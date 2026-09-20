"""Ports and safe failures for revision-bound render-job persistence.

The application layer only ever sees these abstractions, so no adapter detail
(connection string, driver error, SQL, or index name) can reach a route or a
public response. Every exception here carries a fixed safe message.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from thoth_control_plane.domain.render_jobs import (
    RenderJob,
    RenderJobEvent,
    RenderJobPage,
)


class RenderPersistenceError(Exception):
    """Raised when render-job storage is unusable, with nothing to leak."""

    def __init__(self) -> None:
        super().__init__("render persistence unavailable")


class RenderJobNotFound(Exception):
    """Raised when no render job matches the requested identity and scope."""

    def __init__(self) -> None:
        super().__init__("render job not found")


class RenderBusy(Exception):
    """Raised when the one active render slot is already taken.

    The active identity is carried as structured data, never in the message:
    the route decides whether the caller may see a job from another project.
    """

    def __init__(
        self,
        *,
        active_render_job_id: str | None = None,
        active_project_id: str | None = None,
    ) -> None:
        super().__init__("render busy")
        self.active_render_job_id = active_render_job_id
        self.active_project_id = active_project_id


class RenderIdempotencyConflict(Exception):
    """Raised when one idempotency key is reused for a different request."""

    def __init__(self) -> None:
        super().__init__("render idempotency conflict")


class InvalidRenderCursor(Exception):
    """Raised when a history cursor is not one this server issued."""

    def __init__(self) -> None:
        super().__init__("render cursor invalid")


class RenderJobRepository(Protocol):
    """Durable owner of render-job identity, history, and the one active slot."""

    async def reserve(
        self, job: RenderJob, *, idempotency_key: str, payload_hash: str
    ) -> RenderJob:
        """Claim the single active slot, replaying an identical earlier request."""

    async def get(self, *, project_id: str, render_job_id: str) -> RenderJob | None:
        """Read one job the given project owns."""

    async def get_internal(self, *, render_job_id: str) -> RenderJob | None:
        """Read one job by identity alone, for private renderer callbacks."""

    async def list(self, *, project_id: str, limit: int, cursor: str | None) -> RenderJobPage:
        """Read one bounded newest-first page of a project's render history."""

    async def apply_event(
        self, *, render_job_id: str, event: RenderJobEvent, now: datetime
    ) -> RenderJob:
        """Apply one sequenced event under a row lock and persist the result."""

    async def mark_cancel_requested(
        self, *, project_id: str, render_job_id: str, now: datetime
    ) -> tuple[RenderJob, bool]:
        """Record one cancel request, reporting whether this call was the first."""

    async def mark_cleaned(
        self, *, project_id: str, render_job_id: str, now: datetime
    ) -> RenderJob:
        """Record artifact cleanup for a terminal job, keeping the audit row."""

    async def list_expired_active(self, *, deadline: datetime, limit: int) -> tuple[RenderJob, ...]:
        """Read active jobs created before a deadline, for bounded reconciliation."""
