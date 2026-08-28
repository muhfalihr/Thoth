#!/usr/bin/env python
"""embed_platform_logos.py — PREP utility: build the platform-logo knowledge table in Supabase.

Run this ONCE (and again whenever the logo asset folder changes), BEFORE running Thoth. Nothing in
the Thoth/scout pipeline shells out to Python: at trace time scout only issues a nearest-neighbour
SELECT against the table this script fills (see scout/lib/platform_logo.ts).

Why it exists
-------------
A reposted clip often credits its origin with a platform ICON burned into the cover or the first
second of the video (TikTok note, IG camera/Reels glyph, the X bird/logo) rather than with words.
The vision model reads that icon as free text ("ada ikon burung biru kecil di pojok"), which is far
too vague for `resolve_source.ts` to turn into a platform. This table turns that free text into a
grounded answer: every known logo is stored with

  * a CLIP **image** embedding — used here to GROUP the variants of one platform and to flag two
    platforms whose logos are confusable, and
  * a **text** embedding of a bilingual visual descriptor, in the SAME space scout's lib/embed.ts
    uses — that is the vector scout queries at runtime.

Image and text vectors do NOT share a space; keeping both is deliberate. The image side is the
offline grouping/QA signal, the text side is the online lookup.

Asset layout
------------
    assets/platform_logos/<platform>/<variant>.(png|jpg|jpeg|webp)

`<platform>` MUST be one of the supported platform ids (see CATALOG). `<variant>` is a free label —
"glyph-white", "wordmark-dark", "reels-badge", … Crops taken from real posts are better references
than press-kit art, because that is what the model will actually see.

Usage
-----
    python scripts/vision/embed_platform_logos.py seed            # embed + upsert
    python scripts/vision/embed_platform_logos.py seed --dry-run  # embed + report, no writes
    python scripts/vision/embed_platform_logos.py report          # read the table back

Environment
-----------
    THOTH_SUPABASE_URL        postgresql://...   (same DB as Thoth's other RAG tables)
    THOTH_NOVITA_API_KEY      text-embedding provider key
    THOTH_EMBED_MODEL         default qwen/qwen3-embedding-8b   (must match scout/lib/embed.ts)
    THOTH_LOGO_CLIP_MODEL     default openai/clip-vit-base-patch32

Install once:  python -m pip install torch transformers pillow psycopg2-binary requests
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from lib import endpoints  # noqa: E402  (path shim above)


def load_env() -> None:
    """Populate os.environ from the repo-root .env (real env vars still win).

    Runs at import, before the model constants below read os.environ — the keys this needs
    (THOTH_NOVITA_API_KEY, THOTH_SUPABASE_URL) live in .env, not in the shell.
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env()

DEFAULT_ASSET_DIR = REPO_ROOT / "assets" / "platform_logos"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
CLIP_MODEL = os.environ.get("THOTH_LOGO_CLIP_MODEL", "openai/clip-vit-base-patch32")
TEXT_MODEL = os.environ.get("THOTH_EMBED_MODEL", "qwen/qwen3-embedding-8b")
CENTROID_VARIANT = "__centroid__"

