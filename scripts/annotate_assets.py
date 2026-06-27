#!/usr/bin/env python3
"""Annotate existing Thoth assets so the pipeline LLM knows WHERE (which beat /
duration) each asset belongs on the 5-beat viral template.

Process:
  1. Measure each audio asset objectively (duration + loudness + envelope shape
     via raw PCM decoded by ffmpeg) -> transient / riser / sustained.
     Video memes are probed (dims + has_audio) and sampled into frames.
  2. Enrich semantics with a vision/chat LLM **in small batches** (category, meme
     meaning, energy, and a concrete placement recommendation mapped to the
     5-beat template + triggers). Batching avoids JSON truncation and keeps the
     vision model focused on a few frames at a time.
  3. Validate every LLM field against a controlled vocabulary, keep the *measured*
     features authoritative (the LLM can never clobber duration / has_audio /
     dimensions), then write assets/asset_catalog.json (machine, consumed by
     analyze/edit) and assets/ASSET_CATALOG.md (human-readable).

Stdlib + ffmpeg/ffprobe only.

Backends (you are subscribed to both):
  • novita     (default)  — vision: qwen/qwen3-vl-235b-a22b-instruct, text: deepseek/deepseek-v3.1
  • openrouter            — vision+text: google/gemini-2.5-flash
Keys: THOTH_NOVITA_API_KEY / THOTH_OPENROUTER_API_KEY (read from .env).

Usage:
    python scripts/annotate_assets.py
    python scripts/annotate_assets.py --backend openrouter
    python scripts/annotate_assets.py --no-llm                 # measured features only
    python scripts/annotate_assets.py --vision-model <id> --text-model <id>
"""
import argparse
import array
import base64
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent.parent
FFMPEG = str(ROOT / "ffmpeg.exe")
FFPROBE = str(ROOT / "ffprobe.exe")
AUDIO_EXT = {".mp3", ".wav", ".aac", ".m4a", ".ogg", ".flac"}
FONT_EXT = {".ttf", ".otf"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".gif", ".mkv"}

# Measured features are authoritative — the LLM may never overwrite these.
PROTECTED = {
    "file", "kind", "subdir", "duration_sec", "envelope", "peak_pos",
    "rise_ratio", "loudness_dbfs", "env_curve", "width", "height", "has_audio",
}

# ── Controlled vocabulary (the catalog JSON consumed by Rust must stay in-vocab) ──
CATEGORIES = {
    "impact_stinger", "whoosh_transition", "riser_build", "notification",
    "meme_vocal", "fail_sound", "record_scratch", "musical_sting", "ambient",
    "font_display", "font_body", "meme_reaction", "meme_transition",
}
BEATS = {"hook", "intro_tokoh", "kronologi", "reaksi_netizen", "outro",
         "transition", "climax"}
TRIGGERS = {
    "scene_change", "emphasis_word", "shock_reveal", "zoom_punch", "comment_appear",
    "profile_appear", "number_callout", "fail_moment", "suspicion_moment",
    "flex_moment", "freeze_rewind", "awkward_silence", "outro_button",
    "agree_react", "disagree_react", "confused_react", "facepalm_react",
    "cringe_react", "hype_react", "realization_react", "censor_block",
    "rage_react", "applause_react",
}
PLACEMENT_MODES = {"at_cue", "under_segment", "lead_in", "overlay_pip",
                   "fullscreen_insert"}
ENERGY = {"low", "medium", "high"}

# ── Backend defaults ──────────────────────────────────────────────────────────
BACKENDS = {
    "novita": {
        "url": "https://api.novita.ai/openai/chat/completions",
        "key_env": "THOTH_NOVITA_API_KEY",
        "vision_model": "qwen/qwen3-vl-235b-a22b-instruct",
        "text_model": "deepseek/deepseek-v3.1",
        "json_mode": True,
    },
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "key_env": "THOTH_OPENROUTER_API_KEY",
        "vision_model": "google/gemini-2.5-flash",
        "text_model": "google/gemini-2.5-flash",
        "json_mode": False,  # not all OpenRouter models honour response_format
    },
}

