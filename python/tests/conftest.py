from datetime import UTC, datetime

import httpx
import pytest
import pytest_asyncio

from thoth_control_plane.api.app import create_app
from thoth_control_plane.application import (
    ApprovalNotAllowed,
    ApprovalSubmission,
    WorkflowNotFound,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import (
    Actor,
    StylePreset,
    WorkflowRequest,
    WorkflowStatus,
    WorkflowSummary,
)


class InMemoryWorkflowGateway:
    def __init__(self) -> None:
        self.workflows: dict[str, WorkflowSummary] = {}
        self.actors: list[Actor] = []
        self.connection_available = True
        self.last_from_stage: str | None = None
        self.last_approval: ApprovalSubmission | None = None
        self.approval_allowed = True

    def _workflow(self, workflow_id: str) -> WorkflowSummary:
        try:
            return self.workflows[workflow_id]
        except KeyError as exc:
            raise WorkflowNotFound from exc

    async def check_connection(self) -> bool:
        return self.connection_available

    async def list_style_presets(self, *, actor: Actor) -> list[StylePreset]:
        self.actors.append(actor)
        return [
            StylePreset(
                preset_id="news-vertical",
                label="News vertical",
                description="Fast-paced vertical news treatment",
            )
        ]

    async def start(
        self,
        request: WorkflowRequest,
        *,
        actor: Actor,
        idempotency_key: str,
    ) -> WorkflowSummary:
        self.actors.append(actor)
        timestamp = datetime(2026, 8, 28, 8, tzinfo=UTC)
        summary = WorkflowSummary(
            workflow_id="wf_001",
            status="queued",
            created_at=timestamp,
            updated_at=timestamp,
            source={"display_url": request.source.url, "platform": "tiktok"},
            stages=[],
        )
        self.workflows[summary.workflow_id] = summary
        return summary

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        self.actors.append(actor)
        return self._workflow(workflow_id)

    async def cancel(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        self.actors.append(actor)
        summary = self._workflow(workflow_id).model_copy(
            update={"status": WorkflowStatus.CANCELLED}
        )
        self.workflows[workflow_id] = summary
        return summary

    async def retry(
        self,
        workflow_id: str,
        *,
        from_stage: str | None,
        actor: Actor,
    ) -> WorkflowSummary:
        self.actors.append(actor)
        self.last_from_stage = from_stage
        summary = self._workflow(workflow_id).model_copy(update={"status": WorkflowStatus.QUEUED})
        self.workflows[workflow_id] = summary
        return summary

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary:
        self.actors.append(actor)
        if not self.approval_allowed:
            raise ApprovalNotAllowed
        self.last_approval = approval
        summary = self._workflow(workflow_id).model_copy(update={"status": WorkflowStatus.RUNNING})
        self.workflows[workflow_id] = summary
        return summary


@pytest.fixture
def gateway() -> InMemoryWorkflowGateway:
    return InMemoryWorkflowGateway()


@pytest_asyncio.fixture
async def client(gateway: InMemoryWorkflowGateway):
    settings = Settings(THOTH_CONTROL_PLANE_API_KEY="test-key")
    app = create_app(settings, gateway)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as test_client:
        yield test_client
