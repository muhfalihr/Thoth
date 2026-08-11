# Thoth — Runbook (manual, hasil terbaik)

Urutan command untuk menghasilkan satu video narator dari nol, sudah memasukkan semua
pelajaran dari bugfix 2026-06-17 (lihat `../BUGFIX_PLAN_2026-06-17.md`).

- **scout:** semua `bun` script dijalankan dari **`CLIPPER/scout/`**
  (di sanalah key `.novita_key`/`.groq_key`, folder `output/`, dan tab managed browser terbuka).
- **Thoth:** `target\release\thoth.exe` di repo ini.
- **Content-set hasil:** `scout/output/thoth_content_set.json`.

> ⚡ **Cara tercepat:** pakai runner `..\run_full.ps1` (lihat bagian akhir). Bagian di bawah
> menjelaskan tiap langkah manualnya kalau mau jalan satu-satu / debug.

---

## 0. Preflight (sekali per sesi)
```powershell
bun lib/browser.ts status
bun -e "fetch('http://127.0.0.1:18800/json/version').then(r=>console.log('CDP OK',r.status)).catch(()=>console.log('CDP DOWN'))"
```
Tab login **tiktok.com + instagram.com** (tambah x.com/facebook.com bila perlu) harus terbuka di
managed browser. `CDP DOWN` → `bun lib/browser.ts start` lalu login sekali di tab target.

## 1. Discovery topik (akun kurator IG)
> ⚠️ Long-running, **checkpoint per-item** (`reel_topics.json`, `"partial":true`). Jangan kill saat senyap.
```bash
bun pipeline/discover_reels.ts --max-per 4 --hours 48          # reels + feed post (default; --include reels|posts)
# + trending TikTok Studio region Indonesia (butuh tab tiktok.com login) → section `tiktok_trending`:
bun pipeline/discover_reels.ts --max-per 4 --hours 48 --tiktok   # --tiktok-region all untuk semua region
```
Memindai **reels (`/reel/`) DAN feed post (`/p/`)** — net topik lebih luas; post foto = kartu-berita
yang headline-nya terbaca vision. `--max-per` per tipe. Pilih **satu** item dengan kejadian fisik
konkret (bukan meme/musik), lihat field `kind` (`reel`/`post`), catat URL-nya.

## 2. Rakit content-set (orkestrator)
> ⚠️ **`build_footage` makan beberapa menit/objek dan DIAM** (sub-process silent) — itu NORMAL,
> bukan stuck. Jangan kill pada "(no new output)". Checkpoint per-stage & per-objek aktif.
```bash
bun pipeline/run_pipeline.ts "<URL_reel>" --out thoth_content_set.json --per 2 --max 4 --cap 12
```

**2b. Kalau footage tetap kosong** (run_pipeline ke-kill sebelum footage):
```bash
bun pipeline/build_footage.ts   output/thoth_content_set.json --per 2 --max 4
bun pipeline/extract_figures.ts output/thoth_content_set.json
```

## 3. Komentar (kalau main minim komentar)
> ✅ Pasca-fix Bug 1, `scrapers/scrape_comments.ts` MERGE (tak menghapus footage/description) — cocok via
> page-url / `source_url` / video-id.
```bash
bun pipeline/collect_comments.ts output/thoth_content_set.json --cap 12 --extra "<URL_post_rame>"
# atau refresh dari satu video rame:
bun scrapers/scrape_comments.ts "<URL_tiktok_rame>"
```

## 4. Crop post non-video (kalau ada footage X/IG/FB)
> ✅ Pasca-fix Bug 4, crop X lebih tahan re-render; yang gagal otomatis dibuang (lint lolos).
```bash
bun pipeline/enrich_image_paths.ts output/thoth_content_set.json --force
```

## 5. Validasi (WAJIB lolos sebelum render)
```bash
bun pipeline/validate_content_set.ts output/thoth_content_set.json
```
Target sehat: `MAIN` video (`is_video:true`), `FOOTAGE ≥ 2`, **`COMMENTS ≥ 6`**. Exit 0 = aman.

## 6. Render di Thoth
> ⚠️ URL CDN TikTok **ephemeral** → render SEGERA. Provider default `novita` (jangan `groq`).
```powershell
cd C:\Users\mfr\Documents\MyTools\CLIPPER
.\target\release\thoth.exe run --content "C:\Users\mfr\Documents\MyTools\CLIPPER\scout\output\thoth_content_set.json"
```

