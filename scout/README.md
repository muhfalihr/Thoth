# scout — Upstream Content-Sourcing untuk Thoth

Folder ini berisi semua script JS yang **menemukan topik viral → merakit content-set JSON**
`{main, footage[], comments[], figures[]}` → diserahkan ke pipeline Rust via
`thoth run --content <set.json>`.

> **Dijalankan langsung dari folder ini** (`CLIPPER/scout/`) — entrypoint tunggal
> **`node cli.ts <perintah>`** (tanpa argumen = daftar perintah). Credential terpusat di
> **`.env` root repo** (via `lib/env.ts` — tak ada lagi key file per-folder). Folder
> `output/` dan config akun ada di sini. Tak ada workspace terpisah — edit lalu jalankan.

> 🌐 **Browser CDP STANDALONE — tanpa extension/pihak-ketiga.**
> `node lib/browser.ts start` melaunch Brave/Chrome/Edge dengan `--remote-debugging-port`
> + profil khusus (`~/.clipper/browser-profile`) → menyajikan CDP di **port 18800**.
> Login sekali ke TikTok/IG/X di window itu; cookie persisten. `lib/cdp.ts` otomatis pakai
> endpoint ini (override via `THOTH_CDP`). Lihat header `lib/browser.ts` untuk penjelasan
> CDP lengkap.

> 🔧 **Setup pertama kali (key, browser, tab login):** baca **[SETUP.md](SETUP.md)** dulu.
> Dokumen ini (README) fokus ke *flow* sourcing harian.

## 0. Struktur Folder (modular, 2026-07)

```
scout/
├── cli.ts       # ★ ENTRYPOINT TUNGGAL: node cli.ts <perintah> [args] — dispatch ke semua script di bawah
├── lib/         # shared modules — di-require, tak dijalankan langsung (env, cdp, browser, paths, verify, …)
├── scrapers/    # akses per-platform: scrape_comments_*, *_profile, crop, search_*
├── pipeline/    # tahapan perakitan content-set: discover → trace_source → build_footage → …
├── enrich/      # konteks budaya: enrich_context, web_grounding, pulse_harvest, ckb
├── config/      # ig_accounts.json + curator_accounts.json (akun kurator)
└── deprecated/  # jalur lama (jangan pakai)
```

Semua path root (key file, `output/`, `config/`) diresolve via `lib/paths.ts::WORKSPACE`
(= folder `scout/` ini, berbasis `__dirname` bukan cwd) — script boleh dijalankan dari mana
saja. Panggil script pakai path folder: `node pipeline/discover_reels.ts`,
`node scrapers/crop_post.ts`, dst.

---

## 1. Arsitektur & Peta File

### Library bersama (di-`require` script lain — jangan jalankan langsung)

| File | Fungsi |
|---|---|
| `lib/env.ts` | **Credential terpusat**: parse `.env` ROOT repo sekali → `process.env` (shell env menang). `novitaKey()`, `groqKey()`, `supabaseUrl()`, `get()`. |
| `lib/browser.ts` | **Standalone CDP host** — launch Brave/Chrome/Edge sendiri (`--remote-debugging-port` + profil khusus) di **port 18800**. CLI: `start`/`status`/`stop`/`path`/`env`. |
| `lib/cdp.ts` | Koneksi Chrome DevTools Protocol ke managed browser **port 18800** (override `THOTH_CDP`). Semua otomasi browser lewat sini. |
| `lib/paths.ts` | Konvensi lokasi tulis: `output/` (JSON) + `output/crops/` (PNG). |
| `lib/verify.ts` | oEmbed publik TikTok/YouTube (caption+author) + `matchesTopic` (gate keyword). |
| `lib/validate.ts` | Regex bentuk URL per-platform + `MEDIA_RE` (URL CDN langsung) + linter content-set. |
| `lib/embed.ts` | Embedding Novita (qwen3-embedding-8b): `cosine`, `rankBySimilarity` — kecocokan semantik. |
| `lib/comments.ts` | `normalizeLikes` ("1.2K"→1200) + prompt vision komentar (dipakai jalur deprecated). |
| `lib/comment_engine.ts` | Mesin scrape komentar DOM/CDP generik (anti-virtualisasi, crop pixel-perfect). |
| `scrapers/ig_profile.ts` | Ambil reels sebuah profil IG (URL+views+caption), sort views. |
| `scrapers/tiktok_video.ts` | Resolve TikTok page → **URL CDN mp4** (tikwm → fallback CDP). yt-dlp TikTok rusak; ini jalan keluarnya. |
| `scrapers/threads_video.ts` | Ekstrak `<video>.src` fbcdn dari post Threads. |
| `scrapers/crop_post.ts` | Crop post X/IG/FB/Threads pixel-perfect dari DOM (quoted-tweet disembunyikan). |
| `pipeline/resolve_source.ts` | LLM: tentukan SUMBER ASLI video repost dari deskripsi/caption/headline. |
| `lib/footage_objects.ts` | LLM: ekstrak SUBJECT/OBJECT/PEOPLE (query b-roll majemuk) dari teks + komentar. |
| `enrich/web_grounding.ts` | Headline Google News (CDP, text-only) → status entitas TERKINI. Dipakai `enrich_context`. |
| `enrich/ckb.ts` | Cultural Knowledge Base: cache referensi/meme + pulse di **Supabase** (fallback lokal `ckb.json`). Butuh `npm install pg` + URL Supabase. |

