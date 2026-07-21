# SP1 — Topic Dossier + Dossier-Driven Footage + Subtitle-Vision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bangun stage enrichment "Topic Dossier" di depan pipeline scout yang men-drive pencarian footage + menyaring footage react/subtitle via vision, dan suntik dossier ke grounding narasi Rust — tanpa menghapus main video.

**Architecture:** Perluas `enrich_context.ts` yang sudah ada jadi `topic_dossier.ts` (tetap 1 panggilan LLM Novita + web_grounding + CKB), pindahkan panggilannya ke SEBELUM `build_footage`, dan tambah output `search_queries`/`entities`/`relations`/`angles`/`timeline`. `build_footage` mengonsumsi `search_queries` (fallback `footageObjects`) dan menambah filter subtitle-vision di jalur `addVideo`. Rust membaca `dossier` dari content-set → sidecar `content_context.json` → blok grounding baru di `generate_narration`.

**Tech Stack:** TypeScript (scout, dijalankan native via `node`/`bun`, type-stripping Node≥24, `tsc --noEmit` untuk cek tipe), Rust 2024 (thoth-core), Novita LLM+vision, ffmpeg (frame extraction).

## Global Constraints

- Semua field JSON baru pakai `#[serde(default)]` di Rust; struct content-set TANPA `deny_unknown_fields` (forward-compat).
- Setiap stage baru **best-effort**: gagal (no key / no CDP / LLM/vision/ffmpeg error) → degrade diam, pipeline lama tetap jalan. Run `--url` tanpa content-set scout HARUS tetap berjalan.
- Scout tak punya framework test → self-check = script `assert` polos dijalankan `node <file>` (type-stripping). Tak boleh nambah dependency test.
- Verifikasi akhir Rust WAJIB `cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"` dari PowerShell tool (bukan Bash), zero error, sebelum tandai selesai. `cargo test --bin thoth` untuk iterasi cepat.
- `python` (bukan `python3`). Path Bash tool pakai forward-slash.
- Log: `info!` progres, `warn!` degradasi. Scout log lewat `lib/ui.ts`, jangan hardcode ANSI.
- Update `BLUEPRINT.md` + tanggal di baris akhir setelah selesai.

---

### Task 1: Topic Dossier stage (scout) — `topic_dossier.ts` + reorder

**Files:**
- Create: `scout/enrich/topic_dossier.ts` (perluasan dari `scout/enrich/enrich_context.ts`)
- Create: `scout/enrich/dossier_parse.ts` (helper murni + testable)
- Create: `scout/enrich/dossier_parse.test.ts`
- Modify: `scout/pipeline/run_pipeline.ts:136-159` (pindahkan panggilan enrichment ke sebelum `build_footage`, ganti ke `topic_dossier.ts`)

**Interfaces:**
- Produces: `parseDossier(raw: string): Dossier | null` di `dossier_parse.ts`, dengan
  `type Dossier = { topic: string; entities: {term:string;kind:string;summary:string}[]; relations: string[]; angles: string[]; search_queries: {q:string;for:string}[]; timeline: string[] }`.
- Produces: content-set field `dossier` (bentuk `Dossier`) + `references`/`discourse` tetap seperti `enrich_context` sekarang.

- [ ] **Step 1: Tulis test gagal untuk `parseDossier`**

Create `scout/enrich/dossier_parse.test.ts`:

```ts
import assert from 'node:assert';
import { parseDossier } from './dossier_parse.ts';

// 1) JSON valid dengan noise di sekitar → terparse + ter-normalisasi.
const raw = `bla bla ${JSON.stringify({
  topic: '  Kasus X  ',
  entities: [{ term: ' Nvidia ', kind: 'ORG', summary: 'bikin chip' }, { term: '', summary: 'buang' }],
  relations: ['A kaitan B', '  '],
  angles: ['sudut 1', ''],
  search_queries: [{ q: ' chip ai ', for: 'entity:nvidia' }, { q: '' }],
  timeline: ['t1'],
  extra_field: 'diabaikan',
})} tail`;
const d = parseDossier(raw)!;
assert.equal(d.topic, 'Kasus X');
assert.equal(d.entities.length, 1);
assert.equal(d.entities[0].term, 'Nvidia');
assert.equal(d.entities[0].kind, 'org'); // di-lowercase
assert.deepEqual(d.relations, ['A kaitan B']);
assert.deepEqual(d.angles, ['sudut 1']);
assert.equal(d.search_queries.length, 1);
assert.equal(d.search_queries[0].q, 'chip ai');

// 2) Tak ada JSON → null (caller fallback).
assert.equal(parseDossier('maaf saya tidak bisa'), null);

// 3) JSON tanpa field dossier → objek kosong-aman (bukan throw).
const empty = parseDossier('{"topic":"t"}')!;
assert.deepEqual(empty.entities, []);
assert.deepEqual(empty.search_queries, []);

console.log('ok dossier_parse');
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `node scout/enrich/dossier_parse.test.ts`
Expected: FAIL — `Cannot find module './dossier_parse.ts'` / `parseDossier is not a function`.

- [ ] **Step 3: Implementasi `dossier_parse.ts`**

Create `scout/enrich/dossier_parse.ts`:

```ts
// dossier_parse.ts — parse + normalisasi output LLM Topic Dossier. Murni (tanpa I/O) → testable.
export type DossierEntity = { term: string; kind: string; summary: string };
export type DossierQuery = { q: string; for: string };
export type Dossier = {
  topic: string;
  entities: DossierEntity[];
  relations: string[];
  angles: string[];
  search_queries: DossierQuery[];
  timeline: string[];
};

