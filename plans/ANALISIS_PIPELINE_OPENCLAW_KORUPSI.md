# Analisis Pipeline: Content-Set OpenClaw "Korupsi BGN/MBG" → Hasil Jelek

**Tanggal:** 2026-06-05
**Input:** content-set OpenClaw (Ella) — main video TikTok 29 detik (@kompascom, Dadan
Hindayana ditangkap) + 6 footage TikTok + 17 komentar viral + profil + engagement.
**Keluhan:** (1) footage **sama sekali tidak dipakai**, (2) narasi **tidak jelas / ngawur**.

Dokumen ini menelusuri JALUR NYATA pipeline untuk content-set ini, menunjukkan BUKTI dari
job yang sudah jalan, dan menetapkan AKAR MASALAH + rekomendasi. Bukan tebakan — semua
diverifikasi dari kode dan artefak job.

---

## 0. TL;DR (Ringkasan Eksekutif)

| # | Gejala | Akar masalah | Bukti |
|---|--------|--------------|-------|
| **1** | Narasi ngawur / tidak nyambung topik | **Transkrip video utama nyaris kosong**: 29 dtk arrest-footage → Whisper cuma dapat `"Terima kasih."` (2 kata). Itu SATU-SATUNYA input ke LLM narasi. | `transcribe/transcript.json` = `"Terima kasih."`; hook hasil = `"5 Pernyataan Paling Aneh Hari Ini"` (halusinasi, tak ada hubungannya dgn BGN/MBG) |
| **2** | Narasi ngawur (lanjutan) | **17 komentar + title + profil TIDAK PERNAH dikirim ke LLM narasi.** Sinyal cerita terkaya (sentimen viral) dibuang. | `narration::generate_script()` hanya terima `source_text` (= transkrip). Komentar cuma dipakai utk kartu komentar. |
| **3** | Footage tidak dipakai | **Download footage cutaway TANPA cookies.** TikTok wajib cookies utk di-download → `fetch_overlay_from_url` gagal → `None` → 0 kartu footage. (Video UTAMA berhasil krn jalur ingest pakai cookies; jalur footage tidak.) | `overlay::download_clip_section()` membangun `YtDlpArgs` tanpa `.cookies()`. Tak ada file baru di `overlay_cache` saat run. |
| **4** | Footage tidak dipakai (konteks narasi) | **Enrichment-text utk narasi hanya ambil YouTube.** 6 footage semua TikTok → 0 konteks tambahan. | `pipeline::fetch_enrichment_texts()` filter `r.platform == "youtube"`. |
| **5** | Video kependekan & terasa "kosong" | Sumber narasi kosong → LLM cuma hasilkan ~7 dtk narasi (bukan target 45 dtk) → video final **8.5 dtk** berisi b-roll utama + subtitle ngawur. | `narration.mp3` durasi **6.92s**; clip final **8.52s**; `target_secs=45`. |

**Inti masalah arsitektur:** Thoth's narasi dirancang untuk video yang KONTEN-nya ada di
AUDIO (talking-head, podcast, ceramah → transkrip = cerita). Tapi content-set ini adalah
**raw b-roll berita 29 detik tanpa narasi suara** — ceritanya ada di **title + komentar +
visual**, bukan di audio. Pipeline membaca audio (kosong) dan mengabaikan title/komentar →
LLM tak punya bahan → halusinasi.

---

## 1. Bagaimana Pipeline Memproses Content-Set Ini (Trace Nyata)

### 1.1 `main.rs` — resolusi `--content`
File: `src/main.rs` (blok `args.content`)
1. `load_content_set()` parse JSON → `LoadedSet { main_url, footage[6], profile, comments[17], main_image_path }`.
2. **Field `engagement` di `main` DIABAIKAN diam-diam** — bukan bagian schema `MainVideo`, dan
   serde tidak `deny_unknown_fields` (forward-compat). Likes/comments/shares **hilang**, tak
   pernah dipakai di mana pun.
3. Tulis `footage[]` → `output/content_enrichment.json`.
4. Download avatar (kosong di sini) → `content_profile.json` (`name/handle/stats`). Catatan:
   `engagement.likes` TIDAK dipetakan ke `stats`, jadi kartu profil tampil tanpa follower/stats.
5. Comments[17] → `content_comments.json` (dipakai HANYA utk kartu komentar).
6. `resolved_url = main.url` → diserahkan ke pipeline (ingest pakai `main.url`).

➡️ **`main.title`, `main.profile.engagement`, dan `comments[]` tidak masuk ke jalur narasi sama sekali.**

### 1.2 Stage 1 INGEST — download main
- `main.url` (TikTok 29 dtk) di-download yt-dlp **dengan cookies** (`config.ingest.cookie_file`
  = firefox-cookies). Berhasil. ✅

### 1.3 Stage 2 TRANSCRIBE — Whisper large-v3
- Output nyata (`transcribe/transcript.json`):
  ```json
  { "segments": [ { "text": "Terima kasih.", "start_ms": 29460, "end_ms": 29980 } ],
    "duration_ms": 29980 }
  ```
