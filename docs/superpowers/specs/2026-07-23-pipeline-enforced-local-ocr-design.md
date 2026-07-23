# Pipeline-Enforced Local OCR — Design

**Date:** 2026-07-23  
**Status:** Approved design, pending written-spec review

## Context

The DeepSeek-OCR headline/subtitle tracker is implemented in Scout and its
directives are already consumed by the Rust renderer. However, a pipeline run can
still render without those directives:

- Scout is the only component that currently runs OCR.
- `thoth run --content` trusts the supplied content-set.
- resumed runs can reuse a content-set created before OCR fields existed.
- missing OCR data is represented by the same defaults as an actually clean
  video: `trim_start: 0`, `mute_audio: false`, and `subtitle_blur: []`.
- OCR setup, frame extraction, or model failures currently degrade to a clean
  verdict.

In the investigated run, the exact local main video produced the correct
DeepSeek-OCR result when invoked directly (`trim_start: 3.5`, muted source audio,
and six tracked blur windows), but the renderer received only default directives.
The detector worked; the run path did not enforce its execution or freshness.

This design makes OCR a required pipeline contract. It supersedes the fail-open
OCR error behavior in the 2026-07-22 OCR designs while preserving their
classification, source-timing, and render-projection rules.

## Goals

- Analyze the ingested local main video before transcription, analysis, or edit.
- Never treat missing or failed OCR as evidence that a video is clean.
- Persist OCR status and directives so resume behavior is deterministic.
- Prevent stale content-sets from bypassing OCR.
- Require every video enrichment candidate handed to the renderer to have a
  successful OCR analysis.
- Keep headline trimming independent from subtitle censoring.
- Calculate blur geometry from all relevant boxes in each temporal track/window,
  not from the first sampled frame.
- Fail the run when a video that may be rendered cannot be safely analyzed.

## Non-Goals

- Replacing `deepseek/deepseek-ocr` with another model.
- Porting the complete OCR classifier from TypeScript to Rust.
- Running live Novita calls in ordinary unit tests.
- Pixel-level text removal or inpainting.
- Reanalyzing still images, screenshots, or non-video enrichment entries.

## Chosen Architecture

Use a hybrid Rust/Scout integration:

- Scout remains the sole implementation of frame sampling, DeepSeek response
  parsing, text tracking, cover classification, and blur geometry.
- Scout exposes a machine-readable local-video OCR command.
- Rust owns pipeline enforcement, cancellation, persistence, resume semantics,
  and fail-closed behavior.

This avoids a second OCR classifier in Rust and ensures Scout selection and Rust
rendering use the same model and classification rules.

### Rejected alternatives

**Port OCR to Rust.** This would remove the Bun runtime boundary, but it would
duplicate the classifier and create two implementations that can diverge in
sampling, parsing, tracking, and geometry.

**Run OCR only inside the renderer.** This would detect stale inputs late, mix
network/model work into FFmpeg orchestration, and make failure dependent on which
candidate happened to be selected.

**Keep OCR Scout-only and strengthen validation.** Validation alone cannot
guarantee that the locally ingested main video was analyzed by the current
pipeline or current detector version.

## OCR Result Contract

The existing `ClipVerdict` remains the rendering directive payload. A new
analysis envelope distinguishes a verified clean verdict from an unavailable
verdict:

