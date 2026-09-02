# Python workflow control plane operations

The Python control plane is the v1 product boundary for one source-investigation workflow.
It runs beside the existing Rust server and worker during migration; it does not replace the
Rust media engine or the legacy Scout console.

## Local topology

Run each process from its indicated directory in a separate terminal.

| Process | Local address / queue | Start | Graceful stop |
| --- | --- | --- | --- |
| Temporal development server | gRPC `127.0.0.1:7233`, UI `127.0.0.1:8233` | `temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-port 8233` | `Ctrl+C` in its terminal |
| FastAPI | `127.0.0.1:8000` | From `python/`: `uv run uvicorn thoth_control_plane.api:create_app --factory --host 127.0.0.1 --port 8000` | `Ctrl+C`; Uvicorn drains in-flight HTTP requests |
| Temporal Python worker | `thoth-control-plane` and isolated `thoth-legacy-adapter` task queues | From `python/`: `uv run python -m thoth_control_plane.worker` | `Ctrl+C`; the worker asks Temporal to reschedule unfinished work |
| React dashboard | `127.0.0.1:5173` | From `dashboard/`: `bun run dev --host 127.0.0.1` | `Ctrl+C` |

Use Temporal's development server only for local work. It is separate from the existing Rust
`thoth worker`, whose SQLite queue and lifecycle remain documented in [RUNNING.md](RUNNING.md).
Start Temporal before FastAPI and the Python worker. Stop the dashboard, FastAPI, worker, then
Temporal so the durable service remains available while clients and workers drain.

`thoth_control_plane.api:create_app` is the zero-argument production ASGI factory used by the
Uvicorn command above. It constructs `Settings()` from the environment; tests may still supply
an explicit settings object and gateway to the same factory.

## Configuration without secret disclosure

Set secrets in the process environment or a local secret manager. Do not put values in command
history, documentation, screenshots, diagnostics, `git diff`, or commands such as `env`,
`Get-ChildItem Env:`, `set`, or `echo`. Verify presence with a boolean check, never by printing
the value.

| Variable | Process | Meaning |
| --- | --- | --- |
| `THOTH_CONTROL_PLANE_API_KEY` | FastAPI, CLI | Owner bearer credential. Required. |
| `THOTH_CONTROL_PLANE_CORS_ORIGINS` | FastAPI | JSON list of allowed dashboard origins, for example the local Vite origin. Empty by default. |
| `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` | FastAPI, Python worker working directory | Root for safe relative artifact locations. Defaults to `.thoth-artifacts`; API and worker must resolve the same root. |
| `THOTH_TEMPORAL_TARGET` | FastAPI, Python worker | Temporal gRPC target; default `localhost:7233`. |
| `THOTH_TEMPORAL_NAMESPACE` | FastAPI, Python worker | Temporal namespace; default `default`. |
| `THOTH_LEGACY_API_BASE_URL` | FastAPI | Optional read-only Rust observation bridge base URL. |
| `THOTH_LEGACY_API_KEY` | FastAPI | Secret paired with `THOTH_LEGACY_API_BASE_URL`; configuring only one is rejected. |
| `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` | Python worker / workflow start wiring | Worker-owned implementation choice: `python`, `python_tiktok_with_legacy_fallback` (migration default), or `legacy_scout`. It is never accepted from HTTP. |
| `VITE_CONTROL_PLANE_URL` | Dashboard build/dev server | FastAPI origin, normally `http://127.0.0.1:8000`. |
| `VITE_CONTROL_PLANE_API_KEY` | Dashboard build/dev server | Local owner credential used by the v1 client. Do not commit it. |

The existing Scout UI continues to use its legacy Rust route and `VITE_THOTH_API_KEY`. Setting
`VITE_CONTROL_PLANE_URL` does not redirect legacy Scout traffic into the v1 workflow API.

## TikTok acquisition worker

From `python/`, install the optional acquisition runtime and its browser support before starting a
worker that can inspect public TikTok posts:

```powershell
rtk uv sync --extra acquisition
rtk uv run scrapling install
rtk uv run python -m thoth_control_plane.worker
```

