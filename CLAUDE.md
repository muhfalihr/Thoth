# Thoth — Project Instructions for Claude

## Context Memory

**WAJIB DIBACA di setiap sesi:** `BLUEPRINT.md` di root project ini.

File tersebut berisi:
- Blueprint arsitektur lengkap sistem Context Editing
- Status implementasi tiap komponen (✅ / ⚠️ / ❌)
- Gap prioritas yang perlu dikerjakan (lihat bagian "Gap Prioritas")
- Arsitektur Trend-Aware Editing system (Priority 3–6)
- Catatan teknis semua provider dan struktur file

**Prioritas yang BELUM diimplementasi (penting untuk masa depan):**
1. 🔴 **Style Profiles** — Named presets gaya editing trending (config.toml)
2. 🔴 **CapCut-style subtitle** — Animasi kata bold/berwarna dinamis
3. 🔴 **Reference Video Analyzer** — `thoth trend-analyze` command
4. 🔵 **Beat-sync SFX** — Sinkronisasi SFX ke beat musik
5. 🔵 **Full Adaptive Trend Learning** — Auto-update style dari TikTok/YT trending

## Aturan Update Changelog & Blueprint

**Setiap perubahan (kode, config, docs, fix, apa pun) WAJIB dicatat di `CHANGELOG.md`, BUKAN di `BLUEPRINT.md`.**
- Tambah entri pada kategori yang sesuai (`Added` / `Changed` / `Fixed`) di bawah tag rilis teratas — saat ini semua terkonsolidasi di `## [0.1.0]`; buat `## [Unreleased]` baru di atasnya hanya bila memang membuka siklus rilis berikutnya. Gaya Keep-a-Changelog.
- Detail teknis mendalam sekalipun ditulis sebagai bullet Keep-a-Changelog di `CHANGELOG.md` — **jangan** lagi menambah baris `*Last updated:*` naratif panjang di `BLUEPRINT.md`.

**`BLUEPRINT.md` HANYA diupdate saat _status implementasi_ berubah atau arsitektur berubah** — bukan untuk log perubahan harian:
1. Ubah status dari ❌ → ✅ atau ⚠️
2. Isi kolom "Implementasi" dan "File"
3. Update persentase di tabel "Status Keseluruhan"

## Stack Teknis

- **Language:** Rust 2024 edition, async Tokio
- **Build:** `build_cuda.bat` (Windows, CUDA 13.2, LLVM)
- **FFmpeg:** Local `ffmpeg.exe` di root project
- **GPU:** NVIDIA NVENC untuk encoding, CUDA untuk Whisper
- **Config:** `config.toml` (no secrets) + `.env` (API keys)

## ⚠️ Wajib Setelah Setiap Update Fitur

Setelah mengimplementasi atau mengubah kode, **URUTAN INI WAJIB**:

1. **Build dengan `build_cuda.bat`** — bukan hanya `cargo check`, harus full CUDA build:
   ```
   build_cuda.bat
   ```
   Pastikan zero errors dan zero warnings kritis sebelum lanjut.

2. **Testing** — jalankan unit test yang relevan:
   ```
   cargo test --bin thoth <modul>
   ```
   Jika ada test yang fail, perbaiki dulu sebelum melaporkan selesai.

3. **Laporkan hasil** — baru setelah build ✅ dan test ✅ selesai, tandai task completed dan catat perubahan di `CHANGELOG.md` (lihat "Aturan Update Changelog & Blueprint").

**Jangan** melaporkan fitur sebagai selesai hanya dari `cargo check` — harus full `build_cuda.bat`.

## Konvensi Penting

- Semua perubahan harus bisa di-build dengan `build_cuda.bat` (zero errors)
- Gunakan `#[serde(default)]` untuk field baru di schema agar backward-compatible
- Setiap fitur baru harus graceful degrade jika disabled/unavailable
- Log level: `info!` untuk progress penting, `warn!` untuk degradasi, `debug!` untuk detail

## Kontrak Interface: thoth-core ↔ adapters

`thoth-core` adalah SATU sumber kebenaran untuk tipe pipeline + orkestrasi.
Setiap perubahan pada permukaan publiknya (signature/tipe) WAJIB menyesuaikan
kedua adapter:
1. `crates/thoth` (CLI + worker) — dipaksa oleh compiler.
2. `crates/thoth-server` (REST/SSE) — dipaksa oleh compiler.
3. `dashboard/src/api.ts` — TIDAK dipaksa compiler. WAJIB diperbarui manual agar
   `JobSpec`/`JobRecord`/`SseEvent` di TS tetap cocok dengan tipe Rust. Ini satu-
   satunya langkah yang harus dijaga tangan (utoipa/OpenAPI ditunda ke Fase 3).

