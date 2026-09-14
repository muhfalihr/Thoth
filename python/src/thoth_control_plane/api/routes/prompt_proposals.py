"""Authenticated Prompt Proposal routes (C2)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.application.ports import (
    PromptBindingNotFound,
    PromptTemplateNotFound,
)
from thoth_control_plane.application.prompt_lab import PromptStageNotRegistered
from thoth_control_plane.application.prompt_proposal_ports import (
    PromptIdempotencyConflict,
    PromptLockRevisionConflict,
    PromptModelNotInCatalog,
    PromptPreferenceRevisionConflict,
    PromptProposalActiveGeneration,
    PromptProposalApplyResult,
    PromptProposalEmptyLayer,
    PromptProposalInvalidSelection,
    PromptProposalInvalidTransition,
    PromptProposalLayerLocked,
    PromptProposalNotFound,
    PromptProposalStale,
    PromptProposalStoreUnavailable,
    PromptWorkflowUnavailable,
)
from thoth_control_plane.application.prompt_proposals import PromptProposalService
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.prompt_proposals import (
    ApplyPromptProposalRequest,
    CreatePromptProposalRequest,
    LockRevisionConflictBody,
    PreferenceRevisionConflictBody,
    ProjectPromptLayerLock,
    ProjectPromptModelPreference,
    PromptProposal,
    PromptProposalPage,
    PromptProviderDefinition,
    SavePromptLayerLockRequest,
    SavePromptModelPreferenceRequest,
)
from thoth_control_plane.domain.prompts import PromptStarterDefinition

router = APIRouter()

_CONFLICT_ERRORS = (
    PromptProposalActiveGeneration,
    PromptProposalStale,
    PromptProposalLayerLocked,
    PromptProposalInvalidSelection,
    PromptProposalInvalidTransition,
    PromptIdempotencyConflict,
)
_NOT_FOUND_ERRORS = (PromptProposalNotFound, PromptTemplateNotFound, PromptBindingNotFound)
_INVALID_ERRORS = (PromptModelNotInCatalog, PromptProposalEmptyLayer, PromptStageNotRegistered)


def get_prompt_proposal_service(request: Request) -> PromptProposalService:
    return request.app.state.prompt_proposal_service


_ERROR_CONTRACT: dict[type[Exception], tuple[int, str]] = {
    PromptProposalNotFound: (404, "proposal_not_found"),
    PromptTemplateNotFound: (404, "source_not_found"),
    PromptBindingNotFound: (404, "source_not_found"),
    PromptStageNotRegistered: (404, "stage_not_found"),
    PromptProposalStale: (409, "source_revision_changed"),
    PromptProposalLayerLocked: (409, "layer_locked"),
    PromptProposalActiveGeneration: (409, "proposal_already_running"),
    PromptIdempotencyConflict: (409, "idempotency_conflict"),
    PromptProposalInvalidTransition: (409, "invalid_transition"),
    PromptModelNotInCatalog: (422, "model_not_allowed"),
    PromptProposalEmptyLayer: (422, "empty_target_layer"),
    PromptProposalInvalidSelection: (422, "invalid_change_selection"),
    PromptProposalStoreUnavailable: (503, "store_unavailable"),
    PromptWorkflowUnavailable: (503, "workflow_unavailable"),
}


def _http_error(error: Exception) -> HTTPException:
    """Map one typed application error to its stable safe status and detail.code."""
    for error_type, (status_code, code) in _ERROR_CONTRACT.items():
        if isinstance(error, error_type):
            return HTTPException(status_code=status_code, detail={"code": code})
    return HTTPException(status_code=500)


@router.get("/prompt-providers", response_model=list[PromptProviderDefinition])
async def list_prompt_providers(
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> list[PromptProviderDefinition]:
    return list(service.list_providers())


@router.get("/prompt-stages/{stage_id}/starter", response_model=PromptStarterDefinition)
async def get_prompt_starter(
    stage_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> PromptStarterDefinition:
    try:
        starter = service.get_starter(stage_id)
    except PromptStageNotRegistered as error:
        raise _http_error(error) from error
    if starter is None:
        raise HTTPException(status_code=404, detail={"code": "starter_not_found"})
    return starter


@router.get(
    "/projects/{project_id}/prompt-lab/preferences/{stage_id}",
    response_model=ProjectPromptModelPreference,
)
async def get_prompt_preference(
    project_id: str,
    stage_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> ProjectPromptModelPreference:
    try:
        preference = await service.get_preference(project_id, stage_id)
    except PromptStageNotRegistered as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error
    if preference is None:
        raise HTTPException(status_code=404, detail={"code": "preference_not_found"})
    return preference


@router.put(
    "/projects/{project_id}/prompt-lab/preferences/{stage_id}",
    response_model=ProjectPromptModelPreference,
    responses={status.HTTP_409_CONFLICT: {"model": PreferenceRevisionConflictBody}},
)
async def save_prompt_preference(
    project_id: str,
    stage_id: str,
    request: SavePromptModelPreferenceRequest,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> ProjectPromptModelPreference | JSONResponse:
    try:
        return await service.save_preference(project_id, stage_id, request)
    except PromptPreferenceRevisionConflict as error:
        body = PreferenceRevisionConflictBody(latest=error.latest)
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT, content=body.model_dump(mode="json")
        )
    except _CONFLICT_ERRORS as error:
        raise _http_error(error) from error
    except _INVALID_ERRORS as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error


@router.get(
    "/projects/{project_id}/prompt-lab/locks/{stage_id}",
    response_model=list[ProjectPromptLayerLock],
)
async def get_prompt_locks(
    project_id: str,
    stage_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> list[ProjectPromptLayerLock]:
    try:
        return list(await service.get_locks(project_id, stage_id))
    except PromptStageNotRegistered as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error


@router.put(
    "/projects/{project_id}/prompt-lab/locks/{stage_id}/{layer}",
    response_model=ProjectPromptLayerLock,
    responses={status.HTTP_409_CONFLICT: {"model": LockRevisionConflictBody}},
)
async def save_prompt_lock(
    project_id: str,
    stage_id: str,
    layer: str,
    request: SavePromptLayerLockRequest,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> ProjectPromptLayerLock | JSONResponse:
    if layer not in ("template", "project_override"):
        raise HTTPException(status_code=404, detail={"code": "invalid_lock_layer"})
    try:
        return await service.save_lock(project_id, stage_id, layer, request)
    except PromptLockRevisionConflict as error:
        body = LockRevisionConflictBody(latest=error.latest)
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT, content=body.model_dump(mode="json")
        )
    except _CONFLICT_ERRORS as error:
        raise _http_error(error) from error
    except _INVALID_ERRORS as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error


@router.post(
    "/projects/{project_id}/prompt-lab/proposals",
    response_model=PromptProposal,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_prompt_proposal(
    project_id: str,
    request: CreatePromptProposalRequest,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> PromptProposal:
    if not idempotency_key or not idempotency_key.strip():
        raise HTTPException(status_code=422, detail={"code": "missing_idempotency_key"})
    try:
        return await service.create_proposal(project_id, request, _.actor_id, idempotency_key)
    except _CONFLICT_ERRORS as error:
        raise _http_error(error) from error
    except _NOT_FOUND_ERRORS as error:
        raise _http_error(error) from error
    except _INVALID_ERRORS as error:
        raise _http_error(error) from error
    except PromptWorkflowUnavailable as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error


@router.get(
    "/projects/{project_id}/prompt-lab/proposals",
    response_model=PromptProposalPage,
)
async def list_prompt_proposals(
    project_id: str,
    stage_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
    cursor: str | None = None,
    limit: int = 20,
) -> PromptProposalPage:
    try:
        return await service.list_proposals(project_id, stage_id, cursor, limit)
    except PromptStageNotRegistered as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error


@router.get(
    "/projects/{project_id}/prompt-lab/proposals/{proposal_id}",
    response_model=PromptProposal,
)
async def get_prompt_proposal(
    project_id: str,
    proposal_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> PromptProposal:
    try:
        return await service.get_proposal(project_id, proposal_id)
    except PromptProposalNotFound as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error


@router.post(
    "/projects/{project_id}/prompt-lab/proposals/{proposal_id}/apply",
    response_model=PromptProposalApplyResult,
)
async def apply_prompt_proposal(
    project_id: str,
    proposal_id: str,
    request: ApplyPromptProposalRequest,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> PromptProposalApplyResult:
    try:
        return await service.apply(project_id, proposal_id, request, _.actor_id)
    except _CONFLICT_ERRORS as error:
        raise _http_error(error) from error
    except PromptProposalNotFound as error:
        raise _http_error(error) from error
    except _INVALID_ERRORS as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error


@router.post(
    "/projects/{project_id}/prompt-lab/proposals/{proposal_id}/reject",
    response_model=PromptProposal,
)
async def reject_prompt_proposal(
    project_id: str,
    proposal_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptProposalService, Depends(get_prompt_proposal_service)],
) -> PromptProposal:
    try:
        return await service.reject(project_id, proposal_id, _.actor_id)
    except PromptProposalNotFound as error:
        raise _http_error(error) from error
    except PromptProposalInvalidTransition as error:
        raise _http_error(error) from error
    except PromptProposalStoreUnavailable as error:
        raise _http_error(error) from error
