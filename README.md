<p align="center">
  <img src="assets/logo/thoth-logo.svg" alt="Thoth — AI short-form video strategist" width="520">
</p>

<p align="center">
  <a href="https://github.com/muhfalihr/Thoth/releases"><img src="https://img.shields.io/badge/version-0.1.0-f97316?style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Proprietary-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/rust-1.85+-orange?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/node-24+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/CUDA-NVENC%20%2F%20Whisper-76B900?style=flat-square&logo=nvidia&logoColor=white" alt="CUDA">
</p>

<p align="center">
  🚧 <strong>Work in progress</strong> — under active development; APIs, config, and behavior may change.
</p>

---

> *Named after **Thoth**, the ibis-headed Egyptian god — keeper of writing and wisdom, and the scribe of the gods. A tool that **writes, narrates, and spreads** stories.*

**Thoth** is a Rust CLI that automates short-form video creation (TikTok, Reels, Shorts)
from long-form content **or** from a multi-platform content-set (the `scout/` layer). The
end-to-end pipeline: **download → transcribe → AI analysis → enrichment (narrator/news) →
GPU-accelerated video edit**. It supports two modes — **clip-mode** (cut viral moments from
one video) and **narrator-driven** (one commentary script becomes the spine, with b-roll
and reaction/news cards assembled around it).

## Highlights

- 🎬 **End-to-end pipeline** — one command turns a URL into finished vertical clips.
- 🧠 **Multi-provider AI** — Claude, GPT-4o, Gemini, Groq, Novita, vLLM, Ollama; vision scoring + RAG memory.
- 🗣️ **Narrator-driven mode** — an LLM script + TTS voiceover becomes the audio spine, grounded in the source and its comments.
- 🖼️ **AI cover, hook titles & reaction/news overlays** — viral-thumbnail intros, bold hook titles, real profile/comment cards.
- 🎨 **GPU color grading & transitions** — CapCut-style shaders (wgpu) + NVENC encoding.
- 🔎 **Content sourcing** — the `scout/` layer assembles content-sets from multiple platforms.
- 🌐 **CLI or server + worker** — run one-off from the terminal, or as a warm two-process deployment with a dashboard.

## Quick start

```bash
# 1. Configure
cp config.toml.example config.toml     # Windows: Copy-Item config.toml.example config.toml
cp .env.example .env                    # then add at least THOTH_NOVITA_API_KEY

# 2. Build (Lite path — no GPU needed)
cargo build --release

# 3. Run
./target/release/thoth run "https://youtu.be/xxxx" --provider novita
#   Windows: .\target\release\thoth.exe run "https://youtu.be/xxxx" --provider novita
```

Clips land in `output/.thoth/<job-id>/clips/`. Full setup (including the GPU path and
per-OS instructions) is in **[docs/INSTALL.md](docs/INSTALL.md)**.

## Server-mode runtime contract

In the server + worker deployment, cancellation is a distinct terminal outcome, not a
failed job. A queued job becomes `cancelled` immediately; for a running job the worker
observes the shared SQLite cancellation flag, shuts down its active work and child
processes, then records `cancelled`. While SQLite remains readable, that shutdown begins
within two seconds. Job artifacts support streamed `GET`/`HEAD` responses and one HTTP
byte range; invalid run requests are rejected before they enter the queue. The complete
operator and API contract is in **[docs/RUNNING.md](docs/RUNNING.md)**.

The server is designed for a trusted local machine or LAN. Internet-facing bind, token,
and path-hardening policy is intentionally deferred to the next Local/LAN Security
subproject.

## Documentation

| Document | What's in it |
|---|---|
| **[docs/INSTALL.md](docs/INSTALL.md)** | Install & build — prerequisites, toolchain, Lite vs Full/GPU, per OS (Windows/Linux/macOS) |
| **[docs/RUNNING.md](docs/RUNNING.md)** | How to run — the single-command CLI and the server + worker deployment, per OS |
| **[docs/CLI.md](docs/CLI.md)** | Full CLI reference — every command, flag, and provider |
| **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** | `config.toml` + `.env` reference — every section explained |
| **[docs/FEATURES.md](docs/FEATURES.md)** | Feature catalog — narration, cover, overlays, color grading, transitions, audio |
| **[docs/PIPELINE.md](docs/PIPELINE.md)** | Architecture — the five stages, output layout, and the `ViralMoment` schema |
| **[docs/MODELS.md](docs/MODELS.md)** | Every AI model used, where it's configured, and how to swap it |
| **[scout/README.md](scout/README.md)** | Content sourcing — discovery, content-sets, cultural enrichment |
| **[CHANGELOG.md](CHANGELOG.md)** · **[BLUEPRINT.md](BLUEPRINT.md)** | Change history · architecture blueprint & feature status |

## Stack

Rust 2024 (Tokio async) · wgpu (WGSL shaders) · FFmpeg/NVENC · Whisper (CUDA/API) ·
SQLite (job queue) · Supabase/pgvector (RAG) · Node ≥ 24 (`scout/`) · Python 3.10+ (cover/hook renderer).

## License

Copyright (c) 2026 Thoth. **All Rights Reserved.**
Proprietary software. Unauthorized use is strictly prohibited.
