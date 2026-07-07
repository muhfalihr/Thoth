<p align="center">
  <img src="assets/logo/thoth-logo.svg" alt="Thoth — AI short-form video strategist" width="520">
</p>

<p align="center">
  🚧 <strong>Work in progress</strong> — masih dalam pengembangan aktif (API, config, & perilaku bisa berubah).
</p>

---

> *Dinamai dari **Thoth**, dewa Mesir berkepala ibis — penjaga tulisan, kebijaksanaan, dan juru bicara para dewa. Sebuah tool yang **menulis, menarasikan, dan menyebarkan** cerita.*

**Thoth** adalah CLI tool berbasis Rust yang mengotomasi pembuatan video short-form (TikTok, Reels, Shorts) dari konten long-form **atau** dari content-set hasil sourcing multi-platform (layer `scout/`). Pipeline end-to-end: download → transkripsi → analisis AI → enrichment (narator/berita) → edit video dengan GPU acceleration. Mendukung dua mode: **clip-mode** (potong momen viral dari satu video) dan **narrator-driven** (satu naskah komentator jadi tulang punggung, b-roll + kartu reaksi-berita dirakit mengelilinginya).

> 📦 **Baru pertama kali setup?** Ikuti **[SETUP.md](SETUP.md)** — panduan lengkap dari prerequisite, toolchain, API key, sampai run pertama (jalur Lite/API & Full/GPU).

### 📚 Peta Dokumentasi
| Dokumen | Isi |
|---|---|
| **[SETUP.md](SETUP.md)** | Instalasi langkah demi langkah (toolchain, API key, run pertama) |
| **[docs/MODELS.md](docs/MODELS.md)** | Semua model AI yang dipakai (per-stage) + cara ganti + rekomendasi |
| **[config.toml.example](config.toml.example)** | Referensi lengkap semua opsi `config.toml` (berkomentar) |
| **[.env.example](.env.example)** | Template semua environment variable / API key |
| **[scout/README.md](scout/README.md)** | Content sourcing (layer `scout/`): discovery, content-set, CKB, enrichment |
| **[scout/SETUP.md](scout/SETUP.md)** · **[scout/RUNBOOK.md](scout/RUNBOOK.md)** | Setup & operasi harian scout |
| **[CHANGELOG.md](CHANGELOG.md)** · **[BLUEPRINT.md](BLUEPRINT.md)** | Riwayat perubahan · blueprint arsitektur & status fitur |

---

## Arsitektur Pipeline

