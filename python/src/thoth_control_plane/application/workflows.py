"""Workflow lifecycle application service."""

from asyncio import Lock

from thoth_control_plane.application.ports import ApprovalSubmission, WorkflowGateway
from thoth_control_plane.domain import Actor, StylePreset, WorkflowRequest, WorkflowSummary


class WorkflowApplicationError(Exception):
    """Base class for stable workflow application failures."""

    default_detail = "Workflow operation failed"

    def __str__(self) -> str:
        return super().__str__() or self.default_detail


class IdempotencyConflict(WorkflowApplicationError):
    """An idempotency key was reused for a different request body."""

    default_detail = "Idempotency key was already used for a different request"


class WorkflowNotReady(WorkflowApplicationError):
    """No production workflow gateway is ready to serve the operation."""

    default_detail = "Workflow gateway is not ready"


class WorkflowNotFound(WorkflowApplicationError):
    """The requested workflow is absent or not visible to the actor."""

    default_detail = "Workflow not found"


class ApprovalNotAllowed(WorkflowApplicationError):
    """The approval does not match the workflow's active decision point."""

    default_detail = "Approval is not allowed"


class UnavailableWorkflowGateway:
    """Non-state-changing production placeholder used until orchestration is bound."""

    async def list_style_presets(self, *, actor: Actor) -> list[StylePreset]:
        raise WorkflowNotReady

    async def start(
        self,
        request: WorkflowRequest,
        *,
        actor: Actor,
        idempotency_key: str,
    ) -> WorkflowSummary:
        raise WorkflowNotReady

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        raise WorkflowNotReady

    async def cancel(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        raise WorkflowNotReady

    async def retry(
        self,
        workflow_id: str,
        *,
        from_stage: str | None,
        actor: Actor,
    ) -> WorkflowSummary:
        raise WorkflowNotReady

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary:
        raise WorkflowNotReady


class WorkflowService:
    """Coordinate workflow lifecycle calls across a typed gateway boundary."""

    def __init__(self, gateway: WorkflowGateway) -> None:
        self._gateway = gateway
        self._starts: dict[tuple[str, str, str], tuple[str, WorkflowSummary]] = {}
        self._start_locks: dict[tuple[str, str, str], Lock] = {}

    async def list_style_presets(self, *, actor: Actor) -> list[StylePreset]:
        return await self._gateway.list_style_presets(actor=actor)

    async def start(
        self,
        request: WorkflowRequest,
        *,
        actor: Actor,
        idempotency_key: str,
    ) -> WorkflowSummary:
        cache_key = (actor.actor_type, actor.actor_id, idempotency_key)
        fingerprint = request.model_dump_json()
        lock = self._start_locks.setdefault(cache_key, Lock())
        async with lock:
            cached = self._starts.get(cache_key)
            if cached is not None:
                if cached[0] != fingerprint:
                    raise IdempotencyConflict
                return cached[1]

            summary = await self._gateway.start(
                request,
                actor=actor,
                idempotency_key=idempotency_key,
            )
            self._starts[cache_key] = (fingerprint, summary)
            return summary

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        return await self._gateway.get(workflow_id, actor=actor)

    async def cancel(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        await self._gateway.get(workflow_id, actor=actor)
        return await self._gateway.cancel(workflow_id, actor=actor)

    async def retry(
        self,
        workflow_id: str,
        *,
        from_stage: str | None,
        actor: Actor,
    ) -> WorkflowSummary:
        return await self._gateway.retry(
            workflow_id,
            from_stage=from_stage,
            actor=actor,
        )

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary:
        current = await self._gateway.get(workflow_id, actor=actor)
        if current.approval is not None and (
            current.approval.approval_id != approval.approval_id
            or approval.decision not in current.approval.allowed_decisions
        ):
            raise ApprovalNotAllowed
        return await self._gateway.record_approval(
            workflow_id,
            approval,
            actor=actor,
        )
