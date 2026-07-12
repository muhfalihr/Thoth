# Changelog — 🪶 Thoth (formerly CLIPPER)

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-12

First tagged release. It consolidates the **entire** development history into a single
version to match the unified workspace version — from the original CLIPPER prototype
(2026-03-15: basic FFmpeg editing, a Groq/Llama-3 analysis pipeline, a local media cache)
through the May–July 2026 build-out. Earlier in-development version headers (0.2.0–0.5.0),
the `[Unreleased]` section, and the raw engineering dev-journal (previously migrated out of
`BLUEPRINT.md`) were all reformatted and folded in here. For granular, commit-level detail
see the git history.

### Added

**Pipeline & core**
- 5-stage pipeline: **Ingest → Transcribe → Analyze → Enrich → Edit**.
- **GPU pipeline (wgpu)**: CapCut-ported color-grading shaders (HSL per-channel, log color wheels, curves, 3D LUT, sharpen, vignette) + 21 GPU-native transitions + optional GPU concat.
- **`thoth run` with optional URL**: `--query` searches YouTube via yt-dlp; with neither URL nor query it falls back to X/Twitter trending → YouTube search. Query keyword expansion (`src/ingest/query_expand.rs`) broadens the multi-platform search before sourcing.
- **Vision `describe_video`**: per-frame audio-visual descriptions injected into the transcript before analysis, plus scene-boundary frame sampling. Long-video temporal coverage via 2-phase time-bucket selection + adaptive chunking.
- **Style profiles** (`cinematic_film`, `night_drama`, …) with `color_mood` + `gpu_transition`; `thoth trend-analyze` builds `[styles.profiles.<name>]` from reference videos.
- **Asset catalog + beat-sync** SFX/meme cues (`scripts/annotate_assets.py` → `assets/asset_catalog.json`); catalog injected into the analyze prompt, timestamped `asset_cues[]` rendered as audio and meme-PiP overlays, beat-snapped when beat-sync is on.

**Narrator-driven mode**
- **Narrator-driven spine** (`[narration]`): one LLM commentary script → TTS voiceover (ElevenLabs / MiniMax / Fish Audio / Edge) becomes the audio backbone; b-roll and cards are built around it, event audio is ducked, and subtitles are generated from the narration. Dynamic ducking via lead-in windows.
- **Narration Structure RAG**: narration grounded to a corpus of proven beat-arc structures (Supabase `narration_structures`, built by `scripts/analyze_narration_structure.py`).
- **FLSR narration prompt** (`src/narration/mod.rs`): tension-opener, 3-tier body, dual-mode close (sharp debate question *or* specific value-close); reference structures are inspiration-only and the mandatory structure wins on conflict.
- **Cultural-context enrichment for narration**: `scout/enrich_context.js` decodes comment subtext into `references[]` (entities/memes/slang/events), per-comment `context`, and `discourse{}` → grounding blocks `[Konteks Budaya]` / `[Maksud Komentar]`, so the model reads sarcasm as sarcasm and never blames commenters. `web_grounding.js` refreshes entity/event status to its current real state via Google News (beyond the model cutoff, with `as_of_date`/`source_url`). Cultural Knowledge Base on Supabase (`scout/ckb.js`, `pg`+SSL) caches resolved references cross-run and cross-machine, with a local-JSON fallback. `pulse_harvest.js` distills live discourse trends + a register snapshot into `[Tren Diskursus]`.
- **LLM-placed reaction memes & SFX in narrator mode** (`[assets] memes_in_narration`, `sfx_in_narration`): catalog memes/SFX are placed on the beats whose spoken emotion (or transition) matches, spread out with a minimum gap, ducking the narration.

**Content sourcing (scout)**
- **scout content-set integration** (`thoth run --content set.json`): externally-sourced `{main, footage, comments, figures, profile}`; real cropped screenshots drive the comment cards and profile card. `main.description` + top comments + figures ground the narration when the audio transcript is empty.
- **Multi-platform content search** (`[content_search]`): pick a MAIN video + enrichment pool across YouTube / Instagram / Twitter / News (Playwright / Scrapling), with per-result relevance auditing (`match` / `unverified`). TikTok web search proved signature-gated (hard-blocked) → hidden from defaults, kept only for yt-dlp download of specific videos.
- **Shape-aware, multi-platform discovery**: `postShape` (one platform-agnostic yt-dlp `-J` → video/photo/carousel); per-shape topic ladder; multi-platform curators (`curator_accounts.json`: IG/TikTok/X); feed posts scanned alongside reels; TikTok Studio trending topics (region-filtered).
- **Standalone browser CDP** (`scout/lib/browser.js`): launches Brave/Chrome/Edge with a dedicated remote-debugging profile — persistent TikTok/IG/X logins, no extension or third-party relay.
- **Subject/object-aware footage search** (`footage_objects.js` + `build_footage.js`): compound object+subject queries mined from caption/description/top-comments, with brand expansion; non-video posts are cropped to clean card images (`image_path`).
- **Source tracing**: keyword-driven search query, a non-aggregator-tiered fallback, and TikTok creator-profile-direct + vision-cover selection; curated accounts in `ig_accounts.json` are hard-excluded from main/footage (incl. cross-posts).