### Langkah pipeline (dipanggil orkestrator, bisa juga manual)

| File | Peran |
|---|---|
| `pipeline/trace_source.ts` | Anti re-wrap: cari video SUMBER ASLI dari kredit (`tt/user`, 📸 @user, dll) → ganti `main`. TikTok otomatis di-resolve ke CDN + backup mp4 lokal. |
| `pipeline/build_footage.ts` | Footage dari OBJEK cerita (per objek: video+post, di-gate relevansi) + reel relevan dari profil creator + story-gate embedding. |
| `pipeline/extract_figures.ts` | LLM: tokoh/organisasi subjek cerita → `figures[]`. |
| `pipeline/collect_comments.ts` | Komentar multi-sumber (main + footage + `--extra`), dedupe, sort likes, cap. **Krusial untuk narasi.** |
| `enrich/enrich_context.ts` | LLM: decode subteks komentar → `references` (entitas/meme/slang) + `comments[].context` + `discourse` (sikap audiens). +web-grounding status terkini +cache CKB. Bikin narasi paham sarkasme & tak menyalahkan netizen. |
| `pipeline/enrich_image_paths.ts` | Crop post non-video → `image_path` + gate relevansi. |
| `scrapers/search_news.ts` | Google News/chart kurs → kartu image news ke `footage[]`. |
| `pipeline/topic_to_urls.ts` / `pipeline/urls_to_contentset.ts` | Search topik-string lintas platform → content-set dasar (jalur sekunder). |
| `pipeline/validate_content_set.ts` | Lint WAJIB sebelum hand-off. Exit 0 = aman. |
| `scrapers/search_tiktok_v2.ts` / `scrapers/search_social_v2.ts` | Fetcher search per-platform (dipakai topic_to_urls). |
| `scrapers/scrape_comments.ts` + `scrape_comments_{ig,x,yt,fb,reddit}.ts` | Scraper komentar DOM per platform (dipakai collect_comments). |

### Entry-point utama

