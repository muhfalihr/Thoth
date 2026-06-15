# PLAN — Animelorian Narrative Restructure + Meme/Humor Timing

> Status: **Part A + C + B SUDAH diimplementasi & diverifikasi (2026-06-02)** — lihat BLUEPRINT entry n & o.
> **Iterasi tersisa SELESAI (2026-06-04, entry v)** — dengan lensa OpenClaw (data faktual) ↔ Thoth (render):
>   - ✅ Montase lebih padat → config `montage_max_cuts` (tile footage pool tambahan per clip).
>   - ✅ Beat reaksi komentar → modul `edit/comment_card.rs` (kartu komentar screenshot dari `comments[]` OpenClaw) + SFX notif.
>   - ✅ Kartu IG kenalan real-data → `main.profile` OpenClaw (handle/follower/avatar ASLI) override tebakan LLM, foto di-composite.
>   - (meme template di beat reaksi sudah ada via Part B `meme_cues`; komentar kini melengkapinya.)
> Sumber analisis: `test/analysis/ANIMELORIAN_STRUCTURE.md`
> + frame `test/analysis/frames/v1|v2|v3`. Tujuan: hasil video tidak lagi "kaku" dan benar-benar
> mengikuti struktur naratif Animelorian + selera humor netizen.

## Context / Masalah

Output sekarang masih "beda jauh" & **kaku** karena 2 hal:
1. **Struktur salah**: tiap clip diperlakukan video independen ber-headline sendiri. Animelorian
   = SATU arc naratif menerus (hook → kenalan → kronologi → reaksi → punchline). Headline raksasa
   harusnya **hanya di hook (0–3s)**, bukan menempel di tiap konten. Hook juga terlalu ramai
   (headline + lower-third + callout + subtitle bareng).
2. **Tidak hidup / kaku**: meme reaksi belum dipasang di **momen & ekspresi yang tepat**. Video
   viral terasa "hidup" karena meme/SFX/zoom **mem-punctuate emosi** persis saat ekspresi subjek
   atau twist naratif terjadi. Tanpa itu, video terasa datar/kaku.

---

## PART A — Beat-Role Narrative Restructure

### A1. Beat-role mapping
- Tambah peran beat eksplisit ke tiap moment: `hook | intro | chronology | reaction | punchline`.
  - Sumber: LLM mengisi `beat_role` di schema (`src/analyze/schema.rs` `ViralMoment`), ATAU
    derivasi posisi (clip-0 = hook, clip terakhir = punchline, tengah = chronology) sebagai fallback.
- Render layer teks **sesuai beat saja** (lihat tabel).

### A2. Aturan layer per beat (WAJIB — jangan menumpuk)
| Layer | hook (0–3s) | intro (3–6s) | chronology | reaction | punchline |
|---|---|---|---|---|---|
| Headline raksasa multi-warna (`hook_title`) | ✅ **hanya di sini** | ❌ | ❌ | ❌ | ❌ |
| Subtitle berjalan (word-pop) | ❌ (kosong/minim) | ✅ | ✅ | ✅ | ✅ |
| Lower-third panel (`headline`) | ❌ | ❌ | ❌ | ❌ | ❌ (atau opsional) |
| Nama besar + kartu profil IG (`profile_card`) | ❌ | ✅ | ❌ | ❌ | ❌ |
| Callout angka + panah (`callout`) | ❌ | ❌ | ✅ (saat ada angka) | ❌ | ❌ |
| Screenshot komentar + meme template | ❌ | ❌ | ❌ | ✅ | ❌ |

### A3. Komposisi visual per beat
- **hook**: full-frame immersive (footage/subjek dominan) + 1 headline. TANPA base kertas-card,
  TANPA subtitle/callout/lower-third. (clip-0 sudah full-frame; tinggal bersihkan layer lain.)
- **intro/chronology/reaction**: base **kertas kusut** + footage **card tengah** + subtitle + (sesuai beat).
- Montase: ganti footage tiap 3–5s (sudah ada FootageCard; perlu lebih sering/lebih banyak sumber).

### A4. Perubahan kode (Part A)
- `src/analyze/schema.rs` + `prompt.rs`: tambah `beat_role` + instruksi LLM menetapkan peran beat
  & melarang headline di luar hook.
- `src/edit/service.rs`: gate render per beat_role —
  - `hook_title` hanya bila `beat_role==hook`;
  - `headline`(lower-third) dimatikan default;
  - `profile_card` hanya `intro`; `callout` hanya `chronology`; subtitle dimatikan/diminimalkan di `hook`.
