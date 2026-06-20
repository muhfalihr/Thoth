# Bugfix Plan — temuan dari run OpenClaw 2026-06-17

Sumber: sesi Ella `2c0131bc-9a09-467c-9e10-f87b0a5ad583` (14:41–15:10 WIB).
Flow yang dijalankan: `discover_reels → run_pipeline → thoth run --content`.
Topik: *"Siswa SMP Bandar Lampung tusuk teman (KAS 13 vs VI 13, bullying)"*.
Hasil akhir: 1 clip ter-render (`clip_000_narration.mp4`, 9.8s) — **selesai, tapi dengan
beberapa bug & degradasi kualitas di sepanjang jalan.**

Status: **PLAN ONLY — belum ada perbaikan kode.** Daftar di bawah urut prioritas.

---

## P0 — Data loss

### Bug 1 — `scrape_comments.js` menimpa (overwrite) content-set hasil `run_pipeline` — ✅ FIXED (2026-06-17)
> Fix terpasang di `openclaw/scrape_comments.js` (module) + workspace (identik, `node --check` OK).
> Guard merge sekarang cocok via page-url / CDN-url / `source_url` / video-id. Tes simulasi skenario
> bug: page-url → MERGE (footage tetap), video beda → tetap overwrite (benar), legacy exact-url → MERGE.
> Catatan: hanya file ini yang kena; `scrape_comments_*.js` cuma return JSON (tak menulis set),
> `collect_comments.js` sudah aman (pakai `main.source_url || main.url`).
- **Gejala:** setelah `run_pipeline.js` merakit set lengkap (main + description + footage),
  menjalankan `scrape_comments.js <tiktok_url>` menimpa `thoth_content_set.json` jadi set
  minimal → `main.description` hilang, `footage: []`. Ella menyadarinya: *"Content-set kehapus!"*.
- **Root cause (presisi):** `openclaw/scrape_comments.js:184`
  ```js
  if (prev && !Array.isArray(prev) && prev.main && prev.main.url === TARGET_URL) {
    prev.comments = results; // merge: keep footage+description
  }
  ```
  Guard merge hanya jalan kalau `prev.main.url === TARGET_URL`. Tapi `trace_source`
  (dalam `run_pipeline`) sudah me-resolve TikTok → **URL CDN** (`v16m-default.tiktokcdn-us.com/...`),
  sedangkan `scrape_comments` dipanggil dengan **URL halaman** (`tiktok.com/@user/video/123`).
  CDN ≠ page → guard gagal → file ditimpa set minimal. **Untuk main TikTok ini terjadi tiap kali.**
- **Rencana fix:** longgarkan pencocokan — anggap "same main" bila salah satu cocok:
  `prev.main.url === TARGET_URL` **ATAU** `prev.main.source_url === TARGET_URL` **ATAU**
  video-id sama (ekstrak `/video/(\d+)/` dari kedua URL). Pakai itu untuk memutuskan merge.
- **File:** `openclaw/scrape_comments.js` (+ deploy ke workspace via `node sync.js push`).
- **Cek tambahan:** `scrape_comments_{ig,x,yt,fb,reddit}.js` apakah pakai pola tulis yang sama;
  kalau ya, samakan logikanya. `collect_comments.js` (jalur yang disarankan) sudah merge — pastikan.
- **Verifikasi:** run_pipeline → scrape_comments by page-url → cek `footage` & `description` tetap ada.

---

## P1 — Reliability / quality

### Bug 2 — `discover_reels.js` bocor antar-akun + views kosong + topik sampah — ✅ FIXED (2026-06-17)
> Fix di `openclaw/discover_reels.js` + `openclaw/ig_profile.js` (module + workspace, identik, `node --check` OK):
> (1) **Cross-account filter** — `reelsOf`/`igProfileReels` sekarang drop href yang owner-handle-nya ≠ akun
> diminta (bare `/reel/<code>` tetap diterima); ini mematikan kebocoran indozone.id di bawah jktlogy.
> (2) **`cleanTopic()`** — buang meta-answer vision ("Tak ada teks overlay…") & watermark/domain
> ("WWW.INDOZONE.ID", "indozone.id"); diterapkan ke hasil hook DAN audio fallback → kalau kosong jatuh
> ke audio / "(tak terbaca)". (3) **Warning views/grid** — log peringatan saat akun 0 reel
> (grid virtualized / semua leak ke-drop) atau saat semua views 0. Unit-test 11/11 pass.
- **Gejala:** run untuk `@jktlogy` mengembalikan reel ber-URL
  `instagram.com/indozone.id/reel/...` (akun salah), `views: ""` / `views_n: 0`, dan topik
  sampah: `"WWW.INDOZONE.ID"`, `"Tak ada teks overlay di atas video"` (kebaca watermark / kosong).
