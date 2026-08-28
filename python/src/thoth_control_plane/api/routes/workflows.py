"""Versioned workflow lifecycle routes."""

from hmac import compare_digest
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from thoth_control_plane.application import (
    Actor,
    ApprovalSubmission,
    RetryRequest,
    StylePreset,
    WorkflowRequest,
    WorkflowService,
    WorkflowSummary,
)

router = APIRouter()


def get_workflow_service(request: Request) -> WorkflowService:
    return request.app.state.workflow_service


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
