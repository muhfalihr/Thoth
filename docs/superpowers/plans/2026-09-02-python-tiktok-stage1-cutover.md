# Python TikTok Stage 1 Operational Soak and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce safe, deterministic operational evidence for the existing headless-first TikTok acquisition path and change the normal worker default to Python-only only after the approved soak, human approval, and rollback gates pass.

**Architecture:** Deepen the current acquisition, activity, and workflow boundaries so terminal failures retain safe attempt evidence, activity cleanup is observable, and legacy fallback preserves Python history in replay-stable order. Add one isolated operations module that strictly validates operator-produced JSONL, evaluates the fixed Stage 1 policy without side effects, and writes only an aggregate report atomically; provider log redaction remains a separate worker-startup concern.

**Tech Stack:** Python 3.11+, Pydantic v2 strict models, Temporal Python SDK, Typer, standard-library `logging`/`json`/`fractions`/atomic filesystem operations, pytest, pytest-asyncio, Ruff, Scrapling 0.4.15, Bun Scout regression fixtures.

**Spec:** `docs/superpowers/specs/2026-09-02-python-tiktok-stage1-cutover-design.md`

## Global Constraints

- TikTok single-post acquisition remains `Scrapling headless -> TikWM/CDN`; only the explicit fallback mode may then invoke legacy Scout once.
- The Stage 1 policy is fixed at 7 consecutive days, 50 valid completed runs, 5 parity samples, at least 95% Python-native, at most 5% legacy fallback, and at most 2% terminal failure.
- `artifact_persistence_failed`, `acquisition_dependency_unavailable`, `acquisition_runner_failed`, redaction audit failure, absolute-path audit failure, either cleanup failure, or any failed parity sample is a zero-tolerance blocker.
- Every terminal activity route emits exactly one `tiktok_cleanup` event, including `acquisition_dependency_unavailable` (zero attempts, both cleanup booleans, failure code unchanged), so no terminal run can leave the denominator unobserved.
- `operator_cancelled` cleanup evidence comes only from the controlled cancellation gate, never from a workflow-synthesized event or an operator default; every workflow in the window reconciles to exactly one observation, and a workflow with no cleanup-evidence source leaves the dataset unfit for a cutover decision. Absence of evidence is never a cleanup PASS.
- `invalid_tiktok_url` and `unsupported_platform` are pre-provider rejections: `route="invalid_input"`, zero attempts, never members of `LEGACY_FALLBACK_ELIGIBLE_CODES`.
- Source/provider URLs, hosts, cookies, raw HTML, provider bodies, browser traces, exception text, absolute paths, workflow-level evidence, and per-run identity must never enter logs or the aggregate report.
- Observation models reject extra fields, unknown enum/code values, non-UTC timestamps, duplicates, invalid route/attempt combinations, more than three attempts, and TikWM-before-Scrapling ordering.
- Invalid JSONL is an error and writes no report; a valid dataset below thresholds writes `ready=false` with lexicographically sorted finite blocker codes.
- The evaluator is read-only and never changes runtime configuration. Human approval and a successful deployment rollback drill remain mandatory even when `ready=true`.
- The default mode stays `python_tiktok_with_legacy_fallback` through Tasks 1-8. Task 10 is the only task allowed to change it to `python`.
- `python_tiktok_with_legacy_fallback` and `legacy_scout` remain accepted emergency modes after cutover; no HTTP request or dashboard schema may select a mode.
- Do not remove `LegacyScoutActivity`, its isolated task queue, Bun, or `scout/`, and do not add Stage 2 TikTok or non-TikTok capabilities.
- Run Python commands from `python/`; prefix every shell command with `rtk`; use small commits and preserve unrelated worktree changes.

---

## File Structure

- `python/src/thoth_control_plane/acquisition/models.py`: terminal acquisition contracts, including bounded failure attempts.
- `python/src/thoth_control_plane/acquisition/service.py`: preserve every completed strategy attempt on terminal service failures.
- `python/src/thoth_control_plane/activities/source_investigation.py`: convert success/failure attempts to safe events and append one cleanup event.
- `python/src/thoth_control_plane/domain/models.py`: enforce the closed source-event payload key/value taxonomy.
- `python/src/thoth_control_plane/workflows/source_investigation.py`: replay-safe Python/fallback/legacy event composition.
- `python/src/thoth_control_plane/observability.py`: idempotent third-party provider log suppression/redaction.
- `python/src/thoth_control_plane/operations/tiktok_soak.py`: strict observation/report contracts and pure readiness evaluation.
- `python/src/thoth_control_plane/operations/tiktok_soak_cli.py`: strict JSONL loading and atomic aggregate report persistence.
- `python/src/thoth_control_plane/cli.py`: register the operator-only soak command without exposing runtime mode through HTTP.
- `docs/python-control-plane.md`: operator export, soak, decision, cutover, and rollback runbook.
- `docs/python-scout-migration-roadmap.md`: link the approved Stage 1 operational plan and retain Stage 2 as the next capability slice.

### Task 1: Preserve safe attempts on terminal acquisition failures

**Files:**

- Modify: `python/src/thoth_control_plane/acquisition/models.py:103-127`
- Modify: `python/src/thoth_control_plane/acquisition/service.py:167-277`
- Modify: `python/tests/acquisition/test_models.py`
- Modify: `python/tests/acquisition/test_service.py`

**Interfaces:**

- Consumes: existing `AcquisitionAttempt`, `AcquisitionStrategy`, `AttemptStatus`, and `AcquisitionReason` contracts.
- Produces: `TikTokAcquisitionFailure.attempts: list[AcquisitionAttempt]` with zero to three ordered items; Task 2 reads this field.
- Preserves: `TikTokAcquisitionResult` still contains exactly one of `report` or `failure`, and attempts occur in only that terminal branch.

- [ ] **Step 1: Add failing contract tests for bounded failure attempts**

```python
def test_failure_serializes_safe_ordered_attempts() -> None:
    attempts = [
        AcquisitionAttempt(
            strategy="scrapling_headless",
            status="failed",
            reason="headless_blocked",
            attempt_count=1,
            elapsed_ms=10,
        ),
        AcquisitionAttempt(
            strategy="tikwm_cdn",
            status="failed",
            reason="cdn_unavailable",
            attempt_count=1,
            elapsed_ms=20,
        ),
    ]
    failure = TikTokAcquisitionFailure(
        code="cdn_unavailable", retryable=True, attempts=attempts
    )

    assert failure.model_dump(mode="json") == {
        "code": "cdn_unavailable",
        "retryable": True,
        "attempts": [attempt.model_dump(mode="json") for attempt in attempts],
    }


def test_failure_rejects_more_than_three_attempts() -> None:
    attempt = AcquisitionAttempt(
        strategy="scrapling_headless",
        status="failed",
        reason="headless_timeout",
        attempt_count=1,
        elapsed_ms=1,
    )
    with pytest.raises(ValidationError):
        TikTokAcquisitionFailure(
            code="headless_timeout", retryable=True, attempts=[attempt] * 4
        )
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `rtk uv run pytest tests/acquisition/test_models.py -q`

Expected: FAIL because `TikTokAcquisitionFailure` forbids the new `attempts` field.

- [ ] **Step 3: Add the bounded failure-attempt field**

```python
class TikTokAcquisitionFailure(StrictModel):
    code: Literal[
        "invalid_tiktok_url",
        "unsupported_platform",
        "headless_timeout",
        "headless_blocked",
        "headless_incomplete",
        "cdn_rate_limited",
        "cdn_unavailable",
        "media_validation_failed",
        "artifact_persistence_failed",
        "acquisition_dependency_unavailable",
    ]
    retryable: bool
    attempts: Annotated[list[AcquisitionAttempt], Field(max_length=3)] = Field(
        default_factory=list
    )
```

- [ ] **Step 4: Add failing service tests for pre-provider and post-strategy failures**

```python
@pytest.mark.asyncio
async def test_invalid_url_failure_has_no_attempts(tmp_path: Path) -> None:
    result = await service.inspect(
        workflow_id="wf_invalid_url_001",
        source_url="https://example.test/not-tiktok",
        artifact_root=tmp_path,
    )
    assert result.failure is not None
    assert result.failure.attempts == []


@pytest.mark.asyncio
async def test_terminal_cdn_failure_retains_both_attempts(tmp_path: Path) -> None:
    result = await failing_cdn_service.inspect(
        workflow_id="wf_cdn_failure_001",
        source_url="https://www.tiktok.com/@creator/video/1234567890",
        artifact_root=tmp_path,
    )
    assert result.failure is not None
    assert [attempt.strategy.value for attempt in result.failure.attempts] == [
        "scrapling_headless",
        "tikwm_cdn",
    ]
    assert result.failure.attempts[-1].reason == AcquisitionReason.CDN_UNAVAILABLE
