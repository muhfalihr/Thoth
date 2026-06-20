# Changelog — 🪶 Thoth (formerly CLIPPER)

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-06-20

### Added
- **Per-platform profile-card crop** (`openclaw/profile_crop.js`): the real platform profile (avatar + name + @handle + stats + bio) is screenshotted and pasted as the on-screen card instead of a synthetic one. **Instagram** done (handle via `profile.handle` or yt-dlp `%(channel)s` for bare reel URLs); X/Twitter layout works but its avatar is gated off (`THOTH_PROFILE_X=1`) pending an occluded-tab rendering fix; TikTok keeps its existing dedicated cropper.
- **Cover face-swap for subject likeness** (`[cover] face_swap`): in AI mode the real subject's face is swapped onto the AI subject via Novita `merge-face`, using an **internet reference photo** (Wikipedia portrait by `character_name`, else the video frame) so the cover resembles the actual person.
- **OpenRouter cover backend** (`[cover] image_engine = "openrouter"`, `image_model`): generate the cover with an image-output model that natively preserves the subject's identity from reference photos (default `google/gemini-2.5-flash-image`; alternatives `openai/gpt-5-image`, `openai/gpt-5-image-mini`, `google/gemini-3-pro-image`). Needs `THOTH_OPENROUTER_API_KEY`; falls back to FLUX + face-swap if unavailable.
- **Cover topic grounding + medium-shot framing**: the FLUX/scene prompt now uses a detailed topic description (moment title + reason) — not just the headline — and frames people/objects as a medium shot, subject in the upper two-thirds with the lower third kept clear for the headline.
- **Recency-decay topic ranking** (opt-in, env `THOTH_REEL_HALFLIFE_H`) in `discover_reels`: score `views × 0.5^(age/half-life)` so fast-rising reels outrank older high-view ones.
- **Optional yt-dlp cookies for IG audio** (env `THOTH_YTDLP_COOKIES`) so the voiceover topic fallback can fetch login-walled reels.
- **OpenClaw RUNBOOK + one-shot runner**: `openclaw/RUNBOOK.md` (manual flow) and `run_full.ps1` (discover → pipeline → validate → render, with build_footage-empty fallback).

### Changed
- **Narration default model → `deepseek/deepseek-v3.1`** (chat, non-reasoning) for reliable JSON; reasoning models (deepseek-v4-flash/pro, *-thinking, *-r1) truncate JSON.
- **On-screen text has NO punctuation** (hook title **and** burned subtitles) while the spoken narration keeps its punctuation — `strip_punctuation()` applied to displayed text only.
- TikTok source-video ranking now uses the on-screen **vision headline + scene** (the activity), candidate **cover+caption** combined, a wider candidate pool, and a stronger overlay-text vision read — so it picks the right activity, not just the right subject/place.
- TikTok profile read waits up to ~45 s (was 16 s) with progressive-scroll retries (slow tab).