## 7. Tanda log run BENAR
- `🎬 Narrator-driven video: ~45s` — pasca-fix Bug 6 durasi = panjang narasi (B-roll pendek →
  `(looped from Ns source)`), bukan ~10s.
- `🖼️ AI cover … (Novita FLUX + rembg)`
- `💥 Hook title PNG … (Pillow)` (bukan `(ASS)`)
- `🎭 Reaction memes: N placed (LLM-matched …)`
- TANPA `WARN Narration failed`.

Output: `output\.thoth\<job-id>\clips\clip_000_narration.mp4`.

---

## Runner sekali jalan — `run_full.ps1`

Menyatukan semua langkah di atas. Ada di **root repo** (`C:\Users\mfr\Documents\MyTools\CLIPPER\run_full.ps1`).

```powershell
# 1) Discovery dulu (tanpa -Url) → cetak daftar kandidat + URL-nya:
.\run_full.ps1

# 2) Pilih satu URL dari daftar, lalu jalankan full pipeline → render:
.\run_full.ps1 -Url "https://www.instagram.com/<acct>/reel/<code>/"

# Dengan sumber komentar tambahan + knob:
.\run_full.ps1 -Url "<URL>" -Extra "https://www.tiktok.com/@kumparan/video/123" -Per 2 -Max 4 -Cap 12

# Berhenti sebelum render (cuma rakit + validate content-set):
.\run_full.ps1 -Url "<URL>" -SkipRender
```

Parameter: `-Url` (reel/post; kosong = discovery-only), `-Hours 48`, `-MaxPer 4`, `-Per 2`,
`-Max 4`, `-Cap 12`, `-Extra <url>[,<url>]`, `-Provider novita`, `-SkipRender`,
`-Discover` (paksa discovery saja), `-Workspace <path>`.

Yang otomatis ditangani runner: preflight CDP, discovery + cetak kandidat, run_pipeline,
**fallback build_footage/extract_figures kalau footage kosong**, collect_comments (kalau `-Extra`),
enrich_image_paths, validate (**abort kalau FAIL**), lalu render Thoth + cetak lokasi output.
Karena runner jalan **foreground/sinkron**, tidak ada masalah "premature kill" dari poll timeout —
biarkan saja build_footage berjalan walau diam beberapa menit.

---

## 8. Acquisition kernel — troubleshooting

Semua `pipeline/*.ts` akuisisi lewat `acquisition/index.ts` (lihat `scout/README.md` bagian 7 untuk
detail lengkap: env vars, fallback order, circuit breaker, aturan data sensitif). Yang paling sering
relevan saat debug lapangan:

- **"circuit is open (rate-limited/auth-required/challenge)"** — platform itu di-blok untuk SISA
  run ini (bukan bug transien). Login ulang di tab managed browser platform tsb, lalu jalankan
  ulang pipeline-nya (circuit breaker reset per-proses, tak persist antar-run).
- **Item yang baru saja tampil di satu tahap (mis. `itemFrame`) tiba-tiba "tak ada data" di tahap
  berikutnya untuk URL yang SAMA dalam satu run** — itu aturan one-navigation-per-URL kernel: visit
  KEDUA ke URL yang sama dalam satu run mendapat hasil visit PERTAMA (bukan navigasi baru). Ini
  tercatat sebagai keterbatasan yang diketahui di `pipeline/discover_reels.ts` (komentar `ponytail:`
  di sekitar `postShapeViaInspect`).
- **Hasil terasa "basi" padahal platform sudah update** — cache durable ada di
  `scout/output/acquisition-cache/v1/`. Hapus HANYA folder itu untuk memaksa fetch ulang:
  ```
  rm -rf scout/output/acquisition-cache/v1
  ```
  (tidak menyentuh content-set/crops lain di `scout/output/`).
- **`gallery-dl: command not found`-style warning di log startup** — aman diabaikan; `gallery-dl`
  opsional (`pip install gallery-dl` untuk mengaktifkan), kernel otomatis lanjut ke `direct-http`/
  `dom` untuk media gambar.
- **Verifikasi cepat kernel sehat**: dari `scout/`, `bun acquisition/boundary.test.ts` harus cetak
  `ok acquisition_boundary`, dan `bun run test:acquisition` harus diakhiri `ok acquisition_suite`.
