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
- 🔎 **Content sourcing** — the `scout/` layer assembles content-sets from multiple platforms, all acquisition routed through one enforced kernel (`scout/acquisition/`) with cache/TTL, circuit breaking, and sensitive-data rules.
- 🌐 **CLI or server + worker** — run one-off from the terminal, or as a warm two-process deployment with a dashboard.
- 🧭 **Durable workflow control plane** — an additive Python `/api/v1` (FastAPI + Temporal) that runs one source-investigation workflow with approvals, ordered SSE events, cancellation, and authorized artifacts.

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

## Running the dashboard

Two processes, both started from the repo root (they share `thoth.db`):

```
cargo run -p thoth-server                       # API + dashboard on :8787
./target/release/thoth.exe worker --db thoth.db # executes queued jobs
```

Then open **http://127.0.0.1:8787**. Without the worker, jobs stay `queued`.

**The server serves the prebuilt SPA from `dashboard/dist`** (a gitignored build
artifact — it is NOT updated by `git pull`/merge). After any dashboard change, or the
first time you check out a branch whose UI differs, **rebuild it** or the server keeps
serving a stale UI:

```
bun --cwd dashboard install    # first run, or when dashboard deps change
bun --cwd dashboard run build  # regenerates dashboard/dist
```

For UI hot-reload during development, run the Vite dev server instead and open its URL
(default http://localhost:5173):

```
bun --cwd dashboard run dev
```

Vite proxies `/api` to `127.0.0.1:8787`, so in dev mode the server must be on the default
port `8787` (or edit the proxy target in `dashboard/vite.config.ts`).

## Python workflow control plane (v1, additive)

Next to the Rust server + worker there is an **additive** control plane in
**[`python/`](python/README.md)** — a FastAPI `/api/v1` boundary plus a Temporal worker that owns
one durable **source-investigation** workflow: submit → ordered events → approval → authorized
artifact. It does not replace the Rust media engine or the legacy Scout console, and its HTTP
handlers never build or parse a `thoth`/`scout` CLI command.

Four local processes, each in its own terminal:

```bash
temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-port 8233   # anywhere
cd python  && uv run uvicorn thoth_control_plane.api:create_app --factory --port 8000
cd python  && uv run python -m thoth_control_plane.worker
bun --cwd dashboard run dev          # Workflows tab; needs VITE_CONTROL_PLANE_URL
```

The typed operator client is `uv run thoth-control workflow start|watch|approve|cancel|retry`
(see **[docs/CLI.md](docs/CLI.md)**). Every response carries `X-Thoth-Contract-Version: 1`, and
workflow creation requires an `Idempotency-Key`. Ports, environment variables, event/reconnect
semantics, redaction policy, and the retirement gate for the temporary legacy-Scout activity are in
**[docs/python-control-plane.md](docs/python-control-plane.md)**.

> Migration status: `POST /api/v1/workflows/{id}/retry` deliberately answers `503` until a durable
> checkpoint policy exists, so a retry can never duplicate a side effect. The React dashboard stays
> the only end-user UI; the Rust `/api/scout/*` screens continue as an explicit **Legacy console**
> tab.

## Project profiles

Editing style is configured with **typed, project-scoped profiles** instead of raw
`config.toml`. A profile holds narration, visual-edit, analysis, ingest-source, and
output settings; credentials are referenced by **name** only (an env-var the server
resolves) — no secret value is ever stored in a profile, a job snapshot, an API
response, or a log.

- **Dashboard:** the **Profiles** tab edits profiles; **Runs** picks a profile, shows
  its effective settings, and starts a job. Per-run tweaks live in an overrides drawer
  and never mutate the profile.
- **CLI:**
  ```
  thoth project create Demo
  thoth project use Demo
  thoth profile create Vertical --description "ID vertical"
  thoth profile set Vertical --provider novita --layout vertical --max-clips 3
  thoth configure               # interactive wizard
  thoth configure --import      # one-way migration of an existing config.toml
  ```
  Every field is an explicit flag — no raw TOML and no generic `--set key=value`.

Manual acceptance checklist: **[docs/superpowers/plans/2026-07-18-project-profile-manual-test.md](docs/superpowers/plans/2026-07-18-project-profile-manual-test.md)**.

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
| **[docs/python-control-plane.md](docs/python-control-plane.md)** | Python v1 control plane — local topology, env vars, HTTP contract, events/reconnect, approvals, redaction, legacy-adapter retirement gate |
| **[python/README.md](python/README.md)** · **[docs/decisions/](docs/decisions/)** | Control-plane package layout & checks · accepted architecture decisions |
| **[scout/README.md](scout/README.md)** | Content sourcing — discovery, content-sets, cultural enrichment, acquisition kernel (env vars, cache, safety rules) |
| **[CHANGELOG.md](CHANGELOG.md)** · **[BLUEPRINT.md](BLUEPRINT.md)** | Change history · architecture blueprint & feature status |

## Stack

Rust 2024 (Tokio async) · wgpu (WGSL shaders) · FFmpeg/NVENC · Whisper (CUDA/API) ·
SQLite (job queue) · Supabase/pgvector (RAG) · Node ≥ 24 (`scout/`) · Python 3.10+ (cover/hook renderer) ·
Python 3.11–3.13 + uv/FastAPI/Temporal/Ruff (`python/` control plane) · React 19 + TypeScript + Bun (`dashboard/`).

## License

Copyright (c) 2026 Thoth. **All Rights Reserved.**
Proprietary software. Unauthorized use is strictly prohibited.