The normal test suite deliberately does not run either installation command and does not launch a
browser, contact TikTok/TikWM, or invoke Bun. The opt-in live gate requires an approved public
post URL in `THOTH_LIVE_TIKTOK_URL`; provide it through the environment or a secret manager and
verify only its presence. Do not echo it, provider credentials, or provider URLs into shell
history, logs, diagnostics, screenshots, reports, or verification output.

`THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` is a worker-owned migration control:

| Mode | Routing behavior |
| --- | --- |
| `python` | Use Python acquisition only; it never invokes the legacy activity. |
| `python_tiktok_with_legacy_fallback` | Migration default. A TikTok post uses Python first; eligible safe failures may run the legacy activity once. Non-TikTok sources route directly to legacy during this slice. |
| `legacy_scout` | Route all source investigation through the isolated legacy activity. Use this as the rollback mode. |

For an eligible TikTok post, the route order is **Scrapling headless -> TikWM/CDN -> legacy
activity**. A successful headless result materializes media locally and does not call TikWM. A
headless failure never becomes the terminal failure code by itself: the service always continues
to TikWM/CDN afterward, so any actually-observed fallback trigger today is one of
`cdn_rate_limited`, `cdn_unavailable`, or `media_validation_failed` — these are the only codes
`python_tiktok_with_legacy_fallback` can invoke the legacy activity for in practice. The
allowlist that gates the fallback (`LEGACY_FALLBACK_ELIGIBLE_CODES`) also accepts
`headless_timeout`, `headless_blocked`, and `headless_incomplete`; these are attempt-reason codes
— they can appear in an activity's `attempts[]` but never as the terminal failure code for a
TikTok run, so a fallback debugged at the terminal-failure level will never show one of them. The
exact non-fallback safe codes are `invalid_tiktok_url`, `unsupported_platform`,
`artifact_persistence_failed`, `acquisition_dependency_unavailable`, and
`acquisition_runner_failed`; unsafe input and internal/persistence/dependency failures do not
silently fall back.

`unsupported_platform` is deliberately outside the allowlist. It is a pre-provider rejection:
decided before any provider or legacy attempt exists, so its observation is `route="invalid_input"`
with zero attempts and no fallback transition — the shape the `legacy_fallback` route rejects.
Sending a non-TikTok platform to the legacy activity under an explicit migration mode is a
separate routing seam, decided by the activity mode and the platform before the Python activity
runs, never by a failure code returned after it.

The worker limits both the Python acquisition queue and isolated legacy queue to one concurrent
activity. Scrapling fetches have a 45-second deadline, TikWM resolution has a 15-second deadline,
media downloads have a 30-second deadline, and the source and legacy Temporal activities have
five-minute start-to-close deadlines; Python may retry up to three attempts while the legacy
activity has one attempt. Reports are written atomically at
`reports/<workflow-id>/source-report.json`, with media at
`reports/<workflow-id>/media/tiktok-<post-id>.mp4`, all relative to
`THOTH_CONTROL_PLANE_ARTIFACT_ROOT`. Legacy reports remain under
`legacy-scout/<workflow-id>/source-report.json`.

To roll back, set `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` to `legacy_scout` through the
approved deployment environment and restart the Python worker. This preserves the isolated,
single-concurrency legacy queue and process ownership; it does not expose a per-request or HTTP
switch.

## TikTok Stage 1 operational soak

The migration default, `python_tiktok_with_legacy_fallback`, is not changed by this section. It
documents the evidence a future operator must gather and the approval a human must give before
anyone proposes changing that default. Nothing here performs, simulates, or records that change.

1. Deploy with `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback`.
2. Export only completed workflow summaries plus safe source events through the approved Temporal
   operations channel; never export source/provider URLs or raw logs.
3. Convert each exported run to the strict schema version 1 JSONL observation contract outside
   Git (see "Observation contract" below), and designate at least five of the converted runs as
   controlled parity samples. Reconcile every workflow in the window to exactly one observation,
   each with a real source of cleanup evidence (see "Cleanup evidence per route").
4. Collect at least 168 hours (7 days) and 50 valid completed runs before evaluating.
5. From `python/`, run:

   ```powershell
   rtk uv run thoth-control operations tiktok-stage1-soak --observations <approved-jsonl> --output-directory <approved-aggregate-directory>
   ```

6. Archive only the aggregate report file, `tiktok-stage1-soak-report.json`, written into
   `<approved-aggregate-directory>`. Investigate every sorted blocker it lists without editing the
   evidence to force a pass.
