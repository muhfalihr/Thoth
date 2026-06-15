# OpenClaw Module — Upstream Content-Sourcing untuk Thoth

Module ini adalah **source-of-truth ter-git** dari semua script JS yang berjalan di
`~/.openclaw/workspace` (runtime OpenClaw/Ella). Tugasnya: menemukan topik viral → merakit
**content-set JSON** `{main, footage[], comments[], figures[]}` → diserahkan ke pipeline Rust
via `thoth run --content <set.json>`.

> **Penting:** script TIDAK dijalankan dari folder ini. Runtime tetap di
> `~/.openclaw/workspace` (di sanalah key file `.novita_key`/`.groq_key`, folder `output/`,
> dan tab browser ter-attach berada). Edit di sini → deploy dengan `node sync.js push`.

---

## 1. Arsitektur & Peta File

### Library bersama (di-`require` script lain — jangan jalankan langsung)

| File | Fungsi |
|---|---|
| `cdp.js` | Koneksi Chrome DevTools Protocol ke relay **port 18792** (browser login user). Semua otomasi browser lewat sini. |
| `paths.js` | Konvensi lokasi tulis: `output/` (JSON) + `output/crops/` (PNG). |
| `verify.js` | oEmbed publik TikTok/YouTube (caption+author) + `matchesTopic` (gate keyword). |
| `validate.js` | Regex bentuk URL per-platform + `MEDIA_RE` (URL CDN langsung) + linter content-set. |
| `embed.js` | Embedding Novita (qwen3-embedding-8b): `cosine`, `rankBySimilarity` — kecocokan semantik. |
| `comments.js` | `normalizeLikes` ("1.2K"→1200) + prompt vision komentar (dipakai jalur deprecated). |
| `comment_engine.js` | Mesin scrape komentar DOM/CDP generik (anti-virtualisasi, crop pixel-perfect). |
| `ig_profile.js` | Ambil reels sebuah profil IG (URL+views+caption), sort views. |
| `tiktok_video.js` | Resolve TikTok page → **URL CDN mp4** (tikwm → fallback CDP). yt-dlp TikTok rusak; ini jalan keluarnya. |
| `threads_video.js` | Ekstrak `<video>.src` fbcdn dari post Threads. |
| `crop_post.js` | Crop post X/IG/FB/Threads pixel-perfect dari DOM (quoted-tweet disembunyikan). |
| `resolve_source.js` | LLM: tentukan SUMBER ASLI video repost dari deskripsi/caption/headline. |
| `footage_objects.js` | LLM: ekstrak OBJEK VISUAL (query b-roll) dari teks postingan. |

### Langkah pipeline (dipanggil orkestrator, bisa juga manual)

| File | Peran |
|---|---|
| `trace_source.js` | Anti re-wrap: cari video SUMBER ASLI dari kredit (`tt/user`, 📸 @user, dll) → ganti `main`. TikTok otomatis di-resolve ke CDN + backup mp4 lokal. |
| `build_footage.js` | Footage dari OBJEK cerita (per objek: video+post, di-gate relevansi) + reel relevan dari profil creator + story-gate embedding. |
| `extract_figures.js` | LLM: tokoh/organisasi subjek cerita → `figures[]`. |
| `collect_comments.js` | Komentar multi-sumber (main + footage + `--extra`), dedupe, sort likes, cap. **Krusial untuk narasi.** |
| `enrich_image_paths.js` | Crop post non-video → `image_path` + gate relevansi. |
| `search_news.js` | Google News/chart kurs → kartu image news ke `footage[]`. |
| `topic_to_urls.js` / `urls_to_contentset.js` | Search topik-string lintas platform → content-set dasar (jalur sekunder). |
| `validate_content_set.js` | Lint WAJIB sebelum hand-off. Exit 0 = aman. |
| `search_tiktok_v2.js` / `search_social_v2.js` | Fetcher search per-platform (dipakai topic_to_urls). |
| `scrape_comments.js` + `scrape_comments_{ig,x,yt,fb,reddit}.js` | Scraper komentar DOM per platform (dipakai collect_comments). |

