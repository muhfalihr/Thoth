"""Typed outbound port for project-scoped editor asset storage."""

from typing import Protocol

from thoth_control_plane.domain.editor_assets import EditorAssetPage, EditorAssetRecord


class EditorAssetPersistenceError(Exception):
    """The asset store is unavailable, without leaking a path or a connection."""

    def __init__(self) -> None:
        super().__init__("editor asset unavailable")


class EditorAssetRepository(Protocol):
    """Read boundary for validated assets a project may place on its timeline."""

    async def list_ready(
        self, *, project_id: str, limit: int, cursor: str | None
    ) -> EditorAssetPage: ...

    async def get_ready_record(
        self, *, project_id: str, asset_id: str
    ) -> EditorAssetRecord | None: ...