7. Require `ready: true` in that report, explicit human approval, and the rollback drill under
   "Verification and smoke scope" below, in that order, before anyone proposes the default-mode
   commit. A passing report is evidence for that decision, never the decision itself, and never a
   substitute for the human approval step.

### Observation contract

Each line of the JSONL input is one `TikTokSoakObservation` (schema version 1). Its `route` field
is exactly one of five values:

| Route | Meaning |
| --- | --- |
| `python_native` | Python acquisition succeeded terminally; no legacy fallback was used. |
| `legacy_fallback` | An eligible safe Python failure triggered the temporary legacy activity, which then succeeded. |
| `failed` | A terminal failure with no eligible fallback (for example a persistence, dependency, or runner failure). |
| `invalid_input` | Rejected before any attempt: an invalid TikTok URL or an unsupported platform. |
| `operator_cancelled` | The operator cancelled the run before a terminal outcome. |

An operator does not hand-write this file. It is the output of converting exported, redacted run
summaries into this strict shape; the loader rejects any line that does not match it, including
extra fields.

### Cleanup evidence per route

Every observation's cleanup booleans must come from measured evidence. Absence of evidence is
never a cleanup PASS, and no route may have its cleanup result assumed.

- Routes that reach a terminal activity result — `python_native`, `legacy_fallback`, `failed`,
  and `invalid_input` — carry cleanup evidence from the activity's own `tiktok_cleanup` event.
  This includes `acquisition_dependency_unavailable`: that branch returns zero acquisition
  attempts and exactly one `tiktok_cleanup` event carrying both booleans, keeping those runs
  inside the terminal-failure denominator instead of silently disappearing from it.
- `operator_cancelled` is different. A cancelled Temporal activity cannot be relied on to return
  a terminal result, and the workflow has no way to know what the activity actually cleaned up —
  so the workflow does not synthesize a cleanup event after cancellation, and an operator must
  not invent one either. Cleanup for this route is proven by the **controlled cancellation
  cleanup gate**: a deliberate cancellation run in which the operator, after cancellation
  settles, measures the same two invariants the activity's cleanup event reports — that no
  `.part` file remains under the run's report directory, and that no Scrapling browser session
  is still live — and records those measured values.
  - An `operator_cancelled` observation may only be created from that gate's result.
  - Its `partial_cleanup_passed` and `browser_cleanup_passed` values must be the gate's measured
    values, never a workflow assumption or an operator default.
  - Every workflow that falls inside the soak window must reconcile to exactly one observation.
  - A workflow that is missing from the dataset, or that has no source of cleanup evidence,
    leaves the dataset not yet fit to inform a cutover decision. Reconcile or re-run it; do not
    drop it and do not record it as passing.

### Readiness policy, counts, and rates

`evaluate_tiktok_soak` applies a fixed policy — none of these thresholds is operator-configurable:

| Policy field | Value |
| --- | --- |
| `minimum_window_days` | 7 |
| `minimum_valid_completed_runs` | 50 |
| `minimum_parity_samples` | 5 |
| `minimum_python_native_success_rate` | 0.95 |
| `maximum_legacy_fallback_rate` | 0.05 |
| `maximum_terminal_failure_rate` | 0.02 |

The aggregate report carries only counts, rates, a window, `ready`, and blockers — never a
per-run identity, URL, or timestamp.

Counts (`valid_completed` is `python_native + legacy_fallback + failed`, the denominator for the
rates below): `valid_completed`, `python_native`, `legacy_fallback`, `failed`, `invalid_input`,
`operator_cancelled`, `parity_samples`.

Rates, each a fraction of `valid_completed`: `python_native`, `legacy_fallback`,
`terminal_failure`.

Blockers are sorted lexicographically by their fixed string value and are the closed set:
`insufficient_window`, `insufficient_valid_completed_runs`, `insufficient_parity_samples`,
`python_native_rate_below_minimum`, `legacy_fallback_rate_above_maximum`,
`terminal_failure_rate_above_maximum`, `artifact_persistence_failure_present`,
`acquisition_dependency_failure_present`, `acquisition_runner_failure_present`,
`redaction_audit_failure_present`, `absolute_path_audit_failure_present`,
`partial_cleanup_failure_present`, `browser_cleanup_failure_present`, `parity_failure_present`. A
report with `ready: true` never carries any blocker.