```

- [ ] **Step 5: Run focused service tests and verify RED**

Run: `rtk uv run pytest tests/acquisition/test_service.py -q`

Expected: FAIL because service failure constructors currently discard `attempts`.

- [ ] **Step 6: Propagate a copy of the ordered attempts on every post-strategy failure**

```python
return TikTokAcquisitionResult(
    failure=TikTokAcquisitionFailure(
        code=reason.value,
        retryable=reason.value in RETRYABLE_FAILURES,
        attempts=list(attempts),
    )
)
```

Apply the same `attempts=list(attempts)` argument to the CDN media-validation failure. Keep invalid URL and other pre-provider constructors on the empty default.

- [ ] **Step 7: Run the acquisition model and service suites and verify GREEN**

Run: `rtk uv run pytest tests/acquisition/test_models.py tests/acquisition/test_service.py -q`

Expected: PASS, including current headless-first/cancellation regressions.

- [ ] **Step 8: Commit the failure-evidence contract**

```powershell
rtk git add python/src/thoth_control_plane/acquisition/models.py python/src/thoth_control_plane/acquisition/service.py python/tests/acquisition/test_models.py python/tests/acquisition/test_service.py
rtk git commit -m "feat: preserve tiktok acquisition failure attempts"
```

### Task 2: Emit safe failure attempts and cleanup evidence from the activity

**Files:**

- Modify: `python/src/thoth_control_plane/acquisition/browser.py:66-68` only if its existing `active_scrapling_session_count()` export is not public through `acquisition/__init__.py`
- Modify: `python/src/thoth_control_plane/activities/source_investigation.py:16-222`
- Modify: `python/src/thoth_control_plane/domain/models.py:324-355`
- Modify: `python/tests/activities/test_source_investigation.py`
- Modify: `python/tests/domain/test_models.py`

**Interfaces:**

- Consumes: `TikTokAcquisitionFailure.attempts` from Task 1 and existing `active_scrapling_session_count() -> int`.
- Produces: `_cleanup_event(artifact_root: Path, workflow_id: str) -> SourceProgressEvent` and terminal activity results whose events are `attempt events + exactly one tiktok_cleanup event` whenever the runner boundary is entered.
- Produces: source event payload allowlist containing only the existing `stage`/`status`/`elapsed_ms`/`reason`/`progress` keys plus `partial_cleanup_passed`, `browser_cleanup_passed`, and `fallback_from`.
- Produces: domain-owned `LEGACY_FALLBACK_ELIGIBLE_CODES`, imported by both the deterministic workflow and the soak contract so the allowlist cannot drift.

- [ ] **Step 1: Add failing domain tests for the closed payload taxonomy**

```python
@pytest.mark.parametrize(
    "payload",
    [
        {"stage": "tiktok_cleanup", "path": "C:/private/report.part"},
        {"stage": "tiktok_cleanup", "diagnostic": "signed_url=https://cdn.test/x"},
        {"stage": "tiktok_cleanup", "fallback_from": "free form reason"},
    ],
)
def test_source_progress_event_rejects_non_allowlisted_payload(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        SourceProgressEvent(kind="stage.failed", payload=payload)


def test_source_progress_event_accepts_cleanup_booleans() -> None:
    event = SourceProgressEvent(
        kind="stage.completed",
        payload={
            "stage": "tiktok_cleanup",
            "status": "succeeded",
            "partial_cleanup_passed": True,
            "browser_cleanup_passed": True,
        },
    )
    assert event.payload["partial_cleanup_passed"] is True
```

- [ ] **Step 2: Run the domain test and verify RED**

Run: `rtk uv run pytest tests/domain/test_models.py -q`

Expected: FAIL because `SourceProgressEvent.payload` currently accepts arbitrary string keys and values.

- [ ] **Step 3: Validate keys and finite string values at the domain boundary**

```python
LEGACY_FALLBACK_ELIGIBLE_CODES = frozenset(
    {
        # `invalid_tiktok_url` and `unsupported_platform` are deliberately absent:
        # they are pre-provider rejections, decided before any provider or legacy
        # attempt exists, so their observation is `route="invalid_input"` with zero
        # attempts -- the shape `legacy_fallback` rejects. Routing a non-TikTok
        # platform to legacy in an explicit migration mode is a separate routing
        # seam, not a Python failure that triggers fallback.
        "headless_timeout",
        "headless_blocked",
        "headless_incomplete",
        "cdn_rate_limited",
        "cdn_unavailable",
        "media_validation_failed",
    }
)
SOURCE_EVENT_PAYLOAD_KEYS = frozenset(
    {
        "stage",
        "status",
        "elapsed_ms",
        "reason",
        "progress",
        "partial_cleanup_passed",
        "browser_cleanup_passed",
        "fallback_from",
    }
)
SOURCE_EVENT_STAGE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SOURCE_EVENT_STATUSES = frozenset({"succeeded", "failed", "incomplete"})
SOURCE_EVENT_REASONS = frozenset(
    {
        "headless_timeout",
        "headless_blocked",
        "headless_incomplete",
        "cdn_rate_limited",
        "cdn_unavailable",
        "media_validation_failed",
    }
)

@field_validator("payload")
@classmethod
def validate_payload(cls, payload: dict[str, str | int | float | bool | None]):
    if not set(payload) <= SOURCE_EVENT_PAYLOAD_KEYS:
        raise ValueError("source event payload contains an unsupported key")
    stage = payload.get("stage")
    if not isinstance(stage, str) or not SOURCE_EVENT_STAGE_PATTERN.fullmatch(stage):
        raise ValueError("source event stage must be a safe code")
    if "status" in payload and payload["status"] not in SOURCE_EVENT_STATUSES:
        raise ValueError("source event status is unsupported")
    if "reason" in payload and payload["reason"] not in SOURCE_EVENT_REASONS:
        raise ValueError("source event reason is unsupported")
    if "fallback_from" in payload and payload["fallback_from"] not in LEGACY_FALLBACK_ELIGIBLE_CODES:
        raise ValueError("source event fallback code is unsupported")
    progress = payload.get("progress")
    if progress is not None and (
        isinstance(progress, bool)
        or not isinstance(progress, (int, float))
        or not math.isfinite(progress)
        or not 0 <= progress <= 1
    ):
        raise ValueError("source event progress must be finite and between zero and one")
    return payload
```

The `stage` code remains compatible with typed legacy progress records while every other string slot is a closed enum/code set. Do not admit free-form legacy prose.

- [ ] **Step 4: Add failing activity tests for terminal failure attempts and cleanup ordering**

```python
@pytest.mark.asyncio
async def test_terminal_failure_emits_attempts_then_one_cleanup_event(tmp_path: Path) -> None:
    async def runner(workflow_id: str, source_url: str, artifact_root: Path):
        del workflow_id, source_url, artifact_root
        return TikTokAcquisitionResult(
            failure=TikTokAcquisitionFailure(
                code="cdn_unavailable",
                retryable=True,
                attempts=[HEADLESS_FAILED_ATTEMPT, CDN_FAILED_ATTEMPT],
            )
        )

    result = await build_source_investigation_activity(
        _settings(tmp_path), runner=runner
    )(INPUT)

    assert result.failure is not None
    assert [event.payload["stage"] for event in result.events] == [
        "tiktok_headless",
        "tiktok_headless",
        "tiktok_cdn",
        "tiktok_cdn",
        "tiktok_cleanup",
    ]
    cleanup = result.events[-1]
    assert cleanup.kind == "stage.completed"
    assert cleanup.payload == {
        "stage": "tiktok_cleanup",
        "status": "succeeded",
        "partial_cleanup_passed": True,
        "browser_cleanup_passed": True,
    }


@pytest.mark.asyncio
async def test_cleanup_event_fails_when_part_file_remains(tmp_path: Path) -> None:
    async def runner(workflow_id: str, source_url: str, artifact_root: Path):
        del source_url
        part = artifact_root / "reports" / workflow_id / "leftover.part"
        part.parent.mkdir(parents=True)
        part.write_bytes(b"partial")
        return TERMINAL_FAILURE_WITH_ATTEMPTS

    result = await build_source_investigation_activity(_settings(tmp_path), runner=runner)(INPUT)
    cleanup = result.events[-1]
    assert cleanup.kind == "stage.failed"
    assert cleanup.payload["partial_cleanup_passed"] is False
```

- [ ] **Step 5: Run the activity tests and verify RED**

Run: `rtk uv run pytest tests/activities/test_source_investigation.py -q`

Expected: FAIL because failure attempts and cleanup evidence are not emitted.

- [ ] **Step 6: Implement cleanup inspection and one terminal-event composer**

```python
def _cleanup_event(artifact_root: Path, workflow_id: str) -> SourceProgressEvent:
    report_dir = (artifact_root / "reports" / workflow_id).resolve()
    try:
        partial_cleanup_passed = not report_dir.exists() or not any(report_dir.rglob("*.part"))
    except OSError:
        partial_cleanup_passed = False
    browser_cleanup_passed = active_scrapling_session_count() == 0
    passed = partial_cleanup_passed and browser_cleanup_passed
    return SourceProgressEvent(
        kind="stage.completed" if passed else "stage.failed",
        payload={
            "stage": "tiktok_cleanup",
            "status": "succeeded" if passed else "failed",
            "partial_cleanup_passed": partial_cleanup_passed,
            "browser_cleanup_passed": browser_cleanup_passed,
        },
    )


def _terminal_events(
    attempts: list[AcquisitionAttempt], artifact_root: Path, workflow_id: str
) -> list[SourceProgressEvent]:
    return [*_attempt_events(attempts), _cleanup_event(artifact_root, workflow_id)]
```

Use `_terminal_events(acquisition_result.failure.attempts, ...)` before returning a mapped service failure, and `_terminal_events(report.outcome.attempts, ...)` after success persistence. On artifact persistence failure, run existing partial cleanup first, then append the cleanup event. On dependency/runner boundary failures, use an empty attempt list plus the cleanup event. Never include the caught exception or a filesystem path.

- [ ] **Step 7: Verify activity, domain, cancellation, and legacy compatibility tests are GREEN**

Run: `rtk uv run pytest tests/domain/test_models.py tests/activities/test_source_investigation.py tests/activities/test_legacy_scout.py tests/acquisition/test_browser.py -q`

Expected: PASS. Existing cancellation tests still prove browser close occurs even though a cancelled Temporal activity cannot return a terminal result event.

- [ ] **Step 8: Commit activity evidence**

```powershell
rtk git add python/src/thoth_control_plane/acquisition/browser.py python/src/thoth_control_plane/activities/source_investigation.py python/src/thoth_control_plane/domain/models.py python/tests/activities/test_source_investigation.py python/tests/domain/test_models.py
rtk git commit -m "feat: emit tiktok attempt and cleanup evidence"
```

### Task 3: Preserve deterministic Python-to-legacy fallback event history

**Files:**

- Modify: `python/src/thoth_control_plane/workflows/source_investigation.py:210-265`
- Modify: `python/tests/workflows/test_source_investigation.py`

**Interfaces:**

- Consumes: safe Python `SourceInvestigationActivityResult.events` and domain-owned frozen `LEGACY_FALLBACK_ELIGIBLE_CODES` from Task 2.
- Produces: `_legacy_fallback_event(failure_code: str) -> SourceProgressEvent` and ordered source events `python events -> one fallback transition -> legacy events`.
- Preserves: Python-only and legacy-only modes never synthesize `legacy_fallback`; all workflow decisions remain deterministic and replay-safe.

- [ ] **Step 1: Add a failing Temporal test for exact fallback event order**

```python
@pytest.mark.asyncio
async def test_eligible_fallback_preserves_python_transition_and_legacy_events(workflow_env) -> None:
    result, source_events = await run_fallback_case_and_query_events(workflow_env)

    assert result.status == WorkflowStatus.SUCCEEDED
    assert [(event.kind, event.payload["stage"]) for event in source_events] == [
        ("stage.started", "tiktok_headless"),
        ("stage.failed", "tiktok_headless"),
        ("stage.completed", "tiktok_cleanup"),
        ("stage.started", "legacy_fallback"),
        ("stage.started", "source"),
        ("stage.completed", "source"),
    ]
    assert source_events[3].payload == {
        "stage": "legacy_fallback",
        "fallback_from": "headless_blocked",
    }
```

Use the existing time-skipping `WorkflowEnvironment`, query `SourceInvestigationWorkflow.source_events`, and define fake activities with fixed typed results; do not use clocks, environment reads, logging, or provider calls in workflow code.

- [ ] **Step 2: Run the focused workflow test and verify RED**

Run: `rtk uv run pytest tests/workflows/test_source_investigation.py -q`

Expected: FAIL because the current fallback return replaces Python events with legacy events.

- [ ] **Step 3: Compose fallback history before and after the legacy activity**

```python
def _legacy_fallback_event(failure_code: str) -> SourceProgressEvent:
    if failure_code not in LEGACY_FALLBACK_ELIGIBLE_CODES:
        raise ValueError("failure code is not eligible for legacy fallback")
    return SourceProgressEvent(
        kind="stage.started",
        payload={"stage": "legacy_fallback", "fallback_from": failure_code},
    )


python_events = list(result.events)
transition = _legacy_fallback_event(result.failure.code)
self._source_events = [*python_events, transition]
legacy_result = await self._execute_legacy_activity(input_)
return legacy_result.model_copy(
    update={"events": [*self._source_events, *legacy_result.events]}
)
```

Set `_source_events` before awaiting legacy so a query can still retrieve Python and transition evidence if the legacy activity raises. Let the normal run path assign the final combined list after a returned result.

Remove the workflow-local fallback allowlist and import `LEGACY_FALLBACK_ELIGIBLE_CODES` from `thoth_control_plane.domain.models`; this is a pure frozen set and remains safe inside the Temporal sandbox.

- [ ] **Step 4: Add negative tests for Python-only, legacy-only, and ineligible failures**

```python
@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["python", "legacy_scout"])
async def test_non_fallback_modes_never_emit_transition(workflow_env, mode: str) -> None:
    _, source_events = await run_mode_and_query_events(workflow_env, mode)
    assert all(event.payload.get("stage") != "legacy_fallback" for event in source_events)


