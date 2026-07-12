# THOTH — Context Editing Blueprint

> **Petunjuk penggunaan:** File ini adalah *living document* — status diperbarui setiap ada implementasi baru.
> Selalu sertakan file ini sebagai konteks di setiap sesi kerja pada project THOTH.

---

## Tujuan Sistem

Membangun pipeline otomatis yang memahami **gaya editing media sosial viral** (TikTok/Reels/Shorts) secara end-to-end: dari ingestion video mentah hingga produksi clip yang mengikuti tren editing terkini, dengan bantuan LLM sebagai synthesis engine.

---

## Status Keseluruhan

| Layer | Coverage | Keterangan |
|-------|----------|-----------|
| Ingest + transkrip | ✅ 100% | yt-dlp + Whisper word-level timestamps |
| Visual scoring (post-analysis) | ✅ 80% | Frame extraction + vision LLM scoring |
| LLM synthesis dari teks saja | ✅ 95% | Multi-provider, chunked, trending-aware; **LLM keyword extraction otomatis dari transcript** (gantikan word-frequency approach); `--keywords` CLI jadi optional override |
| Combined audio-visual prompt | ✅ 85% | Full-video frame descriptions diinjeksikan ke transcript (opt-in via `vision.describe_video`) |
| Production metadata (sfx/bgm/style) | ✅ 85% | LLM pilih per clip, auto-discovery katalog |
| **Annotated asset catalog → LLM cues** | ✅ 100% | `scripts/annotate_assets.py` anotasi SFX/meme/font (5-beat + trigger, audio diukur, video via vision); `analyze/asset_catalog.rs` inject ke prompt; schema `asset_cues[]` ber-timestamp diisi LLM + divalidasi. **Render audio**: `build_cue_audio_filter`/`build_delayed_audio_filter` mix multi-SFX (`AssetSfxCue`). **Render video**: `build_meme_overlay_filter` meme PiP di pojok bergilir (`MemeCue`). **Audio meme**: meme bersuara (katalog `has_audio`) di-mix + narasi di-duck 50% di window-nya. **Beat-snap**: at_sec cue di-snap ke beat BGM saat beat_sync. Semua divalidasi via ffmpeg run + frame visual |
| Trend awareness (real-time) | ✅ 70% | Google Trends + keyword scoring |
| **Style Profiles system** | ✅ 100% | `StyleProfile` struct + `StylesConfig` di config.rs; 4 default profiles di config.toml; apply di edit/service.rs |
| **CapCut-style subtitle animation** | ✅ 100% | `SubtitleStyle` enum (Karaoke/CapcutBold/WordPop/MinimalWhite) di subtitle.rs; LLM pilih per clip via `subtitle_style` field |
| **Hook title multi-warna (Beat-1)** | ✅ 100% | `edit/hook_title.rs` generate ASS judul raksasa bertumpuk, tiap kata warna palette, font Montserrat-ExtraBold, animasi pop scale-bounce; di-burn sbg subtitles pass kedua (`AudioOptions.hook_title_ass`); `[hook_title]` config opt-in; divalidasi render+frame visual |
| **Profile card + nama di atas kepala (Beat-2)** | ✅ 100% | `edit/profile_card.rs` render kartu (avatar inisial + nama + @handle + stats) & nama raksasa di atas kepala via drawbox/drawtext (tanpa input/aset); LLM isi `character_name/handle/stats` (schema); `[profile_card]` opt-in; divalidasi render+frame. Stats hanya bila disebut transcript (no fabrikasi). ✅ **Avatar foto ASLI + handle/follower faktual via scout** (`content_profile.json` → override LLM, composite foto via `ImageBadgeCue`) — entry (v) |
| **Callout angka + panah (Beat-3)** | ✅ 100% | `edit/callout.rs` render angka di kotak accent + glyph panah ◀▶▲▼ via drawtext (tanpa aset PNG); LLM isi `callouts[]` (text/at/posisi/arah) di schema; `[callout]` opt-in; divalidasi render+frame visual |
| **Animelorian composite mode** | ✅ 100% | Base kanvas kertas hitam kusut + footage sbg KARTU tengah + montase (cut main↔enrichment) + hook full-frame. `AnimelorianConfig` (`[animelorian]` opt-in); `build_video_filter` branch paper-canvas; `OverlayStyle::FootageCard` + arm di `build_overlay_filter` (enable-window, `shortest=1` utk bound paper loop); enrichment pool drive cutaway card. Divalidasi full-pipeline + frame visual (hook immersive, konten paper+card, montage cut bersih) |
| **Reference video style analyzer** | ✅ 100% | `TrendAnalyzeService` di trend_analyzer.rs; download video → extract frames → vision LLM → synthesize profile → save TOML |
| **Query keyword expansion** | ✅ 100% | LLM analisis raw query → 5-8 keyword pencarian ganda sebelum multi-platform search (mis. "kata asbun ghufron al maqoli" → "ghufron viral","ghufron ceramah","MUI ghufron",..). Memperluas footage + memperkaya enrichment pool → konteks multi-sumber utk narasi rage-bait. `expand_query()` di `src/ingest/query_expand.rs`; `ContentSearchConfig.expand_keywords` (`[content_search]` opt-in, default true); dipanggil di `resolve_query_to_url()` (main.rs) sebelum `search_content()`; graceful fallback ke raw query bila LLM gagal. `src/ingest/query_expand.rs` |
| **Trend-aware editing engine** | ❌ 0% | Full adaptive auto-learning dari TikTok Creative Center + YouTube Trending — belum diimplementasi (Priority 6) |
| RAG / knowledge base viral patterns | ✅ 95% | Supabase pgvector + embedding; store & retrieve moments; inject examples ke prompt; video_title/channel kini diteruskan ke storage |
| Beat-sync audio-visual | ✅ 100% | `beat_detect.rs` BPM dari metadata; SFX snap ke downbeat; BGM ducking; ClipStyle duration = beat subdivision |
| Scene boundary detection | ✅ 100% | `detect_scene_boundaries()` via FFmpeg select filter, opt-in via `vision.scene_detection` |
| **News Enrichment (Stage 4) — Phase 1-6** | ✅ 100% | Keyword extraction + search + screenshot + 9:16 format + video overlay + reaction script (LLM) + TTS (Edge TTS) + static avatar post-roll + SadTalker lip-sync talking avatar (local GPU, tidak butuh API). |
| **Narration cultural-context enrichment** | ✅ 100% | scout `enrich_context.js` decode subteks komentar (references entitas/meme/slang + per-comment context + discourse) → blok `[Konteks Budaya]`/`[Maksud Komentar]` di narasi; web-grounding status terkini (Google News via CDP, `web_grounding.js`); CKB cache di **Supabase** (`ckb.js`, fallback lokal-JSON); narator diinstruksi baca sarkasme & tak menyalahkan netizen. `enrich_context.js`/`web_grounding.js`/`ckb.js`, `pipeline/mod.rs`, `narration/mod.rs`, `ingest/content_search.rs` |
| **Cultural Pulse (trend dari diskursus)** | ✅ 80% | `pulse_harvest.js` (cron harian): scrape komentar feed trending → distilasi term berulang + register gaya bahasa → `ckb_pulse` (recency-decay) → blok `[Tren Diskursus]` + flavor register opsional. Sumber = komentar (discourse), bukan view-index. Pelengkap Priority 6. |

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
| **Visual frame scoring (Vision LLM)** | ✅ Implemented | Frame → Gemini/Claude/OpenAI/Novita/OpenRouter/vLLM → skor humor, visual_impact, novelty, engagement (0-10) | `src/analyze/vision.rs` |
| **Multi-provider vision support** | ✅ Implemented | Gemini, OpenAI, Claude, Novita, OpenRouter (OpenAI-compat), vLLM (multimodal). `vision_active` whitelist di `service.rs` gates rerank+describe — Novita/OpenRouter kini termasuk (sebelumnya excluded → vision dead di config default) | `src/analyze/vision.rs`, `src/analyze/service.rs` |
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
| **Editing style fingerprinting** | ✅ Implemented | `TrendAnalyzeService` — download trending videos → extract frames → vision LLM → `StyleProfile` JSON; simpan ke `style_profiles/` folder via `THOTH trend-analyze` | `src/analyze/trend_analyzer.rs` |

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
Tren editing TikTok/Reels bergerak cepat. Tools yang hardcode gaya editing akan ketinggalan dalam 2 minggu. THOTH perlu sistem yang bisa di-update mengikuti tren tanpa harus recompile.

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
THOTH trend-analyze \
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
**Impact: Sangat Tinggi jangka panjang** — THOTH belajar sendiri dari tren terkini

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

