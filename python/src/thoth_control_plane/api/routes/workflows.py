"""Versioned workflow lifecycle routes."""

import re
from collections.abc import AsyncIterator
from hmac import compare_digest
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from thoth_control_plane.application import (
    Actor,
    ApprovalSubmission,
    RetryRequest,
    StylePreset,
    WorkflowEvent,
    WorkflowRequest,
    WorkflowService,
    WorkflowSummary,
)
from thoth_control_plane.infrastructure.event_store import LegacyEventStore
from thoth_control_plane.infrastructure.legacy_reader import (
    LegacyJobMappingError,
    LegacyJobNotFound,
    LegacyJobReader,
)

router = APIRouter()


def get_workflow_service(request: Request) -> WorkflowService:
    return request.app.state.workflow_service


def get_legacy_job_reader(request: Request) -> LegacyJobReader:
    """Get the migration-only, read-only adapter without changing product wiring."""
    configured_reader = getattr(request.app.state, "legacy_job_reader", None)
    if configured_reader is not None:
        return configured_reader
    settings = request.app.state.settings
    if not settings.legacy_bridge_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Legacy bridge is not configured",
        )
    reader = LegacyJobReader.from_settings(
        settings.THOTH_LEGACY_API_BASE_URL or "",
        settings.THOTH_LEGACY_API_KEY.get_secret_value() if settings.THOTH_LEGACY_API_KEY else "",
    )
    request.app.state.legacy_job_reader = reader
    return reader


def current_actor(
    request: Request,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> Actor:
    expected = request.app.state.settings.THOTH_CONTROL_PLANE_API_KEY.get_secret_value()
    scheme, _, credential = authorization.partition(" ") if authorization else ("", "", "")
    if scheme.lower() != "bearer" or not credential or not compare_digest(credential, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized")
    return Actor(actor_id="owner", actor_type="user")


@router.get("/style-presets", response_model=list[StylePreset])
async def list_style_presets(
    actor: Annotated[Actor, Depends(current_actor)],
    service: Annotated[WorkflowService, Depends(get_workflow_service)],
) -> list[StylePreset]:
    return await service.list_style_presets(actor=actor)


@router.post(
    "/workflows",
    response_model=WorkflowSummary,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_workflow(
    request: WorkflowRequest,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1)],
    actor: Annotated[Actor, Depends(current_actor)],
    service: Annotated[WorkflowService, Depends(get_workflow_service)],
) -> WorkflowSummary:
    return await service.start(request, actor=actor, idempotency_key=idempotency_key)


@router.get("/workflows/{workflow_id}", response_model=WorkflowSummary)
async def get_workflow(
    workflow_id: str,
    actor: Annotated[Actor, Depends(current_actor)],
    service: Annotated[WorkflowService, Depends(get_workflow_service)],
) -> WorkflowSummary:
    return await service.get(workflow_id, actor=actor)


@router.get(
    "/workflows/{workflow_id}/events",
    response_model=WorkflowEvent,
    response_class=StreamingResponse,
    responses={
        status.HTTP_200_OK: {
            "content": {
                "text/event-stream": {"schema": {"$ref": "#/components/schemas/WorkflowEvent"}}
            }
        }
    },
)
async def stream_workflow_events(
    workflow_id: str,
    actor: Annotated[Actor, Depends(current_actor)],
    service: Annotated[WorkflowService, Depends(get_workflow_service)],
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    """Stream the current workflow snapshot and replay only unseen typed events."""
    after_sequence = _parse_last_event_id(last_event_id)

    async def encoded_events() -> AsyncIterator[str]:
        if last_event_id is None:
            snapshot = _workflow_snapshot_event(
                await service.get(workflow_id, actor=actor), sequence=1
            )
            yield f"event: workflow.snapshot\ndata: {snapshot.model_dump_json()}\n\n"
        async for event in service.stream_events(
            workflow_id,
            actor=actor,
            after_sequence=after_sequence,
        ):
            yield (
                f"id: {event.sequence}\nevent: {event.kind}\ndata: {event.model_dump_json()}\n\n"
            )

    return StreamingResponse(encoded_events(), media_type="text/event-stream")


@router.get(
    "/legacy/jobs/{legacy_job_id}",
    response_model=WorkflowSummary,
    tags=["migration"],
    summary="Observe a legacy job during migration",
)
async def get_legacy_job(
    legacy_job_id: str,
    actor: Annotated[Actor, Depends(current_actor)],
    reader: Annotated[LegacyJobReader, Depends(get_legacy_job_reader)],
) -> WorkflowSummary:
    """Return a safe v1 projection of one legacy Rust job, without mutations."""
    try:
        return await reader.get_summary(legacy_job_id, actor)
    except LegacyJobNotFound as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found"
        ) from error
    except LegacyJobMappingError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Legacy job is unavailable"
        ) from error