# Descriptors are bilingual on purpose: the runtime query text comes from an Indonesian vision
# prompt, while a lot of the training signal for these glyphs is English. One string carrying both
# keeps the nearest-neighbour lookup from hinging on which language the model happened to answer in.
CATALOG: dict[str, dict] = {
    "tiktok": {
        "aliases": ["tiktok", "tt", "douyin"],
        "descriptor": (
            "TikTok logo: ikon not balok musik / musical note, huruf 'd' stilasi dengan bayangan "
            "cyan biru muda dan magenta merah muda di atas latar hitam, wordmark 'TikTok'. "
            "Watermark TikTok pada video: not musik kecil di samping teks '@username' yang "
            "berpindah-pindah posisi antar sudut layar. English: TikTok music note glyph, cyan and "
            "magenta chromatic offset, moving @username watermark."
        ),
    },
    "instagram": {
        "aliases": ["instagram", "ig", "insta", "reels"],
        "descriptor": (
            "Instagram logo: ikon kamera kotak dengan sudut membulat, lingkaran lensa di tengah "
            "dan titik kecil di kanan atas, gradasi ungu-oranye-merah muda. Badge 'Reels': ikon "
            "clapper board / papan film miring. Kredit repost sering memakai emoji kamera. "
            "English: Instagram rounded-square camera outline, purple orange pink gradient, Reels "
            "clapperboard badge."
        ),
    },
    "twitter": {
        "aliases": ["twitter", "x", "x.com", "tweet"],
        "descriptor": (
            "X (dahulu Twitter) logo: huruf 'X' putih tegas di atas latar hitam. Logo lama: burung "
            "biru terbang menghadap kanan. Kartu tweet putih dengan foto profil bulat dan handle "
            "'@username'. English: X wordmark white on black, legacy blue bird glyph, tweet card."
        ),
    },
    "youtube": {
        "aliases": ["youtube", "yt", "shorts", "youtu.be"],
        "descriptor": (
            "YouTube logo: persegi panjang merah dengan sudut membulat dan segitiga play putih di "
            "tengah, wordmark 'YouTube'. Shorts: ikon play putih di dalam bentuk pita merah "
            "vertikal. English: YouTube red rounded rectangle with white play triangle, Shorts "
            "vertical red ribbon play icon."
        ),
    },
    "facebook": {
        "aliases": ["facebook", "fb", "meta"],
        "descriptor": (
            "Facebook logo: lingkaran biru dengan huruf 'f' putih. Watermark Facebook Reels dan "
            "kartu status biru-putih. English: Facebook blue circle with white lowercase f."
        ),
    },
    "threads": {
        "aliases": ["threads"],
        "descriptor": (
            "Threads logo: simbol '@' stilasi berbentuk kait/pita melingkar, putih di atas latar "
            "hitam. English: Threads stylised at-sign hook glyph, white on black."
        ),
    },
}

# Decoys. Without them the nearest-neighbour lookup has no way to answer "that is not a platform
# logo": every description is forced to pick a winner among six platforms, so a TV station's round
# bug scored 0.595 as YouTube — above the threshold, on prose that names no platform at all. These
# rows give non-platform marks something of their own to be nearest to; the runtime treats a win
# here as "no icon evidence". Text-only: there is nothing to photograph.
NONE_PLATFORM = "__none__"
NEGATIVES: dict[str, str] = {
    "tv_station_bug": (
        "Logo stasiun televisi / channel berita di pojok layar: bentuk bulat, perisai, atau "
        "wordmark singkatan stasiun, sering disertai tulisan LIVE. Bukan logo media sosial. "
        "English: television broadcaster channel bug or news network logo in the corner."
    ),
    "news_chyron": (
        "Chyron / lower-third berita: bilah warna solid berisi teks judul besar, ticker berjalan, "
        "atau tulisan BREAKING NEWS. Bukan logo. English: news lower-third banner, headline bar, "
        "breaking news caption strip."
    ),
    "screen_furniture": (
        "Elemen antarmuka biasa di layar: jam digital, suhu udara, indikator baterai, tombol, "
        "panah, subtitle, atau angka skor. Bukan logo platform. English: on-screen clock, "
        "temperature, battery indicator, buttons, subtitles, scoreboard."
    ),
    "scene_content": (
        "Isi videonya sendiri: orang, kendaraan, jalan, ruangan, hewan, makanan, pemandangan. "
        "Tidak ada ikon atau watermark platform sama sekali. English: the filmed scene itself — "
        "people, vehicles, streets, rooms; no platform mark present."
    ),
    "plain_text_credit": (
        "Tulisan biasa tanpa ikon: nama akun, kredit 'cr:', atau nama orang dalam huruf polos "
        "tanpa lambang platform apa pun. English: plain text credit or username with no glyph."
    ),
}

DDL = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS platform_logos (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    platform        TEXT NOT NULL,
    variant         TEXT NOT NULL,
    source_path     TEXT,
    aliases         TEXT[],
    descriptor      TEXT NOT NULL,
    clip_model      TEXT,
    text_model      TEXT,
    image_embedding halfvec(512),
    text_embedding  halfvec(4096),
    UNIQUE (platform, variant)
);
CREATE INDEX IF NOT EXISTS platform_logos_platform_idx ON platform_logos (platform);
"""

UPSERT = """
INSERT INTO platform_logos (
    platform, variant, source_path, aliases, descriptor,
    clip_model, text_model, image_embedding, text_embedding
) VALUES (%s,%s,%s,%s,%s,%s,%s,%s::halfvec,%s::halfvec)
ON CONFLICT (platform, variant) DO UPDATE SET
    created_at      = now(),
    source_path     = EXCLUDED.source_path,
    aliases         = EXCLUDED.aliases,
    descriptor      = EXCLUDED.descriptor,
    clip_model      = EXCLUDED.clip_model,
    text_model      = EXCLUDED.text_model,
    image_embedding = EXCLUDED.image_embedding,
    text_embedding  = EXCLUDED.text_embedding;
