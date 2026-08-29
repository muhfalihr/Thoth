# Task 6 implementation report

## Result

Committed bounded temporary legacy Scout compatibility seam as `08ea50f`
(`feat: isolate legacy scout as cancellable activity`). The new adapter is worker-only,
uses the dedicated `thoth-legacy-adapter` queue with activity concurrency fixed at one,
and is selected only by `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` configuration.
FastAPI routes do not participate in implementation or task-queue selection.

## RED / GREEN evidence

- RED: `rtk uv run pytest tests/activities/test_legacy_scout.py -q` failed during
  collection with `ModuleNotFoundError: No module named
  'thoth_control_plane.activities.legacy_scout'` before the adapter existed.
- GREEN: the new adapter tests passed after adding the strictly typed process-owning
  activity: `3 passed` initially, then `4 passed` with explicit worker selection.
- RED: the explicit selection setting test initially failed because
  `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` was an extra forbidden settings field.
- GREEN: configuration now records only `python` or `legacy_scout` in the durable
  workflow input; the route layer remains unchanged.
- RED: the legacy workflow cancellation test timed out while the legacy activity
  remained active after a cancellation signal.
- GREEN: the workflow now owns and cancels the active activity task, and the test
  proves the legacy activity receives cancellation and the summary reaches
  `cancelled`.

## Behaviour delivered

- `LegacyScoutInput` strictly accepts only opaque workflow/package/cancellation IDs,
  canonical source URL, bounded timeout, and optional typed progress records. It
  rejects dashboard executor knobs such as `cap`.
- The adapter runs a fixed `asyncio.create_subprocess_exec` argv, never a shell;
  heartbeats while waiting; creates an owned process group; and terminates its owned
  process tree on cancellation.
- stdout/stderr are captured only to produce redacted diagnostics. They are never
  parsed into workflow progress or persisted as state. Progress is emitted only from
  explicit typed records, otherwise start/completed/failed lifecycle records.
- The normal Python activity remains on `thoth-control-plane`; the compatibility
  wrapper is registered only on `thoth-legacy-adapter` with concurrency one.
- `docs/python-control-plane.md` records the adapter retirement gate: equivalent
  offline fixture, controlled live smoke, cancellation, restart/retry proof, and no
  production `bun scout/cli.ts` dependency before removal.

## Verification

- `rtk uv run pytest tests/activities/test_legacy_scout.py tests/workflows/test_source_investigation.py -q` — **16 passed**
- `rtk uv run ruff check src tests` — **passed**
- `rtk uv run ruff format --check src tests` — **33 files already formatted**
- `rtk uv run pytest -q` — **76 passed**
- `rtk git diff --cached --check` — **passed**

## Changed files

- `python/src/thoth_control_plane/activities/__init__.py`
- `python/src/thoth_control_plane/activities/legacy_scout.py`
- `python/src/thoth_control_plane/config.py`
- `python/src/thoth_control_plane/domain/models.py`
- `python/src/thoth_control_plane/infrastructure/temporal_gateway.py`
- `python/src/thoth_control_plane/worker.py`
- `python/src/thoth_control_plane/workflows/source_investigation.py`
- `python/tests/activities/test_legacy_scout.py`
- `python/tests/workflows/test_source_investigation.py`
- `docs/python-control-plane.md`

Pre-existing untracked `docs/research/` was not changed or staged.
