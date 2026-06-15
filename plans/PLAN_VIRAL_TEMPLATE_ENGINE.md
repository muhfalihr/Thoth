# PLAN — Viral Template Engine (gaya "Animelorian Reaction")

Status: **DRAFT / PROPOSAL** · Dibuat: 2026-06-01 · Basis: analisis 3 Shorts Animelorian
(`test/analysis/SYNTHESIS.md` + `report_v1/2/3.md`).

Tujuan: mengubah Thoth dari "auto-thoth + subtitle" menjadi **template engine**
yang bisa mereproduksi (dan menyempurnakan) struktur 5-beat khas reaction-news Indonesia,
secara otomatis dari satu URL sumber.

---

## 0. Ringkasan Template Target (5 Beat)

| Beat | Waktu | Isi | Status di Thoth |
|---|---|---|---|
| 1. Hook | 0–3s | BG petir + ekspresi ekstrem + **judul raksasa multi-warna per kata** + 1 kalimat paradoks | ⚠️ Parsial (`intro.rs` banner putih, bukan judul overlay multi-warna; belum ada petir/PiP) |
| 2. Intro tokoh | 3–6s | Nama BESAR di atas kepala + **kartu profil IG** (follower/like) | ❌ Belum ada (enrich hanya screenshot berita) |
| 3. Kronologi | 6–~30s | Footage/scene, ganti tiap 3–5s, **panah merah + callout angka** | ⚠️ Subtitle ✅, callout/arrow ❌ |
| 4. Reaksi netizen | ~30–40s | **Screenshot komentar di atas meme "elang"** | ❌ Belum ada |
| 5. Penutup | akhir | Punchline / twist / reveal edukasi | ⚠️ `reaction/` ada TTS+avatar, belum terstruktur sbg outro |

---

## 1. Pemetaan ke Arsitektur Saat Ini

Thoth pipeline: **Ingest → Transcribe → Analyze → Enrich(Stage 4) → Edit(Stage 5)**.

Template engine ini hidup di **2 tempat**:
1. **Enrich (Stage 4)** — *menyiapkan bahan*: deteksi tokoh, ambil kartu IG, generate kartu komentar,
   tentukan timestamp callout, tulis script outro. (folder `src/news/`, `src/reaction/`)
2. **Edit (Stage 5)** — *merangkai visual*: judul multi-warna, petir, nama-di-atas-kepala, arrow,
   meme komentar, subtitle. (folder `src/edit/`)

Konsep kunci baru: **`TemplateBeat`** — daftar instruksi visual ber-timestamp yang dihasilkan
Stage 4 dan dikonsumsi Stage 5 (mirip `MomentEnrichment` yang sudah ada di `src/news/model.rs`).

```
enrich.json (sudah ada) ─┐
                          ├─► beats.json (BARU) ──► Edit Stage 5 merender tiap beat
transcript.json ─────────┘
```

---

## 2. Komponen Baru / Perubahan per File

### 2.1 Hook multi-warna raksasa — `src/edit/hook_title.rs` (BARU)
Ganti/lengkapi `intro.rs`. Render judul hook sebagai **overlay di atas video** (bukan banner putih),
tiap kata warna berbeda + outline tebal + animasi pop.
- Pewarnaan per-kata bergiliran dari palet (mis. hijau→kuning→cyan→putih) — pakai mekanisme
  tag ASS inline yang **sudah ada** di `subtitle.rs::build_active_line` (`\c&H..&\3c&H..&\bord`).
- Animasi: scale-in pop pakai ASS `\t` transform (`\fscx`/`\fscy` 60→100 dalam 150ms).
- Auto-fit: pecah jadi 2–4 baris, font auto-shrink agar muat 9:16 (logika `wrap_text` bisa dipakai ulang).
- Input: `hook_text` + palet warna dari **Style Profile** (lihat §4).

### 2.2 Efek petir / energi — `src/edit/fx.rs` (BARU) + aset overlay
- Overlay klip petir transparan (mode blend `screen`) di 0–3s dan momen klimaks.
- FFmpeg: input ke-N berupa `lightning.mov` (alpha) atau `lightning.mp4` + `blend=all_mode=screen`.
- Tambah util `build_overlay_video_filter(idx, at_sec, dur, blend)` di `ffmpeg.rs`
  (pola sama dgn `build_news_image_filter` yg sudah ada).
- Variasi: shake (`crop` jitter via `random`), flash putih (`drawbox white` 1–2 frame), zoom-punch.

