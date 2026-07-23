# Pipeline-Enforced Local OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Use
> `superpowers:test-driven-development` for every behavior change and
> `superpowers:verification-before-completion` before claiming completion.

**Goal:** Make DeepSeek OCR a fail-closed pipeline stage after local ingest, persist
freshness/status metadata, and prevent unverified main or footage video from
reaching render.

**Architecture:** Scout remains the single OCR/classifier implementation and
exposes a JSON-only `ocr-local` command. Rust supervises that command after ingest,
validates its versioned result, updates `content_context.json`, records a
fingerprinted OCR stage for resume, and validates all video enrichment before edit.

**Tech stack:** Bun/TypeScript, Novita OpenAI-compatible DeepSeek OCR, Rust 2024,
Serde, Tokio supervised processes, FFmpeg/ffprobe, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-07-23-pipeline-enforced-local-ocr-design.md`

## Global Constraints

- Default model remains `deepseek/deepseek-ocr`; there is no Qwen fallback.
- Missing, incomplete, malformed, or failed OCR is never converted to `clean`.
- The Rust pipeline analyzes the exact local file returned by ingest.
- Unit tests make no network calls.
- No credential, authorization header, base64 frame, or raw private URL may enter
  stdout, state, diagnostics, or surfaced errors.
- Main OCR failure aborts before transcribe.
- A video footage entry without supported successful OCR metadata aborts before
  edit; still-image entries remain exempt.
- OCR rerun on resume invalidates an already-completed edit stage.
- Preserve unrelated dirty-worktree changes.
- Every shell command executed by the agent is prefixed with `rtk`, per
  `C:\Users\mfr\.codex\RTK.md`.
- Completion requires Scout tests/typecheck, the full `thoth-core` suite, and the
  repository CUDA/release build.

---

## Task 1: Introduce a versioned fail-closed Scout OCR result

**Files:**

- Create: `scout/lib/ocr_contract.ts`
- Modify: `scout/lib/subtitle_vision.ts`
- Modify: `scout/lib/subtitle_vision.test.ts`

**Interfaces:**

```ts
export const OCR_SCHEMA_VERSION = 1;
export const OCR_ANALYZER_VERSION = 'deepseek-ocr-v2';
export const DEFAULT_OCR_MODEL = 'deepseek/deepseek-ocr';

export type OcrStatus = 'analyzed' | 'failed';
export type OcrAnalysis = {
  schema_version: 1;
  ocr_status: OcrStatus;
  provider: 'novita';
  model: string;
  analyzer_version: string;
  requested_frames: number;
  valid_frames: number;
  analyzed_at: string;
  verdict?: ClipVerdict;
  error_code?: string;
  error_message?: string;
};
```

- [ ] **Step 1: Write failing contract tests**

Extend `subtitle_vision.test.ts` with dependency-injected cases:

```ts
const missingKey = await analyzeSubtitlesDetailed('C:/video.mp4', 10, {
  env: {},
  now: () => new Date('2026-07-23T00:00:00Z'),
});
assert.equal(missingKey.ocr_status, 'failed');
assert.equal(missingKey.error_code, 'missing_api_key');
assert.equal(missingKey.verdict, undefined);

const noDuration = await analyzeSubtitlesDetailed('C:/video.mp4', 0, {
  env: { NOVITA_API_KEY: 'test' },
  probeDuration: () => 0,
});
assert.equal(noDuration.ocr_status, 'failed');
assert.equal(noDuration.error_code, 'duration_probe_failed');
```

Add a fully injected successful-empty case and a one-frame-exhausted case:

```ts
assert.equal(clean.ocr_status, 'analyzed');
assert.equal(clean.verdict?.outcome, 'clean');
assert.equal(clean.valid_frames, clean.requested_frames);

