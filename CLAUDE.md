# CLIPPER — Project Instructions for Claude

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
3. 🔴 **Reference Video Analyzer** — `clipper trend-analyze` command
4. 🔵 **Beat-sync SFX** — Sinkronisasi SFX ke beat musik
5. 🔵 **Full Adaptive Trend Learning** — Auto-update style dari TikTok/YT trending

## Aturan Update Blueprint

Setiap kali ada implementasi baru atau perubahan status, **langsung update `BLUEPRINT.md`**:
1. Ubah status dari ❌ → ✅ atau ⚠️
2. Isi kolom "Implementasi" dan "File"
3. Update persentase di tabel "Status Keseluruhan"
4. Perbarui tanggal di baris terakhir file

## Stack Teknis

- **Language:** Rust 2024 edition, async Tokio
- **Build:** `build_cuda.bat` (Windows, CUDA 13.2, LLVM)
- **FFmpeg:** Local `ffmpeg.exe` di root project
- **GPU:** NVIDIA NVENC untuk encoding, CUDA untuk Whisper
- **Config:** `config.toml` (no secrets) + `.env` (API keys)

## Konvensi Penting

- Semua perubahan harus bisa di-build dengan `build_cuda.bat` (zero errors)
- Gunakan `#[serde(default)]` untuk field baru di schema agar backward-compatible
- Setiap fitur baru harus graceful degrade jika disabled/unavailable
- Log level: `info!` untuk progress penting, `warn!` untuk degradasi, `debug!` untuk detail
