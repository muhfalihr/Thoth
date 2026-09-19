"""Authenticated, project-scoped listing of the assets a timeline may reference.

Only the locator-free projection leaves this router; the server-side record
stays behind the preview layer.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.application.editor_assets import (
    DEFAULT_ASSET_PAGE_LIMIT,
    EditorAssetService,
    EditorAssetsUnavailable,
    ListEditorAssetsRequest,
)
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.editor_assets import ASSET_PAGE_LIMIT_MAX, EditorAssetPage

router = APIRouter()

#: Mirrors the application cursor contract so an unsafe value never reaches the store.
CursorQuery = Annotated[
    str | None,
    Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+=*$", description="Opaque page token"),
]


def get_editor_asset_service(request: Request) -> EditorAssetService:
    return request.app.state.editor_asset_service


@router.get("/projects/{project_id}/editor-assets", response_model=EditorAssetPage)
async def list_editor_assets(
    project_id: str,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[EditorAssetService, Depends(get_editor_asset_service)],
    limit: Annotated[int, Query(ge=1, le=ASSET_PAGE_LIMIT_MAX)] = DEFAULT_ASSET_PAGE_LIMIT,
    cursor: CursorQuery = None,
) -> EditorAssetPage:
    try:
        return await service.list_ready(
            project_id, ListEditorAssetsRequest(limit=limit, cursor=cursor)
        )
    except EditorAssetsUnavailable as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE) from error
