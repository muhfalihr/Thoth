# PLAN: Reaction + News-Inject Pipeline
> Status: **Phase 1 IMPLEMENTED ✅** (keyword extraction + internet search) · Phase 2-6 belum  
> Dibuat: 2026-05-31  
> Revisi: 2026-05-31 (koreksi alur keyword extraction dari transcript)  
> Implementasi: 2026-05-31 (Phase 1 — internet search via Python Playwright, bukan Serper berbayar)  
> Prioritas: High (kelanjutan roadmap Thoth)
>
> **Context:** Dokumen ini adalah rencana Phase berikutnya. Pipeline dasar sudah selesai:
> - Stage 1–4 (Ingest, Transcribe, Analyze, Edit) ✅ implemented
> - GPU pipeline (wgpu ColorPipeline + TransitionPipeline, 21 transitions) ✅ implemented
> - `src/edit/color.rs` (ColorGrading, 8 mood presets, to_gpu_params()) ✅ implemented
> - `src/edit/transition.rs` (Transition enum, concat_with_transitions, 40+ xfade) ✅ implemented
> - `src/gpu/` (context, effect, processor, shaders/color.wgsl, shaders/transition.wgsl) ✅ implemented
> - GPU wired ke service.rs (color grading + concat_output mode) ✅ implemented
> - config.toml: `[gpu]` section, `color_mood`/`gpu_transition` di StyleProfile ✅ implemented
> - schema.rs: `ViralMoment.color_mood`, `ViralMoment.gpu_transition` ✅ implemented

---

## ⚠️ Prinsip Utama Pipeline Ini

**Semua keyword pencarian berita BERASAL dari transcript video yang sedang diproses.**

Bukan dari user input, bukan dari metadata ViralMoment, bukan dari tebakan LLM umum.

Alurnya:
```
Transcript (word timestamps)
    → Analyze: temukan moment/hook
    → Keyword Extraction: LLM baca teks transcript window moment → hasilkan 3-5 keyword
    → Internet Search: cari berita/konten dengan keyword tersebut
    → Screenshot: tangkap halaman berita
    → Reaction: avatar mereact moment + konteks berita
```

**Contoh konkret** (dari video "Prabowo Bilang Orang Desa Gak Pake Dollar"):
```
Transcript moment (30s–52s):
  "...orang desa itu gak pake dollar, mereka beli beras, beli tempe,
   minta kendaraan ya yang ada kacanya, itu artinya mobil..."

Keyword yang diekstrak:
  1. "Prabowo orang desa tidak pakai dollar"
  2. "Prabowo minta mobil berkaca"
  3. "pernyataan Prabowo ekonomi rakyat desa"
  4. "Prabowo kontroversi komentar kemiskinan"
  5. "daya beli masyarakat desa Indonesia 2025"

→ Cari 5 keyword ini di internet → ambil berita paling relevan → screenshot → overlay
```

---

## 1. Ringkasan Eksekutif

### Apa yang Diinginkan

Transformasi Thoth dari **clip extractor** menjadi **full production pipeline** yang:

1. **Ekstrak keyword dari transcript** — LLM baca teks transcript setiap moment, hasilkan 3-5 keyword spesifik yang mencerminkan inti kontroversial/menarik dari statement tersebut
2. **Cari berita di internet** menggunakan keyword dari transcript, bukan query manual
3. **Screenshot berita** menggunakan headless browser dan menjadikannya overlay/sisipan video
4. **Hasilkan reaksi avatar** — karakter virtual dengan suara TTS yang mereact konten moment + konteks berita
5. **Sisipkan semua aset** ke dalam clip final dengan timing yang tepat

**Target output:** Shorts/Reels bergaya reaction content — clip utama + berita terkait sebagai visual context + avatar commentary — seperti contoh: *"Prabowo Bilang Orang Desa Gak Pake Dollar dan Minta Mobil Pake Kaca"*

### Apa yang Berubah dari Pipeline Lama

```
LAMA:  Ingest → Transcribe → Analyze → Edit (cut + subtitle + overlay B-roll)

BARU:  Ingest → Transcribe → Analyze → [Enrich] → Enhanced Edit
                                              │
                    ┌─────────────────────────┤
                    │                         │
              Keyword Extract           Reaction Gen
              (dari transcript)         (Script → TTS → Avatar)
                    │
              Internet Search
              (per keyword, paralel)
                    │
              Screenshot Berita
                    │
              Format ke 9:16
```

### Fitur Kunci yang Dibuat

| Fitur | Deskripsi |
|---|---|
| **News Spider** | Cari berita relevan di internet berdasarkan keywords dari moment |
| **Headless Screenshot** | Buka URL berita, bersihkan popup, screenshot, crop ke 9:16 |
| **News Context Extraction** | Ambil headline + summary dari artikel untuk context LLM |
| **Reaction Script Generator** | LLM generate script reaksi berdasarkan moment + berita |
| **TTS Voice Synthesis** | Convert script ke audio MP3 (ElevenLabs / OpenAI / lokal) |
| **Avatar Animator** | Generate video talking avatar lip-synced ke TTS audio |
| **Enhanced Compositor** | FFmpeg pipeline baru yang handle news screenshot + avatar overlay |

---

## 2. Arsitektur Pipeline Baru

### Alur Lengkap

```
URL
 │
 ▼
┌─────────────────────────────────────────┐
│ Stage 1: INGEST                          │
│  yt-dlp → video.mp4 + metadata          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Stage 2: TRANSCRIBE                      │
│  Whisper CUDA/Groq → transcript.json    │
│  (word-level timestamps)                │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Stage 3: ANALYZE                         │
│  LLM pilih ViralMoment[]                │
│  (setiap moment punya: start_sec,        │
│   end_sec, hook, viral_type, dst.)      │
│  → moments.json                         │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐  ← BARU
│ Stage 4: ENRICH (paralel per moment)    │
│                                         │
│  4a. KEYWORD EXTRACTION  ← KUNCI        │
│      Input: teks transcript[start..end] │
│      LLM: "extract 3-5 search keywords" │
│      Output: keywords[] per moment      │
│      Contoh:                            │
│       "Prabowo orang desa dollar"       │
│       "pernyataan Prabowo kemiskinan"   │
│       "kontroversi Prabowo 2025"        │
│                                         │
│  4b. INTERNET SEARCH (paralel)          │
│      → search setiap keyword            │
│      → aggregate + deduplicate          │
│      → rank by relevance score          │
│      → NewsItem[] (URL + headline)      │
│                                         │
│  4c. SCREENSHOT BERITA (per URL)        │
│      → headless Chrome                  │
│      → cleanup cookie/popup             │
│      → screenshot.png                   │
│      → format ke 9:16 + caption         │
│                                         │
│  4d. REACTION SCRIPT (LLM)             │
│      Input: transcript_text + news[]    │
│      → script teks reaksi per moment    │
│                                         │
│  4e. TTS SYNTHESIS                      │
│      → reaction_audio.mp3 per moment    │
│                                         │
│  4f. AVATAR ANIMATION (opsional)        │
│      → avatar_clip.mp4 per moment       │
│                                         │
│  → enrich.json                          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐  ← DIPERBARUI
│ Stage 5: EDIT (Enhanced)                │
│  Per clip:                              │
│  ├── Cut + snap boundaries              │
│  ├── Subtitle ASS generation            │
│  ├── SFX/BGM catalog pick               │
│  ├── News screenshot compositor         │
│  │   (Ken Burns / slide-in animation)   │
│  ├── B-roll overlay (existing)          │
│  ├── Reaction avatar insert             │
│  │   (pre-roll atau post-roll)          │
│  └── FFmpeg final encode                │
│       → clip_NNN_<slug>.mp4             │
└─────────────────────────────────────────┘
```

