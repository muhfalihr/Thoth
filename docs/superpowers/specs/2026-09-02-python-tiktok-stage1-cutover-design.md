# Python TikTok Stage 1 Operational Soak and Cutover Design

**Status:** Approved

**Date:** 2026-09-02

**Roadmap:** [`docs/python-scout-migration-roadmap.md`](../../python-scout-migration-roadmap.md)

**Predecessor:** [`2026-08-31-python-tiktok-scout-rewrite-design.md`](2026-08-31-python-tiktok-scout-rewrite-design.md)

## Context

Stage 1 implements one public TikTok post URL through Python with Scrapling headless first,
TikWM/CDN fallback second, and an explicit workflow-level legacy Scout fallback. Offline tests,
controlled live acquisition, cancellation, and same-URL Python/Scout parity have passed. The
remaining Stage 1 gate is operational: run the Python path long enough to establish reliability,
prove that fallback and failure behavior remain safe, approve the capability-specific retirement
decision, and change the normal runtime default from fallback mode to Python-only.

The current implementation is not yet sufficient evidence for that decision:

- Python acquisition attempts are available on successful reports but not on terminal Python
  failures.
- When the workflow invokes legacy fallback, the returned legacy events replace the preceding
  Python attempt events, obscuring why fallback occurred.
- The Scrapling library logs signed CDN URLs at INFO unless its logger is constrained by the
  worker.
- No strict, reproducible evaluator turns an exported soak dataset into a readiness decision.
- The runtime default remains `python_tiktok_with_legacy_fallback`, as required until retirement
  gates pass.

This design closes those evidence and operations gaps. It does not add TikTok comments,
social-card capture, profile discovery, keyword search, or trending discovery; those remain Stage
2 capabilities.

## Goals

- Preserve safe Python acquisition attempts on success and failure.
- Preserve Python attempt events when legacy fallback is invoked.
- Record one explicit, deterministic fallback transition using only safe codes and enums.
- Record post-attempt Python cleanup evidence without URLs, paths, provider payloads, or raw
  exceptions.
- Prevent Scrapling library logs from shipping signed URLs or raw provider diagnostics.
- Define a strict version 1 soak-observation contract and deterministic readiness evaluator.
- Require an aggregate-only readiness report and human approval before changing the default.
- Change the normal default to `python` only in a separate, reviewable cutover task.
- Retain explicit fallback and legacy modes as time-bounded emergency rollback switches.

## Non-goals

- Automatically changing runtime mode from telemetry.
- Adding OpenTelemetry, Prometheus, or a metrics backend.
- Exposing activity mode, soak policy, provider selection, or fallback controls through FastAPI or
  the dashboard.
- Logging or persisting source URLs, media URLs, provider hosts, cookies, raw HTML, provider
  bodies, browser traces, exception text, or absolute filesystem paths.
- Adding Stage 2 TikTok capabilities.
- Removing `LegacyScoutActivity`, the isolated legacy task queue, Bun, or `scout/`.
- Replacing deployment-level monitoring, alerting, or incident response.
- Committing workflow-level soak evidence to Git.

## Decision

Use an evidence-based manual cutover.

```text
Python acquisition
    -> typed terminal result plus safe attempts
    -> safe source progress events
    -> deterministic workflow fallback event when applicable
    -> operator export from completed Temporal workflows
    -> strict soak observations (JSONL)
    -> deterministic evaluator
    -> aggregate readiness report
    -> human approval
    -> separate default-mode cutover commit
```

The evaluator never changes configuration. A report with `ready: true` is necessary but not
sufficient: a human operator must also approve the cutover. Rollback remains a deployment
configuration change followed by a worker restart.

## Architecture

The design deepens existing modules and adds one operations module with a small interface.

```text
acquisition/models.py
    terminal report OR failure-with-attempts
                |
activities/source_investigation.py
    attempt events + cleanup event
                |
workflows/source_investigation.py
    preserve Python events + fallback transition + final legacy events
                |
Temporal completed workflow queries
                |
operations/tiktok_soak.py
    collect -> validate -> evaluate -> atomic aggregate report
```

Provider logging is isolated from the evidence flow:

```text
worker startup
    -> configure_provider_logging()
    -> Scrapling capability check
    -> worker starts
```

### Deep-module interfaces

The external operations interface is deliberately small:

```python
def evaluate_tiktok_soak(
    observations: list[TikTokSoakObservation],
    policy: TikTokSoakPolicy = TikTokSoakPolicy(),
) -> TikTokSoakReport: ...
```