### 2.3 Kartu profil tokoh (IG/TikTok) — `src/news/profile_card.rs` (BARU)
Beat-2, bagian terpenting yang belum ada.
- Input: `{display_name, handle, avatar_url|path, followers, likes, bio, platform}`.
- 2 mode:
  - **Scrape** (opsional): `scripts/profile_scrape.py` (Playwright, reuse `news/util.rs`
    `python_command`) ambil avatar+follower dari profil publik.
  - **Manual/LLM**: kalau scrape gagal, LLM isi metadata dari transcript + user override.
- Render kartu PNG (template + drawtext) lalu overlay sbg gambar (reuse `ImageOverlaySpec` di `ffmpeg.rs`).
- **Nama BESAR di atas kepala**: drawtext outline tebal, posisi atas-tengah, durasi 2–3s.

### 2.4 Callout angka + panah merah — `src/edit/callout.rs` (BARU)
- LLM (Stage 4) mendeteksi "angka penting" di transcript (berat/harga/jumlah) → `Vec<Callout{at,text,target_xy}>`.
- Render: panah merah PNG + drawtext angka besar, animasi masuk (slide/scale).
- Aset: `assets/arrow_red.png` (beberapa sudut rotasi) atau generate via drawbox+poly.

### 2.5 Kartu komentar netizen + meme — `src/news/comment_card.rs` (BARU)
Beat-4.
- Input: list komentar (LLM generate gaya netizen, atau user supply) → render kartu komentar IG/TikTok.
- Tempel di atas **template meme** (mis. "elang/kecewa ringan") dari `assets/meme/`.
- Posisi pojok, durasi 2–4s.

### 2.6 Outro terstruktur — perluas `src/reaction/`
- `reaction/script.rs`: paksa format outro menjadi salah satu dari `{twist | punchline | edukasi}`
  (enum `OutroStyle`) sesuai konten — analog `script_style` yg sudah ada.
- TTS (`reaction/tts.rs`) + avatar (`reaction/avatar.rs`) sudah siap; tinggal labeli sbg beat-5.

### 2.7 Orkestrator beat — `src/template/mod.rs` (BARU)
- Struct `TemplateBeat { kind, start_sec, end_sec, payload }` + serialisasi `beats.json`.
- `TemplatePlan::from_enrichment(enrich, transcript, profile, style)` menyusun 5 beat.
- Edit Stage 5 (`edit/service.rs`) loop `beats` → panggil renderer terkait (hook_title/fx/profile_card/callout/comment_card).

### 2.8 Style Profile — `src/config.rs` + `config.toml`  (selaras Priority 1 BLUEPRINT)
Preset bernama `[template_profiles.animelorian]` berisi: palet warna hook, font, daftar SFX,
durasi tiap beat, on/off petir/PiP/arrow. Lihat §4.

---

## 3. Penyempurnaan (agar LEBIH BAIK dari referensi)

Referensi Animelorian punya kelemahan yang bisa kita lampaui:

1. **Subtitle hook animasi penuh** — referensi judulnya statis; kita pakai pop/scale per kata + glow
   (sudah punya pondasi di `subtitle.rs`). → lebih "hidup".
2. **Beat-sync SFX & efek ke beat musik** (Priority 4 BLUEPRINT) — petir/flash/cut nyambung ke beat BGM,
   bukan asal taruh. Butuh deteksi beat (`aubio`/ffmpeg `ebur128`/onset) → `src/edit/beatsync.rs`.
3. **Auto-PiP cuplikan klimaks** — ambil frame klimaks (pakai skor vision yg sudah ada di `analyze/`)
   sebagai PiP pojok di hook. Referensi memasang manual; kita otomatis.
4. **Kartu profil real-data** — scrape follower/like aktual (referensi kadang statis/blur).
5. **Konsistensi brand** — watermark/handle channel sendiri, lower-third konsisten, end-card CTA halus.
6. **Auto color-grade** — `edit/color.rs` (sudah ada) untuk LUT/teal-orange agar lebih "premium".
7. **Safe-area & A/B thumbnail** — auto-generate 2–3 thumbnail (sudah ada `thumbnail` command) buat testing.
8. **Validasi retensi** — hitung kepadatan cut (target ganti visual ≤5s) & warning kalau ada "dead air".

---

## 4. Skema Style Profile (config.toml — usulan)