### Struktur Direktori Baru

```
src/
├── news/
│   ├── mod.rs           ← public API: NewsService
│   ├── keyword.rs       ← LLM extract keywords dari transcript window (BARU, KUNCI)
│   ├── search.rs        ← search per keyword via API (Serper/NewsAPI/Bing)
│   ├── scraper.rs       ← headless Chrome: screenshot + text extraction
│   ├── formatter.rs     ← format screenshot ke 9:16, tambah caption overlay
│   └── model.rs         ← struct NewsItem, NewsEnrichment
│
├── reaction/
│   ├── mod.rs           ← public API: ReactionService
│   ├── script.rs        ← LLM generate reaction script
│   ├── tts.rs           ← TTS synthesis (ElevenLabs/OpenAI/local)
│   ├── avatar.rs        ← avatar video generation (D-ID/HeyGen/static)
│   └── model.rs         ← struct ReactionScript, AvatarClip
│
├── edit/
│   ├── service.rs       ← PERBARUI: integrate EnrichResult
│   ├── ffmpeg.rs        ← PERBARUI: tambah news compositor + avatar compositor
│   ├── overlay.rs       ← PERBARUI: tambah ImageOverlay (untuk screenshot)
│   ├── subtitle.rs      ← tidak berubah
│   └── sfx.rs           ← tidak berubah
│
└── pipeline/
    ├── mod.rs           ← PERBARUI: tambah Stage 4 Enrich
    └── state.rs         ← PERBARUI: tambah EnrichResult ke StageResults
```

### Output per Job

```
output/.thoth/<job_id>/
├── state.json
├── source/video.mp4
├── transcribe/transcript.json
├── analyze/moments.json
├── enrich/                          ← BARU
│   ├── enrich.json                  ← semua enrich data per moment index
│   ├── news/
│   │   ├── moment_0/
│   │   │   ├── news_0.json          ← metadata berita
│   │   │   ├── screenshot_0.png     ← screenshot mentah
│   │   │   └── screenshot_0_formatted.png  ← 9:16 + caption
│   │   └── moment_1/...
│   └── reaction/
│       ├── moment_0/
│       │   ├── script.txt           ← teks reaksi
│       │   ├── voice.mp3            ← TTS audio
│       │   └── avatar.mp4           ← avatar video (jika ada)
│       └── moment_1/...
└── clips/
    ├── clip_001_<slug>.mp4
    └── ...
```

---

## 3. Modul Baru: News

