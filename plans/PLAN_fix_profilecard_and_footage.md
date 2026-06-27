# PLAN — Fix: profile card salah (subjek cerita, bukan creator) + footage selain main tidak muncul

> Status: **FIX A SELESAI & BUILD ✓** (2026-06-25). FIX B: news-fallback DITUNDA atas permintaan user; reorder run_pipeline + compound-query/dedup (sesi sebelumnya) sudah mencegah footage clobber, render path terverifikasi konsisten. Run contoh:
>
> **Selesai:** Rust profile card = creator-only (override→uploader→skip), `render_narration_video` terima `source_channel`; build_cuda ✓ zero error, 5/5 test profile_card ✓. trace_source.js selalu isi name/handle dari handle URL walau crop gagal (deployed). run_full.ps1 header order diperbarui.
> **Ditunda (atas permintaan):** auto `search_news.js --append` saat footage video tipis.
> `output/.thoth/243acfef-fbc2-4134-ae8b-46d80b690535/clips/clip_000_narration.mp4`
> Main: `https://www.tiktok.com/@theresalearns/video/7652761519230291218`
> Topik: "Orang Indonesia (Moka) memimpin tim pengembangan chip AI di NVIDIA".

## Diagnosis (dengan bukti)

### Bug 1 — profile card t≈5s menampilkan "Moka" (subjek cerita), bukan creator (theresalearns)
Rantai akar:
1. **OpenClaw**: content-set `main.profile` = `{name:"",handle:"",followers:"",avatar_url:""}` (KOSONG). Ini nilai SEED default `run_pipeline.js:81` + tulisan `scrape_comments_*.js` — artinya `trace_source` TIDAK mengisi profil creator (@theresalearns) untuk run ini.
2. **Rust `main.rs` (~527-543)**: tulis sidecar `content_profile.json` dari `set.profile` (= `main.profile`). Karena semua field kosong → `load_profile_override` (`profile_card.rs:40`) return `None` (guard: name/handle/image_path semua kosong).
3. **Rust `edit/service.rs` (~1911-1947, narration mode)**: tanpa override, card pakai `moment.character_name` = "Moka" (subjek cerita dari analisa LLM) sebagai identitas card → tampil "Moka".
4. Creator ASLI **tersedia tapi tak dipakai**: `info.json` uploader=`theresalearns`, channel="Theresa | Tech & Learnings" → sudah diparse Thoth jadi `VideoMeta.channel` (`ingest/service.rs:751`) dan tersedia di pipeline sebagai `video_channel` (`pipeline/mod.rs:80`).

Konflik desain: fitur asli `profile_card.rs` = "character intro" (nama subjek cerita). Niat baru (memory clipper-profile-card-crop): card t=5s = crop profil CREATOR. Saat creator tak ada, kode jatuh ke perilaku lama (subjek cerita) → salah menurut intent user.

### Bug 2 — tidak ada footage selain main (ROOT CAUSE DITEMUKAN)
Investigasi mendalam (live re-run build_footage + analisa statik):
1. Search MENGEMBALIKAN kandidat (13 utk "chip ai nvidia"). `duniagames`/`kumparan` TERNYATA bukan curated-aggregator → tidak ke-drop. Jadi 3 video + 9 post LOLOS gate awal (aggregator + dedup-main). collect_comments TERBUKTI innocent (pakai temp file, tak menimpa set). extract_figures TERBUKTI preserve footage.
2. **BUG ASLI (terkonfirmasi live):** build_footage hanya `slice(0, nVid)` + `slice(0, nPost)` kandidat TERATAS (PER=2 → 1 video + 1 post), proses 2 itu, dan kalau keduanya gagal gate relevansi/main → **BERHENTI, tak mencoba kandidat sisanya**. Log live: `• "chip ai nvidia" … +0v/0p (2 drop tak-relevan)` padahal masih ada banyak kandidat valid. Shortfall-fill lama cuma menambah PICK sebelum proses, bukan setelah drop.
3. **FIX:** ubah pick jadi "konsumsi kandidat sampai kuota terpenuhi" — iterasi SEMUA vids/posts, terapkan gate, push sampai `wantV`/`wantP` terpenuhi, lalu cross-fill shortfall dari tipe lain. (build_footage.js: `addVideo`/`addPost` helper + Pass 1/Pass 2.)