```
URL / File / --content set.json (scout: main + footage + comments + figures)
    │
    ▼ Stage 1: INGEST
    yt-dlp → video.mp4 + metadata   (TikTok/IG/CDN .mp4 didukung)
    │
    ▼ Stage 2: TRANSCRIBE
    Whisper (CUDA/CPU) → transcript.json (word-level timestamps)
    │
    ▼ Stage 3: ANALYZE
    LLM (multi-provider) → moments.json
    Vision LLM → visual scores + describe_video per frame
    RAG/pgvector → inject past viral patterns
    │
    ▼ Stage 4: ENRICH  (opt-in)
    Narrator-driven: 1 naskah LLM → TTS voiceover (spine) + RAG struktur narasi
    Cultural context (scout): enrich_context → references/discourse + web-grounding
                                 + CKB (Supabase) — narator paham subteks komentar
    News: keyword → Google News (Playwright) → screenshot cards
    Reaction: script + TTS + avatar (opsional)
    │
    ▼ Stage 5: EDIT
    FFmpeg encode (subtitle SELALU di layer paling depan)
    ├── AI Cover intro (FLUX bg + rembg cutout + headline) → dissolve ke footage
    ├── Hook title PNG (Pillow: stroke tebal + shadow, rata kiri, warna per-baris)
    ├── Reaction-news overlays (profile card, comment cards, callout)
    ├── Reaction memes FULL-SCREEN (LLM-match ke emosi narasi, di bawah subtitle)
    ├── Animelorian montage (kanvas kertas + footage cards)
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

### Narrator-Driven Spine (`[narration]`)
Satu naskah komentator (LLM) → **voiceover TTS** (ElevenLabs / MiniMax / Fish Audio / Edge) jadi audio utama. Video dibangun mengelilingi narasi: footage di-placement by embedding-similarity ke window narasi, audio event di-duck, subtitle diturunkan dari narasi. Di-*ground* ke `main.title/description` + komentar + deskripsi visual, dan ke korpus **struktur narasi terbukti** (Narration Structure RAG). Degrade ke clip-mode bila narasi tak tersedia.

### AI Cover / Thumbnail intro (`[cover]`)
Di detik awal (hook window) ditampilkan **cover full-screen** sebelum cut ke footage — gaya thumbnail viral:
- **Background AI** — Novita **FLUX.1 schnell** men-generate latar dramatis sesuai topik.
- **Subjek** — `subject_mode`:
  - `auto` (default) — cutout orang asli (rembg) bila frame **terbaca jelas** (gate brightness/sharpness/coverage); kalau gelap/blur → generate subjek AI.
  - `ai` — selalu FLUX generate subjek dominan penuh layar.
  - `cutout` — selalu cutout orang asli dari frame video.
- **Vision-grounded** — model vision (`qwen3-vl`) mendeskripsikan frame asli sedetail mungkin → FLUX **merekreasi kejadian nyata** jadi ilustrasi HD (bukan tebakan dari headline).
- **Prompt Inggris** — headline (Indonesia) diterjemahkan LLM jadi prompt scene Inggris untuk background lebih relevan.
- Lalu **dissolve** (Ken-Burns + fade) ke footage. Butuh `python` + `Pillow` + `rembg`; gagal → fallback ke hook title biasa.

### Hook Title Renderer (`[hook_title]`)
Judul raksasa scroll-stopper, dua engine:
- **`engine = "python"`** (default) — render PNG via Pillow: **stroke hitam tebal + drop-shadow + AA halus**, **rata kiri**, jarak baris rapat, **warna per-baris** (putih/kuning/cyan), Montserrat ExtraBold, area bawah-tengah. Mirip template cover viral.
- **`engine = "ass"`** — fallback libass (legacy) bila Python tak tersedia.
- Knob: `palette`, `color_mode`, `text_align`, `margin_l`, `margin_v`, `line_spacing`, `stroke_width`, `font_file`, `shadow_*`.

### Reaction-News Overlays
Gaya konten reaksi-berita Indonesia, dirakit dari data faktual (scout):
- **Profile card** (`[profile_card]`) — kartu profil **crop asli** dari sumber sosmed (bukan sintetis)
- **Comment cards** — screenshot **komentar viral asli** (author/text/likes) di reaction beat
- **Callout** (`[callout]`) — angka penting + panah penunjuk
- **Subtitle selalu di layer paling depan** — di-burn setelah semua overlay, jadi caption tak pernah tertutup cutaway.

### Reaction Memes (mode narator, `[assets]`)
Meme reaksi (`assets/meme/`) disisipkan otomatis di mode narator:
- **LLM-matched** — LLM memilih meme dari katalog & menaruhnya di **beat narasi yang emosinya cocok** (kaget/facepalm/sedih/bingung/tepuk-tangan), tersebar dengan jarak minimum.
- **Full-screen** (`meme_fullscreen`, default) — meme tampil penuh layar (cutaway, meme utuh di atas blurred-fill) **di bawah subtitle**; audio meme nge-duck narasi.
- Knob: `memes_in_narration`, `narration_max_memes`, `meme_fullscreen`.

### Content Sourcing (scout + multi-platform)
- **`thoth run --content set.json`** — terima content-set eksternal `{main, footage, comments, figures, profile}` hasil sourcing layer `scout/`, termasuk crop screenshot komentar & kartu profil.
- **`[content_search]`** — cari MAIN video + pool enrichment lintas YouTube/Instagram/Twitter/News (Playwright/Scrapling) saat `--query` / auto-trending.

### Cultural Context Enrichment (mode narator)
Agar narasi **paham subteks** komentar (sarkasme, meme, nama tokoh) dan tidak salah baca:
- **`enrich_context.js` (scout)** — decode komentar jadi `references` (entitas/meme/slang),
  `context` per-komentar (maksud + nada), dan `discourse` (sikap kolektif audiens) → disuntik ke
  prompt narasi sebagai blok `[Konteks Budaya]` + `[Maksud Komentar]`.
- **Web-grounding** (`web_grounding.js`) — perbarui status entitas ke **terkini** via Google News
  (atasi cutoff model, mis. tokoh "menteri" → "terdakwa").
- **Cultural Knowledge Base** (`ckb.js`, **Supabase**) — cache hasil resolve lintas-run/mesin (cache-first).
- **Cultural Pulse** (`pulse_harvest.js`, cron harian) — pelajari tren dari **komentar** video trending
  (bukan index platform) → blok `[Tren Diskursus]` + gaya bahasa kini (opsional).

Detail desain & operasi: [scout/README.md](scout/README.md). Daftar model: [docs/MODELS.md](docs/MODELS.md).

### News Enrichment (`[news]`, opt-in)
Keyword dari transcript per-momen → Google News (Playwright, tanpa API key) → screenshot kartu berita yang relevan disisipkan ke clip.

### Reaction Module (`[reaction]`, opt-in)
Script reaksi + TTS + avatar opsional (static image / **SadTalker** lokal GPU / D-ID / HeyGen), ditempel post-roll / pre-roll / PiP.

### Animelorian Montage (`[animelorian]`)
Base kanvas kertas grid; footage (main + hasil search) di-composite sebagai **kartu di tengah** dan dipotong antar-footage (montase) — hook tetap full-frame.

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

> 🪶 **Thoth.** Binary `thoth`, crate `thoth::`, folder output job `.thoth/`, prefix env **`THOTH_*`**. Conda env: `thoth-news` / `thoth-sadtalker` (buat via `scripts/setup_thoth_news.bat`).

### `run` — Pipeline Utama
```bash
thoth run <URL_ATAU_PATH> [OPTIONS]