**Reaction-news beat overlays**
- **Hook title** (giant multi-colour per-word, `[hook_title]`) with a high-fidelity **Pillow PNG renderer** (thick uniform stroke, drop shadow, supersampled AA), falling back to libass when Python/Pillow is unavailable.
- **Profile card** (`[profile_card]`): pastes the real per-platform cropped social header (avatar + name + @handle + stats); identity is creator-only.
- **Comment cards**: real cropped screenshots + notification SFX.
- **Callout** (`[callout]`): number in an accent box + directional arrow, driven by an LLM schema.
- **AI Cover / Thumbnail intro** (`[cover]`): a full-screen cover for the hook window that dissolves (Ken-Burns + fade) into the footage — AI background (Novita FLUX.1 schnell) + subject cutout (rembg) + headline; **vision-grounded recreation** of the real frame; `subject_mode = auto | ai | cutout`.
- **Montage style** (`[montage]`): paper-grid canvas with footage cards intercut between beats; hook stays full-frame, per-beat text layers don't stack, consistent card placement.
- **News enrichment** (Stage 4, `[news]`): transcript keyword extraction → Playwright Google News search → screenshot cards (no paid API key).
- **Reaction module** (`[reaction]`): reaction script + TTS + optional talking avatar (static image / SadTalker / D-ID / HeyGen).

**Dashboard, server & worker**
- **Cargo workspace split**: `crates/thoth-types` (leaf wire types, pure serde), `crates/thoth-core` (lib: all types + orchestration + `run_once`), `crates/thoth` (thin CLI/worker bin, `--features cuda`), `crates/thoth-server` (axum REST/SSE bin), `crates/thoth-jobs` (SQLite job queue). `thoth-server` links **zero** heavy deps (no ffmpeg/wgpu/CUDA/Whisper).
- **SQLite job-queue** (`thoth-jobs`, WAL): two independent peer processes — `thoth-server` (REST/SSE) and `thoth worker` (warm engine, no per-job CUDA/Whisper cold-start) sharing only one SQLite file. Atomic `claim_next` (`UPDATE … RETURNING`), heartbeat, a reaper that fails stale jobs, and SSE that tails `job_events` by `seq` with `Last-Event-ID`/`?after=` resume (no parent/child, no supervisor).
- **Worker channel `--progress-json`**: global flag; `ProgressEvent{stage,pct,message,ts}` NDJSON on stdout, human logs on stderr; the worker installs a DB progress sink, the CLI keeps stdout NDJSON.
- **Dashboard SPA** (`dashboard/`): Vite + React + TS + shadcn + Tailwind (Bun) cockpit in the "Ink & Gold" theme — RunForm / JobList / JobMonitor / LogPane; typed `api.ts` client kept byte-aligned with the Rust wire types, SSE via `EventSource ?token=`.

**Tooling & identity**
- **Terminal identity** "Feather Spine" + "Ink & Gold" palette (`src/brand.rs`) — single source for colors/glyphs, TTY-gated so no ANSI leaks when piped; mirrored in scout's `lib/ui.ts`.
- **scout rewritten fully in TypeScript** (native, no build step) and the runtime migrated **Node ≥24 → Bun ≥1.2**; credentials centralized in the root `.env`, single `cli.ts` entrypoint, modular `lib/ / scrapers/ / pipeline/ / enrich/` layout.