### 3.1 `src/news/model.rs` — Data Structures

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsItem {
    /// URL artikel berita
    pub url: String,
    /// Judul artikel
    pub title: String,
    /// Summary/lead paragraph (maks 3 kalimat)
    pub summary: String,
    /// Sumber (contoh: "CNN Indonesia", "Kompas")
    pub source: String,
    /// Tanggal publikasi (RFC3339)
    pub published_at: Option<String>,
    /// Keyword yang menghasilkan artikel ini
    pub matched_keyword: String,
    /// Skor relevansi 0.0–1.0 terhadap moment
    pub relevance_score: f32,
    /// Path ke screenshot mentah (setelah scraping)
    pub screenshot_path: Option<PathBuf>,
    /// Path ke screenshot formatted (9:16, sudah ada caption)
    pub formatted_screenshot_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MomentEnrichment {
    /// Index ke ViralMoment dalam moments.json
    pub moment_index: usize,
    /// Teks transcript mentah dari window waktu moment ini
    /// Ini adalah INPUT untuk keyword extraction — bukan field ViralMoment
    pub transcript_window: String,
    /// Keywords yang diekstrak LLM dari transcript_window
    /// Setiap keyword menjadi 1 query pencarian berita
    pub extracted_keywords: Vec<String>,
    /// Daftar berita yang ditemukan (diurutkan berdasarkan relevance)
    pub news: Vec<NewsItem>,
    /// Script reaksi yang dihasilkan LLM
    pub reaction_script: Option<ReactionScript>,
    /// Path ke file audio TTS
    pub tts_audio_path: Option<PathBuf>,
    /// Path ke video avatar (jika avatar generation diaktifkan)
    pub avatar_video_path: Option<PathBuf>,
}
```

### 3.2 `src/news/keyword.rs` — Keyword Extraction dari Transcript ← BARU

**Ini adalah step paling penting.** Keywords TIDAK diambil dari field ViralMoment (`title`, `reason`, dll). Keywords diekstrak langsung dari **raw teks transcript** pada window waktu moment tersebut.

**Mengapa dari transcript, bukan dari ViralMoment fields?**

- `title` di ViralMoment sudah di-paraphrase LLM untuk kebutuhan clickbait — kurang tepat untuk keyword search
- `reason` bersifat analitik, bukan substansi ucapan
- Transcript mentah berisi **apa yang benar-benar diucapkan** — lebih akurat untuk mencari berita yang relevan dengan statement tersebut

**Proses ekstraksi:**

```
transcript.json
    │
    ├── Ambil words_starting_in(moment.start_sec, moment.end_sec)
    │   dari Transcript struct (sudah ada di codebase)
    │
    ├── Join jadi satu string: transcript_window
    │   Contoh: "orang desa itu gak pake dollar mereka beli beras beli
    │            tempe minta kendaraan ya yang ada kacanya itu artinya mobil"
    │
    └── Kirim ke LLM dengan prompt keyword extraction
```

**LLM Prompt untuk Keyword Extraction:**

```
Kamu adalah search engine specialist. Baca teks berikut yang diucapkan dalam video:

"{transcript_window}"

Konteks video: "{video_title}" oleh "{video_channel}"

Ekstrak 3-5 query pencarian yang paling efektif untuk menemukan berita atau artikel
berita Indonesia yang relevan dengan statement ini.

Aturan:
- Setiap query adalah string pendek (3-6 kata) yang bisa langsung diketik di Google
- Prioritaskan aspek yang kontroversial, mengejutkan, atau newsworthy
- Gunakan nama orang/tokoh jika disebutkan dalam teks
- Gunakan tahun jika konteks waktu relevan
- Jangan duplikasi — setiap query harus cari angle yang berbeda
- Bahasa: Indonesia (boleh mix dengan istilah yang umum dipakai media)

Output JSON array saja, tanpa penjelasan:
["query 1", "query 2", "query 3", "query 4", "query 5"]
```

**Contoh input/output:**

Input transcript: *"orang desa itu gak pake dollar mereka beli beras beli tempe minta kendaraan ya yang ada kacanya"*

Output keywords:
```json
[
  "Prabowo orang desa tidak pakai dollar",
  "Prabowo minta mobil berkaca rakyat desa",
  "pernyataan Prabowo kemiskinan desa 2025",
  "kontroversi Prabowo komentar ekonomi rakyat",
  "daya beli masyarakat desa Indonesia"
]
```

**Implementasi Rust:**

```rust
pub async fn extract_keywords(
    transcript_window: &str,
    video_title: &str,
    video_channel: &str,
    llm_client: &dyn LlmClient,
) -> Result<Vec<String>> {
    let prompt = build_keyword_prompt(transcript_window, video_title, video_channel);
    let response = llm_client.complete(&prompt).await?;
    // Parse JSON array dari response
    let keywords: Vec<String> = serde_json::from_str(&response.trim())?;
    Ok(keywords.into_iter().take(5).collect())
}
```

### 3.3 `src/news/search.rs` — Internet Search per Keyword

Setiap keyword dari hasil ekstraksi menjadi **satu pencarian terpisah**. Semua pencarian dijalankan **paralel** lalu hasilnya digabung dan deduplikasi.

**Provider yang didukung:**

| Provider | Gratis? | Kualitas | Keterangan |
|---|---|---|---|
| **Serper.dev** | 2500 req/bulan gratis | Sangat baik | Google News + Google Search via API JSON |
| **NewsAPI.org** | 100 req/hari gratis | Baik | Khusus berita, free tier untuk dev |
| **Bing News Search** | Azure credits | Baik | Microsoft, news-focused |
| **DuckDuckGo Lite** | Gratis, no key | Terbatas | Fallback scraping |

**Alur search per moment:**

```
extracted_keywords: ["kw1", "kw2", "kw3", "kw4", "kw5"]
      │
      ▼ (paralel — semua sekaligus)
┌─────────────────────────────────────────────┐
│ search("kw1") │ search("kw2") │ search("kw3") │ ...
└─────────────────────────────────────────────┘
      │
      ▼
Aggregate semua hasil → Vec<RawResult>
      │
      ▼
Deduplikasi by URL
      │
      ▼
Relevance scoring per artikel:
  - keyword overlap dengan transcript_window
  - tanggal publikasi (lebih baru = lebih tinggi)
  - source credibility (Kompas/CNN > blog)
  - filter: relevance_score >= threshold (config: 0.5)
      │
      ▼
Sort by relevance DESC → top N → NewsItem[]
```

**Search request ke Serper:**

```rust
// POST https://google.serper.dev/news
// Body: { "q": keyword, "gl": "id", "hl": "id", "num": 5 }
// Headers: X-API-KEY: {SERPER_API_KEY}
```

**Relevance scoring:**

```rust
fn score_relevance(article: &RawResult, transcript_window: &str) -> f32 {
    let keyword_overlap = word_overlap_ratio(&article.title, transcript_window);
    let freshness_score = days_ago_score(article.published_at);
    let source_score = source_credibility_score(&article.source);
    
    // Bobot: keyword match paling penting, freshness secondary
    keyword_overlap * 0.60 + freshness_score * 0.25 + source_score * 0.15
}
```

### 3.3 `src/news/scraper.rs` — Headless Browser Screenshot

**Strategy:** Gunakan `chromium --headless` via subprocess (tidak perlu binding Rust).

```
chromium --headless \
  --screenshot=screenshot.png \
  --window-size=1200,900 \
  --disable-notifications \
  --disable-extensions \
  --no-sandbox \
  --hide-scrollbars \
  --disable-popup-blocking \
  --run-all-compositor-stages-before-draw \
  https://news.example.com/article
```

**Alur scraping:**

```
URL
 │
 ├── Check robots.txt (respect crawl-delay)
 │
 ├── Run headless Chrome (timeout: config.news.screenshot_timeout_secs)
 │
 ├── Inject cleanup JS (sebelum screenshot):
 │   - Hapus cookie banners (element.remove() untuk class umum)
 │   - Hapus popup/overlay
 │   - Scroll ke article content
 │   - Tunggu lazy-load images
 │
 ├── Screenshot → screenshot.png (1200×900)
 │
 └── Extract clean text:
     - readability via `chromium --dump-dom` + parsing
     - ATAU: reqwest + scraper crate (html parser)
     - Ambil: judul H1, lead paragraph, author, date
```

**Cookie banner removal JS injection:**

```javascript
// Common cookie banner selectors
const selectors = [
  '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
  '[id*="cookie"]', '[id*="modal"]', '[class*="popup"]',
  '.overlay', '#overlay', '[class*="newsletter"]'
];
selectors.forEach(sel => {
  document.querySelectorAll(sel).forEach(el => el.remove());
});
document.body.style.overflow = 'visible';
```

**Chrome binary detection:**

```rust
fn find_chrome() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Users\{user}\AppData\Local\Google\Chrome\Application\chrome.exe",
    ];
    candidates.iter().map(PathBuf::from).find(|p| p.exists())
}
```

**Fallback jika Chrome tidak ada:** Skip screenshot, gunakan text-only dari reqwest + html parsing.

### 3.4 `src/news/formatter.rs` — Screenshot Formatting

Screenshot mentah (1200×900 landscape) harus diformat ke 9:16 (1080×1920) untuk video portrait.

**Strategi formatting:**

```
screenshot.png (1200×900)
      │
      ├── Opsi A: Pillar Box Style
      │   - Scale screenshot ke width 1080
      │   - Tambah background blur (full blur dari screenshot asli)
      │   - Tempelkan screenshot di tengah vertikal
      │   - Tambah gradient overlay di atas/bawah
      │
      └── Opsi B: Full Crop + Zoom
          - Crop ke 1080×607 (bagian atas artikel)
          - Scale vertikal ke 1920 dengan blur background
          - Ken Burns zoom animation untuk video
```

**Caption overlay di atas screenshot:**

```
┌────────────────────────────────────┐
│ 📰 CNN INDONESIA  •  2 jam lalu    │  ← Source + waktu
├────────────────────────────────────┤
│                                    │
│   [SCREENSHOT ARTIKEL]             │
│                                    │
├────────────────────────────────────┤
│  "Judul artikel dipotong jika...   │  ← Headline
│   terlalu panjang disini"          │
└────────────────────────────────────┘
```

FFmpeg command untuk format:

```
ffmpeg -i screenshot.png -i blur_bg.png \
  -filter_complex "[1]scale=1080:1920[bg];
                   [0]scale=1080:-1[ss];
                   [bg][ss]overlay=0:(1920-h)/3,
                   drawtext=..." \
  formatted.png
