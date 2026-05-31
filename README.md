# CLIPPER — AI-Powered Short-Form Video Strategist

CLIPPER adalah CLI tool berbasis Rust yang mengotomasi pembuatan video short-form (TikTok, Reels, Shorts) dari konten long-form. Pipeline end-to-end: download → transkripsi → analisis AI → edit video dengan GPU acceleration.

---

## Arsitektur Pipeline

```
URL / File
    │
    ▼ Stage 1: INGEST
    yt-dlp → video.mp4 + metadata
    │
    ▼ Stage 2: TRANSCRIBE
    Whisper (CUDA/CPU) → transcript.json (word-level timestamps)
    │
    ▼ Stage 3: ANALYZE
    LLM (multi-provider) → moments.json
    Vision LLM → visual scores per frame
    RAG/pgvector → inject past viral patterns
    │
    ▼ Stage 4: EDIT
    FFmpeg encode (subtitle + SFX + BGM + overlay)
    ├── GPU Color Grading (wgpu — CapCut shaders)
    └── GPU Transitions (wgpu — 21 efek)
```

---

## Fitur Utama

### AI Analysis
- **Multi-provider LLM**: Claude, GPT-4o, Gemini, Groq, Novita, vLLM, Ollama
- **Vision scoring**: Analisis frame visual (humor, visual_impact, novelty, engagement)
- **RAG memory**: Supabase pgvector — belajar dari viral moments sebelumnya
- **Beat detection**: BPM dari BGM → snap transisi ke downbeat
- **Trend awareness**: Google Trends + keyword scoring

### Subtitle Styles (4 mode)
| Style | Deskripsi |
|---|---|
| `karaoke` | Highlight kuning per kata (default) |
| `capcut_bold` | Bold putih, background gelap — viral TikTok style |
| `word_pop` | Animasi pop per kata |
| `minimal_white` | Putih bersih, tanpa background |

### Transition Styles (FFmpeg `xfade` — 40+ jenis)
Digunakan saat concat clips. Nama CapCut → FFmpeg:

| Nama | Deskripsi |
|---|---|
| `blink` | Flash putih (CapCut "Blink") |
| `dissolve` | Dissolve pixel |
| `fade` | Fade through black |
| `wipe_left/right/up/down` | Hard wipe |
| `slide_left/right` | Slide clip |
| `smooth_left/right` | Smooth slide |
| `zoom_in` | Zoom ke clip berikutnya |
| `circle_open/close` | Iris wipe |
| `pixelize` | Mosaic/pixelate |
| `hblur` | Horizontal blur (Glitch) |
| `radial` | Radial wipe |
| `fade_grays` | Desaturate → resaturate |
| `cover_left` | Clip B cover dari kanan |
| `reveal_left` | Clip A reveal dari kiri |
| `squeeze_h` | Squeeze horizontal |

### GPU Color Grading (CapCut shaders, wgpu pipeline)

Pipeline GPU yang diport langsung dari shader CapCut (reverse engineered):

```
FFmpeg decode → raw RGBA frames
    → wgpu ColorPipeline (WGSL shader)
        1. Temperature / Tint
        2. Brightness / Contrast
        3. Saturation (global)
        4. Whites / Blacks
        5. HSL per-channel (8 warna: Red/Orange/Yellow/Green/Cyan/Blue/Purple/Magenta)
        6. Log Color Wheels (Shadow/Midtone/Highlight/Offset)
        7. 3D LUT (.cube file)
        8. Sharpen (unsharp mask Laplacian)
        9. Vignette
    → raw RGBA → FFmpeg encode
```

**Color Moods** (preset siap pakai):

| Mood | Deskripsi |
|---|---|
| `cinematic` | Desaturated, high contrast, vignette |
| `warm` | Temperature +35%, golden tones |
| `cool` | Temperature -30%, moody blue |
| `vibrant` | Saturation +30%, sharp, pop |
| `faded` | Desaturated, soft blacks — retro/vintage |
| `night` | Dark, high contrast, vignette kuat |
| `bright` | Brightness +, airy/clean look |
| `teal_orange` | Shadow: teal, Highlight: orange — blockbuster |

