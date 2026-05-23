# CLIPPER — Context Editing Blueprint

> **Petunjuk penggunaan:** File ini adalah *living document* — status diperbarui setiap ada implementasi baru.
> Selalu sertakan file ini sebagai konteks di setiap sesi kerja pada project CLIPPER.

---

## Tujuan Sistem

Membangun pipeline otomatis yang memahami **gaya editing media sosial viral** (TikTok/Reels/Shorts) secara end-to-end: dari ingestion video mentah hingga produksi clip yang mengikuti tren editing terkini, dengan bantuan LLM sebagai synthesis engine.

---

## Status Keseluruhan

| Layer | Coverage | Keterangan |
|-------|----------|-----------|
| Ingest + transkrip | ✅ 100% | yt-dlp + Whisper word-level timestamps |
| Visual scoring (post-analysis) | ✅ 80% | Frame extraction + vision LLM scoring |
| LLM synthesis dari teks saja | ✅ 90% | Multi-provider, chunked, trending-aware |
| Combined audio-visual prompt | ✅ 85% | Full-video frame descriptions diinjeksikan ke transcript (opt-in via `vision.describe_video`) |
| Production metadata (sfx/bgm/style) | ✅ 85% | LLM pilih per clip, auto-discovery katalog |
| Trend awareness (real-time) | ✅ 70% | Google Trends + keyword scoring |
| **Style Profiles system** | ❌ 0% | Named presets untuk gaya editing trending — belum diimplementasi |
| **CapCut-style subtitle animation** | ❌ 0% | Animasi kata bold/berwarna seperti CapCut — belum diimplementasi |
| **Reference video style analyzer** | ❌ 0% | Analisis video TikTok trending untuk ekstrak gaya editing — belum diimplementasi |
| **Trend-aware editing engine** | ❌ 0% | Full adaptive system berdasarkan tren terkini — belum diimplementasi |
| RAG / knowledge base viral patterns | ✅ 90% | Supabase pgvector + Gemini embeddings — store & retrieve moments, inject examples into prompt |
| Beat-sync audio-visual | ❌ 0% | SFX hardcoded di t=0 |
| Scene boundary detection | ✅ 100% | `detect_scene_boundaries()` via FFmpeg select filter, opt-in via `vision.scene_detection` |

---

## Blueprint Detail & Status Implementasi

---

### 1. Definisi Metrik 'Context Editing'

Parameter yang harus diekstraksi dan dipahami LLM untuk menilai kualitas editing.

| Parameter | Status | Implementasi | File |
|-----------|--------|--------------|------|
| **Pacing & Transisi** | ✅ Implemented | `ClipStyle` enum (fade/flash/zoom/smooth/none), LLM memilih per clip via `clip_style` field di `ViralMoment` | `src/edit/ffmpeg.rs` |
| **Struktur Hook (3 detik)** | ✅ Implemented | Field `hook` di `ViralMoment` — LLM identifikasi kata-kata pertama yang menarik | `src/analyze/schema.rs` |
| **Overlay & Caption Style** | ✅ Implemented | Headline lower-third panel (news-ticker) + subtitle karaoke kuning/putih + Poppins font | `src/edit/ffmpeg.rs`, `src/edit/subtitle.rs` |
| **Headline animation mengikuti style** | ✅ Implemented | `HeadlineAnim` — panel masuk/keluar sesuai ClipStyle (slide-up untuk Zoom, snap untuk Flash, dll) | `src/edit/ffmpeg.rs` |
| **Audio-Visual Sync (beat-sync)** | ❌ Not implemented | SFX selalu di t=0, belum ada deteksi BPM/beat drop untuk sinkronisasi transisi | — |
| **Viral type classification** | ✅ Implemented | 8 kategori: educational_shock, transformation, controversy, actionable, relatable, blueprint, inspiration, storytelling | `src/analyze/schema.rs` |
| **Emotional trigger classification** | ✅ Implemented | 8 kategori: curiosity, surprise, validation, inspiration, fear, humor, empathy, admiration | `src/analyze/schema.rs` |
| **Energy level** | ✅ Implemented | high/medium/low — digunakan untuk memilih BGM dan SFX | `src/analyze/schema.rs` |

---

### 2. Pipeline Ingestion & Pre-processing

Membedah file media menjadi komponen yang dapat diproses.

