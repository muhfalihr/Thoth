# PLAN — Build Footage: subject/object extraction + compound query + dedup main + filter reaction

> Status: **SELESAI & DEPLOYED** (2026-06-25). Sisi OpenClaw discovery saja, TIDAK menyentuh Rust/Thoth.
> Implementasi: footage_objects.js (kontrak {subjects,objects,people}+comments), build_footage.js (query majemuk + dedup main url/id/caption + filter reaction), run_pipeline.js (collect_comments dipindah sebelum build_footage). Verified: node --check ✓, live CLI test ✓ (nvidia→subjects[nvidia,gtc]/objects[chip ai,…]/people[jensen huang]). Deployed via sync.js push. Keputusan: enrichment orang = +1 query (object utama saja).
> File JS diedit di module `CLIPPER/openclaw/` lalu deploy via `node sync.js push`.

## Konteks alur saat ini (run_pipeline)
Urutan step sekarang: `seed → trace_source → build_footage (--per --max) → extract_figures → collect_comments → validate`.
- `build_footage.js` → `footage_objects.js` (LLM ekstrak OBJEK dari main.title + main.description) → per object jalankan `topic_to_urls.js obj --keywords obj` di platform tiktok,tw,ig,fb → pisah vids/posts → gate `relevant(caption, obj)` → story-gate cosine ke main → tulis `set.footage[]`.
- `footage_objects.js` SUDAH menentukan "subjek jangkar" secara internal (rule 1 & 3) tapi cuma keluarkan `objects[]` flat.

## Gap terkonfirmasi dari kode
1. **Konten sama dengan main bisa lolos:** di loop objek, `have` (build_footage.js:84) cuma berisi URL footage existing — `main.url` TIDAK dimasukkan. Cek `r.url === main.url` cuma di cabang profil (:108), bukan loop objek.
2. **Reaction = konsep yang sudah ada:** resolve_source.js:24 memperlakukan repost/reaction sebagai sumber yang harus di-resolve ke aslinya → footage berupa reaction = racun untuk b-roll.
3. **Komentar di-scrape SETELAH build_footage** → untuk enrich ekstraksi dari komentar, urutan harus diubah.

---

## 5 instruksi user
1. Ekstrak **subject** & **object** terpisah (bukan cuma object).
2. Footage hanya relevan ke keyword subject+object hasil ekstrak, **dan jangan ambil konten sama dengan main**.
3. **Luaskan keyword jadi query majemuk**: gabung object+subject ("chip ai" + "nvidia" → `"chip ai nvidia"`), opsional + nama orang/CEO (`"chip ai nvidia jensen huang"`).
4. Ekstrak subject+object **juga dari komentar** (sekarang cuma dari main).
5. **Jangan ambil footage dari konten reaction.**

---

## Perubahan per-file

### A. `footage_objects.js` — kontrak output jadi `{ subjects, objects, people }`
Evolusi, bukan rewrite (subject sudah ditentukan internal, tinggal diekspos & dipakai).
- Tambah param input `comments` (string gabungan teks komentar teratas).
- Prompt keluarkan JSON:
  ```json
  { "subjects": ["nvidia"], "objects": ["chip ai", "data center"], "people": ["jensen huang"] }
  ```
  - **subjects** = jangkar entitas inti: brand/org/event/tempat (1–3).
  - **objects** = benda/aktivitas konkret b-roll, ringkas (4–8), TIDAK perlu di-jangkar telanjang lagi (subject ditempel saat query).
  - **people** = tokoh terkait dari world-knowledge LLM, 0–2 (nvidia→jensen huang). Best-effort.
- Komentar masuk prompt sebagai blok `[KOMENTAR NETIZEN]` (kadang sebut nama/brand yang tak ada di caption).
- Return `{ subjects, objects, people }`. Update CLI print + `module.exports`.
- **Backward-safe:** satu-satunya importer = build_footage.js (diupdate). Input lama tetap didukung.

### B. `build_footage.js` — query majemuk, dedup main, filter reaction, baca komentar
1. **Ambil subjects/objects/people:**
   - `--objects` flag tetap (override manual → diperlakukan sebagai objects, subject kosong).
   - Default: `footageObjects({ description, headline, comments })`. Komentar dari `set.comments[]` (top-N by likes) bila ada.
2. **Compose query majemuk (instruksi #3):**
   - `primarySubject` = subjects[0].
   - Per object → query = `"{object} {primarySubject}"` (mis. `"chip ai nvidia"`). Subject kosong → fallback object telanjang (perilaku lama).
   - **Enrichment orang (opsional, capped +1):** untuk object PERTAMA saja, query ekstra `"{object} {primarySubject} {people[0]}"` (mis. `"chip ai nvidia jensen huang"`). Cap +1 search supaya tak meledak.
   - `searchObject` saat ini pakai `obj` untuk slug cache `topic_urls_<slug>.json` + `--keywords obj` → diganti pakai query majemuk (slug & keywords ikut query).
3. **Dedup terhadap main (instruksi #2):**
   - Seed `have` dengan `main.url`, `main.source_url`, `main.source_traced`.
   - Guard identitas konten: skip footage bila **video-id sama** dengan main (ekstrak id tiktok/yt/ig dari URL) ATAU **caption nyaris identik** dengan main.title/description (normalisasi + exact/prefix match). Cegah repost main ber-URL beda.
4. **Filter reaction (instruksi #5):**
   - Helper baru `looksReaction(text)` — regex konservatif: `\b(reaction|reaksi|bereaksi|ngereact|react(?:ing|s|ed)?|nonton bareng|nge-?react|reupload)\b`. JANGAN pakai "nonton"/"menonton" telanjang (over-filter).
   - Terapkan ke vids & posts: caption `looksReaction` → drop (hapus crop bila post). Log `(N drop reaction)`.
5. **Relevansi (instruksi #2):** pertahankan gate `relevant(text, object)` (token object distinktif = implisit on-subject karena query nempel subject) + story-gate cosine ke main.

### C. `run_pipeline.js` — reorder `collect_comments` SEBELUM `build_footage`
- Urutan baru: `seed → trace_source → collect_comments → build_footage → extract_figures → validate`.
- collect_comments tak bergantung footage (cuma butuh main hasil trace_source) → reorder aman.
- Graceful: `--no-comments`/komentar kosong → footage_objects jalan dari main saja.

---

## Koreksi/keputusan desain
- **Koreksi "extract subject":** footage_objects SUDAH menentukan subject internal — yang kurang = mengeluarkan & memakainya untuk query. Ubah kontrak, bukan modul baru.
- **Dedup identitas-konten** (bukan cuma URL) — main sering repost dengan URL beda.
- **Cap query orang ke +1 (object utama saja)** — query "object subject person" cenderung sempit; per-object = ledakan subprocess topic_to_urls. (User boleh minta lebih agresif → gandakan search.)
- **Reaction filter konservatif** — hindari "nonton" telanjang.

## Tidak diubah (sengaja)
- topic_to_urls.js, crop post, story-gate cosine, exclude curated aggregator — sudah benar.
- Tidak menyentuh Rust/Thoth.

## Verifikasi
- `node --check` ketiga file.
- CLI: `node footage_objects.js --headline "..." --desc "..."` → cek `{subjects,objects,people}`.
- Deploy `node sync.js push` setelah disetujui.

## Pertanyaan terbuka
- Enrichment nama orang dibatasi +1 query (object utama). Mau lebih agresif (tiap object + nama orang)? → menggandakan jumlah search.
