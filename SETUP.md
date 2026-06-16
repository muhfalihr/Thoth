# 🪶 Thoth — Setup Guide

Panduan setup lengkap dari nol: prerequisite → toolchain → build → run.
Ada **dua jalur build**: **Lite (API)** yang ringan tanpa GPU/CUDA, dan **Full (GPU)**
dengan Whisper lokal + CUDA. Pilih sesuai kebutuhan.

---

## 1. System Prerequisites

| Item | Lite (API) | Full (GPU) |
|---|---|---|
| OS | Windows 10/11 (utama), Linux/macOS bisa manual | Windows 10/11 (`build_cuda.bat`) |
| GPU | opsional (NVENC mempercepat encode) | **NVIDIA** (CUDA Whisper + NVENC) |
| Disk | ~2 GB | ~8 GB (model Whisper large-v3 ≈ 3 GB) |
| RAM | 8 GB+ | 16 GB+ |
| Internet | ya (LLM/Whisper API) | ya (LLM API; Whisper lokal) |

> **Tanpa NVIDIA GPU:** pakai jalur **Lite**, set `[ffmpeg] nvenc = false` (encode pakai libx264),
> dan transkripsi lewat **Groq Whisper API** (gratis tier). Semua tetap jalan, hanya lebih lambat.

---

## 2. Core Toolchain (wajib untuk semua jalur)