```

---

## 4. Modul Baru: Reaction

### 4.1 `src/reaction/script.rs` — LLM Reaction Script Generation

**Input ke LLM:**

```
Kamu adalah host/kreator konten Indonesia yang energetik dan jujur.
Kamu sedang mereact video tentang: {video_title}

Moment yang sedang direact (transcript):
"{moment_text}"

Berita terkait yang ditemukan:
1. {news_headline_1} - {news_summary_1}
2. {news_headline_2} - {news_summary_2}

Viral type: {viral_type}
Emotional trigger: {emotional_trigger}
Energy: {energy}

Tulis script reaksi natural (15-25 detik) yang:
- Langsung ke point (tidak basa-basi)
- Ekspresikan reaksi jujur sesuai emotional_trigger
- Hubungkan dengan berita terkait jika relevan
- Akhiri dengan pertanyaan/ajakan ke penonton
- Bahasa: {language} (informal, bukan formal)
- Tone: sesuai viral_type ({tone_guide})

Output JSON:
{
  "script": "teks reaksi...",
  "tone": "shocked|informative|amused|concerned|amazed",
  "duration_estimate_secs": 20,
  "suggested_avatar_expression": "surprised|serious|laughing|concerned|nodding"
}
```

**Tone guide berdasarkan viral_type:**

| Viral Type | Tone | Contoh Pembuka |
|---|---|---|
| `controversy` | shocked/concerned | "Tunggu, ini beneran?! Jadi..." |
| `educational_shock` | amazed/informative | "Nah ini yang banyak orang gak tau..." |
| `transformation` | amazed/inspired | "Gila ya, bayangin dari..." |
| `actionable` | enthusiastic | "Oke ini penting banget, dengerin..." |
| `relatable` | amused | "Hahaha ini gue banget, soalnya..." |
| `blueprint` | informative | "Jadi step-nya tuh gini..." |

### 4.2 `src/reaction/tts.rs` — Text-to-Speech

**Provider yang didukung:**

| Provider | Kualitas | Bahasa ID? | Biaya | Keterangan |
|---|---|---|---|---|
| **ElevenLabs** | ★★★★★ | Ya (multilingual v2) | $5/bulan (30k chars) | Paling natural |
| **OpenAI TTS** | ★★★★ | Ya | $15/1M chars | Cepat, stabil |
| **Google Cloud TTS** | ★★★★ | Ya (WaveNet) | $16/1M chars | Neural voices |
| **Kokoro (lokal)** | ★★★ | Terbatas | Gratis | Model Rust/ONNX |
| **Edge TTS** | ★★★ | Ya | Gratis | Microsoft Edge |

**Implementasi:**

```rust
pub enum TtsProvider {
    ElevenLabs { api_key: String, voice_id: String, model_id: String },
    OpenAI { api_key: String, voice: String },  // alloy/nova/shimmer/etc
    Google { credentials_path: PathBuf, voice_name: String },
    EdgeTts { voice: String },  // id-ID-ArdiNeural / id-ID-GadisNeural
    Local { model_path: PathBuf },
}
```

**Rekomendasi untuk bahasa Indonesia:**
- ElevenLabs dengan `eleven_multilingual_v2` → paling natural
- Microsoft Edge TTS `id-ID-ArdiNeural` → gratis, cukup baik
- OpenAI TTS `nova` → natural tapi aksen agak English

**Output:** `voice.mp3` per moment, durasi sesuai script (~15-25 detik)

### 4.3 `src/reaction/avatar.rs` — Avatar Video Generation

**3 mode yang didukung:**

#### Mode 1: Static Avatar (paling mudah, no API)
- Gunakan foto/gambar avatar (PNG dengan transparansi)
- Render sebagai PiP di pojok layar
- Audio TTS tetap terdengar
- **Tidak ada lip-sync** — sederhana tapi efektif

```
[MAIN VIDEO]        [MAIN VIDEO]
                    ┌──────────┐
                    │  AVATAR  │ ← gambar statis + audio
                    │   PNG    │
                    └──────────┘
```

#### Mode 2: Talking Avatar via D-ID API
- Input: foto avatar (1 gambar) + audio MP3
- D-ID generate video talking head dengan lip-sync
- Output: MP4 ~720p
- Biaya: ~$0.10 per video (D-ID Lite: $0/5 credits, Basic: $7/month)

```
foto_avatar.png + voice.mp3
         │
         ▼
POST /talks (D-ID API)
         │
         ▼
avatar_talking.mp4 (720p, ~15-25 detik)
```

#### Mode 3: Talking Avatar via HeyGen
- Lebih realistis dari D-ID
- Bisa pilih preset avatar atau upload sendiri
- Biaya lebih tinggi ($29/bulan)

**Avatar positioning dalam clip:**

```
Pilihan 1: PRE-ROLL
[avatar reaksi 15-25s] + [main clip 30-60s]

Pilihan 2: POST-ROLL  
[main clip 30-60s] + [avatar reaksi 15-25s]

Pilihan 3: SIDE-BY-SIDE (split screen)
[avatar di kanan bawah] overlay saat main clip main

Pilihan 4: INSERT di tengah
[main clip bagian 1] + [avatar interlude] + [main clip bagian 2]
→ Hanya untuk clips yang punya "natural break" di tengah
```

**Rekomendasi default:** POST-ROLL untuk pertama kali — paling aman, tidak ganggu konten utama.

---

## 5. Perubahan pada Edit Stage

### 5.1 Enhanced `OverlaySpec` — Tambah Static Image

```rust
pub enum OverlaySource {
    /// Video file (existing)
    Video(PathBuf),
    /// Static image (news screenshot, thumbnail, etc) — BARU
    Image {
        path: PathBuf,
        /// Ken Burns: slow zoom selama duration_sec
        ken_burns: bool,
        /// Slide-in dari arah tertentu (optional)
        slide_in: Option<SlideDirection>,
    },
}

pub enum SlideDirection { Left, Right, Bottom }
```

### 5.2 Timing Strategy untuk News Insert

News screenshot muncul **setelah hook** (detik 2-4 clip) dan berlangsung **3-5 detik**:

```
Clip timeline:
0s ─────── 2s ──────── 6s ──────── [end]
 │ HOOK     │ NEWS SS  │  CONTENT  │
 │ (utama)  │ (overlay)│  (utama)  │
```

Logika timing:
```rust
let news_start_sec = 2.0_f64;                    // setelah 2 detik
let news_duration  = config.news.display_secs;   // default: 4.0
let news_end_sec   = news_start_sec + news_duration;
// Hanya tampilkan jika clip cukup panjang untuk menampung
if clip_duration_secs > news_end_sec + 3.0 {
    insert_news_overlay(at: news_start_sec, for: news_duration);
}
```

### 5.3 FFmpeg Filter Chain Baru

Sebelum (existing):
```
[video][subtitle][overlay_video] → final.mp4
```

Setelah (enhanced):
```
[video]
  ├── [subtitle]           (burn karaoke text)
  ├── [headline_panel]     (lower-third)
  ├── [news_screenshot]    (pillar-box image, Ken Burns, at t=2s)
  ├── [b_roll_overlay]     (existing — TikTok B-roll)
  └── [avatar_pip]         (post-roll append ATAU corner PiP)
         │
         ▼
   [audio_mix]
     ├── main audio (original)
     ├── sfx (transient hits)
     ├── bgm (ducked background)
     └── tts_voice (avatar speaking, duck main audio during reaction)
         │
         ▼
   final_clip.mp4
