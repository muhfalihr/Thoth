"""Typed outbound ports for workflow orchestration."""

from collections.abc import AsyncIterator
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from thoth_control_plane.domain import (
    Actor,
    StylePreset,
    WorkflowEvent,
    WorkflowRequest,
    WorkflowSummary,
)


class ApprovalSubmission(BaseModel):
    """An approval decision supplied by a caller, before actor audit data is added."""

    model_config = ConfigDict(extra="forbid", strict=True)
    approval_id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=2_000)


class RetryRequest(BaseModel):
    """Optional validated checkpoint for an explicit workflow retry."""

    model_config = ConfigDict(extra="forbid", strict=True)
    from_stage: (
        Literal[
            "validation",
            "source",
            "assets",
            "narration",
            "render",
            "review",
            "delivery",
        ]
        | None
    ) = None


class WorkflowGateway(Protocol):
    """Orchestration operations required by the application service."""

    async def check_connection(self) -> bool: ...
    async def list_style_presets(self, *, actor: Actor) -> list[StylePreset]: ...

    async def start(
        self,
        request: WorkflowRequest,
        *,
        actor: Actor,
        idempotency_key: str,
    ) -> WorkflowSummary: ...

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary: ...

    def stream_events(
        self, workflow_id: str, *, actor: Actor, after_sequence: int
    ) -> AsyncIterator[WorkflowEvent]: ...

    async def cancel(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary: ...

    async def retry(
        self,
        workflow_id: str,
        *,
        from_stage: str | None,
        actor: Actor,
    ) -> WorkflowSummary: ...

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary: ...
