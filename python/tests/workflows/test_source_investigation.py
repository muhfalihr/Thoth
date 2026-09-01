"""Durability tests for the source-investigation workflow."""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import thoth_control_plane.infrastructure.temporal_gateway as temporal_gateway
from thoth_control_plane import worker
from thoth_control_plane.acquisition.models import TikTokAcquisitionResult, TikTokSourceReport
from thoth_control_plane.activities.legacy_scout import LEGACY_ADAPTER_TASK_QUEUE, LegacyScoutInput
from thoth_control_plane.activities.source_investigation import (
    SourceInvestigationActivityInput,
    build_source_investigation_activity,
)
from thoth_control_plane.api.app import create_app
from thoth_control_plane.application import (
    ApprovalSubmission,
    IdempotencyConflict,
    WorkflowNotFound,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import (
    Actor,
    ActorSnapshot,
    ApprovalDecision,
    ApprovalSignal,
    EventKind,
    SourceInvestigationActivityResult,
    SourceInvestigationWorkflowInput,
    WorkflowRequest,
    WorkflowStatus,
    WorkflowSummary,
    request_snapshot_id,
    safe_workflow_source,
)
from thoth_control_plane.domain.models import SafeActivityError, SourceProgressEvent
from thoth_control_plane.infrastructure.temporal_gateway import (
    TASK_QUEUE,
    TemporalWorkflowGateway,
)
from thoth_control_plane.workflows.source_investigation import SourceInvestigationWorkflow

VALID_IDENTIFY_REQUEST = WorkflowRequest.model_validate(
    {
        "source": {
            "url": "https://example.test/post?signature=must-not-leak",
            "intent": "identify_original",
        },
        "style": {"preset_id": "news-vertical"},
        "output": {"format": "vertical_video", "language": "id"},
        "review": {"require_publish_approval": True},
    }
)
VALID_PRODUCE_REQUEST = VALID_IDENTIFY_REQUEST.model_copy(
    update={"source": VALID_IDENTIFY_REQUEST.source.model_copy(update={"intent": "produce_video"})}
)
ACTOR_SNAPSHOT = ActorSnapshot(actor_id="owner", actor_type="user")


def workflow_input(
    request: WorkflowRequest, actor: ActorSnapshot = ACTOR_SNAPSHOT
) -> SourceInvestigationWorkflowInput:
    return SourceInvestigationWorkflowInput(
        request_snapshot_id=request_snapshot_id(request),
        source=safe_workflow_source(request),
        intent=request.source.intent,
        actor=actor,
    )


@activity.defn(name="inspect_source_candidates")
async def fake_inspect(input_: object) -> SourceInvestigationActivityResult:
    del input_
    return SourceInvestigationActivityResult.model_validate(
        {
            "report": {
                "artifact_id": "art_source_report_001",
                "kind": "source_report",
                "label": "Source investigation report",
                "media_type": "application/json",
                "location": "reports/source-investigation-001.json",
                "checksum": "sha256:" + "a" * 64,
            },
        }
    )


@activity.defn(name="inspect_legacy_scout")
async def fake_legacy_inspect(input_: LegacyScoutInput) -> SourceInvestigationActivityResult:
    assert input_.workflow_id.startswith("wf_")
    assert input_.output_package_id.startswith("pkg_")
    assert input_.canonical_source_url.query is None
    result = await fake_inspect(input_)
    return result.model_copy(
        update={
            "events": [
                {"kind": "stage.started", "payload": {"stage": "source"}},
                {
                    "kind": "stage.progress",
                    "payload": {"stage": "source", "progress": 0.5},
                },
                {"kind": "stage.completed", "payload": {"stage": "source"}},
            ]
        }
    )


@activity.defn(name="inspect_legacy_scout")
async def failed_legacy_inspect(input_: LegacyScoutInput) -> SourceInvestigationActivityResult:
    del input_
    return SourceInvestigationActivityResult(
        failure={"code": LEGACY_FAILURE_CODE, "retryable": False}
    )


FAILING_ACTIVITY_ATTEMPTS = 0
CANCELLING_ACTIVITY_RELEASE: asyncio.Event | None = None
LEGACY_ACTIVITY_STARTED: asyncio.Event | None = None
LEGACY_ACTIVITY_CANCELLED: asyncio.Event | None = None
LEGACY_FAILURE_CODE = "legacy_scout_failed"


@activity.defn(name="inspect_source_candidates")
async def failing_inspect(input_: object) -> SourceInvestigationActivityResult:
    del input_
    global FAILING_ACTIVITY_ATTEMPTS
    FAILING_ACTIVITY_ATTEMPTS += 1
    return SourceInvestigationActivityResult(
        failure={"code": "source_investigation_failed", "retryable": True}
    )


@activity.defn(name="inspect_source_candidates")
async def crashing_inspect(input_: object) -> SourceInvestigationActivityResult:
    del input_
    raise RuntimeError("provider token and raw activity detail must not enter history events")


@activity.defn(name="inspect_source_candidates")
async def cancelling_inspect(input_: object) -> SourceInvestigationActivityResult:
    del input_
    assert CANCELLING_ACTIVITY_RELEASE is not None
    await CANCELLING_ACTIVITY_RELEASE.wait()
    return SourceInvestigationActivityResult(
        failure={"code": "source_investigation_cancelled", "retryable": False}
    )


@activity.defn(name="inspect_legacy_scout")
async def cancelling_legacy_inspect(input_: LegacyScoutInput) -> SourceInvestigationActivityResult:
    del input_
    assert LEGACY_ACTIVITY_STARTED is not None
    assert LEGACY_ACTIVITY_CANCELLED is not None
    LEGACY_ACTIVITY_STARTED.set()
    try:
        await asyncio.Event().wait()
    except asyncio.CancelledError:
        LEGACY_ACTIVITY_CANCELLED.set()
        raise


@pytest_asyncio.fixture
async def workflow_env() -> AsyncIterator[WorkflowEnvironment]:
    environment = await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    )
    try:
        yield environment
    finally:
        await environment.shutdown()


