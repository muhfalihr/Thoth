"""Ports and safe failures for revision-bound render-job persistence.

The application layer only ever sees these abstractions, so no adapter detail
(connection string, driver error, SQL, or index name) can reach a route or a
public response. Every exception here carries a fixed safe message.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from thoth_control_plane.domain.render_jobs import (
    RenderJob,
    RenderJobEvent,
    RenderJobPage,
    RenderOutputFacts,
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


class RendererNotConfigured(Exception):
    """Raised when no private renderer is configured, so render is unavailable."""

    def __init__(self) -> None:
        super().__init__("renderer not configured")


class RendererUnavailable(Exception):
    """Raised when the private renderer cannot be reached or failed internally."""

    def __init__(self) -> None:
        super().__init__("renderer unavailable")


class RendererRejected(Exception):
    """Raised when the private renderer refused a dispatch it understood."""

    def __init__(self) -> None:
        super().__init__("renderer rejected the dispatch")


class ArtifactPathInvalid(Exception):
    """Raised when an identity or location cannot address a safe artifact path."""

    def __init__(self) -> None:
        super().__init__("render artifact path invalid")


class ArtifactUnavailable(Exception):
    """Raised when a required artifact is missing, oversized, or not as recorded."""

    def __init__(self) -> None:
        super().__init__("render artifact unavailable")


@dataclass(frozen=True)
class JobWorkspace:
    """One job's staging area, described only by names the caller may use."""

    render_job_id: str
    bundle_name: str = "bundle.json"
    assets_name: str = "assets"


@dataclass(frozen=True)
class StagedAsset:
    """One asset copied into a workspace and verified against its record."""

    asset_id: str
    relative_name: str
    size_bytes: int
    checksum: str


@dataclass(frozen=True)
class PublishedArtifact:
    """The one published render, addressed relative to the artifact root."""

    relative_path: str
    size_bytes: int
    checksum: str


class ArtifactRoot(Protocol):
    """The only component allowed to compose or resolve an E1 filesystem path."""

    def prepare(self, render_job_id: str) -> JobWorkspace:
        """Create this job's workspace and temporary directory."""

    def resolve_source(self, relative_location: str) -> Path:
        """Resolve one stored asset locator, so no caller ever joins a path."""

    def stage_asset(
        self,
        workspace: JobWorkspace,
        *,
        asset_id: str,
        source: Path,
        expected_checksum: str,
        max_bytes: int,
    ) -> StagedAsset:
        """Copy one bounded, checksum-verified asset into the workspace."""

    def write_bundle(self, workspace: JobWorkspace, bundle_json: bytes) -> str:
        """Write the immutable bundle and return its relative name."""

    def verify_temporary_output(self, render_job_id: str, expected: RenderOutputFacts) -> Path:
        """Confirm the temporary render is a regular file matching its facts."""

    def publish(
        self,
        render_job_id: str,
        output: RenderOutputFacts,
        metadata_json: bytes,
        diagnostics_json: bytes,
    ) -> PublishedArtifact:
        """Atomically publish a verified render with its bounded records."""

    def resolve_download(self, render_job_id: str, relative_path: str) -> Path:
        """Resolve the one downloadable render this job published."""

    def cleanup(self, render_job_id: str) -> None:
        """Delete only this job's files, keeping its bounded safe records."""


class RendererGateway(Protocol):
    """The only way the application reaches the private renderer.

    Both calls are idempotent, carry identity alone, and never report transport
    detail: the service sees one of the fixed renderer failures above.
    """

    async def start(self, *, render_job_id: str, dispatch_id: str) -> None:
        """Ask the renderer to begin exactly one execution for this job."""

    async def cancel(self, *, render_job_id: str) -> None:
        """Ask the renderer to abort the execution it owns for this job."""


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