### Entry-point utama

| File | Kapan dipakai |
|---|---|
| **`discover_reels.js`** | **Discovery topik utama.** Scan akun IG terkurasi (`ig_accounts.json`) → baca topik dari **HOOK on-screen (vision)** / **voiceover (Whisper)** — BUKAN caption — + filter recency `--hours`. |
| **`run_pipeline.js`** | **Orkestrator utama.** Satu URL reel/post → content-set LENGKAP: seed → trace_source → build_footage → extract_figures → collect_comments → validate. |
| `discover_topics.js` | Discovery sekunder: trending X/YouTube + mode `instagram` berbasis caption (cepat tapi sinyal lemah — caption sering nama lagu). |
| `vision_crop.js` | Fallback terakhir crop post dari screenshot manual (kalau CDP tak bisa). |
| `test_narration.js` | A/B prompt narasi antar model TANPA full run Thoth. |

### `deprecated/` — disimpan, jangan dipakai

| File | Kenapa deprecated | Pengganti |
|---|---|---|
| `run_topic.js` | Berangkat dari topik-STRING → content-set **tipis**: tanpa build_footage, tanpa figures, **tanpa comments** → narasi hambar. | `discover_reels.js` → `run_pipeline.js` |
| `batch_pipeline.js` | Orkestrator manual lama, komentar via vision (kurang akurat). | `run_pipeline.js` + `collect_comments.js` |
| `crop_comment_pipeline.js` | Crop komentar via vision bounding-box (meleset). | `scrape_comments.js` (DOM, exact) |
| `find_viral_urls.js` | Sweep profil TikTok news — orphan, tak dipakai flow mana pun. | `discover_reels.js` |

Semua file deprecated sudah dipatch (`require('../...')`) jadi tetap bisa dijalankan dari
`deprecated/` bila perlu referensi.

---

## 2. Prasyarat (sekali setup, lalu cek tiap sesi)

1. **Node host OpenClaw hidup** — inilah yang membuka CDP relay **18792**:
   ```powershell
   openclaw node status     # harus: running
   # cek port:
   node -e "fetch('http://127.0.0.1:18792/json/version').then(r=>console.log('OK',r.status)).catch(()=>console.log('DOWN'))"
   ```
   Terinstall permanen sebagai Scheduled Task **"OpenClaw Node"** (+ "OpenClaw Gateway" di 18789).
2. **Tab browser login & ter-attach** di Brave: minimal **instagram.com** + **tiktok.com**;
   tambah x.com / facebook.com / google.com sesuai platform yang dipakai. Tab harus DIBIARKAN terbuka.
3. **Key file di WORKSPACE** (bukan di module ini, tidak di-commit): `.novita_key` (LLM/vision/embedding),
   `.groq_key` (Whisper fallback discovery).
4. **Thoth** terbuild (`build_cuda.bat`) + `config.toml`: `[narration] enabled = true`.
   Default `--provider` CLI sudah **novita** (jangan pakai groq — rate limit 12k TPM bikin narasi
   diam-diam gagal dan video jatuh ke clip-mode).

---

## 3. FLOW OPTIMAL (jalur yang menghasilkan video terbaik)

Semua perintah dijalankan dari `~/.openclaw/workspace`:

### Step 1 — Discovery topik dari akun IG terkurasi

```bash
node discover_reels.js --max-per 4 --hours 48
```
- Akun diambil dari **`ig_accounts.json`** (edit file itu untuk ganti daftar; `--accounts a,b` meng-override).
- Topik dibaca dari **hook on-screen** (vision) → fallback **voiceover** (Whisper, butuh `.groq_key`).
- Output `output/reel_topics.json`, ranking views+recency. Pilih satu reel yang ceritanya jelas
  (ada kejadian/insiden konkret — bukan meme/musik doang).

### Step 2 — Reel terpilih → content-set lengkap

```bash
node run_pipeline.js "<URL_reel_terpilih>" --out topik_slug.json --per 2 --max 4 --cap 12
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
node -e "const{tiktokDirectUrl}=require('./tiktok_video');tiktokDirectUrl('<page_url>').then(d=>console.log(d))"
```
⚠️ **URL CDN tikwm/fbcdn EPHEMERAL (kedaluwarsa dalam hitungan jam) → lanjut ke Step 4 SEGERA.**

