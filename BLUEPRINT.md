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
| **Style Profiles system** | ✅ 100% | `StyleProfile` struct + `StylesConfig` di config.rs; 4 default profiles di config.toml; apply di edit/service.rs |
| **CapCut-style subtitle animation** | ✅ 100% | `SubtitleStyle` enum (Karaoke/CapcutBold/WordPop/MinimalWhite) di subtitle.rs; LLM pilih per clip via `subtitle_style` field |
| **Reference video style analyzer** | ✅ 100% | `TrendAnalyzeService` di trend_analyzer.rs; download video → extract frames → vision LLM → synthesize profile → save TOML |
| **Trend-aware editing engine** | ❌ 0% | Full adaptive auto-learning dari TikTok Creative Center + YouTube Trending — belum diimplementasi (Priority 6) |
| RAG / knowledge base viral patterns | ✅ 95% | Supabase pgvector + embedding; store & retrieve moments; inject examples ke prompt; video_title/channel kini diteruskan ke storage |
| Beat-sync audio-visual | ✅ 100% | `beat_detect.rs` BPM dari metadata; SFX snap ke downbeat; BGM ducking; ClipStyle duration = beat subdivision |
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
| **Vector Database** | ✅ Implemented | `rag/store.rs` — `RagStore` store/retrieve via sqlx + Supabase pgvector; embedding via `rag/embed.rs` (Gemini/Novita/OpenAI/vLLM); video_title & channel disimpan sebagai metadata | `src/rag/store.rs`, `src/rag/embed.rs` |
| **RAG similarity matching** | ✅ Implemented | `build_rag_context()` di analyze/service.rs — embed transcript → cosine similarity search → top-N similar moments diinjeksikan ke system prompt sebagai contoh | `src/analyze/service.rs` |
| **Editing style fingerprinting** | ✅ Implemented | `TrendAnalyzeService` — download trending videos → extract frames → vision LLM → `StyleProfile` JSON; simpan ke `style_profiles/` folder via `clipper trend-analyze` | `src/analyze/trend_analyzer.rs` |

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

*Last updated: 2026-05-27 (4)*
*Status diperbarui: Style Profiles, CapCut subtitle, Reference Video Analyzer, Beat-sync, RAG — semua selesai.*
*Diperbaiki (2026-05-25):*
  - *vocab.rs: tambah "tepuk tangan" standalone ke intro keywords → talk show applause ceremony kini terdeteksi*
  - *service.rs: `snap_end_to_sentence_boundary()` di-upgrade pakai inter-segment silence gaps (≥300ms) sebagai primary boundary signal; connector-word scan jadi fallback*
  - *service.rs: `has_ceremony_transcript()` + filter baru — drop mid-video ceremony segments (live event roll-call, tepuk tangan buat [name], audience greeting) yang lolos dari timestamp-based intro filter*
  - *prompt.rs: tambah LIVE RECORDING ceremony warning; tambah INTERVIEW PANEL RULE — pilih JAWABAN bukan PERTANYAAN*
*Diperbaiki (2026-05-26) — Long-Video Temporal Coverage Fix:*
  - *service.rs: `select_temporally_diverse()` — gantikan pure quality-sort+truncate dengan 2-phase bucket selection: Phase 1 pilih satu clip terbaik dari setiap N time bucket (N=max_clips), Phase 2 isi slot kosong dengan kandidat terbaik dari bucket manapun → **coverage naik dari 9% → ~60-70% video, dead zone 24-menit di akhir video tereliminasi***
  - *service.rs: adaptive `chunk_size_secs` — video >45 min pakai 6-menit chunks (12 chunks) vs sebelumnya 3-menit (29 chunks); konteks LLM per chunk lebih besar, API calls lebih sedikit*
  - *service.rs: adaptive `clips_per_chunk` — >10 chunks = 2 clips/chunk; 6-10 chunks = 3; <6 = max_clips/2. Mencegah flooding kandidat dari early chunks*
  - *service.rs: `clips_overlap_significant()` — gantikan dedup `|start_diff|<10 AND |end_diff|<10` dengan overlap ratio >35%; catches kasus clip_000(357-398s) + clip_001(378-414s) yang share 20s konten tapi lolos check lama*
  - *service.rs: `snap_start_past_fillers()` — advance start_sec melewati run "Ya. Ya. Ya. Oke." di awal clip; waktu clip dishift forward, end_sec dikompensasi*
  - *vocab.rs: tambah "kami/kita membuat episode", "saat podcast ini", dll ke intro keywords → clip_007-like content (episode setup at t=78s) kini terfilter*
*Diperbaiki (2026-05-27) — FFmpeg Drawtext Headline % Rendering Fix (final):*
  - *ffmpeg.rs: `build_headline_filter()` — tambah `:expansion=none` ke setiap `drawtext=` call (social, hl1, hl2, source credit). Root cause: FFmpeg drawtext 2-phase parsing — Phase 1 option parser, Phase 2 text expander. `%` dalam teks (mis. "90% KASUS KORUPSI") masuk Phase 2 sebagai format specifier `%{...}`. Behavior versi-dependent: sebagian FFmpeg versi treat `%%` → `%` (benar), sebagian lain treat `%` + karakter non-`{` → invalid specifier → **seluruh drawtext element di-skip secara silent** → line 1 invisible sementara line 2 (tanpa `%`) tampil normal. Fix sebelumnya (`%%`) tidak cukup karena version-dependent. Fix final: `expansion=none` menonaktifkan Phase 2 sepenuhnya — `%` selalu literal, zero version sensitivity. Sekaligus: hapus `'%' => "%%"` dari `esc()` karena tidak diperlukan lagi.*