async def wait_for_status(handle: object, status: str) -> None:
    for _ in range(100):
        summary = await handle.query(SourceInvestigationWorkflow.summary)  # type: ignore[attr-defined]
        if summary.status == status:
            return
        await asyncio.sleep(0.01)
    pytest.fail(f"workflow did not reach {status}")


@pytest.mark.asyncio
async def test_identify_original_finishes_with_a_redacted_source_report(
    workflow_env: WorkflowEnvironment,
) -> None:
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[workflow_input(VALID_IDENTIFY_REQUEST)],
            id="wf_test_report",
            task_queue="test",
        )

    assert result.status == "succeeded"
    assert result.artifacts[0].kind == "source_report"
    assert "signature" not in str(result.model_dump(mode="json"))
    assert "candidate_001" not in str(result.model_dump(mode="json"))


@pytest.mark.asyncio
async def test_legacy_selection_runs_only_the_isolated_adapter_queue(
    workflow_env: WorkflowEnvironment,
) -> None:
    legacy_input = workflow_input(VALID_IDENTIFY_REQUEST).model_copy(
        update={"activity_mode": "legacy_scout"}
    )
    async with (
        Worker(
            workflow_env.client,
            task_queue="test",
            workflows=[SourceInvestigationWorkflow],
        ),
        Worker(
            workflow_env.client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[fake_legacy_inspect],
            max_concurrent_activities=1,
        ),
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[legacy_input],
            id="wf_test_legacy_queue",
            task_queue="test",
        )

    assert result.status == "succeeded"
    assert result.artifacts[0].kind == "source_report"


@pytest.mark.asyncio
async def test_produce_video_waits_for_authorized_approval_then_resumes_once(
    workflow_env: WorkflowEnvironment,
) -> None:
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        handle = await workflow_env.client.start_workflow(
            SourceInvestigationWorkflow.run,
            args=[workflow_input(VALID_PRODUCE_REQUEST)],
            id="wf_test_approval",
            task_queue="test",
        )
        await wait_for_status(handle, "awaiting_approval")
        awaiting = await handle.query(SourceInvestigationWorkflow.summary)
        assert awaiting.approval is not None

        await handle.signal(
            SourceInvestigationWorkflow.record_approval,
            ApprovalSignal(
                approval_id=awaiting.approval.approval_id,
                decision=ApprovalDecision(decision="approve"),
                actor=ActorSnapshot(actor_id="outsider", actor_type="user"),
                decided_at=datetime(2026, 8, 29, tzinfo=UTC),
            ),
        )
        assert (await handle.query(SourceInvestigationWorkflow.summary)).status == (
            "awaiting_approval"
        )

        await handle.signal(
            SourceInvestigationWorkflow.record_approval,
            ApprovalSignal(
                approval_id=awaiting.approval.approval_id,
                decision=ApprovalDecision(decision="approve"),
                actor=ACTOR_SNAPSHOT,
                decided_at=datetime(2026, 8, 29, tzinfo=UTC),
            ),
        )
        result = await handle.result()

        assert result.status == "succeeded"
        assert result.approval is None
        assert [artifact.kind for artifact in result.artifacts] == ["source_report"]
        events = await handle.query(SourceInvestigationWorkflow.workflow_events)

    assert [event.kind for event in events] == [
        EventKind.WORKFLOW_QUEUED,
        EventKind.WORKFLOW_STARTED,
        EventKind.STAGE_STARTED,
        EventKind.STAGE_COMPLETED,
        EventKind.ARTIFACT_CREATED,
        EventKind.APPROVAL_REQUIRED,
        EventKind.APPROVAL_RECORDED,
        EventKind.WORKFLOW_COMPLETED,
    ]


