"""Strict E1 render-job contracts and the one pure render state machine.

A render job binds one immutable saved `EditDocument` revision to one trusted
template and one server-owned output preset. Every status change arrives as a
sequenced internal event and is applied by :func:`apply_render_event`, which is
the only place the lifecycle may advance. Terminal jobs are immutable, so a late
or duplicate callback can never resurrect a finished render or publish a partial
file.

Nothing in this module constructs a filesystem path, holds a credential, or
carries raw process output: the job row keeps bounded identifiers, versions,
checksums, and one relative published name produced by the artifact adapter.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, TypeAlias

from pydantic import AwareDatetime, Field, field_validator, model_validator

from thoth_control_plane.domain.editor_assets import RelativeArtifactLocation
from thoth_control_plane.domain.models import Checksum, OpaqueId, ProjectId, StrictModel

# Accept both datetime objects and ISO-8601 strings (repository rows and JSON
# payloads alike); AwareDatetime still rejects naive datetimes either way.
Timestamp: TypeAlias = Annotated[AwareDatetime, Field(strict=False)]

PositiveInt: TypeAlias = Annotated[int, Field(gt=0)]
NonNegativeInt: TypeAlias = Annotated[int, Field(ge=0)]
ProgressPercent: TypeAlias = Annotated[int, Field(ge=0, le=100)]
PositiveSeconds: TypeAlias = Annotated[float, Field(gt=0.0, le=86_400.0)]
Fps: TypeAlias = Annotated[float, Field(gt=0.0, le=240.0)]
#: A pinned build identifier such as ``remotion-4.0.523``.
RendererVersion: TypeAlias = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")]

#: The one template E1 is allowed to render, matching the saved document.
TrustedTemplateId: TypeAlias = Literal["vertical_text_story"]
TrustedTemplateVersion: TypeAlias = Literal[1]
#: The one server-owned output preset: MP4/H.264 at the document canvas.
RenderPresetId: TypeAlias = Literal["standard_vertical_mp4_v1"]

RenderStatus: TypeAlias = Literal[
    "preparing",
    "rendering",
    "finalizing",
    "completed",
    "failed",
    "cancelled",
]

ACTIVE_RENDER_STATUSES: frozenset[str] = frozenset({"preparing", "rendering", "finalizing"})
TERMINAL_RENDER_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled"})

ALLOWED_TRANSITIONS: dict[RenderStatus, frozenset[RenderStatus]] = {
    "preparing": frozenset({"rendering", "failed", "cancelled"}),
    "rendering": frozenset({"finalizing", "failed", "cancelled"}),
    "finalizing": frozenset({"completed", "failed", "cancelled"}),
    "completed": frozenset(),
    "failed": frozenset(),
    "cancelled": frozenset(),
}

RENDER_FAILURE_CODES = frozenset(
    {
        "render_asset_unavailable",
        "render_bundle_invalid",
        "render_deadline_exceeded",
        "render_dispatch_failed",
        "render_engine_failed",
        "render_output_invalid",
        "render_storage_failed",
        "renderer_unavailable",
    }
)
RenderFailureCode: TypeAlias = Literal[
    "render_asset_unavailable",
    "render_bundle_invalid",
    "render_deadline_exceeded",
    "render_dispatch_failed",
    "render_engine_failed",
    "render_output_invalid",
    "render_storage_failed",
    "renderer_unavailable",
]

RenderUnavailableReason: TypeAlias = Literal["renderer_not_configured", "render_busy"]


class InvalidRenderTransition(Exception):
    """Raised when an event asks for a status edge the lifecycle forbids."""


class InvalidRenderEvent(Exception):
    """Raised when an event belongs elsewhere or contradicts its own status."""


class RenderOutputFacts(StrictModel):
    """Validated media facts of the one published MP4."""

    media_type: Literal["video/mp4"]
    size_bytes: PositiveInt
    checksum: Checksum
    codec: Literal["h264"]
    width: PositiveInt
    height: PositiveInt
    fps: Fps
    duration_seconds: PositiveSeconds
    has_audio: bool


class RenderAssetChecksum(StrictModel):
    """One staged asset identity and the checksum the bundle was built from."""

    asset_id: OpaqueId
    checksum: Checksum


class RenderProvenance(StrictModel):
    """Bounded typed record of what produced a render, safe to return publicly."""

    document_revision: PositiveInt
    template_id: TrustedTemplateId
    template_version: TrustedTemplateVersion
    preset_id: RenderPresetId
    renderer_version: RendererVersion
    asset_checksums: Annotated[tuple[RenderAssetChecksum, ...], Field(max_length=200)] = ()
    output: RenderOutputFacts | None = None

    @field_validator("asset_checksums", mode="before")
    @classmethod
    def _coerce_asset_checksums(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value


class RenderJob(StrictModel):
    """One durable render of one immutable saved revision."""

    render_job_id: OpaqueId
    project_id: ProjectId
    document_id: OpaqueId
    document_revision: PositiveInt
    dispatch_id: OpaqueId
    template_id: TrustedTemplateId
    template_version: TrustedTemplateVersion
    preset_id: RenderPresetId
    renderer_version: RendererVersion
    status: RenderStatus
    progress_percent: ProgressPercent | None = None
    last_event_sequence: NonNegativeInt = 0
    retry_of_job_id: OpaqueId | None = None
    created_by: OpaqueId
    created_at: Timestamp
    started_at: Timestamp | None = None
    finished_at: Timestamp | None = None
    cancel_requested_at: Timestamp | None = None
    artifacts_cleaned_at: Timestamp | None = None
    failure_code: RenderFailureCode | None = None
    output_relative_path: RelativeArtifactLocation | None = None
    output: RenderOutputFacts | None = None
    provenance: RenderProvenance

    @model_validator(mode="after")
    def validate_lifecycle(self) -> RenderJob:
        if self.retry_of_job_id == self.render_job_id:
            raise ValueError("a render job must not retry itself")
        if self.provenance.document_revision != self.document_revision:
            raise ValueError("provenance must describe the rendered revision")
        terminal = self.status in TERMINAL_RENDER_STATUSES
        if terminal != (self.finished_at is not None):
            raise ValueError("only a terminal render job carries a finish time")
        if (self.status == "failed") != (self.failure_code is not None):
            raise ValueError("only a failed render job carries a safe failure code")
        completed = self.status == "completed"
        if completed != (self.output is not None):
            raise ValueError("only a completed render job carries output facts")
        if completed != (self.output_relative_path is not None):
            raise ValueError("only a completed render job carries a published path")
        if self.output is not None and self.provenance.output != self.output:
            raise ValueError("provenance must record the published output facts")
        return self


class RenderJobEvent(StrictModel):
    """One sequenced internal report about a dispatched render."""

    render_job_id: OpaqueId
    dispatch_id: OpaqueId
    sequence: PositiveInt
    status: RenderStatus
    progress_percent: ProgressPercent | None = None
    failure_code: RenderFailureCode | None = None
    output_relative_path: RelativeArtifactLocation | None = None
    output: RenderOutputFacts | None = None
    occurred_at: Timestamp


class RenderJobPage(StrictModel):
    """Bounded newest-first history page with an opaque cursor."""

    jobs: Annotated[tuple[RenderJob, ...], Field(max_length=50)] = ()
    next_cursor: str | None = None

    @field_validator("jobs", mode="before")
    @classmethod
    def _coerce_jobs(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value


class RenderCapability(StrictModel):
    """Whether this installation can start a render right now, and why not."""

    available: bool
    reason: RenderUnavailableReason | None = None
    preset_id: RenderPresetId
    renderer_version: RendererVersion
    active_render_job_id: OpaqueId | None = None

    @model_validator(mode="after")
    def validate_reason(self) -> RenderCapability:
        if self.available != (self.reason is None):
            raise ValueError("an unavailable render capability requires exactly one safe reason")
        return self


def _rebuild(job: RenderJob, changes: dict[str, object]) -> RenderJob:
    """Return a revalidated copy so every lifecycle invariant still holds."""
    return RenderJob.model_validate({**job.model_dump(), **changes})


def apply_render_event(job: RenderJob, event: RenderJobEvent, now: datetime) -> RenderJob:
    """Apply one internal event to a job, ignoring duplicate, older, or late reports."""
    if event.render_job_id != job.render_job_id:
        raise InvalidRenderEvent("event belongs to another render job")
    if event.dispatch_id != job.dispatch_id:
        raise InvalidRenderEvent("event belongs to a superseded dispatch")
    if job.status in TERMINAL_RENDER_STATUSES:
        return job
    if event.sequence <= job.last_event_sequence:
        return job
    if event.status != job.status and event.status not in ALLOWED_TRANSITIONS[job.status]:
        raise InvalidRenderTransition(f"{job.status} cannot become {event.status}")
    _validate_event_shape(event)

    changes: dict[str, object] = {
        "status": event.status,
        "last_event_sequence": event.sequence,
    }
    progress = _monotonic_progress(job.progress_percent, event.progress_percent)
    if progress is not None:
        changes["progress_percent"] = progress
    if event.status == "rendering" and job.started_at is None:
        changes["started_at"] = now
    if event.status in TERMINAL_RENDER_STATUSES:
        changes["finished_at"] = now
    if event.status == "completed":
        changes["output"] = event.output
        changes["output_relative_path"] = event.output_relative_path
        changes["provenance"] = job.provenance.model_copy(update={"output": event.output})
    if event.status == "failed":
        changes["failure_code"] = event.failure_code
    return _rebuild(job, changes)


def mark_cancel_requested(job: RenderJob, now: datetime) -> RenderJob:
    """Record one cancel request so the transport is asked exactly once."""
    if job.status in TERMINAL_RENDER_STATUSES:
        raise InvalidRenderTransition(f"a {job.status} render job cannot be cancelled")
    if job.cancel_requested_at is not None:
        return job
    return _rebuild(job, {"cancel_requested_at": now})


def _validate_event_shape(event: RenderJobEvent) -> None:
    completed = event.status == "completed"
    if completed and (event.output is None or event.output_relative_path is None):
        raise InvalidRenderEvent("a completed render requires validated output facts and a path")
    if not completed and (event.output is not None or event.output_relative_path is not None):
        raise InvalidRenderEvent("only a completed render may report output")
    if (event.status == "failed") != (event.failure_code is not None):
        raise InvalidRenderEvent("only a failed render carries a safe failure code")


def _monotonic_progress(current: int | None, reported: int | None) -> int | None:
    if reported is None:
        return current
    if current is None:
        return reported
    return max(current, reported)