# Batch sizes: keep each call small so the JSON never truncates and the vision
# model only ever looks at a handful of frames at once.
VIDEO_BATCH = 3
TEXT_BATCH = 14

# ── 5-beat template vocabulary (kept in sync with PLAN_VIRAL_TEMPLATE_ENGINE.md) ──
TEMPLATE_DOC = """\
Timeline template 5-beat (video reaction-news 9:16, 30-50s):
- BEAT 1 "hook"          (0-3s)   : judul raksasa + ekspresi ekstrem + curiosity gap
- BEAT 2 "intro_tokoh"   (3-6s)   : nama besar + kartu profil IG (follower/like)
- BEAT 3 "kronologi"     (6-30s)  : footage/scene, ganti tiap 3-5s, callout angka/panah
- BEAT 4 "reaksi_netizen"(30-40s) : kartu komentar netizen di atas meme
- BEAT 5 "outro"         (akhir)  : punchline / twist / reveal edukasi
Cross-beat: "transition" (antar scene), "climax" (momen kejut/zoom-punch).

Kosakata trigger penempatan (pilih HANYA dari daftar ini):
  scene_change, emphasis_word, shock_reveal, zoom_punch, comment_appear,
  profile_appear, number_callout, fail_moment, suspicion_moment, flex_moment,
  freeze_rewind, awkward_silence, outro_button,
  agree_react, disagree_react, confused_react, facepalm_react, cringe_react,
  hype_react, realization_react, censor_block, rage_react, applause_react
"""

SCHEMA_HINT = """\
Balas HANYA objek JSON {"assets":[ ... ]}. Tiap elemen array objek dengan field PERSIS:
{
  "file": "<persis seperti input>",
  "label": "<nama pendek manusiawi, mis. 'Vine Boom'>",
  "category": "impact_stinger|whoosh_transition|riser_build|notification|meme_vocal|fail_sound|record_scratch|musical_sting|ambient|font_display|font_body|meme_reaction|meme_transition",
  "energy": "low|medium|high",
  "meaning_id": "<1 kalimat Bahasa Indonesia: makna/kapan secara emosional dipakai>",
  "place_beats": ["hook"|"intro_tokoh"|"kronologi"|"reaksi_netizen"|"outro"|"transition"|"climax", ...],
  "triggers": ["<HANYA dari kosakata trigger di atas>", ...],
  "placement_mode": "at_cue|under_segment|lead_in|overlay_pip|fullscreen_insert",
  "lead_in_sec": <float, detik SEBELUM cue mulai diputar; 0 jika at_cue>,
  "min_gap_sec": <float, jarak minimal antar pemakaian ulang agar tidak spam>,
  "avoid": "<kapan JANGAN dipakai, 1 frasa>",
  "tags": ["...", "..."]
}
Aturan WAJIB:
- Pakai HANYA nilai dari enum di atas (kategori/trigger/beat/placement_mode). Jangan mengarang nilai baru.
- JANGAN tulis field 'duration_sec', 'has_audio', 'width', 'height' — itu sudah diukur otomatis dan akan diabaikan.
- Gunakan fitur terukur (duration_sec, envelope, peak_pos, loudness_dbfs) sebagai dasar:
  'transient' pendek -> impact/stinger di cue; 'riser' -> lead_in sebelum reveal;
  'sustained/voice' -> meme vocal/outro button.
- Untuk FONT: category font_display/font_body; place_beats (display=hook/intro_tokoh, body=kronologi subtitle); triggers boleh kosong.

Untuk ASET VIDEO (kind=video, frame contoh dilampirkan sebagai gambar):
- LIHAT framenya untuk identifikasi meme & emosi (setuju, bingung, facepalm, marah,
  hype, tepuk tangan, sensor/blokir, realisasi, dll).
- category: 'meme_reaction' (overlay reaksi emosi) atau 'meme_transition' (efek transisi spt kertas/no-signal).
- placement_mode: 'overlay_pip' (tempel di pojok saat narator komentar),
  'fullscreen_insert' (sisip 1-2 detik sebagai cutaway), atau 'lead_in'/'at_cue' utk transisi di scene_change.
- triggers pakai *_react sesuai emosi (mis. facepalm_react, hype_react, confused_react).
- 'avoid': jika meme punya audio sendiri, catat 'duck narasi saat meme audio diputar'."""


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, **kw)