Worker channel: `thoth <cmd> --progress-json` mengeluarkan `ProgressEvent` NDJSON
di stdout; log manusia tetap di stderr. Jangan campur keduanya.

### Kontrak Interface: SQLite job-queue (thoth-server ↔ thoth worker)

`thoth-server` (REST/SSE) dan `thoth worker` (engine hangat) adalah **dua proses
peer yang independen** — tanpa parent/child, tanpa stdio antar-proses. Mereka
berkomunikasi HANYA lewat satu file SQLite (WAL) bersama. Dua crate leaf adalah
permukaan-kontrak antar keduanya:

1. **`crates/thoth-jobs`** — skema SQLite + tipe `JobSpec`/`JobRecord`/`JobStatus`/
   `JobEvent` + `JobStore` (enqueue/claim_next/append_event/finish/reap_stale/…).
   Diimpor oleh **thoth-server DAN thoth-core (worker)** → perubahan signature
   dipaksa compiler di kedua sisi.
2. **`crates/thoth-types`** — `ProgressEvent` (leaf wire type; thoth-server tak
   perlu link dep berat thoth-core).

Aturan sinkronisasi:
- **Perubahan skema SQL** WAJIB migration BARU di `crates/thoth-jobs/migrations/`
  (jangan edit migration lama — DB yang sudah ada tak akan re-run).
- **Perubahan tipe/method `thoth-jobs`** menyentuh KEDUA proses (compiler-enforced).
- **`dashboard/src/api.ts`** TIDAK dipaksa compiler → update manual bila
  `JobSpec`/`JobRecord`/`JobStatus`/`JobEvent` berubah (mis. status `cancelled`).
- Worker memiliki proses anak-nya (ffmpeg/whisper/python) di dalam prosesnya
  sendiri → cancel bersifat **kooperatif** via flag DB `cancel_requested`, BUKAN
  taskkill/kill process-tree. Lintas-platform tanpa hack OS.

## Kontrak Content-Set dari scout

Discovery 100% di layer **`scout/`** (script TypeScript di folder repo, jalan native via Bun, dijalankan langsung — lihat
`scout/README.md`). Thoth menerima **content-set JSON** via `thoth run --content set.json`
(loader: `src/ingest/content_search.rs::load_content_set`). Struktur:
`{ main: MainVideo, footage: [ContentResult], comments: [CommentInfo] }`, `main.profile` opsional.
Semua struct pakai `#[serde(default)]` + TANPA `deny_unknown_fields` → field JSON baru aman
(forward-compat, field tak dikenal diabaikan).

**Lokasi file hand-off:** semua content-set JSON + crop komentar ditulis scout ke folder
**`scout/output/`** (JSON) dan **`scout/output/crops/`** (PNG), lewat helper `lib/paths.ts`.
Default content-set: `output/thoth_content_set.json`; `comments[].image_path` menunjuk ke
`output/crops/comment_*.png` (path absolut). `thoth run --content` menerima path absolut apa pun,
jadi lokasi ini bebas — tapi saat membuat/membaca content-set hasil scout, cari di
`scout/output/`, bukan root.

### Field `image_path` (postingan non-video)

Saat URL `main`/`footage` **bukan video** (`is_video:false` — tweet teks, foto IG, status FB,
artikel), yt-dlp tak bisa download. **scout** lalu crop kartu postingan jadi PNG bersih →
kirim path-nya di field **`image_path`** (path absolut lokal) pada entry itu. **Cara utama
(2026-06-07): `scout/scrapers/crop_post.ts` — crop pixel-perfect dari DOM (X/IG/FB) via CDP**, bukan vision.
(`scout/scrapers/vision_crop.ts` qwen3-vl terbukti tak andal isolasi post → fallback terakhir saja.)

**Status di Rust:** field ini **belum dikonsumsi** — `enrichment::is_downloadable_video` mensyaratkan
`is_video:true`, jadi entry non-video tak masuk pool cutaway video (benar: bukan video yt-dlp).
Rencana implementasi (FOLLOW-UP, belum dikerjakan): tambah `image_path: String` (`#[serde(default)]`)
ke `ContentResult`/`MainVideo`, lalu render image statis itu sebagai **kartu visual** (mirip
`FootageCardCue`/`ImageBadgeCue` tapi sumber gambar diam, durasi terjadwal) untuk postingan non-video.
Sampai itu ada, `image_path` cuma diparse-diam (additive, tak memengaruhi run lama).

### Narasi grounding: `main.description` + `comments[]` (IMPLEMENTED)

