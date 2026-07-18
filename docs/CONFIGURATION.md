# Configuration

Thoth is configured by two files in the repo root:

- **`config.toml`** — all behavior/tuning (no secrets). Copy from `config.toml.example`.
- **`.env`** — API keys & secrets, loaded at startup via `dotenvy`. Copy from `.env.example`.

Both are git-ignored — never commit them. This page documents the main sections; the
authoritative, fully-commented reference is **`config.toml.example`** itself.

> New fields use `#[serde(default)]`, so partial config files are fine — anything you
> omit takes its default.

---

## `config.toml`

### `[llm]` — LLM provider

```toml
[llm]
default_provider   = "novita"   # groq | openai | claude | gemini | novita | vllm | ollama | together | fireworks
max_clips          = 3
max_retries        = 2
min_clip_start_sec = 0          # 0 = auto-detect intro end
max_clip_end_sec   = 0          # 0 = auto-detect outro start
```

### `[ffmpeg]` — Video encoding

```toml
[ffmpeg]
ffmpeg_path   = ""       # empty = auto-download via ffmpeg-sidecar (or set an absolute path)
nvenc         = true     # NVIDIA NVENC GPU encoding (set false to use libx264 on CPU)
cq_value      = 23       # 0-51, lower = better quality
preset        = "p4"     # NVENC: p1 (fast) .. p7 (slow) | libx264: ultrafast..veryslow
audio_bitrate = "192k"
```

### `[gpu]` — GPU acceleration

```toml
[gpu]
enabled            = false        # enable the GPU pipeline
color_grading      = true         # apply color grading per clip
gpu_transitions    = false        # GPU-native transitions (vs FFmpeg xfade)
concat_output      = false        # concat all clips into one final video
default_color_mood = "cinematic"  # default mood if the LLM doesn't set one
```

### `[vision]` — Visual frame analysis

```toml
[vision]
enabled           = true
provider          = "novita"
frames_per_moment = 3
frame_width       = 384
score_weight      = 0.35      # 0 = text-only, 1 = vision-only
describe_video    = true      # full-video frame description
describe_interval = 15.0      # one frame per N seconds
scene_detection   = true
```

### `[styles.profiles.*]` — Style profiles

A named preset that overrides the LLM's per-clip style choices.

```toml
[styles.profiles.my_profile]
description    = "Profile description"
subtitle_style = "capcut_bold"    # karaoke | capcut_bold | word_pop | minimal_white
clip_style     = "flash"          # fade | flash | zoom | smooth | none
sfx_vibe       = "impact"         # impact | whoosh | ding | comedy | none
bgm_vibe       = "upbeat"         # lofi | upbeat | cinematic | inspirational | none
overlay_style  = "sticker"        # auto | sticker | pip | fullscreen
color_mood     = "vibrant"        # cinematic | warm | cool | vibrant | faded | night | bright | teal_orange
gpu_transition = "blink"          # blink | dissolve | fade | wipe_left | zoom_in | ...
```

Built-in profiles:

| Profile | For |
|---|---|
| `tiktok_id_2025` | TikTok Indonesia — energetic, flash, vibrant |
| `yt_edu` | YouTube Shorts educational — clean, minimal |
| `drama` | Controversy/drama — cinematic grade, wipe |
| `inspirational` | Inspirational content — warm, smooth |
| `cinematic_film` | Film look — teal-orange, wipe |
| `night_drama` | Night/dark content — dark grade, circle |

Apply one with `--style-profile <name>`, or generate a new one with `thoth trend-analyze`.

### `[assets]` — SFX, BGM & reaction memes

```toml
[assets]
sfx_dir             = "assets/sfx"
bgm_dir             = "assets/bgm"
catalog_path        = "assets/asset_catalog.json"
memes_in_narration  = true   # let the LLM place reaction memes on matching narration beats
narration_max_memes = 3      # max memes per narrated video
meme_fullscreen     = true   # full-screen meme cutaway below the subtitles (not a PiP corner)
beat_sync           = true   # snap SFX to the downbeat + duck BGM during speech

[assets.sfx]
impact = "impact-hit.mp3"
whoosh = "whoosh-swipe.mp3"
ding   = "notification.mp3"
comedy = "vine-boom.mp3"

[assets.bgm]
lofi          = "lofi-chill.mp3"
upbeat        = "upbeat-pop.mp3"
cinematic     = "epic-cinematic.mp3"
inspirational = "inspiring-piano.mp3"
```

