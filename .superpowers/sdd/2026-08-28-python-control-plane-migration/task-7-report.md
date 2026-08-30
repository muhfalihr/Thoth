# Task 7 implementation report

## Result

Completed the first generated-contract dashboard and CLI cutover on `master`. The React
dashboard now starts and follows v1 workflows using generated FastAPI types and user-facing
vocabulary, while the existing Scout UI remains explicitly available as the **Legacy console**.
The Python `thoth-control` Typer entry point is a thin HTTPX client for the same v1 request,
summary, approval, cancellation, and retry contract.

Implementation commit: `f6c6875` (`feat: add workflow dashboard and typed cli client`).

## Inherited state

Task 7 began from an uncommitted handoff containing the intended exporter, generated contract,
client, components, App integration, CLI, and initial tests. No inherited Task 7 change was reset,
discarded, or replaced wholesale. The unrelated untracked `docs/research/` directory was not
modified or staged. `progress.md` was not edited.

The inherited focused behavior was already green when resumed:

- dashboard wizard/monitor/client: **4 passed, 0 failed**;
- Python CLI start test: **1 passed**.

## RED / GREEN evidence

- RED: reproducible type generation failed because the inherited package script used a transient
  `bunx openapi-typescript@latest` installation which could not resolve `@babel/code-frame`.
- GREEN: pinned `openapi-typescript ^7.13.0` as a dashboard development dependency and changed the
  script to the local binary. Export plus generation now completes successfully and updates the
  committed generated file from `python/openapi.json`.
- RED: two added SSE contract tests failed: an incremental `stage.progress` object was delivered
  directly to the UI instead of an authoritative `WorkflowSummary`, and a frame split between
  network chunks produced only one snapshot refresh instead of two.
- GREEN: the client now preserves partial SSE frames, advances the stable event cursor, and turns
  every incremental event into a serialized authoritative summary refresh. The callback is typed
  as `WorkflowSummary` rather than `unknown`.
- RED: a delayed initial snapshot could arrive after an event refresh and overwrite `running` with
  stale `queued` state (`expected "running", received "queued"`).
- GREEN: snapshot refreshes are serialized, so later event-driven reads remain the final visible
  state. Focused control-plane client suite: **5 passed, 0 failed**.
- CLI coverage was expanded across `start`, `watch`, `approve`, `cancel`, and `retry`; focused CLI
  suite: **5 passed, 0 failed**.

## Verification

- `uv run python scripts/export_openapi.py` — passed.
- `bun run --cwd dashboard generate:control-plane-types` — passed with
  `openapi-typescript 7.13.0`.
- dashboard full test suite — **48 passed, 0 failed, 142 assertions**.
- dashboard production build — passed, **2036 modules transformed**.
- dashboard lint — exit 0; three pre-existing warnings remain in `ui/badge.tsx`,
  `ui/button.tsx`, and `Discovery.tsx`.
- Python focused CLI suite — **5 passed**.
- Python full test suite — **88 passed**.
- `uv run ruff check .` — passed.
- `uv run ruff format --check .` — **37 files already formatted**.
- `git diff --check` — passed.

## Changed files

- `python/scripts/export_openapi.py`
- `python/openapi.json`
- `python/src/thoth_control_plane/cli.py`
- `python/tests/test_cli.py`
- `python/pyproject.toml`
- `dashboard/package.json`
- `dashboard/bun.lock`
- `dashboard/src/api/generated/control-plane.ts`
- `dashboard/src/api/control-plane.ts`
- `dashboard/src/api/control-plane.test.ts`
- `dashboard/src/components/WorkflowWizard.tsx`
- `dashboard/src/components/WorkflowWizard.test.tsx`
- `dashboard/src/components/WorkflowMonitor.tsx`
- `dashboard/src/components/WorkflowMonitor.test.tsx`
- `dashboard/src/App.tsx`
- `.superpowers/sdd/2026-08-28-python-control-plane-migration/task-7-report.md`

## Fix round 1

### Inherited state and RED/GREEN evidence

- Inherited, uncommitted work introduced the typed v1 route, application port/service seam, in-memory API/application fixtures, and initial API/Temporal tests. It did not implement `TemporalWorkflowGateway.stream_events`; the focused workflow suite failed with `AttributeError: 'TemporalWorkflowGateway' object has no attribute 'stream_events'`.
- GREEN: the Temporal gateway now authorizes through `_authorized_handle`, queries the durable workflow-owned `workflow_events` query, and yields only strictly later `WorkflowEvent` records. The workflow stores safe typed lifecycle events for approval, completion, failure, and cancellation. The focused Temporal replay/authorization test passed.
- RED: an authorized event endpoint with an empty event history returned a successful empty body. `test_workflow_events_emit_an_initial_snapshot_when_no_events_are_available` failed because `"event: workflow.snapshot"` was absent.
- GREEN: the route now emits a typed, safe current-state snapshot when a fresh stream has no replay records; reconnects with `Last-Event-ID` still replay only later records. Routes remain application-service only and contain no CLI/process behavior.
- RED: the monitor issued its own `getWorkflow` request alongside the stream, allowing a delayed stale response to overwrite a newer stream state. It also ignored action results/errors and used highest-stage progress.
- GREEN: monitor state comes solely from `streamWorkflow`; cancel/retry/approve apply returned summaries and surface failures in an alert; progress is the average across all stages (completed stages count as 1); the binding reads exactly `Needs decision`.

### Root-cause investigation

The first Temporal implementation run failed at `awaiting.approval` with `AttributeError: 'NoneType' object has no attribute 'approval'`. Focused reproduction consistently reached that line. Comparison with Task 5 showed `wait_for_status` deliberately returns `None`; the inherited new test assigned its return value instead of querying the workflow after the wait. Minimal hypothesis test changed only the test to query `SourceInvestigationWorkflow.summary` after waiting. It passed (`1 passed in 0.80s`), proving the failure was a test-fixture misuse rather than a gateway/query defect.

### Verification

- `rtk uv run pytest tests/api/test_workflows.py tests/application/test_workflows.py tests/workflows/test_source_investigation.py -q` — **50 passed**.
- `rtk uv run pytest -q` — **93 passed**.
- `rtk uv run python scripts/export_openapi.py` and `rtk bun run generate:control-plane-types` — passed; `python/openapi.json` and committed generated client were refreshed.
- `rtk bun test` — **50 passed, 0 failed, 148 assertions**.
- `rtk bun run build` — passed (2036 modules transformed).
- `rtk bun run lint` — exit 0; three existing warnings remain in `ui/button.tsx`, `ui/badge.tsx`, and `Discovery.tsx`.
- `rtk uv run ruff check .`, `rtk uv run ruff format --check .`, and `rtk git diff --check` — passed.