assert.equal(partial.ocr_status, 'failed');
assert.equal(partial.error_code, 'incomplete_frame_coverage');
assert.equal(partial.valid_frames, partial.requested_frames - 1);
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
rtk bun scout/lib/subtitle_vision.test.ts
```

Expected: missing `analyzeSubtitlesDetailed`/contract exports.

- [ ] **Step 3: Add the shared contract and runtime dependency seam**

Move model/version constants and the new result types into
`scout/lib/ocr_contract.ts`. In `subtitle_vision.ts`, add an optional dependency
object for tests:

```ts
export type OcrAnalysisDeps = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  probeDuration?: (video: string) => number;
  frameDataUrl?: (video: string, t: number) => string | null;
  ocrFrame?: (image: string) => Promise<{ boxes: OcrBox[]; error?: string }>;
  retryCount?: number;
};
```

Configuration must be resolved at call time rather than frozen at module import so
tests and Rust-launched processes use the actual environment.

- [ ] **Step 4: Implement `analyzeSubtitlesDetailed` minimally**

Required policy:

1. missing key/path -> failed;
2. duration probe <= 0 -> failed;
3. build the existing adaptive schedule;
4. extract and OCR every frame;
5. retry failed model requests a bounded number of times;
6. any permanently failed scheduled frame -> failed;
7. only complete coverage may call `classifyOcrFrames`;
8. successful zero-box responses remain valid clean evidence;
9. append safe diagnostics for both analyzed and failed outcomes.

Keep `analyzeSubtitles` as a compatibility wrapper that returns the verdict only
for analyzed results and throws a sanitized `OcrAnalysisError` for failed results.
It must not restore fail-open behavior.

- [ ] **Step 5: Verify GREEN**

```powershell
rtk bun scout/lib/subtitle_vision.test.ts
rtk proxy powershell -NoProfile -Command 'Push-Location scout; bun run typecheck; Pop-Location'
```

- [ ] **Step 6: Commit**

```powershell
rtk git add scout/lib/ocr_contract.ts scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts
rtk git commit -m "feat(scout): make OCR analysis fail closed"
```

---

## Task 2: Lock headline exclusion and all-frame bbox geometry

**Files:**

- Modify: `scout/lib/subtitle_vision.test.ts`
- Modify only if a regression test fails: `scout/lib/subtitle_vision.ts`

- [ ] **Step 1: Add precise geometry regressions**

Add a hybrid test whose intro headline occupies the middle of the frame and whose
later subtitle moves and grows:

```ts
const result = classifyOcrFrames([
  f(.5, b('INTRO HEADLINE', .08, .40, .92, .52)),
  f(2,  b('INTRO HEADLINE', .06, .39, .94, .53)),
  f(4,  b('spoken one', .24, .74, .70, .80)),
  f(6,  b('spoken two', .12, .72, .88, .84)),
], 10);

assert.equal(result.trim_start, 3);
assert.ok(result.subtitle_blur.every((r) => r.y > .68));
const merged = result.subtitle_blur.find((r) => r.start! <= 4 && r.end! >= 6)!;
assert.ok(merged.x <= .12);
assert.ok(merged.x + merged.w >= .88);
assert.ok(merged.y <= .72);
assert.ok(merged.y + merged.h >= .84);
```

Also assert that a large intro headline box never appears in classified
`subtitle_boxes` diagnostics after `trim_start`.

- [ ] **Step 2: Run the tests**

```powershell
rtk bun scout/lib/subtitle_vision.test.ts
```

If already green, retain the tests as proof and make no production change. If red,
continue with Steps 3–4.

- [ ] **Step 3: Make the smallest classifier correction**

For each merged temporal subtitle window calculate:

```text
x0 = min(all constituent box.x0)
y0 = min(all constituent box.y0)
x1 = max(all constituent box.x1)
y1 = max(all constituent box.y1)
```

Apply padding after the union and clamp to `[0,1]`. Exclude all boxes belonging to
the intro headline track before forming subtitle windows. Do not merge spatially
unrelated tracks merely to obtain a global bbox.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
rtk bun scout/lib/subtitle_vision.test.ts
rtk git add scout/lib/subtitle_vision.ts scout/lib/subtitle_vision.test.ts
rtk git commit -m "test(scout): enforce tracked subtitle bbox geometry"
```

---

## Task 3: Add a JSON-only local OCR command

**Files:**

- Create: `scout/pipeline/ocr_local.ts`
- Create: `scout/pipeline/ocr_local.test.ts`
- Modify: `scout/cli.ts`

**Interfaces:**

```text
bun scout/cli.ts ocr-local <absolute-video-path>
```

- [ ] **Step 1: Write failing command-runner tests**

Export a dependency-injected `runLocalOcr(args, deps)` from `ocr_local.ts`. Test:

- missing argument;
- relative path;
- missing file;
- analyzed result;
- failed result.

Assertions:

- exactly one JSON object is written to stdout;
- success returns exit code 0;
- every failure returns nonzero;
- human diagnostics use stderr;
- no banner or decoration appears on stdout.

- [ ] **Step 2: Verify RED**

```powershell
rtk bun scout/pipeline/ocr_local.test.ts
```

Expected: module/runner does not exist.

- [ ] **Step 3: Implement the local command**

`ocr_local.ts` validates an absolute existing file, invokes
`analyzeSubtitlesDetailed`, writes `JSON.stringify(result) + '\n'`, and maps
status to the process exit code. Use `if (import.meta.main)` so tests can import it
without launching.

Add:

```ts
ocr-local: ['pipeline/ocr_local.ts', '<absolute-video-path> -> one OCR JSON envelope']
```

to `CMDS`. Suppress `ui.banner()` when `cmd === 'ocr-local'`; all other commands
retain current UI behavior.

- [ ] **Step 4: Verify GREEN including process-level output**

```powershell
rtk bun scout/pipeline/ocr_local.test.ts
rtk proxy powershell -NoProfile -Command '$r = & bun scout/cli.ts ocr-local relative.mp4 2>$null; $r | ConvertFrom-Json | Out-Null; if ($LASTEXITCODE -eq 0) { exit 1 }'
rtk proxy powershell -NoProfile -Command 'Push-Location scout; bun run typecheck; Pop-Location'
```

- [ ] **Step 5: Commit**

```powershell
rtk git add scout/cli.ts scout/pipeline/ocr_local.ts scout/pipeline/ocr_local.test.ts
rtk git commit -m "feat(scout): expose machine-readable local OCR"
```

---

## Task 4: Persist and validate OCR metadata in Scout content-sets

**Files:**

- Modify: `scout/lib/types.ts`
- Modify: `scout/lib/ocr_contract.ts`
- Modify: `scout/lib/subtitle_vision.test.ts`
- Modify: `scout/pipeline/trace_source.ts`
- Modify: `scout/pipeline/build_footage.ts`
- Modify: `scout/lib/validate.ts`
- Create: `scout/lib/validate.test.ts`

- [ ] **Step 1: Write failing metadata projection tests**

Add a pure helper:

```ts
analysisFields(analysis: AnalyzedOcrAnalysis)
```

and test that it emits:

```text
ocr_status, ocr_model, ocr_analyzer_version, ocr_analyzed_at,
ocr_requested_frames, ocr_valid_frames,
trim_start, mute_audio, subtitle_blur
```

It must reject/throw for `ocr_status: failed`.

- [ ] **Step 2: Write failing validator tests**

Create `validate.test.ts` with cases:

- video main missing status -> error;
- video main failed -> error;
- analyzed main with wrong model/analyzer -> error;
- video footage missing/failed metadata -> error;
- malformed trim/blur coordinates -> error;
- subtitle-classified footage -> error if an outcome field is persisted;
- still-image main/footage without OCR metadata -> valid;
- fully analyzed main plus clean/cover video footage -> valid.

- [ ] **Step 3: Verify RED**

```powershell
rtk bun scout/lib/subtitle_vision.test.ts
rtk bun scout/lib/validate.test.ts
```

- [ ] **Step 4: Add TypeScript contract fields**

Add the flat OCR metadata fields to both `MainVideo` and `ContentResult`. Add an
optional `ocr_outcome` field so validation can ensure subtitle footage did not
survive filtering.

- [ ] **Step 5: Wire detailed analysis into content construction**

In `trace_source.ts`, replace the final `analyzeSubtitles` call with
`analyzeSubtitlesDetailed`, require analyzed status, and assign
`analysisFields(result)`.

In `build_footage.ts`, require analyzed status before considering the verdict:

- subtitle -> reject;
- clean/cover -> persist all metadata/directives;
- failed -> throw and abort content-set construction.

Remove comments describing the gate as best-effort/fail-open.

- [ ] **Step 6: Implement lint rules**

`lintContentSet` requires supported OCR metadata for every record that can be
rendered as video (`is_video !== false`). Validate finite numbers, normalized bbox
geometry, nonnegative time windows, complete frame counts, and supported
model/analyzer/schema. Image records are exempt.

