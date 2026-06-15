#!/usr/bin/env python3
"""Thoth TTS synthesis via Microsoft Edge TTS (Phase 4).

Menggunakan `edge-tts` (Python package) untuk menghasilkan audio MP3 dari teks.
Edge TTS gratis, tidak butuh API key, dan mendukung suara Indonesia yang natural.

Output JSON ke stdout:
    {"success": true, "path": "/abs/path/voice.mp3", "duration_secs": 12.5}
    {"success": false, "error": "...", "path": null, "duration_secs": 0}

Usage:
    python tts_generate.py --text "..." --voice id-ID-ArdiNeural --output /path/voice.mp3
        [--rate +0%] [--volume +0%] [--pitch +0Hz]

Supported Indonesian voices:
    id-ID-ArdiNeural    ← pria, natural
    id-ID-GadisNeural   ← wanita, natural

Install:
    pip install edge-tts
"""

import argparse
import json
import sys
import os
import asyncio
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def log(msg: str) -> None:
    print(f"[tts] {msg}", file=sys.stderr, flush=True)


def emit(success: bool, path=None, duration_secs=0.0, error="") -> None:
    d = {"success": success, "path": path, "duration_secs": duration_secs}
    if error:
        d["error"] = error
    print(json.dumps(d, ensure_ascii=False))
    sys.stdout.flush()


def parse_args():
    p = argparse.ArgumentParser(description="Thoth Edge TTS synthesis")
    p.add_argument("--text",   required=True, help="text to synthesize")
    p.add_argument("--voice",  default="id-ID-ArdiNeural", help="Edge TTS voice name")
    p.add_argument("--output", required=True, help="output MP3 file path")
    p.add_argument("--rate",   default="+0%",  help="speech rate, e.g. +10% or -5%")
    p.add_argument("--volume", default="+0%",  help="volume, e.g. +20%")
    p.add_argument("--pitch",  default="+0Hz", help="pitch, e.g. +5Hz")
    return p.parse_args()


async def synthesize_edge_tts(text: str, voice: str, output_path: Path,
                               rate: str, volume: str, pitch: str) -> float:
    """Run edge-tts and return duration in seconds."""
    import edge_tts

    output_path.parent.mkdir(parents=True, exist_ok=True)

    communicate = edge_tts.Communicate(
        text=text,
        voice=voice,
        rate=rate,
        volume=volume,
        pitch=pitch,
    )

    log(f"synthesizing {len(text.split())} words with voice={voice}")
    await communicate.save(str(output_path))

    # Estimate duration from file size (MP3 ~128kbps ≈ 16 KB/s)
    size_bytes = output_path.stat().st_size
    duration = size_bytes / 16_000.0

    # Try to get exact duration via mutagen (optional dependency)
    try:
        from mutagen.mp3 import MP3
        audio = MP3(str(output_path))
        duration = audio.info.length
    except ImportError:
        pass  # mutagen not installed — use estimate

    log(f"saved {size_bytes//1024}KB → {output_path} ({duration:.1f}s)")
    return duration


def main():
    args = parse_args()
    output_path = Path(args.output).resolve()

    try:
        import edge_tts
    except ImportError:
        emit(False, error="edge-tts not installed — run: pip install edge-tts")
        sys.exit(3)

    try:
        duration = asyncio.run(
            synthesize_edge_tts(
                text=args.text,
                voice=args.voice,
                output_path=output_path,
                rate=args.rate,
                volume=args.volume,
                pitch=args.pitch,
            )
        )
        emit(True, path=str(output_path), duration_secs=round(duration, 2))
    except Exception as e:
        emit(False, error=f"TTS failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
