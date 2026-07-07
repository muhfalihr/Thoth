# FLSR-Informed Rage-Bait Narration — Design Spec

Date: 2026-07-08
Status: Approved (brainstorming), pending implementation plan

## Background

`FLSR_Content_Framework_Paper.docx` (kajian internal, Juli 2026) menjelaskan FLSR
Framework (Finding, Listing, Sorting, Recreating) — evolusi dari metode ATM — plus
kerangka pelengkap "Anatomi Winning Content": Start With Hook (3 detik pertama),
Build Tension (conflict/contrast/cliffhanger, berlandaskan Zeigarnik Effect +
curiosity gap Loewenstein 1994), Reveal The Solution, dan Call To Value (bukan CTA
generik — penegasan nilai/manfaat konkret bagi penonton).

Narasi Thoth (`src/narration/mod.rs::generate_script`) sudah pakai style
rage-bait dengan struktur HOOK → ISI (kasus + reaksi netizen) → PENUTUP
(pertanyaan tajam pemicu debat). Dibanding anatomi FLSR:

- HOOK ≈ Start With Hook — sudah cocok.
- ISI — progresif reveal kronologi, tapi TIDAK ada mekanik Build Tension yang
  disengaja (withhold info / curiosity gap eksplisit).
- PENUTUP — eksplisit MELARANG nasihat/value statement ("mematikan rage-bait"),
  berlawanan langsung dengan Call To Value.

Tujuan spec ini: selaraskan gaya rage-bait dengan anatomi FLSR di titik yang
genuinely compatible, tanpa mematikan mekanik engagement yang sudah terbukti
jalan.

## Scope

**Masuk scope:** `src/narration/mod.rs::generate_script` — string prompt (`user`
format!) saja. Signature fungsi, skema JSON output (`hook`/`narration`), dan
`parse_narration_reply` tidak berubah.

**Masuk scope (minimal):** framing precedence untuk `refs_block` (blok RAG
`narration_structures` yang disuntik tepat sebelum `STRUKTUR WAJIB` — lihat
`src/rag/store.rs` `NarrationRef.arc` + `pipeline/mod.rs` retrieval). Blok ini
bukan sistem terpisah — dia nempel di prompt yang sama, jadi harus dipastikan
tidak kontradiksi dengan instruksi baru.

**Di luar scope:**
- Re-tagging `scripts/narration/analyze_narration_structure.py` / skema
  Supabase `narration_structures` untuk menandai closing_type (debate vs
  value) — infra Python+Supabase terpisah, effort besar. Dicatat sebagai
  follow-up, tidak dikerjakan di sini.
- Finding/Listing/Sorting di `scout/` (discovery, enrichment, moment ranking)
  — itu menentukan DATA apa yang masuk (footage/comment/momen), bukan GAYA
  narasi. Concern berbeda dari yang diminta (gaya narasi rage-bait).

## Design

### 1. ISI dipecah jadi 3 sub-instruksi eksplisit

Struktur baru menggantikan `2. ISI (DUA LAPIS ...)` yang sekarang:

- **2a. Conflict/Contrast (opener tension):** lempar fakta "gila" secara
  parsial/tanpa detail penuh (curiosity gap) sebelum kupas detailnya —
  misalnya menyebut ada sesuatu yang bikin viral tanpa langsung membongkar
  apa itu.
- **2b. Detail Kasus (porsi terbesar, TIDAK berubah dari sekarang):**
  kronologi, tokoh, angka, lokasi — mengisi gap yang dibuka di 2a. Gaya sinis
  + heran tetap.
- **2c. Reaksi Netizen (pelengkap, TIDAK berubah dari sekarang):** 1-2
  komentar nyeleneh, parafrase, bukan tulang punggung narasi.

### 2. PENUTUP jadi dua mode

- **Mode A (existing, tidak berubah):** pertanyaan tajam spesifik ke kasus,
  pemicu debat.
- **Mode B (baru): Call-To-Value.** Penegasan insight/ironi tajam yang
  SPESIFIK ke kasus ini (bukan nasihat generik seperti "kita harus lebih
  selektif" — itu tetap dilarang). Value didapat lewat sudut pandang sinis
  yang tajam, bukan ceramah moral.
- LLM memilih mode berdasarkan konteks: Mode B saat kasus punya
  ironi/pelajaran yang bisa disampaikan tajam tanpa jadi ceramah; Mode A saat
  kasus lebih opini-terbelah/debatable.
- Larangan existing (LARANGAN KERAS: no profanity, no bahasa formal, no
  ceramah/nasihat generik, no sapaan alay) tetap berlaku ke KEDUA mode.

### 3. REFERENSI VIBE example diperbarui

Contoh few-shot sekarang linear (tanpa withhold-reveal opener, cuma
menunjukkan Mode A). Direvisi supaya menunjukkan conflict-opener → detail →
close Mode A, plus SATU baris kontras singkat untuk Mode B (bukan contoh
penuh kedua — hemat token, prompt sudah panjang).

### 4. RAG precedence clarification

`refs_block` (format di baris ~80-86 sekarang) ditambah satu kalimat: arc
yang di-retrieve dari corpus adalah inspirasi pola dari video eksternal (boleh
beda struktur), tapi `STRUKTUR WAJIB` di bawahnya yang mengikat kalau ada
konflik pola. Ini mencegah LLM lebih nurut ke contoh retrieved yang belum
tentu punya conflict-opener/dual-close daripada instruksi baru.

## Data flow (tidak berubah)

`source_text` → prompt (`SYSTEM` + `user`) → `provider.chat_completion_json`
→ `parse_narration_reply` → `(narration, hook)` → TTS (`synthesize_timed`) →
`Narration` struct. Tidak ada field baru, tidak ada perubahan tipe.

## Error handling

Tidak berubah — `parse_narration_reply` sudah tolerant terhadap truncation
dan key-agnostic; perubahan ini murni di isi instruksi teks, bukan di format
JSON yang diminta (`hook`/`narration` tetap sama).

## Testing / Verifikasi

- Unit test existing (`strip_punctuation`, `parse_narration_reply` — 4 test di
  `mod tests`, `src/narration/mod.rs:306+`) harus tetap pass — tidak ada
  logika yang disentuh.
- Sesuai CLAUDE.md: build via `build_cuda.bat` (bukan cuma `cargo check`),
  bukan `cargo test` saja.
- Verifikasi utama bersifat observasional (prompt-text change, bukan
  logic branch): jalankan satu pipeline run nyata, baca narasi yang
  dihasilkan, cek struktur muncul (conflict-opener → detail → reaksi →
  close Mode A/B) dan larangan (no ceramah generik, no profanity) tetap
  dipatuhi.

## Follow-up (tidak dikerjakan sekarang)

- Re-tagging closing_type di `scripts/narration/analyze_narration_structure.py`
  + kolom baru di tabel Supabase `narration_structures`, supaya retrieval RAG
  bisa bias ke arc yang punya closing type serupa dengan konteks kasus.
- Selaraskan FLSR Finding/Listing/Sorting secara eksplisit ke `scout/`
  (di luar scope narasi).
