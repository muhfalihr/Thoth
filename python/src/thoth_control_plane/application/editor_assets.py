"""Application service for the validated assets a project may place on its timeline.

This service never opens, reads, probes, or resolves an artifact file. It
validates the request, keeps every lookup project-scoped, and returns public
models; only the preview layer consumes the server-side record.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated

from pydantic import Field

from thoth_control_plane.domain.editor_assets import (
    ASSET_PAGE_LIMIT_MAX,
    EditorAssetPage,
    EditorAssetRecord,
)
from thoth_control_plane.domain.models import OpaqueId, ProjectId, StrictModel

if TYPE_CHECKING:
    from thoth_control_plane.application.editor_asset_ports import EditorAssetRepository

DEFAULT_ASSET_PAGE_LIMIT = 20


class EditorAssetNotFound(Exception):
    """No ready asset with that identity exists for this project."""


class EditorAssetsUnavailable(Exception):
    """The asset store is not configured or not reachable."""

    def __init__(self) -> None:
        super().__init__("editor assets unavailable")


class ListEditorAssetsRequest(StrictModel):
    """A bounded catalog page request. The cursor is opaque and base64url-shaped."""

    limit: Annotated[int, Field(ge=1, le=ASSET_PAGE_LIMIT_MAX)] = DEFAULT_ASSET_PAGE_LIMIT
    cursor: Annotated[str, Field(max_length=512, pattern=r"^[A-Za-z0-9_-]+=*$")] | None = None


class EditorAssetService:
    """Project-scoped read service over the validated asset catalog."""

    def __init__(self, repository: EditorAssetRepository | None) -> None:
        self._repository = repository

    async def list_ready(
        self, project_id: ProjectId, request: ListEditorAssetsRequest
    ) -> EditorAssetPage:
        if self._repository is None:
            raise EditorAssetsUnavailable()
        try:
            return await self._repository.list_ready(
                project_id=project_id, limit=request.limit, cursor=request.cursor
            )
        except Exception as error:
            raise EditorAssetsUnavailable() from error

    async def get_ready_record(
        self, project_id: ProjectId, asset_id: OpaqueId
    ) -> EditorAssetRecord:
        """Return the server-side record, hiding an unknown or unvalidated asset."""
        if self._repository is None:
            raise EditorAssetsUnavailable()
        try:
            record = await self._repository.get_ready_record(
                project_id=project_id, asset_id=asset_id
            )
        except Exception as error:
            raise EditorAssetsUnavailable() from error
        if record is None or record.asset.validation_state != "ready":
            raise EditorAssetNotFound()
        return record