@pytest.mark.asyncio
async def test_cancel_signal_finishes_as_cancelled(
    workflow_env: WorkflowEnvironment,
) -> None:
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        handle = await workflow_env.client.start_workflow(
            SourceInvestigationWorkflow.run,
            args=[workflow_input(VALID_PRODUCE_REQUEST)],
            id="wf_test_cancel",
            task_queue="test",
        )
        await wait_for_status(handle, "awaiting_approval")
        await handle.signal(SourceInvestigationWorkflow.request_cancel)
        result = await handle.result()

    assert result.status == "cancelled"
    assert result.approval is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_code", ["legacy_scout_timeout", "legacy_scout_failed"])
async def test_legacy_timeout_or_nonzero_failure_reaches_workflow_summary(
    workflow_env: WorkflowEnvironment,
    failure_code: str,
) -> None:
    global LEGACY_FAILURE_CODE
    LEGACY_FAILURE_CODE = failure_code
    legacy_input = workflow_input(VALID_IDENTIFY_REQUEST).model_copy(
        update={"activity_mode": "legacy_scout"}
    )
    async with (
        Worker(
            workflow_env.client,
            task_queue="test",
            workflows=[SourceInvestigationWorkflow],
        ),
        Worker(
            workflow_env.client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[failed_legacy_inspect],
            max_concurrent_activities=1,
        ),
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[legacy_input],
            id=f"wf_test_{failure_code}",
            task_queue="test",
        )

    assert result.status == "failed"
    assert result.failure is not None
    assert result.failure.code == failure_code
    assert result.artifacts == []


@pytest.mark.asyncio
async def test_legacy_cancellation_cancels_the_owned_activity_and_workflow(
    workflow_env: WorkflowEnvironment,
) -> None:
    global LEGACY_ACTIVITY_STARTED, LEGACY_ACTIVITY_CANCELLED
    LEGACY_ACTIVITY_STARTED = asyncio.Event()
    LEGACY_ACTIVITY_CANCELLED = asyncio.Event()
    legacy_input = workflow_input(VALID_IDENTIFY_REQUEST).model_copy(
        update={"activity_mode": "legacy_scout"}
    )
    async with (
        Worker(
            workflow_env.client,
            task_queue="test",
            workflows=[SourceInvestigationWorkflow],
        ),
        Worker(
            workflow_env.client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[cancelling_legacy_inspect],
            max_concurrent_activities=1,
        ),
    ):
        handle = await workflow_env.client.start_workflow(
            SourceInvestigationWorkflow.run,
            args=[legacy_input],
            id="wf_test_legacy_cancel",
            task_queue="test",
        )
        await asyncio.wait_for(LEGACY_ACTIVITY_STARTED.wait(), timeout=3)
        await handle.signal(SourceInvestigationWorkflow.request_cancel)
        result = await asyncio.wait_for(handle.result(), timeout=3)

    assert result.status == "cancelled"
    assert LEGACY_ACTIVITY_CANCELLED.is_set()


@pytest.mark.asyncio
async def test_activity_failure_is_bounded_and_returns_only_a_safe_failure(
    workflow_env: WorkflowEnvironment,
) -> None:
    global FAILING_ACTIVITY_ATTEMPTS
    FAILING_ACTIVITY_ATTEMPTS = 0
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[failing_inspect],
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[workflow_input(VALID_IDENTIFY_REQUEST)],
            id="wf_test_safe_failure",
            task_queue="test",
        )

    assert FAILING_ACTIVITY_ATTEMPTS == 1
    assert result.status == "failed"
    assert result.failure is not None
    assert result.failure.code == "source_investigation_failed"
    assert "provider token" not in result.model_dump_json()


@pytest.mark.asyncio
async def test_success_trace_records_the_complete_safe_source_lifecycle(
    workflow_env: WorkflowEnvironment,
) -> None:
    workflow_id = "wf_test_complete_lifecycle"
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[workflow_input(VALID_IDENTIFY_REQUEST)],
            id=workflow_id,
            task_queue="test",
        )
        events = await workflow_env.client.get_workflow_handle(workflow_id).query(
            SourceInvestigationWorkflow.workflow_events
        )

    assert [event.kind for event in events] == [
        EventKind.WORKFLOW_QUEUED,
        EventKind.WORKFLOW_STARTED,
        EventKind.STAGE_STARTED,
        EventKind.STAGE_COMPLETED,
        EventKind.ARTIFACT_CREATED,
        EventKind.WORKFLOW_COMPLETED,
    ]
    assert [event.sequence for event in events] == list(range(1, 7))
    assert events[2].stage is not None and events[2].stage.name == "source"
    assert events[4].artifact is not None and events[4].artifact.kind == "source_report"
    assert "provider" not in str([event.model_dump(mode="json") for event in events])


