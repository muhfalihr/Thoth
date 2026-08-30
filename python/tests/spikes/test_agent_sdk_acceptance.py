from __future__ import annotations

import asyncio
import importlib.util
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

import pytest

from spikes.agno_source_investigator import AgnoSourceInvestigator
from thoth_control_plane.application import ApprovalSubmission, WorkflowService
from thoth_control_plane.application.source_investigator import SourceInvestigatorInput
from thoth_control_plane.domain import (
    Actor,
    ApprovalRequest,
    EventKind,
    WorkflowEvent,
    WorkflowStatus,
    WorkflowSummary,
)

if importlib.util.find_spec("pydantic_ai") is not None:
    from spikes.pydanticai_source_investigator import PydanticAISourceInvestigator
else:
    PydanticAISourceInvestigator = None


READ_ONLY_TOOLS = {
    "inspect_source_candidates",
    "explain_source_choice",
    "request_next_stage",
}
FIXTURE_INPUT = SourceInvestigatorInput(
    workflow_id="wf_source_001",
    correlation_id="corr_source_001",
    candidate_ids=["candidate_vincentius", "candidate_repost"],
)
ACTOR = Actor(actor_id="reviewer_001", actor_type="user")


class Investigator(Protocol):
    tool_names: tuple[str, ...]
    last_context: dict[str, Any]

    async def explain(self, input: SourceInvestigatorInput): ...

    async def cancel(self) -> None: ...


AdapterFactory = Callable[["FixtureToolService"], Investigator]


class FixtureToolService:
    def __init__(self, *, block_inspection: bool = False) -> None:
        self.block_inspection = block_inspection
        self.inspection_started = asyncio.Event()
        self.release_inspection = asyncio.Event()
        self.activity_count = 0
        self.side_effect_count = 0
        self.events: list[WorkflowEvent] = []
        self.correlation_ids: list[str] = []

    async def inspect_source_candidates(
        self, workflow_id: str, correlation_id: str
    ) -> list[dict[str, object]]:
        self.activity_count += 1
        self.correlation_ids.append(correlation_id)
        self.events.append(
            WorkflowEvent(
                workflow_id=workflow_id,
                event_id="evt_agent_started",
                sequence=1,
                kind=EventKind.STAGE_STARTED,
                occurred_at=datetime(2026, 8, 30, 8, tzinfo=UTC),
                stage={"name": "source", "progress": 0.0},
            )
        )
        self.inspection_started.set()
        if self.block_inspection:
            await self.release_inspection.wait()
        return [
            {
                "candidate_id": "candidate_vincentius",
                "evidence_id": "evidence_timestamp_001",
                "summary": "Published 14 minutes before the repost.",
            },
            {
                "candidate_id": "candidate_repost",
                "evidence_id": "evidence_watermark_001",
                "summary": "Carries the first candidate's watermark.",
            },
        ]

    async def explain_source_choice(
        self, candidate_ids: list[str], correlation_id: str
    ) -> dict[str, object]:
        assert candidate_ids == ["candidate_vincentius", "candidate_repost"]
        self.correlation_ids.append(correlation_id)
        return {
            "candidate_id": "candidate_vincentius",
            "explanation": "The timestamp and watermark identify the original upload.",
            "citation": {
                "candidate_id": "candidate_vincentius",
                "evidence_id": "evidence_timestamp_001",
                "summary": "Published 14 minutes before the repost.",
            },
            "correlation_id": correlation_id,
        }

    async def request_next_stage(
        self, kind: str, evidence_ids: list[str], correlation_id: str
    ) -> dict[str, object]:
        self.correlation_ids.append(correlation_id)
        return {
            "kind": kind,
            "evidence_ids": evidence_ids,
            "correlation_id": correlation_id,
        }

    def perform_sensitive_activity(self) -> None:
        self.side_effect_count += 1


class DurableApprovalGateway:
    def __init__(self, state: dict[str, WorkflowSummary]) -> None:
        self.state = state
        self.record_count = 0

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        del actor
        return self.state[workflow_id]

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary:
        del actor
        self.record_count += 1
        current = self.state[workflow_id]
        updated = current.model_copy(update={"status": WorkflowStatus.RUNNING, "approval": None})
        self.state[workflow_id] = updated
        return updated


COMPARISON_ADAPTERS = [AgnoSourceInvestigator]
COMPARISON_IDS = ["agno"]
if PydanticAISourceInvestigator is not None:
    COMPARISON_ADAPTERS.append(PydanticAISourceInvestigator)
    COMPARISON_IDS.append("pydantic-ai")