### Fixed
- **`scrape_comments.js` overwrote the content-set** (lost description + footage) when the main URL was a resolved TikTok CDN URL — now merges by page-url / source_url / video-id.
- **`discover_reels` cross-account bleed** (other accounts' reels under the requested handle) + garbage topics (watermark/empty) + silent views=0; added owner-handle filter, `cleanTopic()`, and warnings.
- **Long scripts losing all output on SIGKILL** — `discover_reels` now checkpoints incrementally.
- **`crop_post.js` (X) "rect post tak valid"** — retry the rect read and re-tag after SPA re-render.
- **Narrator clip far shorter than the narration** — video length now equals the narration (B-roll looped via `-stream_loop` instead of truncating the voiceover).
- **`normalizeLikes` misparsed thousands** (`3.261` → 3) — fixed thousands-vs-decimal handling, correcting view/like ranking.
- **`trace_source` curated-aggregator replacement** built its query from the caption only — now composes it from caption + vision (headline/scene) via the LLM; IG covers can now read the on-screen headline (vision).
- **Narration failed on truncated JSON** (reasoning model) — the reply is now salvaged (hook + narration extracted from raw text) instead of falling back to clip-mode.
- Cover subject was a blurry low-res cutout covered by text — low-res cutouts now route to an AI HD recreation that includes the subject, framed clear of the headline.
- Meme cue log said `(top_right)` even when full-screen — now logs `(full-screen)`.

## [0.4.0] - 2026-06-16

### Added
- **AI Cover / Thumbnail intro** (`[cover]`): a full-screen cover is shown for the hook window, then dissolves (Ken-Burns + fade) into the footage. It composites an **AI background** (Novita FLUX.1 schnell, themed to the topic) + a **subject cutout** (rembg) + the **headline text**.
  - `subject_mode = "auto" | "ai" | "cutout"`: **auto** uses the real cut-out subject when the source frame reads clearly (brightness/sharpness/coverage gate) and otherwise generates an AI subject; **ai** always lets FLUX generate a dominant full-screen subject; **cutout** always cuts the real person from a video frame.
  - **Vision-grounded recreation**: the configured vision model (`qwen3-vl`) describes the *actual* frame in detail, and FLUX recreates that real event as an HD illustration (instead of guessing from the headline).
  - **English prompt translation**: the (Indonesian) headline is converted by the LLM into a vivid English scene prompt for stronger, on-topic backgrounds.
- **Pillow hook-title renderer** (`scripts/render_headline.py`, `[hook_title] engine = "python"`): high-fidelity PNG headline — thick uniform stroke, drop shadow, supersampled AA — replacing libass. **Left-aligned, tight line spacing, per-line colour cycling, lower-middle placement** (Montserrat ExtraBold), matching the viral-cover template. Auto-falls back to the ASS renderer when Python/Pillow is unavailable.
- **LLM-matched reaction memes in narrator mode** (`[assets] memes_in_narration`): the LLM places catalog memes at the narration beats whose spoken emotion matches each meme (shock / facepalm / sad / confused / applause …), spread out with a minimum gap. Shown **full-screen** cutaway (`[assets] meme_fullscreen`, whole meme over a blurred fill) **under** the subtitle, with the meme's own audio ducking the narration.
- New Python scripts `scripts/render_cover.py`, `scripts/render_headline.py`; new Rust modules `src/edit/cover.rs`, `src/edit/headline_png.rs`.
- New runtime deps for the cover cutout: **Pillow + rembg + onnxruntime** (reuses the existing `THOTH_NOVITA_API_KEY`).
- New config: `[cover]` (whole section), `[hook_title]` (`engine`, `palette`, `color_mode`, `align`, `text_align`, `margin_l`, `margin_v`, `line_spacing`, `stroke_width`, `font_file`, `shadow_*`), `[assets]` (`memes_in_narration`, `narration_max_memes`, `meme_fullscreen`).

### Changed
- **Subtitles are now the absolute topmost layer** — burned *after* every footage / image / meme / crop overlay, so captions can never be covered by a cutaway.
- **Hook title** default look reworked to the viral-cover template: lower-middle block, per-line white/gold(+accent), thick black stroke + drop shadow, left-aligned and tightly stacked.
- **Reaction memes** now default to a **full-screen cutaway** (was a small corner PiP).

### Fixed
- Subtitle was being covered by footage/cards at some timestamps (now always on top).
- Meme / asset-video cues never appeared in narrator-driven mode — the cue wiring lived only in the legacy per-clip path; the narration path now selects and places them too.
- Windows `[Errno 22]` MAX_PATH overflow on long CDN `.mp4` URLs (yt-dlp output template bounded to `%(id).64s`).

## [0.3.0] - 2026-06-15

### Added
- **GPU pipeline (wgpu)**: CapCut-ported color-grading shaders (HSL per-channel, log color wheels, curves, 3D LUT, sharpen, vignette) + 21 GPU-native transitions + optional GPU concat.
- **Narrator-driven spine** (`[narration]`): one LLM commentary script → TTS voiceover (ElevenLabs / MiniMax / Fish Audio / Edge) becomes the audio backbone; b-roll and cards are built around it, event audio is ducked, and subtitles are generated from the narration.
- **Narration Structure RAG**: narration grounded to a corpus of proven beat-arc structures (Supabase `narration_structures`, built by `scripts/analyze_narration_structure.py`).
- **News enrichment** (Stage 4, `[news]`): keyword extraction from the spoken transcript → Playwright Google News search → screenshot cards (no paid API key).
- **Reaction module** (`[reaction]`): reaction script + TTS + optional talking avatar (static image / SadTalker / D-ID / HeyGen).
- **Multi-platform content search** (`[content_search]`): pick a MAIN video + enrichment pool across YouTube / Instagram / Twitter / News (Playwright / Scrapling).
- **OpenClaw content-set integration** (`thoth run --content set.json`): externally-sourced `{main, footage, comments, figures, profile}`; real cropped screenshots drive the comment cards and profile card.
- **Reaction-news beat overlays**: hook title (giant multi-colour, `[hook_title]`), profile card (real cropped social header, `[profile_card]`), comment cards (real crops), callout (number + arrow, `[callout]`).
- **Animelorian montage style** (`[animelorian]`): paper-grid canvas with footage cards intercut between beats.
- **Asset catalog + beat-sync** SFX/meme cues (`scripts/annotate_assets.py` → `assets/asset_catalog.json`).
- **Vision `describe_video`**: per-frame audio-visual descriptions injected into the transcript before analysis, plus scene-boundary frame sampling.
- Expanded style profiles (`cinematic_film`, `night_drama`) with `color_mood` + `gpu_transition` fields.
- Tracked the OpenClaw Node module (`openclaw/`) and Python helper scripts (`scripts/`).

### Fixed
- **Source tracing** (OpenClaw): keyword-driven search query (previously the title's first stop-word), a non-aggregator-tiered fallback, and TikTok **creator-profile-direct + vision-cover** selection; curated accounts in `ig_accounts.json` are hard-excluded from main/footage.
- **Ingest MAX_PATH**: bound the yt-dlp output template to `%(id).64s` — fixes Windows `[Errno 22]` on direct CDN `.mp4` URLs whose `%(id)s` is a long query string.
- **Narration parse**: key-agnostic JSON parsing (picks the longest string field) — ends the silent clip-mode fallback when the model varies the narration key (`naration` / `narrating` / …).
- **Profile card** now pastes the real OpenClaw profile crop instead of a synthetic badge; the giant name banner is disabled by default.
- **Comment cards**: recycle guard — skip a crop when the tagged DOM node no longer matches the comment text (prevents pasting the post caption on virtualised IG/X lists).

### Changed
- Pipeline is now **5 stages**: Ingest → Transcribe → Analyze → Enrich → Edit.
- `config.toml.example` re-synced with the full config schema; `config.toml` untracked (local testing config with machine-specific paths).
- `fonts/` and `sfx/` moved under `assets/`.

## [0.2.0] - 2026-05-23

### Added
- **Thumbnail Generation**: Added automatic thumbnail generation using FFmpeg. Thumbnails are captured at the most crucial moments (typically when an overlay appears).
- **Vocab Cache System**: Implemented a database-backed vocabulary cache system using Supabase to improve AI analysis accuracy.
- **YouTube Transcript Support**: The application can now detect and use native YouTube transcripts (JSON3/VTT), significantly reducing Groq/Whisper API costs.
- **Multi-Provider LLM Support**: Integration with Anthropic Claude and Google Gemini APIs.
- **Database Schema Migration**: Added support for the `headline` column and full production metadata in the `viral_moments` (Supabase) table.

### Fixed
- **Overlay Download Reliability**: Fixed a bug where overlay downloads often failed because the duration of the first search result was too long. The logic now explores up to 10 search results.
- **RAG Insert Failure**: Fixed RAG storage failures by aligning the `INSERT` query with the latest database schema.
- **BPE Tokenization Fix**: Fixed merging of sub-word tokens produced by Groq/Whisper.

### Changed
- **Subtitle Styling**: Changed the `CapcutBold` style stroke color from Yellow to **Orange** to improve contrast and readability for white text.
- **yt-dlp Orchestration**: Removed the `--no-playlist` flag in overlay searches to allow downloading videos from search result lists.

## [0.1.0] - 2026-03-15
### Added
- Initial project release of CLIPPER.
- Basic FFmpeg integration for editing.
- Analysis pipeline using Groq (Llama 3).
- Local caching system for video and audio files.