### Changed
- **Internal codename `[animelorian]` → `[montage]`** (`MontageConfig`; `intercut` / `intercut_segment_secs` / `intercut_max_cuts`). Backward-compatible via `#[serde(alias = …)]` — old section/field names still parse.
- **Workspace versions unified to `0.1.0`**: single source of truth in the root `[workspace.package] version`; every crate inherits via `version.workspace = true`; `dashboard/package.json` synced.
- **Docs restructured under `docs/`** (English, cross-platform): README slimmed to overview + quick-start + doc map; detail moved into `docs/{INSTALL,RUNNING,CONFIGURATION,FEATURES,PIPELINE,CLI,MODELS}.md` with per-OS (Windows/Linux/macOS) build + CLI + server/worker instructions; `SETUP.md` folded into `docs/INSTALL.md`. The engineering dev-journal moved out of `BLUEPRINT.md` into this changelog (`BLUEPRINT.md` now tracks architecture + status only).
- **Analyze → `deepseek/deepseek-v3.1` + strict JSON mode** (`LlmProvider::chat_completion_json` sending `response_format:{"type":"json_object"}` on the JSON-object callers; `news/keyword` stays on plain mode since it returns a top-level array). Model audit: vision frame-description `qwen3-vl-8b` → `qwen2.5-vl-72b` → `qwen3-vl-235b-a22b-instruct` (after Novita deprecated the earlier vision models); scout text-reasoning tasks → `deepseek/deepseek-v3.1`; cover default → `google/gemini-2.5-flash-image`.
- **Subtitles are the absolute topmost layer** — burned after every footage/image/meme/crop overlay, so captions can never be covered.
- **`build_footage.js` fills its quota from all valid candidates** (iterate videos/posts applying gates + cross-fill) instead of giving up when a few top picks fail the relevance/dedup gate; the fragile oEmbed re-gate was removed (videos trust the search + story gate).
- **Removed THOTH's own footage auto-search** — footage now comes only from scout; `fetch_overlay_clip` and the `src/scraper/` module were deleted (news keeps its own scraper).
- **Clippy standard aligned to the official docs** (`.clippy.toml` + `[lints.clippy]`): high-volume style-only lints (`cast_lossless`, `map_unwrap_or`) allowed with rationale; domain-relevant lints (`float_cmp`, `unused_async`, …) deliberately kept as warn ("zero **critical** warnings", not zero-all).
- **Async performance** (PERF_PLAN D & E): blocking ffmpeg calls wrapped in `tokio::task::spawn_blocking`; enrichment subtitle fetches and Groq transcription chunks run bounded-concurrent (`buffer_unordered`).
- Recency-decay reel ranking (opt-in) and per-platform profile-card crops.
- `config.toml.example` re-synced with the full schema (`config.toml` untracked); `fonts/` and `sfx/` moved under `assets/`.

### Fixed
- **Decorated render hung 15–25 min** — an undecodable `-loop 1` avatar PNG (a garbage download, e.g. 13 KB of ASCII spaces → "Invalid PNG signature") never emits a frame, so the `overlay` filter blocked forever, independent of thread count (disproving the earlier multithread-deadlock and framerate theories). `download_image_to` now validates image magic bytes and rejects non-images; the obsolete avatar download was removed; the filtergraph runs multithreaded again at native source framerate, with the `run_ffmpeg` watchdog (300 s) as backstop.
- **All scout crops broke at `devicePixelRatio ≠ 1`** — `captureClip` double-applied dpr (clip is in CSS pixels), and the TikTok croppers returned black outside the viewport. Fixed to an unscaled CSS-pixel clip (`scale:1`) + page coords + `captureBeyondViewport`.
- **Profile card at t≈5s showed the story subject instead of the video's creator** — the card identity is now creator-only (real scout crop → uploader → skip).
- **AI cover showed a doubled/mirrored subject** on kaleidoscope transition frames — a ±1.5 s window is sampled and the least-symmetric (most natural) frame chosen.
- **Narration silent-failure variants** — truncated/empty JSON and a varying narration key (`naration`/`narrating`/…) previously fell back to off-topic clip-mode; now key-agnostic parsing + salvage recover the hook + narration.
- **Windows `[Errno 22]` MAX_PATH overflow** on long CDN `.mp4` URLs — yt-dlp output template bounded to `%(id).64s`.
- **IG yt-dlp "empty media response"** — the cookie file needs the HttpOnly `sessionid`; `cookie_file` takes priority over `cookie_browser`.
- **FFmpeg drawtext dropped headline lines containing `%`** (e.g. "90% KASUS") — added `:expansion=none` so `%` is always literal, removing version-dependent silent skips.
- **Headline truncation/wrapping** (`max_chars` 22 → 24, 44-char sanitize) and **long-video coverage** (overlap-ratio dedup, filler/ceremony filtering, `snap_start_past_fillers`).
- **Comment-card recycle guard** — skip a crop when the tagged DOM node no longer matches the comment text (prevents pasting the post caption on virtualised IG/X lists); **black-crop density guard** rejects solid-black cards by bytes-per-pixel.