const s = (v: unknown) => String(v ?? '').trim();
const strList = (v: unknown, cap: number) =>
  (Array.isArray(v) ? v : []).map(s).filter(Boolean).slice(0, cap);

export function parseDossier(raw: string): Dossier | null {
  const m = (raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: any;
  try { o = JSON.parse(m[0]); } catch { return null; }
  return {
    topic: s(o.topic),
    entities: (Array.isArray(o.entities) ? o.entities : [])
      .map((e: any) => ({ term: s(e.term), kind: s(e.kind).toLowerCase(), summary: s(e.summary) }))
      .filter((e: DossierEntity) => e.term && e.summary)
      .slice(0, 12),
    relations: strList(o.relations, 12),
    angles: strList(o.angles, 6),
    search_queries: (Array.isArray(o.search_queries) ? o.search_queries : [])
      .map((q: any) => ({ q: s(q.q), for: s(q.for) }))
      .filter((q: DossierQuery) => q.q)
      .slice(0, 16),
    timeline: strList(o.timeline, 12),
  };
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `node scout/enrich/dossier_parse.test.ts`
Expected: `ok dossier_parse`.

- [ ] **Step 5: Buat `topic_dossier.ts` dari `enrich_context.ts`**

Copy `scout/enrich/enrich_context.ts` → `scout/enrich/topic_dossier.ts`. Ubah:

1. Import parser: tambah `import { parseDossier } from './dossier_parse.ts';`.
2. Perluas `PROMPT` — tambah instruksi keluaran dossier. Ganti bagian akhir prompt (`Keluarkan HANYA JSON valid:` + skema) menjadi skema yang menyertakan field dossier:

```ts
Keluarkan HANYA JSON valid (satu objek):
{"references":[{"term":"","kind":"","summary":""}],
 "comments":[{"i":0,"context":""}],
 "discourse":{"audience_stance":"","themes":[""],"narration_guidance":""},
 "topic":"1 kalimat inti kejadian",
 "entities":[{"term":"","kind":"person|org|place|event|meme|slang","summary":"1 baris faktual"}],
 "relations":["kalimat: bagaimana 2 entitas berhubungan di cerita ini"],
 "angles":["3-5 sudut/sub-cerita untuk narasi"],
 "search_queries":[{"q":"kata kunci KONKRET untuk cari footage b-roll","for":"entity:<term> | angle:<n>"}],
 "timeline":["peristiwa berurut waktu (kosongkan bila topik tak temporal)"]}

ATURAN search_queries: 6-12 query. Setiap query = subjek/objek VISUAL yang bisa difilmkan
(orang, tempat, benda, brand, aksi) — BUKAN pertanyaan/opini. Sertakan subjek utama di tiap query.
```

3. Setelah blok yang menulis `set.references`/`set.discourse` (yang sudah ada, ~baris 135-165 di enrich_context), tambahkan penulisan dossier dari respons LLM yang SAMA:

```ts
  // ── Topic Dossier: field baru dari respons LLM yang sama (search_queries men-drive footage) ──
  const dossier = parseDossier(txt); // txt = raw LLM content (sudah ada di enrich())
  if (dossier) {
    set.dossier = dossier;
    console.log(`  📚 dossier: ${dossier.entities.length} entitas, ${dossier.search_queries.length} query, ${dossier.angles.length} sudut`);
  }
```

4. Ganti pesan `Usage:` + nama file di komentar header jadi `topic_dossier.ts`. Fungsi `enrich()` + `main` sisanya (write-back `set`, `fs.writeFileSync`) tetap.

- [ ] **Step 6: Pindahkan + ganti panggilan di `run_pipeline.ts`**

Modify `scout/pipeline/run_pipeline.ts`. Pindahkan enrichment ke SEBELUM `build_footage` dan ganti scriptnya. Ganti blok baris 149-156:

```ts
  step('build_footage (objek→footage)', 'build_footage.ts', [file, '--per', PER, '--max', MAX]);
  step('extract_figures (tokoh — main + footage)', 'extract_figures.ts', [file]);
  if (!NO_COMMENTS)
    step('enrich_context (referensi budaya + maksud komentar)', '../enrich/enrich_context.ts', [file]);
```

menjadi (dossier DULU, lalu build_footage, extract_figures tetap terakhir):

```ts
  // topic_dossier SEBELUM build_footage: search_queries-nya men-drive pencarian footage.
  // Best-effort; bila gagal, build_footage fallback ke footageObjects.
  if (!NO_COMMENTS)
    step('topic_dossier (enrich topik + query footage)', '../enrich/topic_dossier.ts', [file]);
  step('build_footage (dossier→footage)', 'build_footage.ts', [file, '--per', PER, '--max', MAX]);
  step('extract_figures (tokoh — main + footage)', 'extract_figures.ts', [file]);
```

- [ ] **Step 7: Cek tipe scout**

Run: `cd scout && npx tsc --noEmit`
Expected: 0 error.

- [ ] **Step 8: Commit**

```bash
git add scout/enrich/topic_dossier.ts scout/enrich/dossier_parse.ts scout/enrich/dossier_parse.test.ts scout/pipeline/run_pipeline.ts
git commit -m "feat(scout): topic_dossier stage before build_footage (dossier + search_queries)"
```

---

### Task 2: `build_footage` mengonsumsi `dossier.search_queries`

**Files:**
- Create: `scout/pipeline/footage_queries.ts` (helper murni)
- Create: `scout/pipeline/footage_queries.test.ts`
- Modify: `scout/pipeline/build_footage.ts:251-282` (sumber query) + `:405-411` (tasks)

**Interfaces:**
- Consumes: content-set `dossier.search_queries` (Task 1).
- Produces: `resolveFootageTasks(set, footageObjectsFn): Promise<{obj:string;query:string}[]>` — pakai `dossier.search_queries` bila ada, else fallback `footageObjectsFn`.

- [ ] **Step 1: Tulis test gagal**

Create `scout/pipeline/footage_queries.test.ts`:

```ts
import assert from 'node:assert';
import { resolveFootageTasks } from './footage_queries.ts';

// 1) Ada dossier.search_queries → dipakai; footageObjects TIDAK dipanggil.
let calledFallback = false;
const withDossier = {
  main: { title: 'T', description: 'D' },
  comments: [],
  dossier: { search_queries: [{ q: 'chip ai nvidia', for: 'entity:nvidia' }, { q: 'jensen huang', for: 'angle:1' }] },
};
const t1 = await resolveFootageTasks(withDossier, async () => { calledFallback = true; return { subjects: [], objects: [], people: [] }; });
assert.equal(calledFallback, false);
assert.deepEqual(t1.map((x) => x.query), ['chip ai nvidia', 'jensen huang']);
assert.deepEqual(t1.map((x) => x.obj), ['chip ai nvidia', 'jensen huang']);

// 2) Tak ada dossier → fallback footageObjects (objek + subjek utama).
const noDossier = { main: { title: 'T', description: 'D' }, comments: [] };
const t2 = await resolveFootageTasks(noDossier, async () => ({ subjects: ['nvidia'], objects: ['chip ai'], people: [] }));
assert.equal(t2.length >= 1, true);
assert.equal(t2[0].query.includes('chip ai'), true);

console.log('ok footage_queries');
```

- [ ] **Step 2: Jalankan, pastikan GAGAL**

Run: `node scout/pipeline/footage_queries.test.ts`
Expected: FAIL — module tak ada.

- [ ] **Step 3: Implementasi `footage_queries.ts`**

Create `scout/pipeline/footage_queries.ts`:

```ts
// footage_queries.ts — tentukan daftar {obj, query} untuk build_footage.
// Primer: dossier.search_queries (dari topic_dossier). Fallback: footageObjects (objek+subjek main).
type Task = { obj: string; query: string };
type FootageObjects = { subjects: string[]; objects: string[]; people: string[] };

// composeQuery: objek + subjek utama (dipindah dari build_footage agar reusable & testable).
export function composeQuery(obj: string, subject: string): string {
  if (!subject) return obj;
  const o = (obj || '').toLowerCase();
  const hit = subject.toLowerCase().split(/\s+/).some((t) => t.length >= 3 && o.includes(t));
  return hit ? obj : `${obj} ${subject}`;
}

export async function resolveFootageTasks(
  set: any,
  footageObjectsFn: (input: { description: string; headline: string; comments: string }) => Promise<FootageObjects>,
  topComments: (set: any) => string = () => '',
): Promise<Task[]> {
  const q = set?.dossier?.search_queries;
  if (Array.isArray(q) && q.length) {
    // Query dossier LANGSUNG jadi obj+query (obj = query, dipakai sebagai gate token & field footage.query).
    return q.map((e: any) => String(e.q || '').trim()).filter(Boolean).map((query: string) => ({ obj: query, query }));
  }
  // Fallback: footageObjects lama.
  const main = set.main || {};
  const ex = await footageObjectsFn({ description: main.description || '', headline: main.title || '', comments: topComments(set) });
  const primarySubject = ex.subjects[0] || '';
  const tasks: Task[] = ex.objects.map((obj) => ({ obj, query: composeQuery(obj, primarySubject) }));
  if (ex.people[0] && ex.objects[0] && primarySubject)
    tasks.push({ obj: ex.objects[0], query: `${composeQuery(ex.objects[0], primarySubject)} ${ex.people[0]}` });
  return tasks;
}
```

- [ ] **Step 4: Jalankan, pastikan LULUS**

Run: `node scout/pipeline/footage_queries.test.ts`
Expected: `ok footage_queries`.

- [ ] **Step 5: Pakai helper di `build_footage.ts`**

Modify `scout/pipeline/build_footage.ts`:

1. Tambah import: `import { resolveFootageTasks } from './footage_queries.ts';`.
2. Ganti blok ekstraksi objek (baris ~251-282, dari `let subjects = [], ...` s/d `if (!objects.length && !profileUser) {...}`) — pakai helper. Ganti `const tasks = objects.map(...)` + enriched-query push (baris ~405-411) dengan hasil `resolveFootageTasks`. Kode pengganti (letakkan setelah `profileUser` di-resolve, sebelum loop `for (const {obj, query} of tasks)`):

```ts
  const tasks = await resolveFootageTasks(
    set,
    (input) => footageObjects(input),
    (s) => topComments(s),
  );
  console.log(ui.rule());
  console.log('  Build Footage' + (set.dossier?.search_queries?.length ? ' (dossier-driven)' : ' (footageObjects fallback)'));
  console.log(ui.rule());
  if (!tasks.length && !profileUser) {
    console.log('Tak ada query/objek. Selesai.');
    process.exit(0);
  }
```

Hapus deklarasi lama `subjects/objects/people`, `primarySubject`, `composeQuery` lokal, dan `const tasks = objects.map(...)` beserta blok enriched-query yang digantikan. `primarySubject` yang masih dipakai di blok TWITTER (baris ~592) diganti: turunkan dari `tasks[0]?.query` atau `main.title` — ganti `twQuery` jadi:

```ts
    const twQuery = (main.title || '').trim() || (tasks[0]?.query || '');
```

Blok `profileUser` (IG reels) yang memakai `objects`/`main.title` untuk ranking: ganti referensi `objects` dengan `tasks.map(t => t.query)` untuk token relevansi.

- [ ] **Step 6: Cek tipe**

Run: `cd scout && npx tsc --noEmit`
Expected: 0 error.

- [ ] **Step 7: Commit**

```bash
git add scout/pipeline/footage_queries.ts scout/pipeline/footage_queries.test.ts scout/pipeline/build_footage.ts
git commit -m "feat(scout): build_footage consumes dossier.search_queries (footageObjects fallback)"
```

---

### Task 3: Filter subtitle-vision di seleksi footage video

**Files:**
- Create: `scout/lib/subtitle_vision.ts`
- Create: `scout/lib/subtitle_vision.test.ts`
- Modify: `scout/pipeline/build_footage.ts` (`addVideo`, setelah resolve URL CDN)

**Interfaces:**
- Consumes: URL video CDN (dari `tiktokDirectUrl`) + `ffmpeg.exe` root project.
- Produces:
  - `classifyVisionText(resp: string): boolean` — parse respons vision → `true` bila caption-ucapan/react (BUANG).
  - `hasReactionSubtitle(videoUrl: string): Promise<boolean>` — ambil frame + vision; error → `false` (jangan buang).

- [ ] **Step 1: Tulis test gagal untuk `classifyVisionText`**

Create `scout/lib/subtitle_vision.test.ts`:

```ts
import assert from 'node:assert';
import { classifyVisionText } from './subtitle_vision.ts';

// Vision diinstruksi balas JSON {"reject":bool,"why":""}. Uji parsing + default aman.
assert.equal(classifyVisionText('{"reject":true,"why":"auto-caption ucapan"}'), true);
assert.equal(classifyVisionText('noise {"reject":false,"why":"lower-third berita"} noise'), false);
assert.equal(classifyVisionText('model ngaco tanpa json'), false); // tak yakin → jangan buang
assert.equal(classifyVisionText(''), false);
console.log('ok subtitle_vision');
```

- [ ] **Step 2: Jalankan, pastikan GAGAL**

Run: `node scout/lib/subtitle_vision.test.ts`
Expected: FAIL — module tak ada.

- [ ] **Step 3: Implementasi `subtitle_vision.ts`**

Create `scout/lib/subtitle_vision.ts`:

```ts
// subtitle_vision.ts — buang footage video yang punya CAPTION UCAPAN / overlay REACT (auto-caption
// TikTok, subtitle react, face-cam/PiP). BIARKAN lower-third berita, logo, chyron. Best-effort:
// frame/vision gagal → false (jangan buang; fallback ke text-gate build_footage).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { novitaKey } from './env.ts';

const KEY = novitaKey();
const MODEL = process.env.THOTH_VISION_MODEL_JS || 'qwen/qwen3-vl-30b-a3b-instruct';
const FFMPEG = process.env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');

const PROMPT =
  `Lihat frame video ini. Jawab HANYA JSON {"reject":bool,"why":"<=8 kata"}.\n` +
  `reject=true HANYA jika ada: (a) subtitle transkrip UCAPAN yang di-burn-in (auto-caption gaya TikTok/CapCut, ` +
  `teks kata-per-kata mengikuti omongan), ATAU (b) overlay REACT — wajah orang/webcam menimpa klip (face-cam/PiP), reupload react.\n` +
  `reject=false untuk: lower-third berita, logo channel, watermark, headline grafis, teks judul singkat, tanpa teks.`;

// Parse respons vision → true bila BUANG. Tak ada JSON / ragu → false (aman).
export function classifyVisionText(resp: string): boolean {
  const m = (resp || '').match(/\{[\s\S]*?\}/);
  if (!m) return false;
  try { return JSON.parse(m[0]).reject === true; } catch { return false; }
}

// Ambil 1 frame tengah → data URL base64 JPEG. Gagal → null.
function midFrameDataUrl(videoUrl: string): string | null {
  const tmp = path.join(os.tmpdir(), `subv_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    // -ss 50% via -sseof tak andal untuk stream; pakai -ss di ~3s (cukup untuk lihat caption yg muncul).
    execFileSync(FFMPEG, ['-y', '-ss', '3', '-i', videoUrl, '-frames:v', '1', '-vf', 'scale=512:-1', '-q:v', '5', tmp],
      { stdio: 'pipe', timeout: 30000 });
    const b64 = fs.readFileSync(tmp).toString('base64');
    return `data:image/jpeg;base64,${b64}`;
  } catch { return null; }
  finally { try { fs.rmSync(tmp); } catch {} }
}