*Diperbaiki (2026-05-27) — Headline Quality & Truncation Fix:*
  - *ffmpeg.rs: `wrap_headline()` — `max_chars` 22 → 24 untuk vertical video. Root cause: max_chars=22 menyebabkan last-word drop pada headline valid ≤44 chars (contoh: "INVESTOR TOLAK INVESTASI KARENA RISIKO" 38 chars → line2 "INVESTASI KARENA"=16, +"RISIKO"=23 > 22 → "RISIKO" hilang). Dengan 24: "KARENA RISIKO"=13 ≤ 24 ✓*
  - *service.rs: tambah `sanitize_headline()` dipanggil dari `validate_and_clamp()` — enforce 44-char hard limit dengan word-boundary truncation + warn log; strip surrounding quotes dari LLM output*
  - *prompt.rs: upgrade RULE 4b — tambah "QUOTE FIRST" section dengan contoh konkret (transcript "selamat tinggal, dasar jalang!" → headline bukan "INVESTOR TOLAK INVESTASI KARENA RISIKO"); tambah ⚠️ informal language preservation; tambah pair example ke-4 (verbatim quote vs deskripsi); update char limit wording menjadi "HARD LIMIT: 44 chars — server TRUNCATES if exceeded — words LOST"*
*Ditambahkan (2026-05-27) — Outro Detection Feature:*
  - *vocab.rs: tambah `pub outro: Vec<String>` ke `VocabCache`; `defaults()` kini berisi ~40 keyword outro Indonesia+Inggris (subscribe, jangan lupa, like, terima kasih sudah, sampai jumpa, sampai ketemu, see you next, that's all, see you, bye, wassalamualaikum, dll.); load_from_db() support kategori "outro"*
  - *config.rs: tambah `pub max_clip_end_sec: f64` ke `LlmConfig` (simetris dengan `min_clip_start_sec`); `.set_default("llm.max_clip_end_sec", 0.0)` di builder*
  - *config.toml + config.toml.example: tambah komentar + key `max_clip_end_sec = 0` di blok `[llm]`*
  - *service.rs: tambah 4 fungsi: `detect_outro_start()` (2 sinyal: speech-end-gap ≥8s + first keyword dalam scan window 15%/180s), `detect_speech_end_gap_outro()`, `detect_keyword_outro()`, `inject_outro_marker()`*
  - *service.rs: wiring di `run()` — outro detection setelah intro detection; `inject_outro_marker()` ke compact_lines; `retain()` filter drop momen ≥ outro_start_sec; empty-result guard dengan warn*
  - *service.rs: `analyze_in_chunks()` — signature diperluas +`outro_start_sec: f64`; chunk loop pakai `effective_end = if outro_start_sec > 0.0 { outro_start_sec } else { total_duration }`; `select_temporally_diverse()` dipanggil dengan `effective_end` bukan `total_duration` (bucket boundaries relatif ke konten aktual bukan full video)*
  - *prompt.rs: 3 lokasi diupdate: `build_base_system_prompt()` Hard constraints +2 baris OUTRO marker; `chunk_system_prompt()` +blok OUTRO SKIP; `retry_system_prompt()` +1 baris marker constraint*
*Diperbaiki (2026-05-27) — Outro Detection: Double-Fix (Binary + Logic):*
  - *Root cause run sebelumnya: binary stale (code tidak compile sebelum sesi ini karena `analyze_in_chunks` signature mismatch) → outro detection tidak berjalan sama sekali*
  - *Logic bug: `detect_keyword_outro` menemukan outro di t=1973s ("terima kasih sudah menonton") tapi LLM memilih clip start di t=1961s (12s sebelum boundary) karena host membuka outro dengan "oke terima kasih kalau kalian punya pendapat..." yang bukan keyword*
  - *Fix 1 — vocab.rs: tambah keyword CTA dual-use ke `outro` defaults: "komen di bawah", "komentar di bawah", "silakan komen", "silakan komentar", "tulis di kolom komentar", "di kolom komentar", "bagikan pengalaman", "ceritakan di kolom". Aman di last-15% scan window. Deteksi kini fire di t=~1961s (segment "oke terima kasih kalau kalian punya pendapat... silakan komen di bawah")*
  - *Fix 2 — service.rs: upgrade outro `retain()` filter dengan overlap check — juga drop clip di mana >25% durasi clip jatuh di zona outro. Ini safety net untuk kasus keyword detection terlambat beberapa detik. Failing case: start=1961, end=1981, outro=1973 → overlap=8s/20s=39%>25% → DROPPED*
  - *Fix 3 — vocab.rs: `seed_defaults()` tidak menyeed category "outro" ke Supabase — diperbaiki*
*Satu-satunya gap nyata yang tersisa: Priority 6 — Full Adaptive Trend Learning (auto-pull TikTok Creative Center + YouTube Trending, auto-update style_profiles otomatis).*