- Reuse config existing (`hook_title`/`profile_card`/`callout`) — hanya ubah KAPAN dipanggil.

---

## PART B — Meme & Humor Timing (anti-kaku)

### B1. Prinsip selera humor netizen (yang harus "dipahami" sistem)
Meme reaksi harus **mendarat** persis di momen emosional, mencerminkan reaksi penonton:
- **Ekspresi match**: meme dipilih sesuai EMOSI momen (kaget→scream, kecewa→facepalm/bruh,
  konyol→Nick-Young-confused, bangga/keren→clapping/Yea-Boi, panik→sweaty-gamer, sedih-lebay→
  black-guy-crying, ironi/"oh gitu"→think-about-it/Leonardo-pointing, chaos→keyboard-smash).
- **Timing punch**: meme muncul **tepat saat** ekspresi subjek memuncak atau di **twist/punchline**
  kalimat — bukan acak. Durasi singkat (0.8–2s), **pop cepat** + **SFX nyala** (boom/bruh/scream),
  narasi di-duck di window-nya (sudah ada).
- **Beat-sync**: snap ke downbeat BGM bila ada (sudah ada beat_sync).
- **Kepadatan pas**: 1 meme per momen emosional kuat; jangan tiap detik (over = norak), jangan kosong
  panjang (= kaki/datar). Target: reaksi & punchline hampir selalu dapat 1 meme.
- **Placement**: reaction meme bisa **full-screen sticker** (chromakey) atau **PiP pojok** atau
  **template meme + screenshot komentar** (beat reaksi). Variasikan.

### B2. Mesin pemilih meme
- Reuse `assets/asset_catalog.json` (`is_meme`, `category`, `meaning_id` makna emosi, `energy`)
  + `assets/meme/*.mp4` (11 reaksi: confused/facepalm/keyboard-smash/leo-pointing/no-signal/
  yea-boi/crying/clapping/screaming/sweaty-gamer/think-about-it).
- LLM mengisi `meme_cues[]` (sudah ada `MemeCue` di `ffmpeg.rs`) dengan: `at_sec` (momen ekspresi/
  twist), `emotion`/`meaning` (match ke catalog), `with_audio`, `position`. Prompt diberi katalog
  meme + makna emosinya (mirip `asset_catalog::to_prompt_section`) agar LLM memetakan EMOSI→meme.
- Tambah sinyal ekspresi (opsional, kuat): pakai `vision` frame-scoring yang sudah ada untuk
  mendeteksi puncak ekspresi (kaget/ketawa) → kandidat `at_sec` meme. Fallback: LLM dari transcript
  (kata seru "anjir/gila/parah/yah" → emosi).

### B3. Perubahan kode (Part B)
- `src/analyze/schema.rs`: perkuat `meme_cues[]` (field `emotion`/`meaning`) + di `prompt.rs`
  inject katalog meme + aturan "pasang meme di puncak ekspresi/twist, match emosi, jangan acak".
- `src/edit/service.rs`: resolve `meme_cues` → file meme via catalog match (emotion→meaning_id),
  set `with_audio` + SFX pendamping + beat-snap (sebagian sudah ada).
- `src/edit/ffmpeg.rs`: variasi render meme (full sticker chromakey vs PiP) sudah sebagian ada
  (`build_meme_overlay_filter`); pastikan pop+SFX+duck aktif.

---

## PART C — Overlay Placement (konsisten, bukan random)

### C1. Masalah sekarang
Penempatan terasa **aneh/random**: footage card **loncat-loncat vertikal** tiap clip
(`card_y_off = [0,-120,120,-60,60][i%5]` di `service.rs`), meme PiP pindah pojok acak, dan
tidak ada zona tetap. Animelorian justru **NYAMAN karena KONSISTEN** — footage card selalu di
zona tengah yang sama (lihat frame v3 t=27s & t=31s: card identik posisinya), teks di zona tetap.