export async function hasReactionSubtitle(videoUrl: string): Promise<boolean> {
  if (!KEY || !videoUrl) return false;
  const img = midFrameDataUrl(videoUrl);
  if (!img) return false; // frame gagal → jangan buang (fallback text-gate)
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL, max_tokens: 60, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: img } },
        ] }],
      }),
    });
    if (!resp.ok) return false;
    const d: any = await resp.json();
    return classifyVisionText(d?.choices?.[0]?.message?.content || '');
  } catch { return false; }
}
```

- [ ] **Step 4: Jalankan, pastikan LULUS**

Run: `node scout/lib/subtitle_vision.test.ts`
Expected: `ok subtitle_vision`.

- [ ] **Step 5: Integrasi ke `addVideo` di `build_footage.ts`**

Modify `scout/pipeline/build_footage.ts`. Tambah import: `import { hasReactionSubtitle } from '../lib/subtitle_vision.ts';`. Di dalam `addVideo`, SETELAH resolve `furl` (URL CDN TikTok, baris ~464-474) dan SEBELUM `set.footage.push`, sisipkan:

```ts
        // Filter subtitle-vision: buang klip dgn caption-ucapan/overlay react (best-effort).
        // Jalan hanya jika URL bisa di-frame (CDN mp4 hasil resolve). Gagal → lolos (text-gate).
        if (await hasReactionSubtitle(furl)) {
          dropReact++;
          return false;
        }
