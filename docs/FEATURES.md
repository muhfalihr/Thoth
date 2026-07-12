# Features

Every feature below is configured in `config.toml` (see **[CONFIGURATION.md](CONFIGURATION.md)**
for the exact keys) and degrades gracefully when disabled or unavailable.

---

## AI analysis

- **Multi-provider LLM** — Claude, GPT-4o, Gemini, Groq, Novita, vLLM, Ollama, Together, Fireworks.
- **Vision scoring** — visual analysis of candidate frames (humor, visual impact, novelty, engagement).
- **RAG memory** — Supabase pgvector; learns from previous viral moments.
- **Beat detection** — extracts BPM from the BGM and snaps transitions to the downbeat.
- **Trend awareness** — trend/keyword scoring feeds moment selection.

---

## Narrator-driven spine (`[narration]`)

One LLM-written narration script becomes the **TTS voiceover** (ElevenLabs / MiniMax /
Fish Audio / Edge) that serves as the main audio. The video is built around it: footage
is placed by embedding-similarity to each narration window, background audio events are
ducked, and subtitles are derived from the narration. The script is **grounded** in
`main.title`/`description` + top comments + visual description, and in a corpus of proven
narration structures (Narration Structure RAG). Falls back to clip-mode if narration is
unavailable.

---

## AI cover / thumbnail intro (`[cover]`)

During the opening hook window, a **full-screen cover** is shown before cutting to the
footage — viral-thumbnail style:

- **AI background** — a text-to-image model (FLUX.1 schnell) generates a dramatic
  backdrop matching the topic.
- **Subject** — `subject_mode`:
  - `auto` (default) — cut out the real person (rembg) when the frame is clearly
    readable (brightness/sharpness/coverage gate); if dark/blurry, generate an AI subject.
  - `ai` — always generate a dominant AI subject filling the frame.
  - `cutout` — always cut the real person out of the video frame.
- **Vision-grounded** — a vision model describes the real frame in detail, so the image
  model **recreates the real event** as an HD illustration (not a guess from the headline).
- **English prompt** — the (localized) headline is translated by the LLM into an English
  scene prompt for a more relevant background.
- Then it **dissolves** (Ken Burns + fade) into the footage. Requires `python` + `Pillow`
  + `rembg`; on failure it falls back to the plain hook title.

---

## Hook-title renderer (`[hook_title]`)

A giant scroll-stopping title, with two engines:

- **`engine = "python"`** (default) — renders a PNG via Pillow: **thick black stroke +
  drop-shadow + smooth AA**, left-aligned, tight line spacing, **per-line colors**
  (white/yellow/cyan), Montserrat ExtraBold, positioned in the lower-center. Mimics viral
  cover templates.
- **`engine = "ass"`** — libass fallback (legacy) when Python is unavailable.
- Knobs: `palette`, `color_mode`, `text_align`, `margin_l`, `margin_v`, `line_spacing`,
  `stroke_width`, `font_file`, `shadow_*`.

---

## Reaction-news overlays

Reaction/news-commentary style, assembled from factual data (scout):

- **Profile card** (`[profile_card]`) — a profile card cropped from the **real** social
  source (not synthetic).
- **Comment cards** — screenshots of **real viral comments** (author/text/likes) placed
  on a reaction beat.
- **Callout** (`[callout]`) — a key figure + a pointer arrow.
- **Subtitles always frontmost** — burned in after every overlay, so captions are never
  covered by a cutaway.

---

## Reaction memes (narrator mode, `[assets]`)

Reaction memes (`assets/meme/`) are inserted automatically in narrator mode:

- **LLM-matched** — the LLM picks a meme from the catalog and places it on a narration
  beat whose emotion fits (shock/facepalm/sad/confused/applause), spaced with a minimum gap.
- **Full-screen** (`meme_fullscreen`, default) — the meme fills the frame (a cutaway, the
  whole meme over a blurred fill) **below the subtitles**; the meme's audio ducks the narration.