```ts
type OcrStatus = 'analyzed' | 'failed';

type OcrAnalysis = {
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

Rules:

- `ocr_status: analyzed` requires a valid duration and every scheduled frame to
  be extracted and successfully processed after bounded retries.
- A successful model response containing no OCR boxes is a valid analyzed frame.
- Missing credentials, missing Bun/Scout runtime, invalid duration, frame
  extraction failure, timeout, HTTP failure, malformed model output, or incomplete
  sample coverage produces `ocr_status: failed`.
- `verdict` is required only for `analyzed`.
- `error_message` is sanitized and must not contain API keys, authorization
  headers, or raw response headers.
- Absence of `ocr_status` in legacy JSON means **not analyzed**, never clean.

The persisted main and footage records receive:

```text
ocr_status
ocr_model
ocr_analyzer_version
ocr_analyzed_at
ocr_requested_frames
ocr_valid_frames
trim_start
mute_audio
subtitle_blur
```

Failure details go to diagnostics and the surfaced pipeline error rather than
being carried indefinitely in successful content contracts.

## Scout Changes

### Detailed analysis API

Refactor `analyzeSubtitles` around a detailed API that returns `OcrAnalysis`.
Compatibility wrappers may continue returning `ClipVerdict`, but pipeline and
content-set construction must use the detailed API and inspect `ocr_status`.

Per-frame model calls receive bounded retries. Exhausted retries fail the whole
analysis instead of contributing a false clean frame.

### Local OCR command

Add a Scout CLI command with this behavior:

```text
bun scout/cli.ts ocr-local <absolute-video-path>
```

- accepts only a local file;
- writes exactly one JSON `OcrAnalysis` object to stdout;
- sends human-readable diagnostics to stderr;
- exits zero only for `ocr_status: analyzed`;
- exits nonzero for setup, extraction, model, parsing, or coverage failures.

Rust must validate both the process exit status and JSON envelope. A zero exit
with invalid JSON, unsupported schema version, or non-analyzed status is a
pipeline failure.

### Content-set construction

Main-source ranking and footage building persist the OCR metadata alongside the
existing directives.

- Clean main: retained with an explicit successful status.
- Cover main: retained with `trim_start`.
- Subtitle/hybrid main: retained only according to the existing ranking/fallback
  policy, with mute and blur directives.
- Clean footage: retained with an explicit successful status.
- Cover footage: retained with `trim_start`.
- Subtitle footage: rejected as before.
- Failed footage analysis: fail content-set construction; it must not silently
  become clean or enter the renderer pool.

Still-image entries do not require OCR status.

## Rust Pipeline Integration

### Stage placement

Add a required OCR stage immediately after ingest provides a local `video_path`
and before transcription:

```text
ingest -> local OCR -> transcribe -> analyze -> enrich -> edit
```

The stage:

1. locates the repository Scout directory and Bun executable using the same
   runtime-resolution rules as the existing `thoth scout` command;
2. invokes `ocr-local` through `JobExecutionContext`, preserving cancellation and
   process-tree cleanup;
3. parses and validates the `OcrAnalysis` envelope;
4. applies the returned directives to `MainContext`;
5. atomically rewrites `content_context.json`; and
6. records the completed OCR stage and analyzer identity in pipeline state.

If no content-set sidecar exists, the pipeline creates the minimal main context
needed to persist the verified directives without discarding ingest metadata.

### Resume and freshness

Pipeline state gains an OCR stage record containing at least:

```text
status
schema_version
analyzer_version
model
source_fingerprint
completed_at
```

The source fingerprint is derived from stable local file metadata/content
identity and contains no source URL or credentials.

OCR may be reused only when:

- the stage status is analyzed;
- the schema and analyzer versions match the current implementation;
- the configured model matches; and
- the source fingerprint still matches the ingested video.

Missing legacy stage data, a changed video, model change, or analyzer-version
change reruns OCR. A failed OCR attempt is not recorded as a completed stage.

### Fail-closed behavior

The main run aborts before transcription when local OCR is not successfully
analyzed.

Before edit, Rust also validates the enrichment pool:

- every video entry must have `ocr_status: analyzed`;
- each analyzed entry must contain a supported analyzer/schema identity;
- a cover entry must carry a finite, nonnegative `trim_start`;
- all blur coordinates and time windows must be finite and valid.

A missing or failed video-footage status aborts the run with the offending
entry's safe identifier. Non-video entries are unaffected.

## Geometry and Classification Invariants

Headline and subtitle tracks are separate:

- intro headline boxes determine `trim_start`;
- headline boxes before `trim_start` never become subtitle blur regions;
- subtitle boxes at or after the clean boundary determine blur windows;
- a hybrid video may have both positive `trim_start` and subtitle blur windows.

For every temporal blur window, geometry is calculated from every subtitle box
assigned to every constituent sampled frame:

```text
x0 = min(all box.x0)
y0 = min(all box.y0)
x1 = max(all box.x1)
y1 = max(all box.y1)
```

Padding is applied after the union and the result is clamped to normalized
`[0,1]` coordinates. Adjacent windows merge only when their temporal gap and
geometry similarity satisfy the tracker thresholds. This captures moving or
resized subtitles without turning unrelated positions into one oversized
whole-video blur.

The existing Rust source-time projection remains responsible for mapping those
windows through trim, segment selection, and looping.

## Validation

Scout's content-set validator reports an error when:

- main or a video footage entry is missing OCR status;
- status is not `analyzed`;
- analyzed metadata is incomplete or unsupported;
- directive values are non-finite, out of normalized range, or temporally
  invalid; or
- a subtitle-classified footage entry survived footage filtering.

The validator message distinguishes:

- not analyzed;
- analysis failed;
- stale analyzer/model;
- malformed directives.

Rust repeats the safety-critical checks rather than trusting that the external
validator was run.

## Diagnostics and Observability

Logs and JSONL diagnostics include:

- stage start/completion;
- model and analyzer version;
- hashed source identifier;
- requested and valid frame counts;
- retry count and sanitized failure code;
- final outcome and directive counts;
- whether resume reused or invalidated a prior analysis.

No log contains Novita credentials, authorization headers, or a raw private
source URL.

The final run manifest/content context makes it possible to answer whether OCR
ran, which model/version produced the result, and whether that result was reused.

## Testing Strategy

Implementation follows red-green-refactor.

### Scout unit tests

- Missing key returns `failed`, not clean.
- Invalid duration or failed `ffprobe` returns `failed`.
- One permanently failed scheduled frame makes the analysis fail.
- A successful empty OCR response is analyzed-clean.
- Invalid grounding output fails instead of becoming an empty frame.
- CLI prints one valid JSON object and uses exit codes correctly.
- Main and footage records persist successful OCR metadata.
- Failed footage analysis aborts content-set construction.
- Validator rejects missing, failed, stale, and malformed video OCR records.
- Validator ignores OCR status for still-image entries.

### Classifier and geometry regression tests

- Intro headline followed by clean frames produces trim without blur.
- Intro headline followed by subtitles produces both trim and later blur.
- Intro headline geometry never becomes a subtitle blur band.
- Moving subtitle boxes use extrema from all frames in their window.
- Growing and shrinking multi-line subtitles use the complete union.
- Spatially unrelated subtitle windows remain separate.

### Rust unit/integration tests

- The OCR stage runs after ingest and before transcribe.
- Missing legacy OCR state triggers analysis.
- Matching state, model, analyzer, and fingerprint permits reuse.
- Any freshness mismatch reruns analysis.
- Nonzero CLI exit, malformed JSON, wrong schema, or failed status aborts.
- Successful OCR updates `content_context.json`.
- A direct-URL run without a prior sidecar persists a valid context.
- Missing or failed video footage status aborts before edit.
- Still-image enrichment remains valid without OCR metadata.
- Cancellation terminates the supervised OCR subprocess.
- Existing trim, mute, blur, and loop projection tests remain green.

### Required verification

- Scout OCR and validator unit tests.
- Scout TypeScript type-check.
- `cargo test -p thoth-core`.
- repository-required release/CUDA build.
- one explicit live smoke test against the reported source, using Novita only
  after offline tests pass.
- inspect the resulting `content_context.json`, pipeline state, and rendered
  artifact to confirm the intro headline is absent and later subtitle blur is
  correctly positioned.

## Acceptance Criteria

- A pipeline run cannot reach transcription or rendering when main OCR fails.
- A stale or legacy run with no OCR stage reruns OCR automatically.
- Missing OCR fields are never interpreted as a clean verdict.
- The locally ingested main video is the media analyzed by the enforced stage.
- No video enrichment entry reaches rendering without successful OCR metadata.
- Intro headline frames are trimmed and never reused as subtitle blur geometry.
- Blur bbox/window geometry uses all tracked frame boxes rather than the first
  frame only.
- The run artifacts clearly state OCR status, model, analyzer version, and frame
  coverage.
- The investigated failure mode cannot silently reproduce.

