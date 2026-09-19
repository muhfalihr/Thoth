"""PostgreSQL reads for the validated assets a project may place on its timeline."""

from __future__ import annotations

import base64
from datetime import datetime
from typing import Any

from psycopg import AsyncConnection

from thoth_control_plane.application.editor_asset_ports import EditorAssetPersistenceError
from thoth_control_plane.domain.editor_assets import (
    ASSET_PAGE_LIMIT_MAX,
    EditorAsset,
    EditorAssetPage,
    EditorAssetRecord,
)

#: Public columns, in row order. ``artifact_location`` is deliberately absent:
#: a listing must never be able to return a locator.
PUBLIC_COLUMNS = (
    "asset_id, project_id, kind, media_type, duration_in_frames, width, height, "
    "fps, has_audio, validation_state, checksum"
)

_PUBLIC_FIELDS = tuple(column.strip() for column in PUBLIC_COLUMNS.split(","))


def _cursor_token(created_at: datetime, asset_id: str) -> str:
    raw = f"{created_at.isoformat()}|{asset_id}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
    created_at_raw, asset_id = raw.split("|", 1)
    return datetime.fromisoformat(created_at_raw), asset_id


def _asset(row: tuple[Any, ...]) -> EditorAsset:
    return EditorAsset.model_validate(dict(zip(_PUBLIC_FIELDS, row, strict=False)))


class PostgresEditorAssetRepository:
    """Open one short-lived async connection per read, scoped to a single project."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def list_ready(
        self, *, project_id: str, limit: int, cursor: str | None
    ) -> EditorAssetPage:
        clamped = max(1, min(int(limit), ASSET_PAGE_LIMIT_MAX))
        try:
            keyset = _decode_cursor(cursor) if cursor else None
            query = f"""
                SELECT {PUBLIC_COLUMNS}, created_at
                FROM editor_assets
                WHERE project_id = %s AND validation_state = 'ready'
                {"AND (created_at, asset_id) < (%s, %s)" if keyset else ""}
                ORDER BY created_at DESC, asset_id DESC
                LIMIT %s
            """
            params = (project_id, *keyset, clamped + 1) if keyset else (project_id, clamped + 1)

            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                database_cursor = connection.cursor()
                await database_cursor.execute(query, params)
                rows = await database_cursor.fetchall()
        except Exception as error:
            raise EditorAssetPersistenceError() from error

        page = rows[:clamped]
        next_cursor = _cursor_token(page[-1][-1], page[-1][0]) if len(rows) > clamped else None
        return EditorAssetPage(assets=tuple(_asset(row) for row in page), next_cursor=next_cursor)

    async def get_ready_record(self, *, project_id: str, asset_id: str) -> EditorAssetRecord | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                database_cursor = connection.cursor()
                await database_cursor.execute(
                    f"""
                    SELECT {PUBLIC_COLUMNS}, artifact_location, provenance
                    FROM editor_assets
                    WHERE project_id = %s AND asset_id = %s AND validation_state = 'ready'
                    """,
                    (project_id, asset_id),
                )
                row = await database_cursor.fetchone()
                if row is None:
                    return None
                return EditorAssetRecord(
                    asset=_asset(row),
                    artifact_location=row[-2],
                    provenance=row[-1],
                )
        except Exception as error:
            raise EditorAssetPersistenceError() from error