| File | Kapan dipakai |
|---|---|
| **`pipeline/discover_reels.ts`** | **Discovery topik utama.** Scan akun IG terkurasi (`config/ig_accounts.json`) → **reels (`/reel/`) DAN feed post (`/p/`)** (`--include`, default keduanya) → baca topik dari **HOOK on-screen / cover image (vision)** / **voiceover (Whisper, video saja)** — BUKAN caption — + filter recency `--hours`. Tambah `--tiktok` untuk menyertakan **trending topics TikTok Studio** (lihat di bawah) sebagai pool seed terpisah. |
| `pipeline/discover_tiktok_trending.ts` | **Trending TikTok Studio.** Scrape ranking topik viral resmi TikTok dari `Inspiration → Trending` (judul topik + total views), **default region Indonesia** (auto-pilih dari dropdown; `--region` untuk ganti, `--region all` = semua). Standalone (`output/tiktok_trending.json`) atau dipanggil oleh `discover_reels --tiktok`. Butuh tab **tiktok.com login**. |
| **`pipeline/run_pipeline.ts`** | **Orkestrator utama.** Satu URL reel/post → content-set LENGKAP: seed → trace_source → collect_comments → build_footage → extract_figures → enrich_context → validate. |
| `enrich/pulse_harvest.ts` | **Cultural Pulse (cron harian).** Scrape komentar feed trending → distilasi tren diskursus + register gaya bahasa → CKB `ckb_pulse` (recency-decay). `--max`/`--per-video`/`--min-freq`. |
| `pipeline/discover_topics.ts` | Discovery sekunder: trending X/YouTube + mode `instagram` berbasis caption (cepat tapi sinyal lemah — caption sering nama lagu). |
| `scrapers/vision_crop.ts` | Fallback terakhir crop post dari screenshot manual (kalau CDP tak bisa). |
| `test_narration.ts` | A/B prompt narasi antar model TANPA full run Thoth. |

### `deprecated/` — disimpan, jangan dipakai

| File | Kenapa deprecated | Pengganti |
|---|---|---|
| `run_topic.ts` | Berangkat dari topik-STRING → content-set **tipis**: tanpa build_footage, tanpa figures, **tanpa comments** → narasi hambar. | `pipeline/discover_reels.ts` → `pipeline/run_pipeline.ts` |
| `batch_pipeline.ts` | Orkestrator manual lama, komentar via vision (kurang akurat). | `pipeline/run_pipeline.ts` + `pipeline/collect_comments.ts` |
| `crop_comment_pipeline.ts` | Crop komentar via vision bounding-box (meleset). | `scrapers/scrape_comments.ts` (DOM, exact) |
| `find_viral_urls.ts` | Sweep profil TikTok news — orphan, tak dipakai flow mana pun. | `pipeline/discover_reels.ts` |

Semua file deprecated sudah dipatch (`require('../...')`) jadi tetap bisa dijalankan dari
`deprecated/` bila perlu referensi.

---

## 2. Prasyarat (sekali setup, lalu cek tiap sesi)

1. **Managed browser hidup** — standalone CDP host di **18800**:
   ```powershell
   node lib/browser.ts status     # harus: UP
   node lib/browser.ts start       # kalau DOWN
   ```
2. **Tab browser login** di window managed itu: minimal **instagram.com** + **tiktok.com**;
   tambah x.com / facebook.com / google.com sesuai platform yang dipakai. Login persisten di
   profil `~/.clipper/browser-profile`, jadi cukup sekali.
3. **Credential di `.env` ROOT repo** (tidak di-commit; dibaca `lib/env.ts`):
   `THOTH_NOVITA_API_KEY` (LLM/vision/embedding), `THOTH_GROQ_API_KEY` (Whisper fallback discovery).
   - **CKB (Cultural Knowledge Base) — opsional, untuk `enrich_context`/`pulse_harvest`:** Supabase
     Postgres. Sediakan `THOTH_SUPABASE_URL` di `.env` root, lalu: `npm install pg`.
     Tanpa ini, CKB degrade ke cache lokal-JSON (`ckb.json`) — tetap jalan, tapi tidak lintas-mesin.
4. **Thoth** terbuild (`build_cuda.bat`) + `config.toml`: `[narration] enabled = true`.
   Default `--provider` CLI sudah **novita** (jangan pakai groq — rate limit 12k TPM bikin narasi
   diam-diam gagal dan video jatuh ke clip-mode).
5. **Python + Pillow + rembg** (untuk AI Cover & hook-title PNG renderer di Stage EDIT):
   ```powershell
   python -m pip install Pillow rembg onnxruntime
   ```
   `THOTH_NOVITA_API_KEY` (env Thoth, sudah ada) dipakai juga untuk: generate background cover
   (FLUX), deskripsi vision frame, dan pemilihan meme. **Tanpa Python/Pillow** → cover dilewati &
   hook title fallback ke libass (graceful, run tetap jalan).

---

## 3. FLOW OPTIMAL (jalur yang menghasilkan video terbaik)