- **Root cause (dugaan):** grid reels IG ter-virtualisasi → scraper nyangkut ke profil/iklan lain;
  + pembaca topik menerima string watermark/empty sebagai topik valid.
- **Rencana fix:**
  1. Validasi tiap reel: handle di URL HARUS == akun yang diminta; kalau beda → buang.
  2. Gate topik: tolak topik yang cuma watermark domain (regex `WWW\.|\.ID|\.COM`) / "Tak ada teks".
  3. Saat `views_n == 0` untuk semua reel → tandai akun "fetch gagal", jangan diam-diam lolos.
- **File:** `openclaw/discover_reels.js`, `openclaw/ig_profile.js`.

### Bug 3 — Script panjang kena SIGKILL sebelum selesai — ✅ FIXED (2026-06-17)
> (1) **Code:** `discover_reels.js` dulu nulis output cuma sekali di akhir → SIGKILL = total loss
> (terbukti: `reel_topics.json` stale 6/12). Sekarang **checkpoint per-reel & per-akun** (`flush()`,
> flag `"partial": true`; final write `partial:false`). `run_pipeline.js` sudah resilient (seed +
> per-stage write → partial selamat saat kill — terkonfirmasi di run). (2) **Docs:** `openclaw/README.md`
> §3 box + baris Troubleshooting → jalankan via **background + poll**, kecilkan beban per-call, dan
> output partial bisa langsung dipakai tanpa rerun penuh. (module ↔ workspace identik, `node --check` OK.)
- **Gejala:** `discover_reels.js` DAN `run_pipeline.js` dua-duanya di-`SIGKILL` mid-run oleh
  timeout proses OpenClaw. `run_pipeline` mati pas `build_footage` → content-set partial
  (main + 2 footage, tanpa figures/comments) → Ella rakit ulang manual.
- **Root cause:** durasi eksekusi > batas default proses runtime (vision + whisper + multi-search).
- **Rencana fix (orkestrasi, bukan kode pipeline):**
  1. Jalankan via background session + `process poll/log` (bukan satu call sinkron).
  2. Kecilkan beban per-call: `discover_reels` 1 akun per call; `run_pipeline` turunkan `--per/--max`.
  3. Update skill/README OpenClaw: dokumentasikan pola "background + poll" untuk step ini.
- **File:** `openclaw/README.md`, skill content-sourcing, mungkin `discover_reels.js`/`run_pipeline.js`
  (mode chunked).

### Bug 6 — Narator clip cuma 9.8s padahal `target_secs = 45` — ✅ FIXED (2026-06-17)
> **Diagnosis (bukan dugaan):** narasi SEBENARNYA panjang & on-target — `narration.txt` ~115 kata,
> `narration_words.json` kata terakhir end 47.693s; `state.json` source=14s, transcribe=10s, clip=9.8s.
> Root cause: `service.rs` `let dur = (narr_dur+lead).min(video_dur-0.2)` → video di-clamp ke durasi
> source/transkrip (10s), narasi (48s) dipotong ~80%.
> **Fix:** (1) `service.rs render_narration_video` — `dur = narr_dur + lead` (narasi = tulang
> punggung audio, TAK di-cap ke source); kalau `dur > video_dur` set `loop_source=true` & start=0.
> (2) `ffmpeg.rs` — field baru `AudioOptions.loop_source`; `encode_clip_direct` menambah `-stream_loop -1`
> sebelum `-i source` (kedua branch) → B-roll pendek di-loop mengisi timeline; trim/amix(duration=first)
> tetap membatasi output ke panjang narasi. Log diperjelas "(looped from Ns source)".
> **Verifikasi:** `cargo check` ✓, `build_cuda.bat` full ✓ (zero error), 60 edit-test ✓, **bukti
> end-to-end:** ffmpeg dgn aset asli (source 14.6s + narration 47.9s) + `-stream_loop -1`+trim →
> output **47.879s** (bukan 14s).
- **Gejala:** `🎬 Narrator-driven video: 9.8s | B-roll [0.2–10.0s]`. Jauh di bawah target 45s.
  Footage semua di-skip (`1 window, 1 di-skip <floor 0.46 → main clip`), `Montage: 0 footage`.
