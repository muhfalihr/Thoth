#!/usr/bin/env python3
"""Analyze the NARRATION STRUCTURE of reference videos → store to Supabase.

Goal: build a corpus of *what good narration looks like* so Thoth's narration
generator (`src/narration/mod.rs`) can ground its scripts in proven structures
instead of hallucinating weird ones. Each video is broken into an ordered BEAT
ARC (HOOK → SETUP_KARAKTER → KONTEKS → INSIDEN → flexible middle [comedy /
dialogue-reenactment / analysis] → KICKER_PUNCHLINE), each beat with timestamps +
verbatim quote + function. Also captures: hook format (e.g. expectation_vs_reality),
narrator posture (commentator vs storyteller), punchline strength, social-controversy
dimension, real engagement (likes/comments), slang, anti-patterns, and concrete
lessons for generation.

Pipeline per URL:
  1. yt-dlp  → metadata (title, description, channel, duration) + audio download
  2. ffmpeg  → 16 kHz mono mp3 (small, transcription-friendly)
  3. Groq Whisper (large-v3) → transcript of the spoken narration
  4. Novita LLM → structured narration-structure analysis (strict JSON)
  5. Novita embeddings (qwen3-embedding-8b, 4096-d) → semantic vector (optional)
  6. Supabase (same DB as Thoth, OWN table `narration_structures`) → upsert

Uses the SAME Supabase + provider creds as Thoth (read from .env / config.toml).
The table is separate from `viral_moments` and never touches it.

Usage:
    # one-time: create the table
    python scripts/analyze_narration_structure.py --init-db

    # analyze URLs (positional, or --urls-file with one URL per line)
    python scripts/analyze_narration_structure.py URL1 URL2 ...
    python scripts/analyze_narration_structure.py --urls-file refs.txt --language id

Options:
    --init-db            Create the narration_structures table (and exit if no URLs).
    --urls-file PATH     Read newline-separated URLs from a file.
    --language CODE      Expected narration language (default: id).
    --llm-model NAME     Override the analysis LLM model.
    --whisper-model NAME Override the Groq Whisper model (default: whisper-large-v3).
    --max-audio-sec N    Trim audio to first N seconds before transcribing (default 1800).
    --no-embed           Skip embedding generation (store NULL vector).
    --no-cookies         Don't pass yt-dlp cookies.
    --keep-audio         Keep the downloaded audio files (debug).
    --dry-run            Do everything except the DB write (prints the analysis JSON).

Requires in .env / environment:
    THOTH_SUPABASE_URL   postgresql://...        (same DB as Thoth)
    THOTH_GROQ_API_KEY   for Whisper transcription
    THOTH_NOVITA_API_KEY for LLM analysis + embeddings  (or THOTH_EMBED_API_KEY)

Install once:  python -m pip install psycopg2-binary requests json_repair
               (json_repair is optional but recommended — repairs LLM JSON that
                has unescaped quotes inside verbatim dialogue.)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import requests  # noqa: E402

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

ROOT = Path(__file__).resolve().parent.parent.parent  # repo root (scripts/narration/ is two deep)


# ──────────────────────────────────────────────────────────────────────────────
# Config / env
# ──────────────────────────────────────────────────────────────────────────────
def load_env():
    """Populate os.environ from .env (does not override real env vars)."""
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def load_config() -> dict:
    """Read provider/cookie settings from config.toml (graceful defaults)."""
    cfg = {
        "novita_base_url": "https://api.novita.ai/openai",
        "novita_model": "qwen/qwen-2.5-72b-instruct",
        "embed_model": "qwen/qwen3-embedding-8b",
        "ytdlp_path": "yt-dlp",
        "cookie_file": "",
        "cookie_browser": "",
    }
    path = ROOT / "config.toml"
    if tomllib and path.exists():
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
            llm = data.get("llm", {})
            vdb = data.get("vector_db", {})
            ing = data.get("ingest", {})
            cfg["novita_base_url"] = llm.get("novita_base_url") or cfg["novita_base_url"]
            cfg["novita_model"] = llm.get("novita_model") or cfg["novita_model"]
            cfg["embed_model"] = vdb.get("embed_model") or cfg["embed_model"]
            if vdb.get("embed_base_url"):
                cfg["novita_base_url"] = vdb["embed_base_url"]
            cfg["ytdlp_path"] = ing.get("ytdlp_path") or cfg["ytdlp_path"]
            cfg["cookie_file"] = ing.get("cookie_file", "") or ""
            cfg["cookie_browser"] = ing.get("cookie_browser", "") or ""
        except Exception as e:
            log(f"warn: cannot parse config.toml ({e}) — using defaults")
    return cfg


def ffmpeg_bin() -> str:
    local = ROOT / "ffmpeg.exe"
    return str(local) if local.exists() else "ffmpeg"


def log(msg: str):
    print(msg, flush=True)


# ──────────────────────────────────────────────────────────────────────────────
# yt-dlp: metadata + audio
# ──────────────────────────────────────────────────────────────────────────────
def _cookie_args(cfg: dict, use_cookies: bool) -> list:
    if not use_cookies:
        return []
    if cfg["cookie_file"] and Path(cfg["cookie_file"]).exists():
        return ["--cookies", cfg["cookie_file"]]
    if cfg["cookie_browser"]:
        return ["--cookies-from-browser", cfg["cookie_browser"]]
    return []


def ytdlp_metadata(url: str, cfg: dict, use_cookies: bool) -> dict:
    """Fetch video metadata as JSON without downloading the media."""
    cmd = [
        cfg["ytdlp_path"], "--dump-single-json", "--no-playlist",
        "--no-warnings", "--retries", "5", "--socket-timeout", "30",
        *_cookie_args(cfg, use_cookies), url,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        log("  ! yt-dlp metadata timed out")
        return {}
    if out.returncode != 0:
        log(f"  ! yt-dlp metadata failed: {out.stderr.decode('utf-8','replace')[:200]}")
        return {}
    try:
        data = json.loads(out.stdout.decode("utf-8", "replace"))
    except Exception:
        return {}
    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None
    return {
        "video_id": str(data.get("id", "")),
        "title": data.get("title", "") or "",
        "channel": data.get("uploader") or data.get("channel") or data.get("uploader_id") or "",
        "description": data.get("description", "") or "",
        "duration_sec": float(data.get("duration") or 0.0),
        "likes": _int(data.get("like_count")),
        "comments_count": _int(data.get("comment_count")),
        "view_count": _int(data.get("view_count")),
    }


def ytdlp_download_audio(url: str, out_dir: Path, cfg: dict, use_cookies: bool,
                         max_sec: int) -> Path | None:
    """Download bestaudio then transcode to 16 kHz mono mp3 (trimmed to max_sec)."""
    raw_tmpl = str(out_dir / "raw.%(ext)s")
    cmd = [
        cfg["ytdlp_path"], "-f", "bestaudio/best", "--no-playlist",
        "--no-warnings", "--retries", "10", "--socket-timeout", "30",
        "--ffmpeg-location", ffmpeg_bin(),
        *_cookie_args(cfg, use_cookies),
        "-o", raw_tmpl, url,
    ]
    # NB: we trim with ffmpeg `-t` below rather than yt-dlp --download-sections,
    # which breaks on some extractors. Full audio download is more reliable.
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=600)
    except subprocess.TimeoutExpired:
        log("  ! yt-dlp audio download timed out")
        return None
    if res.returncode != 0:
        log(f"  ! yt-dlp audio failed: {res.stderr.decode('utf-8','replace')[:250]}")
        return None

    raw = next((p for p in out_dir.glob("raw.*") if p.is_file()), None)
    if not raw:
        log("  ! downloaded audio not found")
        return None

    mp3 = out_dir / "audio16k.mp3"
    ff = [
        ffmpeg_bin(), "-y", "-i", str(raw),
        "-ac", "1", "-ar", "16000", "-b:a", "32k",
    ]
    if max_sec > 0:
        ff += ["-t", str(max_sec)]
    ff += [str(mp3)]
    conv = subprocess.run(ff, capture_output=True, timeout=300)
    try:
        raw.unlink()
    except OSError:
        pass
    if conv.returncode != 0 or not mp3.exists():
        log(f"  ! ffmpeg transcode failed: {conv.stderr.decode('utf-8','replace')[:200]}")
        return None
    return mp3


# ──────────────────────────────────────────────────────────────────────────────
# Transcription (Groq Whisper)
# ──────────────────────────────────────────────────────────────────────────────
def transcribe_groq(audio: Path, model: str, language: str):
    """Return (plain_text, segments) where segments = [{start,end,text}]."""
    key = os.environ.get("THOTH_GROQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("THOTH_GROQ_API_KEY not set — cannot transcribe")
    size_mb = audio.stat().st_size / 1_048_576
    if size_mb > 24:
        log(f"  ! audio is {size_mb:.1f} MB (Groq free limit ~25 MB) — "
            f"lower --max-audio-sec if this fails")
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    with audio.open("rb") as fh:
        files = {"file": (audio.name, fh, "audio/mpeg")}
        # verbose_json → per-segment timestamps so the LLM can assign beat windows.
        data = {"model": model, "response_format": "verbose_json", "temperature": "0"}
        if language:
            data["language"] = language
        resp = requests.post(url, headers={"Authorization": f"Bearer {key}"},
                             files=files, data=data, timeout=300)
    if resp.status_code != 200:
        raise RuntimeError(f"Groq Whisper {resp.status_code}: {resp.text[:300]}")
    js = resp.json()
    text = (js.get("text") or "").strip()
    segs = []
    for s in js.get("segments") or []:
        t = (s.get("text") or "").strip()
        if t:
            segs.append({"start": float(s.get("start") or 0.0),
                         "end": float(s.get("end") or 0.0), "text": t})
    return text, segs


def timestamped_transcript(text: str, segs: list) -> str:
    """Compact `[start-end] text` view for the analyzer; falls back to plain text."""
    if not segs:
        return text
    return "\n".join(f"[{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in segs)


# ──────────────────────────────────────────────────────────────────────────────
# LLM structural analysis (Novita, OpenAI-compatible)
# ──────────────────────────────────────────────────────────────────────────────
ANALYSIS_SYSTEM = (
    "Lo analis konten shorts viral Indonesia, spesialis membedah STRUKTUR NARASI "
    "(voiceover) video pendek gaya commentary/storytelling/rage-bait (mis. "
    "Animelorian). Tugas lo: pecah narasi jadi BABAK (beats) berurutan dengan "
    "rentang waktu + kutipan verbatim + fungsi tiap babak, identifikasi pola hook, "
    "posisi narator (commentator vs storyteller), kekuatan punchline, dan dimensi "
    "kontroversi yang memicu komentar. Lalu tarik pelajaran konkret biar generator "
    "narasi bisa meniru struktur yang terbukti — bukan asal ngarang. "
    "Output HANYA JSON valid, tanpa teks lain, tanpa markdown."
)

# Kosakata label babak kanonik (boleh tambah label lain bila perlu):
#   HOOK, SETUP_KARAKTER, KONTEKS, INSIDEN, DIALOG_REENACTMENT, COMEDY_BEAT,
#   ANALISIS_OPINI, RESOLUSI, KICKER_PUNCHLINE
ANALYSIS_SCHEMA = """{
  "language": "kode bahasa narasi, mis. id",
  "topic": "topik utama video (1 frasa)",
  "summary": "ringkasan isi 1-2 kalimat",
  "narration_style": "rage_bait | storytelling | reaction | educational | hype | explainer | commentary | other",
  "narrator_posture": "commentator | storyteller | hybrid",
  "tone": ["sinis","heran","sarkas","santai","lucu","serius"],
  "hook": {
    "text": "kalimat pembuka VERBATIM dari transkrip",
    "type": "ranking_list | pernyataan_gila | pertanyaan | niat_vs_realita | kutipan_kontroversial | sapaan | statistik | other",
    "format": "expectation_vs_reality | konflik_langsung | misteri | klaim_bombastis | other",
    "word_count": 0,
    "stops_scroll": true,
    "technique": "kenapa hook ini menahan scroll (1 kalimat)"
  },
  "beats": [
    {"n": 1, "label": "HOOK", "start_sec": 0.0, "end_sec": 4.0,
     "text": "kutipan VERBATIM babak ini", 
     "function": "apa peran babak ini dlm cerita"
    }
  ],
  "arc_template": ["HOOK","SETUP_KARAKTER","KONTEKS","INSIDEN","...","KICKER_PUNCHLINE"],
  "body": {
    "approach": "cara bercerita (mis. sinis+heran, naratif kronologis, reenactment dialog)",
    "uses_verbatim_quotes": true,
    "uses_dialogue_reenactment": false,
    "uses_data_or_rules": false,
    "reaction_interjections": ["Serius?","Ya kali.","Anjay."],
    "avg_sentence_words": 0,
    "pacing": "fast | medium | slow",
    "rhetorical_devices": ["repetition","contrast","exaggeration","rhetorical_question"]
  },
  "punchline": {
    "text": "kalimat penutup/kicker VERBATIM",
    "type": "meme_reference | callback | rhetorical_question | one_word | analysis | weak | other",
    "strength": "strong | medium | weak"
  },
  "closing": {
    "type": "pertanyaan_memancing | fakta_bicara_sendiri | cta | nasihat_moral | sapaan_alay | other",
    "invites_debate": true,
    "has_moral_preaching": false
  },
  "controversy": {
    "has_social_controversy": true,
    "dimension": "kenapa topik ini bikin orang marah/debat (1 kalimat), atau '' kalau murni lucu",
    "drives_comments": true
  },
  "estimated_total_words": 0,
  "estimated_duration_sec": 0,
  "words_per_second": 0.0,
  "formal_word_hits": ["merupakan","tersebut","beliau","adapun"],
  "slang_terms": ["anjir","jjir","ngaken","sumpah","ngakak"],
  "profanity": false,
  "what_makes_it_work": "2-3 kalimat: kenapa struktur+topik ini bagus/viral (pisahkan kontribusi STRUKTUR vs TOPIK)",
  "anti_patterns": ["hal yang HARUS DIHINDARI (mis. punchline lembek 'Yeah', nutup pakai nasihat)"],
  "lessons_for_generation": ["takeaway KONKRET & imperatif buat generator narasi (mis. 'Buka dengan expectation vs reality 4 detik')"],
  "quality_score": "ANGKA 0.0-10.0 (skala SEPULUH; 10=struktur narasi sangat bagus). WAJIB pakai skala 0-10, bukan 0-1."
}"""


def analyze_structure(transcript: str, meta: dict, language: str,
                      base_url: str, model: str, api_key: str) -> dict:
    title = meta.get("title", "")
    desc = (meta.get("description", "") or "")[:1200]
    eng_bits = []
    if meta.get("likes") is not None:
        eng_bits.append(f"{meta['likes']} likes")
    if meta.get("comments_count") is not None:
        eng_bits.append(f"{meta['comments_count']} komentar")
    if meta.get("view_count") is not None:
        eng_bits.append(f"{meta['view_count']} views")
    eng = ", ".join(eng_bits) or "tidak diketahui"
    user = (
        f"Analisa STRUKTUR NARASI video berikut.\n\n"
        f"[Judul]\n{title}\n\n"
        f"[Deskripsi]\n{desc}\n\n"
        f"[Engagement]\n{eng}\n\n"
        f"[Transkrip Voiceover — format '[mulai-selesai] teks' per segmen]\n"
        f"{transcript[:9000]}\n\n"
        f"Bahasa narasi diharapkan: {language}.\n"
        f"INSTRUKSI:\n"
        f"- Pecah narasi jadi BABAK berurutan di field `beats`: tiap babak punya "
        f"label, start_sec & end_sec (pakai timestamp segmen di atas), kutipan "
        f"VERBATIM, dan fungsinya.\n"
        f"- `arc_template` = urutan label babak saja.\n"
        f"- Kutip `hook.text` & `punchline.text` VERBATIM.\n"
        f"- Di `what_makes_it_work`, PISAHKAN kontribusi STRUKTUR vs TOPIK "
        f"(engagement tinggi bisa karena kontroversi topik, bukan struktur).\n"
        f"- Kalau transkrip kosong/instrumental: narration_style sesuai, "
        f"quality_score rendah, jelaskan di summary.\n"
        f"- PENTING: di dalam nilai string JSON, JANGAN pakai tanda kutip ganda (\") "
        f"untuk mengutip dialog — pakai kutip tunggal (') atau «». Pastikan JSON 100% "
        f"valid & bisa di-parse.\n\n"
        f"Keluarkan HANYA JSON dengan skema persis ini:\n{ANALYSIS_SCHEMA}"
    )
    messages = [
        {"role": "system", "content": ANALYSIS_SYSTEM},
        {"role": "user", "content": user},
    ]
    url = f"{base_url.rstrip('/')}/v1/chat/completions"

    def call(json_format: bool, max_tokens: int):
        body = {
            "model": model, "messages": messages,
            "temperature": 0.2, "max_tokens": max_tokens,
        }
        if json_format:
            body["response_format"] = {"type": "json_object"}
        return requests.post(url, headers={"Authorization": f"Bearer {api_key}"},
                             json=body, timeout=300)

    # Escalating token budgets. Full verbatim beats + reasoning models (which burn
    # tokens on hidden reasoning before emitting `content`) can be long; if the
    # model says it was cut off ("length"), retry with more room. We keep the best
    # (most complete) content and never shorten the requested output.
    budgets = [8000, 16000, 24000]
    best, truncated = "", False
    for i, mt in enumerate(budgets):
        resp = call(True, mt)
        content = _content_of(resp) if resp.status_code == 200 else ""
        fin = _finish_reason(resp) if resp.status_code == 200 else ""
        # JSON-object mode sometimes returns empty (model ignores it / reasoning
        # ate the budget) → retry plainly at the same budget.
        if resp.status_code != 200 or not content.strip():
            resp2 = call(False, mt)
            if resp2.status_code == 200:
                content = _content_of(resp2)
                fin = _finish_reason(resp2)
            elif not best:
                raise RuntimeError(f"LLM analysis {resp2.status_code}: {resp2.text[:300]}")
        if content.strip():
            best, truncated = content, (fin == "length")
            if not truncated:
                break
        if truncated and i < len(budgets) - 1:
            log(f"  ! output cut off at {mt} tokens — retrying with more room…")

    if not best.strip():
        raise RuntimeError("LLM returned empty content (try a different --llm-model, "
                           "e.g. qwen/qwen-2.5-72b-instruct)")
    if truncated:
        log("  ! warning: analysis still truncated — late fields may be missing; "
            "try a non-reasoning --llm-model (qwen/qwen-2.5-72b-instruct)")
    try:
        return _extract_json(best)
    except Exception as e:
        raise RuntimeError(f"could not parse LLM JSON ({e}); raw head: {best[:400]!r}")


def _content_of(resp) -> str:
    """Pull the assistant text from an OpenAI-compatible response, tolerating
    reasoning models that put the answer in `reasoning_content` / `reasoning`."""
    try:
        msg = resp.json()["choices"][0]["message"]
    except Exception:
        return ""
    for key in ("content", "reasoning_content", "reasoning"):
        v = msg.get(key)
        if isinstance(v, str) and v.strip():
            return v
    return ""


def _finish_reason(resp) -> str:
    """'stop' = complete, 'length' = truncated by max_tokens, '' = unknown."""
    try:
        return resp.json()["choices"][0].get("finish_reason") or ""
    except Exception:
        return ""


def _extract_json(raw: str) -> dict:
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*", "", s).strip().rstrip("`").strip()
    start, end = s.find("{"), s.rfind("}")
    if start != -1 and end != -1 and end > start:
        s = s[start:end + 1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # LLM JSON often has unescaped quotes inside verbatim quotes / dialogue
        # reenactment, or a trailing comma. Repair tolerantly when possible.
        try:
            import json_repair
        except ModuleNotFoundError:
            # minimal fallback: drop trailing commas before } or ]
            fixed = re.sub(r",(\s*[}\]])", r"\1", s)
            return json.loads(fixed)
        repaired = json_repair.loads(s)
        if not isinstance(repaired, dict):
            raise ValueError("repaired JSON is not an object")
        return repaired


# ──────────────────────────────────────────────────────────────────────────────
# Embedding (Novita, OpenAI-compatible) — mirrors src/rag/embed.rs
# ──────────────────────────────────────────────────────────────────────────────
def embed_text(text: str, base_url: str, model: str, api_key: str) -> list | None:
    if not text.strip() or not api_key:
        return None
    url = f"{base_url.rstrip('/')}/v1/embeddings"
    try:
        resp = requests.post(
            url, headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "input": text[:8000], "encoding_format": "float"},
            timeout=120,
        )
    except requests.RequestException as e:
        log(f"  ! embedding HTTP error: {e}")
        return None
    if resp.status_code != 200:
        log(f"  ! embedding {resp.status_code}: {resp.text[:200]}")
        return None
    try:
        return resp.json()["data"][0]["embedding"]
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Supabase (psycopg2)
# ──────────────────────────────────────────────────────────────────────────────
DDL = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS narration_structures (
    id                      BIGSERIAL PRIMARY KEY,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_url              TEXT NOT NULL,
    platform                TEXT,
    video_id                TEXT,
    title                   TEXT,
    channel                 TEXT,
    description             TEXT,
    duration_sec            DOUBLE PRECISION,
    language                TEXT,
    transcript              TEXT,
    narration_style         TEXT,
    narrator_posture        TEXT,
    hook_type               TEXT,
    hook_format             TEXT,
    hook_text               TEXT,
    beat_count              INTEGER,
    arc_template            TEXT[],
    punchline_type          TEXT,
    punchline_strength      TEXT,
    closing_type            TEXT,
    invites_debate          BOOLEAN,
    has_moral_preaching     BOOLEAN,
    has_controversy         BOOLEAN,
    likes                   BIGINT,
    comments_count          BIGINT,
    view_count              BIGINT,
    words_per_second        DOUBLE PRECISION,
    estimated_duration_sec  DOUBLE PRECISION,
    quality_score           DOUBLE PRECISION,
    analysis                JSONB NOT NULL,
    embedding               halfvec(4096),
    UNIQUE (source_url)
);
-- Idempotent forward-compat: add columns if an older table already exists.
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS narrator_posture   TEXT;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS hook_format        TEXT;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS beat_count         INTEGER;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS arc_template       TEXT[];
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS punchline_type     TEXT;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS punchline_strength TEXT;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS has_controversy    BOOLEAN;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS likes              BIGINT;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS comments_count     BIGINT;
ALTER TABLE narration_structures ADD COLUMN IF NOT EXISTS view_count         BIGINT;
CREATE INDEX IF NOT EXISTS narration_structures_style_idx    ON narration_structures (narration_style);
CREATE INDEX IF NOT EXISTS narration_structures_quality_idx  ON narration_structures (quality_score DESC);
CREATE INDEX IF NOT EXISTS narration_structures_hookfmt_idx  ON narration_structures (hook_format);
CREATE INDEX IF NOT EXISTS narration_structures_posture_idx  ON narration_structures (narrator_posture);
"""