@pytest.fixture(params=COMPARISON_ADAPTERS, ids=COMPARISON_IDS)
def adapter_factory(request: pytest.FixtureRequest) -> AdapterFactory:
    return request.param


@pytest.mark.asyncio
async def test_cited_explanation_uses_only_three_read_only_tools(
    adapter_factory: AdapterFactory,
) -> None:
    tools = FixtureToolService()
    investigator = adapter_factory(tools)

    result = await investigator.explain(FIXTURE_INPUT)

    assert result.candidate_id == "candidate_vincentius"
    assert [citation.evidence_id for citation in result.citations] == ["evidence_timestamp_001"]
    assert set(investigator.tool_names) == READ_ONLY_TOOLS
    assert len(investigator.tool_names) == 3
    assert set(result.executed_tools) == READ_ONLY_TOOLS


@pytest.mark.asyncio
async def test_no_side_effect_occurs_before_server_side_approval(
    adapter_factory: AdapterFactory,
) -> None:
    tools = FixtureToolService()
    investigator = adapter_factory(tools)

    result = await investigator.explain(FIXTURE_INPUT)

    assert result.proposed_approval.kind == "continue_to_acquisition"
    assert tools.side_effect_count == 0
    assert not hasattr(investigator, "record_approval")


@pytest.mark.asyncio
async def test_pause_restart_resume_records_one_authorized_decision_without_duplicate_activity(
    adapter_factory: AdapterFactory,
) -> None:
    tools = FixtureToolService()
    first_worker = adapter_factory(tools)
    explanation = await first_worker.explain(FIXTURE_INPUT)
    timestamp = datetime(2026, 8, 30, 8, tzinfo=UTC)
    state = {
        FIXTURE_INPUT.workflow_id: WorkflowSummary(
            workflow_id=FIXTURE_INPUT.workflow_id,
            status=WorkflowStatus.AWAITING_APPROVAL,
            created_at=timestamp,
            updated_at=timestamp,
            source={"display_url": "https://example.test/post", "platform": "example"},
            stages=[],
            approval=ApprovalRequest(
                approval_id="approval_source_001",
                kind=explanation.proposed_approval.kind,
                prompt="Continue to acquisition?",
                allowed_decisions=["approve", "reject"],
            ),
        )
    }

    restarted_worker = adapter_factory(tools)
    gateway = DurableApprovalGateway(state)
    service = WorkflowService(gateway)
    resumed = await service.record_approval(
        FIXTURE_INPUT.workflow_id,
        ApprovalSubmission(approval_id="approval_source_001", decision="approve"),
        actor=ACTOR,
    )

    assert restarted_worker is not first_worker
    assert resumed.status == WorkflowStatus.RUNNING
    assert gateway.record_count == 1
    assert tools.activity_count == 1


@pytest.mark.asyncio
async def test_cancellation_interrupts_a_blocking_read_only_tool(
    adapter_factory: AdapterFactory,
) -> None:
    tools = FixtureToolService(block_inspection=True)
    investigator = adapter_factory(tools)
    task = asyncio.create_task(investigator.explain(FIXTURE_INPUT))
    await asyncio.wait_for(tools.inspection_started.wait(), timeout=1)

    await investigator.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert tools.side_effect_count == 0


@pytest.mark.asyncio
async def test_adapter_emits_typed_dashboard_events(adapter_factory: AdapterFactory) -> None:
    tools = FixtureToolService()
    investigator = adapter_factory(tools)

    await investigator.explain(FIXTURE_INPUT)

    assert tools.events
    assert all(isinstance(event, WorkflowEvent) for event in tools.events)
    assert tools.events[0].kind == EventKind.STAGE_STARTED


@pytest.mark.asyncio
async def test_correlation_is_preserved_and_sensitive_context_is_absent(
    adapter_factory: AdapterFactory,
) -> None:
    tools = FixtureToolService()
    investigator = adapter_factory(tools)

    result = await investigator.explain(FIXTURE_INPUT)

    assert result.correlation_id == "corr_source_001"
    assert tools.correlation_ids == ["corr_source_001"] * 3
    assert investigator.last_context["correlation_id"] == "corr_source_001"
    serialized = str(investigator.last_context).lower()
    assert "cookie" not in serialized
    assert "credential" not in serialized
    assert "media_bytes" not in serialized
