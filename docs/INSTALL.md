# Installation & Build

This guide takes you from nothing to a working Thoth binary on **Windows, Linux,
and macOS**.

There are two build paths — pick one:

| Path | What you get | When to choose it |
|---|---|---|
| **Lite (API)** | No GPU/CUDA. Transcription via the Groq Whisper API. | Fastest to set up; any OS; no NVIDIA GPU. |
| **Full (GPU)** | Local Whisper + CUDA acceleration + NVENC encoding. | You have an NVIDIA GPU and want offline/faster transcription. |

> **No NVIDIA GPU?** Use the **Lite** path, set `[ffmpeg] nvenc = false` (encode with
> libx264), and transcribe through the Groq Whisper API. Everything still works — just
> slower. On Apple Silicon macOS, Lite is the recommended path (CUDA is NVIDIA-only).

---

## 1. System prerequisites

| Item | Lite (API) | Full (GPU) |
|---|---|---|
| OS | Windows / Linux / macOS | Windows or Linux with an **NVIDIA** GPU |
| GPU | optional (NVENC speeds up encoding) | **NVIDIA** (CUDA Whisper + NVENC) |
| Disk | ~2 GB | ~8 GB (the `large-v3` Whisper model is ≈ 3 GB) |
| RAM | 8 GB+ | 16 GB+ |
| Internet | yes (LLM / Whisper API) | yes (LLM API; Whisper runs locally) |

---

## 2. Core toolchain (required for every path)

### Rust (2024 edition)