UPSERT = """
INSERT INTO narration_structures (
    source_url, platform, video_id, title, channel, description, duration_sec,
    language, transcript, narration_style, narrator_posture,
    hook_type, hook_format, hook_text, beat_count, arc_template,
    punchline_type, punchline_strength, closing_type,
    invites_debate, has_moral_preaching, has_controversy,
    likes, comments_count, view_count,
    words_per_second, estimated_duration_sec, quality_score,
    analysis, embedding
) VALUES (
    %s,%s,%s,%s,%s,%s,%s,
    %s,%s,%s,%s,
    %s,%s,%s,%s,%s,
    %s,%s,%s,
    %s,%s,%s,
    %s,%s,%s,
    %s,%s,%s,
    %s::jsonb,%s::halfvec
)
ON CONFLICT (source_url) DO UPDATE SET
    created_at             = now(),
    platform               = EXCLUDED.platform,
    video_id               = EXCLUDED.video_id,
    title                  = EXCLUDED.title,
    channel                = EXCLUDED.channel,
    description            = EXCLUDED.description,
    duration_sec           = EXCLUDED.duration_sec,
    language               = EXCLUDED.language,
    transcript             = EXCLUDED.transcript,
    narration_style        = EXCLUDED.narration_style,
    narrator_posture       = EXCLUDED.narrator_posture,
    hook_type              = EXCLUDED.hook_type,
    hook_format            = EXCLUDED.hook_format,
    hook_text              = EXCLUDED.hook_text,
    beat_count             = EXCLUDED.beat_count,
    arc_template           = EXCLUDED.arc_template,
    punchline_type         = EXCLUDED.punchline_type,
    punchline_strength     = EXCLUDED.punchline_strength,
    closing_type           = EXCLUDED.closing_type,
    invites_debate         = EXCLUDED.invites_debate,
    has_moral_preaching    = EXCLUDED.has_moral_preaching,
    has_controversy        = EXCLUDED.has_controversy,
    likes                  = EXCLUDED.likes,
    comments_count         = EXCLUDED.comments_count,
    view_count             = EXCLUDED.view_count,
    words_per_second       = EXCLUDED.words_per_second,
    estimated_duration_sec = EXCLUDED.estimated_duration_sec,
    quality_score          = EXCLUDED.quality_score,
    analysis               = EXCLUDED.analysis,
    embedding              = EXCLUDED.embedding;
"""