- Knobs: `memes_in_narration`, `narration_max_memes`, `meme_fullscreen`.

---

## Content sourcing (scout + multi-platform)

- **`thoth run --content set.json`** — accepts an external content-set
  `{main, footage, comments, figures, profile}` produced by the `scout/` layer, including
  cropped comment screenshots and profile cards.
- **`[content_search]`** — searches for the MAIN video + an enrichment pool across
  YouTube/Instagram/Twitter/News (Playwright/Scrapling) when a `--query` is given or on
  auto-trending.

Details: **[scout/README.md](../scout/README.md)**. Model list: **[MODELS.md](MODELS.md)**.

---

## Cultural context enrichment (narrator mode)

So the narration understands the **subtext** of comments (sarcasm, memes, named figures)
and doesn't misread them:

- **`enrich_context` (scout)** — decodes comments into `references` (entities/memes/slang),
  per-comment `context` (intent + tone), and `discourse` (the audience's collective
  stance) → injected into the narration prompt.
- **Web-grounding** — updates an entity's status to the present via news search (works
  around the model's knowledge cutoff).
- **Cultural Knowledge Base** (Supabase) — caches resolutions across runs/machines (cache-first).
- **Cultural Pulse** (daily cron) — learns trends from the **comments** of trending
  videos (not the platform index) → discourse/style blocks (optional).

---

## News enrichment (`[news]`, opt-in)

Per-moment keywords from the transcript → news search (Playwright, no API key) →
screenshots of relevant news cards inserted into the clip.

---

## Reaction module (`[reaction]`, opt-in)

A reaction script + TTS + an optional avatar (static image / local GPU talking-head /
D-ID / HeyGen), attached post-roll / pre-roll / picture-in-picture.

---

## Montage composite (`[montage]`)

> Previously named `[animelorian]` internally — the old section name is still accepted as
> a backward-compatible alias.

A paper-grid canvas as the base; the footage (main + search results) is composited as a
**card in the center** and intercut between footage clips (a montage) — while the hook
stays full-frame.

---

## Subtitle styles (4 modes)

| Style | Description |
|---|---|
| `karaoke` | Yellow per-word highlight (default) |
| `capcut_bold` | Bold white text on a dark background — viral TikTok style |
| `word_pop` | Per-word pop animation |
| `minimal_white` | Clean white, no background |

---

## Transition styles (FFmpeg `xfade` — 40+ types)

Used when concatenating clips. CapCut name → FFmpeg mapping:

| Name | Description |
|---|---|
| `blink` | White flash (CapCut "Blink") |
| `dissolve` | Pixel dissolve |
| `fade` | Fade through black |
| `wipe_left/right/up/down` | Hard wipe |
| `slide_left/right` | Slide the clip |
| `smooth_left/right` | Smooth slide |
| `zoom_in` | Zoom into the next clip |
| `circle_open/close` | Iris wipe |
| `pixelize` | Mosaic / pixelate |
| `hblur` | Horizontal blur (glitch) |
| `radial` | Radial wipe |
| `fade_grays` | Desaturate → resaturate |
| `cover_left` | Clip B covers from the right |
| `reveal_left` | Clip A reveals from the left |
| `squeeze_h` | Horizontal squeeze |

---

## GPU color grading (CapCut shaders, wgpu pipeline)

A GPU pipeline ported directly from CapCut's shaders:

```
FFmpeg decode → raw RGBA frames
    → wgpu ColorPipeline (WGSL shader)
        1. Temperature / Tint
        2. Brightness / Contrast
        3. Saturation (global)
        4. Whites / Blacks
        5. HSL per-channel (8 colors: Red/Orange/Yellow/Green/Cyan/Blue/Purple/Magenta)
        6. Log color wheels (Shadow/Midtone/Highlight/Offset)
        7. 3D LUT (.cube file)
        8. Sharpen (Laplacian unsharp mask)
        9. Vignette
    → raw RGBA → FFmpeg encode
```