@pytest.mark.asyncio
async def test_approval_and_cancel_traces_record_their_terminal_lifecycle(
    workflow_env: WorkflowEnvironment,
) -> None:
    workflow_id = "wf_test_approval_cancel_lifecycle"
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        handle = await workflow_env.client.start_workflow(
            SourceInvestigationWorkflow.run,
            args=[workflow_input(VALID_PRODUCE_REQUEST)],
            id=workflow_id,
            task_queue="test",
        )
        await wait_for_status(handle, "awaiting_approval")
        await handle.signal(SourceInvestigationWorkflow.request_cancel)
        assert (await handle.result()).status == "cancelled"
        events = await handle.query(SourceInvestigationWorkflow.workflow_events)

    assert EventKind.APPROVAL_REQUIRED in [event.kind for event in events]
    assert events[-1].kind == EventKind.WORKFLOW_CANCELLED
    assert [event.sequence for event in events] == list(range(1, len(events) + 1))


@pytest.mark.asyncio
async def test_activity_error_records_a_typed_safe_workflow_failure_event(
    workflow_env: WorkflowEnvironment,
) -> None:
    workflow_id = "wf_test_activity_error_lifecycle"
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[crashing_inspect],
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[workflow_input(VALID_IDENTIFY_REQUEST)],
            id=workflow_id,
            task_queue="test",
        )
        events = await workflow_env.client.get_workflow_handle(workflow_id).query(
            SourceInvestigationWorkflow.workflow_events
        )

    assert result.status == "failed"
    assert result.failure is not None and result.failure.code == "source_investigation_failed"
    assert events[-1].kind == EventKind.WORKFLOW_FAILED
    serialized = str([event.model_dump(mode="json") for event in events])
    assert "provider token" not in serialized
    assert "raw activity detail" not in serialized


@pytest.mark.asyncio
async def test_temporal_gateway_reuses_durable_id_and_enforces_actor_scope(
    workflow_env: WorkflowEnvironment,
) -> None:
    async with Worker(
        workflow_env.client,
        task_queue=TASK_QUEUE,
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        gateway = TemporalWorkflowGateway(workflow_env.client)
        owner = Actor(actor_id="owner", actor_type="user")
        first = await gateway.start(
            VALID_IDENTIFY_REQUEST,
            actor=owner,
            idempotency_key="create-001",
        )
        second = await gateway.start(
            VALID_IDENTIFY_REQUEST,
            actor=owner,
            idempotency_key="create-001",
        )
        result = await gateway.get(first.workflow_id, actor=owner)

        assert second.workflow_id == first.workflow_id
        assert result.status == "succeeded"
        changed = VALID_IDENTIFY_REQUEST.model_copy(
            update={"output": VALID_IDENTIFY_REQUEST.output.model_copy(update={"language": "en"})}
        )
        with pytest.raises(IdempotencyConflict):
            await gateway.start(changed, actor=owner, idempotency_key="create-001")

        same_id_service = Actor(actor_id="owner", actor_type="service")
        service_summary = await gateway.start(
            VALID_IDENTIFY_REQUEST,
            actor=same_id_service,
            idempotency_key="create-001",
        )
        assert service_summary.workflow_id != first.workflow_id
        with pytest.raises(WorkflowNotFound):
            await gateway.get(first.workflow_id, actor=same_id_service)
        with pytest.raises(WorkflowNotFound):
            await gateway.get(
                first.workflow_id,
                actor=Actor(actor_id="outsider", actor_type="user"),
            )


@pytest.mark.asyncio
async def test_temporal_history_contains_only_redacted_workflow_values(
    workflow_env: WorkflowEnvironment,
) -> None:
    async with Worker(
        workflow_env.client,
        task_queue=TASK_QUEUE,
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        gateway = TemporalWorkflowGateway(workflow_env.client)
        summary = await gateway.start(
            VALID_IDENTIFY_REQUEST,
            actor=Actor(actor_id="owner", actor_type="user"),
            idempotency_key="history-001",
        )
        history = await workflow_env.client.get_workflow_handle(summary.workflow_id).fetch_history()

    serialized_history = history.to_json()
    assert "signature=must-not-leak" not in serialized_history
    assert "candidate_001" not in serialized_history
    assert "provider token" not in serialized_history


CANONICAL_TIKTOK_URL = "https://www.tiktok.com/@creator/video/1234567890"
_FIXTURE_REPORT_PATH = (
    Path(__file__).resolve().parent.parent / "fixtures" / "tiktok" / "normalized_report.json"
)


def _offline_successful_runner():
    """Build a deterministic, offline `AcquisitionRunner` for workflow tests.

    Never touches Scrapling, Chromium, or TikWM; keeps the ordinary suite
    fully offline while exercising the real activity persistence path.
    """

    async def run(workflow_id: str, source_url: str, artifact_root: Path):
        del source_url
        media_path = artifact_root / f"reports/{workflow_id}/media/tiktok-1234567890.mp4"
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 10_100)
        report = TikTokSourceReport.model_validate_json(
            _FIXTURE_REPORT_PATH.read_text(encoding="utf-8")
        ).model_copy(update={"workflow_id": workflow_id})
        return TikTokAcquisitionResult(report=report)

    return run


@pytest.mark.asyncio
async def test_source_investigation_activity_materializes_its_report(
    tmp_path,
) -> None:
    configured_activity = build_source_investigation_activity(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_CONTROL_PLANE_ARTIFACT_ROOT=tmp_path,
            THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE="python",
        ),
        runner=_offline_successful_runner(),
    )
    result = await configured_activity(
        SourceInvestigationActivityInput(
            workflow_id="wf_materialized",
            request_snapshot_id="req_materialized",
            canonical_source_url=CANONICAL_TIKTOK_URL,
        )
    )

    assert result.report is not None
    report = tmp_path / result.report.location
    assert report.is_file()
    assert "wf_materialized" in report.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_production_worker_registration_binds_source_activity_to_configured_artifact_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    registered: dict[str, object] = {}

    class CapturingWorker:
        def __init__(self, client: object, **kwargs: object) -> None:
            registered["client"] = client
            registered.update(kwargs)

    monkeypatch.setattr(worker, "Worker", CapturingWorker)
    configured_root = tmp_path / "configured-artifacts"
    worker.build_source_investigation_worker(
        object(),
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_CONTROL_PLANE_ARTIFACT_ROOT=configured_root,
            THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE="python",
        ),
        runner=_offline_successful_runner(),
    )

    activities = registered["activities"]
    assert isinstance(activities, list)
    result = await activities[0](
        SourceInvestigationActivityInput(
            workflow_id="wf_registered_root",
            request_snapshot_id="req_registered_root",
            canonical_source_url=CANONICAL_TIKTOK_URL,
        )
    )

    assert (configured_root / "reports" / "wf_registered_root" / "source-report.json").is_file()
    assert result.report.location == "reports/wf_registered_root/source-report.json"


