"""Deterministic durable source-investigation workflow."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import timedelta
from hashlib import sha256

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    import annotated_types

    del annotated_types

    from thoth_control_plane.activities.legacy_scout import (
        LEGACY_ADAPTER_TASK_QUEUE,
        LegacyScoutInput,
        inspect_legacy_scout,
    )
    from thoth_control_plane.activities.source_investigation import (
        SourceInvestigationActivityInput,
        inspect_source_candidates,
    )
    from thoth_control_plane.domain import (
        ActorSnapshot,
        ApprovalRequest,
        ApprovalSignal,
        ArtifactRef,
        EventKind,
        SourceInvestigationActivityResult,
        SourceInvestigationWorkflowInput,
        WorkflowEvent,
        WorkflowFailure,
        WorkflowStatus,
        WorkflowSummary,
    )
    from thoth_control_plane.domain.models import (
        LEGACY_FALLBACK_ELIGIBLE_CODES,
        LegacyScoutProgressEvent,
        SourceProgressEvent,
        StageProgress,
        StageSummary,
    )

# `LEGACY_FALLBACK_ELIGIBLE_CODES` is domain-owned (see
# `thoth_control_plane.domain.models`) so the workflow's routing and the
# payload validator that guards `fallback_from` can never drift apart.


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
        self._source_events: list[LegacyScoutProgressEvent] = []
        self._event_sequence = 0
        self._workflow_events: list[WorkflowEvent] = []

    @workflow.run
    async def run(self, input_: SourceInvestigationWorkflowInput) -> WorkflowSummary:
        self._workflow_id = workflow.info().workflow_id
        self._request_snapshot_id = input_.request_snapshot_id
        self._actor_id = input_.actor.actor_id
        self._actor_type = input_.actor.actor_type
        self._created_at = workflow.now()
        self._updated_at = self._created_at
        self._source = input_.source
        self._record_event(EventKind.WORKFLOW_QUEUED)
        self._transition(WorkflowStatus.RUNNING)
        self._record_event(EventKind.WORKFLOW_STARTED)
        self._record_event(
            EventKind.STAGE_STARTED,
            stage=StageProgress(name="source", progress=0.0),
        )

        try:
            activity_task = asyncio.create_task(self._execute_source_activity(input_))
            await workflow.wait_condition(lambda: self._cancel_requested or activity_task.done())
            if self._cancel_requested:
                activity_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await activity_task
                self._transition(WorkflowStatus.CANCELLED)
                self._record_event(EventKind.WORKFLOW_CANCELLED)
                return self._summary()
            result = await activity_task
        except ActivityError:
            if self._cancel_requested:
                self._transition(WorkflowStatus.CANCELLED)
                self._record_event(EventKind.WORKFLOW_CANCELLED)
                return self._summary()
            self._failure = WorkflowFailure(
                code="source_investigation_failed",
                message="Source investigation failed",
                failed_stage="source",
                retryable=True,
            )
            self._transition(WorkflowStatus.FAILED)
            self._record_event(EventKind.WORKFLOW_FAILED)
            return self._summary()

        self._source_events = list(result.events)
        self._event_sequence += len(self._source_events)

        if result.failure is not None:
            if self._cancel_requested:
                self._transition(WorkflowStatus.CANCELLED)
                self._record_event(EventKind.WORKFLOW_CANCELLED)
                return self._summary()
            self._failure = WorkflowFailure(
                code=result.failure.code,
                message="Source investigation failed",
                failed_stage="source",
                retryable=result.failure.retryable,
            )
            self._transition(WorkflowStatus.FAILED)
            self._record_event(EventKind.WORKFLOW_FAILED)
            return self._summary()

        if result.report is None:
            self._failure = WorkflowFailure(
                code="source_investigation_failed",
                message="Source investigation failed",
                failed_stage="source",
                retryable=False,
            )
            self._transition(WorkflowStatus.FAILED)
            self._record_event(EventKind.WORKFLOW_FAILED)
            return self._summary()

        self._record_event(
            EventKind.STAGE_COMPLETED,
            stage=StageProgress(name="source", progress=1.0),
        )
        self._artifacts = [result.report]
        self._record_event(EventKind.ARTIFACT_CREATED, artifact=result.report)
        self._event_sequence += 1
        self._updated_at = workflow.now()

        if self._cancel_requested:
            self._transition(WorkflowStatus.CANCELLED)
            self._record_event(EventKind.WORKFLOW_CANCELLED)
            return self._summary()

        if input_.intent == "identify_original":
            self._transition(WorkflowStatus.SUCCEEDED)
            self._record_event(EventKind.WORKFLOW_COMPLETED)
            return self._summary()

        self._approval = ApprovalRequest(
            approval_id=_approval_id(self._workflow_id),
            kind="continue_to_acquisition",
            prompt="Continue to acquisition?",
            allowed_decisions=["approve", "reject"],
        )
        self._transition(WorkflowStatus.AWAITING_APPROVAL)
        self._record_event(EventKind.APPROVAL_REQUIRED)
        await workflow.wait_condition(
            lambda: self._cancel_requested or self._approval_decision is not None
        )

        if self._cancel_requested:
            self._approval = None
            self._transition(WorkflowStatus.CANCELLED)
            self._record_event(EventKind.WORKFLOW_CANCELLED)
        elif self._approval_decision == "approve":
            self._approval = None
            self._transition(WorkflowStatus.SUCCEEDED)
            self._record_event(EventKind.WORKFLOW_COMPLETED)
        else:
            self._approval = None
            self._failure = WorkflowFailure(
                code="approval_rejected",
                message="Acquisition approval was rejected",
                failed_stage="source",
                retryable=False,
            )
            self._transition(WorkflowStatus.FAILED)
            self._record_event(EventKind.WORKFLOW_FAILED)
        return self._summary()

    async def _execute_source_activity(
        self, input_: SourceInvestigationWorkflowInput
    ) -> SourceInvestigationActivityResult:
        """Route deterministically between the Python activity and legacy Scout.

        Fallback eligibility is a frozen, closed allowlist
        (`LEGACY_FALLBACK_ELIGIBLE_CODES`): unsafe input, dependency,
        configuration, and artifact failures never invoke legacy. When a
        fallback fires, the Python evidence trail is preserved ahead of
        exactly one `legacy_fallback` transition event, then the legacy
        activity's own events, so the ordered history is always
        `python events -> one fallback transition -> legacy events`. The
        transition is recorded on `self._source_events` before awaiting the
        legacy activity, so a query can still retrieve the Python and
        transition evidence if the legacy activity itself raises.
        """
        if input_.activity_mode == "legacy_scout":
            return await self._execute_legacy_activity(input_)
        if (
            input_.activity_mode == "python_tiktok_with_legacy_fallback"
            and input_.source.platform != "tiktok"
        ):
            return await self._execute_legacy_activity(input_)
        result = await self._execute_python_activity(input_)
        if (
            input_.activity_mode == "python_tiktok_with_legacy_fallback"
            and result.failure is not None
            and result.failure.code in LEGACY_FALLBACK_ELIGIBLE_CODES
        ):
            python_events = list(result.events)
            transition = _legacy_fallback_event(result.failure.code)
            self._source_events = [*python_events, transition]
            legacy_result = await self._execute_legacy_activity(input_)
            return legacy_result.model_copy(
                update={"events": [*self._source_events, *legacy_result.events]}
            )
        return result

    async def _execute_python_activity(
        self, input_: SourceInvestigationWorkflowInput
    ) -> SourceInvestigationActivityResult:
        return await workflow.execute_activity(
            inspect_source_candidates,
            SourceInvestigationActivityInput(
                workflow_id=self._workflow_id,
                request_snapshot_id=self._request_snapshot_id,
                canonical_source_url=input_.source.display_url,
            ),
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

    async def _execute_legacy_activity(
        self, input_: SourceInvestigationWorkflowInput
    ) -> SourceInvestigationActivityResult:
        return await workflow.execute_activity(
            inspect_legacy_scout,
            LegacyScoutInput(
                workflow_id=self._workflow_id,
                canonical_source_url=input_.source.display_url,
                output_package_id=f"pkg_{self._request_snapshot_id[4:]}",
                timeout=timedelta(minutes=5),
                cancellation_token=f"can_{self._workflow_id[3:]}",
            ),
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=RetryPolicy(maximum_attempts=1),
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
        )

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
        self._record_event(EventKind.APPROVAL_RECORDED)

    @workflow.query
    def summary(self) -> WorkflowSummary:
        return self._summary()

    @workflow.query
    def owner_actor(self) -> ActorSnapshot:
        return ActorSnapshot(actor_id=self._actor_id, actor_type=self._actor_type)

    @workflow.query
    def request_snapshot_id(self) -> str:
        return self._request_snapshot_id

    @workflow.query
    def source_events(self) -> list[LegacyScoutProgressEvent]:
        return list(self._source_events)

    @workflow.query
    def workflow_events(self) -> list[WorkflowEvent]:
        """Return durable, safe lifecycle events in strictly increasing order."""
        return list(self._workflow_events)

    def _transition(self, status: WorkflowStatus) -> None:
        self._status = status
        self._event_sequence += 1
        self._updated_at = workflow.now()

    def _record_event(
        self,
        kind: EventKind,
        *,
        stage: StageProgress | None = None,
        artifact: ArtifactRef | None = None,
    ) -> None:
        sequence = len(self._workflow_events) + 1
        self._workflow_events.append(
            WorkflowEvent(
                workflow_id=self._workflow_id,
                event_id=f"evt_{sequence}",
                sequence=sequence,
                kind=kind,
                occurred_at=workflow.now(),
                stage=stage,
                artifact=artifact,
            )
        )

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


def _approval_id(workflow_id: str) -> str:
    digest = sha256(workflow_id.encode()).hexdigest()
    return f"apr_{digest[:24]}"


def _legacy_fallback_event(failure_code: str) -> SourceProgressEvent:
    """Build the single transition event marking a Python-to-legacy fallback.

    Only ever called with a code already checked against
    `LEGACY_FALLBACK_ELIGIBLE_CODES`; the redundant check here is a closed
    guard so an ineligible code can never be recorded, even if a future
    caller forgets to gate first.
    """
    if failure_code not in LEGACY_FALLBACK_ELIGIBLE_CODES:
        raise ValueError("failure code is not eligible for legacy fallback")
    return SourceProgressEvent(
        kind="stage.started",
        payload={"stage": "legacy_fallback", "fallback_from": failure_code},
    )