def db_connect():
    import psycopg2  # lazy — only needed when actually writing to the DB
    url = os.environ.get("THOTH_SUPABASE_URL", "").strip()
    if not url:
        raise RuntimeError("THOTH_SUPABASE_URL not set")
    return psycopg2.connect(url)


def _vec_literal(emb: list | None) -> str | None:
    if not emb:
        return None
    return "[" + ",".join(f"{float(x):.6f}" for x in emb) + "]"


def _num(d: dict, *keys, default=None):
    cur = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


def _dget(d: dict, key: str) -> dict:
    v = d.get(key)
    return v if isinstance(v, dict) else {}


def _opt_bool(d: dict, key: str):
    return bool(d[key]) if key in d and d[key] is not None else None


def upsert_row(conn, url: str, platform: str, meta: dict, language: str,
               transcript: str, analysis: dict, emb: list | None):
    hook = _dget(analysis, "hook")
    closing = _dget(analysis, "closing")
    punch = _dget(analysis, "punchline")
    contro = _dget(analysis, "controversy")
    beats = analysis.get("beats") if isinstance(analysis.get("beats"), list) else []
    arc = analysis.get("arc_template")
    arc = [str(x) for x in arc] if isinstance(arc, list) else None
    row = (
        url, platform, meta.get("video_id", ""), meta.get("title", ""),
        meta.get("channel", ""), meta.get("description", ""),
        float(meta.get("duration_sec") or 0.0),
        language, transcript,
        analysis.get("narration_style"),
        analysis.get("narrator_posture"),
        hook.get("type"),
        hook.get("format"),
        hook.get("text"),
        len(beats) or None,
        arc,
        punch.get("type"),
        punch.get("strength"),
        closing.get("type"),
        _opt_bool(closing, "invites_debate"),
        _opt_bool(closing, "has_moral_preaching"),
        _opt_bool(contro, "has_social_controversy"),
        meta.get("likes"),
        meta.get("comments_count"),
        meta.get("view_count"),
        _to_float(analysis.get("words_per_second")),
        _to_float(analysis.get("estimated_duration_sec")),
        _to_float(analysis.get("quality_score")),
        json.dumps(analysis, ensure_ascii=False),
        _vec_literal(emb),
    )
    with conn.cursor() as cur:
        cur.execute(UPSERT, row)
    conn.commit()


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Driver
# ──────────────────────────────────────────────────────────────────────────────
def platform_of(url: str) -> str:
    host = urllib.parse.urlparse(url).netloc.lower().replace("www.", "")
    for key in ("tiktok", "instagram", "youtube", "youtu.be", "facebook",
                "twitter", "x.com", "vimeo", "twitch"):
        if key in host:
            return "youtube" if key == "youtu.be" else key.replace(".com", "")
    return host or "unknown"


