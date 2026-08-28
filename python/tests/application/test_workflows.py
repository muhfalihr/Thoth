import asyncio
from datetime import UTC, datetime

import pytest

from thoth_control_plane.application.workflows import (
    ApprovalSubmission,
    IdempotencyConflict,
    WorkflowService,
)
from thoth_control_plane.domain import Actor, StylePreset, WorkflowRequest, WorkflowSummary


class StartGateway:
    def __init__(self) -> None:
        self.start_calls = 0
        self.last_actor: Actor | None = None
        self.last_from_stage: str | None = None

    async def start(
        self,
        request: WorkflowRequest,
        *,
        actor: Actor,
        idempotency_key: str,
    ) -> WorkflowSummary:
        self.start_calls += 1
        self.last_actor = actor
        timestamp = datetime(2026, 8, 28, 8, tzinfo=UTC)
        return WorkflowSummary(
            workflow_id="wf_001",
            status="queued",
            created_at=timestamp,
            updated_at=timestamp,
            source={"display_url": request.source.url, "platform": "tiktok"},
            stages=[],
        )

    async def list_style_presets(self, *, actor: Actor) -> list[StylePreset]:
        return [
            StylePreset(
                preset_id="news-vertical",
                label="News vertical",
                description=f"Available to {actor.actor_id}",
            )
        ]

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        self.last_actor = actor
        timestamp = datetime(2026, 8, 28, 8, tzinfo=UTC)
        return WorkflowSummary(
            workflow_id=workflow_id,
            status="queued",
            created_at=timestamp,
            updated_at=timestamp,
            source={"display_url": "https://example.test/post", "platform": "tiktok"},
            stages=[],
        )

    async def cancel(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        self.last_actor = actor
        summary = await self.get(workflow_id, actor=actor)
        return summary.model_copy(update={"status": "cancelled"})

    async def retry(
        self,
        workflow_id: str,
        *,
        from_stage: str | None,
        actor: Actor,
    ) -> WorkflowSummary:
        self.last_from_stage = from_stage
        self.last_actor = actor
        return await self.get(workflow_id, actor=actor)

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary:
        self.last_actor = actor
        summary = await self.get(workflow_id, actor=actor)
        return summary.model_copy(update={"status": "running"})


class OverlappingStartGateway(StartGateway):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.entered = 0

    async def start(
        self,
        request: WorkflowRequest,
        *,
        actor: Actor,
        idempotency_key: str,
    ) -> WorkflowSummary:
        self.entered += 1
        call_number = self.entered
        self.started.set()
        await self.release.wait()
        summary = await super().start(
            request,
            actor=actor,
            idempotency_key=idempotency_key,
        )
        return summary.model_copy(update={"workflow_id": f"wf_{call_number:03d}"})


@pytest.mark.asyncio
async def test_start_reuses_a_matching_idempotency_key() -> None:
    gateway = StartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")
    request = WorkflowRequest.model_validate(
        {
            "source": {
                "url": "https://example.test/post",
                "intent": "identify_original",
            },
            "style": {"preset_id": "news-vertical"},
            "output": {"format": "vertical_video", "language": "id"},
            "review": {"require_publish_approval": True},
        }
    )

    first = await service.start(request, actor=actor, idempotency_key="create-001")
    second = await service.start(request, actor=actor, idempotency_key="create-001")

    assert second.workflow_id == first.workflow_id
    assert gateway.start_calls == 1


@pytest.mark.asyncio
async def test_concurrent_matching_starts_create_only_one_workflow() -> None:
    gateway = OverlappingStartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")
    request = WorkflowRequest.model_validate(
        {
            "source": {
                "url": "https://example.test/post",
                "intent": "identify_original",
            },
            "style": {"preset_id": "news-vertical"},
            "output": {"format": "vertical_video", "language": "id"},
            "review": {"require_publish_approval": True},
        }
    )

    first_task = asyncio.create_task(
        service.start(request, actor=actor, idempotency_key="create-001")
    )
    await gateway.started.wait()
    second_task = asyncio.create_task(
        service.start(request, actor=actor, idempotency_key="create-001")
    )
    await asyncio.sleep(0)
    gateway.release.set()

    first, second = await asyncio.gather(first_task, second_task)

    assert {first.workflow_id, second.workflow_id} == {"wf_001"}
    assert gateway.start_calls == 1


@pytest.mark.asyncio
async def test_concurrent_different_body_conflicts_without_a_second_start() -> None:
    gateway = OverlappingStartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")
    request = WorkflowRequest.model_validate(
        {
            "source": {
                "url": "https://example.test/post",
                "intent": "identify_original",
            },
            "style": {"preset_id": "news-vertical"},
            "output": {"format": "vertical_video", "language": "id"},
            "review": {"require_publish_approval": True},
        }
    )
    changed = request.model_copy(
        update={"output": request.output.model_copy(update={"language": "en"})}
    )

    first_task = asyncio.create_task(
        service.start(request, actor=actor, idempotency_key="create-001")
    )
    await gateway.started.wait()
    second_task = asyncio.create_task(
        service.start(changed, actor=actor, idempotency_key="create-001")
    )
    await asyncio.sleep(0)
    gateway.release.set()

    first, second = await asyncio.gather(first_task, second_task, return_exceptions=True)

    assert isinstance(first, WorkflowSummary)
    assert first.workflow_id == "wf_001"
    assert isinstance(second, IdempotencyConflict)
    assert gateway.start_calls == 1


@pytest.mark.asyncio
async def test_same_idempotency_key_with_a_different_body_conflicts() -> None:
    gateway = StartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")
    request = WorkflowRequest.model_validate(
        {
            "source": {
                "url": "https://example.test/post",
                "intent": "identify_original",
            },
            "style": {"preset_id": "news-vertical"},
            "output": {"format": "vertical_video", "language": "id"},
            "review": {"require_publish_approval": True},
        }
    )
    changed = request.model_copy(
        update={"output": request.output.model_copy(update={"language": "en"})}
    )
    await service.start(request, actor=actor, idempotency_key="create-001")

    with pytest.raises(IdempotencyConflict):
        await service.start(changed, actor=actor, idempotency_key="create-001")

    assert gateway.start_calls == 1


@pytest.mark.asyncio
async def test_style_presets_are_returned_for_the_current_actor() -> None:
    service = WorkflowService(StartGateway())
    actor = Actor(actor_id="owner", actor_type="user")

    presets = await service.list_style_presets(actor=actor)

    assert presets == [
        StylePreset(
            preset_id="news-vertical",
            label="News vertical",
            description="Available to owner",
        )
    ]


@pytest.mark.asyncio
async def test_get_returns_the_actor_authorized_workflow() -> None:
    gateway = StartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")

    summary = await service.get("wf_001", actor=actor)

    assert summary.workflow_id == "wf_001"
    assert gateway.last_actor == actor


@pytest.mark.asyncio
async def test_cancel_records_the_actor_and_returns_the_latest_summary() -> None:
    gateway = StartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")

    summary = await service.cancel("wf_001", actor=actor)

    assert summary.status == "cancelled"
    assert gateway.last_actor == actor


@pytest.mark.asyncio
async def test_retry_records_the_actor_and_requested_checkpoint() -> None:
    gateway = StartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")

    summary = await service.retry("wf_001", from_stage="source", actor=actor)

    assert summary.workflow_id == "wf_001"
    assert gateway.last_from_stage == "source"
    assert gateway.last_actor == actor


@pytest.mark.asyncio
async def test_record_approval_records_only_the_authenticated_actor() -> None:
    gateway = StartGateway()
    service = WorkflowService(gateway)
    actor = Actor(actor_id="owner", actor_type="user")
    approval = ApprovalSubmission(
        approval_id="apr_001",
        decision="approve",
        note="Continue",
    )

    summary = await service.record_approval("wf_001", approval, actor=actor)

    assert summary.status == "running"
    assert gateway.last_actor == actor
    assert "actor" not in approval.model_dump()