- **Root cause (perlu diagnosis):** durasi video narator = panjang audio narasi (TTS). 9.8s ≈ ~30 kata
  → script narasi keluar jauh lebih pendek dari ~135 kata target. Kemungkinan: (a) LLM narasi
  menghasilkan script pendek, (b) main video cuma 14s lalu durasi ter-clamp, (c) footage ke-skip
  sehingga tak ada bahan visual untuk memperpanjang. Belum pasti — log tengah tak ter-capture.
- **Rencana fix:** diagnosis dulu (rerun + simpan log penuh `Narration script: NN words`), lalu
  putuskan: pertegas target panjang di prompt narasi / longgarkan floor footage / handle main pendek.
- **File:** `src/narration/`, `src/pipeline/mod.rs`, `src/edit/service.rs` (footage floor 0.46).

---

## P2 — Scraper fragility (bukan blocker, tapi sering muncul)

### Bug 4 — `crop_post.js` (X/Twitter) "rect post tak valid" — ✅ FIXED (2026-06-17)
> Root cause: hard `return` saat rect invalid terjadi SEBELUM retry loop, dan X (SPA agresif)
> sering re-render → atribut `data-crop-post` ke-wipe → `place()` querySelector dapat null → bail.
> Fix di `openclaw/crop_post.js`: retry baca rect sampai box valid (w>30 & h>12), **re-tag** (jalankan
> ulang `find`) tiap retry kalau atribut hilang; caption (`text`) dibaca SETELAH rect valid (bukan
> sebelum) biar tak kosong gara-gara re-render. Downstream sudah aman: `enrich_image_paths.js:79-84`
> memang sudah **drop** footage non-video tanpa image_path (lint lolos) — lint FAIL kemarin karena
> Ella rakit set manual (bypass enrich), bukan bug kode. (module ↔ workspace identik, `node --check` OK.)
- **Gejala:** crop tweet `x.com/Popmama_com/...` gagal (`⚠️ rect post tak valid`) → footage
  `is_video:false` tanpa `image_path` → **lint FAIL** → Ella buang tweet itu.
- **Root cause (dugaan):** selector/penentuan bounding-rect `<article>` X berubah / belum render.
- **Rencana fix:** retune selector X + tunggu `article[data-testid="tweet"]` render; fallback skip
  bersih (jangan tinggalkan footage tanpa image_path).
- **File:** `openclaw/crop_post.js`.

### Bug 5 — yt-dlp gagal ekstrak audio IG (fallback voiceover discover) — ✅ FIXED (2026-06-18)
> **Fix (`openclaw/discover_reels.js audioTopic`):** (1) **pre-skip** IG saat tanpa cookies — IG
> login-walled, jadi yt-dlp pasti gagal; dulu memanggilnya = doomed download (~menit) + pesan
> "Command failed: yt-dlp …" yang terlihat seperti crash. (2) Dukungan **`THOTH_YTDLP_COOKIES`**
> (firefox/brave/chrome) → `--cookies-from-browser` agar audio IG BISA jalan kalau diaktifkan.
> (3) Note error bersih & best-effort (login-wall/timeout/gagal), `--no-warnings --no-playlist`,
> timeout 45s. Vision hook tetap jalur utama; voiceover tak pernah mematikan entri.
> **Verifikasi:** `node --check` ok, module↔workspace identik; IG tanpa cookies → note bersih
> "audio-skip (IG login-wall — set THOTH_YTDLP_COOKIES=…)", TikTok tetap mencoba.

---

## P1 — Source resolution