- **Seluruh 29 detik = "Terima kasih."** Klip penangkapan = keramaian/voice-over tipis di
  ujung saja; tak ada narasi yang bisa ditranskrip. Ini **bukan bug Whisper** — memang audionya
  tidak berisi cerita.

### 1.4 Stage 3 ANALYZE (+ vision describe)
- `describe_video=true` men-deskripsi frame secara VISUAL, tapi hasilnya dipakai untuk
  meranking momen di stage analyze — **tidak menulis ulang `transcribe/transcript.json`**.
- Stage narasi (1.5 di bawah) membaca `transcript.json` MENTAH → tetap cuma "Terima kasih.".

### 1.5 Stage 4 NARRATION — sumber masalah utama
File: `src/pipeline/mod.rs::generate_narration()` + `src/narration/mod.rs`
1. `main_text` = gabungan segmen transkrip = **"Terima kasih."**.
2. `fetch_enrichment_texts()` → ambil subtitle video lain **TAPI hanya `platform=="youtube"`**.
   6 footage semua **TikTok** → return **kosong**. Jadi `source_text = "Terima kasih."`.
3. `narration::generate_script(provider, source_text="Terima kasih.", "id", 45)`:
   - LLM diminta nulis ~135 kata rage-bait dari input "Terima kasih.".
   - Tidak ada topik, tokoh, atau fakta → **LLM mengarang**. Hasil hook nyata:
     **`"5 Pernyataan Paling Aneh Hari Ini"`** — sama sekali tak menyebut Dadan/BGN/MBG/korupsi.
4. TTS → `narration.mp3` **6.92 dtk** (pendek, karena bahan tipis).

➡️ Inilah "narasi tidak jelas": **narasi halusinasi, lepas dari topik nyata.**

### 1.6 Stage 5 EDIT — `render_narration_video` (jalur aktif krn `[narration] enabled`)
File: `src/edit/service.rs`
1. Durasi video = durasi narasi = **~7 dtk** → clip final **8.5 dtk**.
2. Montase footage: untuk tiap beat, coba `fetch_overlay_from_url(footage.url, …)`.
   - `fetch_overlay_from_url` → `download_clip_section()` → `YtDlpArgs` **TANPA cookies**.
   - TikTok menolak download tanpa cookies → gagal → `None` → **tidak ada `FootageCardCue`**.
   - (Image pool kosong: semua footage `is_video:true`.)
3. Hasil: `audio.footage_cards = []`, `audio.image_cards = []` → **layar cuma b-roll utama**.
   Frame t=5 terbukti: footage penangkapan @kompascom + subtitle `"KALI."` (potongan narasi
   ngawur), **tanpa kartu footage / montase**.

➡️ Inilah "footage sama sekali tidak dipakai".

---

## 2. Bukti Konkret (dari job nyata `e3860617…`)

| Artefak | Nilai | Arti |
|---------|-------|------|
| `transcribe/transcript.json` | `"Terima kasih."` (29.46–29.98s) | Transkrip nyaris kosong |
| `narration/hook.txt` | `"5 Pernyataan Paling Aneh Hari Ini"` | Hook halusinasi, lepas topik |
| `narration/narration.mp3` | durasi **6.92s** | Narasi terlalu pendek (target 45s) |
| clip `clip_000_narration.mp4` | durasi **8.52s** | Video final kependekan |
| `overlay_cache/` | tak ada file baru saat run | Download footage TikTok gagal |
| Frame t=5s | b-roll utama + subtitle `"KALI."`, **tanpa kartu footage** | Footage tak terpakai |

---

## 3. Akar Masalah Detail

