"""Project-scoped render endpoints.

The public contract is deliberately narrow: a caller names one saved document
revision and nothing else, and reads back a projection that holds no dispatch
identity, provenance, local path, or renderer address. Every failure becomes a
fixed code, so a driver message or a filesystem detail can never be reflected
into a browser.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from pydantic import Field

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.application.render_bundles import RenderBundleInvalid
from thoth_control_plane.application.render_job_ports import (
    ArtifactPathInvalid,
    ArtifactUnavailable,
    InvalidRenderCursor,
    RenderBusy,
    RendererNotConfigured,
    RendererRejected,
    RendererUnavailable,
    RenderIdempotencyConflict,
    RenderJobNotCancellable,
    RenderJobNotCleanable,
    RenderJobNotFound,
    RenderJobNotRetryable,
    RenderPersistenceError,
)
from thoth_control_plane.application.render_jobs import (
    MAX_PAGE_SIZE,
    CreateRenderJobRequest,
    ListRenderJobsRequest,
    RenderJobService,
)
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.models import OpaqueId, ProjectId, StrictModel
from thoth_control_plane.domain.render_jobs import (
    Fps,
    PositiveInt,
    PositiveSeconds,
    ProgressPercent,
    RenderCapability,
    RenderFailureCode,
    RenderJob,
    RenderJobPage,
    RenderStatus,
    Timestamp,
)

router = APIRouter()

#: Downloads are per-caller and never cached by an intermediary.
DOWNLOAD_HEADERS = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}

#: Every application failure the public surface is allowed to describe.
_ERRORS: tuple[tuple[type[Exception], int, str], ...] = (
    (RenderJobNotFound, status.HTTP_404_NOT_FOUND, "render_job_not_found"),
    (RenderBusy, status.HTTP_409_CONFLICT, "render_busy"),
    (RenderIdempotencyConflict, status.HTTP_409_CONFLICT, "idempotency_conflict"),
    (RenderJobNotCancellable, status.HTTP_409_CONFLICT, "render_job_not_cancellable"),
    (RenderJobNotRetryable, status.HTTP_409_CONFLICT, "render_job_not_retryable"),
    (RenderJobNotCleanable, status.HTTP_409_CONFLICT, "render_job_not_cleanable"),
    (InvalidRenderCursor, 422, "invalid_render_cursor"),
    (RenderBundleInvalid, 422, "render_document_invalid"),
    (RendererNotConfigured, status.HTTP_503_SERVICE_UNAVAILABLE, "renderer_not_configured"),
    (RendererUnavailable, status.HTTP_503_SERVICE_UNAVAILABLE, "render_dispatch_failed"),
    (RendererRejected, status.HTTP_503_SERVICE_UNAVAILABLE, "render_dispatch_failed"),
    (RenderPersistenceError, status.HTTP_503_SERVICE_UNAVAILABLE, "render_unavailable"),
)


@contextlib.contextmanager
def safe_render_errors(
    *, unavailable: tuple[int, str] = (status.HTTP_409_CONFLICT, "render_preparation_failed")
) -> Iterator[None]:
    """Translate one application failure into its fixed public answer.

    An artifact failure means something different per route — a render that was
    never staged, or a file that is no longer downloadable — so the caller
    chooses that pair and everything else is fixed here.
    """
    try:
        yield
    except (ArtifactUnavailable, ArtifactPathInvalid):
        raise HTTPException(status_code=unavailable[0], detail={"code": unavailable[1]}) from None
    except Exception as error:
        for kind, status_code, code in _ERRORS:
            if isinstance(error, kind):
                raise HTTPException(status_code=status_code, detail={"code": code}) from None
        raise


class RenderOutputView(StrictModel):
    """What a finished render is, with no locator and no encoder knob."""

    media_type: Literal["video/mp4"]
    size_bytes: PositiveInt
    checksum: str
    width: PositiveInt
    height: PositiveInt
    fps: Fps
    duration_seconds: PositiveSeconds
    has_audio: bool


class RenderJobView(StrictModel):
    """The only render-job shape a browser ever sees."""

    render_job_id: OpaqueId
    project_id: ProjectId
    document_id: OpaqueId
    document_revision: PositiveInt
    status: RenderStatus
    progress_percent: ProgressPercent | None = None
    failure_code: RenderFailureCode | None = None
    template_id: Literal["vertical_text_story"]
    template_version: Literal[1]
    preset_id: Literal["standard_vertical_mp4_v1"]
    renderer_version: str
    retry_of_job_id: OpaqueId | None = None
    created_at: Timestamp
    started_at: Timestamp | None = None
    finished_at: Timestamp | None = None
    cancel_requested_at: Timestamp | None = None
    artifacts_cleaned_at: Timestamp | None = None
    output: RenderOutputView | None = None


class RenderJobPageView(StrictModel):
    """One bounded newest-first page of a project's render history."""

    jobs: Annotated[tuple[RenderJobView, ...], Field(max_length=MAX_PAGE_SIZE)] = ()
    next_cursor: str | None = None


