# CLIPPER

GPU-accelerated viral video clipping and editing automation. Takes a YouTube URL and produces polished short-form clips (9:16 vertical, 16:9, or 1:1) with word-level karaoke subtitles, driven by an LLM that identifies the best moments.

```
[YouTube URL]
     │
     ▼
1. INGEST      → yt-dlp              → Local .mp4
     │
     ▼
2. TRANSCRIBE  → Groq Whisper API    → transcript.json (word-level timestamps)
               → (or local whisper.cpp with CUDA)
     │
     ▼
3. ANALYZE     → Groq / OpenAI / Ollama LLM  → moments.json
     │
     ▼
4. EDIT        → FFmpeg + NVENC      → clip_000_*.mp4, clip_001_*.mp4 …
     │
     ▼
[Short Video Output (.mp4) with burned subtitles]
```

---

## Prerequisites

### Required

| Tool | Install |
|------|---------|
| **Rust** 1.85+ | `winget install Rustlang.Rustup` |
| **yt-dlp** | `winget install yt-dlp.yt-dlp` |
| **API Keys** | Groq, OpenAI, Gemini, or Claude |

FFmpeg is managed automatically by `ffmpeg-sidecar` — no manual install needed.

### Optional (for local GPU transcription)

| Tool | Notes |
|------|-------|
| **CUDA Toolkit 12.x** | [developer.nvidia.com/cuda-downloads](https://developer.nvidia.com/cuda-downloads) |
| **LLVM / Clang** | `winget install LLVM.LLVM` — required for `whisper-rs` bindgen |
| **Whisper ggml model** | Download instructions below |

---

## Quick Start

### 1. Configure API keys

```powershell
# Copy the example and fill in your keys
Copy-Item .env.example .env
# Edit .env and set CLIPPER_GROQ_API_KEY
```

Or set directly in your shell:

```powershell
$env:CLIPPER_GROQ_API_KEY = "your_key_here"
```

### 2. Build

```powershell
# Standard build (Groq API for transcription — no CUDA required)
cargo build --release

# GPU build (local Whisper with CUDA — requires LLVM + CUDA Toolkit)
cargo build --release --features cuda
```

### 3. Run the full pipeline

```powershell
.\target\release\clipper.exe run "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

---

## Usage

### Full pipeline

```
clipper run <URL> [OPTIONS]

Options:
  -o, --output-dir <DIR>      Output directory [default: ./output]
      --provider <name>       groq | openai | ollama [default: groq]
      --model <SIZE>          Whisper model size [default: medium]
      --max-clips <N>         Number of clips to produce [default: 3]
      --layout <LAYOUT>       vertical | horizontal | square [default: vertical]
      --resume <JOB_ID>       Resume a previously interrupted job
```

### Individual stages

```powershell
# Stage 1: Download
clipper ingest "https://youtu.be/..." --output-dir ./output

# Stage 2: Transcribe (uses Groq API by default)
clipper transcribe ./output/.clipper/<job_id>/source/video.mp4

# Stage 3: Find viral moments
clipper analyze ./output/.clipper/<job_id>/transcribe/transcript.json --max-clips 3

# Stage 4: Render clips
clipper edit ./source.mp4 ./moments.json ./transcript.json --layout vertical
```

### Resume an interrupted pipeline

If the pipeline fails mid-way (e.g. network error during analysis), resume from where it stopped:

```powershell
clipper run "https://youtu.be/..." --resume 550e8400-e29b-41d4-a716-446655440000
```

---

## Output Structure

```
output/
└── .clipper/
    └── <job_id>/
        ├── state.json                   # Pipeline state (enables resume)
        ├── source/
        │   ├── <video_id>.mp4           # Downloaded video
        │   └── audio.wav                # 16kHz mono for transcription
        ├── transcribe/
        │   └── transcript.json          # Word-level timestamps
        ├── analyze/
        │   └── moments.json             # Viral moment list from LLM
        └── clips/
            ├── clip_000_<title>.ass     # ASS subtitle file
            └── clip_000_<title>.mp4     # Final rendered clip
```

---

## Local Whisper Setup (optional, GPU-accelerated)

If you want faster, offline transcription without API costs:

### 1. Install prerequisites

```powershell
# Install LLVM (required for bindgen)
winget install LLVM.LLVM

# Install CUDA Toolkit 12.x from:
# https://developer.nvidia.com/cuda-downloads
```

### 2. Automatic Model Download

Clipper will automatically download the required Whisper model (from HuggingFace) on its first run if it's missing from the `models/` directory.

### 3. Build with CUDA

```powershell
.\build_cuda.bat
```

---

## Configuration

Edit `config.toml` to adjust defaults. Never put API keys there — use environment variables:

```
CLIPPER_GROQ_API_KEY=...
CLIPPER_OPENAI_API_KEY=...
RUST_LOG=clipper=debug    # verbose logging
```

---

## Subtitle Style

Clips include word-level karaoke subtitles:
- **White bold** text for the sentence
- **Yellow highlighted** text for the currently spoken word
- Bottom-center alignment, Arial 52pt with black outline
- Burned in via FFmpeg ASS filter

---

## GPU Encoding

Video is encoded with `h264_nvenc` (NVIDIA GPU encoder) by default:
- Much faster than CPU `libx264`
- Comparable quality at the same bitrate
- Set `nvenc = false` in `config.toml` to fall back to CPU encoding
