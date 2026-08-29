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