- [ ] **Step 7: Verify GREEN**

```powershell
rtk bun scout/lib/subtitle_vision.test.ts
rtk bun scout/lib/validate.test.ts
rtk proxy powershell -NoProfile -Command 'Push-Location scout; bun run typecheck; Pop-Location'
```

- [ ] **Step 8: Commit**

```powershell
rtk git add scout/lib/types.ts scout/lib/ocr_contract.ts scout/lib/subtitle_vision.test.ts scout/pipeline/trace_source.ts scout/pipeline/build_footage.ts scout/lib/validate.ts scout/lib/validate.test.ts
rtk git commit -m "feat(scout): require OCR metadata in video content"
```

---

## Task 5: Mirror the OCR contract and safety checks in Rust

**Files:**

- Modify: `crates/thoth-core/src/ingest/content_search.rs`
- Modify: `crates/thoth-core/src/edit/enrichment.rs`

**Interfaces:**

```rust
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrStatus { Analyzed, Failed }

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OcrMetadata {
    pub ocr_status: Option<OcrStatus>,
    pub ocr_model: String,
    pub ocr_analyzer_version: String,
    pub ocr_analyzed_at: String,
    pub ocr_requested_frames: usize,
    pub ocr_valid_frames: usize,
    pub ocr_outcome: String,
}
```

Use `#[serde(flatten)]` on `MainVideo`, `ContentResult`, and `MainContext` so the
JSON remains flat.

- [ ] **Step 1: Write failing deserialize/validation tests**

Add tests for:

- legacy/missing metadata deserializes as not analyzed, not clean;
- analyzed metadata round-trips through `to_main_context`;
- failed/missing/stale metadata is rejected;
- NaN/infinite/negative trim and invalid bbox/time windows are rejected;
- image enrichment is exempt;
- video enrichment is required to be analyzed.

Add a file-based test in `edit/enrichment.rs` showing that an unsafe video pool
returns an error rather than silently loading an empty/legacy pool.

- [ ] **Step 2: Verify RED**

```powershell
rtk cargo test -p thoth-core ocr_metadata --no-run
```

- [ ] **Step 3: Add the Rust metadata contract**

Mirror the supported schema/model/analyzer constants. Carry main metadata through
`LoadedSet` and `to_main_context`. Update every `ContentResult` struct literal
identified by the compiler.

- [ ] **Step 4: Add pure validators**

Implement:

```rust
validate_main_ocr(&MainContext) -> Result<()>
validate_video_ocr(&ContentResult) -> Result<()>
validate_subtitle_blur(&[SubtitleBlur]) -> Result<()>
```

Errors use safe record indices/platforms, never raw URLs. Missing enrichment file
remains valid. A present enrichment file with a renderable unsafe video is an
error.

Change or supplement `load_pool` with a strict result-returning function used by
the pipeline preflight; existing rendering selection can remain a `Vec` consumer
after preflight succeeds.

- [ ] **Step 5: Verify GREEN**

```powershell
rtk cargo test -p thoth-core ocr_metadata
rtk cargo test -p thoth-core enrichment
```

- [ ] **Step 6: Commit**

```powershell
rtk git add crates/thoth-core/src/ingest/content_search.rs crates/thoth-core/src/edit/enrichment.rs
rtk git commit -m "feat(core): validate OCR metadata contract"
```

---

## Task 6: Build the supervised Rust local-OCR adapter

**Files:**

- Create: `crates/thoth-core/src/pipeline/ocr.rs`
- Modify: `crates/thoth-core/src/pipeline/mod.rs`
- Modify: `crates/thoth-core/src/ingest/content_search.rs`
- Modify if needed for Windows atomic replace:
  `crates/thoth-core/Cargo.toml`

**Interfaces:**

```rust
pub async fn run_local_ocr(
    execution: &JobExecutionContext,
    video_path: &Path,
) -> Result<OcrAnalysis>;

pub fn source_fingerprint(video_path: &Path) -> Result<String>;
pub fn apply_analysis(context: &mut MainContext, analysis: &OcrAnalysis) -> Result<()>;
pub fn save_main_context_atomic(base_dir: &Path, context: &MainContext) -> Result<()>;
```

- [ ] **Step 1: Write failing pure adapter tests**

