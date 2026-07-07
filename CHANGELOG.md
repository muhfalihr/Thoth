# Changelog — 🪶 Thoth (formerly CLIPPER)

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Current-register voice flavor (Phase 4).** `pulse_harvest.js` distillation also returns a `register` snapshot (5–8 casual phrasings/interjections currently prevalent in the harvested comments — tone, not topic), stored via `ckb.setRegister` (one row in `ckb_memes`, "latest known", profanity-filtered). `enrich_context.js` injects it as an **optional** flavor into `discourse.narration_guidance` ("pakai bila pas, JANGAN dipaksakan") — no Rust change (reuses the existing field). Deliberately conservative: the narrator's core voice still comes from its SYSTEM prompt; register only refreshes diction. (Style-Profiles tie-in deferred — that BLUEPRINT feature isn't built yet.)
- **Cultural Pulse Harvester (Phase 3).** `scout/pulse_harvest.js` — distills "what's trending in the *discourse*" from the tool's OWN discovery feed (not an external view-index): scans `reel_topics.json` reels, scrapes a budget of their comments (`--max`/`--per-video`), runs one LLM distillation, keeps terms that RECUR across ≥`--min-freq` videos, and writes them to `ckb.pulse` with recency decay (`exp(-age/τ)`) + TTL prune. `ckb.js` gains `bumpPulse/prunePulse/topPulse`. Surfacing (3b): `enrich_context` writes the top live terms to `discourse.trends`; Rust `Discourse.trends` renders a "Tren diskursus (gaya/jargon — JANGAN paksakan topik)" line in `[Maksud Komentar]` as a STYLE reference. Run daily after `discover_reels`. Verified end-to-end on a 3-video feed (correctly kept 0 — unrelated videos shouldn't promote one-off terms).
- **Cultural Knowledge Base on Supabase (Phase 2b).** `scout/ckb.js` — a CKB backed by **Supabase Postgres** (`pg` client + SSL; tables `ckb_entities`/`ckb_memes`/`ckb_pulse` auto-created) that caches resolved references across runs AND machines (cache-first): an entity/meme resolved once is reused later without re-hitting web/LLM (TTL: entities 14d so status stays current, memes 120d). `enrich_context.js` checks the CKB before grounding (cache-hit ⇒ skip) and writes results back; async `load()/save()` (flushes only dirty rows). Connection via `THOTH_SUPABASE_URL`/`THOTH_SUPABASE_URL` env, a `.supabase_url` file, or a nearby `.env`; **degrades to a local JSON cache** if the DB/`pg`/URL is unavailable so the tool never breaks. Workspace setup: `npm install pg`. Verified live: cold run wrote to Supabase (`backend: supabase`, Nadiem grounded), warm run "CKB hit: 3 term, skip grounding" read from the DB. (`kamus-alay` slang lexicon deferred — the model decodes slang well already.)
- **Narration context web-grounding (Phase 2a).** `enrich_context.js` now refreshes entity/event reference summaries to their CURRENT real status (beyond the model's training cutoff) via Google News over CDP — new `scout/web_grounding.js` (`groundTerms`, text-only headlines, reusing the search_news Google-News technique). A second LLM pass rewrites each person/org/event/place summary from the latest headlines + adds `as_of_date`/`source_url`. Verified: "Nadiem Makarim" went from stale "Mendikbud, simbol harapan" → "terdakwa kasus korupsi Chromebook menunggu vonis" (sourced). Memes/slang are not grounded (no time-sensitive status). Best-effort + `THOTH_GROUND=0` to disable; Rust `Reference` gained `as_of_date`/`source_url` and the `[Konteks Budaya]` block shows "(per <date>)".
- **Cultural-context enrichment for narration (Phase 1).** Narration previously got comments RAW, so the LLM misread coded sarcasm as literal complaints (e.g. narrating that "blamed the netizens"). New `scout/enrich_context.js` (run in `run_pipeline` after figures) makes one LLM pass that decodes the content-set: `references[]` (entities/memes/slang/events — e.g. "konoha" = satirical name for Indonesia), per-comment `context` (subtext + tone), and `discourse{}` (collective `audience_stance` + `themes` + `narration_guidance`). Thoth `generate_narration` emits two new grounding blocks — `[Konteks Budaya]` and `[Maksud Komentar]` (+ `[maksud: …]` appended per comment) — and the narration prompt now instructs the model to read sarcasm as sarcasm, align with the audience stance, and NOT blame commenters. Content-set fields `references`/`discourse`/`comments[].context` are additive `#[serde(default)]` (forward-compat). Validated on the failing clip: discourse correctly read "bangga tapi pesimis… JANGAN menyalahkan netizen". (Phase 2 — web-grounding of current-event status — is documented in `RESEARCH_context_enrichment_narration.md`.)
- **LLM-placed reaction SFX in narrator mode** (`[assets] sfx_in_narration`, `narration_max_sfx`): the SFX analogue of `memes_in_narration`. `select_narration_sfx()` feeds the narration (with `[t=..s]` timestamps) + the SFX catalog (category/energy/triggers) to the LLM, which drops impact/whoosh/riser/notification hits on the matching emotional & transition beats. Cues clamp to the file's own length (0.3–3.0 s), keep ≥3 s apart, avoid stacking on a meme, and append to (not replace) the static comment-card notification SFX. Best-effort → silent no-op on any failure.
- **`discover_reels.js` scans feed posts too** (`--include reels,posts`, default both): besides reels (`/reel/`) it now reads feed posts (`/p/` — photos/carousels/video posts) from the main grid, widening the topic net. Image posts read the headline from the cover image (vision); audio fallback runs for video items only. Each entry gets a `kind` field; `--max-per` applies per type.
- **TikTok Studio trending topics** (`scout/discover_tiktok_trending.js`; `discover_reels --tiktok`): scrapes TikTok's official viral-topic ranking (`Inspiration → Trending` — topic phrase + total views) as an extra seed pool, **filtered to a region (default Indonesia)** by driving the region dropdown (`--region`; `all` = unfiltered). Class-agnostic scrapers (row matched by shape `<rank><title>` + view-count cell; region trigger/option matched by shape, not class) survive TikTok's class-hash churn; view counts parse K/M/B. Written to `output/tiktok_trending.json` (standalone) or a `tiktok_trending` section in `reel_topics.json` (kept out of the IG views ranking so 200M-view topics don't bury reels). Needs a logged-in tiktok.com tab; best-effort → empty on failure.

### Changed
- **Analyze → `deepseek/deepseek-v3.1` + strict JSON mode.** Analyze (viral-moment extraction) now defaults to DeepSeek V3.1 (chat, non-reasoning) instead of `qwen-2.5-72b` — stronger reasoning + reliable JSON, and the same model already trusted for narration. To harden structured output, added an opt-in `LlmProvider::chat_completion_json` (default delegates to plain `chat_completion`; OpenAI-compatible/Novita provider sends `response_format:{"type":"json_object"}`). Wired the JSON-OBJECT callers (analyze, trending, narration, reaction script, meme/SFX selection) to it; left `news/keyword` on plain mode (it returns a top-level JSON **array**, which `json_object` forbids). Reasoning/`*-flash` models remain discouraged for analyze (they truncate JSON).
- **Model audit cleanup (better quality per task).** Vision frame-description bumped from `qwen3-vl-8b` → `qwen2.5-vl-72b-instruct` (`[vision]` config + Rust default) — the 8B was the weak link in visual grounding that feeds narration. scout TEXT-reasoning tasks moved off the vision model onto a text reasoner: `footage_objects.js`, `extract_figures.js`, `enrich_context.js` now default to `deepseek/deepseek-v3.1` (was `qwen3-vl-235b`). `comments.js` vision model is now env-overridable (`THOTH_VISION_MODEL`) like the other croppers. Stale hardcoded cover default `openai/gpt-5-image` → `google/gemini-2.5-flash-image` (matches active config).
- **`build_footage.js` subject/object-aware footage search.** `footage_objects.js` now returns `{subjects, objects, people}` (was a flat object list) and also mines the post's **top comments** for context (names/brands often surface there) — so the comment scrape was moved **before** build_footage in `run_pipeline.js`. Each footage search query is now **compound** — object + primary subject (`"chip ai"` + `"nvidia"` → `"chip ai nvidia"`), plus one **person-enriched** query for the primary object when a related figure is known (`"chip ai nvidia jensen huang"`). build_footage also **never re-uses the main content** (dedupes by url, platform video-id, and near-identical caption, catching reposts under a different URL) and **drops reaction/repost footage** (face-cam over a clip ≠ b-roll; conservative marker match, not bare "nonton").
- **`scripts/annotate_assets.py` reworked** for reliability + quality: per-type batched LLM calls (audio/font text batches, video memes in vision batches of 3) instead of one giant call that truncated; measured ffprobe/PCM features are now authoritative (the LLM can't clobber duration / has_audio / dimensions); all LLM enum fields are validated in-vocab; 3 frames @512px; optional OpenRouter backend (`--backend`).

### Fixed
- **AI cover showed a doubled/mirrored subject** when the single cover-subject frame (`subject_at_sec`) happened to land on a mirror/kaleidoscope TRANSITION in the source video. `pick_cover_frame_time` (`src/edit/ffmpeg.rs`) now samples a small ±1.5 s window around the chosen moment, scores each frame's left↔right symmetry (a tiny 64×64 grayscale mirror-SAD, no new deps), and picks the LEAST-symmetric (most natural) frame — dodging the doubled-subject frame. Validated on the failing clip: mirror frame ≈32.5 vs normal ≈40 asymmetry, so the natural frame wins.
- **`build_footage.js` returned 0 footage even when many valid candidates existed.** The per-object picker sliced only the top `nVid`/`nPost` candidates (with `--per 2`, just 1 video + 1 post), processed those, and if they failed the relevance/main-dedup gate it gave up — never trying the remaining valid candidates. Confirmed live: `• "chip ai nvidia" … +0v/0p (2 drop tak-relevan)` while 3 videos + 9 posts had passed the earlier aggregator/dedup gates. Now build_footage **consumes candidates until the quota is filled** (iterate all videos/posts applying gates, then cross-fill any shortfall from the other type), so a few unlucky top picks no longer zero out the footage. (`addVideo`/`addPost` helpers + Pass 1/Pass 2.) Also **removed the fragile per-video `relevant()` re-gate**: TikTok/YT candidates are already keyword-gated at search time and the cosine story-gate trims off-topic at the end, but the re-gate depended on the oEmbed caption — under rate-limit/flaky oEmbed it dropped perfectly valid videos (the real cause of `+0v/0p` despite good candidates). Videos now trust the search gate + story-gate; posts still require their cropped text to match (they are not search-gated).
- **Profile card at t≈5s showed the story SUBJECT instead of the main video's creator.** The Beat-2 profile card seeded its identity from the LLM `character_*` fields (the person the video is *about*, e.g. "Moka"), only overridden when scout supplied a real profile. When `main.profile` was empty the card mislabeled the creator. Now the card identity is **creator-only**: (1) real scout profile crop/handle → (2) the main video's uploader (`source_channel` from info.json, e.g. `theresalearns`) → (3) none → **skip the card**. The story `character_*` is never used as the card identity. (`src/edit/service.rs` both render paths; `render_narration_video` now receives `source_channel`.) scout side: `trace_source.js` now **always** records `main.profile.name/handle` from the URL handle even when the profile crop fails (previously handle was set only inside the `if (cropped)` branch, so a failed crop left the profile empty).
- **All scout crops broke at `devicePixelRatio ≠ 1` (HiDPI / browser zoom).** Two distinct causes, both in the shared `client.captureClip` path (`cdp.js`):
  1. **dpr double-applied.** `Page.captureScreenshot`'s `clip` is in **CSS pixels** (Chrome renders the output at the page dpr automatically with `scale:1`), but `captureClip` multiplied x/y/width/height by `dpr`. At dpr=2 the clip came out 2× → the crop shifted right (avatar + left text chopped) and ballooned with a black empty right half; at dpr=0.9 it was ~10% off but looked OK (which is why the earlier "coords ×dpr" change seemed correct). Fix: pass the CSS rect unscaled, `scale:1`. Verified at dpr 0.9 **and** 2 (profile crop now exact: full avatar + name + handle + stats, no chop, no black).
  2. **black crops** from the two TikTok croppers (`scrape_comments.js`, `tiktok_profile.js`) which used viewport coords without `captureBeyondViewport` — `fromSurface` returns black for anything outside the composited viewport (worse at dpr>1 / small windows). Fixed to PAGE coords (`+scrollX/Y`) + `{beyondViewport:true}`, like the other croppers. Also dropped `user-bio` from the TikTok profile bbox (its full-width text was widening the card into mostly-empty space).

## [0.5.0] - 2026-06-20

### Added
- **Per-platform profile-card crop** (`scout/profile_crop.js`): the real platform profile (avatar + name + @handle + stats + bio) is screenshotted and pasted as the on-screen card instead of a synthetic one. **Instagram** done (handle via `profile.handle` or yt-dlp `%(channel)s` for bare reel URLs); X/Twitter layout works but its avatar is gated off (`THOTH_PROFILE_X=1`) pending an occluded-tab rendering fix; TikTok keeps its existing dedicated cropper.
- **Cover face-swap for subject likeness** (`[cover] face_swap`): in AI mode the real subject's face is swapped onto the AI subject via Novita `merge-face`, using an **internet reference photo** (Wikipedia portrait by `character_name`, else the video frame) so the cover resembles the actual person.
- **OpenRouter cover backend** (`[cover] image_engine = "openrouter"`, `image_model`): generate the cover with an image-output model that natively preserves the subject's identity from reference photos (default `google/gemini-2.5-flash-image`; alternatives `openai/gpt-5-image`, `openai/gpt-5-image-mini`, `google/gemini-3-pro-image`). Needs `THOTH_OPENROUTER_API_KEY`; falls back to FLUX + face-swap if unavailable.
- **Cover topic grounding + medium-shot framing**: the FLUX/scene prompt now uses a detailed topic description (moment title + reason) — not just the headline — and frames people/objects as a medium shot, subject in the upper two-thirds with the lower third kept clear for the headline.
- **Recency-decay topic ranking** (opt-in, env `THOTH_REEL_HALFLIFE_H`) in `discover_reels`: score `views × 0.5^(age/half-life)` so fast-rising reels outrank older high-view ones.
- **Optional yt-dlp cookies for IG audio** (env `THOTH_YTDLP_COOKIES`) so the voiceover topic fallback can fetch login-walled reels.
- **scout RUNBOOK + one-shot runner**: `scout/RUNBOOK.md` (manual flow) and `run_full.ps1` (discover → pipeline → validate → render, with build_footage-empty fallback).

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
- **scout content-set integration** (`thoth run --content set.json`): externally-sourced `{main, footage, comments, figures, profile}`; real cropped screenshots drive the comment cards and profile card.
- **Reaction-news beat overlays**: hook title (giant multi-colour, `[hook_title]`), profile card (real cropped social header, `[profile_card]`), comment cards (real crops), callout (number + arrow, `[callout]`).
- **Animelorian montage style** (`[animelorian]`): paper-grid canvas with footage cards intercut between beats.
- **Asset catalog + beat-sync** SFX/meme cues (`scripts/annotate_assets.py` → `assets/asset_catalog.json`).
- **Vision `describe_video`**: per-frame audio-visual descriptions injected into the transcript before analysis, plus scene-boundary frame sampling.
- Expanded style profiles (`cinematic_film`, `night_drama`) with `color_mood` + `gpu_transition` fields.
- Tracked the scout Node module (`scout/`) and Python helper scripts (`scripts/`).

### Fixed
- **Source tracing** (scout): keyword-driven search query (previously the title's first stop-word), a non-aggregator-tiered fallback, and TikTok **creator-profile-direct + vision-cover** selection; curated accounts in `ig_accounts.json` are hard-excluded from main/footage.
- **Ingest MAX_PATH**: bound the yt-dlp output template to `%(id).64s` — fixes Windows `[Errno 22]` on direct CDN `.mp4` URLs whose `%(id)s` is a long query string.
- **Narration parse**: key-agnostic JSON parsing (picks the longest string field) — ends the silent clip-mode fallback when the model varies the narration key (`naration` / `narrating` / …).
- **Profile card** now pastes the real scout profile crop instead of a synthetic badge; the giant name banner is disabled by default.
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