### 🔴 RC-1 — Narasi dibangun dari audio yang kosong, mengabaikan sumber cerita
- `generate_script()` (`src/narration/mod.rs:43`) **hanya** menerima `source_text` (transkrip).
- Untuk raw b-roll tanpa narasi suara, transkrip ≈ kosong → LLM **wajib mengarang**.
- **Title** (`"…Dadan Hindayana ditangkap"`), **profil** (`Kompas.com`), dan terutama **17
  komentar** (yang memuat SELURUH cerita + sentimen: "Dadan ditangkap", "BUBARKAN MBG ladang
  korupsi", "hukuman mati koruptor", "audit semua SPPG", arti warna rompi, dsb.) — **tidak
  pernah dikirim ke LLM narasi**.
- Komentar di content-set ini adalah **bahan rage-bait terbaik yang mungkin ada**, tapi cuma
  jadi kartu komentar, bukan bahan narasi.

### 🔴 RC-2 — Download footage cutaway tanpa cookies (TikTok pasti gagal)
- `overlay::download_clip_section()` (`src/edit/overlay.rs:604`) membangun argumen yt-dlp tanpa
  `.cookies(...)`, padahal jalur INGEST utama memakai `config.ingest.cookie_file`.
- TikTok memblok download video tanpa cookies → semua footage TikTok gagal di-fetch.
- Akibat lanjutan setelah perbaikan allowlist (entry `x` di BLUEPRINT): pool video **terisi**
  (6 footage lolos filter), tapi **download-nya tetap gagal** → tetap 0 kartu. Jadi "platform-
  agnostic pool" perlu dipasangkan dgn "download pakai cookies" supaya benar-benar berguna.

### 🟠 RC-3 — Konteks enrichment narasi hanya YouTube
- `fetch_enrichment_texts()` (`src/pipeline/mod.rs:263`) filter `r.platform == "youtube"`.
- Semua footage TikTok → 0 konteks. Andai pun komentar tak dipakai, subtitle footage TikTok pun
  tak diambil.

### 🟠 RC-4 — Mismatch panjang & field terbuang
- `target_secs=45` tapi narasi nyata 6.9 dtk (sumber tipis). Tidak ada lantai durasi / tidak ada
  fallback "kalau transkrip pendek, pakai komentar".
- `engagement` (185K likes, 24K comments, dst.) **diabaikan** — padahal bisa jadi `profile.stats`
  ("185.2K suka") dan angka callout/hook ("185 RIBU like dalam sehari").

---

## 4. Rekomendasi Perbaikan (prioritas)

> Catatan: ini ANALISIS. Belum ada kode yang diubah. Daftar di bawah = peta perbaikan.

### Prioritas 1 — Suntik komentar + title + profil ke konteks narasi (dampak terbesar)
Ubah `generate_narration()` agar `source_text` digabung dari, berurutan:
1. **Title** main (`"Dadan Hindayana ditangkap…"`) — orientasi topik.
2. **Top-N komentar** (sort by likes; sudah ada di `content_comments.json`) — sentimen + fakta.
3. Transkrip (kalau ada isinya).
4. (opsional) deskripsi visual `describe_video` saat transkrip kosong.

Lalu `generate_script()` diberi blok `[Judul]`, `[Komentar Netizen Teratas]`, `[Transkrip]`
yang eksplisit. Untuk konten seperti ini, komentar = bahan rage-bait paling otentik.
→ Menghapus halusinasi; narasi langsung nyambung ke "Dadan ditangkap, netizen minta MBG dibubarkan".

### Prioritas 2 — Lewatkan cookies ke download footage ✅ SUDAH DIKERJAKAN (2026-06-05)
~~Tambah `.cookies(...)` di `download_clip_section()`/`download_clip_variant()`~~ → IMPLEMENTED.
`download_clip_section()`, `download_clip_variant()`, dan `download_clip_direct()` di
`src/edit/overlay.rs` kini menerima `Option<&CookieSource>` dan memanggil `with_cookie()`
(mirror jalur ingest, prioritas file > browser) + cleanup temp cookie DB (Windows Chromium).
`fetch_overlay_from_url`/`fetch_overlay_clip` meneruskan cookie; `EditService` resolve sekali
via `overlay_cookie()` dari `config.ingest.cookie_file`/`cookie_browser`. → Footage
TikTok/IG/dll bisa di-download → kartu montase muncul → "footage dipakai".

### Prioritas 3 — Fallback transkrip kosong
Di `generate_narration()`: bila `main_text` < ~10 kata, JANGAN paksa narasi dari audio. Beralih
ke title+komentar sebagai sumber utama (dan/atau pakai `describe_video`). Tambah lantai durasi
yang masuk akal (mis. min 20 dtk) atau sesuaikan ke jumlah bahan.

### Prioritas 4 — Manfaatkan `engagement` + perluas enrichment-text
- Map `engagement` → `ProfileCardData.stats` ("185.2K suka · 24K komentar") dan bahan hook/callout.
- Longgarkan `fetch_enrichment_texts()` agar tak YouTube-only (atau, lebih baik, andalkan
  komentar daripada subtitle footage).

### Prioritas 5 (sisi OpenClaw / Ella)
Untuk raw b-roll tanpa narasi suara, content-set sebaiknya menandai bahwa **cerita ada di
komentar/title**, bukan audio — atau menyertakan ringkasan kejadian sebagai field konteks, agar
Thoth tak bergantung pada transkrip yang mungkin kosong.

---

## 5. Kesimpulan

Hasil jelek **bukan** karena fitur image-card/montase rusak, melainkan karena:
1. **Narasi:** video ini tak punya narasi suara → transkrip = "Terima kasih." → LLM mengarang,
   sementara sumber cerita sebenarnya (title + 17 komentar) dibuang dari jalur narasi.
2. **Footage:** download cutaway tidak memakai cookies → footage TikTok gagal di-download →
   tidak ada kartu montase.

Dua perbaikan berdampak terbesar: **(P1)** suntik komentar+title ke narasi, dan **(P2)** kirim
cookies ke downloader footage. Keduanya kecil secara kode tapi langsung menyelesaikan kedua
keluhan utama.