Test:

- valid analyzed stdout parses;
- failed status is rejected;
- zero exit plus invalid JSON is rejected;
- unsupported schema/model/analyzer is rejected;
- nonzero exit includes sanitized stderr but never a bearer token;
- source fingerprint changes when file length/mtime identity changes;
- applying analysis overwrites stale trim/mute/blur and metadata;
- atomic save preserves all pre-existing narration-grounding fields.

- [ ] **Step 2: Verify RED**

```powershell
rtk cargo test -p thoth-core pipeline::ocr --no-run
```

- [ ] **Step 3: Implement runtime resolution and subprocess supervision**

Extract/reuse the current `<repo>/scout` and Bun resolution logic from
`Commands::Scout`. Invoke:

```text
bun <scout>/cli.ts ocr-local <absolute local video path>
```

through `JobExecutionContext::output`. Validate process status and the single JSON
stdout envelope. Reject extra non-whitespace stdout.

- [ ] **Step 4: Implement safe persistence**

Load existing `content_context.json` or default it, replace only OCR metadata and
directives, serialize to a same-directory temporary file, flush it, and atomically
replace the destination. On Windows use the existing `windows-sys` dependency
with the narrow filesystem feature/API needed for replace-existing semantics.
Clean up only the known temporary file on failure.

- [ ] **Step 5: Verify GREEN**

```powershell
rtk cargo test -p thoth-core pipeline::ocr
```

- [ ] **Step 6: Commit**

```powershell
rtk git add crates/thoth-core/src/pipeline/ocr.rs crates/thoth-core/src/pipeline/mod.rs crates/thoth-core/src/ingest/content_search.rs crates/thoth-core/Cargo.toml
rtk git commit -m "feat(core): supervise local Scout OCR"
```

---

## Task 7: Enforce OCR in pipeline state, resume, and edit preflight

**Files:**

- Modify: `crates/thoth-core/src/pipeline/state.rs`
- Modify: `crates/thoth-core/src/pipeline/mod.rs`
- Modify: `crates/thoth-core/src/edit/enrichment.rs`

**Interfaces:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrStageResult {
    pub status: OcrStatus,
    pub schema_version: u32,
    pub analyzer_version: String,
    pub model: String,
    pub source_fingerprint: String,
    pub completed_at: DateTime<Utc>,
}
```

- [ ] **Step 1: Write failing state/freshness tests**

Add tests:

- old state without `stages.ocr` deserializes;
- matching fingerprint/schema/model/analyzer is reusable;
- each mismatch is not reusable;
- missing or failed context prevents reuse;
- a rerun decision invalidates `state.stages.edit`;
- strict enrichment preflight rejects unsafe video before edit.

Extract small pure helpers (`ocr_is_fresh`, `invalidate_after_ocr_rerun`) so tests do
not execute ingest/network/FFmpeg.

- [ ] **Step 2: Verify RED**

```powershell
rtk cargo test -p thoth-core ocr_is_fresh --no-run
```

- [ ] **Step 3: Add `stages.ocr` with legacy defaults**

Add `#[serde(default)] pub ocr: Option<OcrStageResult>` to `StageResults`.
Failed attempts are never stored as completed stages.

- [ ] **Step 4: Insert the required stage after ingest**

Immediately after cloning `video_path`:

1. calculate the current fingerprint/model/analyzer identity;
2. reuse only if state and persisted main context both pass freshness checks;
3. otherwise run supervised local OCR;
4. update `content_context.json`;
5. set `state.stages.ocr`;
6. clear `state.stages.edit` if it was already complete;
7. save state;
8. only then continue to transcribe.

Update stage headers/counts consistently. OCR errors propagate with
`context("local OCR stage failed")`; they are not downgraded to warnings.

- [ ] **Step 5: Add edit preflight**

Before narration/edit, strictly validate:

- persisted main context is analyzed/current;
- every renderable video in `content_enrichment.json` is analyzed/current and has
  valid directives.

Absent enrichment is valid. Present still-image-only enrichment is valid.

- [ ] **Step 6: Verify GREEN**

```powershell
rtk cargo test -p thoth-core ocr_is_fresh
rtk cargo test -p thoth-core pipeline
rtk cargo test -p thoth-core enrichment
```