### Fail-closed CLI behavior

`rtk uv run thoth-control operations tiktok-stage1-soak` fails closed. Any I/O error, encoding
error, blank line, malformed JSON, per-observation validation failure, or dataset-level problem
(for example an empty dataset, a duplicate id, or observations out of chronological order) aborts
the entire run before any report is written. It prints the fixed message
`tiktok stage 1 soak evaluation failed` to stderr and exits with status code `1`. It never writes
a partial report, never prints a diagnostic derived from the offending line, and never names an
observation id, workflow id, or path in that message. On success it prints
`tiktok stage 1 soak report written` and writes the report atomically: a sibling `.part` file is
written, flushed, and `fsync`'d, then renamed onto `tiktok-stage1-soak-report.json`; the `.part`
file is removed on any failure or cancellation, so a reader never observes a truncated report.

### Observation evidence is sensitive

Every field in the strict observation contract is aggregate-safe by construction — no URL, no
caption, no checksum, no absolute path. The exported JSONL as a whole is still sensitive
operational evidence: it carries real observation and workflow identifiers and real occurrence
timestamps that can correlate with actual acquisition activity. Do not commit it, paste it into a
ticket, chat, or code review, or print it to a terminal session that is logged or shared. The
repository's `.gitignore` matches the naming convention `tiktok-stage1-soak-observations*.jsonl`
and the atomic partial-write suffix `tiktok-stage1-soak-report.json.part`; write the finished
report only into an approved directory outside the repository tree, never the working directory
default.

The synthetic, non-live example at
`docs/operations/tiktok-stage1-soak-observation.example.jsonl` is safe to commit: it uses a
placeholder observation id, workflow id, and timestamp, and validates against the real
`TikTokSoakObservation` model. It is a fixture for documentation and tooling checks, never a
soak dataset.

## v1 HTTP contract

Every response carries `X-Thoth-Contract-Version: 1`. All state-changing endpoints require
`Authorization: Bearer …`; workflow creation also requires a non-empty `Idempotency-Key`.

| Method and path | Purpose |
| --- | --- |
| `GET /healthz`, `GET /readyz` | Process liveness and Temporal readiness. |
| `GET /api/v1/style-presets` | Safe user-facing style choices. |
| `POST /api/v1/workflows` | Submit a typed workflow request; repeated actor/key/body returns the same workflow. |
| `GET /api/v1/workflows/{workflow_id}` | Read the authoritative summary. |
| `GET /api/v1/workflows/{workflow_id}/events` | Read the current snapshot and ordered SSE replay. |
| `POST /api/v1/workflows/{workflow_id}/approve` | Record the exact active approval decision. |
| `POST /api/v1/workflows/{workflow_id}/cancel` | Idempotently request cancellation. |
| `POST /api/v1/workflows/{workflow_id}/retry` | Request retry from a validated stage. Currently returns `503` because no durable checkpoint policy is implemented. |
| `GET /api/v1/workflows/{workflow_id}/artifacts/{artifact_id}` | Authorize through workflow ownership and stream one referenced artifact. |
| `GET /api/v1/legacy/jobs/{legacy_job_id}` and `/events` | Read-only migration projection; never starts or mutates legacy work. |

The retryable flag on a failure states whether the failed activity is safe to consider for a
future checkpointed retry. It is not permission to rerun now. Until artifact fingerprint and
side-effect checkpoint validation exist, the Temporal gateway rejects retry rather than risk a
duplicate publish, download, or other side effect.

## Events and reconnect

A fresh SSE response begins with `workflow.snapshot`, followed by durable events whose sequence is
after the requested cursor. Durable v1 kinds are `workflow.queued`, `workflow.started`,
`workflow.completed`, `workflow.failed`, `workflow.cancelled`, `stage.started`, `stage.progress`,
`stage.completed`, `approval.required`, `approval.recorded`, `artifact.created`, and
`diagnostic.recorded`.

Durable event `sequence` values strictly increase. Store the last durable SSE `id` and reconnect
with `Last-Event-ID`; do not manufacture a cursor from list position or raw legacy output. The
snapshot is authoritative current state, while replayed events are the audit trail after the
cursor. Reconnect can repeat a snapshot, so clients must apply events idempotently.