```

**Audio ducking saat avatar bicara:**

```
Saat avatar video (post-roll):
  - main clip audio: FADE OUT di 0.5s terakhir
  - tts voice: FADE IN pada awal avatar segment
  - bgm: berlanjut di volume 30%

Saat news screenshot overlay (in-clip):
  - tidak ada audio perubahan (berita tidak bersuara)
  - bisa tambah subtle "news ding" SFX
```

---

## 6. Perubahan Config (`config.toml`)

```toml
# ─── News Module ──────────────────────────────────────────────────────
[news]
# Aktifkan/matikan seluruh modul news
enabled = false   # default off sampai API key dikonfigurasi

# Provider pencarian berita
# Pilihan: "serper" | "newsapi" | "bing" | "ddg"
provider = "serper"

# Dari .env: NEWS_SEARCH_API_KEY
# serper: SERPER_API_KEY
# newsapi: NEWSAPI_KEY  
# bing: BING_SEARCH_API_KEY

# Jumlah hasil berita per moment (lebih banyak = lebih relevan tapi lebih lambat)
max_results_per_moment = 3

# Filter: minimum skor relevansi (0.0–1.0)
relevance_threshold = 0.5

# Filter: berita tidak lebih tua dari N hari (0 = tidak ada limit)
max_age_days = 14

# Timeout headless browser dalam detik
screenshot_timeout_secs = 15

# Lebar screenshot sebelum formatting
screenshot_width_px = 1200

# Berapa detik news screenshot ditampilkan dalam clip
display_duration_secs = 4.0

# Kapan news screenshot muncul dalam clip (detik dari awal)
display_start_sec = 2.0

# Sumber berita yang diutamakan (kosong = semua)
# Contoh: ["kompas.com", "cnnindonesia.com", "detik.com"]
preferred_sources = []

# Direktori cache untuk screenshots (relatif ke output dir)
# Jika sama, screenshot dari run sebelumnya di-reuse
cache_dir = "news_cache"

# ─── Reaction Module ──────────────────────────────────────────────────
[reaction]
# Aktifkan/matikan seluruh modul reaction
enabled = false

# Posisi avatar dalam video final
# Pilihan: "pre_roll" | "post_roll" | "pip_corner" | "insert_middle"
position = "post_roll"

# Posisi pojok untuk mode "pip_corner"
# Pilihan: "bottom_right" | "bottom_left" | "top_right" | "top_left"
pip_position = "bottom_right"

# Ukuran PiP sebagai % lebar frame (untuk mode pip_corner)
pip_scale_pct = 30

# Durasi maksimum reaksi dalam detik (LLM akan generate script sesuai ini)
max_reaction_secs = 25

# Bahasa reaksi (gunakan kode BCP47: "id" = Indonesia, "en" = English)
language = "id"

# Gaya script reaksi — mempengaruhi tone LLM
# Pilihan: "energetic" | "informative" | "shocked" | "casual" | "auto"
# "auto" = LLM pilih berdasarkan viral_type moment
script_style = "auto"

# ─── TTS (Text-to-Speech) ─────────────────────────────────────────────
[reaction.tts]
# Provider TTS
# Pilihan: "elevenlabs" | "openai" | "google" | "edge" | "none"
# "none" = hanya static avatar image, tidak ada voice
provider = "edge"   # default: edge TTS (gratis, tidak butuh API key)

# Microsoft Edge TTS voices untuk bahasa Indonesia:
# "id-ID-ArdiNeural" (pria) | "id-ID-GadisNeural" (wanita)
edge_voice = "id-ID-ArdiNeural"

# ElevenLabs config (jika provider = "elevenlabs")
# API key dari .env: ELEVENLABS_API_KEY
elevenlabs_voice_id = ""
elevenlabs_model = "eleven_multilingual_v2"

# OpenAI TTS config (jika provider = "openai")
# Menggunakan key yang sama dengan analyze (OPENAI_API_KEY)
# Pilihan voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
openai_voice = "nova"
openai_model = "tts-1-hd"

# ─── Avatar ──────────────────────────────────────────────────────────
[reaction.avatar]
# Mode avatar
# Pilihan: "static_image" | "did" | "heygen" | "none"
# "none" = tidak ada avatar, hanya audio voice-over
mode = "static_image"

# Path ke gambar avatar (PNG, transparan lebih baik)
# Kosong = gunakan placeholder dari assets/
image_path = ""

# D-ID config (jika mode = "did")
# API key dari .env: DID_API_KEY
did_presenter_id = ""
did_driver_id = "uM00QMwJ9x"   # default natural driver

# HeyGen config (jika mode = "heygen")
# API key dari .env: HEYGEN_API_KEY  
heygen_avatar_id = ""
heygen_voice_id = ""
```

### Perubahan `.env`

```env
# News Search
SERPER_API_KEY=your_key_here
# NEWSAPI_KEY=your_key_here
# BING_SEARCH_API_KEY=your_key_here

# TTS
ELEVENLABS_API_KEY=your_key_here