### `[overlay]` — Meme / b-roll insert

```toml
[overlay]
enabled             = true
cache_dir           = "footage_cache"
max_duration        = 8.0
fallback_to_youtube = true
max_variants        = 3
scraper_enabled     = true   # stealth scraper + view-count ranking
```

### `[vector_db]` — RAG memory

```toml
[vector_db]
enabled              = true
retrieval_count      = 3
similarity_threshold = 0.65
embed_provider       = "novita"
embed_model          = "qwen/qwen3-embedding-8b"
```

### `[narration]` — Narrator-driven spine

```toml
[narration]
enabled        = true
model          = "deepseek/deepseek-v3.1"  # narration script model (non-reasoning chat → reliable JSON; avoid *-flash). Provider from --provider
target_secs    = 45        # target narration length (~3 words/sec)
language       = "id"
duck_event_vol = 0.12      # background-audio volume while the narrator speaks
leak_event_vol = 0.45      # volume while the narrator pauses
lead_in_secs   = 1.6       # background audio plays loud briefly before the narrator starts
structure_rag  = true      # narration-structure RAG (Supabase narration_structures)
```

### `[content_search]` — Multi-platform sourcing

```toml
[content_search]
enabled          = true
script           = "scripts/news/social_search.py"
platforms        = "youtube,instagram,twitter,news"   # tiktok needs a residential proxy
engine           = "auto"            # auto | playwright | scrapling
max_per_platform = 6
expand_keywords  = true              # LLM expands the query into multiple keywords
```

### `[cover]` / `[hook_title]` — AI cover & hook title

```toml
[cover]
enabled          = true
duration_sec     = 3.0
subject_mode     = "auto"          # auto | ai | cutout
prompt_translate = true            # translate the (localized) headline → English scene prompt (LLM)
subject_scale    = 1.02            # (cutout mode) subject height = fraction of the canvas
darken           = 0.32            # dark gradient for text contrast
steps            = 4               # FLUX schnell steps
prompt_suffix    = "empty scene with no people, dramatic cinematic ..."

[hook_title]
enabled      = true
engine       = "python"           # python (Pillow PNG, best) | ass (libass)
palette      = ["#FFFFFF", "#FFE100", "#FFFFFF", "#3FC1FF", "#FFFFFF"]  # cycles per line
color_mode   = "per_line"
font_file    = "assets/fonts/Montserrat-ExtraBold.ttf"
text_align   = "left"             # left (template style) | center
margin_l     = 56                 # left margin (px)
margin_v     = 380                # distance from the bottom
line_spacing = 1.0                # ×font size (≈1.0 = tight)
stroke_width = 13                 # stroke thickness (python engine)
shadow_dy    = 12
shadow_blur  = 10.0
shadow_alpha = 170

[profile_card]
enabled         = true
position        = "lower"            # center | upper | lower
name_above_head = false              # giant name banner (default OFF — distracting)
# The real cropped profile card is used when the content-set provides profile.image_path

[callout]
enabled      = true                  # key figure + pointer arrow
max_per_clip = 3
```

### `[montage]` — Montage composite

> The old `[animelorian]` section name is still accepted as a backward-compatible alias,
> as are the old field names (`montage`, `montage_segment_secs`, `montage_max_cuts`).

```toml
[montage]
enabled               = true
paper_bg              = "assets/ui/Paper-Grid-Background.mp4"
footage_scale_pct     = 88            # footage card width
hook_fullscreen       = true          # keep the hook (clip 0) full-frame
intercut              = true          # intercut footage as cards (montage on/off)
intercut_segment_secs = 4.0           # footage-swap cadence (seconds)
placement_variation   = true          # slight per-beat position/scale/tilt variation
intercut_max_cuts     = 2             # distinct footage clips per clip (montage density)
```

### `[news]` / `[reaction]` — Enrichment (opt-in)

```toml
[news]
enabled   = false                    # keyword → news search (Playwright) → screenshot cards
provider  = "playwright"
conda_env = "thoth-news"             # create with: conda env create -f environment.yml

[reaction]
enabled  = false                     # reaction script + TTS + avatar
position = "post_roll"               # post_roll | pre_roll | pip_corner
[reaction.tts]
provider = "elevenlabs"              # edge | minimax | fish_audio | openai | elevenlabs | none
[reaction.avatar]
mode = "none"                        # none | static_image | sad_talker | did | heygen
```