@pytest.mark.asyncio
async def test_gateway_approval_and_cancellation_use_authorized_boundaries(
    workflow_env: WorkflowEnvironment,
) -> None:
    owner = Actor(actor_id="owner", actor_type="user")
    async with Worker(
        workflow_env.client,
        task_queue=TASK_QUEUE,
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        gateway = TemporalWorkflowGateway(workflow_env.client)
        approved = await gateway.start(
            VALID_PRODUCE_REQUEST,
            actor=owner,
            idempotency_key="approval-001",
        )
        approved_handle = workflow_env.client.get_workflow_handle(
            approved.workflow_id,
            result_type=WorkflowSummary,
        )
        await wait_for_status(approved_handle, "awaiting_approval")
        awaiting = await gateway.get(approved.workflow_id, actor=owner)
        assert awaiting.approval is not None
        await gateway.record_approval(
            approved.workflow_id,
            approval=ApprovalSubmission(
                approval_id=awaiting.approval.approval_id,
                decision="approve",
            ),
            actor=owner,
        )
        assert (await approved_handle.result()).status == "succeeded"

        cancelled = await gateway.start(
            VALID_PRODUCE_REQUEST,
            actor=owner,
            idempotency_key="cancel-001",
        )
        cancelled_handle = workflow_env.client.get_workflow_handle(
            cancelled.workflow_id,
            result_type=WorkflowSummary,
        )
        await wait_for_status(cancelled_handle, "awaiting_approval")
        await gateway.cancel(cancelled.workflow_id, actor=owner)
        assert (await cancelled_handle.result()).status == "cancelled"


@pytest.mark.asyncio
async def test_gateway_event_stream_returns_current_snapshot_then_unseen_events(
    workflow_env: WorkflowEnvironment,
) -> None:
    async with Worker(
        workflow_env.client,
        task_queue=TASK_QUEUE,
        workflows=[SourceInvestigationWorkflow],
        activities=[fake_inspect],
    ):
        gateway = TemporalWorkflowGateway(workflow_env.client)
        owner = Actor(actor_id="owner", actor_type="user")
        started = await gateway.start(
            VALID_PRODUCE_REQUEST,
            actor=owner,
            idempotency_key="events-001",
        )
        handle = workflow_env.client.get_workflow_handle(
            started.workflow_id,
            result_type=WorkflowSummary,
        )
        await wait_for_status(handle, "awaiting_approval")
        awaiting = await handle.query(SourceInvestigationWorkflow.summary)

        initial = [
            event
            async for event in gateway.stream_events(
                started.workflow_id,
                actor=owner,
                after_sequence=0,
            )
        ]

        assert [event.kind for event in initial] == [
            "workflow.queued",
            "workflow.started",
            "stage.started",
            "stage.completed",
            "artifact.created",
            "approval.required",
        ]
        cursor = initial[-1].sequence
        assert awaiting.approval is not None
        await gateway.record_approval(
            started.workflow_id,
            approval=ApprovalSubmission(
                approval_id=awaiting.approval.approval_id,
                decision="approve",
            ),
            actor=owner,
        )
        await handle.result()

        replayed = [
            event
            async for event in gateway.stream_events(
                started.workflow_id,
                actor=owner,
                after_sequence=cursor,
            )
        ]

        assert [event.kind for event in replayed] == [
            "approval.recorded",
            "workflow.completed",
        ]
        assert [event.sequence for event in replayed] == list(
            range(cursor + 1, cursor + 1 + len(replayed))
        )

        with pytest.raises(WorkflowNotFound):
            _ = [
                event
                async for event in gateway.stream_events(
                    started.workflow_id,
                    actor=Actor(actor_id="intruder", actor_type="user"),
                    after_sequence=0,
                )
            ]


@pytest.mark.asyncio
async def test_gateway_cancellation_wins_when_the_running_activity_returns_an_error(
    workflow_env: WorkflowEnvironment,
) -> None:
    global CANCELLING_ACTIVITY_RELEASE
    CANCELLING_ACTIVITY_RELEASE = asyncio.Event()
    owner = Actor(actor_id="owner", actor_type="user")
    async with Worker(
        workflow_env.client,
        task_queue=TASK_QUEUE,
        workflows=[SourceInvestigationWorkflow],
        activities=[cancelling_inspect],
    ):
        gateway = TemporalWorkflowGateway(workflow_env.client)
        started = await gateway.start(
            VALID_IDENTIFY_REQUEST,
            actor=owner,
            idempotency_key="running-cancel-001",
        )
        handle = workflow_env.client.get_workflow_handle(
            started.workflow_id,
            result_type=WorkflowSummary,
        )
        await wait_for_status(handle, "running")
        await gateway.cancel(started.workflow_id, actor=owner)
        CANCELLING_ACTIVITY_RELEASE.set()
        assert (await handle.result()).status == "cancelled"


PYTHON_CALLS = 0
LEGACY_CALLS = 0


@activity.defn(name="inspect_source_candidates")
async def eligible_python_failure(input_: SourceInvestigationActivityInput):
    global PYTHON_CALLS
    PYTHON_CALLS += 1
    return SourceInvestigationActivityResult(
        failure={"code": "headless_blocked", "retryable": True}
    )


@activity.defn(name="inspect_source_candidates")
async def cdn_unavailable_python_failure(input_: SourceInvestigationActivityInput):
    """A real, service-producible eligible failure (see `TikWmError`).

    Unlike `eligible_python_failure` (`headless_blocked`, a code
    `TikTokAcquisitionService.inspect()` never actually returns), this pins
    the fallback path a production run can really hit.
    """
    global PYTHON_CALLS
    PYTHON_CALLS += 1
    return SourceInvestigationActivityResult(failure={"code": "cdn_unavailable", "retryable": True})


@activity.defn(name="inspect_source_candidates")
async def unsafe_python_failure(input_: SourceInvestigationActivityInput):
    global PYTHON_CALLS
    PYTHON_CALLS += 1
    return SourceInvestigationActivityResult(
        failure={"code": "invalid_tiktok_url", "retryable": False}
    )


@activity.defn(name="inspect_source_candidates")
async def acquisition_runner_python_failure(input_: SourceInvestigationActivityInput):
    global PYTHON_CALLS
    PYTHON_CALLS += 1
    return SourceInvestigationActivityResult(
        failure={"code": "acquisition_runner_failed", "retryable": False}
    )


@activity.defn(name="inspect_source_candidates")
async def acquisition_dependency_python_failure(input_: SourceInvestigationActivityInput):
    global PYTHON_CALLS
    PYTHON_CALLS += 1
    return SourceInvestigationActivityResult(
        failure={"code": "acquisition_dependency_unavailable", "retryable": False}
    )


@activity.defn(name="inspect_source_candidates")
async def artifact_persistence_python_failure(input_: SourceInvestigationActivityInput):
    global PYTHON_CALLS
    PYTHON_CALLS += 1
    return SourceInvestigationActivityResult(
        failure={"code": "artifact_persistence_failed", "retryable": False}
    )


@activity.defn(name="inspect_legacy_scout")
async def counted_legacy_success(input_: LegacyScoutInput):
    global LEGACY_CALLS
    LEGACY_CALLS += 1
    return await fake_legacy_inspect(input_)


@activity.defn(name="inspect_source_candidates")
async def counted_python_success(input_: SourceInvestigationActivityInput):
    global PYTHON_CALLS
    PYTHON_CALLS += 1
    return await fake_inspect(input_)


async def run_routing_case(workflow_env, *, source_url: str, mode: str, python_activity):
    global PYTHON_CALLS, LEGACY_CALLS
    PYTHON_CALLS = 0
    LEGACY_CALLS = 0
    request = VALID_IDENTIFY_REQUEST.model_copy(
        update={"source": VALID_IDENTIFY_REQUEST.source.model_copy(update={"url": source_url})}
    )
    input_ = workflow_input(request).model_copy(update={"activity_mode": mode})
    async with (
        Worker(
            workflow_env.client,
            task_queue="test",
            workflows=[SourceInvestigationWorkflow],
            activities=[python_activity],
        ),
        Worker(
            workflow_env.client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[counted_legacy_success],
            max_concurrent_activities=1,
        ),
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[input_],
            id=f"wf_route_{mode}_{request_snapshot_id(request)}",
            task_queue="test",
        )
    return result, PYTHON_CALLS, LEGACY_CALLS


@pytest.mark.asyncio
@pytest.mark.parametrize(
    (
        "source_url",
        "mode",
        "python_activity",
        "expected_status",
        "expected_failure",
        "expected_python_calls",
        "expected_legacy_calls",
    ),
    [
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python_tiktok_with_legacy_fallback",
            counted_python_success,
            "succeeded",
            None,
            1,
            0,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python_tiktok_with_legacy_fallback",
            eligible_python_failure,
            "succeeded",
            None,
            1,
            1,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python_tiktok_with_legacy_fallback",
            cdn_unavailable_python_failure,
            "succeeded",
            None,
            1,
            1,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python_tiktok_with_legacy_fallback",
            unsafe_python_failure,
            "failed",
            "invalid_tiktok_url",
            1,
            0,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python_tiktok_with_legacy_fallback",
            acquisition_runner_python_failure,
            "failed",
            "acquisition_runner_failed",
            1,
            0,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python_tiktok_with_legacy_fallback",
            acquisition_dependency_python_failure,
            "failed",
            "acquisition_dependency_unavailable",
            1,
            0,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python_tiktok_with_legacy_fallback",
            artifact_persistence_python_failure,
            "failed",
            "artifact_persistence_failed",
            1,
            0,
        ),
        (
            "https://example.test/post",
            "python_tiktok_with_legacy_fallback",
            counted_python_success,
            "succeeded",
            None,
            0,
            1,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "python",
            eligible_python_failure,
            "failed",
            "headless_blocked",
            1,
            0,
        ),
        (
            "https://www.tiktok.com/@creator/video/1234567890",
            "legacy_scout",
            counted_python_success,
            "succeeded",
            None,
            0,
            1,
        ),
    ],
)
async def test_activity_mode_routing(
    workflow_env,
    source_url,
    mode,
    python_activity,
    expected_status,
    expected_failure,
    expected_python_calls,
    expected_legacy_calls,
):
    result, python_calls, legacy_calls = await run_routing_case(
        workflow_env,
        source_url=source_url,
        mode=mode,
        python_activity=python_activity,
    )
    assert result.status == expected_status
    assert (result.failure.code if result.failure is not None else None) == expected_failure
    assert python_calls == expected_python_calls
    assert legacy_calls == expected_legacy_calls