```

Karena `dropReact` sudah dihitung & dilaporkan di ringkasan (`+pv/pp ... drop reaction`), penolakan subtitle otomatis muncul di log tanpa perubahan lain.

- [ ] **Step 6: Cek tipe**

Run: `cd scout && npx tsc --noEmit`
Expected: 0 error.

- [ ] **Step 7: Commit**

```bash
git add scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts scout/pipeline/build_footage.ts
git commit -m "feat(scout): subtitle-vision filter drops spoken-caption/react footage in addVideo"
```

---

### Task 4: Rust — tipe `Dossier` + passthrough content-set → sidecar

**Files:**
- Modify: `crates/thoth-core/src/ingest/content_search.rs` (struct `ContentSet` loader + `MainContext` + `Dossier` type)
- Modify: `crates/thoth-core/src/lib.rs:872-891` (tulis `dossier` ke sidecar)
- Test: `crates/thoth-core/src/ingest/content_search.rs` (mod tests)

**Interfaces:**
- Consumes: content-set JSON field `dossier` (Task 1).
- Produces: `MainContext.dossier: Dossier` terbaca via `load_main_context`.
  `pub struct Dossier { pub topic: String, pub entities: Vec<Reference>, pub relations: Vec<String>, pub angles: Vec<String>, pub timeline: Vec<String> }` (search_queries scout-only, tak diikutkan ke Rust).

- [ ] **Step 1: Tulis test gagal (deserialize + round-trip dossier)**

Tambah di `#[cfg(test)] mod tests` pada `content_search.rs`:

```rust
#[test]
fn content_set_parses_dossier_into_main_context() {
    let json = r#"{
      "main": {"url":"u","title":"T","description":"D"},
      "footage": [], "comments": [],
      "dossier": {
        "topic":"Kasus X",
        "entities":[{"term":"Nvidia","kind":"org","summary":"chip"}],
        "relations":["A kaitan B"],
        "angles":["sudut 1"],
        "search_queries":[{"q":"chip ai","for":"entity:nvidia"}],
        "timeline":["t1"]
      }
    }"#;
    let set: ContentSet = serde_json::from_str(json).unwrap();
    let ctx = to_main_context(set); // helper yg dipakai lib.rs; lihat Step 3
    assert_eq!(ctx.dossier.topic, "Kasus X");
    assert_eq!(ctx.dossier.entities.len(), 1);
    assert_eq!(ctx.dossier.angles, vec!["sudut 1".to_string()]);
    assert_eq!(ctx.dossier.timeline, vec!["t1".to_string()]);
}

#[test]
fn content_set_without_dossier_defaults_empty() {
    let set: ContentSet = serde_json::from_str(r#"{"main":{"url":"u"},"footage":[],"comments":[]}"#).unwrap();
    let ctx = to_main_context(set);
    assert!(ctx.dossier.topic.is_empty());
    assert!(ctx.dossier.entities.is_empty());
}
```

