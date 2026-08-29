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

from thoth_control_plane.api.app import create_app
from thoth_control_plane.application import WorkflowNotFound
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import (
    Actor,
    ActorSnapshot,
    ApprovalDecision,
    ApprovalSignal,
    SourceInvestigationResult,
    WorkflowRequest,
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


@activity.defn(name="inspect_source_candidates")
async def fake_inspect(input_: object) -> SourceInvestigationResult:
    del input_
    return SourceInvestigationResult.model_validate(
        {
            "candidates": [
                {
                    "candidate_id": "candidate_001",
                    "citation": "Safe public citation; raw provider payload is not returned.",
                    "score": 0.94,
                }
            ],
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


FAILING_ACTIVITY_ATTEMPTS = 0


@activity.defn(name="inspect_source_candidates")
async def failing_inspect(input_: object) -> SourceInvestigationResult:
    del input_
    global FAILING_ACTIVITY_ATTEMPTS
    FAILING_ACTIVITY_ATTEMPTS += 1
    raise RuntimeError("provider token and raw payload must not escape")


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
            args=[VALID_IDENTIFY_REQUEST, ACTOR_SNAPSHOT],
            id="wf_test_report",
            task_queue="test",
        )

    assert result.status == "succeeded"
    assert result.artifacts[0].kind == "source_report"
    assert "signature" not in str(result.model_dump(mode="json"))
    assert "candidate_001" not in str(result.model_dump(mode="json"))


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
            args=[VALID_PRODUCE_REQUEST, ACTOR_SNAPSHOT],
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
            args=[VALID_PRODUCE_REQUEST, ACTOR_SNAPSHOT],
            id="wf_test_cancel",
            task_queue="test",
        )
        await wait_for_status(handle, "awaiting_approval")
        await handle.signal(SourceInvestigationWorkflow.request_cancel)
        result = await handle.result()

    assert result.status == "cancelled"
    assert result.approval is None


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
            args=[VALID_IDENTIFY_REQUEST, ACTOR_SNAPSHOT],
            id="wf_test_safe_failure",
            task_queue="test",
        )

    assert FAILING_ACTIVITY_ATTEMPTS == 3
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
        with pytest.raises(WorkflowNotFound):
            await gateway.get(
                first.workflow_id,
                actor=Actor(actor_id="outsider", actor_type="user"),
            )


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