**Parameter lengkap** (per clip via `ViralMoment.color_mood` atau config):
```toml
# Di style profile:
color_mood = "cinematic"  # preset

# Atau manual via ColorGrading struct di Rust:
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
hsl_blue    = [0.0, 20.0, -5.0]   # [hue_shift°, sat_delta, lum_delta]
wheel_shadow    = [-0.05, 0.05, 0.10, 0.0]  # [R, G, B, sat]
wheel_highlight = [0.10, 0.05, -0.05, 0.0]
```

### GPU Transitions (GPU-native, wgpu pipeline)

21 transisi diimplementasi langsung di WGSL shader (tidak bergantung FFmpeg xfade):

```
Fade, Blink (flash putih), Dissolve (hash dither),
WipeLeft/Right/Up/Down, SlideLeft/Right, ZoomIn,
CircleOpen/Close, Pixelize (mosaic), Radial,
HBlur (glitch), FadeGrays, DiagTL, CoverLeft,
RevealLeft, SqueezeH, SmoothLeft
```

### Overlay System
- **FullScreen**: Cut-away B-roll full frame
- **Sticker**: Chromakey greenscreen + corner position
- **PiP**: Picture-in-picture, no chromakey
- Auto-detect greenscreen via sampling

### Audio Pipeline
- **SFX catalog**: Pilih SFX by vibe (impact/whoosh/ding/comedy)
- **BGM catalog**: Pilih BGM by vibe (lofi/upbeat/cinematic/inspirational)
- **Beat sync**: Snap SFX + transitions ke downbeat BGM
- **BGM ducking**: Reduce BGM 60% saat speech
- **Audio normalization**: 48kHz stereo, resample semua sources

---

## CLI Commands

### `run` — Pipeline Utama
```bash
clipper run <URL_ATAU_PATH> [OPTIONS]

# Contoh
clipper run "https://youtu.be/xxxx"
clipper run ./video.mp4 --max-clips 5 --layout vertical
clipper run "https://youtu.be/xxxx" --style-profile tiktok_id_2025
clipper run "https://youtu.be/xxxx" --provider claude --layout square
```

**Options:**
| Flag | Default | Deskripsi |
|---|---|---|
| `--max-clips N` | 3 | Jumlah clip viral yang diekstrak |
| `--layout` | vertical | `vertical` \| `horizontal` \| `square` |
| `--provider` | config | `claude` \| `gemini` \| `openai` \| `groq` \| `novita` \| `vllm` \| `ollama` |
| `--style-profile` | auto | Nama profil dari `config.toml [styles.profiles]` |
| `--clip-style` | — | Override transition: `fade` \| `flash` \| `zoom` \| `smooth` \| `none` |
| `--sfx` | — | Override SFX file (path absolut) |
| `--bgm` | — | Override BGM file (path absolut) |
| `--focus` | — | Keyword prioritas, comma-separated |
| `--resume JOB_ID` | — | Lanjutkan job yang gagal |

### `trend-analyze` — Auto-generate Style Profile
```bash
# Analisis 10 video trending → generate style profile ke config.toml
clipper trend-analyze --count 10 --output tiktok_id_latest
```

### `vocab` — Knowledge Management
```bash
clipper vocab seed defaults          # isi DB dengan default viral keywords
clipper vocab list tone_funny        # list kata dalam kategori
clipper vocab add energy_high "hype" # tambah kata manual
clipper vocab review                 # review candidate words interaktif
clipper vocab stats                  # DB status + word counts
```

### `thumbnail` — Regenerate Thumbnails
```bash
clipper thumbnail --job-id <ID>
```

---

## Konfigurasi (`config.toml`)

### `[llm]` — LLM Provider
```toml
[llm]
default_provider = "novita"   # groq | openai | claude | gemini | novita | vllm | ollama
max_clips        = 3
max_retries      = 2
min_clip_start_sec = 0        # 0 = auto-detect intro end
max_clip_end_sec   = 0        # 0 = auto-detect outro start
```