### C2. Layout zones tetap (9:16, 1080×1920) — semua beat patuhi grid ini
```
y 0      ┌───────────────────────────────┐  ← margin kertas (atas)
y ~120   │  ZONA ATAS: headline(hook) /   │
         │  caption / callout-label       │  (~0–22% / 0–420px)
y ~460   ├───────────────────────────────┤
         │                               │
         │   ZONA TENGAH: FOOTAGE CARD   │  (~24–76% / 460–1460px)
         │   (posisi & lebar KONSISTEN)  │     card center, lebar ~88%
         │                               │
y ~1460  ├───────────────────────────────┤
         │  ZONA SUBTITLE (word-pop)     │  (~76–88% / 1460–1690px)
y ~1690  ├───────────────────────────────┤
         │  ZONA REAKSI: meme/komentar   │  (~88–98%)
y 1920   └───────────────────────────────┘  ← margin kertas (bawah)
```

### C3. Aturan penempatan
- **Footage card**: posisi & skala **KONSISTEN** di zona tengah (center, lebar ~88%). **HAPUS**
  loncatan acak `[i%5]`. Montase cut menjaga card di posisi SAMA (sudah diperbaiki).
- **Variasi yang BOLEH** (halus & purposeful, bukan loncat posisi): slow zoom/ken-burns dalam card,
  atau sesekali **full-frame** untuk penegasan di momen klimaks. Default: diam & stabil.
- **Teks**: caption/label di ZONA ATAS; subtitle di ZONA SUBTITLE (tetap); jangan menimpa wajah/aksi.
- **Callout + panah**: label di zona atas, **panah menunjuk ke aksi DI DALAM card** (relatif ke
  objek), bukan koordinat acak.
- **Meme**: reaksi → **full-screen sticker** (chromakey) atau **PiP pojok KONSISTEN** (mis. selalu
  kanan-bawah di zona reaksi) atau **komentar+template meme** di zona reaksi. Jangan pindah pojok acak.
- **Hook**: full-frame (zona penuh), 1 headline di zona atas-tengah. Tidak ikut grid card.
- Semua elemen hormati **safe-area** 9:16 (hindari 8% tepi) agar nyaman & tidak ketabrak UI platform.

### C4. Perubahan kode (Part C)
- `src/edit/service.rs`: hapus/ubah `placement_variation` acak → posisi card TETAP; `card_y_off`
  default 0 (atau satu nilai konsisten); variasi opsional = skala/zoom, bukan posisi.
- `src/edit/ffmpeg.rs` (`build_video_filter` branch animelorian + `build_overlay_filter` FootageCard):
  kunci `y` card ke konstanta zona tengah; tambah opsi ken-burns ringan; callout/meme posisi dari zona tetap.
- `src/config.rs` `[animelorian]`: ganti `placement_variation: bool` → `card_motion` (`none|zoom`) +
  `card_y_anchor` (default center). Backward-compat via serde default.

## Files to modify (gabungan)
- `src/analyze/schema.rs` — `beat_role`, perkuat `meme_cues` (emotion/meaning).
- `src/analyze/prompt.rs` — instruksi beat-role + larangan headline non-hook + katalog meme + aturan humor.
- `src/edit/service.rs` — gate layer per beat_role; resolve meme by emotion; timing/SFX/duck/beat-snap.
- `src/edit/ffmpeg.rs` — pastikan variasi render meme + pop animation (kebanyakan sudah ada).
- Reuse: `asset_catalog.rs`, `MemeCue`, `hook_title`/`profile_card`/`callout`, FootageCard montase.

## Verifikasi
1. `build_cuda.bat` + `cargo test`.
2. Run pipeline "prabowo joget" / novita. Ekstrak frame & cek:
   - **hook (clip-0)**: HANYA headline (tanpa lower-third/callout/subtitle bertumpuk).
   - **konten**: TANPA headline raksasa; footage card di kertas + subtitle (+callout bila angka).
   - **momen emosi/twist**: meme reaksi muncul pop + SFX, match emosi, durasi singkat.
3. Tonton 1 clip utuh: terasa "hidup" (ada punch), bukan kaku.
4. Update `BLUEPRINT.md`.

## Staging (urutan kerja)
1. **A (struktur)** — dampak terbesar pada "benar/salah": headline hook-only + layer per beat.
2. **C (placement)** — hilangkan kesan random: zona tetap + card konsisten (cepat, bikin nyaman).
3. **B (meme/humor)** — bikin "hidup": meme by ekspresi + SFX + timing.
4. Iterasi: montase lebih padat (multi footage/beat), beat reaksi (komentar+meme template), kartu IG kenalan.

> Catatan: A & C sebaiknya sekaligus (keduanya ubah `service.rs`/`ffmpeg.rs` di area yang sama),
> baru lanjut B.
