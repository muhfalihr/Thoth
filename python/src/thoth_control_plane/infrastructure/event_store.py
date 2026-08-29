"""Normalized, replayable observations from the read-only legacy job bridge."""

from __future__ import annotations

from collections.abc import AsyncIterator

from thoth_control_plane.domain import Actor, EventKind, WorkflowEvent, WorkflowStatus
from thoth_control_plane.domain.models import StageProgress
from thoth_control_plane.infrastructure.legacy_reader import LegacyJobReader

_SNAPSHOT_EVENT_KIND = {
    WorkflowStatus.QUEUED: EventKind.WORKFLOW_QUEUED,
    WorkflowStatus.RUNNING: EventKind.WORKFLOW_STARTED,
    WorkflowStatus.SUCCEEDED: EventKind.WORKFLOW_COMPLETED,
    WorkflowStatus.FAILED: EventKind.WORKFLOW_FAILED,
    WorkflowStatus.CANCELLED: EventKind.WORKFLOW_CANCELLED,
    WorkflowStatus.AWAITING_APPROVAL: EventKind.APPROVAL_REQUIRED,
}


class LegacyEventStore:
    """Build a stable v1 SSE replay stream without writing to the legacy database."""

    def __init__(self, reader: LegacyJobReader) -> None:
        self._reader = reader

    async def replay(
        self, legacy_job_id: str, actor: Actor, after_sequence: int
    ) -> AsyncIterator[WorkflowEvent]:
        """Yield one snapshot for a fresh stream, followed by strictly newer events."""
        if after_sequence < 0:
            raise ValueError("event sequence must not be negative")
        if after_sequence == 0:
            summary = await self._reader.get_summary(legacy_job_id, actor)
            stage = None
            if summary.stages:
                current = summary.stages[0]
                stage = StageProgress(name=current.id, progress=current.progress)
            yield WorkflowEvent(
                workflow_id=summary.workflow_id,
                event_id=f"{summary.workflow_id}_snapshot",
                sequence=1,
                kind=_SNAPSHOT_EVENT_KIND[summary.status],
                occurred_at=summary.updated_at,
                stage=stage,
            )

        legacy_after = max(after_sequence - 1, 0)
        async for event in self._reader.iter_events(legacy_job_id, legacy_after):
            if event.sequence <= 0:
                continue
            normalized = event.model_copy(
                update={
                    "sequence": event.sequence + 1,
                    "event_id": f"{event.workflow_id}_event_{event.sequence}",
                }
            )
            if normalized.sequence > after_sequence:
                yield normalized