> For every option (with comments), see **`config.toml.example`**.

---

## Environment variables (`.env`)

Thoth loads `.env` from the repo root at startup. Full template: **`.env.example`**.

```env
# ── LLM providers (fill in only the ones you use) ──
THOTH_NOVITA_API_KEY=...           # default; analyze/narration/vision/embedding/cover-FLUX/scout
THOTH_GROQ_API_KEY=gsk_...         # alt provider + Whisper API (transcription)
THOTH_OPENAI_API_KEY=sk-...
THOTH_CLAUDE_API_KEY=sk-ant-...
THOTH_GEMINI_API_KEY=AIza...
THOTH_OPENROUTER_API_KEY=...       # [cover] image_engine="openrouter"
THOTH_TOGETHER_API_KEY=  /  THOTH_FIREWORKS_API_KEY=  /  THOTH_VLLM_API_KEY=

# ── RAG + Cultural Knowledge Base (Supabase Postgres) ──
THOTH_SUPABASE_URL=postgresql://user:pass@host:5432/db   # vector_db RAG + CKB (enrich/pulse)
THOTH_EMBED_API_KEY=               # empty = use the novita key

# ── TTS (narrator/reaction voices) ──
THOTH_ELEVENLABS_API_KEY=          # default TTS (eleven_multilingual_v2)
THOTH_MINIMAX_API_KEY=  /  THOTH_MINIMAX_GROUP_ID=  /  THOTH_FISH_AUDIO_API_KEY=

# ── News + avatar (optional) ──
THOTH_SERPER_API_KEY=              # news search (when provider = serper)
THOTH_DID_API_KEY=  /  THOTH_HEYGEN_API_KEY=

# ── Tooling / overrides ──
FFMPEG_PATH=                       # optional absolute path (default: auto-download / local ffmpeg)
THOTH_PYTHON=python                # interpreter for the Pillow/cover renderer
THOTH_WHISPER_LANGUAGE=id          # force the transcription language (optional)
```

### Server + worker variables

Only used by the two-process deployment (see **[RUNNING.md](RUNNING.md)**):

| Variable | Process | Default | Purpose |
|---|---|---|---|
| `THOTH_DB` | server + worker | `thoth.db` | Shared SQLite/WAL job database. Must match on both. |
| `THOTH_API_KEY` | server | `dev-key` | Bearer token clients/SPA must send. |
| `THOTH_OUTPUT_ROOT` | server | `output` | Root served by `/api/artifacts/<job_id>/*`. |
| `THOTH_ADDR` | server | `127.0.0.1:8787` | Server bind address. |

### Trusted local/LAN server boundary

The server + worker deployment is for a trusted local machine or LAN, not an
Internet-facing multi-user service. `THOTH_ADDR` defaults to loopback; if you choose a
LAN bind address, set a non-default `THOTH_API_KEY` and restrict access at the network
boundary. The current API key protects server routes, while fuller bind policy, token
handling, and local/LAN hardening are deliberately deferred to the next hardening
subproject.

For the runtime contract, the server validates `POST /api/jobs` before enqueueing and
returns structured `422` errors for invalid input. `params.extra_args` is only for the
trusted operator: it must be non-empty option strings and cannot provide positional
source input or override `-o`, `--output-dir`, `--job-id`, or `--content` (including
`--flag=value` forms). Artifact responses under `THOTH_OUTPUT_ROOT` support streamed
`GET`/`HEAD` and one byte range; malformed, unsatisfiable, and multi-range requests
return `416`. See **[RUNNING.md](RUNNING.md)** for the lifecycle and response details.

### scout model knobs (optional)

Defaults are good — see **[MODELS.md](MODELS.md)**. Overrides: `THOTH_LLM_MODEL`,
`THOTH_CONTEXT_MODEL`, `THOTH_VISION_MODEL`, `THOTH_EMBED_MODEL`, `THOTH_GROUND=0`
(disable web-grounding), `THOTH_CKB_*` (cache TTL).

> scout uses the **same root `.env`** as Thoth (via `scout/lib/env.ts`). It requires
> `THOTH_NOVITA_API_KEY`; `THOTH_GROQ_API_KEY` is an optional discovery fallback, and
> the CKB needs `THOTH_SUPABASE_URL` + `npm install pg`. See
> **[scout/README.md](../scout/README.md)**.

> **Never commit** `.env`, `config.toml`, or cookies — all are in `.gitignore`.
