"""Deterministic durable source-investigation workflow."""

from __future__ import annotations

import re
from datetime import timedelta
from hashlib import sha256
from urllib.parse import urlsplit, urlunsplit

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from thoth_control_plane.activities.source_investigation import (
        SourceInvestigationActivityInput,
        inspect_source_candidates,
    )
    from thoth_control_plane.domain import (
        ActorSnapshot,
        ApprovalRequest,
        ApprovalSignal,
        ArtifactRef,
        WorkflowFailure,
        WorkflowRequest,
        WorkflowStatus,
        WorkflowSummary,
    )
    from thoth_control_plane.domain.models import StageSummary


@workflow.defn
class SourceInvestigationWorkflow:
    """Investigate a source, then durably gate acquisition when requested."""

    def __init__(self) -> None:
        self._workflow_id = "wf_uninitialized"
        self._request_snapshot_id = "req_uninitialized"
        self._actor_id = "actor_uninitialized"
        self._actor_type = "user"
        self._status = WorkflowStatus.QUEUED
        self._created_at = None
        self._updated_at = None
        self._source = None
        self._artifacts: list[ArtifactRef] = []
        self._approval: ApprovalRequest | None = None
        self._approval_decision: str | None = None
        self._cancel_requested = False
        self._failure: WorkflowFailure | None = None
        self._event_sequence = 0

    @workflow.run
    async def run(self, request: WorkflowRequest, actor: ActorSnapshot) -> WorkflowSummary:
        self._workflow_id = workflow.info().workflow_id
        self._request_snapshot_id = _request_snapshot_id(request)
        self._actor_id = actor.actor_id
        self._actor_type = actor.actor_type
        self._created_at = workflow.now()
        self._updated_at = self._created_at
        self._source = _safe_source(request)
        self._transition(WorkflowStatus.RUNNING)

        try:
            result = await workflow.execute_activity(
                inspect_source_candidates,
                SourceInvestigationActivityInput(
                    request=request,
                    workflow_id=self._workflow_id,
                ),
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except ActivityError:
            self._failure = WorkflowFailure(
                code="source_investigation_failed",
                message="Source investigation failed",
                failed_stage="source",
                retryable=True,
            )
            self._transition(WorkflowStatus.FAILED)
            return self._summary()

        self._artifacts = [result.report]
        self._event_sequence += 1
        self._updated_at = workflow.now()

        if self._cancel_requested:
            self._transition(WorkflowStatus.CANCELLED)
            return self._summary()

        if request.source.intent == "identify_original":
            self._transition(WorkflowStatus.SUCCEEDED)
            return self._summary()

        self._approval = ApprovalRequest(
            approval_id=_approval_id(self._workflow_id),
            kind="continue_to_acquisition",
            prompt="Continue to acquisition?",
            allowed_decisions=["approve", "reject"],
        )
        self._transition(WorkflowStatus.AWAITING_APPROVAL)
        await workflow.wait_condition(
            lambda: self._cancel_requested or self._approval_decision is not None
        )

        if self._cancel_requested:
            self._approval = None
            self._transition(WorkflowStatus.CANCELLED)
        elif self._approval_decision == "approve":
            self._approval = None
            self._transition(WorkflowStatus.SUCCEEDED)
        else:
            self._approval = None
            self._failure = WorkflowFailure(
                code="approval_rejected",
                message="Acquisition approval was rejected",
                failed_stage="source",
                retryable=False,
            )
            self._transition(WorkflowStatus.FAILED)
        return self._summary()

    @workflow.signal
    def request_cancel(self) -> None:
        if self._status not in {
            WorkflowStatus.SUCCEEDED,
            WorkflowStatus.FAILED,
            WorkflowStatus.CANCELLED,
        }:
            self._cancel_requested = True

    @workflow.signal
    def record_approval(self, signal: ApprovalSignal) -> None:
        approval = self._approval
        if (
            self._status != WorkflowStatus.AWAITING_APPROVAL
            or approval is None
            or signal.approval_id != approval.approval_id
            or signal.decision.decision not in approval.allowed_decisions
            or signal.actor.actor_id != self._actor_id
            or signal.actor.actor_type != self._actor_type
            or self._approval_decision is not None
        ):
            return
        self._approval_decision = signal.decision.decision
        self._event_sequence += 1
        self._updated_at = workflow.now()

    @workflow.query
    def summary(self) -> WorkflowSummary:
        return self._summary()

    @workflow.query
    def owner_actor_id(self) -> str:
        return self._actor_id

    @workflow.query
    def request_snapshot_id(self) -> str:
        return self._request_snapshot_id

    def _transition(self, status: WorkflowStatus) -> None:
        self._status = status
        self._event_sequence += 1
        self._updated_at = workflow.now()

    def _summary(self) -> WorkflowSummary:
        if self._created_at is None or self._updated_at is None or self._source is None:
            raise RuntimeError("workflow has not started")
        stage_status = {
            WorkflowStatus.QUEUED: "queued",
            WorkflowStatus.RUNNING: "running",
            WorkflowStatus.AWAITING_APPROVAL: "waiting",
            WorkflowStatus.SUCCEEDED: "completed",
            WorkflowStatus.FAILED: "failed",
            WorkflowStatus.CANCELLED: "cancelled",
        }[self._status]
        return WorkflowSummary(
            workflow_id=self._workflow_id,
            status=self._status,
            created_at=self._created_at,
            updated_at=self._updated_at,
            source=self._source,
            stages=[
                StageSummary(
                    id="source",
                    label="Investigate original source",
                    status=stage_status,
                    progress=1.0 if self._artifacts else None,
                )
            ],
            artifacts=list(self._artifacts),
            approval=self._approval,
            failure=self._failure,
        )


def _request_snapshot_id(request: WorkflowRequest) -> str:
    digest = sha256(request.model_dump_json().encode()).hexdigest()
    return f"req_{digest[:24]}"


def _approval_id(workflow_id: str) -> str:
    digest = sha256(workflow_id.encode()).hexdigest()
    return f"apr_{digest[:24]}"


def _safe_source(request: WorkflowRequest) -> dict[str, str]:
    parsed = urlsplit(str(request.source.url))
    display_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    labels = (parsed.hostname or "unknown").lower().split(".")
    platform = labels[-2] if len(labels) > 1 else labels[0]
    platform = re.sub(r"[^a-z0-9_]", "_", platform).strip("_") or "unknown"
    return {"display_url": display_url, "platform": platform}