# Contoh
thoth run "https://youtu.be/xxxx"
thoth run ./video.mp4 --max-clips 5 --layout vertical
thoth run "https://youtu.be/xxxx" --style-profile tiktok_id_2025
thoth run "https://youtu.be/xxxx" --provider claude --layout square
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
| `--content FILE` | — | Content-set JSON (scout): `{main, footage, comments, figures}` → mode narrator-driven |
| `--resume JOB_ID` | — | Lanjutkan job yang gagal |

> **Narrator-driven**: jalankan dengan `--content set.json` (atau aktifkan `[narration]`) untuk membangun video di sekitar voiceover narator. Gunakan `--provider novita` untuk narasi (default `groq` kena rate-limit → fallback clip-mode).

### `trend-analyze` — Auto-generate Style Profile
```bash
# Analisis 10 video trending → generate style profile ke config.toml
thoth trend-analyze --count 10 --output tiktok_id_latest
```

### `vocab` — Knowledge Management
```bash
thoth vocab seed defaults          # isi DB dengan default viral keywords
thoth vocab list tone_funny        # list kata dalam kategori
thoth vocab add energy_high "hype" # tambah kata manual
thoth vocab review                 # review candidate words interaktif
thoth vocab stats                  # DB status + word counts
```

### `thumbnail` — Regenerate Thumbnails
```bash
thoth thumbnail --job-id <ID>
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

### `[assets]` — SFX, BGM & Reaction Memes
```toml
[assets]
sfx_dir   = "assets/sfx"
bgm_dir   = "assets/bgm"
catalog_path        = "assets/asset_catalog.json"
memes_in_narration  = true   # LLM taruh meme reaksi di beat narasi yang cocok emosinya
narration_max_memes = 3      # maksimum meme per video narasi
meme_fullscreen     = true   # meme FULL-LAYAR (cutaway) di bawah subtitle, bukan PiP pojok
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
cache_dir           = "footage_cache"
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

