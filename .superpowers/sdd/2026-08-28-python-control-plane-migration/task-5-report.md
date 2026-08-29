# Task 5 implementation report

## Result

Committed the first durable source-investigation Temporal workflow as
`d1c2e15` (`feat: run durable source investigation workflows`).

## Changed files

- `python/src/thoth_control_plane/workflows/__init__.py`
- `python/src/thoth_control_plane/workflows/source_investigation.py`
- `python/src/thoth_control_plane/activities/__init__.py`
- `python/src/thoth_control_plane/activities/source_investigation.py`
- `python/src/thoth_control_plane/infrastructure/temporal_gateway.py`
- `python/src/thoth_control_plane/worker.py`
- `python/src/thoth_control_plane/application/ports.py`
- `python/src/thoth_control_plane/application/workflows.py`
- `python/src/thoth_control_plane/api/app.py`
- `python/tests/workflows/__init__.py`
- `python/tests/workflows/test_source_investigation.py`

The pre-existing untracked `docs/research/` directory was not staged or modified.

## Test-first evidence

The first workflow test run failed at collection with the expected missing boundary:

`ModuleNotFoundError: No module named 'thoth_control_plane.workflows'`

The real Temporal test server was available. A direct
`WorkflowEnvironment.start_time_skipping()` startup printed
`TEMPORAL_TEST_SERVER_READY` and shut down cleanly. No fake durability substitute was
used.

Fresh final verification:

- `rtk uv run pytest -q` — **65 passed in 2.03s**.
- `rtk uv run pytest tests/workflows/test_source_investigation.py -q` — **6 passed in 1.45s**.
- `rtk uv run pytest tests/workflows/test_source_investigation.py tests/application/test_workflows.py tests/api/test_workflows.py -q` — **36 passed in 1.81s**.
- `rtk uv run ruff check src tests` — **All checks passed**.
- `rtk uv run ruff format --check src tests` — **31 files already formatted**.
- `rtk git diff --cached --check` — clean before commit.

## Spec self-review

- `SourceInvestigationWorkflow.run(request, actor_snapshot)` is registered on the exact
  `thoth-control-plane` task queue by the worker.
- The workflow executes `inspect_source_candidates` with a five-minute close timeout and
  a maximum of three attempts. Activity failures become a fixed typed workflow failure;
  provider exception text does not enter the returned summary.
- `identify_original` returns `succeeded` with a `source_report` artifact reference.
- `produce_video` enters `awaiting_approval` with a
  `continue_to_acquisition` approval and uses `workflow.wait_condition` until the exact
  authorized approval or cancellation arrives.
- Approval signals are rejected defensively when the approval ID, decision, actor ID,
  actor type, state, or prior decision does not match. Duplicate/stale signals cannot
  resume the workflow twice.
- Cancellation signals produce the explicit `cancelled` workflow status. The application
  service performs an actor-scoped read before cancellation and validates the active
  approval before delegating the approval signal; the Temporal gateway repeats the checks.
- Workflow-owned fields contain only opaque request/actor/workflow IDs, safe source
  metadata, status, artifact references, active approval metadata, safe failure metadata,
  and event sequence. Candidate results are discarded after retaining the report ref;
  signed URL query data is removed from the summary.
- `TemporalWorkflowGateway` uses the Pydantic Temporal converter, deterministic workflow
  IDs scoped by actor and idempotency key, a Temporal memo containing the idempotency key
  and request snapshot ID, and reuse semantics for existing workflow IDs.
- FastAPI routes remain dependent only on the application service. Temporal connection,
  task queue, activity, and worker knowledge are confined to application startup,
  infrastructure, workflow, and worker modules. No CLI or process behavior was added.
- FastAPI lifespan probes Temporal. An outage leaves `/healthz` at 200 while `/readyz`
  returns 503 and state-changing routes retain the unavailable gateway.
- `worker.py` registers exactly `SourceInvestigationWorkflow` and
  `inspect_source_candidates` on `thoth-control-plane`.

## Quality self-review

- Public-behavior tests use the real Temporal `WorkflowEnvironment` and Worker.
- Coverage includes identify-original completion, durable approval waiting, unauthorized
  signal rejection, cancellation, bounded activity retries with safe failures, gateway
  durable ID reuse/actor isolation, and liveness/readiness separation.
- Temporal history uses the Pydantic data converter so strict v1 models and `HttpUrl`
  values serialize without ad-hoc dictionaries at the gateway boundary.
- Activity candidates/raw provider payloads are not copied into workflow-owned state or
  returned workflow summaries; only the safe artifact reference is retained.
- The staged diff contained only the eleven Task 5 files listed above.

## Fix round 1 — 2026-08-29

Committed review corrections in `d2b5c228b62b5e79142071e313d0d040896e55fa` (`fix: harden durable source workflow boundaries`).

### Test-first evidence

- RED: `rtk uv run pytest tests/workflows/test_source_investigation.py -q` failed at collection because `SourceInvestigationActivityResult` did not exist.
- RED: the new runtime readiness test returned 200 after its gateway became unavailable.
- GREEN: `rtk uv run pytest tests/workflows/test_source_investigation.py tests/application/test_workflows.py tests/api/test_workflows.py -q` — **41 passed in 2.88s**.
- GREEN: `rtk uv run pytest -q` — **70 passed in 2.60s**.
- Quality: `rtk uv run ruff check src tests` passed; `rtk uv run ruff format --check src tests` reported **31 files already formatted**.

### Corrections covered

- Temporal workflow/activity history now has only typed redacted identifiers, safe display metadata, artifact references, and typed activity failures; serialized-history tests exclude the signed URL and raw candidate data.
- Workflow identity, authorization, and application idempotency scope include both actor type and actor ID. Durable replays compare the request fingerprint and query the authoritative summary.
- Source reports are materialized before their references return; cancellation wins over an activity failure; approval/cancel integration goes through the authorized gateway boundaries.
- `/readyz` checks current Temporal availability, and lifespan only turns expected connection errors into an unavailable gateway.

## Concerns

None blocking Task 5. Provider-specific source discovery remains deliberately outside this
first Python activity boundary; the plan assigns the temporary legacy implementation and
its process-cancellation proof to Task 6.