@pytest.mark.asyncio
async def test_ineligible_python_failure_does_not_emit_transition(workflow_env) -> None:
    _, source_events = await run_ineligible_failure_and_query_events(workflow_env)
    assert all(event.payload.get("stage") != "legacy_fallback" for event in source_events)
```

- [ ] **Step 5: Run workflow routing and replay tests and verify GREEN**

Run: `rtk uv run pytest tests/workflows/test_source_investigation.py -q`

Expected: PASS with exact Python and legacy activity counts unchanged.

- [ ] **Step 6: Commit deterministic fallback history**

```powershell
rtk git add python/src/thoth_control_plane/workflows/source_investigation.py python/tests/workflows/test_source_investigation.py
rtk git commit -m "feat: preserve python evidence across legacy fallback"
```

### Task 4: Redact Scrapling provider logs before capability checks

**Files:**

- Create: `python/src/thoth_control_plane/observability.py`
- Create: `python/tests/test_observability.py`
- Create: `python/tests/test_worker.py`
- Modify: `python/src/thoth_control_plane/worker.py:1-48`

**Interfaces:**

- Produces: `configure_provider_logging() -> None`, idempotent and non-raising.
- Consumes: standard Python logging records in the `scrapling` namespace.
- Guarantees: DEBUG/INFO are dropped; WARNING/ERROR are rewritten to `scrapling provider event redacted` with args, exception, exception text, and stack text cleared before configured handlers receive them.

- [ ] **Step 1: Add failing logger safety tests with hostile synthetic records**

```python
def test_scrapling_info_is_dropped_and_error_is_fully_redacted() -> None:
    records: list[logging.LogRecord] = []
    handler = _ListHandler(records)
    logger = logging.getLogger("scrapling")
    logger.handlers[:] = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)

    configure_provider_logging()
    logger.info("signed https://cdn.test/video?token=secret")
    try:
        raise RuntimeError("provider token=secret")
    except RuntimeError:
        logger.exception("failed %s", "https://cdn.test/x?token=secret", stack_info=True)

    assert len(records) == 1
    record = records[0]
    assert record.getMessage() == "scrapling provider event redacted"
    assert record.args == ()
    assert record.exc_info is None
    assert record.exc_text is None
    assert record.stack_info is None


def test_provider_logging_configuration_is_idempotent() -> None:
    configure_provider_logging()
    configure_provider_logging()
    logger = logging.getLogger("scrapling")
    assert sum(isinstance(item, ScraplingRedactionFilter) for item in logger.filters) == 1
```

- [ ] **Step 2: Run the logger tests and verify RED**

Run: `rtk uv run pytest tests/test_observability.py -q`

Expected: FAIL because `thoth_control_plane.observability` does not exist.

- [ ] **Step 3: Implement the idempotent namespace filter**

```python
REDACTED_PROVIDER_MESSAGE = "scrapling provider event redacted"


class ScraplingRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not record.name.startswith("scrapling"):
            return True
        if record.levelno < logging.WARNING:
            return False
        record.msg = REDACTED_PROVIDER_MESSAGE
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


def configure_provider_logging() -> None:
    try:
        logger = logging.getLogger("scrapling")
        logger.setLevel(logging.WARNING)
        targets = [logger, *logger.handlers, *logging.getLogger().handlers]
        for target in targets:
            if not any(isinstance(item, ScraplingRedactionFilter) for item in target.filters):
                target.addFilter(ScraplingRedactionFilter())
    except Exception:
        return