### `[narration]` — Narrator-Driven Spine
```toml
[narration]
enabled        = true
model          = "deepseek/deepseek-v3.1"  # naskah narasi (chat non-reasoning → JSON andal; HINDARI *-flash). Provider dari --provider
target_secs    = 45        # target panjang narasi (~3 kata/detik)
language       = "id"
duck_event_vol = 0.12      # volume audio event saat narator bicara
leak_event_vol = 0.45      # volume saat narator jeda
lead_in_secs   = 1.6       # audio event main keras dulu sebelum narator
structure_rag  = true      # RAG struktur narasi (Supabase narration_structures)
```

### `[content_search]` — Multi-platform Sourcing
```toml
[content_search]
enabled          = true
script           = "scripts/social_search.py"
platforms        = "youtube,instagram,twitter,news"   # tiktok perlu proxy residential
engine           = "auto"            # auto | playwright | scrapling
max_per_platform = 6
expand_keywords  = true              # LLM expand query → keyword ganda
```

### AI Cover & Hook Title — `[cover]` / `[hook_title]`
```toml
[cover]
enabled         = true
duration_sec    = 3.0
subject_mode    = "auto"          # auto | ai | cutout
prompt_translate = true           # headline ID → prompt scene Inggris (LLM)
subject_scale   = 1.02            # (mode cutout) tinggi subjek = fraksi kanvas
darken          = 0.32            # gradient gelap utk kontras teks
steps           = 4               # FLUX schnell
prompt_suffix   = "empty scene with no people, dramatic cinematic ..."

[hook_title]
enabled      = true
engine       = "python"           # python (Pillow PNG, terbaik) | ass (libass)
palette      = ["#FFFFFF", "#FFE100", "#FFFFFF", "#3FC1FF", "#FFFFFF"]  # cycle per baris
color_mode   = "per_line"
font_file    = "assets/fonts/Montserrat-ExtraBold.ttf"
text_align   = "left"             # left (gaya template) | center
margin_l     = 56                 # margin kiri (px)
margin_v     = 380                # jarak dari bawah
line_spacing = 1.0                # ×ukuran font (≈1.0 = rapat)
stroke_width = 13                 # tebal stroke (engine python)
shadow_dy    = 12
shadow_blur  = 10.0
shadow_alpha = 170

[profile_card]
enabled         = true
position        = "lower"            # center | upper | lower
name_above_head = false              # banner nama raksasa (default OFF — mengganggu)
# Crop kartu profil ASLI dipakai bila content-set memberi profile.image_path

[callout]
enabled      = true                  # angka penting + panah
max_per_clip = 3
```

### `[animelorian]` — Montage Composite
```toml
[animelorian]
enabled              = true
paper_bg             = "assets/ui/Paper-Grid-Background.mp4"
footage_scale_pct    = 88            # lebar kartu footage
montage              = true          # intercut footage sebagai kartu
montage_max_cuts     = 2
```

### `[news]` / `[reaction]` — Enrichment (opt-in)
```toml
[news]
enabled       = false                # keyword → Google News (Playwright) → screenshot cards
provider      = "playwright"
conda_env     = "thoth-news"       # buat: scripts/setup_thoth_news.bat

[reaction]
enabled  = false                     # script reaksi + TTS + avatar
position = "post_roll"               # post_roll | pre_roll | pip_corner
[reaction.tts]
provider = "elevenlabs"              # edge | minimax | fish_audio | openai | elevenlabs | none
[reaction.avatar]
mode = "none"                        # none | static_image | sad_talker | did | heygen
```

> Daftar lengkap semua opsi: lihat **`config.toml.example`** (template tersinkron, tanpa secret).

---

## Environment Variables (`.env`)

Thoth memuat `.env` di root saat start (via `dotenvy`). Template lengkap: **[.env.example](.env.example)**.