### Bug 8 — Penggantian main dari akun kurator pakai query caption-saja (tanpa vision) → gagal untuk caption vague — ✅ FIXED (2026-06-18)
> **Gejala (run `run_full.ps1 -Url basevox/reel/...`):** main IG dari @basevox (kurator) WAJIB diganti
> ke sumber non-agregator, tapi `[1] caption: (kosong)`, `[2] headline(vision): (kosong)` → `keywords: -`
> → query `findStoryVideo` lemah → gagal.
> **Root cause:** `coverOf()` hanya menangani tiktok/youtube → untuk **IG return ''** → vision tak pernah
> jalan (tak ada gambar) → tak ada headline on-screen; query enforce dibangun dari caption/first-words
> saja, padahal caption kurator sering vague/motivasional.
> **Fix:** (1) `trace_source.js coverOf` + helper `igCoverImage()` — ambil **og:image** reel IG via CDP
> → vision (`visionHeadline` + `visionCover`) kini jalan untuk IG. (2) Sinyal `caption/headline/scene`
> di-hoist; `scene` (deskripsi visual) ikut disuntik ke `resolveSource`. (3) `resolve_source.js`
> fungsi baru `composeSearchQuery({description,caption,headline,scene})` — LLM menyusun SATU query
> spesifik, mengutamakan vision. (4) `[5]` enforce memakai query itu; `findStoryVideo` terima
> `opts.query` override. **Verifikasi LLM nyata:** caption-saja → "Keluarga penerus generasi penerus"
> (sampah); caption+vision → "Masinis KRL gagalkan bunuh diri di Stasiun Manggarai" (spesifik).
> (module ↔ workspace identik, `node --check` OK.)
> **Sisa:** `igCoverImage` pakai og:image (cukup ringan); kalau og:image kosong/blank, fallback capture
> frame pembuka (seperti `discover_reels.reelFrame`) bisa ditambah nanti.

### Bug 9 — `normalizeLikes` salah baca angka ribuan (views/likes) → ranking reel keliru — ✅ FIXED (2026-06-18)
> **Gejala:** ranking reel di `discover_reels` (kunci = `views_n` desc) memakai `normalizeLikes`, yang
> meng-`replace(',', '.')` lalu memperlakukan SEMUA titik sebagai desimal. Akibatnya angka ribuan
> TANPA suffix K/M jadi salah total: `3,261`→3, `2,932`→3, `3.261`→3, `9.999`→10. Reel views-ribuan
> yang ditampilkan angka penuh tenggelam ke dasar peringkat secara keliru.
> **Fix (`openclaw/comments.js normalizeLikes`):** bedakan separator berdasarkan ada/tidaknya suffix —
> ADA suffix (k/rb=×1e3, m/jt=×1e6) → angka = desimal (`1,2K`=1200, `32.4K`=32400); TANPA suffix →
> integer dgn pemisah ribuan, buang `.`/`,` (`3,261`=3261, `1.234.567`=1234567, `409`=409).
> **Verifikasi:** 18/18 kasus pass (termasuk semua kasus suffix lama = regression-safe). Dipakai juga
> untuk likes komentar (`collect_comments` sort) → bonus akurasi. (module ↔ workspace identik, `node --check` OK.)

### Enhancement 10 — Ranking topik: recency-decay opsional — ✅ DONE (2026-06-18)
> **Konteks:** ranking `discover_reels` murni `views_n` (recency cuma gate `--hours` + tie-break). Views
> akumulatif → memihak reel lebih tua; reel yg cepat viral (fresh) bisa kalah.
> **Implementasi (`openclaw/discover_reels.js`):** opt-in via env **`THOTH_REEL_HALFLIFE_H`** (jam).
> 0/unset = perilaku lama (backward-compatible). >0 → skor `views × 0.5^(umur_jam / half-life)`;
> umur tak diketahui = faktor 1 (tak menghukum). `rankCmp` dipakai seragam di flush & final write;
> `reel_topics.json` dapat field `ranking` + `score` (saat decay on); banner & PERINGKAT cetak mode +
> skor. **Verifikasi:** legacy → A>C>B (tak berubah); half-life 24 → C>A>B (fresh-but-strong naik).
> Didokumentasikan di `openclaw/README.md` (tabel tuning). (module ↔ workspace identik, `node --check` OK.)