- [ ] **Step 2: Jalankan, pastikan GAGAL**

Run: `cargo test --bin thoth content_set_parses_dossier -- --nocapture`
Expected: FAIL — `Dossier`/`to_main_context`/`ctx.dossier` belum ada.

- [ ] **Step 3: Tambah tipe `Dossier`, field, dan helper `to_main_context`**

Di `content_search.rs`:

a) Tambah struct (dekat `Reference`/`Discourse`):

```rust
/// Topic Dossier (scout `topic_dossier.ts`): entitas + relasi + sudut cerita untuk grounding narasi.
/// `search_queries` scout-only (men-drive footage) → TIDAK diikutkan ke Rust.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Dossier {
    #[serde(default)] pub topic: String,
    #[serde(default)] pub entities: Vec<Reference>,
    #[serde(default)] pub relations: Vec<String>,
    #[serde(default)] pub angles: Vec<String>,
    #[serde(default)] pub timeline: Vec<String>,
}
```

b) Tambah field `dossier` ke struct loader `ContentSet` (yang mem-parse JSON scout) DAN ke `MainContext`:

```rust
    // di ContentSet:
    #[serde(default)] pub dossier: Dossier,
    // di MainContext:
    #[serde(default)] pub dossier: Dossier,
```

c) Refactor penulisan `MainContext` di `lib.rs` jadi helper agar testable. Tambah di `content_search.rs`:

```rust
/// Rakit sidecar MainContext dari content-set (dipakai lib.rs saat load content-set).
pub fn to_main_context(set: ContentSet) -> MainContext {
    MainContext {
        title: set.main_title.trim().to_string(),
        description: set.main_description.trim().to_string(),
        figures: set.figures,
        references: set.references,
        discourse: set.discourse,
        dossier: set.dossier,
    }
}
```

> Catatan: nama field `set.main_title`/`set.main_description` mengikuti struct `ContentSet` yang ada (lib.rs:874-875 memakainya). Jika `ContentSet` menyimpan main sebagai sub-struct, sesuaikan akses di `to_main_context` — tapi field `dossier` tetap di root content-set.

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cargo test --bin thoth content_set_parses_dossier content_set_without_dossier -- --nocapture`
Expected: PASS (2 test).

- [ ] **Step 5: Pakai helper di `lib.rs`**

Modify `crates/thoth-core/src/lib.rs:873-879`. Ganti konstruksi inline `MainContext { ... }` dengan:

```rust
                    let ctx = ingest::content_search::to_main_context(set.clone());
```

(`set.clone()` karena `set` masih dipakai di bawah untuk profile/comments. Jika `ContentSet` besar, pindahkan pemanggilan `to_main_context` ke setelah pemakaian `set` lain & pakai move — tapi clone aman dan lazy di sini.)

- [ ] **Step 6: Commit**

```bash
git add crates/thoth-core/src/ingest/content_search.rs crates/thoth-core/src/lib.rs
git commit -m "feat(core): parse dossier from content-set into MainContext sidecar"
```

---

### Task 5: Rust — blok narasi dari dossier

**Files:**
- Modify: `crates/thoth-core/src/pipeline/mod.rs` (helper `dossier_blocks` + wire ke `generate_narration` ~baris 340)
- Test: `crates/thoth-core/src/pipeline/mod.rs` (mod tests)

**Interfaces:**
- Consumes: `MainContext.dossier` (Task 4).
- Produces: `dossier_blocks(d: &Dossier) -> Vec<String>` (blok `[Entitas & Fakta]`, `[Sudut Cerita]`, `[Kronologi]`).

- [ ] **Step 1: Tulis test gagal**

Tambah di `#[cfg(test)] mod tests` pada `pipeline/mod.rs` (buat mod tests bila belum ada):

```rust
#[test]
fn dossier_blocks_emits_present_sections_only() {
    use crate::ingest::content_search::{Dossier, Reference};
    let d = Dossier {
        topic: "Kasus X".into(),
        entities: vec![Reference { term: "Nvidia".into(), kind: "org".into(), summary: "chip".into(), as_of_date: String::new(), source_url: String::new() }],
        relations: vec!["A kaitan B".into()],
        angles: vec!["sudut 1".into(), "sudut 2".into()],
        timeline: vec![],
    };
    let blocks = dossier_blocks(&d);
    let joined = blocks.join("\n---\n");
    assert!(joined.contains("[Entitas & Fakta]"));
    assert!(joined.contains("Nvidia"));
    assert!(joined.contains("A kaitan B"));
    assert!(joined.contains("[Sudut Cerita]"));
    assert!(joined.contains("sudut 1"));
    assert!(!joined.contains("[Kronologi]")); // timeline kosong → tak diemit
}

#[test]
fn dossier_blocks_empty_when_all_empty() {
    use crate::ingest::content_search::Dossier;
    assert!(dossier_blocks(&Dossier::default()).is_empty());
}
```

> Sesuaikan field `Reference` di test bila strukturnya beda (lihat definisi di `content_search.rs`); yang penting `term`/`kind`/`summary`.

- [ ] **Step 2: Jalankan, pastikan GAGAL**

Run: `cargo test --bin thoth dossier_blocks -- --nocapture`
Expected: FAIL — `dossier_blocks` tak ada.

- [ ] **Step 3: Implementasi `dossier_blocks` + wire**

Di `pipeline/mod.rs`, tambah fungsi bebas (module-level):