```toml
[template_profiles.animelorian]
enabled            = true
# ── Beat timing (detik) ──
hook_dur           = 3.0
intro_dur          = 3.0      # beat-2 kartu profil
outro_style        = "auto"   # twist | punchline | edukasi | auto

# ── Hook title ──
hook_font          = "assets/fonts/Anton-Regular.ttf"   # display heavy
hook_palette       = ["#3DDC4A", "#FFE34D", "#3FC1FF", "#FFFFFF"]  # warna per-kata bergiliran
hook_outline_px    = 8
hook_animate       = true     # pop scale-in per kata

# ── FX ──
fx_lightning       = true
fx_lightning_asset = "assets/fx/lightning_loop.mov"
fx_flash_on_climax = true
fx_shake           = true

# ── Beat-2 profil ──
profile_card       = true
profile_scrape     = true     # coba Playwright dulu, fallback manual
name_above_head    = true

# ── Beat-3 callout ──
callout_arrows     = true
arrow_asset        = "assets/arrow_red.png"

# ── Beat-4 komentar ──
comment_cards      = true
meme_templates_dir = "assets/meme"

# ── Audio ──
sfx_whoosh         = "assets/sfx/whoosh-swipe.mp3"
sfx_impact         = "assets/sfx/impact-hit.mp3"
sfx_riser          = "assets/sfx/tuco-get-out.mp3"
sfx_ding           = "assets/sfx/notification.mp3"
beat_sync          = true
bgm_dir            = "assets/bgm"
```

Backward-compatible: semua field pakai `#[serde(default)]` (aturan CLAUDE.md).

---

## 5. ASET YANG DIBUTUHKAN

> Letakkan di struktur baru. Yang **WAJIB** ditandai 🔴, **disarankan** 🟡, **opsional** 🔵.

### 5.1 Font (`assets/fonts/`)
| Aset | Fungsi | Spek | Sumber |
|---|---|---|---|
| 🔴 Display heavy (Anton / Montserrat ExtraBold / Komika) | Judul hook & nama-di-atas-kepala | `.ttf`, bobot ≥800 | Google Fonts (Anton, gratis) |
| 🔴 Poppins-Bold (ADA) | Subtitle | sudah ada | ✓ |
| 🟡 TikTok Sans / Proxima alt | Variasi subtitle | `.ttf` | — |

### 5.2 Efek visual overlay (`assets/fx/`)
| Aset | Fungsi | Spek |
|---|---|---|
| 🔴 `lightning_loop.mov` | Petir hook & klimaks | Alpha (ProRes 4444) **atau** hitam-latar utk `blend=screen`, 1080×1920, loopable 2–4s |
| 🟡 `energy_lines.mov` | Garis energi/spark di belakang teks | alpha, seamless loop |
| 🟡 `flash_white.png` | Flash putih klimaks | 1080×1920 putih (dipakai via opacity) |
| 🔵 `particles_dust.mov` | Atmosfer | alpha loop |
| 🔵 `glitch_transition.mov` | Transisi antar scene | alpha, 0.3–0.5s |

> Sumber: Pexels/Mixkit/Videvo (CC), atau generate sendiri (After Effects/Blender). Pastikan lisensi komersial.

### 5.3 Grafis UI (`assets/ui/`)
| Aset | Fungsi | Spek |
|---|---|---|
| 🔴 `arrow_red.png` (+ rotasi 0/45/90/135°) | Callout penunjuk | PNG transparan, ~300px, merah tebal + outline putih |
| 🔴 `profile_card_template.png` | Kartu profil IG/TikTok | PNG 9:16-safe, slot avatar bulat + teks follower/like |
| 🔴 `comment_card_template.png` | Kartu komentar netizen | PNG gaya IG/TikTok comment (avatar + username + bubble) |
| 🟡 `lower_third.png` | Lower-third brand channel | PNG transparan |
| 🟡 `badge_verified.png` | Centang biru di kartu profil | PNG kecil |
| 🔵 `progress_bar.png` | Bar progres atas (retensi) | PNG |

### 5.4 Template meme (`assets/meme/`)
| Aset | Fungsi |
|---|---|
| 🔴 `elang_kecewa.png` | Template "elang/kecewa ringan" (basis kartu komentar beat-4) |
| 🟡 Koleksi 5–10 meme reaksi populer ID | Variasi beat-4 |

> Catatan lisensi: meme publik berisiko hak cipta — disarankan **buat versi orisinal** (karakter/maskot sendiri)
> agar aman monetisasi.

### 5.5 Audio
| Aset | Folder | Fungsi | Spek |
|---|---|---|---|
| 🟢 SFX meme (ADA 13 file, sudah dianotasi di `assets/asset_catalog.json`) | `assets/sfx/` | Transisi, klimaks, reaksi | ✓ |
| 🔴 BGM no-copyright (3–5 track energik) | `assets/bgm/` (kosong — isi) | Bed musik | MP3, loopable |
| 🟡 `bass_drop.mp3`, `swoosh_reverse.mp3` | `assets/sfx/` | Aksen | — |

> Sumber SFX/BGM bebas: Pixabay Audio, Mixkit, YouTube Audio Library, Uppbeat (cek lisensi Shorts).

