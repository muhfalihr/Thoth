"""Authenticated, project-scoped listing of the assets a timeline may reference.

Only the locator-free projection leaves this router; the server-side record
stays behind the preview layer.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.application.editor_assets import (
    DEFAULT_ASSET_PAGE_LIMIT,
    EditorAssetNotFound,
    EditorAssetService,
    EditorAssetsUnavailable,
    ListEditorAssetsRequest,
)
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.editor_assets import ASSET_PAGE_LIMIT_MAX, EditorAssetPage
from thoth_control_plane.domain.models import StrictModel
from thoth_control_plane.infrastructure.editor_preview import (
    PREVIEW_COOKIE_NAME,
    EditorPreviewSigner,
    PreviewArtifactInvalid,
    PreviewCapabilityExpired,
    PreviewCapabilityInvalid,
    resolve_preview_path,
)

router = APIRouter()

#: Same-origin prefix used when an operator has not configured one explicitly.
DEFAULT_PREVIEW_BASE_URL = "/api/v1"

#: Nothing about the preview is cacheable, quotable, or sniffable.
PREVIEW_HEADERS = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}

#: Mirrors the application cursor contract so an unsafe value never reaches the store.
CursorQuery = Annotated[
    str | None,
    Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+=*$", description="Opaque page token"),
]

#: The capability arrives only here, never as a path segment or a query value.
CapabilityCookie = Annotated[str | None, Cookie(alias=PREVIEW_COOKIE_NAME, max_length=1024)]


class PreviewCapabilityResponse(StrictModel):
    """Where to fetch the media and when the issued capability stops working."""

    preview_url: str
    expires_at: datetime


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


def get_preview_signer(request: Request) -> EditorPreviewSigner:
    signer = request.app.state.editor_preview_signer
    if signer is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    return signer


def _preview_path(request: Request, project_id: str, asset_id: str) -> str:
    base = request.app.state.settings.THOTH_EDITOR_PREVIEW_BASE_URL or DEFAULT_PREVIEW_BASE_URL
    return f"{base}/projects/{project_id}/editor-assets/{asset_id}/preview"


async def _ready_record(service: EditorAssetService, project_id: str, asset_id: str):
    try:
        return await service.get_ready_record(project_id, asset_id)
    except EditorAssetNotFound as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND) from error
    except EditorAssetsUnavailable as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE) from error


@router.post(
    "/projects/{project_id}/editor-assets/{asset_id}/preview-capability",
    response_model=PreviewCapabilityResponse,
)
async def issue_editor_asset_preview_capability(
    project_id: str,
    asset_id: str,
    request: Request,
    _: Annotated[Actor, Depends(current_actor)],
    service: Annotated[EditorAssetService, Depends(get_editor_asset_service)],
    signer: Annotated[EditorPreviewSigner, Depends(get_preview_signer)],
) -> Response:
    """Mint a short-lived capability for one ready asset of one project."""
    await _ready_record(service, project_id, asset_id)
    settings = request.app.state.settings
    capability = signer.issue(
        project_id=project_id,
        asset_id=asset_id,
        now=datetime.now(tz=UTC),
    )
    preview_path = _preview_path(request, project_id, asset_id)
    body = PreviewCapabilityResponse(preview_url=preview_path, expires_at=capability.expires_at)
    response = JSONResponse(content=body.model_dump(mode="json"), headers=PREVIEW_HEADERS)
    response.set_cookie(
        key=PREVIEW_COOKIE_NAME,
        value=capability.token,
        max_age=settings.THOTH_EDITOR_PREVIEW_TTL_SECONDS,
        path=preview_path,
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
    )
    return response


@router.get(
    "/projects/{project_id}/editor-assets/{asset_id}/preview",
    response_class=FileResponse,
    responses={status.HTTP_200_OK: {"content": {"application/octet-stream": {}}}},
)
async def stream_editor_asset_preview(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[EditorAssetService, Depends(get_editor_asset_service)],
    signer: Annotated[EditorPreviewSigner, Depends(get_preview_signer)],
    capability: CapabilityCookie = None,
) -> Response:
    """Stream one previewable artifact, authorized solely by the asset-scoped cookie."""
    if capability is None:
        return _capability_refused(request, project_id, asset_id, clear=False)
    try:
        signer.verify(
            capability, project_id=project_id, asset_id=asset_id, now=datetime.now(tz=UTC)
        )
    except (PreviewCapabilityInvalid, PreviewCapabilityExpired):
        return _capability_refused(request, project_id, asset_id, clear=True)
    record = await _ready_record(service, project_id, asset_id)
    try:
        path = resolve_preview_path(
            request.app.state.settings.THOTH_CONTROL_PLANE_ARTIFACT_ROOT,
            record.artifact_location,
        )
    except PreviewArtifactInvalid as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"code": "asset_not_ready"}
        ) from error
    return FileResponse(path, media_type=record.asset.media_type, headers=PREVIEW_HEADERS)


def _capability_refused(
    request: Request, project_id: str, asset_id: str, *, clear: bool
) -> JSONResponse:
    """Refuse without ever repeating the supplied capability back to the caller."""
    response = JSONResponse(
        status_code=status.HTTP_403_FORBIDDEN,
        content={"detail": {"code": "preview_capability_required"}},
        headers=PREVIEW_HEADERS,
    )
    if clear:
        response.delete_cookie(
            key=PREVIEW_COOKIE_NAME,
            path=_preview_path(request, project_id, asset_id),
            httponly=True,
            samesite="strict",
        )
    return response
