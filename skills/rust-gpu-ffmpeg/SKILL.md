---
name: rust-gpu-ffmpeg
description: "Pola GPU & media-processing Thoth di Windows: NVENC encoding, CUDA Whisper, shader wgpu (CapCut-ported color grading & transitions), dan integrasi ffmpeg.exe lokal. PROACTIVELY activate saat: (1) kerja di src/edit/ atau src/gpu/, (2) FFmpeg command building, (3) shader/transition/color grading, (4) NVENC/encoding params, (5) masalah path/binary di Windows. Memuat aturan path Windows, fallback CPU, dan konvensi pemanggilan ffmpeg lokal."
version: 1.0.0
---

# Rust GPU & FFmpeg (Windows)

Pola untuk lapisan akselerasi & media Thoth. Stack: NVIDIA NVENC (encode), CUDA (Whisper),
wgpu (shader CapCut-ported), `ffmpeg.exe` lokal di root project.

## When to Use This Skill

- Kerja di `src/edit/` (ffmpeg, overlay, color, transitions) atau `src/gpu/` (effect, processor, shader)
- Menyusun/men-tune perintah FFmpeg (encode, xfade, subtitle burn-in, SFX/BGM mux)
- Menambah/mengubah shader, transisi, atau color grading wgpu
- Tuning parameter NVENC
- Debug error path/binary spesifik Windows

## How It Works — Aturan

### FFmpeg lokal
- Gunakan **`ffmpeg.exe` di root project**, bukan asumsi PATH global. Resolve path-nya relatif
  root, quote kalau ada spasi.
- Build argumen sebagai list arg (hindari string shell mentah) untuk hindari masalah escaping Windows.

### Path Windows (KRITIS)
- Saat Edit/Write & saat menyusun path untuk FFmpeg: pakai backslash `\`. Hati-hati path dengan
  spasi → selalu quote.

### GPU dengan fallback (graceful degrade — lihat `thoth-pipeline`)
- **NVENC** untuk encode; kalau GPU/NVENC tak tersedia → fallback encoder CPU (`libx264`) + `warn!`.
- **CUDA Whisper** → fallback CPU bila CUDA absen.
- **wgpu shader/transisi** → kalau adapter GPU gagal init, degrade ke jalur FFmpeg `xfade`/filter
  CPU, jangan crash.

### Build
- Perubahan apa pun di lapisan ini: verifikasi via **`build_cuda.bat`** (CUDA 13.2 + LLVM), zero error.

## Steps (menambah efek/transisi GPU)

1. Implement shader/efek di `src/gpu/`; daftarkan di processor/effect registry.
2. Sediakan jalur fallback non-GPU (FFmpeg filter) + `warn!` saat degrade.
3. Jika ada param baru di config → `#[serde(default)]`.
4. `build_cuda.bat` → test render pendek → verifikasi output.
5. Update `BLUEPRINT.md` (baris GPU/efek).

## Guardrails / Anti-patterns

- ❌ Asumsi `ffmpeg` ada di PATH global. → Pakai `ffmpeg.exe` lokal.
- ❌ String shell mentah untuk argumen FFmpeg di Windows → escaping rapuh.
- ❌ Jalur GPU tanpa fallback CPU → crash di mesin tanpa NVENC/CUDA.
- ✅ Selalu uji satu render pendek setelah ubah encode/shader.

## Examples

> Task: tambah transisi wgpu baru.
> → shader di `src/gpu/`, register, fallback ke `xfade` FFmpeg, param `#[serde(default)]`,
> `build_cuda.bat`, render 3 detik untuk cek, update BLUEPRINT.
