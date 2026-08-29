"""Durability tests for the source-investigation workflow."""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from thoth_control_plane.activities.legacy_scout import LEGACY_ADAPTER_TASK_QUEUE, LegacyScoutInput
from thoth_control_plane.activities.source_investigation import (
    SourceInvestigationActivityInput,
    inspect_source_candidates,
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
    SourceInvestigationActivityResult,
    SourceInvestigationWorkflowInput,
    WorkflowRequest,
    WorkflowSummary,
    request_snapshot_id,
    safe_workflow_source,
)
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
    return await fake_inspect(input_)


FAILING_ACTIVITY_ATTEMPTS = 0
CANCELLING_ACTIVITY_RELEASE: asyncio.Event | None = None
LEGACY_ACTIVITY_STARTED: asyncio.Event | None = None
LEGACY_ACTIVITY_CANCELLED: asyncio.Event | None = None


@activity.defn(name="inspect_source_candidates")
async def failing_inspect(input_: object) -> SourceInvestigationActivityResult:
    del input_
    global FAILING_ACTIVITY_ATTEMPTS
    FAILING_ACTIVITY_ATTEMPTS += 1
    return SourceInvestigationActivityResult(
        failure={"code": "source_investigation_failed", "retryable": True}
    )


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


@pytest.mark.asyncio
async def test_source_investigation_activity_materializes_its_report(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    from thoth_control_plane.activities import source_investigation

    monkeypatch.setattr(source_investigation, "ARTIFACT_ROOT", tmp_path)
    result = await inspect_source_candidates(
        SourceInvestigationActivityInput(
            workflow_id="wf_materialized",
            request_snapshot_id="req_materialized",
        )
    )

    assert result.report is not None
    report = tmp_path / result.report.location
    assert report.is_file()
    assert "req_materialized" in report.read_text(encoding="utf-8")


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