Render Engine (THOTH saat ini):
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

**✅ SEBAGIAN TERIMPLEMENTASI (2026-06-27) — pendekatan DISKURSUS, bukan view-index:**
Alih-alih menarik index tren platform (TikTok Creative Center dst.) yang dikurasi algoritma, THOTH kini
memanen tren dari **apa yang warganet TULIS** di feed yang sudah ditemukannya sendiri. `scout/pulse_harvest.js`
(cron harian): scan `reel_topics.json` → scrape komentar berbudget → distilasi LLM term berulang (lintas
≥N video) + snapshot register gaya bahasa → simpan ke **CKB Supabase** `ckb_pulse` dengan recency-decay
(`exp(-age/τ)`) + TTL-prune. Disuntik ke narasi sbg `[Tren Diskursus]` (referensi gaya, bukan dipaksakan).
Detail desain: `RESEARCH_context_enrichment_narration.md` (Fase 3–4).
**Sisa Priority 6 yang BELUM:** auto-pull style-fingerprint VISUAL dari video trending (frame→vision→
update `style_profiles/` otomatis) — pulse saat ini fokus DISKURSUS/teks, belum gaya editing visual.

---

## News Enrichment Pipeline (Stage 4) — Status per Phase

Rencana lengkap: lihat `PLAN_REACT_NEWS_PIPELINE.md`. Pipeline baru menyisipkan
**Stage 4 (Enrich)** di antara Analyze (3) dan Edit (5). Prinsip utama: **semua
keyword pencarian berita berasal dari transcript yang diucapkan tiap moment**,
bukan dari field `title`/`reason` hasil paraphrase LLM.