Semua perintah dijalankan dari `CLIPPER/scout/` — bentuk kanonik lewat entrypoint tunggal
`node cli.ts <perintah>` (memanggil script langsung juga tetap bisa; flag identik):

> ⚠️ **`pipeline/discover_reels.ts` & `pipeline/run_pipeline.ts` itu LONG-RUNNING** (vision + whisper + multi-search,
> bisa >2 menit). Kalau dijalankan sinkron, shell bisa timeout di tengah jalan.
> **Jalankan via background session + poll** (bukan satu call sinkron):
> jalankan dengan `run_in_background`, lalu `process poll/log` sampai selesai. Keduanya **checkpoint
> ke disk** (`run_pipeline` per-stage; `discover_reels` per-reel dengan flag `"partial": true`),
> jadi kalaupun ke-kill, output yang sudah jadi tetap kepakai — cek file-nya sebelum rerun.
> Untuk meringankan: `discover_reels` boleh 1–2 akun per call, `run_pipeline` turunkan `--per/--max`.

### Step 1 — Discovery topik dari akun IG terkurasi

```bash
node cli.ts discover --max-per 4 --hours 48        # reels + post (default, net lebih luas)
node cli.ts discover --include posts               # hanya feed post (kartu berita foto)
node cli.ts discover --include reels               # perilaku lama (reels saja)
node cli.ts discover --tiktok                      # + trending TikTok Studio (region Indonesia, tab tiktok.com login)
node cli.ts trending --max 25                      # standalone: trending TikTok (region Indonesia) → output/tiktok_trending.json
node cli.ts trending --region "United States"      # region lain · --region all = semua region
```
- Akun diambil dari **`config/ig_accounts.json`** (edit file itu untuk ganti daftar; `--accounts a,b` meng-override).
- Memindai **reels (`/reel/`) DAN feed post (`/p/`)** — post foto sering justru kartu-berita yang
  headline-nya terbaca jelas oleh vision. `--include` memilih tipe (default `reels,posts`).
- `--max-per` berlaku **per tipe** (mis. `4` → ≤4 reel + ≤4 post per akun). Tiap entry `reel_topics.json`
  dapat field `kind` (`reel`/`post`); nama key JSON tetap `reels` (downstream tak berubah).
- Topik dibaca dari **hook on-screen / cover image** (vision) → fallback **voiceover** (Whisper, butuh
  `.groq_key`, **hanya item video**; post foto tak punya audio → langsung pakai hook vision).
- Output `output/reel_topics.json`, ranking views+recency. Pilih satu item yang ceritanya jelas
  (ada kejadian/insiden konkret — bukan meme/musik doang). Catatan: post foto biasanya tak punya
  view-count di grid → ter-rank lewat recency.

### Step 2 — Reel terpilih → content-set lengkap

```bash
node cli.ts run "<URL_reel_terpilih>" --out topik_slug.json --per 2 --max 4 --cap 12
```
Yang terjadi otomatis: caption di-fetch → **trace_source** (cari video sumber asli dari kredit;
TikTok di-resolve ke CDN mp4 + backup lokal) → **build_footage** (b-roll objek + reel relevan
profil creator) → **extract_figures** → **collect_comments** (multi-sumber, sort likes) → **validate**.

Cek ringkasan akhirnya — target minimal yang sehat:
- `MAIN` = video sumber (bukan repost ber-headline), `is_video:true`
- `FOOTAGE` ≥ 2 (campur video + kartu)
- `COMMENTS` ≥ 6 ← **kalau 0, narasi pasti hambar; ulangi collect_comments dengan `--extra <url>`**

### Step 3 — (Hanya jika main TikTok & belum ter-resolve) cek URL CDN

`trace_source` biasanya sudah mengisi `main.url` = CDN + `main.source_local` = mp4 backup.
Kalau `main.url` masih halaman `tiktok.com/@user/video/...`, resolve manual:
```bash
node -e "const{tiktokDirectUrl}=require('./scrapers/tiktok_video');tiktokDirectUrl('<page_url>').then(d=>console.log(d))"
```
⚠️ **URL CDN tikwm/fbcdn EPHEMERAL (kedaluwarsa dalam hitungan jam) → lanjut ke Step 4 SEGERA.**