def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def probe_duration(path: Path) -> float:
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)], text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def audio_features(path: Path) -> dict:
    """Decode to 16k mono s16le and compute envelope-based features."""
    dur = probe_duration(path)
    r = run([FFMPEG, "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000",
             "-f", "s16le", "-"])
    raw = r.stdout
    if not raw:
        return {"duration_sec": round(dur, 3), "envelope": "unknown",
                "peak_pos": 0.0, "loudness_dbfs": None, "rise_ratio": None}
    samples = array.array("h")
    samples.frombytes(raw[: (len(raw) // 2) * 2])
    n = len(samples)
    if n == 0:
        return {"duration_sec": round(dur, 3), "envelope": "unknown",
                "peak_pos": 0.0, "loudness_dbfs": None, "rise_ratio": None}

    WIN = 16
    wsize = max(1, n // WIN)
    rms = []
    peak_amp = 1
    for i in range(WIN):
        seg = samples[i * wsize:(i + 1) * wsize]
        if not seg:
            rms.append(0.0)
            continue
        acc = 0
        smax = 0
        for s in seg:
            acc += s * s
            a = s if s >= 0 else -s
            if a > smax:
                smax = a
        rms.append(math.sqrt(acc / len(seg)))
        if smax > peak_amp:
            peak_amp = smax

    mx = max(rms) or 1.0
    env = [round(v / mx, 3) for v in rms]
    peak_idx = env.index(max(env))
    peak_pos = round(peak_idx / (WIN - 1), 3)

    front = sum(env[:max(1, WIN // 5)]) / max(1, WIN // 5)
    back = sum(env[-max(1, WIN // 5):]) / max(1, WIN // 5)
    rise_ratio = round((back + 0.01) / (front + 0.01), 2)
    loud = round(20 * math.log10(peak_amp / 32768.0), 1)

    # Classify envelope shape
    if rise_ratio >= 1.6 and peak_pos >= 0.55:
        shape = "riser"          # builds up -> good lead-in before reveal
    elif peak_pos <= 0.35 and dur <= 2.0:
        shape = "transient"      # sharp hit at start -> stinger/impact on cue
    elif dur >= 2.5 and 0.3 <= peak_pos <= 0.8:
        shape = "sustained"      # body/voice meme -> under segment / outro
    else:
        shape = "swell"

    return {
        "duration_sec": round(dur, 3),
        "envelope": shape,
        "peak_pos": peak_pos,
        "rise_ratio": rise_ratio,
        "loudness_dbfs": loud,
        "env_curve": env,
    }


def b64_image(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()


def video_features(path: Path, frame_dir: Path, n_frames: int = 3) -> dict:
    """Probe a video meme and extract representative frames for the vision model."""
    dur = probe_duration(path)
    # width/height/has_audio via ffprobe (authoritative — never set by the LLM)
    r = run([FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-of", "csv=p=0:s=x", str(path)], text=True)
    dims = r.stdout.strip().split("x") if r.stdout.strip() else []
    w = int(dims[0]) if len(dims) == 2 and dims[0].isdigit() else None
    h = int(dims[1]) if len(dims) == 2 and dims[1].isdigit() else None
    ra = run([FFPROBE, "-v", "error", "-select_streams", "a",
              "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path)], text=True)
    has_audio = bool(ra.stdout.strip())

    # Extract n_frames evenly across the clip (skip first/last 15%), larger now
    # (512px) so overlay text / facial expression reads clearly to the vision model.
    frames = []
    if dur > 0:
        for i in range(n_frames):
            frac = 0.15 + (0.7 * (i / max(1, n_frames - 1))) if n_frames > 1 else 0.5
            t = round(dur * frac, 2)
            outp = frame_dir / f"{path.stem}_{i}.jpg"
            run([FFMPEG, "-v", "error", "-ss", str(t), "-i", str(path),
                 "-frames:v", "1", "-vf", "scale=512:-1", "-q:v", "3", "-y", str(outp)])
            if outp.exists():
                frames.append(outp)
    return {
        "duration_sec": round(dur, 3),
        "width": w, "height": h, "has_audio": has_audio,
        "_frames": frames,
    }


def collect_assets(frame_dir: Path) -> list[dict]:
    """Scan the centralized assets/ tree. Audio under assets/{sfx,bgm,music},
    fonts under assets/fonts, video memes under assets/meme, transitions under
    assets/ui. File paths are emitted root-relative."""
    recs = []
    base = ROOT / "assets"
    for sub in ("sfx", "bgm", "music"):
        d = base / sub
        if not d.exists():
            continue
        for f in sorted(d.iterdir()):
            if f.suffix.lower() in AUDIO_EXT:
                feat = audio_features(f)
                recs.append({"file": f"assets/{sub}/{f.name}", "kind": "audio", **feat})
    fd = base / "fonts"
    if fd.exists():
        for f in sorted(fd.iterdir()):
            if f.suffix.lower() in FONT_EXT:
                recs.append({"file": f"assets/fonts/{f.name}", "kind": "font",
                             "duration_sec": None, "envelope": None})
    # Video assets: reaction memes (assets/meme) + visual transitions (assets/ui)
    for sub in ("meme", "ui"):
        d = base / sub
        if not d.exists():
            continue
        for f in sorted(d.iterdir()):
            if f.suffix.lower() in VIDEO_EXT:
                feat = video_features(f, frame_dir)
                recs.append({"file": f"assets/{sub}/{f.name}", "kind": "video",
                             "subdir": sub, **feat})
    return recs


# ── LLM enrichment ────────────────────────────────────────────────────────────
def load_env():
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def chat_completion(content, model: str, cfg: dict, api_key: str,
                    max_tokens: int = 4000) -> str | None:
    """One OpenAI-compatible chat call (Novita or OpenRouter) with retries.
    Returns the assistant text, or None on hard failure."""
    body = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.3,
        "max_tokens": max_tokens,
    }
    if cfg["json_mode"]:
        body["response_format"] = {"type": "json_object"}
    payload = json.dumps(body).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "thoth-annotator/2.0",
        "Accept": "application/json",
    }
    if "openrouter" in cfg["url"]:
        headers["HTTP-Referer"] = "https://github.com/muhfalihr/thoth"
        headers["X-Title"] = "Thoth Asset Annotator"

    last = None
    for attempt in range(1, 6):
        req = urllib.request.Request(cfg["url"], data=payload, headers=headers,
                                     method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                out = json.loads(resp.read().decode())
            return out["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read().decode()[:200]}"
            if e.code in (429, 500, 502, 503, 529):
                wait = min(8 * attempt, 32)
                print(f"    retry {attempt} ({last}) in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"    {last}", file=sys.stderr)
            return None
        except Exception as e:
            last = str(e)
            print(f"    attempt {attempt} err: {last}", file=sys.stderr)
            time.sleep(6 * attempt)
    print(f"    LLM failed: {last}", file=sys.stderr)
    return None


def annotate_batch(batch: list[dict], model: str, cfg: dict, api_key: str,
                   with_frames: bool) -> list[dict]:
    """Annotate one small batch of assets. Vision frames are attached only for
    the video batch (with_frames=True)."""
    slim = [{k: v for k, v in r.items() if k not in ("env_curve", "_frames")}
            for r in batch]
    kind_note = ("Batch ini berisi ASET VIDEO (meme/transisi); frame contoh tiap aset "
                 "dilampirkan sebagai gambar di bawah."
                 if with_frames else
                 "Batch ini berisi ASET AUDIO (SFX/musik) dan/atau FONT.")
    prompt = (
        "Kamu adalah sound/asset director untuk konten short-form viral Indonesia.\n"
        "Anotasi tiap aset agar pipeline editor otomatis tahu KAPAN memakainya.\n"
        f"{kind_note}\n\n"
        f"{TEMPLATE_DOC}\n\n"
        f"FITUR TERUKUR ASET (sudah diukur otomatis dari file asli):\n"
        f"{json.dumps(slim, ensure_ascii=False, indent=1)}\n\n"
        f"{SCHEMA_HINT}\n"
    )
    content = [{"type": "text", "text": prompt}]
    if with_frames:
        for r in batch:
            for fr in r.get("_frames", []) or []:
                content.append({"type": "text", "text": f"\n[FRAME dari {r['file']}]"})
                content.append({"type": "image_url", "image_url": {"url": b64_image(fr)}})

    # Budget tokens by batch size (~180 tok/asset for the JSON answer, min 1500).
    max_tokens = max(1500, 220 * len(batch))
    text = chat_completion(content, model, cfg, api_key, max_tokens=max_tokens)
    if not text:
        return []
    return parse_json_array(text)


def llm_annotate(records: list[dict], cfg: dict, api_key: str,
                 vision_model: str, text_model: str) -> list[dict]:
    videos = [r for r in records if r.get("_frames")]
    others = [r for r in records if not r.get("_frames")]  # audio + fonts

    out: list[dict] = []
    n_batches = (math.ceil(len(others) / TEXT_BATCH) if others else 0) + \
                (math.ceil(len(videos) / VIDEO_BATCH) if videos else 0)
    bi = 0
    for batch in chunks(others, TEXT_BATCH):
        bi += 1
        print(f"  [{bi}/{n_batches}] text batch ({len(batch)} assets) via {text_model}…",
              file=sys.stderr)
        out += annotate_batch(batch, text_model, cfg, api_key, with_frames=False)
    for batch in chunks(videos, VIDEO_BATCH):
        bi += 1
        print(f"  [{bi}/{n_batches}] vision batch ({len(batch)} memes) via {vision_model}…",
              file=sys.stderr)
        out += annotate_batch(batch, vision_model, cfg, api_key, with_frames=True)
    return out


def parse_json_array(text: str) -> list[dict]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    try:
        data = json.loads(text)
    except Exception:
        # Salvage: grab the outermost array or object substring.
        s = text.find("[")
        e = text.rfind("]")
        if s >= 0 and e > s:
            try:
                data = json.loads(text[s:e + 1])
            except Exception:
                data = []
        else:
            s, e = text.find("{"), text.rfind("}")
            try:
                data = json.loads(text[s:e + 1]) if s >= 0 and e > s else []
            except Exception:
                data = []
    if isinstance(data, dict):
        for k in ("assets", "annotations", "items", "data"):
            if isinstance(data.get(k), list):
                return data[k]
        return [data]
    return data if isinstance(data, list) else []


# ── Validation / normalization of LLM output ──────────────────────────────────
def _clamp_one(v, allowed: set, default):
    return v if isinstance(v, str) and v in allowed else default


def _clamp_list(v, allowed: set):
    if not isinstance(v, list):
        return []
    seen, out = set(), []
    for x in v:
        if isinstance(x, str) and x in allowed and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def normalize_annotation(ann: dict) -> dict:
    """Clamp every controlled field to its vocabulary so only valid values reach
    the catalog JSON (Rust reads these directly)."""
    a = dict(ann)
    if "category" in a:
        a["category"] = _clamp_one(a.get("category"), CATEGORIES, "")
    if "energy" in a:
        a["energy"] = _clamp_one(a.get("energy"), ENERGY, "medium")
    if "placement_mode" in a:
        a["placement_mode"] = _clamp_one(a.get("placement_mode"), PLACEMENT_MODES, "")
    if "place_beats" in a:
        a["place_beats"] = _clamp_list(a.get("place_beats"), BEATS)
    if "triggers" in a:
        a["triggers"] = _clamp_list(a.get("triggers"), TRIGGERS)
    for fld in ("lead_in_sec", "min_gap_sec"):
        if fld in a:
            try:
                a[fld] = round(float(a[fld]), 2)
            except (TypeError, ValueError):
                a.pop(fld, None)
    return a


# ── Output writers ────────────────────────────────────────────────────────────
def write_markdown(merged: list[dict], out: Path):
    lines = ["# Asset Catalog — Annotated for 5-Beat Template",
             "",
             "Dihasilkan `scripts/annotate_assets.py`. Fitur audio/video diukur dari file asli; "
             "penempatan dianotasi LLM (batched, in-vocab) ke timeline template 5-beat.",
             "",
             "| File | Tipe | Kategori | Energi | Durasi | Beat | Trigger | Makna |",
             "|---|---|---|---|---|---|---|---|"]
    order = {"audio": 0, "video": 1, "font": 2}
    for a in sorted(merged, key=lambda x: (order.get(x.get("kind"), 9), x.get("file", ""))):
        dur = a.get("duration_sec")
        dur_s = f"{dur:.2f}s" if isinstance(dur, (int, float)) else "—"
        beats = ", ".join(a.get("place_beats", []) or [])
        trig = ", ".join(a.get("triggers", []) or [])
        lines.append(
            f"| `{a.get('file','')}` | {a.get('kind','?')} | {a.get('category','?')} | "
            f"{a.get('energy','—')} | {dur_s} | {beats} | {trig} | {a.get('meaning_id','')} |")
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=list(BACKENDS), default="novita",
                    help="LLM provider (default: novita; you also have openrouter)")
    ap.add_argument("--vision-model", default=None,
                    help="override vision model id (default per backend)")
    ap.add_argument("--text-model", default=None,
                    help="override text model id (default per backend)")
    ap.add_argument("--model", default=None,
                    help="[deprecated] alias for --vision-model")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--out-json", default="assets/asset_catalog.json")
    ap.add_argument("--out-md", default="assets/ASSET_CATALOG.md")
    args = ap.parse_args()

    cfg = BACKENDS[args.backend]
    vision_model = args.vision_model or args.model or cfg["vision_model"]
    text_model = args.text_model or cfg["text_model"]

    tmp = tempfile.TemporaryDirectory(prefix="thoth_annot_")
    frame_dir = Path(tmp.name)

    print("Measuring assets…", file=sys.stderr)
    records = collect_assets(frame_dir)
    n_vid = sum(1 for r in records if r.get("kind") == "video")
    print(f"  {len(records)} assets measured ({n_vid} video w/ frames)", file=sys.stderr)

    annotations = []
    if not args.no_llm:
        load_env()
        api_key = os.environ.get(cfg["key_env"], "")
        if not api_key:
            print(f"WARN: no {cfg['key_env']} -> skipping LLM enrichment", file=sys.stderr)
        else:
            print(f"Annotating placement via {args.backend} "
                  f"(vision={vision_model}, text={text_model})…", file=sys.stderr)
            annotations = llm_annotate(records, cfg, api_key, vision_model, text_model)
            print(f"  {len(annotations)} annotations returned", file=sys.stderr)

    # Merge: measured features authoritative; LLM fields layered on top but
    # validated in-vocab and forbidden from clobbering PROTECTED measured fields.
    by_file = {a.get("file"): normalize_annotation(a)
               for a in annotations if isinstance(a, dict) and a.get("file")}
    merged = []
    for r in records:
        ann = by_file.get(r["file"], {})
        m = {k: v for k, v in r.items() if k != "_frames"}
        for k, v in ann.items():
            if k in PROTECTED:
                continue  # never let the LLM overwrite a measured fact
            m[k] = v
        merged.append(m)
    tmp.cleanup()

    n_enriched = sum(1 for m in merged if m.get("file") in by_file)
    print(f"  merged: {n_enriched}/{len(merged)} assets enriched by LLM", file=sys.stderr)

    out_json = ROOT / args.out_json
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(
        {"version": 1, "template": "5beat-animelorian", "assets": merged},
        ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(merged, ROOT / args.out_md)
    print(f"OK -> {out_json}", file=sys.stderr)
    print(f"OK -> {ROOT / args.out_md}", file=sys.stderr)


if __name__ == "__main__":
    main()