| Komponen | Status | Implementasi | File |
|----------|--------|--------------|------|
| **NewsConfig + `[news]` section** | ✅ Done | Struct `NewsConfig` (provider, region, threshold, dll) + default + config.toml/.example | `src/config.rs`, `config.toml` |
| **Keyword extraction dari transcript** | ✅ Done | `extract_keywords()` — LLM baca `transcript_window` (via `words_starting_in`) → 3-5 query; parser toleran (JSON/fence/line fallback) + dedup | `src/news/keyword.rs` |
| **Internet search (Playwright)** | ✅ Done | Subprocess Python + Playwright (Bing News + fallback Google), 1 browser per moment (batched queries), tanpa API key | `src/news/search.rs`, `scripts/news_search.py` |
| **Internet search (Serper fallback)** | ✅ Done | `search_serper()` via `THOTH_SERPER_API_KEY` jika `provider = "serper"` | `src/news/search.rs` |
| **Dedup + relevance scoring + ranking** | ✅ Done | `dedup_by_url`, `score_relevance` (overlap 0.6 + freshness 0.25 + source 0.15), `within_max_age`, filter threshold, sort, truncate | `src/news/search.rs` |
| **EnrichService (orchestrasi Stage 4)** | ✅ Done | Sequential per moment, simpan `enrich/enrich.json`, best-effort (gagal tidak menggagalkan pipeline) | `src/news/service.rs`, `src/pipeline/mod.rs` |
| **EnrichResult di pipeline state** | ✅ Done | `StageResults.enrich: Option<EnrichResult>` (serde default, resumable) | `src/pipeline/state.rs` |
| **LLM provider factory (shared)** | ✅ Done | `build_llm_provider()` di-extract agar reusable oleh analyze + news | `src/analyze/provider/mod.rs` |
| **Conda env setup** | ✅ Done | `environment.yml`, `scripts/setup_THOTH_news.bat`, `conda_env` field di `NewsConfig`; command builder `util::python_command()` | `src/news/util.rs`, `config.rs` |
| **Headless screenshot berita (Phase 2)** | ✅ Done | `scraper::screenshot()` — subprocess `news_screenshot.py` (Playwright, popup cleanup JS, text extraction, graceful degrade); `scraper::ScreenshotResult` | `src/news/scraper.rs`, `scripts/news_screenshot.py` |
| **Screenshot 9:16 formatter (Phase 2)** | ✅ Done | `formatter::format_screenshot()` — FFmpeg `filter_complex` pillar-box (blur bg + scale overlay + drawtext caption source/date/headline); `escape_text`, `truncate_text` | `src/news/formatter.rs` |
| **News overlay di video (Phase 3)** | ✅ Done | `ImageOverlaySpec` (path, at_sec, dur, ken_burns) + `build_news_image_filter()` (FFmpeg fade-in/out + Ken Burns zoompan) + `enrich_data` loading + `audio_clone.news_overlay` per clip | `src/edit/ffmpeg.rs`, `src/edit/service.rs` |
| **Reaction script + TTS (Phase 4)** | ✅ Done | `src/reaction/` (model, script, tts, error, mod); LLM script generator; **5 TTS providers**: Edge (free), **MiniMax Speech 2.8 HD Sync** (recommended), **Fish Audio S2 Pro**, OpenAI, ElevenLabs; hex decode untuk MiniMax audio; binary streaming untuk Fish Audio; 3 unit tests decode_hex | `src/reaction/`, `src/config.rs` |
| **Static avatar + post-roll (Phase 5)** | ✅ Done | `src/reaction/avatar.rs`: `create_avatar_segment()` — FFmpeg bg (news screenshot / dark color) + optional PNG avatar PiP + TTS audio → MP4 segment; `concat_post_roll()` di `edit/ffmpeg.rs`; wired ke EnrichService (avatar segment) + EditService (post-roll concat) | `src/reaction/avatar.rs`, `src/edit/ffmpeg.rs`, `src/edit/service.rs` |
| **Local talking avatar — SadTalker (Phase 6)** | ✅ Done | `AvatarMode::SadTalker` di config; `create_sadtalker_segment()` di avatar.rs; `scripts/sadtalker_generate.py` wrapper SadTalker inference.py; `scripts/setup_sadtalker.bat` clone+install+model; conda env `THOTH-sadtalker` terpisah dari `THOTH-news` | `src/reaction/avatar.rs`, `src/config.rs`, `scripts/` |