```rust
/// Rakit blok grounding narasi dari Topic Dossier. Hanya emit seksi yang terisi.
fn dossier_blocks(d: &crate::ingest::content_search::Dossier) -> Vec<String> {
    let mut out = Vec::new();
    let ents: Vec<String> = d.entities.iter()
        .filter(|e| !e.term.trim().is_empty() && !e.summary.trim().is_empty())
        .map(|e| {
            let kind = e.kind.trim();
            if kind.is_empty() { format!("- {}: {}", e.term.trim(), e.summary.trim()) }
            else { format!("- {} ({}): {}", e.term.trim(), kind, e.summary.trim()) }
        }).collect();
    let rels: Vec<String> = d.relations.iter().map(|r| r.trim()).filter(|r| !r.is_empty()).map(|r| format!("- {r}")).collect();
    if !ents.is_empty() || !rels.is_empty() {
        let mut s = String::from("[Entitas & Fakta]");
        if !ents.is_empty() { s.push('\n'); s.push_str(&ents.join("\n")); }
        if !rels.is_empty() { s.push_str("\nRelasi:\n"); s.push_str(&rels.join("\n")); }
        out.push(s);
    }
    let angles: Vec<String> = d.angles.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).map(|a| format!("- {a}")).collect();
    if !angles.is_empty() {
        out.push(format!("[Sudut Cerita]\n{}", angles.join("\n")));
    }
    let tl: Vec<String> = d.timeline.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).map(|t| format!("- {t}")).collect();
    if !tl.is_empty() {
        out.push(format!("[Kronologi]\n{}", tl.join("\n")));
    }
    out
}
```

Wire di `generate_narration`: setelah blok `[Konteks Budaya]` di-push (dalam `if let Some(ctx) = ...load_main_context`, sekitar baris 340), tambahkan:

```rust
            // Topic Dossier (scout topic_dossier.ts): entitas+relasi+sudut cerita → spine narasi.
            for b in dossier_blocks(&ctx.dossier) {
                sources.push(b);
            }
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cargo test --bin thoth dossier_blocks -- --nocapture`
Expected: PASS (2 test).

- [ ] **Step 5: Update prompt narator (opsional-minimal) + BLUEPRINT**

Di `crates/thoth-core/src/narration/mod.rs`, di daftar blok sumber pada prompt (tempat blok lain seperti `[Analisa Momen]` disebut), tambah 1 baris agar narator tahu blok baru: sebut `[Sudut Cerita]` sebagai kerangka arah dan `[Entitas & Fakta]` sebagai fakta wajib-ground. (Cari string prompt yang menyenaraikan blok; tambahkan penyebutan singkat — tanpa mengubah aturan grounding.)

Update `BLUEPRINT.md`: tandai item Topic Dossier / footage enrichment jadi ⚠️/✅ dengan file `scout/enrich/topic_dossier.ts` + tanggal 2026-07-21 di baris akhir.

- [ ] **Step 6: Build penuh + commit**

Run (PowerShell tool): `cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"`
Expected: `EXIT=0`, zero error. Verifikasi `thoth.exe` mtime maju.

```bash
git add crates/thoth-core/src/pipeline/mod.rs crates/thoth-core/src/narration/mod.rs BLUEPRINT.md
git commit -m "feat(core): inject dossier entities/relations/angles into narration grounding"
```

---

## Self-Review

**Spec coverage:**
- Stage `topic_dossier` + reorder → Task 1. ✅
- `build_footage` konsumsi `search_queries` + fallback → Task 2. ✅
- Filter subtitle-vision (toleransi caption-ucapan/react saja) → Task 3 (prompt `subtitle_vision.ts` eksplisit membiarkan lower-third berita). ✅
- Narasi konsumsi entities/relations/angles + timeline → Task 5. ✅
- Kontrak data content-set + sidecar (`#[serde(default)]`) → Task 4. ✅
- Backward-compat run `--url` tanpa dossier → Task 2 (fallback), Task 4 (`default`), Task 5 (blok kosong → tak diemit). ✅
- Best-effort semua stage → Task 1 (parse null), Task 3 (frame/vision gagal → false), Task 4/5 (default). ✅

**Placeholder scan:** Tak ada TBD/TODO; tiap step code lengkap. Satu asumsi ditandai eksplisit (nama field `ContentSet.main_title` di Task 4 Step 3 — implementer verifikasi ke struct nyata; ini catatan, bukan placeholder).

**Type consistency:** `Dossier` (topic/entities:Vec<Reference>/relations/angles/timeline) konsisten Task 4↔5. `parseDossier`→`Dossier` TS konsisten Task 1↔2 (`search_queries`). `resolveFootageTasks`/`composeQuery` konsisten Task 2. `classifyVisionText`/`hasReactionSubtitle` konsisten Task 3.

**Catatan integrasi manual (non-blocking):** `dashboard/src/api.ts` tak dipaksa compiler — dossier tak menambah field JobSpec/JobRecord, jadi TAK perlu update TS dashboard di SP1.