- [ ] **Step 7: Commit**

```powershell
rtk git add crates/thoth-core/src/pipeline/state.rs crates/thoth-core/src/pipeline/mod.rs crates/thoth-core/src/edit/enrichment.rs
rtk git commit -m "feat(core): enforce OCR before transcribe and edit"
```

---

## Task 8: Integration regression, full verification, and documentation

**Files:**

- Modify: `BLUEPRINT.md`
- Modify only if required by verified behavior:
  `docs/superpowers/specs/2026-07-23-pipeline-enforced-local-ocr-design.md`

- [ ] **Step 1: Run all offline Scout verification**

```powershell
rtk bun scout/lib/subtitle_vision.test.ts
rtk bun scout/pipeline/ocr_local.test.ts
rtk bun scout/lib/validate.test.ts
rtk proxy powershell -NoProfile -Command 'Push-Location scout; bun run typecheck; bun run lint; Pop-Location'
```

- [ ] **Step 2: Run the full Rust suite**

```powershell
rtk cargo test -p thoth-core
```

Expected: zero failures, including legacy-state, context persistence, freshness,
strict preflight, cancellation-adapter parsing, bbox, trim, and blur projection
regressions.

- [ ] **Step 3: Run the repository-required CUDA/release build**

```powershell
rtk proxy powershell -NoProfile -Command 'cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; exit $LASTEXITCODE'
```

Inspect `build_log.txt` and the release binary timestamp. Expected: exit zero and
no compile errors.

- [ ] **Step 4: Run an explicit live OCR smoke test**

Use the investigated local source:

```text
C:\Users\mfr\.thoth\projects\645bc68c-d549-4a46-a295-201d836d9180\
outputs\d3e80c8a-90e0-4eae-a20c-8561126eb5cd\source\DbBUPFNhIRE.mp4
```

Expected:

- `ocr_status: analyzed`;
- model `deepseek/deepseek-ocr`;
- `trim_start` around the verified headline boundary;
- `mute_audio: true`;
- subtitle blur regions target later lower captions;
- headline geometry is absent from subtitle blur;
- requested and valid frame counts are equal.

- [ ] **Step 5: Run one pipeline integration against a disposable output**

Use a fresh output directory, then inspect:

- `state.json` contains a completed OCR stage;
- `content_context.json` contains analyzed metadata and directives;
- OCR log appears before transcribe;
- the rendered clip starts after the headline;
- later blur follows subtitle movement;
- rerunning with resume reuses fresh OCR;
- changing/removing OCR stage metadata forces rerun and edit invalidation.

Do not overwrite the user's reported output directory.

- [ ] **Step 6: Update architecture documentation**

Record in `BLUEPRINT.md`:

- enforced post-ingest OCR stage;
- fail-closed status semantics;
- local source fingerprint/resume behavior;
- Scout/Rust versioned OCR contract;
- strict enrichment preflight;
- all-frame bbox union invariant.

- [ ] **Step 7: Final checks and documentation commit**

```powershell
rtk git diff --check
rtk git status --short
rtk git add BLUEPRINT.md
rtk git commit -m "docs(blueprint): record enforced local OCR stage"
```

Confirm all pre-existing unrelated dirty files remain untouched.

## Self-Review

- **Root cause coverage:** Tasks 1, 3, 6, and 7 eliminate the Scout-only/stale
  handoff gap and force analysis of the ingested local main.
- **Missing vs clean:** Tasks 1, 4, 5, and 7 give missing/failed OCR separate
  states and reject both.
- **Headline vs subtitle:** Task 2 locks the independent trim/blur behavior and
  prevents headline geometry from becoming a subtitle censor.
- **BBox accuracy:** Task 2 asserts extrema over all constituent frame boxes while
  preserving separate spatial tracks.
- **Main and footage:** local main enforcement is Tasks 6–7; footage metadata and
  rejection are Tasks 4–5 and the edit preflight in Task 7.
- **Resume:** Tasks 6–7 fingerprint the source, version the analyzer/model, rerun
  stale state, and invalidate completed edit output.
- **Operational safety:** all live calls are deferred to Task 8; ordinary tests
  are dependency-injected and offline.
- **No placeholders:** all production tasks name files, interfaces, red commands,
  minimal green behavior, verification, and commit boundaries.

