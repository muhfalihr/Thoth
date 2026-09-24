"""Typed outbound port for project-scoped editor asset storage."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from thoth_control_plane.domain.editor_assets import EditorAssetPage, EditorAssetRecord


class EditorAssetPersistenceError(Exception):
    """The asset store is unavailable, without leaking a path or a connection."""

    def __init__(self) -> None:
        super().__init__("editor asset unavailable")


class EditorAssetUploadTooLarge(Exception):
    """An upload crossed the fixed byte ceiling; nothing of it was kept."""


class EditorAssetMediaInvalid(Exception):
    """The upload is not media this project can use; ``code`` says which rule refused it."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ReceivedUpload:
    """One fully received upload, still in temporary storage below the artifact root."""

    location: str
    path: Path
    size_bytes: int
    checksum: str
    head: bytes


class EditorAssetRepository(Protocol):
    """Read boundary for validated assets a project may place on its timeline."""

    async def list_ready(
        self, *, project_id: str, limit: int, cursor: str | None
    ) -> EditorAssetPage: ...

    async def get_ready_record(
        self, *, project_id: str, asset_id: str
    ) -> EditorAssetRecord | None: ...

    async def get_ready_records(
        self, *, project_id: str, asset_ids: tuple[str, ...]
    ) -> tuple[EditorAssetRecord, ...]:
        """Read one bounded batch of ready records, in the requested order."""
        ...

    async def register_ready(self, record: EditorAssetRecord) -> None:
        """Insert one validated record; a failure must leave no row behind."""
        ...
