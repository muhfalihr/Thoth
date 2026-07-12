# Dashboard Fase 2 — Review & QC (Review-only slice)

*Design spec — 2026-07-12. Supersedes the "Fase 2" row scope in
`2026-07-11-dashboard-architecture-design.md` for this slice.*

## 1. Goal & scope

After a job reaches `succeeded`, let the user **review the result in the
browser**: play the final video, inspect ranked moments + scores, and preview
raw artifacts (transcript / narration). Read-only — **no editing, no rerender**
in this slice (those stay deferred; see §8).

Non-goal: config/profile editing (Fase 3), moment editing, partial re-render.

## 2. Decisions locked in brainstorming

1. **Depth = review-only.** Edit + rerender deferred — much larger (needs a
   partial-pipeline re-run path in the worker).
2. **Deterministic artifact paths via injected job_id.** Today the pipeline
   generates its **own** random `job_id` (`Uuid::new_v4`) and nests work under
   `<output_dir>/.thoth/<random>/`. The server never learns that random id, so
   it cannot address artifacts. Fix: the worker passes the **server job id**
   down; the pipeline uses it instead of minting a random one.
3. **Flat layout under the server.** When a `job_id` is injected (server path),
   the pipeline treats `output_dir` as the job root **directly** — no
   `.thoth/<id>` wrapper. Artifacts land at `output_root/<id>/{clips,analyze,
   narration,transcribe}/…`, matching what the artifact route already serves
   and the intent of the `routes.rs` comment. The `.thoth/<uuid>` nesting stays
   the **default for CLI** runs (no injected id → mint uuid + nest, so a bare
   `thoth run <url>` still doesn't litter the CWD). Verified safe: `.thoth` is
   referenced in exactly one place (`util/fs.rs::job_dir`); nothing globs it as
   a marker.

## 3. Backend

### 3a. Inject server job_id into the pipeline (thoth-core)

- `RunArgs` gains `--job-id <string>` (optional; `#[serde(default)]` /
  `Option<String>`).
- `PipelineRunner::run` gains a caller-supplied id path. The existing
  `resume_id` seam already substitutes an id for the uuid, but resume also
  triggers state reload — keep the two **orthogonal**. New logic:

  ```
  match injected_job_id {
      Some(id) => (id, output_dir.to_owned()),            // FLAT: root = output_dir
      None     => { let id = uuid(); (id.clone(), job_dir(output_dir, &id)) } // CLI: nested
  }
  ```

  i.e. the caller-supplied id both **names** the job and selects the **flat
  root**. `job_dir()` is only applied on the CLI branch.
- `state.json` records this id in its `job_id` field (already present).
- Worker (`thoth-core/src/worker/mod.rs`) adds `--job-id <job.id>` to the argv
  it already builds (`--output-dir output_root/<id>` stays).

Compiler-enforced: the signature change to `RunArgs` / `PipelineRunner::run`
forces both adapters (CLI bin + worker) to update. `thoth-jobs` untouched → **no
migration**.

### 3b. `GET /api/jobs/:id/manifest` (thoth-server)

New handler in `crates/thoth-server/src/routes.rs`, ~40 lines, **no thoth-core
dependency** (it only walks the served dir). With flat layout the job root is
simply `output_root/<id>`:

- Resolve each artifact and return the **relpath** (relative to
  `output_root/<id>`, so the existing `/api/artifacts/:id/<relpath>` serves it):
  - `video` → `clips/final_concat.mp4`; fallback: newest `clips/clip_*.mp4`
    (single-clip runs have no concat).
  - `thumbnail` → thumb beside the chosen video if present.
  - `moments` → `analyze/moments.json`.
  - `narration` → `narration/narration.mp3`.
  - `transcript` → `transcribe/transcript.json`.
- Return only keys whose file **exists**:
  `{ video?, thumbnail?, moments?, narration?, transcript? }`.
- Always `200`. Job not finished / dir absent → all fields `null` (frontend
  treats that as "not ready").
- Auth: same Bearer guard as the other `/api/jobs*` routes.

**Coupling note (ponytail):** this handler encodes the pipeline's output
sub-layout (`clips/`, `analyze/`, …), which lives in
`thoth-core/pipeline/job.rs`. Nothing forces them to stay in sync (server has
no dep on core). A dir rename would silently empty the manifest → covered by the
integration test in §6. `// ponytail: layout mirrors thoth-core JobPaths; test guards drift`

## 4. Frontend — "Review" tab in `JobMonitor`

Shown only when `status === "succeeded"`. On mount, call `getManifest(id)` then:

- **Player** — `<video controls>` whose `src` is an object URL from
  `fetchArtifact(id, manifest.video)` (reuses the existing bearer-aware
  object-URL pattern; a raw `<a href>`/`src` can't carry the auth header).
- **Moments table** — parse `manifest.moments` (`Vec<ViralMoment>`). Columns:
  `#`, `title` / `headline`, `start_sec–end_sec`, `viral_type`, `energy`.
  Each row expandable to `reason` / `hook`.
- **Score bars** — from `ViralMoment.visual_score`
  (`humor`, `visual_impact`, `novelty`, `engagement`) rendered as **inline
  CSS/SVG bars**. Bar length normalized per-column against the max value seen
  across moments (don't hard-assume a 0–10 scale — confirm the field's actual
  type/range against `analyze/schema.rs` at implementation time). No chart
  library — adding `recharts` for a bar list is over-building; the dashboard has
  no chart dep today.
- **Raw artifacts** — collapsible links that `fetchArtifact` the transcript /
  narration for preview/download.

### 4a. `api.ts` (manual contract half)

Add, kept byte-aligned with the Rust handler:

```ts
export type Manifest = {
  video?: string;
  thumbnail?: string;
  moments?: string;
  narration?: string;
  transcript?: string;
};
export async function getManifest(id: string): Promise<Manifest> { … }
```

(utoipa/OpenAPI codegen remains Fase 3 — this stays hand-synced.)

## 5. Error handling & isolation

- Manifest returns partial/empty when files are missing — frontend renders only
  what exists; a missing `video` shows "render not available" rather than error.
- `fetchArtifact` failure (404/permission) → inline error in that widget, rest
  of the panel still renders.
- Malformed `moments.json` → table shows a parse-error notice, player unaffected
  (widgets are independent).

## 6. Testing

- **Rust integration** (`thoth-server`): build a temp `output_root/<id>/` with
  dummy `clips/final_concat.mp4` + `analyze/moments.json`, assert `manifest`
  resolves those relpaths and omits absent ones; and the empty case (no job dir)
  → all `null`. This is the guard for the §3b coupling note.
- **Rust unit** (`thoth-core`): assert that an injected `job_id` yields a flat
  root (`root == output_dir`, no `.thoth`), and that the CLI path (no id) still
  nests under `.thoth/<uuid>`.
- **Frontend**: `tsc -b` + `bun run build` clean (Fase 1 verification pattern).
- **Full**: `build_cuda.bat` EXIT 0 + `cargo test --workspace` per CLAUDE.md.

## 7. Interface-sync contract

- `RunArgs` / `PipelineRunner::run` signature change → CLI bin + worker updated
  (compiler-enforced).
- `Manifest` type in `dashboard/src/api.ts` → hand-synced with the Rust handler.
- No `thoth-jobs` schema change → no migration.

## 8. Deferred (unchanged)

- Edit narration/subtitle text in-browser + `POST /rerender` (partial pipeline
  re-run) — the heavy half of the original Fase 2 row.
- Fase 3 (config / profiles / vocab / curators, API-keys panel, utoipa codegen).