### Step 4 — Render di Thoth

```powershell
cd C:\Users\mfr\Documents\MyTools\CLIPPER
.\target\release\thoth.exe run --content "C:\Users\mfr\Documents\MyTools\CLIPPER\scout\output\topik_slug.json"
```
(`--provider` default sudah novita → narasi voiceover sendiri jalan.)

**Tanda run yang BENAR di log:**
- `Stage 4/5: Narration (narrator voiceover)` … `🎙️ Narration script: NN words | hook: "..."` —
  TANPA `WARN Narration failed`
- Baris akhir `🎬 Narrator-driven video: ...` (bukan hanya `Clip N/N` = clip-mode)
- `🧠 Footage placement: embedding-matched ...` — kalau semua window `di-skip <floor`, lihat tuning di bawah
- `💬 Comment card(s)` muncul
- `🖼️ AI cover: "..." (3.0s, Novita FLUX + rembg)` — cover intro ter-generate (kalau Python/Novita
  gagal akan ada `WARN AI cover failed — falling back to hook title`, run tetap jalan)
- `💥 Hook title PNG: "..." (Pillow)` — judul render via Pillow (bukan `(ASS)` = fallback libass)
- `🎭 Reaction memes: N placed (LLM-matched, ...)` + baris `meme cue: <file>.mp4 at t=...` — meme
  reaksi full-layar tersisip sesuai emosi narasi (butuh `[assets] memes_in_narration = true`)

> **Catatan visual otomatis (Stage EDIT):** cover AI (FLUX + cutout rembg + headline), hook-title
> PNG (stroke tebal, rata kiri, warna per-baris), dan meme reaksi full-screen kini di-handle otomatis
> oleh Thoth — scout cukup menyediakan content-set yang sehat (main + footage + comments). Subtitle
> selalu di layer paling depan (tak tertutup footage/meme).

### Step 5 — QC cepat

```powershell
.\ffmpeg.exe -v error -i <clip.mp4> -vf "blackdetect=d=0.1:pic_th=0.98" -an -f null -   # kosong = tak ada frame hitam
.\ffmpeg.exe -v error -ss 15 -i <clip.mp4> -frames:v 1 qc.jpg -y                        # cek visual 1 frame
```

---

## 4. Tuning agar hasil optimal

| Knob | Lokasi | Default | Efek |
|---|---|---|---|
| `placement_min_similarity` | Thoth `config.toml` `[overlay]` | 0.46 | Turunkan ke ~0.40 → lebih banyak footage masuk montase; naikkan → lebih ketat (fallback B-roll main). |
| `THOTH_FOOTAGE_STORY_MIN` | env saat `build_footage` | 0.33 | Gate kasar buang footage beda-angle. Naikkan hati-hati (embedding domain-mirip skornya rapat ~0.4). |
| `--per` / `--max` (run_pipeline) | CLI | 2 / 4 | Footage per objek / objek maksimal. |
| `--cap` (run_pipeline) | CLI | 12 | Jumlah komentar maksimal. Jangan kecilkan — komentar = bahan narasi. |
| `--hours` (discover_reels) | CLI | 48 | Window recency topik. |
| `--include` (discover_reels) | CLI | `reels,posts` | Tipe item yang dipindai: `reels,posts` (default, net luas) · `reels` (lama) · `posts` (feed post saja). `--max-per` berlaku per tipe. |
| `--tiktok` / `--tiktok-max` / `--tiktok-region` (discover_reels) | CLI | off / 25 / Indonesia | Sertakan trending TikTok Studio → section `tiktok_trending` di `reel_topics.json` (pool seed terpisah, tak mencemari ranking views reel IG). Region default Indonesia (`--tiktok-region all` = semua). Butuh tab tiktok.com login. |
| `--region` (discover_tiktok_trending) | CLI | Indonesia | Region trending yang dipilih dari dropdown TikTok Studio. `all` / `All regions` = tak difilter. |
| `THOTH_REEL_HALFLIFE_H` | env saat `discover_reels` | 0 (off) | Ranking topik. 0 = pure-views (recency cuma gate+tiebreak). >0 = skor `views × 0.5^(umur/half-life)` → reel yg cepat viral (fresh) naik. Coba ~24 (≈window/2). |
| `[narration] target_secs` | Thoth `config.toml` | 45 | Panjang narasi (≈3 kata/detik). |
| `[cover] subject_mode` | Thoth `config.toml` | `auto` | `auto` (cutout asli kalau jelas, kalau gelap/blur → subjek AI) · `ai` (selalu generate) · `cutout` (selalu orang asli). |
| `[cover] duration_sec` | Thoth `config.toml` | 3.0 | Lama cover full-screen sebelum dissolve ke footage. |
| `[hook_title] engine` | Thoth `config.toml` | `python` | `python` (PNG Pillow, terbaik) · `ass` (libass fallback). |
| `[hook_title] text_align` / `line_spacing` | Thoth `config.toml` | `left` / 1.0 | Rata kiri + jarak baris rapat (gaya template). |
| `[assets] memes_in_narration` / `meme_fullscreen` | Thoth `config.toml` | true / true | Sisipkan meme reaksi LLM-matched, tampil full-layar. |
| `[assets] narration_max_memes` | Thoth `config.toml` | 3 | Maksimum meme per video. |