---

## FIX A — Profile card = CREATOR main video (bukan subjek cerita)

### A1. Rust (robust fallback) — `src/edit/service.rs` + mungkin `profile_card.rs`
- Saat **tidak ada** OpenClaw profile override DAN tak ada handle creator:
  - **Fallback ke uploader info.json** (`video_channel` / uploader) sebagai nama+handle card, BUKAN `character_name` cerita.
  - Prioritas identitas card: (1) `content_profile.json` override (crop OpenClaw), (2) uploader main video (`info.json`), (3) JANGAN render subjek cerita sebagai "profile card" (misleading) — skip card, atau pisahkan jadi label nama-di-atas-kepala saja.
- Pastikan perubahan kena DUA site (narration ~1911 & clip ~872-923).
- Perlu meneruskan uploader ke edit stage (cek apakah `video_channel`/uploader sudah sampai ke fungsi render profile card; bila belum, teruskan).

### A2. OpenClaw (sumber) — `trace_source.js` / `run_pipeline.js`
- Investigasi kenapa `main.profile` kosong untuk @theresalearns (handle jelas). Kemungkinan: trace_source bail/handle-extract gagal, atau set terakhir ditimpa scrape_comments.
- Perbaiki agar `main.profile.name/handle` SELALU terisi dari handle URL main meski crop gagal (graceful), dan `cropTiktokProfile` dijalankan untuk creator main.
- Pastikan urutan `run_pipeline` tidak menimpa profil/footage saat collect_comments menulis set (comment_engine merge harus pertahankan main.profile + footage; cek standalone scrape_comments_*.js jangan reset profil bila set sudah ada).

---

## FIX B — Footage selain main muncul

### B0. Reproduce dulu (wajib sebelum fix)
- Jalankan `node build_footage.js <set.json> --per 2 --max 4` pada content-set run ini, amati log per-gate (berapa drop aggregator / tak-relevan / reaction / main). Tentukan apakah footage benar 0 karena scarcity atau karena bug fold.

### B1. OpenClaw — atasi footage scarcity (aggregator-heavy)
- Bila kandidat habis ke-drop aggregator: tambah fallback footage **kartu berita** (`search_news.js --append`) saat footage video < target — sudah ada infranya, tinggal panggil dari build_footage/run_pipeline bila `footage.length` di bawah ambang.
- Pastikan compound query (subject+object) sudah membantu (chip ai nvidia) — verifikasi hasil non-aggregator lebih banyak dengan query baru.

### B2. Pastikan render pakai set yang sudah ber-footage
- Konfirmasi `thoth run --content <path>` menunjuk set yang SAMA dengan output build_footage (output/thoth_content_set.json), bukan set lama/stale. Cek run_full.ps1 / urutan langkah.

---

## Verifikasi
- Rust: `build_cuda.bat` (wajib, ada perubahan Rust) → zero error; `cargo test --bin thoth profile_card`.
- Re-run pipeline pada main yang sama → cek: (a) profile card = theresalearns/Theresa, (b) footage selain main muncul di video.
- OpenClaw: `node --check`, `node sync.js push`.

## Keputusan user (TERKUNCI 2026-06-25)
1. Profile card t≈5s = **akun pengunggah main** (theresalearns). BUKAN subjek cerita (Moka).
2. Bila creator tak bisa didapat sama sekali (no crop + no uploader) → **SKIP card** (jangan tampilkan apa pun). JANGAN fallback ke subjek cerita.
3. Footage news-card fallback → **AKTIF OTOMATIS** saat footage video di bawah ambang.

Implikasi konkret:
- Rust `character_name` cerita TIDAK BOLEH lagi jadi identitas profile card. Identitas card HANYA: (1) crop OpenClaw, (2) uploader info.json. Selain itu → skip.
- build_footage: setelah loop objek, bila `footage.length < ambang` (mis. < 2 video) → panggil `search_news.js --append` pakai subject utama untuk menambah kartu berita on-topik.