**Color moods** (ready-made presets):

| Mood | Description |
|---|---|
| `cinematic` | Desaturated, high contrast, vignette |
| `warm` | Temperature +35%, golden tones |
| `cool` | Temperature −30%, moody blue |
| `vibrant` | Saturation +30%, sharp, pop |
| `faded` | Desaturated, soft blacks — retro/vintage |
| `night` | Dark, high contrast, strong vignette |
| `bright` | Brightness up, airy/clean look |
| `teal_orange` | Shadows teal, highlights orange — blockbuster |

Full manual parameters (per clip via `ViralMoment.color_mood` or a style profile):

```toml
color_mood = "cinematic"   # preset

# or set manually via the ColorGrading struct in Rust:
brightness  = 0.0    # -1..1
contrast    = 0.15
saturation  = -0.1
temperature = -0.2   # cool
tint        = 0.0
highlights  = -0.15
shadows     = 0.05
whites      = 0.0
blacks      = 0.0
sharpen     = 0.0
vignette    = 0.45
hsl_blue        = [0.0, 20.0, -5.0]        # [hue_shift°, sat_delta, lum_delta]
wheel_shadow    = [-0.05, 0.05, 0.10, 0.0] # [R, G, B, sat]
wheel_highlight = [0.10, 0.05, -0.05, 0.0]
```

---

## GPU transitions (GPU-native, wgpu pipeline)

21 transitions implemented directly in WGSL shaders (not dependent on FFmpeg xfade):

```
Fade, Blink (white flash), Dissolve (hash dither),
WipeLeft/Right/Up/Down, SlideLeft/Right, ZoomIn,
CircleOpen/Close, Pixelize (mosaic), Radial,
HBlur (glitch), FadeGrays, DiagTL, CoverLeft,
RevealLeft, SqueezeH, SmoothLeft
```

---

## Overlay system

- **FullScreen** — full-frame cut-away b-roll.
- **Sticker** — chromakey greenscreen + corner position.
- **PiP** — picture-in-picture, no chromakey.
- Auto-detects greenscreen by sampling.

---

## Audio pipeline

- **SFX catalog** — pick SFX by vibe (impact / whoosh / ding / comedy).
- **BGM catalog** — pick BGM by vibe (lofi / upbeat / cinematic / inspirational).
- **Beat sync** — snap SFX + transitions to the BGM downbeat.
- **BGM ducking** — reduce BGM ~60% during speech.
- **Audio normalization** — 48 kHz stereo, resample all sources.

---

## Using the GPU pipeline from Rust

```rust
use thoth::gpu::{GpuProcessor, ClipJob, ColorParams};
use thoth::edit::{ColorGrading, Transition};

// Init the GPU (auto-selects the best NVIDIA/AMD adapter)
let gpu = GpuProcessor::new().await?;

// Color grade from a preset mood
let color = ColorGrading::from_mood("cinematic").to_gpu_params();
gpu.apply_color("input.mp4", "output.mp4", 0.0, 30.0, &color, true).await?;

// Manual color grade
let mut grading = ColorGrading::default();
grading.saturation  = 0.3;
grading.vignette    = 0.4;
grading.temperature = -0.2;
grading.hsl_blue    = [0.0, 20.0, -5.0];

// Concat clips with GPU transitions
let jobs = vec![
    ClipJob::new("clip1.mp4", 0.0, 15.0)
        .with_color(grading.to_gpu_params())
        .with_transition(Transition::Blink),
    ClipJob::new("clip2.mp4", 0.0, 12.0)
        .with_transition(Transition::WipeLeft),
    ClipJob::new("clip3.mp4", 5.0, 18.0)
        .with_transition(Transition::None),
];
gpu.concat_gpu(&jobs, "final.mp4", true).await?;
```
