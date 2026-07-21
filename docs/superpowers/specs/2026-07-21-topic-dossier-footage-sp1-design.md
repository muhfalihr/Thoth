# SP1 — Topic Dossier → Footage Search → Subtitle-Vision Filter

**Tanggal:** 2026-07-21
**Status:** Design (disetujui, siap writing-plans)
**Scope:** `scout/` (TypeScript) + perubahan additif kecil di `crates/thoth-core` (narasi).
**Sub-project berikutnya (TERPISAH, bukan di sini):** SP2 — Montage assembly (Rust `edit`: main + footage sebagai segmen full-frame, bukan overlay).

---

## 1. Masalah

Flow discover→run sekarang membangun content-set dengan urutan:

```
seed → trace_source(main) → collect_comments → build_footage → extract_figures → enrich_context
```

Dua kelemahan akar:

1. **Enrichment telat & dangkal untuk footage.** `enrich_context` jalan SETELAH `build_footage`, dan tujuannya hanya subteks budaya untuk narasi (`references[]` + `discourse{}`). Enrichment **tidak pernah** ikut menentukan footage apa yang dicari.
2. **Keyword footage dangkal & main-terkunci.** `build_footage` mencari footage dari `footageObjects()` — objek/subjek yang diekstrak hanya dari `main.title + main.description + komentar`. Tidak ada pemahaman topik yang lebih luas (entitas terkait, peristiwa, sudut cerita), sehingga footage sering sempit / kurang relevan dan narasi cenderung hanya "tahu" soal main.

Selain itu, footage hasil react/editan (yang punya subtitle burned-in / face-cam overlay) sering lolos karena filter reaction saat ini hanya **regex teks caption** (`REACTION_RE`), bukan pengecekan visual frame.

**Catatan:** "main video" TIDAK dihapus. Main tetap ada sebagai sumber (biasanya klip paling on-topik soal kejadiannya). Yang diubah adalah: enrichment jadi dalam & di depan, footage di-drive enrichment, dan footage react/subtitle disaring via vision.

## 2. Tujuan & Non-Tujuan

**Tujuan (SP1):**
- Stage `topic_dossier` baru di depan (perluasan `enrich_context`) → "Topic Dossier" sadar-relasi.
- `build_footage` mengonsumsi `dossier.search_queries` (primer) → footage lebih luas & relevan.
- Filter subtitle-vision saat seleksi footage → buang klip dengan caption ucapan / overlay react.
- Narasi mengonsumsi `entities/relations/angles` dari dossier (additif).

**Non-Tujuan (SP1):**
- Perubahan assembly/edit (main-base vs montage) → **SP2**.
- Knowledge graph penuh (node+edge+traversal) → dossier cukup research-brief sadar-relasi; graph adalah upgrade path bila brief-driven mentok.
- Analisa per-footage (transcribe/vision tiap klip untuk grounding narasi) → tidak perlu; narasi di-ground ke dossier + data main yang sudah ada.

## 3. Keputusan desain (terkunci)

| Keputusan | Pilihan |
|---|---|
| Bentuk enrichment | **Research brief sadar-relasi** ("Topic Dossier"), bukan knowledge graph penuh. |
| Main video | **Tetap ada**, tidak dihapus. |
| Sumber dossier | Pengetahuan model → `web_grounding` (berita terkini) → CKB cache. Masing-masing **best-effort**, degrade diam. |
| Query footage | `dossier.search_queries` **primer**; `footageObjects()` **fallback** bila dossier kosong. |
| Toleransi subtitle-vision | **Hanya buang caption ucapan / overlay react** (auto-caption TikTok, subtitle react, face-cam/PiP). **Biarkan** lower-third berita, logo, chyron, teks grafis asli. |
| Vision model filter | Reuse model vision Novita yang sudah dipakai scout (30b-a3b). |
| Ambil frame | ffmpeg 1 frame tengah dari URL CDN yang sudah di-resolve. Frame tak bisa diambil murah → **fallback text-gate saja** (jangan blokir; non-fatal). |
| Backward-compat | Semua field baru `#[serde(default)]`; run `--url` tanpa dossier tetap jalan (fallback ke perilaku sekarang). |

## 4. Arsitektur

### 4.1 Urutan scout baru

```
seed → trace_source(main) → collect_comments → topic_dossier(NEW) → build_footage(dossier-driven + subtitle-vision) → extract_figures → validate
```

`collect_comments` tetap sebelum dossier (komentar jadi bahan enrichment). `extract_figures` tetap setelah build_footage (bisa baca deskripsi footage).

### 4.2 Komponen

**A. `scout/enrich/topic_dossier.ts` (perluasan `enrich_context.ts`)**
- Satu unit: input = content-set (main + comments) → output = dossier ditulis balik ke content-set + sidecar.
- Reuse: prompt/parsing `enrich_context` (references/discourse/comment-context) + `web_grounding.groundTerms()` + `ckb`.
- Tambahan output dossier:
  - `entities[]` — `{term, kind, summary}` (sudah ada sebagai `references`, dipromosikan/dipetakan).
  - `relations[]` — kalimat "X — kaitan — Y" (edge sebagai teks, untuk narator).
  - `angles[]` — 3–5 sudut/sub-cerita (spine narasi).
  - `search_queries[]` — `{q, for}` (query footage konkret turunan; `for` = entitas/angle asal).
  - `timeline[]` — kronologi (opsional, kalau topik temporal).
