"""Temporal implementation of the workflow lifecycle gateway."""

from __future__ import annotations

from contextlib import suppress
from datetime import UTC, datetime
from hashlib import sha256

from temporalio.client import Client, WorkflowHandle
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from thoth_control_plane.application import (
    ApprovalNotAllowed,
    ApprovalSubmission,
    WorkflowNotFound,
    WorkflowNotReady,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import (
    Actor,
    ActorSnapshot,
    ApprovalDecision,
    ApprovalSignal,
    SourceInvestigationWorkflowInput,
    StylePreset,
    WorkflowRequest,
    WorkflowSummary,
    request_snapshot_id,
    safe_workflow_source,
)
from thoth_control_plane.workflows.source_investigation import SourceInvestigationWorkflow

TASK_QUEUE = "thoth-control-plane"


class TemporalWorkflowGateway:
    """Run application lifecycle operations against durable Temporal state."""

    def __init__(self, client: Client) -> None:
        self._client = client

    @classmethod
    async def connect(cls, settings: Settings) -> TemporalWorkflowGateway:
        client = await Client.connect(
            settings.THOTH_TEMPORAL_TARGET,
            namespace=settings.THOTH_TEMPORAL_NAMESPACE,
            data_converter=pydantic_data_converter,
        )
        return cls(client)

    async def check_connection(self) -> bool:
        try:
            return await self._client.service_client.check_health()
        except RPCError:
            return False

    async def list_style_presets(self, *, actor: Actor) -> list[StylePreset]:
        del actor
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
        workflow_id = _workflow_id(actor.actor_type, actor.actor_id, idempotency_key)
        requested_snapshot_id = request_snapshot_id(request)
        with suppress(WorkflowAlreadyStartedError):
            await self._client.start_workflow(
                SourceInvestigationWorkflow.run,
                args=[
                    SourceInvestigationWorkflowInput(
                        request_snapshot_id=requested_snapshot_id,
                        source=safe_workflow_source(request),
                        intent=request.source.intent,
                        actor=ActorSnapshot.model_validate(actor.model_dump()),
                    )
                ],
                id=workflow_id,
                task_queue=TASK_QUEUE,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
                memo={
                    "idempotency_key": idempotency_key,
                    "request_snapshot_id": requested_snapshot_id,
                },
            )

        handle = await self._authorized_handle(workflow_id, actor)
        existing_snapshot_id = await handle.query(SourceInvestigationWorkflow.request_snapshot_id)
        if existing_snapshot_id != requested_snapshot_id:
            from thoth_control_plane.application import IdempotencyConflict

            raise IdempotencyConflict
        return await handle.query(SourceInvestigationWorkflow.summary)

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        handle = await self._authorized_handle(workflow_id, actor)
        try:
            return await handle.query(SourceInvestigationWorkflow.summary)
        except RPCError as error:
            raise _mapped_rpc_error(error) from error

    async def cancel(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        handle = await self._authorized_handle(workflow_id, actor)
        await handle.signal(SourceInvestigationWorkflow.request_cancel)
        return await handle.query(SourceInvestigationWorkflow.summary)

    async def retry(
        self,
        workflow_id: str,
        *,
        from_stage: str | None,
        actor: Actor,
    ) -> WorkflowSummary:
        del workflow_id, from_stage, actor
        raise WorkflowNotReady("Durable workflow retry is not available")

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary:
        handle = await self._authorized_handle(workflow_id, actor)
        current = await handle.query(SourceInvestigationWorkflow.summary)
        if (
            current.approval is None
            or current.approval.approval_id != approval.approval_id
            or approval.decision not in current.approval.allowed_decisions
        ):
            raise ApprovalNotAllowed
        await handle.signal(
            SourceInvestigationWorkflow.record_approval,
            ApprovalSignal(
                approval_id=approval.approval_id,
                decision=ApprovalDecision(decision=approval.decision, note=approval.note),
                actor=ActorSnapshot.model_validate(actor.model_dump()),
                decided_at=datetime.now(UTC),
            ),
        )
        return await handle.query(SourceInvestigationWorkflow.summary)

    async def _authorized_handle(
        self, workflow_id: str, actor: Actor
    ) -> WorkflowHandle[WorkflowSummary]:
        handle: WorkflowHandle[WorkflowSummary] = self._client.get_workflow_handle(workflow_id)
        try:
            owner_actor = await handle.query(SourceInvestigationWorkflow.owner_actor)
        except RPCError as error:
            raise _mapped_rpc_error(error) from error
        if owner_actor.actor_id != actor.actor_id or owner_actor.actor_type != actor.actor_type:
            raise WorkflowNotFound
        return handle


def _workflow_id(actor_type: str, actor_id: str, idempotency_key: str) -> str:
    digest = sha256(f"{actor_type}\0{actor_id}\0{idempotency_key}".encode()).hexdigest()
    return f"wf_{digest[:24]}"


def _mapped_rpc_error(error: RPCError) -> Exception:
    if error.status == RPCStatusCode.NOT_FOUND:
        return WorkflowNotFound()
    return WorkflowNotReady()