### Step 4 — Render di Thoth

```powershell
cd C:\Users\mfr\Documents\MyTools\CLIPPER
.\target\release\thoth.exe run --content "C:\Users\mfr\.openclaw\workspace\output\topik_slug.json"
```
(`--provider` default sudah novita → narasi voiceover sendiri jalan.)

**Tanda run yang BENAR di log:**
- `Stage 4/5: Narration (narrator voiceover)` … `🎙️ Narration script: NN words | hook: "..."` —
  TANPA `WARN Narration failed`
- Baris akhir `🎬 Narrator-driven video: ...` (bukan hanya `Clip N/N` = clip-mode)
- `🧠 Footage placement: embedding-matched ...` — kalau semua window `di-skip <floor`, lihat tuning di bawah
- `💬 Comment card(s)` muncul

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
| `[narration] target_secs` | Thoth `config.toml` | 45 | Panjang narasi (≈3 kata/detik). |

---

## 5. Troubleshooting

| Gejala | Akar | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:18792` di semua script | Node host mati (sering hilang setelah update OpenClaw) | `openclaw node status` → kalau stopped: `openclaw node start`. Kalau task hilang: `openclaw node install` lalu `start`. Kalau minta pairing: `openclaw devices list` → `openclaw devices approve <id>` → start ulang. Klik extension TIDAK menolong kalau node host mati. |
| `tab X belum ter-attach relay (skip)` | Tab platform itu tak terbuka/ter-attach | Buka tab login platform tsb di Brave, biarkan terbuka. |
| discover_reels: akun "kosong" | Grid reels IG virtualized tak render via CDP (akun besar/verified) | Known issue (≈4/10 akun). Pakai akun lain di daftar; atau buka profilnya manual di tab IG lalu rerun. |
| Narasi hambar / generik | `comments[] = 0` di content-set | Jalankan `node collect_comments.js <set.json> --extra <url_post_rame>`. |
| Video jadi clip-mode padahal narration enabled | Provider groq kena 429 (12k TPM) → narasi gagal diam-diam | Pastikan provider novita (default baru). Cek log: `Narration failed`. |
| yt-dlp gagal download TikTok | Extractor TikTok rusak + page 403 | Sudah ditangani `tiktok_video.js` (tikwm→CDN). Pastikan `main.url` = URL tiktokcdn, bukan page. |
| URL CDN expired saat thoth run | tikwm/fbcdn ephemeral | Pakai `main.source_local` (mp4 backup) atau re-resolve lalu run segera. |
| Lint FAIL `is_video:false TANPA image_path` | Crop post gagal (tab tak attach) | Attach tab platform itu → `node enrich_image_paths.js <set.json> --force`. |
| Footage semua di-skip `<floor 0.46` | Footage beda-angle dari narasi (normal untuk cerita niche) | Bukan bug. Turunkan `placement_min_similarity` kalau mau lebih banyak cutaway. |

---

## 6. Maintenance / sinkronisasi

```bash
# Edit kode DI MODULE INI (ter-git, di-review) lalu deploy ke runtime:
node sync.js push        # module  → ~/.openclaw/workspace

# Kalau ada hotfix langsung di workspace (mis. selector DOM berubah), tarik balik:
node sync.js pull        # workspace → module  → lalu commit di repo Thoth
```

Aturan:
- **Jangan pernah** menaruh/commit `.novita_key`, `.groq_key`, `api_key.txt` di module (sudah di-`.gitignore`).
- Selector DOM (IG/X/FB/TikTok) adalah bagian paling rapuh — kalau platform ganti layout, file yang
  diretune: `scrape_comments_*.js`, `crop_post.js`, `ig_profile.js`, `discover_reels.js`.
- Script baru: tulis di module → `sync.js push` → test di workspace → commit.
- Dokumentasi perilaku runtime yang lebih dalam: `~/.openclaw/workspace/TOOLS.md`.