@router.get(
    "/legacy/jobs/{legacy_job_id}/events",
    tags=["migration"],
    summary="Replay legacy job observations during migration",
)
async def stream_legacy_job_events(
    legacy_job_id: str,
    actor: Annotated[Actor, Depends(current_actor)],
    reader: Annotated[LegacyJobReader, Depends(get_legacy_job_reader)],
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    """Expose migration-only SSE replay with a strict, monotonically increasing cursor."""
    after_sequence = _parse_last_event_id(last_event_id)
    store = LegacyEventStore(reader)

    async def encoded_events() -> AsyncIterator[str]:
        try:
            async for event in store.replay(legacy_job_id, actor, after_sequence):
                yield (
                    f"id: {event.sequence}\nevent: {event.kind}\n"
                    f"data: {event.model_dump_json()}\n\n"
                )
        except LegacyJobNotFound:
            return
        except LegacyJobMappingError:
            return

    return StreamingResponse(encoded_events(), media_type="text/event-stream")


def _parse_last_event_id(value: str | None) -> int:
    if value is None:
        return 0
    if not re.fullmatch(r"[0-9]+", value):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Last-Event-ID must be a non-negative integer",
        )
    return int(value)


def _workflow_snapshot_event(summary: WorkflowSummary, *, sequence: int) -> WorkflowEvent:
    """Represent an otherwise eventless current state with the typed event contract."""
    kind_by_status = {
        "queued": "workflow.queued",
        "running": "workflow.started",
        "awaiting_approval": "approval.required",
        "succeeded": "workflow.completed",
        "failed": "workflow.failed",
        "cancelled": "workflow.cancelled",
    }
    return WorkflowEvent(
        workflow_id=summary.workflow_id,
        event_id=f"snapshot_{summary.workflow_id}",
        sequence=max(1, sequence),
        kind=kind_by_status[str(summary.status)],
        occurred_at=summary.updated_at,
    )


@router.post("/workflows/{workflow_id}/cancel", response_model=WorkflowSummary)
async def cancel_workflow(
    workflow_id: str,
    actor: Annotated[Actor, Depends(current_actor)],
    service: Annotated[WorkflowService, Depends(get_workflow_service)],
) -> WorkflowSummary:
    return await service.cancel(workflow_id, actor=actor)


@router.post("/workflows/{workflow_id}/retry", response_model=WorkflowSummary)
async def retry_workflow(
    workflow_id: str,
    retry: RetryRequest,
    actor: Annotated[Actor, Depends(current_actor)],
    service: Annotated[WorkflowService, Depends(get_workflow_service)],
) -> WorkflowSummary:
    return await service.retry(workflow_id, from_stage=retry.from_stage, actor=actor)


@router.post("/workflows/{workflow_id}/approve", response_model=WorkflowSummary)
async def approve_workflow(
    workflow_id: str,
    approval: ApprovalSubmission,
    actor: Annotated[Actor, Depends(current_actor)],
    service: Annotated[WorkflowService, Depends(get_workflow_service)],
) -> WorkflowSummary:
    return await service.record_approval(workflow_id, approval, actor=actor)
