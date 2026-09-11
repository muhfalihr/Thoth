"""Authenticated Creator Studio import and immutable-document retrieval routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.application.edit_documents import (
    ContentSetImportRequest,
    EditDocumentNotFound,
    EditDocumentService,
    EditorUnavailable,
)
from thoth_control_plane.application.ports import EditDocumentRevisionConflict
from thoth_control_plane.domain import Actor, EditDocument
from thoth_control_plane.domain.edit_document_operations import EditDocumentPatch

router = APIRouter()


def get_edit_document_service(request: Request) -> EditDocumentService:
    return request.app.state.edit_document_service


@router.post(
    "/projects/{project_id}/edit-documents/import-content-set",
    response_model=EditDocument,
    status_code=status.HTTP_201_CREATED,
)
async def import_content_set(
    project_id: str,
    payload: ContentSetImportRequest,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[EditDocumentService, Depends(get_edit_document_service)],
) -> EditDocument:
    try:
        return await service.import_content_set(project_id, payload)
    except EditorUnavailable as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE) from error


@router.get("/projects/{project_id}/edit-documents/{document_id}", response_model=EditDocument)
async def get_edit_document(
    project_id: str,
    document_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[EditDocumentService, Depends(get_edit_document_service)],
) -> EditDocument:
    try:
        return await service.get_latest(project_id, document_id)
    except EditDocumentNotFound as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from error
    except EditorUnavailable as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE) from error


@router.patch(
    "/projects/{project_id}/edit-documents/{document_id}",
    response_model=EditDocument,
    responses={status.HTTP_409_CONFLICT: {"model": EditDocument}},
)
async def apply_edit_document_patch(
    project_id: str,
    document_id: str,
    patch: EditDocumentPatch,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[EditDocumentService, Depends(get_edit_document_service)],
) -> EditDocument | JSONResponse:
    try:
        return await service.apply_patch(project_id, document_id, patch)
    except EditDocumentNotFound as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from error
    except EditDocumentRevisionConflict as error:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT, content=error.latest.model_dump(mode="json")
        )
    except EditorUnavailable as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE) from error
