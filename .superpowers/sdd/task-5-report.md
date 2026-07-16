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