@pytest.mark.asyncio
async def test_gateway_connect_propagates_source_investigation_activity_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = object()

    async def fake_connect(*args: object, **kwargs: object) -> object:
        del args, kwargs
        return fake_client

    monkeypatch.setattr(temporal_gateway.Client, "connect", fake_connect)

    gateway = await TemporalWorkflowGateway.connect(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE="legacy_scout",
        )
    )

    assert gateway._activity_mode == "legacy_scout"


@pytest.mark.asyncio
async def test_temporal_outage_fails_readiness_without_failing_liveness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unavailable(cls: type[TemporalWorkflowGateway], settings: Settings) -> None:
        del cls, settings
        raise OSError("Temporal unavailable")

    monkeypatch.setattr(
        TemporalWorkflowGateway,
        "connect",
        classmethod(unavailable),
    )
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            health = await client.get("/healthz")
            readiness = await client.get("/readyz")

    assert health.status_code == 200
    assert readiness.status_code == 503


@activity.defn(name="inspect_source_candidates")
async def eligible_headless_failure_with_events(
    input_: SourceInvestigationActivityInput,
) -> SourceInvestigationActivityResult:
    del input_
    return SourceInvestigationActivityResult(
        failure=SafeActivityError(code="headless_blocked", retryable=True),
        events=[
            SourceProgressEvent(kind="stage.started", payload={"stage": "tiktok_headless"}),
            SourceProgressEvent(
                kind="stage.failed",
                payload={
                    "stage": "tiktok_headless",
                    "status": "failed",
                    "elapsed_ms": 120,
                    "reason": "headless_blocked",
                },
            ),
            SourceProgressEvent(
                kind="stage.completed",
                payload={
                    "stage": "tiktok_cleanup",
                    "status": "succeeded",
                    "partial_cleanup_passed": True,
                    "browser_cleanup_passed": True,
                },
            ),
        ],
    )