| Komponen | Status | Implementasi | File |
|----------|--------|--------------|------|
| **Download video (yt-dlp)** | ✅ Implemented | yt-dlp subprocess dengan progress streaming, auto-merge video+audio | `src/ingest/service.rs` |
| **Copyright detection** | ✅ Implemented | Cek field `license` + scan description untuk kata-kata copyright | `src/ingest/service.rs` |
| **YouTube transcript download** | ✅ Implemented | Auto-download subtitle YouTube (json3/vtt), fallback ke Whisper | `src/ingest/service.rs` |
| **Ekstraksi Audio (WAV)** | ✅ Implemented | FFmpeg → WAV 16kHz mono untuk Whisper | `src/edit/ffmpeg.rs` |
| **Frame Extraction** | ✅ Implemented | `vision.rs` — extract JPEG frames via FFmpeg per candidate moment | `src/analyze/vision.rs` |
| **Scene Boundary Detection** | ❌ Not implemented | Saat ini sampling uniform (fps = count/duration). Harusnya menggunakan FFmpeg `select='gt(scene,0.3)'` untuk deteksi pergantian adegan yang sesungguhnya | — |
| **Keyframe-only extraction** | ❌ Not implemented | Ambil frame di interval tetap, bukan hanya di scene cut yang signifikan | — |
| **Audio tempo/BPM detection** | ❌ Not implemented | Tidak ada analisis ritme musik BGM untuk sinkronisasi transisi | — |

---

### 3. Multimodal → Text Translation

Jembatan antara media audio-visual dan LLM teks.

| Komponen | Status | Implementasi | File |
|----------|--------|--------------|------|
| **Speech-to-Text + word timestamps** | ✅ Implemented | Whisper local CUDA (large-v3) + Groq Whisper API, word-level timestamps | `src/transcribe/service.rs` |
| **BPE subword merging** | ✅ Implemented | `fix_subwords()` / `merge_subword_tokens()` — gabungkan token terpecah seperti "ber"+"sama" | `src/transcribe/model.rs` |
| **Visual frame scoring (Vision LLM)** | ✅ Implemented | Frame → Gemini/Claude/OpenAI/vLLM → skor humor, visual_impact, novelty, engagement (0-10) | `src/analyze/vision.rs` |
| **Multi-provider vision support** | ✅ Implemented | Gemini, OpenAI, Claude, vLLM (multimodal) | `src/analyze/vision.rs` |
| **Rich frame description per timestamp** | ✅ Implemented | `describe_video_frames()` di `vision.rs` — sample 1 frame per N detik, kirim ke vision LLM, hasilkan deskripsi teks per frame | `src/analyze/vision.rs` |
| **Combined audio+visual synchronized prompt** | ✅ Implemented | `build_enriched_transcript()` menginjeksikan deskripsi visual ke setiap baris transcript. Aktifkan via `vision.describe_video = true` | `src/analyze/vision.rs`, `src/analyze/service.rs` |

**Output yang kini tersedia (dengan `describe_video = true`):**
```
[120] "Hampir 60% uang dari Cina!"
  ↳ Visual: close-up wajah pembicara, ekspresi serius, grafik merah di background
[130] "Dan ini yang tidak pernah diberitahu..."
  ↳ Visual: pembicara menunjuk grafik, tangan menekankan angka di layar
```

---

### 4. LLM Synthesis Engine

Core engine yang menganalisis dan menghasilkan output terstruktur.

| Komponen | Status | Implementasi | File |
|----------|--------|--------------|------|
| **Multi-provider LLM** | ✅ Implemented | Groq, OpenAI, Claude, Gemini, vLLM, Ollama | `src/analyze/provider/` |
| **Structured JSON output (ViralMoment)** | ✅ Implemented | 17+ fields: title, headline, hook, caption, viral_type, sfx_vibe, bgm_vibe, overlay_query, dll | `src/analyze/schema.rs` |
| **Transcript + timestamp ke LLM** | ✅ Implemented | Format `[sec] teks` dikirim ke LLM dengan keyword markers | `src/analyze/prompt.rs` |
| **Chunked analysis (long videos)** | ✅ Implemented | Auto-chunking 180s windows dengan 30s overlap untuk video >15 menit | `src/analyze/service.rs` |
| **Retry + JSON repair** | ✅ Implemented | Retry sekali dengan fresh prompt jika JSON invalid | `src/analyze/service.rs` |
| **Visual re-ranking post-analysis** | ✅ Implemented | Vision scores digunakan untuk re-rank kandidat (text 65% + visual 35%) | `src/analyze/service.rs` |
| **AI-generated headline (news-ticker)** | ✅ Implemented | Field `headline` terpisah dari `title` — dirancang untuk visual overlay, bukan SEO | `src/analyze/schema.rs` |
| **Per-clip production suggestions** | ✅ Implemented | LLM memilih clip_style, sfx_vibe, bgm_vibe, overlay_query per moment | `src/analyze/schema.rs` |
| **Combined audio+visual synthesis** | ✅ Implemented | Frame descriptions diinjeksikan ke transcript sebelum main LLM analysis. `vision.describe_video = true` untuk aktifkan | `src/analyze/service.rs` |