```

The filter keeps non-Scrapling records unchanged when installed on a root handler. Do not log from the exception path.

- [ ] **Step 4: Add a failing worker-order test**

```python
@pytest.mark.asyncio
async def test_worker_configures_provider_logging_before_capability_check(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(worker, "configure_provider_logging", lambda: calls.append("logging"))

    async def capability():
        calls.append("capability")
        raise _StopWorker

    monkeypatch.setattr(worker, "check_scrapling_capability", capability)
    with pytest.raises(_StopWorker):
        await worker.run_worker(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"))
    assert calls == ["logging", "capability"]
```

- [ ] **Step 5: Invoke the filter before browser capability inspection**

```python
async def run_worker(settings: Settings | None = None) -> None:
    runtime_settings = settings or Settings()  # type: ignore[call-arg]
    configure_provider_logging()
    capability = await check_scrapling_capability()
    # existing client and worker construction follows
```

- [ ] **Step 6: Run observability and worker tests and verify GREEN**

Run: `rtk uv run pytest tests/test_observability.py tests/test_worker.py tests/acquisition/test_browser.py -q`

Expected: PASS; no captured record contains the synthetic URL, token, exception, or stack.

- [ ] **Step 7: Commit provider logging safety**

```powershell
rtk git add python/src/thoth_control_plane/observability.py python/src/thoth_control_plane/worker.py python/tests/test_observability.py python/tests/test_worker.py
rtk git commit -m "feat: redact scrapling provider logs"
```

### Task 5: Define the strict Stage 1 soak contracts

**Files:**

- Create: `python/src/thoth_control_plane/operations/__init__.py`
- Create: `python/src/thoth_control_plane/operations/tiktok_soak.py`
- Create: `python/tests/operations/__init__.py`
- Create: `python/tests/operations/test_tiktok_soak.py`

**Interfaces:**

- Produces: `TikTokSoakObservation`, `TikTokSoakPolicy`, `TikTokSoakReport`, `TikTokSoakRoute`, `TikTokSoakBlocker`, and `TikTokSoakDatasetError`.
- Reuses: `AcquisitionAttempt` and `SourceActivityMode`; no duplicate strategy/status/reason taxonomy.
- Represents: redaction and absolute-path audit failures as finite terminal `failure_code` values on `route="failed"`, avoiding new free-form evidence fields.

- [ ] **Step 1: Add failing strict-model and invariant tests**

```python
def test_observation_rejects_extra_and_non_utc_fields(valid_observation: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "source_url": "https://x"})
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {**valid_observation, "occurred_at": "2026-09-02T19:00:00+07:00"}
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"route": "python_native", "failure_code": "cdn_unavailable"},
        {"route": "legacy_fallback", "failure_code": None},
        {"route": "invalid_input", "attempts": [HEADLESS_FAILED]},
        {"attempts": [TIKWM_FAILED, HEADLESS_FAILED]},
    ],
)
def test_observation_rejects_inconsistent_route_evidence(
    valid_observation: dict[str, object], changes: dict[str, object]
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, **changes})
```

- [ ] **Step 2: Run the operations contract tests and verify RED**

Run: `rtk uv run pytest tests/operations/test_tiktok_soak.py -q`

Expected: FAIL because the operations package does not exist.

- [ ] **Step 3: Implement enums, strict policy defaults, and observation invariants**

```python
class TikTokSoakRoute(StrEnum):
    PYTHON_NATIVE = "python_native"
    LEGACY_FALLBACK = "legacy_fallback"
    FAILED = "failed"
    INVALID_INPUT = "invalid_input"
    OPERATOR_CANCELLED = "operator_cancelled"


SoakFailureCode: TypeAlias = Literal[
    "invalid_tiktok_url",
    "unsupported_platform",
    "headless_timeout",
    "headless_blocked",
    "headless_incomplete",
    "cdn_rate_limited",
    "cdn_unavailable",
    "media_validation_failed",
    "artifact_persistence_failed",
    "acquisition_dependency_unavailable",
    "acquisition_runner_failed",
    "redaction_audit_failed",
    "absolute_path_audit_failed",
]


class TikTokSoakPolicy(StrictModel):
    minimum_window_days: Annotated[int, Field(ge=1)] = 7
    minimum_valid_completed_runs: Annotated[int, Field(ge=1)] = 50
    minimum_parity_samples: Annotated[int, Field(ge=1)] = 5
    minimum_python_native_success_rate: Annotated[float, Field(ge=0, le=1)] = 0.95
    maximum_legacy_fallback_rate: Annotated[float, Field(ge=0, le=1)] = 0.05
    maximum_terminal_failure_rate: Annotated[float, Field(ge=0, le=1)] = 0.02


class TikTokSoakObservation(StrictModel):
    schema_version: Literal[1] = 1
    observation_id: Annotated[str, Field(pattern=r"^obs_[a-f0-9]{16,64}$")]
    workflow_id: OpaqueId
    occurred_at: datetime
    activity_mode: SourceActivityMode
    route: TikTokSoakRoute
    attempts: Annotated[list[AcquisitionAttempt], Field(max_length=3)] = Field(default_factory=list)
    failure_code: SoakFailureCode | None = None
    artifact_validated: bool
    partial_cleanup_passed: bool
    browser_cleanup_passed: bool
    parity_passed: bool | None = None

    @field_validator("occurred_at", mode="before")
    @classmethod
    def require_utc(cls, value: datetime | str) -> datetime:
        parsed = _parse_utc(value)
        if parsed.utcoffset() != timedelta(0):
            raise ValueError("occurred_at must use UTC")
        return parsed

    @model_validator(mode="after")
    def validate_terminal_evidence(self) -> TikTokSoakObservation:
        strategies = [attempt.strategy for attempt in self.attempts]
        valid_orders = [
            [],
            [AcquisitionStrategy.SCRAPLING_HEADLESS],
            [AcquisitionStrategy.SCRAPLING_HEADLESS, AcquisitionStrategy.TIKWM_CDN],
        ]
        if strategies not in valid_orders:
            raise ValueError("attempt strategies are not in headless-first order")
        if self.activity_mode == "python" and self.route is TikTokSoakRoute.LEGACY_FALLBACK:
            raise ValueError("python mode cannot use legacy fallback")
        if self.activity_mode == "legacy_scout" and self.route in {
            TikTokSoakRoute.PYTHON_NATIVE,
            TikTokSoakRoute.LEGACY_FALLBACK,
        }:
            raise ValueError("legacy-only mode cannot report a Python route")
        if self.route is TikTokSoakRoute.PYTHON_NATIVE:
            if (
                self.failure_code is not None
                or not self.attempts
                or self.attempts[-1].status is not AttemptStatus.SUCCEEDED
                or not self.artifact_validated
            ):
                raise ValueError("python-native evidence is inconsistent")
        elif self.route is TikTokSoakRoute.LEGACY_FALLBACK:
            if (
                self.activity_mode != "python_tiktok_with_legacy_fallback"
                or self.failure_code not in LEGACY_FALLBACK_ELIGIBLE_CODES
                or not self.attempts
                or self.attempts[-1].status is AttemptStatus.SUCCEEDED
                or not self.artifact_validated
            ):
                raise ValueError("legacy-fallback evidence is inconsistent")
        elif self.route is TikTokSoakRoute.INVALID_INPUT:
            if (
                self.failure_code not in {"invalid_tiktok_url", "unsupported_platform"}
                or self.attempts
                or self.artifact_validated
                or self.parity_passed is not None
            ):
                raise ValueError("invalid-input evidence is inconsistent")
        elif self.route is TikTokSoakRoute.OPERATOR_CANCELLED:
            if self.failure_code is not None or self.artifact_validated or self.parity_passed is not None:
                raise ValueError("operator-cancelled evidence is inconsistent")
        elif self.failure_code is None or self.artifact_validated:
            raise ValueError("terminal failure evidence is inconsistent")
        if self.parity_passed is not None and not self.artifact_validated:
            raise ValueError("parity evidence requires a validated artifact")
        return self
```

Import `LEGACY_FALLBACK_ELIGIBLE_CODES` from `domain.models`. This makes `fallback_from` event validation and observation validation use the same closed values.

- [ ] **Step 4: Add aggregate report privacy and serialization tests**

```python
def test_aggregate_report_schema_has_no_per_run_identity() -> None:
    report = TikTokSoakReport(
        schema_version=1,
        generated_at="2026-09-02T12:30:00Z",
        policy=TikTokSoakPolicy(),
        window={"started_at": None, "ended_at": None, "duration_hours": 0},
        counts={
            "valid_completed": 0,
            "python_native": 0,
            "legacy_fallback": 0,
            "failed": 0,
            "invalid_input": 0,
            "operator_cancelled": 0,
            "parity_samples": 0,
        },
        rates={"python_native": 0.0, "legacy_fallback": 0.0, "terminal_failure": 0.0},
        ready=False,
        blockers=["insufficient_valid_completed_runs"],
    )
    payload = report.model_dump(mode="json")
    forbidden = {"observation_id", "workflow_id", "attempts", "source_url", "path"}
    assert forbidden.isdisjoint(json.dumps(payload).split('"'))