### `[ffmpeg]` — Video Encoding
```toml
[ffmpeg]
ffmpeg_path   = ""       # kosong = auto-download via ffmpeg-sidecar
nvenc         = true     # GPU encoding NVIDIA NVENC
cq_value      = 23       # 0-51, kecil = kualitas lebih baik
preset        = "p4"     # NVENC: p1 (cepat) .. p7 (lambat) | libx264: ultrafast..veryslow
audio_bitrate = "192k"
```

### `[gpu]` — GPU Acceleration
```toml
[gpu]
enabled            = false        # aktifkan GPU pipeline
color_grading      = true         # apply color grading per clip
gpu_transitions    = false        # GPU-native transitions (vs FFmpeg xfade)
concat_output      = false        # concat semua clips menjadi 1 video final
default_color_mood = "cinematic"  # mood default jika LLM tidak set
```

### `[vision]` — Visual Frame Analysis
```toml
[vision]
enabled           = true
provider          = "novita"
frames_per_moment = 3
frame_width       = 384
score_weight      = 0.35      # 0=text-only, 1=vision-only
describe_video    = true      # full-video frame description
describe_interval = 15.0      # 1 frame per N detik
scene_detection   = true
```

### `[styles.profiles.*]` — Style Profiles
```toml
[styles.profiles.nama_profile]
description    = "Deskripsi profil"
subtitle_style = "capcut_bold"    # karaoke | capcut_bold | word_pop | minimal_white
clip_style     = "flash"          # fade | flash | zoom | smooth | none
sfx_vibe       = "impact"         # impact | whoosh | ding | comedy | none
bgm_vibe       = "upbeat"         # lofi | upbeat | cinematic | inspirational | none
overlay_style  = "sticker"        # auto | sticker | pip | fullscreen
color_mood     = "vibrant"        # cinematic | warm | cool | vibrant | faded | night | bright | teal_orange
gpu_transition = "blink"          # blink | dissolve | fade | wipe_left | zoom_in | ...
```

**Profile bawaan:**

| Profile | Untuk |
|---|---|
| `tiktok_id_2025` | TikTok Indonesia — energetic, flash, vibrant |
| `yt_edu` | YouTube Shorts educational — clean, minimal |
| `drama` | Kontroversi/drama — cinematic grade, wipe |
| `inspirational` | Konten inspirasi — warm, smooth |
| `cinematic_film` | Film look — teal-orange, wipe |
| `night_drama` | Konten malam/gelap — dark grade, circle |

### `[assets]` — SFX & BGM
```toml
[assets]
sfx_dir   = "sfx"
bgm_dir   = "bgm"
beat_sync = true   # snap SFX ke downbeat + duck BGM saat speech

[assets.sfx]
impact  = "impact-hit.mp3"
whoosh  = "whoosh-swipe.mp3"
ding    = "notification.mp3"
comedy  = "vine-boom.mp3"

[assets.bgm]
lofi          = "lofi-chill.mp3"
upbeat        = "upbeat-pop.mp3"
cinematic     = "epic-cinematic.mp3"
inspirational = "inspiring-piano.mp3"
```

### `[overlay]` — Meme/B-Roll Insert
```toml
[overlay]
enabled             = true
cache_dir           = "overlay_cache"
max_duration        = 8.0
fallback_to_youtube = true
max_variants        = 3
scraper_enabled     = true   # stealth scraper + view count ranking
```

### `[vector_db]` — RAG Memory
```toml
[vector_db]
enabled              = true
retrieval_count      = 3
similarity_threshold = 0.65
embed_provider       = "novita"
embed_model          = "qwen/qwen3-embedding-8b"
```

---

## Environment Variables (`.env`)