---

### 5. Knowledge Base & Trend (RAG)

Konteks tren untuk membandingkan dengan pola editing yang sedang viral.

| Komponen | Status | Implementasi | File |
|----------|--------|--------------|------|
| **Real-time Google Trends** | ✅ Implemented | `trending.rs` — fetch trending topics regional (ID) + keyword interest scores | `src/analyze/trending.rs` |
| **Keyword-aware moment selection** | ✅ Implemented | Transkrip diformat dengan marker `[🎯 keyword]` untuk moments yang relevan dengan trending keywords | `src/analyze/service.rs` |
| **User-defined focus keywords** | ✅ Implemented | `--keywords` CLI arg, dikombinasikan dengan auto-extracted + trending keywords | `src/cli.rs` |
| **Vector Database** | ❌ Not implemented | Tidak ada penyimpanan persisten hasil analisis video viral masa lalu | — |
| **RAG similarity matching** | ❌ Not implemented | Tidak ada perbandingan "clip ini 80% mirip template trending X" | — |
| **Editing style fingerprinting** | ❌ Not implemented | Tidak ada ekstraksi "gaya editing" dari video viral untuk dijadikan referensi | — |

---

## Arsitektur Saat Ini

```
URL / File
    │
    ▼
[1. INGEST]  yt-dlp → video.mp4
                     ↓ (parallel)
           YT subtitles ─────────────────┐
                                         │
    ▼                                    │
[2. TRANSCRIBE]  Whisper CUDA / Groq API │
                 → transcript.json       │
                   (word timestamps)     │
                         │               │
    ▼                    ▼               │
[3. ANALYZE]  ┌── Text LLM ─────────────┘
              │   (Groq/Gemini/vLLM/etc)
              │   + Google Trends context
              │   → ViralMoment candidates (2× max_clips)
              │
              └── Vision LLM (optional)  ← frames dari video
                  (Gemini/Claude/vLLM)
                  → visual scores → re-rank → top N moments
                  → moments.json

    ▼
[4. EDIT]  Per clip:
           ├── Generate ASS subtitles (karaoke style)
           ├── Download TikTok overlay (optional, yt-dlp)
           ├── Resolve SFX from catalog (auto-discovery)
           ├── Resolve BGM from catalog (auto-discovery)
           └── FFmpeg encode:
               - Reframe (vertical/horizontal/square)
               - Subtitle burn
               - Headline lower-third panel
               - SFX + BGM mix
               - ClipStyle transition
               - TikTok overlay insert (optional)
               → clip_NNN.mp4
```

---

## Gap Prioritas (Roadmap)

### ✅ Priority 1 — Rich frame descriptions + combined prompt — **SELESAI**
**Diimplementasikan:** `describe_video_frames()` + `build_enriched_transcript()` + injeksi ke service

Untuk mengaktifkan:
```toml
[vision]
enabled        = true
describe_video = true       # ← aktifkan combined prompt
describe_interval = 10.0   # 1 frame per 10 detik
describe_batch    = 5      # 5 frame per API call
```

### ✅ Priority 2 — Scene boundary detection — **SELESAI**
**Diimplementasikan:** `detect_scene_boundaries()` + updated `extract_frames()` + scene-aware `describe_video_frames()`

Untuk mengaktifkan:
```toml
[vision]
scene_detection = true
scene_threshold = 0.3   # 0.0 = sangat sensitif, 1.0 = hard cuts only
```