def process_url(url: str, args, cfg: dict, novita_key: str, embed_key: str,
                conn) -> bool:
    log(f"\n=== {url} ===")
    use_cookies = not args.no_cookies
    meta = ytdlp_metadata(url, cfg, use_cookies)
    if meta.get("title"):
        log(f"  • {meta['title']}  ({meta.get('duration_sec',0):.0f}s, "
            f"@{meta.get('channel','?')})")

    with tempfile.TemporaryDirectory(prefix="narr_") as td:
        tmp = Path(td)
        log("  • downloading + transcoding audio…")
        audio = ytdlp_download_audio(url, tmp, cfg, use_cookies, args.max_audio_sec)
        if not audio:
            log("  ✗ skipped (audio unavailable)")
            return False
        if args.keep_audio:
            keep = ROOT / "test" / "narration_audio"
            keep.mkdir(parents=True, exist_ok=True)
            dest = keep / f"{meta.get('video_id') or 'aud'}.mp3"
            try:
                dest.write_bytes(audio.read_bytes())
                log(f"  • kept audio → {dest}")
            except OSError:
                pass

        log("  • transcribing (Groq Whisper)…")
        try:
            transcript, segs = transcribe_groq(audio, args.whisper_model, args.language)
        except Exception as e:
            log(f"  ✗ transcription failed: {e}")
            return False
        log(f"  • transcript: {len(transcript.split())} words, {len(segs)} segments")
        timed = timestamped_transcript(transcript, segs)

    log("  • analyzing narration structure (LLM)…")
    try:
        analysis = analyze_structure(
            timed, meta, args.language,
            cfg["novita_base_url"], args.llm_model or cfg["novita_model"], novita_key,
        )
    except Exception as e:
        log(f"  ✗ analysis failed: {e}")
        return False
    beats = analysis.get("beats") if isinstance(analysis.get("beats"), list) else []
    log(f"  • style={analysis.get('narration_style')} "
        f"posture={analysis.get('narrator_posture')} "
        f"hook={_num(analysis,'hook','format') or _num(analysis,'hook','type')} "
        f"beats={len(beats)} "
        f"punchline={_num(analysis,'punchline','strength')} "
        f"quality={analysis.get('quality_score')}")
    if beats:
        arc = " → ".join(str(b.get("label", "?")) for b in beats)
        log(f"  • arc: {arc}")

    emb = None
    if not args.no_embed:
        log("  • embedding…")
        emb_input = " | ".join(filter(None, [
            analysis.get("topic", ""), analysis.get("narration_style", ""),
            _num(analysis, "hook", "text") or "",
            analysis.get("what_makes_it_work", ""), transcript[:600],
        ]))
        emb = embed_text(emb_input, cfg["novita_base_url"], cfg["embed_model"], embed_key)
        if emb:
            log(f"  • embedding dims={len(emb)}")

    if args.dry_run:
        log("  • DRY RUN — analysis JSON:")
        log(json.dumps(analysis, ensure_ascii=False, indent=2))
        return True

    try:
        upsert_row(conn, url, platform_of(url), meta, args.language,
                   transcript, analysis, emb)
        log("  ✓ stored to Supabase (narration_structures)")
        return True
    except Exception as e:
        log(f"  ✗ DB write failed: {e}")
        return False