```

- [ ] **Step 5: Implement typed aggregate report submodels and finite blocker enum**

```python
class TikTokSoakWindow(StrictModel):
    started_at: datetime | None
    ended_at: datetime | None
    duration_hours: Annotated[float, Field(ge=0)]


class TikTokSoakCounts(StrictModel):
    valid_completed: Annotated[int, Field(ge=0)]
    python_native: Annotated[int, Field(ge=0)]
    legacy_fallback: Annotated[int, Field(ge=0)]
    failed: Annotated[int, Field(ge=0)]
    invalid_input: Annotated[int, Field(ge=0)]
    operator_cancelled: Annotated[int, Field(ge=0)]
    parity_samples: Annotated[int, Field(ge=0)]


class TikTokSoakRates(StrictModel):
    python_native: Annotated[float, Field(ge=0, le=1)]
    legacy_fallback: Annotated[float, Field(ge=0, le=1)]
    terminal_failure: Annotated[float, Field(ge=0, le=1)]


class TikTokSoakBlocker(StrEnum):
    INSUFFICIENT_WINDOW = "insufficient_window"
    INSUFFICIENT_VALID_COMPLETED_RUNS = "insufficient_valid_completed_runs"
    INSUFFICIENT_PARITY_SAMPLES = "insufficient_parity_samples"
    PYTHON_NATIVE_RATE_BELOW_MINIMUM = "python_native_rate_below_minimum"
    LEGACY_FALLBACK_RATE_ABOVE_MAXIMUM = "legacy_fallback_rate_above_maximum"
    TERMINAL_FAILURE_RATE_ABOVE_MAXIMUM = "terminal_failure_rate_above_maximum"
    ARTIFACT_PERSISTENCE_FAILURE_PRESENT = "artifact_persistence_failure_present"
    ACQUISITION_DEPENDENCY_FAILURE_PRESENT = "acquisition_dependency_failure_present"
    ACQUISITION_RUNNER_FAILURE_PRESENT = "acquisition_runner_failure_present"
    REDACTION_AUDIT_FAILURE_PRESENT = "redaction_audit_failure_present"
    ABSOLUTE_PATH_AUDIT_FAILURE_PRESENT = "absolute_path_audit_failure_present"
    PARTIAL_CLEANUP_FAILURE_PRESENT = "partial_cleanup_failure_present"
    BROWSER_CLEANUP_FAILURE_PRESENT = "browser_cleanup_failure_present"
    PARITY_FAILURE_PRESENT = "parity_failure_present"


class TikTokSoakReport(StrictModel):
    schema_version: Literal[1] = 1
    generated_at: datetime
    policy: TikTokSoakPolicy
    window: TikTokSoakWindow
    counts: TikTokSoakCounts
    rates: TikTokSoakRates
    ready: bool
    blockers: list[TikTokSoakBlocker]
```

Keep the report graph aggregate-only by construction: none of its submodels accepts IDs, attempts, codes per run, URLs, checksums, paths, captions, or per-run timestamps.

- [ ] **Step 6: Run the strict contract tests and verify GREEN**

Run: `rtk uv run pytest tests/operations/test_tiktok_soak.py -q`

Expected: PASS for strictness, route invariants, fixed defaults, and aggregate-only serialization.

- [ ] **Step 7: Commit Stage 1 soak contracts**

```powershell
rtk git add python/src/thoth_control_plane/operations python/tests/operations
rtk git commit -m "feat: define tiktok stage 1 soak contracts"
```

### Task 6: Implement deterministic soak validation and readiness evaluation

**Files:**

- Modify: `python/src/thoth_control_plane/operations/tiktok_soak.py`
- Modify: `python/src/thoth_control_plane/operations/__init__.py`
- Modify: `python/tests/operations/test_tiktok_soak.py`

**Interfaces:**

- Produces: `evaluate_tiktok_soak(observations: list[TikTokSoakObservation], policy: TikTokSoakPolicy = TikTokSoakPolicy(), *, generated_at: datetime | None = None) -> TikTokSoakReport`.
- Raises: `TikTokSoakDatasetError(code: TikTokSoakDatasetErrorCode)` for invalid datasets, with no raw observation, ID, timestamp, or path in its message.
- Guarantees: exact rational threshold comparisons, stable count/rate calculation, and lexicographically sorted blocker values.

- [ ] **Step 1: Add failing dataset rejection tests**

```python
@pytest.mark.parametrize(
    ("mutator", "expected_code"),
    [
        (duplicate_observation_id, "duplicate_observation_id"),
        (duplicate_workflow_id, "duplicate_workflow_id"),
        (reverse_timestamp_order, "observations_not_chronological"),
    ],
)
def test_invalid_dataset_raises_safe_finite_error(
    ready_observations, mutator, expected_code
) -> None:
    with pytest.raises(TikTokSoakDatasetError) as captured:
        evaluate_tiktok_soak(mutator(ready_observations), generated_at=GENERATED_AT)
    assert captured.value.code.value == expected_code
    assert "wf_" not in str(captured.value)
    assert "obs_" not in str(captured.value)
```

- [ ] **Step 2: Add failing threshold boundary tables**

```python
@pytest.mark.parametrize(
    ("observations", "blocker"),
    [
        (window_at(hours=167, minutes=59, seconds=59), "insufficient_window"),
        (completed_runs(49), "insufficient_valid_completed_runs"),
        (parity_samples(4), "insufficient_parity_samples"),
        (route_mix(native=94, fallback=5, failed=1), "python_native_rate_below_minimum"),
        (route_mix(native=94, fallback=6, failed=0), "legacy_fallback_rate_above_maximum"),
        (route_mix(native=97, fallback=0, failed=3), "terminal_failure_rate_above_maximum"),
    ],
)
def test_policy_boundary_below_or_above_limit_blocks(observations, blocker: str) -> None:
    report = evaluate_tiktok_soak(observations, generated_at=GENERATED_AT)
    assert blocker in [item.value for item in report.blockers]
