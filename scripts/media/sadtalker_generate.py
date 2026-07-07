#!/usr/bin/env python3
"""Thoth SadTalker talking avatar generation (Phase 6).

Wrapper untuk SadTalker inference.py yang menghasilkan video talking head
lip-synced dari 1 foto avatar + audio TTS.

Output JSON ke stdout:
    {"success": true, "path": "/abs/path/talking_avatar.mp4", "duration_secs": 14.2}
    {"success": false, "error": "...", "path": null, "duration_secs": 0}

Usage:
    python sadtalker_generate.py \\
        --audio  voice.mp3 \\
        --image  avatar.png \\
        --output reaction/avatar_talking.mp4 \\
        --sadtalker-dir tools/SadTalker \\
        [--size 256] [--still] [--enhancer gfpgan]

Requirements (conda env thoth-sadtalker):
    Setup via scripts/setup_sadtalker.bat

SadTalker repo: https://github.com/OpenTalker/SadTalker
"""

import argparse
import json
import sys
import os
import subprocess
import glob
import shutil
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def log(msg: str) -> None:
    print(f"[sadtalker] {msg}", file=sys.stderr, flush=True)


def emit(success: bool, path=None, duration_secs=0.0, error="") -> None:
    d = {"success": success, "path": path, "duration_secs": duration_secs}
    if error:
        d["error"] = error
    print(json.dumps(d, ensure_ascii=False))
    sys.stdout.flush()


def parse_args():
    p = argparse.ArgumentParser(description="Thoth SadTalker wrapper")
    p.add_argument("--audio",         required=True,  help="TTS audio file (MP3/WAV)")
    p.add_argument("--image",         required=True,  help="avatar portrait PNG/JPG")
    p.add_argument("--output",        required=True,  help="output MP4 file path")
    p.add_argument("--sadtalker-dir", default="tools/SadTalker", help="SadTalker repo root")
    p.add_argument("--size",          type=int, default=256, choices=[256, 512],
                   help="face image size (256=fast, 512=high quality)")
    p.add_argument("--still",         action="store_true",
                   help="still mode — reduce head movement")
    p.add_argument("--enhancer",      default="",
                   help="face enhancer: gfpgan | RestoreFormer (slower but higher quality)")
    return p.parse_args()


def get_audio_duration(audio_path: str) -> float:
    """Estimate duration from file size (MP3 ~128kbps ≈ 16KB/s)."""
    try:
        from mutagen.mp3 import MP3
        return MP3(audio_path).info.length
    except Exception:
        pass
    try:
        size = Path(audio_path).stat().st_size
        return size / 16_000.0
    except Exception:
        return 10.0


def find_output_video(result_dir: Path, stem: str) -> Path | None:
    """SadTalker writes to result_dir/<stem>*.mp4 — find the newest one."""
    candidates = sorted(result_dir.glob(f"{stem}*.mp4"), key=lambda p: p.stat().st_mtime)
    if candidates:
        return candidates[-1]
    # Fallback: any MP4 in result dir
    candidates = sorted(result_dir.glob("*.mp4"), key=lambda p: p.stat().st_mtime)
    return candidates[-1] if candidates else None


def main():
    args = parse_args()

    sadtalker_dir = Path(args.sadtalker_dir).resolve()
    audio_path    = Path(args.audio).resolve()
    image_path    = Path(args.image).resolve()
    output_path   = Path(args.output).resolve()

    # ── Validate inputs ───────────────────────────────────────────────────────
    if not sadtalker_dir.exists():
        emit(False, error=f"SadTalker not found at '{sadtalker_dir}'. "
                          f"Run scripts/setup_sadtalker.bat first.")
        sys.exit(1)

    inference_py = sadtalker_dir / "inference.py"
    if not inference_py.exists():
        emit(False, error=f"inference.py not found in '{sadtalker_dir}'. "
                          f"Check that SadTalker was cloned correctly.")
        sys.exit(1)

    if not audio_path.exists():
        emit(False, error=f"audio file not found: {audio_path}")
        sys.exit(1)

    if not image_path.exists():
        emit(False, error=f"image file not found: {image_path}")
        sys.exit(1)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Run SadTalker ─────────────────────────────────────────────────────────
    # SadTalker saves output to --result_dir/<input_stem>_*.mp4
    result_dir = output_path.parent / "sadtalker_tmp"
    result_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,        # use current Python (already in thoth-sadtalker env)
        str(inference_py),
        "--driven_audio",  str(audio_path),
        "--source_image",  str(image_path),
        "--result_dir",    str(result_dir),
        "--size",          str(args.size),
    ]
    if args.still:
        cmd.append("--still")
    if args.enhancer:
        cmd.extend(["--enhancer", args.enhancer])

    log(f"running SadTalker: size={args.size} still={args.still} enhancer='{args.enhancer}'")
    log(f"  audio: {audio_path.name}  image: {image_path.name}")

    try:
        result = subprocess.run(
            cmd,
            cwd=str(sadtalker_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,   # 5 minutes max
        )
    except subprocess.TimeoutExpired:
        emit(False, error="SadTalker timed out (>300s)")
        sys.exit(1)
    except Exception as e:
        emit(False, error=f"subprocess error: {e}")
        sys.exit(1)

    if result.returncode != 0:
        stderr = result.stderr[-800:] if result.stderr else "(no stderr)"
        emit(False, error=f"SadTalker exited {result.returncode}: {stderr}")
        sys.exit(1)

    # ── Find and move output ──────────────────────────────────────────────────
    generated = find_output_video(result_dir, image_path.stem)
    if generated is None:
        emit(False, error=f"SadTalker finished but no MP4 found in {result_dir}")
        sys.exit(1)

    shutil.move(str(generated), str(output_path))
    log(f"output moved → {output_path}")

    # Cleanup tmp dir
    try:
        shutil.rmtree(result_dir, ignore_errors=True)
    except Exception:
        pass

    duration = get_audio_duration(str(audio_path))
    emit(True, path=str(output_path), duration_secs=round(duration, 2))


if __name__ == "__main__":
    main()
