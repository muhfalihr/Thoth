# scout/ — Migrasi Runtime Node.js → Bun (hard switch)

**Tanggal:** 2026-07-09
**Scope:** Ganti runtime scout/ dari Node ≥24 ke Bun. Hard switch — tidak ada fallback Node.

## Motivasi

scout/ adalah layer TypeScript yang dijalankan native (tanpa build step). Sebelumnya
via Node ≥24 type-stripping. User sudah menginstal Bun dan ingin scout jalan di atas Bun.

## Perubahan

### 1. Rust — `src/main.rs` (handler `Commands::Scout`)
- `which::which("node")` → `which::which("bun")`.
- Spawn `bun scout/cli.ts <args>` (sebelumnya `node ...`). Argumen & cwd tidak berubah.
- Pesan error: "node not found … https://nodejs.org/" → "bun not found … https://bun.sh".
- `src/cli.rs:445` doc-comment `→ node scout/cli.ts …` → `→ bun scout/cli.ts …`.

### 2. Spawn internal TS (7 site `execFileSync('node', …)`)
Ganti literal `'node'` → `process.execPath` supaya child selalu pakai runtime yang
sama dengan parent (di Bun = binary bun), tanpa PATH lookup:
- `pipeline/run_pipeline.ts`
- `pipeline/collect_comments.ts`
- `pipeline/build_footage.ts`
- `pipeline/topic_to_urls.ts`
- `pipeline/trace_source.ts`
- `enrich/pulse_harvest.ts`

`cli.ts` sudah pakai `process.execPath` (tidak diubah). `lib/browser.ts` spawn binary
browser, bukan node (tidak diubah).

### 3. `package.json` + lockfile
- `engines`: `{ "node": ">=24" }` → `{ "bun": ">=1.2" }`.
- `description`: ganti "Node >=24 type stripping" → "Bun".
- `@types/node` + `typescript` **tetap** — tsc typecheck masih butuh tipe builtin `node:`.
- Hapus `package-lock.json`, jalankan `bun install` → hasilkan `bun.lock`.

### 4. `tsconfig.json`
Hanya komentar header (Node type-stripping → Bun). CompilerOptions tidak berubah;
`types: ["node"]` tetap dibutuhkan (kode pakai API `node:fs`, `node:path`, dst — Bun
mengimplementasikan API ini, tipenya dari @types/node).

### 5. Docs & komentar
`README.md`, `SETUP.md`, `RUNBOOK.md`, CLAUDE.md kontrak scout, BLUEPRINT.md (bila ada),
dan komentar usage `node xxx.ts` di header script → `bun xxx.ts`. `node -e` → `bun -e`.
Referensi "Node.js LTS/≥24" → "Bun ≥1.2". Pesan error "`node: command not found`" → bun.

## Verifikasi
1. `bun run typecheck` (tsc --noEmit) → 0 error.
2. `bun cli.ts` (tanpa arg) → daftar perintah tampil.
3. `bun lib/browser.ts status` → smoke test path CDP/http server.
4. `cargo check`, lalu full `build_cuda.bat` (wajib: main.rs berubah), verifikasi mtime
   `thoth.exe` maju.

## Risiko (sudah dicek kompatibel Bun)
`pg` (optional dep), global `fetch`/`WebSocket`, `http.createServer` di browser.ts,
`import.meta.dirname`, `execFileSync`/`spawnSync`/`execSync` — semua didukung Bun ≥1.2.
Tidak ada `worker_threads` atau flag Node eksotis.