```

Add passing counterparts for exactly 168 hours, exactly 50 runs, exactly 5 parity samples, exactly 95% native, exactly 5% fallback, and exactly 2% terminal failure. Construct all fixtures from `TikTokSoakObservation`, not unvalidated dictionaries.

- [ ] **Step 3: Run evaluator tests and verify RED**

Run: `rtk uv run pytest tests/operations/test_tiktok_soak.py -q`

Expected: FAIL because `evaluate_tiktok_soak` is not implemented.

- [ ] **Step 4: Implement duplicate/order validation and exact comparisons**

```python
def _rate(count: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else count / denominator


def _fraction(value: float) -> Fraction:
    return Fraction(str(value))


class TikTokSoakDatasetErrorCode(StrEnum):
    DUPLICATE_OBSERVATION_ID = "duplicate_observation_id"
    DUPLICATE_WORKFLOW_ID = "duplicate_workflow_id"
    OBSERVATIONS_NOT_CHRONOLOGICAL = "observations_not_chronological"


class TikTokSoakDatasetError(ValueError):
    def __init__(self, code: TikTokSoakDatasetErrorCode) -> None:
        self.code = code
        super().__init__(code.value)


def _validate_unique_ids(observations: list[TikTokSoakObservation]) -> None:
    if len({item.observation_id for item in observations}) != len(observations):
        raise TikTokSoakDatasetError(TikTokSoakDatasetErrorCode.DUPLICATE_OBSERVATION_ID)
    if len({item.workflow_id for item in observations}) != len(observations):
        raise TikTokSoakDatasetError(TikTokSoakDatasetErrorCode.DUPLICATE_WORKFLOW_ID)


def _validate_chronological_order(observations: list[TikTokSoakObservation]) -> None:
    timestamps = [item.occurred_at for item in observations]
    if timestamps != sorted(timestamps):
        raise TikTokSoakDatasetError(TikTokSoakDatasetErrorCode.OBSERVATIONS_NOT_CHRONOLOGICAL)


def evaluate_tiktok_soak(
    observations: list[TikTokSoakObservation],
    policy: TikTokSoakPolicy = TikTokSoakPolicy(),
    *,
    generated_at: datetime | None = None,
) -> TikTokSoakReport:
    _validate_unique_ids(observations)
    _validate_chronological_order(observations)
    blockers: set[TikTokSoakBlocker] = set()
    completed = [
        item
        for item in observations
        if item.route
        in {TikTokSoakRoute.PYTHON_NATIVE, TikTokSoakRoute.LEGACY_FALLBACK, TikTokSoakRoute.FAILED}
    ]
    denominator = len(completed)
    native = sum(item.route is TikTokSoakRoute.PYTHON_NATIVE for item in completed)
    fallback = sum(item.route is TikTokSoakRoute.LEGACY_FALLBACK for item in completed)
    failed = sum(item.route is TikTokSoakRoute.FAILED for item in completed)

    if denominator < policy.minimum_valid_completed_runs:
        blockers.add(TikTokSoakBlocker.INSUFFICIENT_VALID_COMPLETED_RUNS)
    parity_samples = sum(item.parity_passed is not None for item in observations)
    if parity_samples < policy.minimum_parity_samples:
        blockers.add(TikTokSoakBlocker.INSUFFICIENT_PARITY_SAMPLES)
    started_at = completed[0].occurred_at if completed else None
    ended_at = completed[-1].occurred_at if completed else None
    duration_hours = (
        (ended_at - started_at).total_seconds() / 3600
        if started_at is not None and ended_at is not None
        else 0.0
    )
    if duration_hours < policy.minimum_window_days * 24:
        blockers.add(TikTokSoakBlocker.INSUFFICIENT_WINDOW)
    if Fraction(native, denominator or 1) < _fraction(policy.minimum_python_native_success_rate):
        blockers.add(TikTokSoakBlocker.PYTHON_NATIVE_RATE_BELOW_MINIMUM)
    if Fraction(fallback, denominator or 1) > _fraction(policy.maximum_legacy_fallback_rate):
        blockers.add(TikTokSoakBlocker.LEGACY_FALLBACK_RATE_ABOVE_MAXIMUM)
    if Fraction(failed, denominator or 1) > _fraction(policy.maximum_terminal_failure_rate):
        blockers.add(TikTokSoakBlocker.TERMINAL_FAILURE_RATE_ABOVE_MAXIMUM)
```

After the zero-tolerance loop in Step 6, return `TikTokSoakReport` with `generated_at=generated_at or ended_at or datetime(1970, 1, 1, tzinfo=UTC)`, the typed counts/window/rates above, `ready=not ordered_blockers`, and `blockers=ordered_blockers`. This makes the no-argument interface deterministic; the CLI in Task 7 always supplies the current UTC time explicitly.

- [ ] **Step 5: Add failing zero-tolerance, exclusion, and blocker-order tests**

```python
@pytest.mark.parametrize(
    ("observation", "blocker"),
    [
        (failure_observation("artifact_persistence_failed"), "artifact_persistence_failure_present"),
        (failure_observation("acquisition_dependency_unavailable"), "acquisition_dependency_failure_present"),
        (failure_observation("acquisition_runner_failed"), "acquisition_runner_failure_present"),
        (failure_observation("redaction_audit_failed"), "redaction_audit_failure_present"),
        (failure_observation("absolute_path_audit_failed"), "absolute_path_audit_failure_present"),
        (cleanup_failure(partial=False), "partial_cleanup_failure_present"),
        (cleanup_failure(browser=False), "browser_cleanup_failure_present"),
        (parity_failure(), "parity_failure_present"),
    ],
)
def test_zero_tolerance_evidence_always_blocks(ready_observations, observation, blocker) -> None:
    report = evaluate_tiktok_soak(
        [*ready_observations, observation], generated_at=GENERATED_AT
    )
    assert blocker in [item.value for item in report.blockers]


def test_invalid_and_cancelled_routes_are_excluded_from_rates(ready_observations) -> None:
    baseline = evaluate_tiktok_soak(ready_observations, generated_at=GENERATED_AT)
    report = evaluate_tiktok_soak(
        sorted([*ready_observations, invalid_input(), operator_cancelled()], key=lambda item: item.occurred_at),
        generated_at=GENERATED_AT,
    )
    assert report.rates == baseline.rates
    assert report.blockers == sorted(report.blockers, key=lambda item: item.value)
```

- [ ] **Step 6: Implement fixed zero-tolerance blockers and stable report construction**

```python
ZERO_TOLERANCE_CODES = {
    "artifact_persistence_failed": TikTokSoakBlocker.ARTIFACT_PERSISTENCE_FAILURE_PRESENT,
    "acquisition_dependency_unavailable": TikTokSoakBlocker.ACQUISITION_DEPENDENCY_FAILURE_PRESENT,
    "acquisition_runner_failed": TikTokSoakBlocker.ACQUISITION_RUNNER_FAILURE_PRESENT,
    "redaction_audit_failed": TikTokSoakBlocker.REDACTION_AUDIT_FAILURE_PRESENT,
    "absolute_path_audit_failed": TikTokSoakBlocker.ABSOLUTE_PATH_AUDIT_FAILURE_PRESENT,
}

for observation in observations:
    blocker = ZERO_TOLERANCE_CODES.get(observation.failure_code)
    if blocker is not None:
        blockers.add(blocker)
    if not observation.partial_cleanup_passed:
        blockers.add(TikTokSoakBlocker.PARTIAL_CLEANUP_FAILURE_PRESENT)
    if not observation.browser_cleanup_passed:
        blockers.add(TikTokSoakBlocker.BROWSER_CLEANUP_FAILURE_PRESENT)
    if observation.parity_passed is False:
        blockers.add(TikTokSoakBlocker.PARITY_FAILURE_PRESENT)

ordered_blockers = sorted(blockers, key=lambda item: item.value)
```

Count parity samples only where `parity_passed is not None`; every false sample adds the blocker. Return rates as raw floats without rounding, but use `Fraction` for comparisons.

- [ ] **Step 7: Run evaluator, Ruff, and format gates and verify GREEN**

Run: `rtk uv run pytest tests/operations/test_tiktok_soak.py -q`

Run: `rtk uv run ruff check src/thoth_control_plane/operations tests/operations`

Run: `rtk uv run ruff format --check src/thoth_control_plane/operations tests/operations`

Expected: all commands PASS.

- [ ] **Step 8: Commit the deterministic evaluator**

```powershell
rtk git add python/src/thoth_control_plane/operations python/tests/operations/test_tiktok_soak.py
rtk git commit -m "feat: evaluate tiktok stage 1 soak readiness"
```

### Task 7: Add strict JSONL input and atomic aggregate report CLI

**Files:**

- Create: `python/src/thoth_control_plane/operations/tiktok_soak_cli.py`
- Create: `python/tests/operations/test_tiktok_soak_cli.py`
- Modify: `python/src/thoth_control_plane/cli.py:17-20`
- Modify: `python/tests/test_cli.py`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `load_tiktok_soak_observations(path: Path) -> list[TikTokSoakObservation]` and `write_tiktok_soak_report(report: TikTokSoakReport, output_directory: Path) -> Path`.
- Produces CLI: `thoth-control operations tiktok-stage1-soak --observations <file.jsonl> --output-directory <dir>`.
- Writes only `<dir>/tiktok-stage1-soak-report.json` via the sibling `.part` file; returns fixed safe errors without echoing paths, JSON, IDs, or validation input.

- [ ] **Step 1: Add failing JSONL parser tests**

```python
def test_loader_accepts_one_strict_observation_per_nonempty_line(tmp_path: Path) -> None:
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text(
        "\n".join(json.dumps(item.model_dump(mode="json")) for item in READY_OBSERVATIONS),
        encoding="utf-8",
    )
    assert load_tiktok_soak_observations(input_path) == READY_OBSERVATIONS


@pytest.mark.parametrize("content", ["not-json\n", '{"schema_version":2}\n', "\n"])
def test_loader_fails_closed_without_echoing_input(tmp_path: Path, content: str) -> None:
    input_path = tmp_path / "secret-observations.jsonl"
    input_path.write_text(content, encoding="utf-8")
    with pytest.raises(TikTokSoakInputError) as captured:
        load_tiktok_soak_observations(input_path)
    assert str(captured.value) == "invalid tiktok soak observation input"
```

- [ ] **Step 2: Run CLI module tests and verify RED**

Run: `rtk uv run pytest tests/operations/test_tiktok_soak_cli.py -q`

Expected: FAIL because `tiktok_soak_cli.py` does not exist.

- [ ] **Step 3: Implement strict line parsing with a fixed error boundary**

```python
class TikTokSoakInputError(ValueError):
    pass


def load_tiktok_soak_observations(path: Path) -> list[TikTokSoakObservation]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        if not lines or any(not line.strip() for line in lines):
            raise ValueError
        return [TikTokSoakObservation.model_validate_json(line) for line in lines]
    except (OSError, UnicodeError, ValueError, ValidationError) as error:
        raise TikTokSoakInputError("invalid tiktok soak observation input") from error
```

Do not retain the input text on a custom exception attribute and do not print `ValidationError` details.

- [ ] **Step 4: Add failing atomic output tests for success, replace failure, and cancellation**

```python
def test_writer_atomically_replaces_report_and_leaves_no_part(tmp_path: Path) -> None:
    destination = write_tiktok_soak_report(READY_REPORT, tmp_path)
    assert destination == tmp_path / "tiktok-stage1-soak-report.json"
    assert TikTokSoakReport.model_validate_json(destination.read_text()) == READY_REPORT
    assert not destination.with_suffix(".json.part").exists()


@pytest.mark.parametrize("raised", [OSError("replace failed"), KeyboardInterrupt()])
def test_writer_removes_part_on_failure_or_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raised: BaseException
) -> None:
    def fail_replace(source: Path, destination: Path) -> None:
        del source, destination
        raise raised

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(type(raised)):
        write_tiktok_soak_report(READY_REPORT, tmp_path)
    assert list(tmp_path.glob("*.part")) == []
    assert not (tmp_path / "tiktok-stage1-soak-report.json").exists()