All rate calculations, exclusions, duplicate detection, window validation, blocker ordering, and
aggregate report construction live behind this interface. The CLI reads strict JSONL, calls this
function, and writes the result. It does not reimplement policy logic.

The logger configuration interface is also small:

```python
def configure_provider_logging() -> None: ...
```

It is idempotent and invoked before importing or checking browser capabilities in the worker
entry point.

## Acquisition Failure Evidence

`TikTokAcquisitionFailure` gains:

```python
attempts: list[AcquisitionAttempt]
```

The list is bounded to the same maximum of three attempts as the successful report outcome.
Every service failure after strategy execution includes all attempts made so far. Validation
failure before provider execution uses an empty list. Activity-boundary failures such as missing
dependencies, unexpected runner failure, or artifact persistence failure also have no acquisition
attempt list because no trustworthy provider attempt result exists.

`TikTokAcquisitionResult` continues to require exactly one terminal report or failure. A success
keeps its attempts in `report.outcome.attempts`; a failure keeps them in
`failure.attempts`. Attempts are never duplicated across both branches.

No attempt contains a URL, hostname, provider body, message, path, or exception. Its persisted
fields remain strategy, status, safe reason, attempt count, and elapsed milliseconds.

## Source Progress Events

The Python activity produces attempt events for both success and failure:

```json
{"kind":"stage.started","payload":{"stage":"tiktok_headless"}}
{"kind":"stage.failed","payload":{"stage":"tiktok_headless","status":"failed","elapsed_ms":1200,"reason":"headless_blocked"}}
{"kind":"stage.started","payload":{"stage":"tiktok_cdn"}}
{"kind":"stage.completed","payload":{"stage":"tiktok_cdn","status":"succeeded","elapsed_ms":800}}
```

After the runner and its cleanup finish, the activity appends exactly one cleanup event:

```json
{
  "kind": "stage.completed",
  "payload": {
    "stage": "tiktok_cleanup",
    "status": "succeeded",
    "partial_cleanup_passed": true,
    "browser_cleanup_passed": true
  }
}
```

The cleanup checks are scoped to the one-activity worker model used by Stage 1:

- `partial_cleanup_passed` means no `.part` exists under
  `reports/<workflow-id>/` after the activity finishes.
- `browser_cleanup_passed` means the adapter-owned Scrapling session count is zero after close.

If either check fails, the event uses `kind="stage.failed"`, `status="failed"`, and the relevant
boolean is false. The event still contains no process ID, executable path, filesystem path, or
diagnostic text. A failed cleanup gate blocks cutover readiness even if the source workflow later
succeeds through legacy fallback.

The safe event payload allowlist expands only with:

- `partial_cleanup_passed`;
- `browser_cleanup_passed`; and
- `fallback_from`.

Values are booleans or finite safe codes. Bare free-form strings remain forbidden.

## Deterministic Legacy Fallback Evidence

When `python_tiktok_with_legacy_fallback` receives an eligible Python failure, the workflow:

1. retains the Python result's attempt and cleanup events;
2. appends one fallback transition event;
3. runs the legacy activity once; and
4. appends the legacy result's events.

The transition event is:

```json
{
  "kind": "stage.started",
  "payload": {
    "stage": "legacy_fallback",
    "fallback_from": "headless_blocked"
  }
}
```

The workflow constructs it only from the durable activity result and the frozen fallback
allowlist. It performs no I/O, clock reads, logging, environment access, or provider inspection.
Event order is stable across replay.

If legacy returns a result, its existing events follow the transition. If legacy raises an
activity error, the workflow failure remains safe and the preserved Python/fallback events remain
queryable. Python-only and legacy-only modes do not synthesize a fallback transition.

## Provider Log Safety

`configure_provider_logging()` configures the `scrapling` logger namespace before the worker
capability check.

- DEBUG and INFO records from Scrapling are dropped.
- WARNING and ERROR records are replaced with a fixed message such as
  `"scrapling provider event redacted"`.
- `record.args`, `record.exc_info`, `record.exc_text`, and `record.stack_info` are cleared before
  the record reaches an installed handler.
- The filter is idempotent and is not installed multiple times when worker construction is tested.
- Application-owned acquisition logs use fixed event names plus enums, integers, opaque workflow
  IDs, and booleans only.

The filter deliberately sacrifices raw third-party diagnostic detail to guarantee that signed
CDN URLs, query tokens, browser state, and exception messages are not shipped. Provider debugging
requiring raw logs must occur only in a separately approved local diagnostic procedure with log
export disabled; it is outside this design.

## Soak Observation Contract

The operator exports completed workflow summaries and safe source events, then converts them into
strict JSONL observations. Each line has this version 1 shape:

```json
{
  "schema_version": 1,
  "observation_id": "obs_0123456789abcdef",
  "workflow_id": "wf_0123456789abcdef",
  "occurred_at": "2026-09-02T12:00:00Z",
  "activity_mode": "python_tiktok_with_legacy_fallback",
  "route": "python_native",
  "attempts": [
    {
      "strategy": "scrapling_headless",
      "status": "succeeded",
      "reason": null,
      "attempt_count": 1,
      "elapsed_ms": 900
    }
  ],
  "failure_code": null,
  "artifact_validated": true,
  "partial_cleanup_passed": true,
  "browser_cleanup_passed": true,
  "parity_passed": null
}
```

Fields:

- `schema_version`: literal `1`.
- `observation_id`: opaque deterministic identifier; duplicate IDs are rejected.
- `workflow_id`: opaque ID used only for deduplication and operator traceability.
- `occurred_at`: timezone-aware UTC timestamp.
- `activity_mode`: one of the three existing worker-owned modes.
- `route`: `python_native`, `legacy_fallback`, `failed`, `invalid_input`, or
  `operator_cancelled`.
- `attempts`: zero to three safe acquisition attempts in execution order.
- `failure_code`: finite safe code or null. It is null for `python_native`; contains the
  triggering eligible Python code for `legacy_fallback`; contains the terminal code for
  `failed` and `invalid_input`; and is null for `operator_cancelled`.
- `artifact_validated`: true only when the final Python or normalized parity artifact passes its
  schema, containment, MP4-size/signature, byte-count, and checksum checks.
- `partial_cleanup_passed`: result of the Python cleanup event.
- `browser_cleanup_passed`: result of the Python cleanup event.
- `parity_passed`: true/false for designated same-URL parity samples; null otherwise.

The model is strict and rejects extra fields. It cannot contain the source URL, provider URL,
hostname, caption, owner handle, post ID, checksum, path, message, or diagnostic payload.

### Route classification

- `python_native`: Python produced the authoritative report without legacy fallback.
- `legacy_fallback`: an eligible Python failure was followed by the explicit fallback transition.
- `failed`: a valid input ended in a terminal acquisition or infrastructure failure.
- `invalid_input`: input was rejected before any provider or legacy attempt.
- `operator_cancelled`: cancellation was requested by the operator.

Invalid input and operator cancellation are excluded from the reliability denominator. Invalid
input still must have zero attempts and no fallback event. Operator cancellation remains subject
to the controlled cancellation cleanup gate; an observation reporting failed cleanup blocks
readiness.

`unsupported_platform` is an `invalid_input` failure code and is deliberately **not**
legacy-fallback-eligible. It is decided before any provider or legacy attempt exists, so its
observation has zero attempts and no fallback transition — a shape the `legacy_fallback` route
rejects. Routing a non-TikTok platform to legacy under an explicit migration mode is a separate
routing seam, decided by the activity mode and the platform before the Python activity runs,
never by a failure code returned after it.

### Cleanup evidence per terminal route

Every terminal route owes cleanup evidence, and the evidence must have a real source. Absence of
evidence is never a cleanup PASS.

- `acquisition_dependency_unavailable` is a terminal activity result: the activity emits zero
  attempts and exactly one `tiktok_cleanup` event carrying both cleanup booleans, and the
  terminal failure code stays `acquisition_dependency_unavailable`. Emitting it is what keeps the
  zero-tolerance dependency blocker reachable — without it these runs cannot be observed at all
  and silently leave the terminal-failure denominator, letting a *partial* provider outage hide
  from the readiness gate by dropping exactly the runs that should block it.
- `operator_cancelled` cleanup is proven by the **controlled cancellation gate**, not by the
  workflow. A cancelled activity's result cannot be relied upon to carry terminal events, and the
  workflow cannot know what the activity actually cleaned up — so the workflow must not synthesize
  a cleanup event after cancellation. Cancellation propagation and resource cleanup stay as they
  are; the evidence comes from elsewhere.
  - An `operator_cancelled` observation may only be produced from that gate.
  - Its cleanup booleans must come from the gate's measured result, never from a workflow
    assumption.
  - Every workflow inside the soak window must reconcile to exactly one observation.
  - A workflow that is missing, or that has no source of cleanup evidence, leaves the dataset
    not yet fit to inform a cutover decision.

## Soak Policy

`TikTokSoakPolicy` has fixed Stage 1 defaults:

```text
minimum_window_days = 7
minimum_valid_completed_runs = 50
minimum_parity_samples = 5
minimum_python_native_success_rate = 0.95
maximum_legacy_fallback_rate = 0.05
maximum_terminal_failure_rate = 0.02
```