### Bug 11 — Profile card sintetis (bukan crop asli platform) untuk non-TikTok — 🚧 IN PROGRESS
> **Gejala (job `2c2fafa7`, main IG @andiabdllh):** di ~t=5s tampil **kartu profil sintetis** (digambar
> Thoth) bukan crop profil asli platform. **Root cause:** satu-satunya profile-cropper =
> `tiktok_profile.cropTiktokProfile` (TikTok saja), dan hanya dipanggil di jalur `platHint==='tiktok'`.
> IG/X/FB/YT → `main.profile.image_path` kosong → Thoth gambar kartu sintetis.
> **Rencana:** modul baru `openclaw/profile_crop.js` (dispatcher `cropProfile(platform, handle, out)`),
> per-platform satu-satu, di-wire di `trace_source` end-step (guard: skip kalau image_path sudah ada →
> TikTok tak dobel).
> - ✅ **Instagram (2026-06-18):** crop `<header>` (avatar+nama+handle+stats+bio), bottom di-cap di
>   tombol Follow/Message (buang baris highlights). Handle dari `profile.handle` atau, untuk URL reel
>   telanjang, via **yt-dlp `%(channel)s`** (andal tanpa cookies; DOM `/reels/` cuma expose profil
>   VIEWER → bahaya salah-profil, jadi tak dipakai). Tes live: by-handle ✓, by-reel-URL ✓ (visual
>   benar @andiabdllh, avatar tampil). Wired di `trace_source.js` (best-effort, gagal → kartu sintetis).
> - ⚠️ **X/Twitter (2026-06-18): layout ✅, avatar ❌ → di-GATE OFF (`THOTH_PROFILE_X=1` utk paksa).**
>   `cropTwitter` (scope `primaryColumn`, avatar→tablist, pilih avatar terbesar) menghasilkan crop
>   teks/stat **sempurna**. Avatar bermasalah & semua jalur dicoba gagal:
>   1. X render avatar = **CSS background-image** → Chromium **tak rasterize di tab occluded** (blank).
>   2. Di tab occluded X bahkan **tak load URL avatar** ke DOM (flaky).
>   3. **Inject `<img>` unavatar.io** → diblokir **CSP halaman X** (img-src allowlist) → tak load.
>   4. **Download (Node, no CSP) + overlay lingkaran via ffmpeg** → URL avatar OK (unavatar.io andal),
>      koordinat dihitung benar (dpr=2, av=(178,179,142)→ax=58,ay=24,d=283) TAPI overlay tetap mis-align
>      visual — quirk coordinate-space screenshot-vs-layout di tab occluded/zoomed relay.
>   Kesimpulan: profil-card X andal butuh tab **foreground** atau pendekatan lain (render kartu sendiri
>   dari data+unavatar, bukan screenshot tab live). Kode download+overlay disimpan di balik flag.
>   Default: X pakai kartu sintetis (tanpa regresi).
> - ⏳ TODO: Facebook, YouTube — kemungkinan kena isu occluded-tab yang sama; rekomendasi: bila perlu,
>   tempuh jalur "render kartu sendiri" (avatar unavatar.io + nama/handle/followers dari teks) yang
>   bebas dari masalah rasterisasi tab.

