---
name: clipper-pipeline
description: "Konvensi arsitektur & alur kerja CLIPPER — CLI Rust video short-form. PROACTIVELY activate saat: (1) menambah/mengubah stage pipeline (ingest/transcribe/analyze/edit), (2) menambah field schema serde, (3) menambah provider LLM, (4) kerja di modul news/reaction/narration, (5) sebelum melapor fitur selesai. Memuat: urutan build_cuda.bat → test wajib, aturan backward-compat serde, graceful degrade, dan kewajiban update BLUEPRINT.md."
version: 1.0.0
---

# CLIPPER Pipeline Conventions

CLIPPER = CLI Rust (2024 edition, Tokio async) yang mengotomasi pembuatan video short-form
viral dari long-form. Skill ini menjaga setiap perubahan selaras dengan arsitektur & aturan rilis.

## When to Use This Skill

- Menyentuh stage manapun: **INGEST** (yt-dlp) → **TRANSCRIBE** (Whisper CUDA) → **ANALYZE**
  (LLM multi-provider + vision + RAG) → **EDIT** (FFmpeg + GPU wgpu)
- Menambah field ke schema (`src/analyze/schema.rs`, dll.)
- Menambah provider LLM (`src/analyze/provider/`)
- Kerja di pipeline modul baru: `news/`, `reaction/`, `narration/`, `ingest/`
- **Sebelum** menandai fitur "selesai"

## Pipeline Map (rujukan cepat)

```
URL/File → INGEST(yt-dlp) → TRANSCRIBE(Whisper) → ANALYZE(LLM+Vision+RAG) → EDIT(FFmpeg+GPU)
src/ingest/   src/edit/(whisper)   src/analyze/         src/edit/
```

## How It Works — Aturan Wajib

### 1. Build & verifikasi (URUTAN TIDAK BOLEH DILANGGAR)
1. **`build_cuda.bat`** — full CUDA build, BUKAN cukup `cargo check`. Harus zero error & zero
   warning kritis. *(catatan: `cargo check`/`test` bisa jalan tanpa CUDA untuk iterasi cepat,
   tapi laporan "selesai" wajib lewat `build_cuda.bat`.)*
2. **`cargo test --bin clipper <modul>`** — jalankan test relevan, perbaiki yang fail dulu.
3. **Baru** tandai selesai + update `BLUEPRINT.md`.

### 2. Backward-compatible schema
- Field baru di struct serde **WAJIB** `#[serde(default)]` agar config/JSON lama tetap parse.

### 3. Graceful degrade
- Tiap fitur baru harus **degrade mulus** kalau disabled/unavailable (provider mati, GPU absen,
  asset hilang) — jangan panik/crash, turun ke fallback + `warn!`.

### 4. Logging
- `info!` progress penting · `warn!` degradasi · `debug!` detail.

### 5. Update BLUEPRINT.md (WAJIB tiap implementasi/perubahan status)
- Ubah status ❌→⚠️/✅, isi kolom "Implementasi" & "File", update persentase tabel, perbarui tanggal.

## Steps (checklist menambah fitur)

1. Baca `BLUEPRINT.md` (status + Gap Prioritas) sebelum mulai.
2. Implementasi; field schema baru → `#[serde(default)]`; sediakan fallback.
3. `build_cuda.bat` → zero error.
4. `cargo test --bin clipper <modul>` → hijau.
5. Update `BLUEPRINT.md`.
6. (Opsional) `graphify update .` untuk refresh knowledge graph.

## Guardrails / Anti-patterns

- ❌ Lapor "selesai" hanya dari `cargo check`. → Harus `build_cuda.bat`.
- ❌ Field serde tanpa `#[serde(default)]` → patah backward-compat.
- ❌ Hard-fail saat provider/GPU/asset absen → harus graceful degrade.
- ❌ Lupa update `BLUEPRINT.md`.
- ✅ Windows: pakai backslash `\` di path saat Edit/Write.

## Examples

> Task: tambah provider LLM baru.
> → tambah di `src/analyze/provider/`, field config `#[serde(default)]`, fallback kalau key
> kosong (`warn!` + skip), `build_cuda.bat`, test, update BLUEPRINT baris provider.