---

## 5. Troubleshooting

| Gejala | Akar | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:18800` di semua script | Managed browser belum jalan | `node lib/browser.ts status` → kalau DOWN: `node lib/browser.ts start`. |
| `Process exited with signal SIGKILL` saat discover_reels/run_pipeline | Step long-running ke-kill timeout runtime sebelum selesai | Jalankan via **background + poll** (lihat box di §3), jangan sinkron. Output partial sudah ke-checkpoint: cek `reel_topics.json` (`"partial": true`) / `thoth_content_set.json` — sering sudah cukup dipakai tanpa rerun penuh. Kalau perlu rerun, kecilkan beban (akun/`--per`/`--max` lebih sedikit). |
| `tab X belum ter-attach (skip)` | Tab platform itu tak terbuka | Buka tab login platform tsb di managed browser, biarkan terbuka. |
| discover_reels: akun "kosong" | Grid reels IG virtualized tak render via CDP (akun besar/verified) | Known issue (≈4/10 akun). Pakai akun lain di daftar; atau buka profilnya manual di tab IG lalu rerun. |
| Narasi hambar / generik | `comments[] = 0` di content-set | Jalankan `node pipeline/collect_comments.ts <set.json> --extra <url_post_rame>`. |
| Video jadi clip-mode padahal narration enabled | Provider groq kena 429 (12k TPM) → narasi gagal diam-diam | Pastikan provider novita (default baru). Cek log: `Narration failed`. |
| yt-dlp gagal download TikTok | Extractor TikTok rusak + page 403 | Sudah ditangani `scrapers/tiktok_video.ts` (tikwm→CDN). Pastikan `main.url` = URL tiktokcdn, bukan page. |
| URL CDN expired saat thoth run | tikwm/fbcdn ephemeral | Pakai `main.source_local` (mp4 backup) atau re-resolve lalu run segera. |
| Lint FAIL `is_video:false TANPA image_path` | Crop post gagal (tab tak attach) | Attach tab platform itu → `node pipeline/enrich_image_paths.ts <set.json> --force`. |
| Footage semua di-skip `<floor 0.46` | Footage beda-angle dari narasi (normal untuk cerita niche) | Bukan bug. Turunkan `placement_min_similarity` kalau mau lebih banyak cutaway. |

---

## 6. Maintenance

Aturan:
- **Jangan pernah** menaruh/commit `.novita_key`, `.groq_key`, `api_key.txt`, `.supabase_url` (sudah di-`.gitignore`).
- Selector DOM (IG/X/FB/TikTok) adalah bagian paling rapuh — kalau platform ganti layout, file yang
  diretune: `scrape_comments_*.ts`, `scrapers/crop_post.ts`, `scrapers/ig_profile.ts`, `pipeline/discover_reels.ts`.
- Script baru: tulis langsung di folder yang sesuai (`pipeline/`, `scrapers/`, `enrich/`) → test → commit.