# Avatar
DID_API_KEY=your_key_here
# HEYGEN_API_KEY=your_key_here
```

---

## 7. Perubahan Pipeline State

### `src/pipeline/state.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StageResults {
    pub ingest:     Option<IngestResult>,
    pub transcribe: Option<TranscribeResult>,
    pub analyze:    Option<AnalyzeResult>,
    pub enrich:     Option<EnrichResult>,   // ← BARU
    pub edit:       Option<EditResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichResult {
    pub enrichments: Vec<MomentEnrichment>,
    pub completed_at: DateTime<Utc>,
    pub news_found: usize,
    pub screenshots_taken: usize,
    pub reactions_generated: usize,
    pub tts_generated: usize,
    pub avatars_generated: usize,
}
```

### `src/pipeline/mod.rs` — Stage 4 Baru

```rust
// ── Stage 4: Enrich ─────────────────────────────────────────────────
if state.stages.enrich.is_none() && (config.news.enabled || config.reaction.enabled) {
    stage_header(4, 5, "Enrich  (news + reaction)");
    let svc = EnrichService::new(self.config, &job);
    let result = svc.run(
        &job.moments_path(),
        &job.transcript_path(),
        &video_title,
    ).await?;
    state.stages.enrich = Some(result);
    state.save(&job.state_path())?;
} else if state.stages.enrich.is_none() {
    info!("Stage 4/5: Enrich — skipped (news and reaction disabled)");
}
```

---

## 8. `EnrichService` — Orchestrasi Stage 4

```rust
impl EnrichService {
    pub async fn run(
        &self,
        moments_path: &Path,
        transcript_path: &Path,
        video_title: &str,
        video_channel: &str,
    ) -> Result<EnrichResult> {
        let moments: ViralMomentList = load_moments(moments_path)?;
        let transcript: Transcript = load_transcript(transcript_path)?;

        // Semua moment diproses secara PARALEL
        let handles: Vec<_> = moments.moments.iter().enumerate().map(|(i, moment)| {
            let job = self.job.clone();
            let config = self.config.clone();
            let transcript = transcript.clone();
            let video_title = video_title.to_owned();
            let video_channel = video_channel.to_owned();
            tokio::spawn(async move {
                enrich_single_moment(i, moment, &transcript, &video_title, &video_channel, &job, &config).await
            })
        }).collect();

        let enrichments: Vec<MomentEnrichment> = 
            futures::future::join_all(handles).await
            .into_iter()
            .filter_map(|r| r.ok().and_then(|r| r.ok()))
            .collect();

        // aggregate stats, save enrich.json ...
    }
}

async fn enrich_single_moment(
    index: usize,
    moment: &ViralMoment,
    transcript: &Transcript,          // ← BARU: butuh transcript untuk ekstrak teks window
    video_title: &str,
    video_channel: &str,
    job: &JobContext,
    config: &AppConfig,
) -> Result<MomentEnrichment> {
    
    // ── 4a: Ekstrak teks transcript dari window waktu moment ──────────────
    // Gunakan words_starting_in() yang sudah ada di Transcript struct
    let words = transcript.words_starting_in(moment.start_sec, moment.end_sec);
    let transcript_window: String = words.iter()
        .map(|w| w.word.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    let mut enrichment = MomentEnrichment {
        moment_index: index,
        transcript_window: transcript_window.clone(),
        extracted_keywords: vec![],
        news: vec![],
        reaction_script: None,
        tts_audio_path: None,
        avatar_video_path: None,
    };

    if config.news.enabled {
        // ── 4b: Keyword extraction dari transcript window via LLM ─────────
        // SUMBER KEBENARAN: apa yang benar-benar diucapkan, bukan metadata
        let keywords = NewsService::extract_keywords(
            &transcript_window,
            video_title,
            video_channel,
            config,
        ).await.unwrap_or_else(|e| {
            warn!("keyword extraction failed for moment {index}: {e}");
            vec![]
        });
        
        info!("moment {index}: extracted {} keywords: {:?}", keywords.len(), keywords);
        enrichment.extracted_keywords = keywords.clone();

        // ── 4c: Cari berita per keyword (semua paralel) ───────────────────
        let search_handles: Vec<_> = keywords.iter().map(|kw| {
            let kw = kw.clone();
            let cfg = config.clone();
            tokio::spawn(async move {
                NewsService::search_by_keyword(&kw, &cfg).await
            })
        }).collect();

        let mut all_results: Vec<NewsItem> = futures::future::join_all(search_handles)
            .await
            .into_iter()
            .filter_map(|r| r.ok().and_then(|r| r.ok()))
            .flatten()
            .collect();

        // Deduplikasi by URL
        all_results.dedup_by(|a, b| a.url == b.url);

        // Score dan sort
        all_results.iter_mut().for_each(|item| {
            item.relevance_score = score_relevance(item, &transcript_window);
        });
        all_results.sort_by(|a, b| b.relevance_score.partial_cmp(&a.relevance_score).unwrap());
        all_results.retain(|item| item.relevance_score >= config.news.relevance_threshold);

        // ── 4d: Screenshot top N berita ───────────────────────────────────
        let top_n = all_results.into_iter().take(config.news.max_results_per_moment);
        for mut item in top_n {
            match NewsService::screenshot(&item.url, &job.news_dir(index), config).await {
                Ok(paths) => {
                    item.screenshot_path = paths.raw;
                    item.formatted_screenshot_path = paths.formatted;
                }
                Err(e) => warn!("screenshot failed for {}: {e}", item.url),
            }
            enrichment.news.push(item);
        }
    }

    if config.reaction.enabled {
        // ── 4e: Reaction script (LLM) ────────────────────────────────────
        // Input: transcript_window (bukan moment.title!) + news context
        let script = ReactionService::generate_script(
            &transcript_window,
            &enrichment.news,
            moment,
            config,
        ).await?;

        // ── 4f: TTS synthesis ─────────────────────────────────────────────
        let audio_path = ReactionService::synthesize_tts(
            &script,
            &job.reaction_dir(index),
            config,
        ).await?;
        enrichment.tts_audio_path = Some(audio_path.clone());

        // ── 4g: Avatar animation (opsional) ──────────────────────────────
        if config.reaction.avatar.mode != AvatarMode::None {
            let avatar_path = ReactionService::generate_avatar(
                &audio_path,
                &script,
                &job.reaction_dir(index),
                config,
            ).await?;
            enrichment.avatar_video_path = Some(avatar_path);
        }

        enrichment.reaction_script = Some(script);
    }

    Ok(enrichment)
}
```

---

## 9. Perubahan `EditService`

`EditService::run()` menerima parameter tambahan:

```rust
pub async fn run(
    &self,
    video_path:        &Path,
    moments_path:      &Path,
    transcript_path:   &Path,
    enrich_path:       Option<&Path>,   // ← BARU: None jika enrich dimatikan
    layout:            &OutputLayout,
    audio_opts:        &AudioOptions,
    source_channel:    &str,
    social_name:       &str,
    style_profile_name: &str,
) -> Result<EditResult>
```

Per clip, data enrich dimuat dan diteruskan ke FFmpeg builder:

```rust
for (i, moment) in moments.iter().enumerate() {
    let enrichment = enrich_data.as_ref()
        .and_then(|e| e.enrichments.get(i));

    // Pilih news screenshot terbaik (highest relevance_score)
    let news_overlay = enrichment
        .and_then(|e| e.news.first())
        .and_then(|n| n.formatted_screenshot_path.as_ref())
        .map(|p| ImageOverlaySpec {
            path: p.clone(),
            at_sec: config.news.display_start_sec,
            duration_sec: config.news.display_duration_secs,
            animation: ImageAnimation::KenBurns,
        });

    // Avatar: pre-roll atau post-roll
    let avatar_clip = enrichment
        .and_then(|e| e.avatar_video_path.as_ref())
        .map(|p| AvatarInsert {
            path: p.clone(),
            position: config.reaction.position.clone(),
            tts_path: enrichment.and_then(|e| e.tts_audio_path.as_ref()).cloned(),
        });

    // Pass ke FFmpeg builder
    let output = ffmpeg::build_and_run(
        &FfmpegJob {
            // ... existing fields
            news_overlay,
            avatar_clip,
        },
        &self.config.ffmpeg,
    ).await?;
}
```

---

## 10. Implementasi Bertahap

### Phase 1 — Keyword Extraction + News Search (tanpa screenshot) — ✅ SELESAI (2026-05-31)
**Estimasi: 2-3 hari**

Ini adalah fondasi segalanya — keyword berasal dari transcript.

- ✅ `src/news/model.rs` — structs `NewsItem`, `MomentEnrichment` (`transcript_window` + `extracted_keywords`), `EnrichResult`, `RawSearchResult`
- ✅ `src/news/keyword.rs` — LLM keyword extractor dari transcript window + parser toleran (JSON/code-fence/line fallback) + dedup; 4 unit test
- ✅ `src/news/search.rs` — **Playwright (default) + Serper (fallback)**; batched query per moment (1 browser), aggregate, `dedup_by_url`, `score_relevance` (overlap·0.6 + freshness·0.25 + source·0.15), `within_max_age`; 3 unit test
- ✅ `scripts/news_search.py` — Python + Playwright (Bing News + fallback Google), output JSON envelope, graceful degrade jika playwright tidak terinstall
- ✅ `src/news/service.rs` — `EnrichService` orchestrasi Stage 4 (sequential per moment, simpan `enrich.json`)
- ✅ `src/pipeline/state.rs` — `EnrichResult` ditambahkan ke `StageResults` (serde default, resumable)
- ✅ `src/pipeline/mod.rs` — Stage 4 wired (gated `news.enabled`, best-effort, tidak menggagalkan pipeline), renumber 1/5..5/5
- ✅ `src/config.rs` — `NewsConfig` struct + default + load Serper key dari env
- ✅ `config.toml` + `config.toml.example` — section `[news]`
- ✅ `src/analyze/provider/mod.rs` — `build_llm_provider()` di-extract jadi free function (dipakai analyze + news)
- ✅ Build: `cargo check` zero error; 7 unit test news lulus

> **Keputusan desain (per arahan user):** internet search memakai **Python + Playwright**
> (tanpa API key berbayar) sebagai default, bukan Serper. Serper tetap tersedia sebagai
> fallback bila `THOTH_SERPER_API_KEY` diset dan `provider = "serper"`.

**Output:** `enrich.json` dengan keywords dari transcript + berita yang ditemukan. Belum ada screenshot.

**Validasi runtime (perlu dijalankan dengan video nyata):** set `[news] enabled = true`,
pastikan `pip install playwright && python -m playwright install chromium`, lalu jalankan
pipeline dan periksa `enrich.json` — keywords harus mencerminkan isi transcript, bukan metadata LLM.

### Phase 2 — Headless Screenshot + Formatting — ✅ SELESAI (2026-05-31)
**Estimasi: 2-3 hari**

- ✅ `environment.yml` + `scripts/setup_thoth_news.bat` — conda env `thoth-news` (Python 3.11 + Playwright + Chromium); jalankan sekali sebelum pakai
- ✅ `conda_env` field di `NewsConfig` (default: "thoth-news"); `screenshot_script` field; helper `util::python_command()` yang route otomatis ke `conda run -n env python` atau `python` langsung
- ✅ `scripts/news_screenshot.py` — Playwright headless, inject JS cleanup popup/cookie, screenshot, extract title + lead paragraph, output JSON envelope
- ✅ `src/news/scraper.rs` — subprocess wrapper, parsing JSON, `ScreenshotResult`, graceful degrade kalau script tidak ada / browser gagal
- ✅ `src/news/formatter.rs` — FFmpeg `filter_complex`: blur background 1080×1920 + scale screenshot overlay + `drawtext` source/date/headline; `escape_text`, `truncate_text`; 4 unit test
- ✅ Wired di `EnrichService`: screenshot → format → simpan path ke `NewsItem.screenshot_path` + `.formatted_screenshot_path`
- ✅ Build: `cargo check` zero error; 11 unit test lulus

> **Keputusan desain:** Screenshot menggunakan **Playwright dari conda env** (bukan Chrome binary discovery).
> Ini lebih konsisten di Windows — Playwright install Chromium sendiri ke `~/.cache/ms-playwright`,
> tidak bergantung path Chrome sistem yang variatif. Conda env juga memastikan Python + versi
> Playwright yang terprediksi.

**Output:** `enrich/news/moment_N/news_J.png` (raw) + `news_J_formatted.png` (9:16 + caption).

### Phase 3 — News Screenshot di Video
**Estimasi: 1-2 hari**

- Update `OverlaySpec` / tambah `ImageOverlaySpec` dengan `KenBurns` animation
- Update `ffmpeg.rs` — filter chain untuk static image overlay dengan zoom
- Update `edit/service.rs` — load enrich.json, pilih berita terbaik per clip
- Test: clip video menampilkan screenshot berita di detik ke-2 selama 4 detik

**Output:** clip video dengan berita relevan sebagai overlay visual.

### Phase 4 — TTS Voice Synthesis
**Estimasi: 2-3 hari**

- `src/reaction/model.rs` — structs
- `src/reaction/script.rs` — LLM reaction script generator (input: transcript_window + news[])
- `src/reaction/tts.rs` — Edge TTS (default, gratis)
- `config.rs` — ReactionConfig struct
- Test: `voice.mp3` dihasilkan per moment

**Output:** audio reaksi tersedia per moment.

### Phase 5 — Static Avatar + Post-Roll
**Estimasi: 2-3 hari**

- `src/reaction/avatar.rs` — static image mode
- Update `ffmpeg.rs` — post-roll append + audio ducking
- Update `edit/service.rs` — avatar insert logic
- Test: clip final = [main clip] + [avatar speaking reaction]

**Output:** clip video dengan reaksi avatar di akhir.

### Phase 6 — D-ID Talking Avatar (opsional)
**Estimasi: 3-4 hari**

- `src/reaction/avatar.rs` — D-ID API client
- D-ID polling (job-based API, tidak langsung selesai)
- Caching avatar untuk menghindari regenerasi
- Test: talking head dengan lip-sync

**Output:** reaksi avatar dengan lip-sync realistis.

---

## 11. Dependency Baru (Cargo.toml)

```toml
# News scraping
scraper   = "0.19"             # HTML parsing untuk text extraction
readability = "0.1"            # Mozilla Readability port (artikel extraction)

# Image processing (untuk screenshot formatting)
image     = "0.25"             # scale, crop, composite
imageproc = "0.25"             # Ken Burns (scale + crop per frame)

# Edge TTS (gratis, tidak butuh API key)
# Gunakan via subprocess: edge-tts Python CLI ATAU pure HTTP ke voice.microsoft.com

# HTTP (sudah ada reqwest)
# Tidak ada dependency baru untuk TTS/Avatar (gunakan reqwest untuk semua API)

# Parallel processing (sudah ada tokio)
futures   = "0.3"              # join_all untuk parallel enrichment
```

**Chrome:** Gunakan yang sudah terinstall di sistem (tidak diinstall sebagai dependency).

**Edge TTS:** Bisa via subprocess Python (`pip install edge-tts`) atau langsung HTTP ke endpoint Microsoft. Lebih baik via subprocess untuk simplicity, tanpa dependency tambahan di Rust.

---

## 12. Trade-offs & Keputusan Desain

### A. Kenapa static image dulu, bukan langsung D-ID?

D-ID API:
- Latency: 30-90 detik per video
- Biaya: ~$0.10 per video
- Jika 5 clips × 5 videos/hari = $2.50/hari

Static image:
- Latency: 0 (sudah ada gambar)
- Biaya: 0
- Cukup efektif untuk awal, upgrade ke D-ID kemudian

### B. Kenapa Edge TTS sebagai default?

- Gratis, tidak butuh API key
- Kualitas cukup baik untuk bahasa Indonesia
- `id-ID-ArdiNeural` dan `id-ID-GadisNeural` cukup natural
- Upgrade ke ElevenLabs dengan 1 baris config jika dibutuhkan

### C. Kenapa post-roll (bukan overlay side-by-side)?

Post-roll lebih aman karena:
- Tidak mengganggu konten utama
- Editing lebih sederhana (append, bukan composite)
- Konsisten dengan format "react" yang banyak di TikTok
- PiP side-by-side bisa jadi Phase 2 jika user feedback positif

### D. Bagaimana jika news tidak ditemukan?

Fallback chain:
1. Coba Serper (Google News)
2. Jika gagal, coba NewsAPI
3. Jika gagal/tidak ada berita relevan:
   - Tetap generate reaction script (dari moment saja, tanpa berita)
   - Tetap generate TTS + avatar
   - Tidak ada news overlay di video
4. Log warning yang jelas

### E. Bagaimana dengan video yang bukan topik terkini?

- `max_age_days = 0` = tidak ada filter usia berita
- Query bisa disusun lebih umum (hanya keyword, tidak ada date filter)
- LLM juga bisa generate reaction tanpa berita (isi `news: []`)

### F. Headless Chrome vs. Playwright/Puppeteer?

Chrome subprocess langsung (tanpa library):
- ✅ Tidak ada dependency tambahan di Rust
- ✅ Selalu up-to-date dengan browser user
- ✅ Tidak perlu install Chromium terpisah
- ❌ Kurang fleksibel untuk JS execution yang kompleks

Untuk kebutuhan kita (screenshot artikel + popup removal), subprocess sudah cukup.

### G. Screenshot sebagai overlay vs. sisipan video?

Screenshot bisa disajikan dua cara:
1. **Overlay** (gambar di atas video utama): lebih ringkas, konten utama tetap terlihat
2. **Sisipan** (full-screen replace): lebih dramatis, konten utama berhenti sesaat

Rekomendasi: **Overlay default** (gambar di atas, video utama tetap jalan), dengan opsi config `news.display_mode = "overlay" | "insert"` untuk full-screen insert.

---

## 13. Metrik Sukses

| Metrik | Target |
|---|---|
| News ditemukan | ≥ 70% dari moments berhasil menemukan ≥1 berita |
| Screenshot sukses | ≥ 80% dari URL yang ditemukan berhasil di-screenshot |
| TTS latency | < 5 detik per script (Edge TTS lokal) |
| Avatar mode static | Selalu sukses (hanya butuh gambar + audio) |
| Pipeline total tambahan | < 60 detik untuk stage Enrich (dengan paralel) |
| Clip quality | News screenshot tidak menutupi subtitles utama |

---

## 14. Yang Perlu Diklarifikasi Sebelum Implementasi

Sebelum mulai coding, berikut pertanyaan yang perlu dijawab:

1. **Bahasa berita:** Selalu bahasa Indonesia, atau mengikuti bahasa video?
2. **Avatar image:** Apakah ada gambar avatar yang sudah disiapkan, atau butuh placeholder default?
3. **News provider priority:** Mana yang diutamakan — Serper (gratis 2500/bulan) atau NewsAPI (100/hari)?
4. **Avatar position default:** Post-roll atau PiP corner? Atau biarkan user pilih via CLI arg?
5. **React tone:** Satu tone untuk semua video, atau auto dari viral_type?
6. **Phase priority:** Mulai dari Phase mana yang paling penting untuk segera diimplementasi?

---

## 15. Update BLUEPRINT.md yang Diperlukan

Setelah implementasi, tambahkan baris ini ke BLUEPRINT.md:

| Komponen | Status | File |
|---|---|---|
| **Keyword Extraction (dari transcript)** | ✅ Done | `src/news/keyword.rs` |
| **News Search Module (Playwright/Serper)** | ✅ Done | `src/news/search.rs`, `scripts/news_search.py` |
| **EnrichService (Stage 4)** | ✅ Done | `src/news/service.rs`, `src/pipeline/mod.rs` |
| **Headless Browser Screenshot** | ❌ 0% | `src/news/scraper.rs` (Phase 2) |
| **News Screenshot Overlay** | ❌ 0% | `src/news/formatter.rs`, `src/edit/ffmpeg.rs` (Phase 3) |
| **Reaction Script Generator** | ❌ 0% | `src/reaction/script.rs` (Phase 4) |
| **TTS Voice Synthesis** | ❌ 0% | `src/reaction/tts.rs` (Phase 4) |
| **Static Avatar Insert** | ❌ 0% | `src/reaction/avatar.rs` (Phase 5) |
| **D-ID Talking Avatar** | ❌ 0% | `src/reaction/avatar.rs` (Phase 6) |

---

## 16. Status Implementasi GPU Pipeline (Sudah Selesai)

Fitur GPU yang sudah diimplementasi dan tidak perlu dibuat lagi:

| Komponen | Status | File |
|---|---|---|
| **wgpu Context** (NVIDIA/AMD init) | ✅ Done | `src/gpu/context.rs` |
| **ColorPipeline** (WGSL color.wgsl) | ✅ Done | `src/gpu/effect.rs` |
| **TransitionPipeline** (WGSL transition.wgsl) | ✅ Done | `src/gpu/effect.rs` |
| **GpuProcessor** (FFmpeg pipe → GPU → FFmpeg) | ✅ Done | `src/gpu/processor.rs` |
| **color.wgsl** (HSL, LogWheel, Sharpen, Vignette, LUT) | ✅ Done | `src/gpu/shaders/color.wgsl` |
| **transition.wgsl** (21 transition types) | ✅ Done | `src/gpu/shaders/transition.wgsl` |
| **ColorGrading struct** (user-facing, serializable) | ✅ Done | `src/edit/color.rs` |
| **Transition enum** (40+ xfade + GPU-native) | ✅ Done | `src/edit/transition.rs` |
| **concat_with_transitions()** (FFmpeg xfade chain) | ✅ Done | `src/edit/transition.rs` |
| **GPU wired ke service.rs** | ✅ Done | `src/edit/service.rs` |
| **GpuConfig** di AppConfig | ✅ Done | `src/config.rs` |
| **color_mood** di ViralMoment | ✅ Done | `src/analyze/schema.rs` |
| **gpu_transition** di ViralMoment | ✅ Done | `src/analyze/schema.rs` |
| **color_mood/gpu_transition** di StyleProfile | ✅ Done | `src/config.rs` |
| **[gpu] section** di config.toml | ✅ Done | `config.toml` |

---

*Last updated: 2026-05-31*