## Authorization and approvals

The local v1 implementation maps the valid owner key to an audited `Actor`. Authorization is
checked again at the application/gateway boundary for summary, events, controls, and artifact
download. A missing, wrong, or non-Bearer credential receives `403`; an invisible workflow or
artifact receives the same safe not-found boundary as an absent one.

Approval requires the workflow to be waiting for the exact active `approval_id`, an allowed
`approve` or `reject` decision, and the authenticated workflow owner. Agent SDK pause/resume data
is never authorization. Approval is persisted and signalled through Temporal; restarting FastAPI
or the worker while waiting does not create a second decision or activity execution.

## Redaction and artifact policy

Workflow history and events contain only small typed identifiers, safe source display URLs,
stage state, stable error codes/messages, safe metrics, and `ArtifactRef` metadata. They must not
contain bearer tokens, API keys, cookies, signed URLs, absolute paths, raw provider/model payloads,
browser traces, media bytes, or unredacted stdout/stderr. Query strings and fragments are removed
from stored display URLs. Legacy diagnostic text is redacted before persistence and never drives
workflow state.

Artifact locations are validated relative durable paths. The API resolves them beneath
`THOTH_CONTROL_PLANE_ARTIFACT_ROOT` only after actor/workflow/artifact authorization; it never
returns the storage path or a signed source URL.

## Temporary Legacy Scout activity

`LegacyScoutActivity` is a worker-only compatibility seam. FastAPI routes and requests cannot
select it. When `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=legacy_scout`, the Temporal gateway
records the fixed worker configuration and the workflow dispatches only to
`thoth-legacy-adapter`.

That queue has maximum activity concurrency one to match the single-browser limit. The adapter
launches the registered `bun scout/cli.ts run <canonical-source-url> --out <configured-report>`
command from the repository root, without a shell. It creates the configured report directory
first and returns an artifact only after the report exists below
`THOTH_CONTROL_PLANE_ARTIFACT_ROOT`; otherwise it returns a typed safe failure. It heartbeats
while waiting, owns its process group/tree, gives that tree a bounded graceful-stop interval, then
escalates the full group/tree and reaps the original process. Typed events and safe artifact/error
results cross the activity boundary; stdout and stderr do not.

### Exact retirement gate

Do not remove the adapter until the Python source activity:

1. passes the same offline candidate fixture;
2. completes a controlled live smoke with equivalent safe artifacts and stable failure codes;
3. demonstrates equivalent cancellation and no orphaned browser/process tree;
4. survives API and worker restart with the same retry/rate-limit behavior and performance budget;
5. preserves safe artifact, error, event, and redaction semantics; and
6. repository search plus production smoke prove there is no import, reference, or execution of
   `scout/cli.ts` or Bun on the production source-investigation path.

Only after all six proofs are recorded may the isolated adapter queue and its worker wiring be
removed. A later migration plan must name one bounded replacement activity and its parity fixture;
it must not begin a broad Scout TypeScript or Rust media rewrite.

## Verification and smoke scope

The deterministic offline smoke uses Temporal's time-skipping test server and the real FastAPI,
gateway, workflow, worker, SSE, authorization, approval, cancellation, failure eligibility, and
artifact route seams:

```powershell
cd python
uv run pytest tests/integration/test_control_plane_smoke.py -q
```

This is not a controlled live provider/Scout smoke. A live run additionally requires operator
credentials, network/provider availability, and explicit selection of an approved fixture; never
paste those credentials into the test command or report.

### Required rollback drill

Run this drill before approving a cutover away from the migration default, and keep it as the
standing emergency procedure afterward. It does not run automatically and a passing soak report
does not substitute for it.

1. Set `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback` for ordinary
   recovery, or `legacy_scout` for full acquisition rollback, through the approved deployment
   environment.
2. Restart the Python worker; in-flight workflows retain their durable input mode from when they
   started.
3. Confirm newly gateway-started workflows carry the selected mode.
4. Run one approved public TikTok post and verify exact Python/legacy activity counts against the
   selected mode's expected routing.
5. Audit logs and source events for zero source URLs, signed URLs, provider payloads, exception
   text, and absolute paths.

Do not include real workflow IDs, URLs, environment values, report paths, screenshots, or live
output when recording that this drill was run.