Readiness additionally requires:

- zero `artifact_persistence_failed`;
- zero `acquisition_dependency_unavailable`;
- zero `acquisition_runner_failed`;
- zero redaction or absolute-path audit failure;
- zero failed partial-cleanup evidence;
- zero failed browser-cleanup evidence;
- every designated parity sample has `parity_passed=true`; and
- every invalid-input observation has no acquisition attempt and no fallback route.

The seven-day window is measured from the earliest to latest included valid-completed observation
and must span at least 168 hours. The denominator for native, fallback, and terminal-failure rates
contains routes `python_native`, `legacy_fallback`, and `failed` only. Rates use exact integer
counts; the evaluator does not round before comparison.

The evaluator rejects:

- duplicate observation IDs;
- duplicate workflow IDs;
- unknown schema versions, modes, routes, strategies, statuses, reasons, or failure codes;
- timestamps without UTC offsets;
- observations ordered differently from their timestamps after normalization;
- more than three attempts;
- TikWM preceding Scrapling;
- a fallback route whose `failure_code` is absent or not legacy-fallback-eligible;
- a Python-native route containing a fallback transition; and
- inconsistent terminal fields, cleanup evidence, or parity flags.

Invalid datasets are errors, not `not_ready` reports. Valid datasets that miss thresholds produce
`ready=false` with deterministic blockers.

## Aggregate Readiness Report