### 5.6 Karakter / Avatar reaktor (`assets/avatar/`)
| Aset | Fungsi | Catatan |
|---|---|---|
| 🟡 Maskot reactor (PNG pose / sprite ekspresi) | Beat-5 reaction & branding | Bisa 3D render (Blender) atau ilustrasi; ekspresi: kaget, ketawa, mikir, kesal |
| 🔵 Model SadTalker (driver image) | Talking avatar (sudah ada path di config) | foto/render wajah frontal |

### 5.7 Data & konfigurasi
| Aset | Fungsi |
|---|---|
| 🔴 `THOTH_NOVITA_API_KEY` (ADA) | LLM + vision |
| 🔴 `data/cookies.txt` (ADA) | Playwright scrape profil/komentar |
| 🟡 Voice ID TTS (ElevenLabs/MiniMax/Fish) | Suara narator outro |
| 🟡 LUT `.cube` (`assets/luts/`) | Color grade `edit/color.rs` |

---

## 6. Skrip Python Baru (`scripts/`)
| Skrip | Fungsi | Reuse |
|---|---|---|
| 🔴 `profile_scrape.py` | Ambil avatar+follower+like dari profil IG/TikTok publik | pola `news_search.py` (Playwright + cookies) |
| 🟡 `comment_render.py` | (Opsional) render kartu komentar via PIL kalau tak mau FFmpeg drawtext | PIL |
| 🟡 `beat_detect.py` | Deteksi beat BGM → timestamps utk beat-sync | `librosa`/`aubio` |

---

## 7. Roadmap Bertahap (selaras aturan build_cuda.bat + test)

> Tiap fase: implement → `build_cuda.bat` (zero error) → `cargo test` → update `BLUEPRINT.md`.

- **Fase 1 — Hook engine** 🔴
  `edit/hook_title.rs` + Style Profile minimal + palet warna per-kata + animasi pop.
  Aset: font display, (petir opsional dulu). → Output: hook beat tampil benar.

- **Fase 2 — FX layer** 🔴
  `edit/fx.rs` + `ffmpeg.rs::build_overlay_video_filter` (petir/flash/shake).
  Aset: `lightning_loop.mov`, `flash_white.png`.

- **Fase 3 — Beat-2 profil tokoh** 🔴
  `news/profile_card.rs` + `scripts/profile_scrape.py` + nama-di-atas-kepala.
  Aset: `profile_card_template.png`, `badge_verified.png`.

- **Fase 4 — Callout & arrow** 🟡
  `edit/callout.rs` + deteksi angka LLM. Aset: `arrow_red.png`.

- **Fase 5 — Beat-4 komentar netizen** 🟡
  `news/comment_card.rs` + template meme. Aset: `comment_card_template.png`, `assets/meme/`.

- **Fase 6 — Orkestrator + Style Profile penuh** 🔴
  `template/mod.rs` (`beats.json`), integrasi di `edit/service.rs`, preset `animelorian` lengkap.

- **Fase 7 — Penyempurnaan** 🔵
  Beat-sync SFX (`beatsync.rs`), auto-PiP klimaks, color grade, validasi retensi, A/B thumbnail.

---

## 8. Definisi Selesai (Acceptance)
Satu perintah `thoth run <url> --profile animelorian` menghasilkan klip 9:16 yang:
1. Hook 0–3s: judul multi-warna animasi + petir + 1 kalimat paradoks. ✅
2. 3–6s: nama besar + kartu profil IG (data real bila bisa). ✅
3. Body: subtitle CapCut sinkron + ≥1 callout angka/arrow + ganti visual ≤5s. ✅
4. ~30–40s: ≥1 kartu komentar netizen di template meme. ✅
5. Penutup: outro twist/punchline/edukasi + (opsional) avatar bicara. ✅
6. Build `build_cuda.bat` zero-error, `cargo test` hijau, `BLUEPRINT.md` terupdate. ✅

---

## 9. Risiko & Mitigasi
| Risiko | Mitigasi |
|---|---|
| Hak cipta meme/footage sumber | Pakai maskot/aset orisinal; copyright-warning sudah ada di ingest |
| Scrape profil diblok bot-detection | Fallback manual/LLM (pola Kumparan yg sudah dipelajari) |
| FFmpeg filter_complex makin kompleks | Orkestrator `template/` membangun filter terpisah per beat, bukan satu graph raksasa |
| Aset alpha `.mov` berat | Sediakan varian `blend=screen` MP4 (tanpa alpha) |
| Lisensi font/SFX/BGM | Audit lisensi komersial sebelum dipakai; catat di `assets/CREDITS.md` |
```