Masalah lama: raw b-roll tanpa voiceover → transkrip Whisper nyaris kosong ("Terima kasih.")
→ LLM narasi **mengarang topik ngawur**.

Perbaikan: `generate_narration()` (`src/pipeline/mod.rs`) kini menyusun `source_text` dari
**gabungan blok**, bukan transkrip saja:
`[Judul]` (`main.title`) + `[Deskripsi]` (`main.description`) + `[Komentar Netizen Teratas]`
(top-12 by likes dari `content_comments.json`) + `[Deskripsi Visual]` (apa yang TERLIHAT di
layar — dari vision model `describe_video`, di-persist ke `analyze/video_descriptions.json`) +
`[Analisa Momen]` (ranked viral angle + vision note tiap momen, dari `moments.json`) +
`[Transkrip Audio]` (hanya jika ≥8 kata) + `[Video Terkait]` (subtitle enrichment). Prompt LLM
(`src/narration/mod.rs`) diinstruksi **WAJIB grounding** ke blok-blok itu, dilarang mengarang
topik di luar konteks. `[Deskripsi Visual]` + `[Analisa Momen]` lahir dari Thoth sendiri
(stage analyze), bukan scout — jadi tetap berfungsi untuk run `--url` biasa.

Kontrak baru:
- **`main.description`** (`#[serde(default)]` di `MainVideo`) — caption/deskripsi asli postingan.
  Ditulis main.rs ke sidecar **`content_context.json`** (`MAIN_CONTEXT_FILE`), dibaca narasi via
  `content_search::load_main_context`. **scout WAJIB mengisinya** (bawa topik saat audio kosong).
- **`footage[].query`** — keyword penemu footage. scout mengisi footage = hasil search dari
  keyword penting yang diekstrak dari title+description+komentar main (footage relevan, bukan acak).
- Empty-transcript tak lagi langsung `bail` — selama ada title/description/komentar, narasi jalan.

Graceful: untuk run `--url` biasa (tanpa content-set), `content_context.json` tak ada → narasi
fallback ke transkrip seperti sebelumnya.

### Narration Structure RAG (IMPLEMENTED)

Narasi juga di-*ground* ke korpus struktur narasi terbukti. `build_narration_structure_refs()`
(`src/pipeline/mod.rs`) meng-embed `source_text` lalu retrieve top-N struktur paling mirip dari
tabel Supabase **`narration_structures`** (`rag/store.rs::retrieve_narration_structures`), format
jadi blok "REFERENSI STRUKTUR" (arc/hook/pelajaran) yang disuntik ke prompt narator
(`narration/mod.rs::generate_script`). Korpus diisi oleh `scripts/narration/analyze_narration_structure.py`
(kirim URL referensi → beat-arc + hook_format/posture/punchline/lessons + embedding 4096-d).
Gating: `[narration] structure_rag` (default true) + `THOTH_SUPABASE_URL` + embed valid —
INDEPENDEN dari `[vector_db] enabled` (itu RAG momen). Degrade diam bila tak tersedia.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

<!-- headroom:learn:start -->
## Headroom Learned Patterns

*Auto-generated by `headroom learn` (analysis of 37 sessions / 6277 tool calls / 464 failures). The block between these markers may be overwritten on re-run — do not hand-edit.*

### Shell & Commands
- `python3` does NOT exist on this machine — only `python` (Anaconda 3.10). `python3` returns exit 127 `command not found`. Always use `python`.
- The Bash tool mangles Windows backslash paths (`ls "C:\Users\..."` → `cannot access 'C:Usersmfr...'` / `unexpected EOF`). In the Bash tool use **forward slashes** (`C:/Users/mfr/...`); use backslashes only in the PowerShell tool.
- Don't mix shells: `tail`/`head`/`Get-Content`/`Select-String` fail in PowerShell and vice-versa. In PowerShell use `Select-Object -Last N` (not `| tail`); in Bash use `rg`/`tail`.

### Build & Verify
- Invoke the CUDA build from PowerShell as `cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"` — bare `build_cuda.bat` (or Bash `cmd /c build_cuda.bat`) gives `'build_cuda.bat' is not recognized` / empty output. The leading `.\` is required.
- `cargo check` / `cargo test --bin thoth` run fine without CUDA for fast iteration; full `build_cuda.bat` only when reporting a feature done (per CLAUDE.md rules above).

### File Access Limits (use offset/limit, Grep, or a script — don't Read whole)
- `src/analyze/service.rs` is ~2401 lines and exceeds Read's 25k-token cap.
- Generated JSON/HTML under `.understand-anything/tmp/`, `test/scraper/*.html`, and `arch-input.json` routinely exceed the 256KB / 25k-token Read cap.
<!-- headroom:learn:end -->