The evaluator produces only aggregate evidence:

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-02T12:30:00Z",
  "policy": {
    "minimum_window_days": 7,
    "minimum_valid_completed_runs": 50,
    "minimum_parity_samples": 5,
    "minimum_python_native_success_rate": 0.95,
    "maximum_legacy_fallback_rate": 0.05,
    "maximum_terminal_failure_rate": 0.02
  },
  "window": {
    "started_at": "2026-08-26T12:00:00Z",
    "ended_at": "2026-09-02T12:00:00Z",
    "duration_hours": 168
  },
  "counts": {
    "valid_completed": 50,
    "python_native": 48,
    "legacy_fallback": 2,
    "failed": 0,
    "invalid_input": 1,
    "operator_cancelled": 1,
    "parity_samples": 5
  },
  "rates": {
    "python_native": 0.96,
    "legacy_fallback": 0.04,
    "terminal_failure": 0.0
  },
  "ready": true,
  "blockers": []
}
```

The report excludes observation IDs, workflow IDs, URLs, post identity, captions, checksums,
paths, and per-run timestamps. `generated_at` is supplied by the CLI and passed into the pure
report builder so tests remain deterministic.

The CLI writes `tiktok-stage1-soak-report.json.part`, flushes it, and atomically replaces
`tiktok-stage1-soak-report.json`. It removes the partial file on failure or cancellation.

## Operational Workflow

1. Deploy a worker with `python_tiktok_with_legacy_fallback` and safe provider logging.
2. Run normal approved single-post TikTok traffic for at least seven days.
3. Export completed workflow summaries and safe source events without source URLs or provider
   payloads.
4. Produce strict version 1 observation JSONL outside Git.
5. Mark at least five controlled same-URL parity observations.
6. Run the evaluator and archive the aggregate report through the approved operations channel.
7. Investigate every blocker; never edit observations merely to make the report pass.
8. Obtain explicit human approval.
9. Apply the separate default-mode cutover change.
10. Run a deployment rollback drill before declaring the capability Python-only.

The soak report is evidence for the decision; it is not a runtime configuration input.

## Cutover

The cutover task changes:

- `Settings.THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` default from
  `python_tiktok_with_legacy_fallback` to `python`;
- operations documentation to state Python-only is normal for one public TikTok post; and
- tests that pin the runtime default and gateway propagation.

It does not remove either explicit emergency mode. `python_tiktok_with_legacy_fallback` and
`legacy_scout` remain valid worker-owned configuration values. No request model gains an activity
mode field.

The cutover commit must cite the approved aggregate report through the operator's change record,
not by committing per-workflow evidence or secret-bearing logs.

## Rollback

Rollback is deployment-owned:

1. Set `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback` for ordinary
   recovery, or `legacy_scout` for full acquisition rollback.
2. Restart the Python worker.
3. Confirm gateway-started workflows carry the selected mode.
4. Run one controlled public TikTok post and verify exact Python/legacy activity counts.
5. Confirm no source URL, signed URL, provider payload, or absolute path appears in logs or
   workflow events.

The rollback drill must pass before final cutover approval. Rollback does not mutate in-flight
workflow history; already-started workflows retain their durable input mode.

## Error Handling

- Malformed observation input fails closed with a safe validation error and produces no report.
- Evaluator policy misses produce a valid `ready=false` report with sorted finite blocker codes.
- Observation export or Temporal connection failures are operational failures; they do not alter
  source workflow results.
- Report filesystem failures remove `.part` and return a fixed safe error without the path.
- Provider log filtering never raises into acquisition work; configuration is idempotent and
  completes before browser capability checks.
- A missing or malformed cleanup event makes the observation invalid rather than implicitly
  passing cleanup.
- A legacy fallback without preserved Python failure evidence is invalid and blocks cutover.

## Testing Strategy

### Contracts and event preservation

- Failure models serialize safe ordered attempts and reject more than three.
- Invalid URL failure has no attempts.
- Headless/TikWM terminal failures retain every executed attempt.
- Activity emits attempts on success and failure.
- Activity emits exactly one cleanup event after owned resources close.
- Event payload allowlists reject new free-form keys and strings.
- Workflow fallback preserves Python events, inserts exactly one fallback event, and appends
  legacy events in stable order.
- Python-only and legacy-only routes never emit fallback transition events.
- Replay and Temporal sandbox tests remain bounded and deterministic.

### Provider logging

- Synthetic Scrapling INFO records containing signed URLs are dropped.
- WARNING/ERROR records containing URLs, query tokens, exception text, and stack text reach the
  handler only as the fixed redacted message.
- Repeated configuration does not duplicate filters or handlers.
- Worker configures logging before capability check.

### Evaluator

- Boundary tables cover 6 days 23:59:59 versus 7 days, 49 versus 50 runs, 4 versus 5 parity
  samples, 94% versus 95% native, 5% versus greater-than-5% fallback, and 2% versus
  greater-than-2% terminal failure.
- Zero-tolerance failure codes and cleanup failures always block readiness.
- Invalid input and operator cancellation are excluded from rate denominators.
- Duplicate observation/workflow IDs are rejected.
- TikWM-before-headless and fallback-without-eligible-failure are rejected.
- Aggregate output contains no per-run identity or sensitive field.
- Atomic report output cleans partial files on success, failure, and cancellation.

### Cutover and rollback

- Settings default becomes `python` only in the final cutover task.
- All three explicit modes remain accepted.
- Gateway propagation is pinned.
- No FastAPI schema exposes activity mode.
- `python` mode never invokes legacy.
- Fallback and legacy modes remain operational for rollback.
- Full Python tests, Ruff checks, focused Scout acquisition regressions, controlled canary, and
  rollback drill pass.

## Rollout Sequence

1. Extend failure contracts and safe activity events.
2. Preserve fallback event history deterministically.
3. Install and verify provider log safety before worker startup.
4. Add strict soak models, evaluator, and atomic CLI output.
5. Document observation export, soak execution, decision, and rollback procedures.
6. Deploy fallback mode and collect at least seven days / fifty valid runs / five parity samples.
7. Generate an aggregate readiness report.
8. Obtain human approval and complete the rollback drill.
9. Land the separate default-mode change to `python`.
10. Keep emergency fallback modes until Stage 2 and the broader Scout retirement gates approve
    their removal.

## Acceptance Criteria

- Successful and failed Python acquisitions expose all executed safe attempts.
- Eligible legacy fallback preserves Python attempts and records exactly one safe transition.
- Cleanup evidence is present and false cleanup evidence blocks readiness.
- Scrapling library logs cannot ship signed URLs or raw diagnostics from the worker.
- Strict observation JSONL can be validated without provider or filesystem secrets.
- The evaluator applies the approved 7-day / 50-run / 5-parity / 95%-native / 5%-fallback /
  2%-failure policy deterministically.
- The aggregate report contains no workflow-level identity or sensitive data.
- Invalid datasets fail closed; valid insufficient datasets produce deterministic blockers.
- No runtime mode changes automatically.
- The default changes to `python` only after `ready=true`, human approval, and a rollback drill.
- Explicit fallback and legacy modes remain available after cutover.
- No public request or dashboard control can select activity mode.
- No Stage 2 TikTok capability or non-TikTok adapter is added.

## Follow-on

After this cutover is approved and completed, Stage 2 should be split into separate specifications:

1. TikTok post enrichment: authoritative publication time and engagement normalization, comment
   collection, and social-card capture.
2. TikTok discovery: profile, keyword, and trending discovery producing strict post candidates.
3. TikTok capability retirement: remove the TikTok dependency on Scout fallback after the new
   capabilities pass their own parity, live, soak, and rollback gates.