1. **Rust (2024 edition)** — install via [rustup](https://rustup.rs):
   ```powershell
   winget install Rustlang.Rustup
   rustup default stable
   ```
2. **Git**:
   ```powershell
   winget install Git.Git
   ```
3. **FFmpeg** — dua opsi:
   - **(a) Local** (disarankan): taruh `ffmpeg.exe` di root project, set `config.toml` `[ffmpeg] ffmpeg_path = ""` → atau isi path absolut.
   - **(b) Auto**: biarkan `ffmpeg_path = ""` → `ffmpeg-sidecar` mengunduh FFmpeg otomatis saat run pertama.
4. **MSVC Build Tools** (linker Windows untuk Rust) — Visual Studio 2022 Build Tools:
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools
   ```
   Saat install centang **"Desktop development with C++"**.

---

## 3. Python (untuk AI Cover, Hook-title PNG & Reaction Meme)

Stage EDIT memakai Python untuk render cover/headline/meme. **Wajib** kalau mau fitur
cover & hook-title PNG (kalau tak ada → cover dilewati, hook title fallback ke libass).

```powershell
# Python 3.10+ (cek: python --version)
python -m pip install Pillow rembg onnxruntime
```
- **Pillow** — render teks headline & komposit cover.
- **rembg** + **onnxruntime** — cutout subjek dari frame (model `u2net_human_seg` auto-download ~170 MB saat pertama dipakai).
- Override interpreter via env `THOTH_PYTHON` bila perlu (default: `python` di PATH).

### (Opsional) Conda env untuk News & TTS Python
Untuk fitur `[news]` (Playwright) / TTS Edge / durasi MP3:
```powershell
conda env create -f environment.yml   # membuat env "thoth-news"
conda activate thoth-news
playwright install chromium
```

---

## 4. API Keys (`.env`)

```powershell
copy .env.example .env      # lalu edit .env
```

| Key | Wajib? | Untuk |
|---|---|---|
| `THOTH_NOVITA_API_KEY` | **Ya** (default provider) | LLM analyze + narasi + vision + **cover background (FLUX)** + pemilihan meme |
| `THOTH_GROQ_API_KEY` | jalur Lite | Whisper API (transkripsi) bila tanpa Whisper lokal |
| `THOTH_OPENAI/CLAUDE/GEMINI_API_KEY` | opsional | provider LLM alternatif |
| `THOTH_SUPABASE_URL` | opsional | RAG memory (pgvector) |
| `THOTH_MINIMAX/FISH_AUDIO/ELEVENLABS_*` | opsional | TTS narasi/reaksi |

> `.env` **tidak** di-commit (sudah di `.gitignore`). Backward-compat: prefix lama `CLIPPER_*`
> otomatis dibaca sebagai `THOTH_*`.

---

## 5. Konfigurasi (`config.toml`)

```powershell
copy config.toml.example config.toml
```
`config.toml` berisi setting lokal (tidak di-commit). Yang penting dicek:
- `[llm] default_provider = "novita"`
- `[whisper] model_size` — `large-v3` (terbaik) / `medium` (cepat); diabaikan di jalur Lite (pakai Groq API)
- `[ffmpeg] nvenc` — `true` (NVIDIA) / `false` (CPU libx264)
- `[narration] enabled = true` (mode narator)
- `[cover] enabled = true`, `[hook_title] engine = "python"`, `[assets] memes_in_narration = true`

---

## 6. Whisper Models (HANYA jalur Full/GPU)

Jalur **Lite** memakai **Groq Whisper API** → lewati langkah ini.
Jalur **Full** (Whisper lokal) butuh model `ggml-*.bin` di `models/`:
```powershell
mkdir models
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin -o models/ggml-large-v3.bin
# atau yang lebih ringan:
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin  -o models/ggml-medium.bin
```

---

## 7. Build

### Jalur Lite (API) — paling cepat setup, tanpa CUDA/LLVM
```powershell
cargo build --release
```
Transkripsi via Groq Whisper API (`THOTH_GROQ_API_KEY`). Binary: `target\release\thoth.exe`.

### Jalur Full (GPU) — Whisper lokal + CUDA
Butuh tambahan:
- **LLVM/Clang** (bindgen whisper-rs): `winget install LLVM.LLVM`
- **CUDA Toolkit** (setup ini pakai **v13.2**; 12.x+ juga didukung): <https://developer.nvidia.com/cuda-downloads>
- **CMake + Ninja** (umumnya ikut VS Build Tools; atau `winget install Kitware.CMake Ninja-build.Ninja`)

Edit **`build_cuda.bat`** → sesuaikan baris `cd /d "<path repo>"` dan path CUDA/LLVM bila beda versi, lalu:
```powershell
.\build_cuda.bat
```
Script ini set `vcvars64`, `LIBCLANG_PATH`, `CUDA_PATH`, `CMAKE_GENERATOR=Ninja`, lalu
`cargo build --release --features cuda` (feature `cuda` = `local-whisper` + GPU).

---

## 8. First Run

### Single URL
```powershell
.\target\release\thoth.exe run --url "https://www.tiktok.com/@user/video/123" --provider novita
```

### Content-set (hasil OpenClaw sourcing)
```powershell
.\target\release\thoth.exe run --content "C:\path\to\content_set.json" --provider novita
```
Output: `output\.thoth\<job-id>\clips\*.mp4`.

**Tanda run sehat di log:** `Stage 4/5: Narration` (tanpa `WARN Narration failed`) →
`🎬 Narrator-driven video` → `🖼️ AI cover (…Novita FLUX + rembg)` → `💥 Hook title PNG (Pillow)` →
`🎭 Reaction memes: N placed`.

---

## 9. (Opsional) OpenClaw — Content Sourcing Otomatis

Untuk merakit content-set `{main, footage, comments, figures}` dari sosmed secara otomatis:
- **Setup OpenClaw** (install, Node.js, node host + CDP relay 18792, pairing, key, skill, deploy
  script): **[openclaw/SETUP.md](openclaw/SETUP.md)**.
- **Flow harian** (discover_reels → run_pipeline → `thoth run --content`): **[openclaw/README.md](openclaw/README.md)**.

> OpenClaw **opsional** — Thoth tetap jalan via `thoth run --url <link>` tanpanya.

---

## 10. Verifikasi & Troubleshooting

| Gejala | Fix |
|---|---|
| `cargo build` gagal: linker `link.exe` not found | Install VS 2022 Build Tools + "Desktop development with C++". |
| Build CUDA gagal: `libclang` not found | Install LLVM, pastikan `LIBCLANG_PATH` benar di `build_cuda.bat`. |
| Build CUDA gagal: `nvcc`/CUDA | Pastikan `CUDA_PATH` cocok dengan versi CUDA terinstall (script default v13.2). |
| Transkripsi kosong / error | Jalur Lite: cek `THOTH_GROQ_API_KEY`. Jalur Full: pastikan `models/ggml-*.bin` ada & cocok `model_size`. |
| Cover dilewati / hook title `(ASS)` | `python -m pip install Pillow rembg onnxruntime`; pastikan `python` di PATH (atau set `THOTH_PYTHON`). |
| Cover background gagal | Cek `THOTH_NOVITA_API_KEY` (dipakai FLUX + vision + meme). Best-effort → fallback otomatis. |
| Narasi diam-diam jatuh ke clip-mode | Jangan pakai `--provider groq` (rate limit). Pakai `novita` (default). |
| Video lambat / GPU tak terpakai | `[ffmpeg] nvenc = true` (butuh NVIDIA); jalur Full untuk Whisper GPU. |

Lihat juga: `README.md` (fitur + config detail), `CHANGELOG.md` (riwayat), `openclaw/README.md` (sourcing).