### ✅ Priority 3 — Subtitle Styles (CapCut/WordPop/Minimal/Karaoke) — **SELESAI**
**Diimplementasikan:** `SubtitleStyle` enum + 4 gaya ASS + LLM picks per clip via `subtitle_style` field

### ✅ Priority 3 (lengkap) — Style Profiles + trend-analyze command — **SELESAI**
**Impact: Sangat Tinggi** — Langsung terlihat di hasil video, mengikuti tren editing terkini

#### Mengapa ini penting
Tren editing TikTok/Reels bergerak cepat. Tools yang hardcode gaya editing akan ketinggalan dalam 2 minggu. CLIPPER perlu sistem yang bisa di-update mengikuti tren tanpa harus recompile.

#### 3a. Style Profiles System

Named presets yang capture gaya editing trending. Disimpan di `config.toml` dan bisa di-update manual tiap bulan.

```toml
[style_profiles.tiktok_id_2025]
# Gaya TikTok Indonesia trending 2025
clip_style_default    = "flash"
subtitle_style        = "capcut_bold"   # kata tebal bergantian kuning/putih
overlay_behavior      = "sticker_corner"
sfx_on_hook           = true            # SFX tepat di kata pertama
bgm_duck_on_speech    = true
cut_pace              = "fast"          # avg 2-3s per segment

[style_profiles.youtube_shorts_edu]
clip_style_default    = "zoom"
subtitle_style        = "minimal_white"
overlay_behavior      = "pip_reaction"
sfx_on_hook           = false
bgm_duck_on_speech    = true
cut_pace              = "medium"
```

**Flow**: `content_category + energy + viral_type` → LLM picks best profile → apply to render

**Files to create/modify:**
- `src/config.rs` — `StyleProfile` struct + `profiles: HashMap<String, StyleProfile>`
- `config.toml` — default profiles
- `src/analyze/schema.rs` — add `style_profile: String` to `ViralMoment`
- `src/edit/service.rs` — apply profile parameters to `AudioOptions` per clip

#### 3b. CapCut-style Subtitle Animation

Ini yang paling langsung terlihat. Ganti subtitle karaoke biasa dengan animasi yang lebih dinamis:

**Saat ini**: kata highlight bergantian (kuning/putih), statik  
**Target**: kata muncul satu per satu dengan efek scale/bounce, background pill, warna dinamis berdasarkan energy

```
NORMAL word  ← putih, normal size
[HIGHLIGHT]  ← kuning, bold, scale 110%, background pill hitam
```

Untuk konten high-energy: kata muncul lebih cepat, warna lebih kontras  
Untuk konten emotional: transisi lebih halus, warna lebih soft

**Files to modify:**
- `src/edit/subtitle.rs` — add `SubtitleStyle` enum dengan variant `CapcutBold`, `MinimalWhite`, `HighEnergy`
- `src/edit/ffmpeg.rs` — build style-specific ASS filter

#### 3c. Reference Video Style Analyzer (New command)

```powershell
# Download & analyze 5 trending videos, buat style profile baru
clipper trend-analyze \
  --hashtag "suratirta" \
  --sample 5 \
  --provider gemini \
  --output-profile tiktok_id_health_2025
```

**Proses**:
1. yt-dlp download N video dari TikTok hashtag/trending
2. Extract frames setiap 2s dari setiap video
3. Vision LLM analyze: "Describe editing style — caption, overlay, pacing, transitions"
4. Synthesize → generate style profile JSON
5. Save ke `style_profiles/` folder
6. Tersedia sebagai `--style-profile tiktok_id_health_2025` di run command

**Output style profile yang diekstrak:**
```json
{
  "avg_cut_every_secs": 2.3,
  "caption_style": "bold_yellow_words_white_bg",
  "overlay_common": "greenscreen_bottomright_35pct",
  "transition_dominant": "flash_white",
  "sfx_placement": "on_hook_and_peak",
  "bgm_energy": "upbeat_hiphop"
}
```

---

### ✅ Priority 4 — Beat-sync SFX/BGM — **SELESAI**
**Diimplementasikan:** BPM dari metadata + vibe fallback, SFX adelay ke downbeat, BGM ducking filter

Aktifkan dengan:
```toml
[assets]
beat_sync = true
```

### ✅ Priority 4 lanjutan — Beat-aligned ClipStyle transitions — **SELESAI**
**Diimplementasikan:** `clip_bpm` di AudioOptions, `fade_in_dur(bpm)` dan `fade_out_dur(bpm)` di ClipStyle, HeadlineAnim juga beat-aligned