```

- [ ] **Step 5: Implement flush, fsync, atomic replace, and `BaseException` cleanup**

```python
REPORT_NAME = "tiktok-stage1-soak-report.json"


def write_tiktok_soak_report(report: TikTokSoakReport, output_directory: Path) -> Path:
    destination = output_directory / REPORT_NAME
    partial = output_directory / f"{REPORT_NAME}.part"
    output_directory.mkdir(parents=True, exist_ok=True)
    try:
        with partial.open("wb") as handle:
            handle.write(report.model_dump_json(indent=2).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(partial, destination)
        return destination
    except BaseException:
        with contextlib.suppress(OSError):
            partial.unlink(missing_ok=True)
        raise
```

- [ ] **Step 6: Add a failing end-to-end Typer test**

```python
def test_cli_writes_ready_aggregate_report(tmp_path: Path) -> None:
    observations = tmp_path / "observations.jsonl"
    observations.write_text(READY_JSONL, encoding="utf-8")
    result = runner.invoke(
        app,
        [
            "operations",
            "tiktok-stage1-soak",
            "--observations",
            str(observations),
            "--output-directory",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 0
    payload = json.loads((tmp_path / REPORT_NAME).read_text())
    assert payload["ready"] is True
    assert "workflow_id" not in json.dumps(payload)
```

- [ ] **Step 7: Register the operator command and map safe failures to exit code 1**

```python
operations_app = typer.Typer(no_args_is_help=True)
app.add_typer(operations_app, name="operations")


@operations_app.command("tiktok-stage1-soak")
def tiktok_stage1_soak(
    observations: Annotated[Path, typer.Option("--observations")],
    output_directory: Annotated[Path, typer.Option("--output-directory")] = Path("."),
) -> None:
    try:
        items = load_tiktok_soak_observations(observations)
        report = evaluate_tiktok_soak(items, generated_at=datetime.now(UTC))
        write_tiktok_soak_report(report, output_directory)
    except (TikTokSoakInputError, TikTokSoakDatasetError, OSError):
        typer.echo("tiktok stage 1 soak evaluation failed", err=True)
        raise typer.Exit(code=1) from None
    typer.echo("tiktok stage 1 soak report written")
```

Append `/tiktok-stage1-soak-observations*.jsonl` and `/tiktok-stage1-soak-report.json.part` to `.gitignore`. Do not ignore the aggregate JSON name globally because its archival destination is deployment-owned, not the repository.

- [ ] **Step 8: Run CLI and operations suites and verify GREEN**

Run: `rtk uv run pytest tests/operations tests/test_cli.py -q`

Expected: PASS; malformed input creates no report, and all `.part` cleanup assertions pass.

- [ ] **Step 9: Commit the operator CLI**

```powershell
rtk git add .gitignore python/src/thoth_control_plane/cli.py python/src/thoth_control_plane/operations/tiktok_soak_cli.py python/tests/test_cli.py python/tests/operations/test_tiktok_soak_cli.py
rtk git commit -m "feat: add atomic tiktok soak report cli"
```

### Task 8: Document soak export, approval, cutover, and rollback operations

**Files:**

- Modify: `docs/python-control-plane.md:27-103,198-211`
- Modify: `docs/python-scout-migration-roadmap.md:66-70,295-300`
- Create: `docs/operations/tiktok-stage1-soak-observation.example.jsonl`

**Interfaces:**

- Consumes: Task 7 CLI and the exact observation/report contracts from Tasks 5-6.
- Produces: a secret-safe operator runbook and one synthetic, non-live JSONL example.
- Preserves: workflow-level exports stay outside Git; only synthetic examples and aggregate operational guidance are committed.

- [ ] **Step 1: Add a synthetic observation example that validates against the real model**

```json
{"schema_version":1,"observation_id":"obs_0123456789abcdef","workflow_id":"wf_0123456789abcdef","occurred_at":"2026-09-02T12:00:00Z","activity_mode":"python_tiktok_with_legacy_fallback","route":"python_native","attempts":[{"strategy":"scrapling_headless","status":"succeeded","reason":null,"attempt_count":1,"elapsed_ms":900}],"failure_code":null,"artifact_validated":true,"partial_cleanup_passed":true,"browser_cleanup_passed":true,"parity_passed":true}
```

- [ ] **Step 2: Add an executable contract check for the documentation fixture**

Run:

```powershell
rtk uv run python -c "from pathlib import Path; from thoth_control_plane.operations.tiktok_soak_cli import load_tiktok_soak_observations; assert len(load_tiktok_soak_observations(Path('../docs/operations/tiktok-stage1-soak-observation.example.jsonl'))) == 1"
```

Expected: command exits 0 without printing the observation.

- [ ] **Step 3: Document the exact pre-cutover operational sequence**

Add these instructions to `docs/python-control-plane.md`:

```markdown
## TikTok Stage 1 operational soak

1. Deploy with `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback`.
2. Export only completed summaries plus safe source events through the approved Temporal operations channel; never export source/provider URLs or raw logs.
3. Convert each run to the strict version 1 JSONL contract outside Git and designate at least five controlled parity samples.
4. Collect at least 168 hours and 50 valid completed runs.
5. From `python/`, run `rtk uv run thoth-control operations tiktok-stage1-soak --observations <approved-jsonl> --output-directory <approved-aggregate-directory>`.
6. Archive only `tiktok-stage1-soak-report.json`; investigate every sorted blocker without editing evidence to force a pass.
7. Require `ready=true`, explicit human approval, and the rollback drill below before the default-mode commit.
```

Document that observation JSONL is sensitive operational evidence even though fields are safe and must not be committed, pasted into tickets, or printed. Include definitions for all five routes and all policy counts/rates.

Also document where each route's cleanup booleans come from: the four terminal-result routes read them from the activity's own `tiktok_cleanup` event (`acquisition_dependency_unavailable` included, with zero attempts), while `operator_cancelled` reads them only from the controlled cancellation gate — a deliberate cancellation run that measures the two invariants after cancellation settles. State that every workflow in the window reconciles to exactly one observation, and that a missing workflow or one with no cleanup-evidence source leaves the dataset unfit for the cutover decision; absence of evidence is never a cleanup PASS.

- [ ] **Step 4: Document the deployment rollback drill and emergency choices**

```markdown
### Required rollback drill

1. Set `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback` for ordinary recovery or `legacy_scout` for full acquisition rollback.
2. Restart the Python worker; in-flight workflows retain their durable input mode.
3. Confirm newly gateway-started workflows carry the selected mode.
4. Run one approved public TikTok post and verify exact Python/legacy activity counts.
5. Audit logs and source events for zero source URLs, signed URLs, provider payloads, exception text, and absolute paths.
```

Do not include real workflow IDs, URLs, environment values, report paths, screenshots, or live output.

- [ ] **Step 5: Link plan status from the migration roadmap**

Update the Stage 1 status and immediate next-step paragraphs to link the approved design and this plan. Keep Stage 2 enrichment/discovery decomposition unchanged and explicitly state that Stage 2 starts only after the Stage 1 cutover decision is completed.

- [ ] **Step 6: Run documentation safety searches**

Run: `rtk grep -n "token=|signed_url|C:\\\\|/Users/|source_url.*https" docs/python-control-plane.md docs/operations/tiktok-stage1-soak-observation.example.jsonl docs/python-scout-migration-roadmap.md`

Expected: no secret-bearing URL, absolute user path, or provider token match. The synthetic TikTok contract contains no URL field.

- [ ] **Step 7: Commit the operations knowledge**

```powershell
rtk git add docs/python-control-plane.md docs/python-scout-migration-roadmap.md docs/operations/tiktok-stage1-soak-observation.example.jsonl
rtk git commit -m "docs: add tiktok stage 1 soak runbook"
```

### Task 9: Run implementation regression gates and begin the operational soak

**Files:**

- No repository files are changed by the soak itself.
- External output: approved workflow-level JSONL outside Git and an archived aggregate `tiktok-stage1-soak-report.json` in the operations channel.

**Interfaces:**

- Consumes: Tasks 1-8 and the deployment's approved Temporal export/monitoring channel.
- Produces: one aggregate report with `ready=true`, an explicit human approval record, and a successful rollback-drill record required by Task 10.
- Stop condition: if any of the three artifacts is missing, stale, or failed, do not start Task 10 and do not change the default.

- [ ] **Step 1: Run deterministic Python quality and test gates**

Run: `rtk uv run ruff check src tests`

Run: `rtk uv run ruff format --check src tests`

Run: `rtk uv run pytest -m "not live" -q`

Expected: all commands PASS.

- [ ] **Step 2: Run focused legacy Scout acquisition regressions**

From repository root run: `rtk proxy bun --cwd=scout run typecheck`

From repository root run: `rtk proxy bun --cwd=scout run test:acquisition`

Expected: both gates PASS without live provider access.

- [ ] **Step 3: Deploy fallback mode with safe provider logging**

Set the deployment-owned value to `python_tiktok_with_legacy_fallback`, restart the worker, and confirm new workflow inputs carry that exact mode. Do not print the environment, approved public URL, or worker log body.

- [ ] **Step 4: Collect and validate the approved soak dataset**

Collect normal approved single-post TikTok traffic until all of these are simultaneously true:

```text
window >= 168 hours
valid completed runs >= 50
designated parity samples >= 5
```

Export strict JSONL outside Git, run the Task 7 command, and verify the archived aggregate report says `ready: true` with `blockers: []`.

- [ ] **Step 5: Obtain explicit human cutover approval**

The change record must cite the archived aggregate report, the exact evaluator version/commit, the deployment, and the approver. It must not embed observation JSONL, source/workflow IDs, URLs, provider data, or raw logs.

- [ ] **Step 6: Complete the rollback drill before cutover**

Execute the five runbook steps from Task 8, verify expected activity counts and redaction/cleanup evidence, restore `python_tiktok_with_legacy_fallback`, restart the worker, and record PASS in the same approved change record.

- [ ] **Step 7: Enforce the cutover checkpoint**

Proceed only when all predicates are true:

```text
aggregate_report.ready == true
aggregate_report.blockers == []
human_approval == recorded
rollback_drill == passed
implementation_commit == evaluated_commit
```

If any predicate is false, stop here, keep fallback mode as the default, investigate, collect a fresh valid window if evidence changed, and regenerate the report.

### Task 10: Land the separately gated Python-only default cutover

**Files:**

- Modify: `python/src/thoth_control_plane/config.py:32-34`
- Modify: `python/tests/activities/test_legacy_scout.py:337-366`
- Modify: `python/tests/workflows/test_source_investigation.py:620-670,1080-1090`
- Modify: `python/tests/api/test_workflows.py`
- Modify: `docs/python-control-plane.md:34-44,67-103`
- Modify: `docs/python-scout-migration-roadmap.md:66-70,295-300`

**Interfaces:**

- Consumes: the five passing checkpoint predicates from Task 9.
- Produces: `Settings.THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE == "python"` when the environment omits the variable.
- Preserves: all three explicit `SourceActivityMode` values, gateway propagation, Python-never-calls-legacy behavior, and absence of a mode field from FastAPI request schemas.

- [ ] **Step 1: Reconfirm the external gate before touching code**

Read the approved change record and aggregate report through the approved channel. If `ready=true`, empty blockers, approval, rollback PASS, and commit identity cannot all be verified, stop without editing a repository file.

- [ ] **Step 2: Change tests first to pin the Python-only default and emergency modes**

```python
def test_source_activity_mode_defaults_to_python() -> None:
    settings = Settings(THOTH_CONTROL_PLANE_API_KEY="test-key")
    assert settings.source_investigation_activity_mode == "python"


@pytest.mark.parametrize(
    "mode", ["python", "python_tiktok_with_legacy_fallback", "legacy_scout"]
)
def test_all_explicit_source_activity_modes_remain_accepted(mode: str) -> None:
    settings = Settings(
        THOTH_CONTROL_PLANE_API_KEY="test-key",
        THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=mode,
    )
    assert settings.source_investigation_activity_mode == mode


def test_public_workflow_request_rejects_activity_mode() -> None:
    with pytest.raises(ValidationError):
        WorkflowRequest.model_validate({**VALID_REQUEST, "activity_mode": "legacy_scout"})
```

Retain the existing Temporal routing test asserting explicit `python` performs one Python call and zero legacy calls, plus the gateway propagation test for `legacy_scout`.

- [ ] **Step 3: Run the cutover tests and verify RED**

Run: `rtk uv run pytest tests/activities/test_legacy_scout.py tests/workflows/test_source_investigation.py tests/api/test_workflows.py -q`

Expected: FAIL only because the current settings default remains `python_tiktok_with_legacy_fallback`.

- [ ] **Step 4: Change only the settings default**

```python
THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: SourceActivityMode = "python"
```

Do not remove a literal mode, change workflow routing, unregister the legacy worker, or add any API/dashboard configuration field.

- [ ] **Step 5: Update operations documentation to describe the new normal and rollback**

Change `python` to “normal default for one public TikTok post.” Describe `python_tiktok_with_legacy_fallback` as ordinary emergency recovery and `legacy_scout` as full acquisition rollback. Cite the approved external change record identifier without copying workflow-level evidence into Git.

- [ ] **Step 6: Run cutover, full regression, schema, and formatting gates**

Run: `rtk uv run pytest tests/activities/test_legacy_scout.py tests/workflows/test_source_investigation.py tests/api/test_workflows.py -q`

Run: `rtk uv run pytest -m "not live" -q`

Run: `rtk uv run ruff check src tests`

Run: `rtk uv run ruff format --check src tests`

Run: `rtk grep -n "activity_mode" python/src/thoth_control_plane/api dashboard/src`

Expected: all Python gates PASS; search finds no request/dashboard control that selects the activity mode.

- [ ] **Step 7: Commit the cutover separately**

```powershell
rtk git add python/src/thoth_control_plane/config.py python/tests/activities/test_legacy_scout.py python/tests/workflows/test_source_investigation.py python/tests/api/test_workflows.py docs/python-control-plane.md docs/python-scout-migration-roadmap.md
rtk git commit -m "feat: make python tiktok acquisition the default"
```

- [ ] **Step 8: Deploy the cutover and run one controlled Python-only canary**

Deploy with no activity-mode override, restart the worker, start one approved public TikTok post, and verify one Python activity, zero legacy activities, a valid artifact, attempt plus cleanup evidence, and no sensitive provider data in logs/events. If any assertion fails, set `python_tiktok_with_legacy_fallback`, restart the worker, and follow the documented incident path.

- [ ] **Step 9: Record Stage 1 completion without retiring Scout**

Record the canary outcome and cutover commit in the approved operational change record. Keep both emergency modes and legacy worker registration intact; the next repository work is a separate Stage 2 post-enrichment specification, not deletion of Scout.

## Final Verification Matrix

| Gate | Required evidence | Blocks default cutover |
| --- | --- | --- |
| Contracts/events | Python tests prove safe attempts, cleanup, and replay-stable fallback order | Yes |
| Provider logging | Synthetic hostile records are dropped/redacted before handlers | Yes |
| Dataset | Strict JSONL validates; duplicates/order/invariants fail closed | Yes |
| Soak | 168 hours, 50 completed, 5 parity, approved rate limits | Yes |
| Zero tolerance | No infrastructure, persistence, redaction, path, cleanup, or parity failures | Yes |
| Decision | Aggregate `ready=true`, empty blockers, human approval | Yes |
| Rollback | Fallback/legacy restart drill passes | Yes |
| Cutover | Default-only change, all explicit modes accepted, no API control | Yes |
| Canary | Python-only run succeeds with zero legacy calls and safe evidence | Requires immediate rollback on failure |

## Execution Prompt

```text
Implement docs/superpowers/plans/2026-09-02-python-tiktok-stage1-cutover.md task-by-task and treat docs/superpowers/specs/2026-09-02-python-tiktok-stage1-cutover-design.md as the authoritative specification. Use test-driven development, run every RED and GREEN command, make the named small commit after each completed task, and preserve unrelated worktree changes. Keep Scrapling headless primary, TikWM/CDN secondary, and legacy Scout reachable only through explicit fallback/rollback modes. Never expose URLs, provider payloads, exception text, absolute paths, workflow-level soak evidence, or runtime mode through HTTP/dashboard schemas. Stop after Task 8 until the full Task 9 operational soak, ready aggregate report, explicit human approval, and rollback drill are independently verified. Do not execute Task 10 or change the default to python before those gates pass. Do not add Stage 2 capabilities or remove Scout/Bun.
```