- Best-effort: gagal (no key / no CDP / LLM error) → dossier kosong/partial, tak fatal.

**B. `scout/pipeline/build_footage.ts` (modifikasi)**
- Ganti sumber query: iterasi `dossier.search_queries` bila ada; jika kosong → `footageObjects()` (perilaku lama).
- `entities`/`relations` memperkuat gate relevansi (opsional; minimal reuse `relevant()` yang ada).
- Sisipkan **filter subtitle-vision** di jalur `addVideo()`: setelah kandidat lolos gate teks murah + resolve URL, ambil 1 frame tengah → vision check → tolak bila caption-ucapan/react. Kartu post (X/IG/FB non-video) TIDAK kena filter ini.

**C. `scout/lib/subtitle_vision.ts` (baru, unit kecil)**
- `hasReactionSubtitle(frameOrUrl): Promise<boolean>` — ambil frame (ffmpeg) + panggil vision Novita, prompt fokus membedakan **caption ucapan / react** (tolak) vs **lower-third berita / logo** (lolos).
- Frame gagal / vision gagal → return `false` (jangan buang; fallback text-gate). Non-fatal.

**D. `crates/thoth-core` — narasi (additif)**
- Loader dossier via `content_search` (pola `load_main_context`).
- `generate_narration` (`src/pipeline/mod.rs`) menambah blok `source_text`:
  - `[Entitas & Fakta]` ← `entities` + `relations`
  - `[Sudut Cerita]` ← `angles`
  - blok kronologi ← `timeline`
- Prompt narator (`src/narration/mod.rs`) diinstruksi tetap grounding; blok baru melengkapi yang lama.
- Tipe dossier di Rust: `#[serde(default)]`, tanpa `deny_unknown_fields`.

### 4.3 Kontrak data (content-set + sidecar)

Field baru di content-set JSON (semua `#[serde(default)]`):

```jsonc
{
  "main": { /* … tak berubah … */ },
  "footage": [ /* … tak berubah … */ ],
  "comments": [ /* … + comments[].context (sudah ada) … */ ],
  "references": [ /* sudah ada */ ],
  "discourse": { /* sudah ada */ },
  "dossier": {
    "topic": "…inti kejadian 1 kalimat…",
    "entities":      [ { "term": "", "kind": "person|org|place|event|meme|slang", "summary": "" } ],
    "relations":     [ "kalimat relasi antar-entitas" ],
    "angles":        [ "sudut/sub-cerita" ],
    "search_queries":[ { "q": "query footage", "for": "entity:… | angle:…" } ],
    "timeline":      [ "peristiwa berurut (opsional)" ]
  }
}
```

Sidecar mengikuti pola `content_context.json` (`MAIN_CONTEXT_FILE`) yang sudah ada untuk hand-off scout→Rust.

## 5. Error handling & degradasi

- **No Novita key / LLM error / no JSON** → dossier tak dibuat; `build_footage` fallback ke `footageObjects()`; narasi fallback ke blok lama. (pola `enrich_context` sekarang.)
- **No CDP / web_grounding gagal** → dossier tetap dari pengetahuan model; entitas tak ter-ground (tak fatal).
- **Frame/vision gagal** → klip TIDAK dibuang (fallback text-gate). Filter subtitle bersifat menambah presisi, bukan syarat.
- **Run `--url` biasa (tanpa content-set scout)** → tak ada dossier → semua jalur fallback ke perilaku lama.

## 6. Testing

- **`subtitle_vision`**: unit check membedakan frame caption-ucapan (tolak) vs lower-third berita (lolos) pada beberapa frame contoh; assert fallback `false` saat frame/vision gagal.
- **`build_footage`**: assert query bersumber dari `dossier.search_queries` bila ada, fallback `footageObjects()` bila kosong. `tsc --noEmit` 0 error.
- **Rust narasi**: `cargo test --bin thoth` untuk loader dossier + assembly `source_text` (dossier ada vs tak ada). Full `build_cuda.bat` sebelum tandai selesai (aturan CLAUDE.md).

## 7. Urutan implementasi (garis besar untuk writing-plans)

1. `topic_dossier.ts` (perluas enrich_context; tambah field dossier; pindahkan panggilan ke sebelum build_footage di `run_pipeline.ts`).
2. Kontrak dossier di content-set + sidecar.
3. `subtitle_vision.ts` + integrasi di `build_footage.addVideo()`.
4. `build_footage` konsumsi `dossier.search_queries` (fallback footageObjects).
5. Rust: loader dossier + blok grounding baru di `generate_narration`.
6. Validasi: `tsc --noEmit`, `cargo test`, `build_cuda.bat`; update `BLUEPRINT.md`.
