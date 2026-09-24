"""Authenticated routes for opening a projected Content Set as a Studio draft."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Request, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.api.routes.edit_documents import _revision_conflict
from thoth_control_plane.application.edit_documents import EditDocumentNotFound, EditorUnavailable
from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    StudioImportConflict,
    StudioImportDecisionRejected,
    StudioImportItemNotFound,
    StudioImportItemResolved,
    StudioImportSourceMismatch,
)
from thoth_control_plane.application.studio_imports import StudioImportService
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.edit_document_v2 import DocumentRevisionConflictBody
from thoth_control_plane.domain.studio_imports import (
    CreateStudioImport,
    ResolveStudioImportItem,
    StudioDraft,
    StudioDraftList,
    StudioImportInventory,
    StudioSourceInspection,
    StudioSourceProjection,
)

router = APIRouter()


def get_studio_import_service(request: Request) -> StudioImportService:
    return request.app.state.studio_import_service


def _error(status_code: int, code: str | None = None) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code} if code else None)


@router.post("/projects/{project_id}/studio-imports/inspect", response_model=StudioSourceInspection)
async def inspect_studio_import(
    project_id: str,
    payload: StudioSourceProjection,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[StudioImportService, Depends(get_studio_import_service)],
) -> StudioSourceInspection:
    """Read-only: the inventory to import and the drafts already made from this source."""
    try:
        return await service.inspect(project_id, payload)
    except EditorUnavailable as error:
        raise _error(status.HTTP_503_SERVICE_UNAVAILABLE) from error


@router.post(
    "/projects/{project_id}/studio-imports",
    response_model=StudioDraft,
    status_code=status.HTTP_201_CREATED,
)
async def create_studio_import(
    project_id: str,
    payload: CreateStudioImport,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[StudioImportService, Depends(get_studio_import_service)],
) -> StudioDraft:
    """Create one draft per key; replaying the key returns the same draft."""
    try:
        return await service.create(project_id, payload, idempotency_key)
    except ValidationError as error:
        # The key itself is never echoed back: it may carry caller-controlled text.
        raise _error(422, "invalid_idempotency_key") from error
    except StudioImportSourceMismatch as error:
        raise _error(status.HTTP_409_CONFLICT, "stale_source_key") from error
    except StudioImportConflict as error:
        raise _error(status.HTTP_409_CONFLICT, "studio_import_conflict") from error
    except EditorUnavailable as error:
        raise _error(status.HTTP_503_SERVICE_UNAVAILABLE) from error


@router.get(
    "/projects/{project_id}/studio-imports/documents/{document_id}",
    response_model=StudioImportInventory,
)
async def get_studio_import_inventory(
    project_id: str,
    document_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[StudioImportService, Depends(get_studio_import_service)],
) -> StudioImportInventory:
    try:
        return await service.get_inventory(project_id, document_id)
    except EditDocumentNotFound as error:
        raise _error(status.HTTP_404_NOT_FOUND) from error
    except EditorUnavailable as error:
        raise _error(status.HTTP_503_SERVICE_UNAVAILABLE) from error


@router.post(
    "/projects/{project_id}/studio-imports/documents/{document_id}/items/{item_id}/resolve",
    response_model=StudioImportInventory,
    responses={status.HTTP_409_CONFLICT: {"model": DocumentRevisionConflictBody}},
)
async def resolve_studio_import_item(
    project_id: str,
    document_id: str,
    item_id: str,
    payload: ResolveStudioImportItem,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[StudioImportService, Depends(get_studio_import_service)],
) -> StudioImportInventory | JSONResponse:
    """Record one explicit attach or exclude decision against the saved revision."""
    try:
        return await service.resolve(project_id, document_id, item_id, payload)
    except EditDocumentRevisionConflict as error:
        return _revision_conflict(error)
    except EditDocumentNotFound as error:
        raise _error(status.HTTP_404_NOT_FOUND) from error
    except StudioImportItemNotFound as error:
        raise _error(status.HTTP_404_NOT_FOUND, "import_item_not_found") from error
    except StudioImportItemResolved as error:
        raise _error(status.HTTP_409_CONFLICT, "import_item_resolved") from error
    except StudioImportDecisionRejected as error:
        raise _error(status.HTTP_409_CONFLICT, error.code) from error
    except EditorUnavailable as error:
        raise _error(status.HTTP_503_SERVICE_UNAVAILABLE) from error


@router.get("/projects/{project_id}/studio-imports/{source_key}", response_model=StudioDraftList)
async def list_studio_import_drafts(
    project_id: str,
    source_key: Annotated[str, Path(pattern=r"^[0-9a-f]{64}$")],
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[StudioImportService, Depends(get_studio_import_service)],
) -> StudioDraftList:
    """The newest drafts made from one source, for Resume."""
    try:
        return await service.list_drafts(project_id, source_key)
    except EditorUnavailable as error:
        raise _error(status.HTTP_503_SERVICE_UNAVAILABLE) from error