**Cara mengaktifkan Phase 1:**
```toml
[news]
enabled = true
provider = "playwright"   # butuh: pip install playwright && python -m playwright install chromium
```
Output: `output/.THOTH/<job>/enrich/enrich.json` berisi `extracted_keywords` + `news[]` (URL + relevance_score) per moment.

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
.env             — API keys (THOTH_*_API_KEY)
assets/          — semua media asset terpusat:
  ├ fonts/       — font files (Poppins auto-download, Montserrat-ExtraBold)
  ├ sfx/         — SFX files (auto-discovery by keyword)
  ├ bgm/         — BGM files (auto-discovery by keyword)
  ├ ui/          — grafis UI (arrow, kartu profil/komentar)
  ├ meme/        — template meme
  ├ asset_catalog.json — anotasi penempatan aset (5-beat) untuk LLM
  └ ASSET_CATALOG.md   — versi human-readable
footage_cache/   — Downloaded TikTok footage clips (cached by query hash)
models/          — Whisper GGML model files
output/          — Pipeline output (job artifacts)
```

### Struktur Output Per Job
```
output/.THOTH/{job_id}/
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

## Change History

Detailed change history and the engineering dev-journal now live in **[CHANGELOG.md](CHANGELOG.md)**.
This blueprint tracks **architecture** and **implementation status** only (the tables and roadmap above).

> **Policy:** when you make any change, log it in `CHANGELOG.md` — **not** here. Update this file only when an
> implementation **status** flips (❌ → ⚠️ / ✅) or the architecture itself changes.

*Last updated: 2026-07-12 — dev-journal migrated to CHANGELOG.md; per policy, change detail is now logged there.*
