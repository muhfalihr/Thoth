#!/usr/bin/env python3
"""CLIPPER narration TTS — full narrator voice + WORD-LEVEL timings.

Drives the Animelorian "narrator-driven" edit: synthesizes one continuous
narration to MP3 AND returns per-word timestamps so the edit can word-pop
subtitles and pace the footage to the voice.

Engine: Microsoft Edge TTS (free, natural id-ID voices). Edge emits
SentenceBoundary events (not word) in this version, so word timings are
derived by distributing each sentence's [offset, offset+duration] span across
its words proportionally to character length — good enough for word-pop subs.

Output JSON (stdout, last line):
    {"success": true, "path": "<abs mp3>", "duration_secs": 47.2,
     "words": [{"word": "Jadi", "start_ms": 100, "end_ms": 480}, ...]}
    {"success": false, "error": "..."}

Usage:
    python tts_narrate.py --text "..." --voice id-ID-ArdiNeural \
        --output out/narration.mp3 --rate +8% [--words-out out/words.json]
"""

import argparse, asyncio, json, re, sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def log(msg):
    print(f"[tts_narrate] {msg}", file=sys.stderr, flush=True)


def emit(d, code=0):
    print(json.dumps(d, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def split_words(text):
    # keep word tokens (letters/digits/apostrophes); punctuation rides the prior word
    return [w for w in re.findall(r"\S+", text) if w]


def distribute_words(sentence_text, start_ms, dur_ms):
    """Spread a sentence's time span across its words by char length."""
    words = split_words(sentence_text)
    if not words:
        return []
    weights = [max(len(re.sub(r"[^\w']", "", w)), 1) for w in words]
    total = sum(weights)
    out, t = [], start_ms
    for w, wt in zip(words, weights):
        slice_ms = dur_ms * (wt / total)
        s = int(round(t))
        e = int(round(t + slice_ms))
        out.append({"word": w, "start_ms": s, "end_ms": max(e, s + 30)})
        t += slice_ms
    return out


async def synth(text, voice, out_path, rate, volume, pitch):
    import edge_tts
    out_path.parent.mkdir(parents=True, exist_ok=True)
    c = edge_tts.Communicate(text=text, voice=voice, rate=rate, volume=volume, pitch=pitch)
    sentences = []
    with open(out_path, "wb") as f:
        async for chunk in c.stream():
            t = chunk.get("type")
            if t == "audio":
                f.write(chunk["data"])
            elif t in ("SentenceBoundary", "WordBoundary"):
                sentences.append((chunk.get("text", ""),
                                  chunk.get("offset", 0) / 1e4,    # 100ns → ms
                                  chunk.get("duration", 0) / 1e4))
    # Build word timings
    words = []
    if sentences and any(s[0] for s in sentences):
        for txt, off_ms, dur_ms in sentences:
            words.extend(distribute_words(txt, off_ms, dur_ms))
    # Duration: prefer mutagen, else last boundary, else size estimate
    duration = 0.0
    try:
        from mutagen.mp3 import MP3
        duration = MP3(str(out_path)).info.length
    except Exception:
        if sentences:
            duration = (sentences[-1][1] + sentences[-1][2]) / 1000.0
        else:
            duration = out_path.stat().st_size / 16000.0
    # Fallback word timings: spread all words across full duration
    if not words:
        all_w = split_words(text)
        if all_w:
            per = (duration * 1000.0) / len(all_w)
            for i, w in enumerate(all_w):
                words.append({"word": w, "start_ms": int(i * per),
                              "end_ms": int((i + 1) * per)})
    return duration, words


def main():
    p = argparse.ArgumentParser(description="CLIPPER narration TTS with word timings")
    p.add_argument("--text", required=True)
    p.add_argument("--voice", default="id-ID-ArdiNeural")
    p.add_argument("--output", required=True)
    p.add_argument("--rate", default="+0%")
    p.add_argument("--volume", default="+0%")
    p.add_argument("--pitch", default="+0Hz")
    p.add_argument("--words-out", default="")
    args = p.parse_args()

    try:
        import edge_tts  # noqa
    except ImportError:
        emit({"success": False, "error": "edge-tts not installed (pip install edge-tts)"}, 3)

    out_path = Path(args.output).resolve()
    try:
        duration, words = asyncio.run(
            synth(args.text, args.voice, out_path, args.rate, args.volume, args.pitch)
        )
    except Exception as e:
        emit({"success": False, "error": f"narration TTS failed: {e}"}, 1)

    if args.words_out:
        wp = Path(args.words_out).resolve()
        wp.parent.mkdir(parents=True, exist_ok=True)
        wp.write_text(json.dumps({"words": words}, ensure_ascii=False), encoding="utf-8")

    log(f"{len(words)} words, {duration:.1f}s → {out_path}")
    emit({"success": True, "path": str(out_path),
          "duration_secs": round(duration, 2), "words": words})


if __name__ == "__main__":
    main()