```env
# ── LLM providers (isi yang dipakai saja) ──
THOTH_NOVITA_API_KEY=...           # default; analyze/narration/vision/embedding/cover-FLUX/scout
THOTH_GROQ_API_KEY=gsk_...         # provider alt + Whisper API (transcribe)
THOTH_OPENAI_API_KEY=sk-...
THOTH_CLAUDE_API_KEY=sk-ant-...
THOTH_GEMINI_API_KEY=AIza...
THOTH_OPENROUTER_API_KEY=...       # [cover] image_engine="openrouter" (gemini-2.5-flash-image)
THOTH_TOGETHER_API_KEY= / THOTH_FIREWORKS_API_KEY= / THOTH_VLLM_API_KEY=

# ── RAG + Cultural Knowledge Base (Supabase Postgres) ──
THOTH_SUPABASE_URL=postgresql://user:pass@host:5432/db   # vector_db RAG + CKB (enrich/pulse)
THOTH_EMBED_API_KEY=               # kosong = pakai novita key

# ── TTS (suara narator/reaksi) ──
THOTH_ELEVENLABS_API_KEY=          # default TTS (eleven_multilingual_v2)
THOTH_MINIMAX_API_KEY= / THOTH_MINIMAX_GROUP_ID= / THOTH_FISH_AUDIO_API_KEY=

# ── News + avatar (opsional) ──
THOTH_SERPER_API_KEY=              # news search (kalau provider serper)
THOTH_DID_API_KEY= / THOTH_HEYGEN_API_KEY=

# ── Tooling / override ──
FFMPEG_PATH=C:/.../ffmpeg.exe      # opsional (default auto-download / ffmpeg.exe lokal)
THOTH_PYTHON=python                # interpreter untuk renderer Pillow/cover
THOTH_WHISPER_LANGUAGE=id          # paksa bahasa transcribe (opsional)
```

**Knob model scout (opsional, default sudah bagus — lihat [docs/MODELS.md](docs/MODELS.md)):**
`THOTH_LLM_MODEL`, `THOTH_CONTEXT_MODEL`, `THOTH_VISION_MODEL`, `THOTH_EMBED_MODEL`,
`THOTH_GROUND=0` (matikan web-grounding), `THOTH_CKB_*` (TTL cache).

> **scout pakai FILE kunci, bukan `.env`.** Di folder `scout/`: `.novita_key` (wajib),
> `.groq_key` (opsional), dan untuk CKB Supabase: `.supabase_url` (atau env `THOTH_SUPABASE_URL`) +
> `npm install pg`. Detail: [scout/README.md](scout/README.md).

> 🔐 **Jangan commit** `.env`, `.novita_key`, `.groq_key`, `.supabase_url`, `config.toml`, atau cookie.
> Semua sudah di `.gitignore`.

---

## Output Structure

```
output/
└── .thoth/<job_id>/
    ├── state.json              ← stage checkpoints (resume support)
    ├── source/
    │   └── video.mp4
    ├── transcribe/
    │   └── transcript.json     ← word-level timestamps
    ├── analyze/
    │   ├── moments.json            ← ViralMoment[] dengan color_mood, gpu_transition
    │   └── video_descriptions.json ← describe_video per-frame (vision)
    ├── narration/
    │   └── narration.mp3           ← voiceover TTS (mode narrator-driven)
    └── clips/
        ├── clip_000_narration.mp4  ← narrator-driven, atau
        ├── clip_001_<slug>.mp4     ← clip-mode
        ├── clip_001_<slug>.jpg     ← thumbnail
        └── final_concat.mp4        ← jika gpu.concat_output = true

# Sidecar di output/ (dari --content / content_search):
#   content_enrichment.json · content_context.json · content_comments.json · content_profile.json
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
use thoth::gpu::{GpuProcessor, ClipJob, ColorParams};
use thoth::edit::{ColorGrading, Transition};

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
- **Python 3.10+ + Pillow + rembg** (untuk AI Cover & hook-title PNG renderer):
  ```bash
  python -m pip install Pillow rembg onnxruntime
  ```
  `THOTH_NOVITA_API_KEY` dipakai untuk generate background cover (FLUX) + deskripsi vision + pemilihan meme. Tanpa Python/Pillow, hook title fallback ke libass dan cover dilewati (graceful).

---

## License

Copyright (c) 2026 Thoth. **All Rights Reserved.**  
Proprietary software. Unauthorized use strictly prohibited.
