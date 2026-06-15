#!/usr/bin/env python3
"""Deep structural analysis of a short-form video (visual + voice) via Novita VL.

Stdlib-only (urllib). Sends timestamped frames + Whisper transcript to a Novita
vision model and asks for a deep breakdown of visual hooks, character intro,
social-media display, subtitle style, and audio/voice structure.

Usage:
    python scripts/analyze_short.py \
        --frames-dir test/analysis/frames/v1 \
        --transcript path/to/transcript.json \
        --title "..." --channel "Animelorian" --duration 46.7 \
        --out test/analysis/report_v1.md

Requires THOTH_NOVITA_API_KEY in .env or environment.
"""
import argparse
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent.parent


def load_env():
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def b64_image(path: Path) -> str:
    data = path.read_bytes()
    return "data:image/jpeg;base64," + base64.b64encode(data).decode()


def sample_frames(frames_dir: Path, max_frames: int):
    files = sorted(frames_dir.glob("f_*.jpg"))
    if len(files) <= max_frames:
        return files
    # Always keep the first 6 (the hook), then sample the rest evenly.
    head = files[:6]
    rest = files[6:]
    keep = max_frames - len(head)
    step = max(1, len(rest) // keep)
    sampled = rest[::step][:keep]
    return head + sampled


def frame_seconds(path: Path) -> int:
    # f_001.jpg -> frame 1 -> ~0s (fps=1, first frame at t=0)
    n = int(path.stem.split("_")[1])
    return n - 1


def format_transcript(transcript_path: Path) -> str:
    data = json.loads(transcript_path.read_text(encoding="utf-8"))
    lines = []
    for seg in data.get("segments", []):
        s = seg.get("start_ms", 0) / 1000.0
        e = seg.get("end_ms", 0) / 1000.0
        txt = seg.get("text", "").strip()
        lines.append(f"[{s:5.1f}-{e:5.1f}] {txt}")
    return "\n".join(lines)


PROMPT = """Kamu adalah analis konten video pendek (TikTok/YouTube Shorts) tingkat ahli.
Aku memberimu RANGKAIAN FRAME (1 frame/detik, timestamp 't=Ns' tertera di kiri-atas
tiap frame) dan TRANSCRIPT suara (timestamp dalam detik) dari satu video pendek.

Judul: {title}
Channel: {channel}
Durasi: {duration} detik

=== TRANSCRIPT SUARA ===
{transcript}
=== AKHIR TRANSCRIPT ===

Analisis STRUKTUR video ini SEDALAM MUNGKIN, gabungkan bukti visual (frame) dan audio
(transcript). Tulis dalam Bahasa Indonesia, terstruktur dengan heading markdown.
WAJIB rujuk timestamp konkret (mis. "pada t=2s") sebagai bukti. Bahas SEMUA poin ini:

## 1. VISUAL HOOK (0-3 detik)
- Apa persis yang tampil di frame pertama? (karakter, teks, warna, ekspresi, efek)
- Teknik menahan scroll: kontras warna, gerakan, teks besar, rasa penasaran?
- Kalimat pembuka di audio dan bagaimana ia menciptakan curiosity gap.

## 2. AUDIO / VOICE HOOK & STRUKTUR NARASI
- Kalimat pembuka verbal (verbatim) dan fungsinya.
- Gaya bicara: tempo, energi, persona (sarkas/lucu/serius), apakah TTS atau manusia?
- Struktur narasi: setup -> konflik -> punchline. Petakan ke timestamp.
- Bagaimana audio menjaga retensi sampai detik terakhir (CTA/cliffhanger?).

## 3. CARA MEMPERKENALKAN KARAKTER
- Karakter/tokoh apa saja yang dibahas? Kapan diperkenalkan (timestamp)?
- Apakah ada FOTO/AVATAR karakter yang ditampilkan? Bentuknya (3D render, foto asli, screenshot)?
- Apakah ada NAMA / HANDLE / AKUN SOCIAL MEDIA yang ditampilkan? (screenshot IG/TikTok, username, jumlah follower) Sebut timestamp & isi persisnya.
- Bagaimana penonton tahu "siapa" yang sedang dibahas secara visual.

## 4. ELEMEN VISUAL & OVERLAY
- Overlay screenshot (postingan IG/berita/komentar): kapan muncul, isinya, posisinya.
- Efek visual: petir, zoom, shake, flash, transisi. Timestamp & fungsinya.
- Background: statis/dinamis, gaya (gelap dramatis, dll).
- Layout: di mana karakter, teks, dan overlay ditempatkan dalam frame 9:16.

## 5. GAYA SUBTITLE (CapCut style)
- Posisi, font, ukuran, warna (kata kunci diwarnai/di-bold?), animasi kata.
- Sinkronisasi dengan suara, jumlah kata per baris.

## 6. TEMPLATE / POLA YANG BISA DITIRU
- Ringkas "resep" video ini sebagai template langkah-demi-langkah (timeline detik).
- Apa elemen paling penting untuk virality menurut bukti di video ini.

Jawab lengkap, konkret, dan kaya bukti timestamp."""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--channel", default="")
    ap.add_argument("--duration", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="qwen/qwen2.5-vl-72b-instruct")
    ap.add_argument("--max-frames", type=int, default=30)
    args = ap.parse_args()

    load_env()
    api_key = os.environ.get("THOTH_NOVITA_API_KEY", "")
    if not api_key:
        print("ERROR: THOTH_NOVITA_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    frames_dir = Path(args.frames_dir)
    transcript = format_transcript(Path(args.transcript))
    frames = sample_frames(frames_dir, args.max_frames)
    print(f"[{frames_dir.name}] sending {len(frames)} frames, model={args.model}", file=sys.stderr)

    prompt = PROMPT.format(
        title=args.title, channel=args.channel,
        duration=args.duration, transcript=transcript,
    )

    content = [{"type": "text", "text": prompt}]
    for f in frames:
        content.append({"type": "text", "text": f"\n[FRAME t={frame_seconds(f)}s]"})
        content.append({"type": "image_url", "image_url": {"url": b64_image(f)}})

    body = {
        "model": args.model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.4,
        "max_tokens": 4000,
    }

    import time
    payload = json.dumps(body).encode("utf-8")
    result = None
    last_err = None
    for attempt in range(1, 7):
        req = urllib.request.Request(
            "https://api.novita.ai/openai/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "thoth-analyzer/1.0 (+https://novita.ai)",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                result = json.loads(resp.read().decode())
            break
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}: {e.read().decode()[:300]}"
            if e.code in (429, 500, 502, 503, 529):
                wait = min(8 * attempt, 40)
                print(f"  attempt {attempt} failed ({last_err}); retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            print(last_err, file=sys.stderr)
            sys.exit(1)
        except Exception as e:  # noqa
            last_err = str(e)
            print(f"  attempt {attempt} error: {last_err}; retry", file=sys.stderr)
            time.sleep(8 * attempt)
    if result is None:
        print(f"FAILED after retries: {last_err}", file=sys.stderr)
        sys.exit(1)

    text = result["choices"][0]["message"]["content"]
    usage = result.get("usage", {})

    out = Path(args.out)
    header = f"# Analisis: {args.title}\n\n**Channel:** {args.channel}  |  **Durasi:** {args.duration}s  |  **Frames:** {len(frames)}  |  **Model:** {args.model}\n\n---\n\n"
    out.write_text(header + text, encoding="utf-8")
    print(f"OK -> {out}  (tokens: prompt={usage.get('prompt_tokens')}, completion={usage.get('completion_tokens')})", file=sys.stderr)


if __name__ == "__main__":
    main()