def _view(job: RenderJob) -> RenderJobView:
    """Project the persisted row, dropping every field the browser must not see."""
    return RenderJobView.model_validate(
        {field: getattr(job, field) for field in RenderJobView.model_fields if field != "output"}
        | {
            "output": None
            if job.output is None
            else RenderOutputView.model_validate(
                job.output.model_dump(mode="python", exclude={"codec"})
            )
        }
    )


def _page(page: RenderJobPage) -> RenderJobPageView:
    return RenderJobPageView(
        jobs=tuple(_view(job) for job in page.jobs), next_cursor=page.next_cursor
    )


def get_render_job_service(request: Request) -> RenderJobService:
    return request.app.state.render_job_service


ServiceDependency = Annotated[RenderJobService, Depends(get_render_job_service)]
ActorDependency = Annotated[Actor, Depends(current_actor)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)]


@router.get("/projects/{project_id}/render-capability", response_model=RenderCapability)
async def read_render_capability(
    project_id: ProjectId, actor: ActorDependency, service: ServiceDependency
) -> RenderCapability:
    """Report whether this installation can start a render for this project now."""
    with safe_render_errors():
        return await service.capability(project_id)


@router.post(
    "/projects/{project_id}/render-jobs",
    response_model=RenderJobView,
    status_code=status.HTTP_201_CREATED,
)
async def create_render_job(
    project_id: ProjectId,
    payload: CreateRenderJobRequest,
    idempotency_key: IdempotencyKey,
    actor: ActorDependency,
    service: ServiceDependency,
) -> RenderJobView:
    """Start exactly one render of one saved revision, or report why not."""
    with safe_render_errors():
        job = await service.create(
            project_id=project_id,
            actor_id=actor.actor_id,
            request=payload,
            idempotency_key=idempotency_key,
        )
    return _view(job)


@router.get("/projects/{project_id}/render-jobs", response_model=RenderJobPageView)
async def list_render_jobs(
    project_id: ProjectId,
    actor: ActorDependency,
    service: ServiceDependency,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 20,
    cursor: Annotated[str | None, Query(min_length=1, max_length=256)] = None,
) -> RenderJobPageView:
    with safe_render_errors():
        page = await service.list(project_id, ListRenderJobsRequest(limit=limit, cursor=cursor))
    return _page(page)


@router.get(
    "/projects/{project_id}/render-jobs/{render_job_id}",
    response_model=RenderJobView,
)
async def read_render_job(
    project_id: ProjectId,
    render_job_id: OpaqueId,
    actor: ActorDependency,
    service: ServiceDependency,
) -> RenderJobView:
    with safe_render_errors():
        job = await service.get(project_id, render_job_id)
    return _view(job)


@router.post(
    "/projects/{project_id}/render-jobs/{render_job_id}/cancel",
    response_model=RenderJobView,
)
async def cancel_render_job(
    project_id: ProjectId,
    render_job_id: OpaqueId,
    actor: ActorDependency,
    service: ServiceDependency,
) -> RenderJobView:
    """Record one cancel request; the renderer answers through its own events."""
    with safe_render_errors():
        job = await service.cancel(project_id, render_job_id)
    return _view(job)


@router.post(
    "/projects/{project_id}/render-jobs/{render_job_id}/retry",
    response_model=RenderJobView,
    status_code=status.HTTP_201_CREATED,
)
async def retry_render_job(
    project_id: ProjectId,
    render_job_id: OpaqueId,
    idempotency_key: IdempotencyKey,
    actor: ActorDependency,
    service: ServiceDependency,
) -> RenderJobView:
    """Start a new job for the same revision; the finished one stays finished."""
    with safe_render_errors():
        job = await service.retry(project_id, actor.actor_id, render_job_id, idempotency_key)
    return _view(job)


@router.get(
    "/projects/{project_id}/render-jobs/{render_job_id}/output",
    response_class=FileResponse,
    responses={200: {"content": {"video/mp4": {}}}},
)
async def download_render_output(
    project_id: ProjectId,
    render_job_id: OpaqueId,
    actor: ActorDependency,
    service: ServiceDependency,
) -> FileResponse:
    """Stream the one published render, never a redirect to where it lives."""
    with safe_render_errors(unavailable=(status.HTTP_404_NOT_FOUND, "render_output_unavailable")):
        download = await service.output_path(project_id, render_job_id)
    return FileResponse(
        download.path,
        media_type=download.media_type,
        headers={
            **DOWNLOAD_HEADERS,
            "Content-Disposition": f'attachment; filename="{download.filename}"',
            "Content-Length": str(download.size_bytes),
            "X-Thoth-Render-Checksum": download.checksum,
        },
    )


@router.delete(
    "/projects/{project_id}/render-jobs/{render_job_id}/artifacts",
    response_model=RenderJobView,
)
async def cleanup_render_artifacts(
    project_id: ProjectId,
    render_job_id: OpaqueId,
    actor: ActorDependency,
    service: ServiceDependency,
) -> RenderJobView:
    """Delete one terminal job's files by hand, keeping its audit row."""
    with safe_render_errors():
        job = await service.cleanup(project_id, render_job_id)
    return _view(job)
