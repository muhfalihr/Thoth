# Task 5 — Execution Context Pipeline Propagation

## RED

Command run before production implementation:

```powershell
cargo test -p thoth-core cancelled_context_stops_before_next_stage -- --nocapture
```

Expected and observed failure (exit 1): `E0425`, `run_cooperative_stage` was not found in `pipeline/mod.rs`. This proved the original pipeline had no cooperative stage-boundary seam or execution-context propagation.

## GREEN

Implemented a private cooperative stage helper and its pipeline test. `PipelineRunner`, every requested stage service, direct CLI entry points, `run_once`, and the worker now share one `JobExecutionContext`. The helper checks before and after each top-level stage; checkpoints are guarded immediately before persistence. Service-stage cancellation checks keep `Cancelled` in the `anyhow` error chain, including the best-effort enrichment path, and the final output is reached only after another cancellation check.

Focused verification:

```powershell
cargo test -p thoth-core cancelled_context_stops_before_next_stage -- --nocapture
```

Result: passed — 1 passed, 0 failed.

## Verification

```powershell
cargo check -p thoth-core
```

Result: passed (exit 0).

```powershell
cargo test -p thoth-core
```

Result: passed — 130 passed, 0 failed.

```powershell
git diff --check
```

Result: passed (exit 0).

```powershell
cargo fmt --all -- --check
```

Result: reports pre-existing formatting differences in unrelated files (for example `crates/thoth/src/main.rs`, `analyze/asset_catalog.rs`, provider modules, and `rag/vocab.rs`). It made no changes. The Task 5 diff was not broadened to reformat those user-owned/unrelated files.

No external-command adapter was modified; Task 6 behavior was left out of scope.

## Iteration Seam Follow-up

### RED

```powershell
cargo test -p thoth-core cancelled_context_stops_before_next_cooperative_item -- --nocapture
```

Expected and observed failure (exit 1): `E0425`, `run_cooperative_item` was not found. This established that production had no reusable per-item cancellation boundary for the identified concurrent/sequential loops.

### GREEN

Added the crate-private, production-used `run_cooperative_item` helper. It checks the same `JobExecutionContext` before and after each unit and keeps `Cancelled` typed. The regression cancels after its first item and verifies that its second item is never entered.

The helper now guards:

- each visual re-rank item, including scene detection, frame extraction, and vision scoring;
- every transcribe chunk extraction and bounded Groq upload item;
- the primary and each additional montage overlay fetch.

Visual re-ranking returns an `anyhow::Result` so cancellation cannot be collapsed into a zero visual score; it cleans frames before propagating the error. No process adapter was changed.

### Follow-up Verification

```powershell
cargo test -p thoth-core cancelled_context_stops_before_next_cooperative_item -- --nocapture
cargo check -p thoth-core
cargo test -p thoth-core
git diff --check
```

Results: focused regression passed (1/1); type-check passed; full suite passed (131/131); diff check passed.

`cargo fmt --all -- --check` continues to report the pre-existing unrelated formatting drift recorded above and made no changes.
