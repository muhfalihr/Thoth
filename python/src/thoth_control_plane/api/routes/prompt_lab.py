"""Authenticated Prompt Lab authoring routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.application.ports import (
    PromptBindingNotFound,
    PromptBindingRevisionConflict,
    PromptTemplateNotFound,
    PromptTemplateRevisionConflict,
)
from thoth_control_plane.application.prompt_lab import (
    PromptLabService,
    PromptLabStoreUnavailable,
    PromptStageMismatch,
    PromptStageNotRegistered,
)
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.prompts import (
    ProjectPromptBinding,
    PromptStageDefinition,
    PromptStageId,
    PromptTemplateRevision,
    ResolvedPromptDraft,
    SaveProjectPromptBindingRequest,
    SavePromptTemplateRequest,
)

router = APIRouter()

_STAGE_ERRORS = (PromptStageMismatch, PromptStageNotRegistered)
_NOT_FOUND_ERRORS = (PromptTemplateNotFound, PromptBindingNotFound)


def get_prompt_lab_service(request: Request) -> PromptLabService:
    return request.app.state.prompt_lab_service


def _unavailable(error: PromptLabStoreUnavailable) -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)


def _not_found(
    error: PromptTemplateNotFound | PromptBindingNotFound | PromptStageNotRegistered,
) -> HTTPException:
    code = (
        status.HTTP_422_UNPROCESSABLE_ENTITY
        if isinstance(error, PromptStageNotRegistered)
        else status.HTTP_404_NOT_FOUND
    )
    return HTTPException(status_code=code)


def _stage_mismatch(error: PromptStageMismatch) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY)


@router.get("/prompt-stages", response_model=list[PromptStageDefinition])
async def list_prompt_stages(
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptLabService, Depends(get_prompt_lab_service)],
) -> list[PromptStageDefinition]:
    return list(service.list_stages())


@router.get(
    "/projects/{project_id}/prompt-lab/templates",
    response_model=list[PromptTemplateRevision],
)
async def list_prompt_templates(
    project_id: str,
    stage_id: PromptStageId,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptLabService, Depends(get_prompt_lab_service)],
) -> list[PromptTemplateRevision]:
    try:
        return await service.list_templates(project_id, stage_id)
    except PromptStageNotRegistered as error:
        raise _not_found(error) from error
    except PromptLabStoreUnavailable as error:
        raise _unavailable(error) from error


@router.post(
    "/projects/{project_id}/prompt-lab/templates",
    response_model=PromptTemplateRevision,
    status_code=status.HTTP_201_CREATED,
    responses={status.HTTP_409_CONFLICT: {"model": PromptTemplateRevision}},
)
async def create_prompt_template(
    project_id: str,
    request: SavePromptTemplateRequest,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptLabService, Depends(get_prompt_lab_service)],
) -> PromptTemplateRevision | JSONResponse:
    try:
        return await service.save_template(project_id, request)
    except PromptTemplateRevisionConflict as error:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT, content=error.latest.model_dump(mode="json")
        )
    except PromptTemplateNotFound as error:
        raise _not_found(error) from error
    except PromptLabStoreUnavailable as error:
        raise _unavailable(error) from error


@router.get(
    "/projects/{project_id}/prompt-lab/bindings/{stage_id}",
    response_model=ProjectPromptBinding,
)
async def get_prompt_binding(
    project_id: str,
    stage_id: PromptStageId,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptLabService, Depends(get_prompt_lab_service)],
) -> ProjectPromptBinding:
    try:
        binding = await service.get_binding(project_id, stage_id)
    except PromptStageNotRegistered as error:
        raise _not_found(error) from error
    except PromptLabStoreUnavailable as error:
        raise _unavailable(error) from error
    if binding is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return binding


@router.put(
    "/projects/{project_id}/prompt-lab/bindings/{stage_id}",
    response_model=ProjectPromptBinding,
    responses={status.HTTP_409_CONFLICT: {"model": ProjectPromptBinding}},
)
async def save_prompt_binding(
    project_id: str,
    stage_id: PromptStageId,
    request: SaveProjectPromptBindingRequest,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptLabService, Depends(get_prompt_lab_service)],
) -> ProjectPromptBinding | JSONResponse:
    try:
        return await service.save_binding(project_id, stage_id, request)
    except PromptBindingRevisionConflict as error:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT, content=error.latest.model_dump(mode="json")
        )
    except _NOT_FOUND_ERRORS as error:
        raise _not_found(error) from error
    except _STAGE_ERRORS as error:
        raise _stage_mismatch(error) from error
    except PromptLabStoreUnavailable as error:
        raise _unavailable(error) from error


@router.get(
    "/projects/{project_id}/prompt-lab/resolved/{stage_id}",
    response_model=ResolvedPromptDraft,
)
async def get_resolved_prompt(
    project_id: str,
    stage_id: PromptStageId,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[PromptLabService, Depends(get_prompt_lab_service)],
) -> ResolvedPromptDraft:
    try:
        return await service.get_resolved_prompt(project_id, stage_id)
    except _NOT_FOUND_ERRORS as error:
        raise _not_found(error) from error
    except _STAGE_ERRORS as error:
        raise _stage_mismatch(error) from error
    except PromptLabStoreUnavailable as error:
        raise _unavailable(error) from error