Install via [rustup](https://rustup.rs):

- **Windows**
  ```powershell
  winget install Rustlang.Rustup
  rustup default stable
  ```
- **Linux / macOS**
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  rustup default stable
  ```

### Git

- **Windows:** `winget install Git.Git`
- **Debian/Ubuntu:** `sudo apt install git`
- **Fedora:** `sudo dnf install git`
- **macOS:** `brew install git` (or the Xcode Command Line Tools)

### A C toolchain / linker (needed by Rust)

- **Windows:** Visual Studio 2022 Build Tools with the **"Desktop development with
  C++"** workload:
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools
  ```
- **Debian/Ubuntu:** `sudo apt install build-essential pkg-config`
- **Fedora:** `sudo dnf groupinstall "Development Tools"`
- **macOS:** `xcode-select --install`

### FFmpeg

Thoth needs FFmpeg. Two options:

1. **Auto (default & simplest)** — leave `[ffmpeg] ffmpeg_path = ""` in `config.toml`;
   the bundled `ffmpeg-sidecar` downloads a static FFmpeg on the first run.
2. **System / local** — install FFmpeg yourself and either put it on your `PATH`,
   drop the binary in the repo root, or set `[ffmpeg] ffmpeg_path` (or the
   `FFMPEG_PATH` env var) to its absolute path.
   - **Windows:** `winget install Gyan.FFmpeg`
   - **Debian/Ubuntu:** `sudo apt install ffmpeg`
   - **Fedora:** `sudo dnf install ffmpeg`
   - **macOS:** `brew install ffmpeg`

---

## 3. Python (for AI Cover, hook-title PNG & reaction memes)

The EDIT stage uses Python to render the cover, hook-title, and meme composites.
**Required** only if you want those features — without Python, the cover is skipped
and the hook title falls back to libass (both degrade gracefully).

```bash
# Python 3.10+ (check: python --version)
python -m pip install Pillow rembg onnxruntime
```

- **Pillow** — renders the headline text and composites the cover.
- **rembg** + **onnxruntime** — cut the subject out of a frame (the
  `u2net_human_seg` model, ~170 MB, auto-downloads on first use).
- Override the interpreter with the `THOTH_PYTHON` env var if `python` is not on
  your `PATH` (e.g. `THOTH_PYTHON=python3`).

### (Optional) A dedicated env for the News & TTS Python

For the `[news]` (Playwright) feature and some TTS/duration helpers:

```bash
conda env create -f environment.yml   # creates the "thoth-news" env
conda activate thoth-news
playwright install chromium
```

---

## 4. API keys (`.env`)

Copy the template and fill in the keys you actually use:

```bash
# Windows (PowerShell):  Copy-Item .env.example .env
# Linux / macOS:         cp .env.example .env
```

| Key | Required? | For |
|---|---|---|
| `THOTH_NOVITA_API_KEY` | **Yes** (default provider) | LLM analysis + narration + vision + cover background (FLUX) + meme selection |
| `THOTH_GROQ_API_KEY` | Lite path | Whisper API (transcription) when not using local Whisper |
| `THOTH_OPENAI_API_KEY` / `THOTH_CLAUDE_API_KEY` / `THOTH_GEMINI_API_KEY` | optional | Alternative LLM providers |
| `THOTH_SUPABASE_URL` | optional | RAG memory (pgvector) + Cultural Knowledge Base |
| `THOTH_ELEVENLABS_API_KEY` / `THOTH_MINIMAX_*` / `THOTH_FISH_AUDIO_API_KEY` | optional | TTS for narration/reaction |

Full list & descriptions: **[CONFIGURATION.md](CONFIGURATION.md)** and `.env.example`.
`.env` is git-ignored — never commit it.

---

## 5. Configuration (`config.toml`)

```bash
# Windows (PowerShell):  Copy-Item config.toml.example config.toml
# Linux / macOS:         cp config.toml.example config.toml
```

`config.toml` holds your local settings (git-ignored). The important knobs to check:

- `[llm] default_provider = "novita"`
- `[whisper] model_size` — `large-v3` (best) / `medium` (faster); ignored on the Lite
  path (which uses the Groq API)
- `[ffmpeg] nvenc` — `true` (NVIDIA) / `false` (CPU libx264)
- `[narration] enabled = true` (narrator mode)
- `[cover] enabled = true`, `[hook_title] engine = "python"`, `[assets] memes_in_narration = true`

Every section is documented in **[CONFIGURATION.md](CONFIGURATION.md)**.

---

## 6. Whisper models (Full/GPU path only)

The **Lite** path uses the Groq Whisper API → skip this step.
The **Full** path (local Whisper) needs a `ggml-*.bin` model in `models/`:

```bash
mkdir -p models
# best quality (~3 GB):
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin -o models/ggml-large-v3.bin
# or a lighter model:
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin  -o models/ggml-medium.bin
```

---

## 7. Build

### Lite (API) — fastest, no CUDA/LLVM

```bash
cargo build --release
```

Transcription goes through the Groq Whisper API (`THOTH_GROQ_API_KEY`).
Binaries land in `target/release/` (`thoth` / `thoth.exe`, and `thoth-server`).

### Full (GPU) — local Whisper + CUDA

Extra prerequisites:

- **LLVM/Clang** (for the whisper-rs bindgen step)
  - Windows: `winget install LLVM.LLVM`
  - Debian/Ubuntu: `sudo apt install llvm clang libclang-dev`
  - Fedora: `sudo dnf install llvm clang clang-devel`
- **CUDA Toolkit** 12.x+ — <https://developer.nvidia.com/cuda-downloads>
- **CMake + Ninja** — usually bundled with the VS Build Tools on Windows; otherwise
  install them (`winget install Kitware.CMake Ninja-build.Ninja`, `apt install cmake ninja-build`, `brew install cmake ninja`).

The `cuda` feature bundles `local-whisper` + GPU acceleration:

- **Windows** — a helper script sets the MSVC/LLVM/CUDA environment for you. Edit
  `build_cuda.bat` to match your CUDA/LLVM install paths (and the repo path), then:
  ```powershell
  .\build_cuda.bat
  ```
  It sets `vcvars64`, `LIBCLANG_PATH`, `CUDA_PATH`, `CMAKE_GENERATOR=Ninja`, then runs
  `cargo build --release -p thoth --features cuda` (and builds `thoth-server`).

- **Linux** — set the same environment variables in your shell, then build directly:
  ```bash
  export LIBCLANG_PATH=/usr/lib/llvm-<version>/lib     # where libclang.so lives
  export CUDA_PATH=/usr/local/cuda                     # your CUDA Toolkit root
  export CMAKE_GENERATOR=Ninja
  cargo build --release -p thoth --features cuda
  cargo build --release -p thoth-server
  ```

- **macOS** — CUDA is not available. Use the **Lite** path, or build local Whisper on
  CPU/Metal with `cargo build --release --features local-whisper` (no `cuda`).

---

## 8. First run

See **[RUNNING.md](RUNNING.md)** for per-OS run instructions (single-command CLI and
the server + worker deployment). A quick smoke test:

```bash
# Windows:  .\target\release\thoth.exe run "https://youtu.be/xxxx" --provider novita
# Unix:     ./target/release/thoth run "https://youtu.be/xxxx" --provider novita
```

Output lands in `output/.thoth/<job-id>/clips/*.mp4`.

---

## 9. (Optional) scout — automated content sourcing

To assemble a content-set (`{main, footage, comments, figures}`) from social media
automatically, use the `scout/` layer (Node.js ≥ 24 + a managed browser over CDP):

- **Setup:** [scout/SETUP.md](../scout/SETUP.md)
- **Daily flow & reference:** [scout/README.md](../scout/README.md) · [scout/RUNBOOK.md](../scout/RUNBOOK.md)

scout is **optional** — Thoth still runs via `thoth run <url>` without it.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `cargo build` fails: linker `link.exe` / `cc` not found | Install the C toolchain for your OS (§2). |
| CUDA build fails: `libclang` not found | Install LLVM and make sure `LIBCLANG_PATH` points at the folder containing `libclang.{dll,so,dylib}`. |
| CUDA build fails: `nvcc` / CUDA errors | Make sure `CUDA_PATH` matches your installed CUDA version. |
| Empty / errored transcript | Lite: check `THOTH_GROQ_API_KEY`. Full: make sure `models/ggml-*.bin` exists and matches `[whisper] model_size`. |
| Cover skipped / hook title shows `(ASS)` | `python -m pip install Pillow rembg onnxruntime`; ensure `python` is on `PATH` (or set `THOTH_PYTHON`). |
| Cover background generation fails | Check `THOTH_NOVITA_API_KEY` (used for FLUX + vision + memes). This is best-effort and falls back automatically. |
| Narration silently falls back to clip-mode | Don't use `--provider groq` (rate limit). Use `novita` (default). |
| Slow render / GPU unused | Set `[ffmpeg] nvenc = true` (needs NVIDIA); use the Full path for GPU Whisper. |

See also: **[CONFIGURATION.md](CONFIGURATION.md)** (all options), **[CLI.md](CLI.md)**
(commands), **[../CHANGELOG.md](../CHANGELOG.md)** (history).