### Bug 12 — Teks on-screen (hook title + subtitle) tanpa tanda baca; narasi audio tetap — ✅ FIXED (2026-06-18/19)
> **Permintaan:** teks hook & subtitle yang DITAMPILKAN wajib tanpa tanda baca; narasi (audio/skrip) boleh tetap.
> **Fix (`src/narration/mod.rs`):** `pub fn strip_punctuation()` membuang SEMUA tanda baca (ASCII punctuation
> + em/en-dash, kutip keriting, elipsis, dll) → diganti spasi (kata tak nyatu), whitespace di-collapse;
> huruf/angka/emoji dipertahankan. `sanitize_hook` = alias-nya.
> - **Hook title:** diterapkan saat ekstrak hook dari JSON LLM → `hook.txt` bersih → hook-title PNG (Pillow)
>   DAN AI cover dapat teks bersih. Prompt LLM juga diinstruksi tanpa tanda baca (sanitizer = jaminan).
> - **Subtitle (`src/edit/service.rs render_narration_video`):** kata-kata subtitle di-`strip_punctuation`
>   per-kata SEBELUM `generate_ass` (timing per-kata tetap; token yg jadi kosong, mis. "—", di-drop).
>   **Audio TTS + `narration.txt` TIDAK diubah** — narasi tetap bertanda baca, hanya tampilan yg bersih.
> **Verifikasi:** 2 unit-test pass ("Niatnya nolong — eh, malah ditangkap?!" → "Niatnya nolong eh malah
> ditangkap"); `cargo check` ✓; `build_cuda.bat` full ✓ (44s).

### Enhancement 13 — Prompt cover AI: grounding ke deskripsi topik + medium-shot subjek (non-bangunan) — ✅ DONE (2026-06-19)
> **Permintaan:** prompt generate gambar (`render_cover.py`) tambahkan detail deskripsi topik (jangan
> headline saja); subjek manusia/objek (BUKAN bangunan) dibuat **medium shot**.
> **Implementasi:**
> - Rust: field baru `CoverSpec.topic_desc`; `build_cover` terima `topic_desc` (dari moment pertama:
>   `title + ". " + reason`); fallback FLUX prompt juga memuat topik (300 char). (`src/edit/cover.rs`,
>   `src/edit/service.rs`)
> - Python (`scripts/render_cover.py`): `translate_to_scene` & `describe_frame` kini pakai headline **+**
>   `topic_desc` (user message: "Headline: …\nTopic description: …"), system-prompt diinstruksi grounding
>   ke deskripsi (bukan headline saja). **Framing:** subjek person/animal/object → **MEDIUM SHOT**
>   (mid-distance, waist-up untuk orang), HANYA bangunan/struktur besar boleh lebih lebar. `AI_EVENT_SUFFIX`
>   juga menambah instruksi medium-shot.
> **Verifikasi:** `python ast.parse` OK; `cargo check` ✓; `build_cuda.bat` full ✓ (1m26s).

### Enhancement 14 — Cover: subjek AI-HD (bukan cutout blur) + tak tertutup teks — ✅ DONE (2026-06-19)
> **Keluhan (job `2a35c881`):** cover pakai cutout asli yg di-upscale → subjek BLUR + tertutup headline.
> **Fix (`scripts/render_cover.py`, script → tanpa rebuild):**
> - **Resolution gate** di `cutout_is_good`: tambah `native_h` (tinggi subjek asli); kalau `target_h/native_h
>   > auto_max_upscale` (default 1.5) → cutout ditolak → "auto" pakai **AI HD recreation yang MENYERTAKAN
>   subjek** (via `describe_frame` vision → FLUX), bukan paste cutout blur. (Gibran: native 601px → 3.3× → AI.)
> - **Komposisi** (`AI_COMPOSITION`, dipakai di sys-prompt ai + `AI_EVENT_SUFFIX`): subjek di UPPER TWO-THIRDS,
>   wajah/badan atas tajam & UNOBSTRUCTED; LOWER THIRD dibiarkan bersih/gelap untuk headline → teks tak
>   menutup subjek. `crisp focus` ditambah ke style.
> **Verifikasi:** re-render spec job nyata → cover baru = subjek AI HD (pria kemeja putih + mic, medium shot),
> wajah jelas di atas, headline di bawah (cuma kena tangan/mic, bukan wajah). `ast.parse` OK.

### Enhancement 15 — Cover: wajah subjek MIRIP asli via face-swap + foto referensi internet — ✅ DONE (2026-06-19)
> **Permintaan:** subjek AI di cover harus mirip wajah aslinya; cari foto subjek di internet untuk
> menambah "knowledge" wajah.
> **Cek Novita (terverifikasi):** ada `v3/merge-face` (face-swap sync → `image_file` base64),
> `v3beta/flux-1-dev`, `v3/async/img2img`; `instant-id` 404. Dipilih **merge-face** (paling mirip).
> **Implementasi (`scripts/render_cover.py`):**
> - `fetch_reference_face(name)` — **search internet** via Wikipedia (id→en) by `character_name` →
>   download portrait bersih (key-free; Gibran → official portrait tanpa kacamata). Pakai thumbnail 800px.
> - `merge_face(target,face)` — Novita `v3/merge-face`; input di-cap JPEG (`_encode_capped` ≤1920/1024)
>   biar < limit 3.75MB.
> - `apply_face_swap`: mode "ai", setelah FLUX scene → swap wajah ASLI (ref internet > frame) → likeness.
>   Gate `[cover] face_swap` (default on).
> - Rust: `CoverSpec.subject_name`+`face_swap`; `build_cover(subject_name=moment.character_name)`;
>   `CoverConfig.face_swap`. (`cover.rs`,`service.rs`,`config.rs`,`config.toml.example`)
> **Verifikasi end-to-end:** spec job nyata → auto→ai → FLUX HD → Wikipedia Gibran → merge-face → cover
> final = subjek medium-shot **wajah Gibran asli** (bukan generik), headline di bawah. `cargo check` ✓,
> `build_cuda.bat` ✓ (55s), `ast.parse` ✓.

### Bug 16 — trace_source TikTok pilih video salah-aktivitas (subjek+lokasi benar, kegiatan beda) — ✅ FIXED (2026-06-20)
> **Gejala (job `momentumid3`):** main IG kredit `tt/momentumid3` → profil TikTok kebaca 30 video, TAPI
> dipilih video "kunjungan kerja Gibran" (`7652552464951987476`, sim 0.499 LOW-CONFIDENCE), padahal yang
> relevan = "Menu MBG dimasak Subuh" (`7652729200520056084`). Subjek+lokasi benar, AKTIVITAS salah.
> **Root cause:** ranking topik = `main.title + main.description` (KOSONG utk reel IG) → fallback ke
> **keywords saja** (subjek+lokasi). Sinyal AKTIVITAS dari **vision headline + scene** (sudah dibaca di
> [2]/[2b]) TAK ikut ke ranker.
> **Fix (`openclaw/trace_source.js`):**
> - `storyCtx` baru = **vision headline + scene + title + desc + keywords** → dipakai untuk ranking di
>   findOriginalTiktok / findOriginalInstagram / findStoryVideo (bukan title+desc kosong).
> - findOriginalTiktok: rank kandidat by **cover+caption digabung** (bukan cover saja); **pool diperlebar**
>   (byViews 12→16, byCap 6→8) biar klip yg benar tak ke-exclude sebelum di-rank.
> - `visionCover` prompt diperkuat: **WAJIB baca teks overlay** + aksi spesifik (diskriminator utama).
> **Verifikasi:** synthetic embed-rank → topik+vision menang 0.882 vs 0.512 (gap 0.17→0.37, lebih
> decisive). Live profile-read flaky saat tes (tab occluded → 0 video; di run user kebaca 30). `node --check` ✓.

### Bug 17 — Narration failed: JSON truncated (reasoning model) → clip-mode — ✅ FIXED (2026-06-20)
> **Gejala:** `WARN Narration failed — parse narration JSON: EOF while parsing an object`. Provider
> narasi `deepseek/deepseek-v4-flash` (reasoning model) menghabiskan token budget utk "thinking" → JSON
> ke-cut sebelum `}` (nilai hook+narration SUDAH lengkap, cuma kurang penutup) → serde gagal → jatuh
> ke clip-mode (topik salah).
> **Root cause:** parser narasi sebelumnya strict — `serde_json::from_str` gagal pada JSON terpotong → `?`
> langsung bail. `max_tokens` 4096 cukup utk output, tapi reasoning model boros.
> **Fix (`src/narration/mod.rs`):** `parse_narration_reply()` 2-tahap — (1) strict JSON (key-agnostic,
> seperti dulu); (2) **salvage**: kalau JSON invalid/terpotong, `json_str_field()` (UTF-8 safe, toleran
> truncation) menarik nilai string `"hook"` + narasi (coba key narration/naration/narrator/narasi/script/…)
> langsung dari teks mentah. Narasi ≥8 kata → dipakai (log WARN "salvaged"), bukan gagal total.
> **Verifikasi:** 4 unit-test pass termasuk **reply terpotong persis dari log** (tanpa `}`) → ter-salvage;
> `build_cuda.bat` ✓ (54s).

### Bug 18 — trace_source TikTok "0 video terbaca" (tab lambat) — ✅ FIXED (2026-06-20)
> **Gejala:** `[tiktok] profil @user: 0 video terbaca (login/tab?)` di tahap [4] → fallback search.
> Penyebab: grid profil lazy-load & tab kadang lama, `waitProfileReady` cuma 16s → timeout → 0 video.
> **Fix (`openclaw/tiktok_profile.js`):** `waitProfileReady` default 16s → **45s**; nav wait 7s→9s;
> baca grid dengan **retry + progressive scroll** (6×, scroll bertambah, sleep 1.5s tiap kali) sampai
> dapat video (total tunggu ~45–55s). `node --check` ✓, deploy ke workspace.

### Enhancement 19 — Cover backend OpenRouter (openai/gpt-5-image) — identity-preserving — ✅ DONE (2026-06-20)
> **Konteks:** FLUX text2img + face-swap "lebih bagus tapi belum mirip subjek". Cek OpenRouter: 9 model
> image-OUTPUT; pilih **`openai/gpt-5-image`** (GPT arch, image+text→image) yg ambil foto referensi asli +
> prompt → cover HD yang **native preserve identitas** (tanpa swap-hack).
> **Implementasi:**
> - `scripts/render_cover.py`: `openrouter_key()`, `_data_uri()`, `gen_cover_openrouter()` — kirim foto
>   referensi (Wikipedia by name + frame) + prompt scene/komposisi medium-shot ke
>   `openrouter.ai/api/v1/chat/completions` (modalities image), ambil `message.images[0]` → cover.
>   `main()`: `image_engine="openrouter"` → pakai jalur ini (mode ai, tanpa cutout/face-swap); **gagal/tanpa
>   key → fallback FLUX+face-swap** (graceful).
> - Rust: `CoverConfig.image_engine`+`image_model` (default flux / gpt-5-image); `CoverSpec` + `build_cover`.
> - Config: `config.toml` di-set `image_engine="openrouter"` (live, user mau coba); `config.toml.example`
>   default `flux`; `.env(.example)` tambah `THOTH_OPENROUTER_API_KEY`.
> **Verifikasi:** `cargo check`+`build_cuda.bat` ✓ (44s); `ast.parse` ✓; tanpa-key → graceful fallback ke
> FLUX terbukti (tak crash). **Perlu user isi `THOTH_OPENROUTER_API_KEY` di `.env` untuk aktif.**

### Bug 7 — Log meme menyesatkan ("top_right" padahal full-layar) — ✅ FIXED (2026-06-18)
> **Status:** BUKAN bug render (meme memang sudah full-layar) — cuma label log basi.
> **Fix (`src/edit/ffmpeg.rs:884`):** log `(full-screen)` saat `m.fullscreen`, selain itu `({position})`.
> **Verifikasi:** `cargo check` ✓, `build_cuda.bat` full ✓, 14 ffmpeg-test ✓.

---

## Catatan non-bug (untuk konteks)
- Komentar dari main TikTok `@monitorinddotcom` cuma 4 & receh ("p", "pertama", "1") → Ella pindah
  ambil dari `@kumparan` (3.115 / 1.812 likes). Ini **memang** alur `--extra`/sumber lain yang benar
  — tapi Bug 1 yang bikin langkah ini malah menghancurkan set. Setelah Bug 1 beres, alur ini aman.
- AI cover & hook-title PNG **tak bisa dipastikan** dari sesi ini (bagian tengah stage EDIT
  ke-scroll di luar snippet yang ke-poll). Perlu rerun dgn log penuh untuk konfirmasi keduanya
  muncul. (Config & binary sudah benar: `[cover] enabled`, `[hook_title] engine="python"`, binary
  ter-build 22:24 > source 22:22.)

---

## Urutan eksekusi yang disarankan
1. **Bug 1** (P0, data loss, root-cause jelas, fix kecil) — paling dulu.
2. **Bug 7** (P3, satu baris) — sekalian, murah.
3. **Bug 2** + **Bug 4** + **Bug 5** (scraper JS, satu batch di OpenClaw).
4. **Bug 6** (diagnosis dulu, baru fix) — butuh rerun dengan log penuh.
5. **Bug 3** (orkestrasi/dokumentasi) — terakhir, lebih ke pola pemakaian.