@activity.defn(name="inspect_legacy_scout")
async def legacy_success_two_events(
    input_: LegacyScoutInput,
) -> SourceInvestigationActivityResult:
    result = await fake_inspect(input_)
    return result.model_copy(
        update={
            "events": [
                SourceProgressEvent(kind="stage.started", payload={"stage": "source"}),
                SourceProgressEvent(kind="stage.completed", payload={"stage": "source"}),
            ]
        }
    )


def _tiktok_fallback_input(mode: str) -> SourceInvestigationWorkflowInput:
    request = VALID_IDENTIFY_REQUEST.model_copy(
        update={
            "source": VALID_IDENTIFY_REQUEST.source.model_copy(update={"url": CANONICAL_TIKTOK_URL})
        }
    )
    return workflow_input(request).model_copy(update={"activity_mode": mode})


async def run_fallback_case_and_query_events(
    workflow_env: WorkflowEnvironment,
) -> tuple[WorkflowSummary, list[SourceProgressEvent]]:
    workflow_id = "wf_fallback_history_001"
    async with (
        Worker(
            workflow_env.client,
            task_queue="test",
            workflows=[SourceInvestigationWorkflow],
            activities=[eligible_headless_failure_with_events],
        ),
        Worker(
            workflow_env.client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[legacy_success_two_events],
            max_concurrent_activities=1,
        ),
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[_tiktok_fallback_input("python_tiktok_with_legacy_fallback")],
            id=workflow_id,
            task_queue="test",
        )
        source_events = await workflow_env.client.get_workflow_handle(workflow_id).query(
            SourceInvestigationWorkflow.source_events
        )
    return result, source_events