def main():
    ap = argparse.ArgumentParser(description="Analyze narration structure → Supabase")
    ap.add_argument("urls", nargs="*", help="video URLs")
    ap.add_argument("--urls-file", help="file with one URL per line")
    ap.add_argument("--language", default="id")
    ap.add_argument("--llm-model", default="")
    ap.add_argument("--whisper-model", default="whisper-large-v3")
    ap.add_argument("--max-audio-sec", type=int, default=1800)
    ap.add_argument("--no-embed", action="store_true")
    ap.add_argument("--no-cookies", action="store_true")
    ap.add_argument("--keep-audio", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--init-db", action="store_true",
                    help="create the narration_structures table, then continue")
    args = ap.parse_args()

    load_env()
    cfg = load_config()

    urls = list(args.urls)
    if args.urls_file:
        p = Path(args.urls_file)
        if not p.exists():
            log(f"urls-file not found: {p}")
            return 2
        urls += [ln.strip() for ln in p.read_text(encoding="utf-8").splitlines()
                 if ln.strip() and not ln.strip().startswith("#")]
    # de-dup, keep order
    urls = list(dict.fromkeys(urls))

    novita_key = os.environ.get("THOTH_NOVITA_API_KEY", "").strip()
    embed_key = (os.environ.get("THOTH_EMBED_API_KEY", "").strip() or novita_key)

    if not args.init_db and not urls:
        log("No URLs given. Pass URLs or --urls-file (or --init-db to just create the table).")
        return 2
    if not novita_key and urls:
        log("warn: THOTH_NOVITA_API_KEY not set — LLM analysis will fail")

    conn = None
    if not args.dry_run or args.init_db:
        try:
            conn = db_connect()
        except Exception as e:
            log(f"DB connect failed: {e}")
            if not args.dry_run:
                return 1

    if args.init_db and conn:
        log("Creating table narration_structures …")
        with conn.cursor() as cur:
            cur.execute(DDL)
        conn.commit()
        log("✓ table ready")

    ok = 0
    for url in urls:
        try:
            if process_url(url, args, cfg, novita_key, embed_key, conn):
                ok += 1
        except KeyboardInterrupt:
            log("\ninterrupted")
            break
        except Exception as e:
            log(f"  ✗ unexpected error: {e}")

    if conn:
        conn.close()
    if urls:
        log(f"\nDone: {ok}/{len(urls)} stored.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