"""


def log(message: str) -> None:
    # A Windows console defaults to cp1252, where every glyph below raises UnicodeEncodeError and
    # takes the whole run down at the first status line.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(message, flush=True)


# ──────────────────────────────────────────────────────────────────────────────
# Embedding
# ──────────────────────────────────────────────────────────────────────────────
def clip_encoder():
    """Load CLIP once. Returns encode(path) -> list[float] (L2-normalised)."""
    import torch
    from PIL import Image
    from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection

    processor = CLIPImageProcessor.from_pretrained(CLIP_MODEL)
    model = CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL).eval()

    def encode(path: Path) -> list[float]:
        # Logos are routinely transparent PNGs; flatten onto white so the alpha channel does not
        # arrive as black and swamp the embedding.
        raw = Image.open(path)
        image = Image.new("RGB", raw.size, (255, 255, 255))
        image.paste(raw, mask=raw.convert("RGBA").split()[-1] if raw.mode in ("RGBA", "LA") else None)
        inputs = processor(images=image, return_tensors="pt")
        with torch.no_grad():
            vector = model(**inputs).image_embeds[0]
        vector = vector / vector.norm()
        return vector.tolist()

    return encode


def embed_text(text: str) -> list | None:
    key = os.environ.get("THOTH_NOVITA_API_KEY", "").strip()
    if not key:
        log("  ! THOTH_NOVITA_API_KEY kosong — text_embedding dilewati")
        return None
    url = f"{endpoints.novita().rstrip('/')}/v1/embeddings"
    try:
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {key}"},
            json={"model": TEXT_MODEL, "input": text[:8000], "encoding_format": "float"},
            timeout=120,
        )
    except requests.RequestException as error:
        log(f"  ! embedding HTTP error: {error}")
        return None
    if resp.status_code != 200:
        log(f"  ! embedding {resp.status_code}: {resp.text[:200]}")
        return None
    try:
        return resp.json()["data"][0]["embedding"]
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Grouping / QA
# ──────────────────────────────────────────────────────────────────────────────
def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def centroid(vectors: list[list[float]]) -> list[float]:
    size = len(vectors[0])
    mean = [sum(vector[i] for vector in vectors) / len(vectors) for i in range(size)]
    norm = sum(value * value for value in mean) ** 0.5 or 1.0
    return [value / norm for value in mean]


def report_grouping(groups: dict[str, list[tuple[str, list[float]]]]) -> None:
    """Print how tight each platform's variants are, and which platforms look alike.

    A variant that sits far from its own centroid is usually a bad reference (wrong crop, heavy
    background). Two centroids that sit close mean the runtime match between them will be a coin
    flip — better to know that here than to debug a wrong platform mid-pipeline.
    """
    centroids = {platform: centroid([v for _, v in items]) for platform, items in groups.items()}
    log("\n── pengelompokan logo (CLIP) ──")
    for platform, items in sorted(groups.items()):
        sims = [(name, cosine(vector, centroids[platform])) for name, vector in items]
        worst = min(sims, key=lambda pair: pair[1])
        log(f"  {platform:<10} varian={len(items)}  kohesi_min={worst[1]:.3f} ({worst[0]})")
        if worst[1] < 0.7:
            log(f"    ⚠ '{worst[0]}' jauh dari pusat kelompoknya — kemungkinan crop/aset keliru.")
    names = sorted(centroids)
    for i, left in enumerate(names):
        for right in names[i + 1 :]:
            sim = cosine(centroids[left], centroids[right])
            if sim >= 0.9:
                log(f"  ⚠ '{left}' vs '{right}' mirip ({sim:.3f}) — rawan tertukar saat match.")


# ──────────────────────────────────────────────────────────────────────────────
# Supabase
# ──────────────────────────────────────────────────────────────────────────────
def db_connect():
    import psycopg2  # lazy — only needed when actually writing to the DB

    url = os.environ.get("THOTH_SUPABASE_URL", "").strip()
    if not url:
        raise RuntimeError("THOTH_SUPABASE_URL not set")
    return psycopg2.connect(url)


def vec_literal(vector: list | None) -> str | None:
    return None if not vector else "[" + ",".join(f"{value:.6f}" for value in vector) + "]"


def collect(asset_dir: Path) -> dict[str, list[Path]]:
    found: dict[str, list[Path]] = {}
    for platform_dir in sorted(p for p in asset_dir.iterdir() if p.is_dir()):
        platform = platform_dir.name.lower()
        if platform not in CATALOG:
            log(f"  ! folder '{platform}' bukan platform yang didukung — dilewati")
            continue
        images = sorted(p for p in platform_dir.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
        if images:
            found[platform] = images
    return found


def seed(asset_dir: Path, dry_run: bool) -> int:
    if not asset_dir.is_dir():
        log(f"✗ folder aset tak ada: {asset_dir}")
        log("  Buat dulu: assets/platform_logos/<platform>/<varian>.png (lihat README di sana).")
        return 1
    assets = collect(asset_dir)
    if not assets:
        log(f"✗ tak ada gambar logo di {asset_dir}")
        return 1

    encode = clip_encoder()
    groups: dict[str, list[tuple[str, list[float]]]] = {}
    rows: list[tuple] = []

    for platform, images in assets.items():
        entry = CATALOG[platform]
        for image in images:
            variant = image.stem.lower()
            log(f"  · {platform}/{variant}")
            image_vector = encode(image)
            groups.setdefault(platform, []).append((variant, image_vector))
            descriptor = f"{entry['descriptor']} Varian: {variant}."
            rows.append(
                (
                    platform,
                    variant,
                    str(image.relative_to(REPO_ROOT)),
                    entry["aliases"],
                    descriptor,
                    CLIP_MODEL,
                    TEXT_MODEL,
                    vec_literal(image_vector),
                    vec_literal(embed_text(descriptor)),
                )
            )

    # One centroid row per platform: the runtime lookup wants ONE canonical answer per platform, not
    # a vote among however many variants happen to be seeded.
    for platform, items in groups.items():
        entry = CATALOG[platform]
        rows.append(
            (
                platform,
                CENTROID_VARIANT,
                None,
                entry["aliases"],
                entry["descriptor"],
                CLIP_MODEL,
                TEXT_MODEL,
                vec_literal(centroid([vector for _, vector in items])),
                vec_literal(embed_text(entry["descriptor"])),
            )
        )

    for variant, descriptor in NEGATIVES.items():
        log(f"  · {NONE_PLATFORM}/{variant}")
        rows.append(
            (
                NONE_PLATFORM,
                variant,
                None,
                [],
                descriptor,
                CLIP_MODEL,
                TEXT_MODEL,
                None,
                vec_literal(embed_text(descriptor)),
            )
        )

    report_grouping(groups)

    if dry_run:
        log(f"\n(dry-run) {len(rows)} baris siap di-upsert ke platform_logos — tidak ditulis.")
        return 0

    conn = db_connect()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(DDL)
            for row in rows:
                cur.execute(UPSERT, row)
    finally:
        conn.close()
    log(f"\n✓ {len(rows)} baris di-upsert ke platform_logos.")
    return 0


def report() -> int:
    conn = db_connect()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT platform, variant, source_path,"
                " image_embedding IS NOT NULL, text_embedding IS NOT NULL"
                " FROM platform_logos ORDER BY platform, variant"
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        log("platform_logos kosong — jalankan `seed` dulu.")
        return 1
    for platform, variant, path, has_image, has_text in rows:
        flags = ("clip" if has_image else "----") + "/" + ("text" if has_text else "----")
        log(f"  {platform:<10} {variant:<18} {flags}  {path or ''}")
    log(f"\n{len(rows)} baris.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("mode", choices=["seed", "report"])
    parser.add_argument("--dir", default=str(DEFAULT_ASSET_DIR), help="folder aset logo")
    parser.add_argument("--dry-run", action="store_true", help="hitung + laporkan, jangan tulis DB")
    args = parser.parse_args()
    if args.mode == "report":
        return report()
    return seed(Path(args.dir), args.dry_run)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except RuntimeError as error:
        log(f"✗ {error}")
        raise SystemExit(1)