Priority 4 sepenuhnya selesai:
- SFX snapped to downbeat ✅
- BGM ducking during speech ✅  
- ClipStyle transition duration = beat subdivision ✅ (Fade=1beat, Flash=½beat, Smooth=2beats)

### 🔵 Priority 5 — Vector DB + RAG
**Impact: Tinggi jangka panjang** — Memungkinkan "style matching" dengan video viral

Implementasi:
- Simpan `ViralMoment` + `VisualScore` ke Vector DB (e.g., Qdrant/Chroma)
- Embedding: encode editing parameters sebagai vector
- Saat analisis video baru: retrieve similar past viral clips → inject sebagai contoh ke prompt

### 🔵 Priority 6 — Full Adaptive Trend Learning
**Impact: Sangat Tinggi jangka panjang** — CLIPPER belajar sendiri dari tren terkini

Arsitektur lengkap yang perlu dibangun:

```
Sumber data tren (auto-pull):
├── Google Trends (sudah ada) → keywords viral
├── TikTok Creative Center   → trending sounds, hashtags
├── TikTok Hashtag pages     → format video dominan (via yt-dlp scraping)
└── YouTube Trending         → Shorts format/style

↓ Processing

Style Extractor:
├── Download 5-10 video trending per kategori
├── Vision LLM → extract style fingerprint per video
├── Synthesize → "gaya editing yang sedang dominan minggu ini"
└── Update style_profiles/ otomatis

↓ Apply

Render Engine (CLIPPER saat ini):
├── Pilih style profile yang paling sesuai + trending
├── Apply: transition, subtitle, overlay, sfx, bgm
└── Output clip yang mengikuti tren minggu ini
```

**Trend data sources yang bisa diakses gratis:**

| Sumber | Data | Cara akses |
|--------|------|-----------|
| Google Trends | Keywords | API (sudah ada) |
| TikTok hashtag | Format dominan | yt-dlp scraping |
| YouTube Trending | Shorts style | yt-dlp scraping |
| TikTok Creative Center | Sounds, hashtags | Web scraping |

---

## Catatan Teknis

### Provider yang Didukung

| Provider | Teks | Vision | Notes |
|----------|------|--------|-------|
| Groq | ✅ | ❌ | Free tier, 30K TPM (llama-3.3-70b) |
| OpenAI | ✅ | ✅ | gpt-4o-mini (vision: detail=low) |
| Claude | ✅ | ✅ | claude-sonnet-4-5 |
| Gemini | ✅ | ✅ | gemini-2.0-flash, free tier 15 RPM |
| vLLM | ✅ | ✅ | Self-hosted, mendukung reasoning models (gpt-oss-120b, qwen-vl) |
| Ollama | ✅ | ❌ | Local inference |

### Config File
```
config.toml      — semua konfigurasi (no secrets)
.env             — API keys (CLIPPER_*_API_KEY)
fonts/           — Poppins font files (auto-download)
sfx/             — SFX files (auto-discovery by keyword)
bgm/             — BGM files (auto-discovery by keyword)
overlay_cache/   — Downloaded TikTok overlay clips (cached by query hash)
models/          — Whisper GGML model files
output/          — Pipeline output (job artifacts)
```

### Struktur Output Per Job
```
output/.clipper/{job_id}/
├── state.json           — pipeline state (resumable)
├── source/
│   └── {video_id}.mp4   — downloaded video
├── transcribe/
│   └── transcript.json  — word-level timestamps
├── analyze/
│   ├── moments.json     — ViralMoment list dengan visual scores
│   └── frames/          — temp frame files (deleted after vision analysis)
└── clips/
    ├── clip_000_*.ass   — ASS subtitle file
    └── clip_000_*.mp4   — final rendered clip
```

---

*Last updated: 2026-05-21*
*Ditambahkan: Trend-Aware Editing Architecture (Priority 3–6) — Style Profiles, CapCut subtitle, Reference Video Analyzer, Full Adaptive Learning*
*Next priority: Style Profiles system + CapCut-style subtitle animation*
*Priority 1 (Combined audio-visual prompt) selesai diimplementasikan.*
*Gap berikutnya: Scene boundary detection (Priority 2) dan Beat-sync SFX/BGM (Priority 3)*