```env
# LLM
CLIPPER_CLAUDE_API_KEY=sk-ant-...
CLIPPER_GEMINI_API_KEY=AIza...
CLIPPER_OPENAI_API_KEY=sk-...
CLIPPER_GROQ_API_KEY=gsk_...
CLIPPER_NOVITA_API_KEY=...

# Database (RAG)
CLIPPER_SUPABASE_URL=postgresql://...

# Ingest
FFMPEG_PATH=C:/tools/ffmpeg.exe   # opsional, override auto-download
```

---

## Output Structure

```
output/
└── .clipper/<job_id>/
    ├── state.json              ← stage checkpoints (resume support)
    ├── source/
    │   └── video.mp4
    ├── transcribe/
    │   └── transcript.json     ← word-level timestamps
    ├── analyze/
    │   └── moments.json        ← ViralMoment[] dengan color_mood, gpu_transition
    └── clips/
        ├── clip_001_<slug>.mp4
        ├── clip_001_<slug>.jpg ← thumbnail
        └── final_concat.mp4   ← jika gpu.concat_output = true
```

---

## `ViralMoment` — LLM Output Schema

LLM menghasilkan field berikut per clip:

```json
{
  "title": "Hook untuk social media (≤60 chars)",
  "headline": "Lower-third overlay text (≤44 chars, ALL CAPS)",
  "start_sec": 45.2,
  "end_sec": 78.1,
  "hook": "3 kata pertama pembuka",
  "viral_type": "educational_shock | transformation | controversy | actionable | relatable | blueprint | inspiration | storytelling",
  "emotional_trigger": "curiosity | surprise | validation | inspiration | fear | humor | empathy | admiration",
  "energy": "high | medium | low",
  "subtitle_style": "capcut_bold",
  "clip_style": "flash",
  "sfx_vibe": "impact",
  "sfx_at_sec": 8.0,
  "bgm_vibe": "upbeat",
  "overlay_query": "shocked reaction face",
  "overlay_style": "sticker",
  "overlay_position": "bottom_right",
  "color_mood": "vibrant",
  "gpu_transition": "blink"
}
```

---

## Cara Pakai GPU Pipeline (Rust API)

```rust
use clipper::gpu::{GpuProcessor, ClipJob, ColorParams};
use clipper::edit::{ColorGrading, Transition};

// Init GPU (otomatis pilih NVIDIA/AMD terbaik)
let gpu = GpuProcessor::new().await?;

// Color grading dari preset mood
let color = ColorGrading::from_mood("cinematic").to_gpu_params();
gpu.apply_color("input.mp4", "output.mp4", 0.0, 30.0, &color, true).await?;

// Color grading manual
let mut grading = ColorGrading::default();
grading.saturation  = 0.3;
grading.vignette    = 0.4;
grading.temperature = -0.2;
grading.hsl_blue    = [0.0, 20.0, -5.0];

// Concat clips dengan GPU transitions
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

---

## Dependencies Utama

| Crate | Versi | Fungsi |
|---|---|---|
| `tokio` | 1 | Async runtime |
| `wgpu` | 22 | GPU pipeline (WGSL shaders) |
| `bytemuck` | 1 | GPU uniform buffer |
| `ffmpeg-sidecar` | 2 | FFmpeg spawn + manage |
| `sqlx` | 0.8 | PostgreSQL + pgvector RAG |
| `reqwest` | 0.12 | HTTP client (LLM API calls) |
| `clap` | 4 | CLI argument parsing |
| `tracing` | 0.1 | Structured logging |
| `serde_json` | 1 | JSON parsing |
| `whisper-rs` | 0.16 | Local Whisper (optional feature) |

---

## Build

```bash
# Standard build
cargo build --release

# Dengan local Whisper + CUDA GPU
cargo build --release --features local-whisper,cuda
```

**Requirements:**
- Rust 2024 edition
- LLVM/Clang (untuk whisper-rs bindgen, jika pakai local-whisper)
- CUDA Toolkit 12.x (untuk `--features cuda`)
- GPU dengan Vulkan/DX12 support (untuk `[gpu] enabled = true`)

---

## License

Copyright (c) 2026 CLIPPER. **All Rights Reserved.**  
Proprietary software. Unauthorized use strictly prohibited.