async def run_mode_and_query_events(
    workflow_env: WorkflowEnvironment, mode: str
) -> tuple[WorkflowSummary, list[SourceProgressEvent]]:
    workflow_id = f"wf_mode_history_{mode}"
    async with (
        Worker(
            workflow_env.client,
            task_queue="test",
            workflows=[SourceInvestigationWorkflow],
            activities=[eligible_headless_failure_with_events],
        ),
        Worker(
            workflow_env.client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[legacy_success_two_events],
            max_concurrent_activities=1,
        ),
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[_tiktok_fallback_input(mode)],
            id=workflow_id,
            task_queue="test",
        )
        source_events = await workflow_env.client.get_workflow_handle(workflow_id).query(
            SourceInvestigationWorkflow.source_events
        )
    return result, source_events


async def run_ineligible_failure_and_query_events(
    workflow_env: WorkflowEnvironment,
) -> tuple[WorkflowSummary, list[SourceProgressEvent]]:
    workflow_id = "wf_ineligible_history_001"
    async with Worker(
        workflow_env.client,
        task_queue="test",
        workflows=[SourceInvestigationWorkflow],
        activities=[acquisition_runner_python_failure],
    ):
        result = await workflow_env.client.execute_workflow(
            SourceInvestigationWorkflow.run,
            args=[_tiktok_fallback_input("python_tiktok_with_legacy_fallback")],
            id=workflow_id,
            task_queue="test",
        )
        source_events = await workflow_env.client.get_workflow_handle(workflow_id).query(
            SourceInvestigationWorkflow.source_events
        )
    return result, source_events


@pytest.mark.asyncio
async def test_eligible_fallback_preserves_python_transition_and_legacy_events(
    workflow_env: WorkflowEnvironment,
) -> None:
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


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["python", "legacy_scout"])
async def test_non_fallback_modes_never_emit_transition(
    workflow_env: WorkflowEnvironment, mode: str
) -> None:
    _, source_events = await run_mode_and_query_events(workflow_env, mode)
    assert all(event.payload.get("stage") != "legacy_fallback" for event in source_events)


@pytest.mark.asyncio
async def test_ineligible_python_failure_does_not_emit_transition(
    workflow_env: WorkflowEnvironment,
) -> None:
    _, source_events = await run_ineligible_failure_and_query_events(workflow_env)
    assert all(event.payload.get("stage") != "legacy_fallback" for event in source_events)
