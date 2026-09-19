"""PostgreSQL persistence for immutable Creator Studio document revisions."""

from __future__ import annotations

import hashlib
from typing import Any

from psycopg import AsyncConnection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import TypeAdapter

from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    EditDocumentUpgradeConflict,
)
from thoth_control_plane.domain.edit_document_operations import (
    EditDocumentOperation,
    apply_edit_operations,
)
from thoth_control_plane.domain.edit_document_upgrade import upgrade_edit_document_v1
from thoth_control_plane.domain.edit_document_v2 import AssetRef, EditDocument, EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1
from thoth_control_plane.domain.timeline_operations import AddClipFromAsset

DOCUMENT_ADAPTER: TypeAdapter[EditDocument] = TypeAdapter(EditDocument)

#: Asset columns the operation engine is allowed to see. The artifact locator
#: is never selected here, so it cannot reach a persisted document.
SAFE_ASSET_COLUMNS = "asset_id, kind, duration_in_frames, width, height, fps, has_audio, checksum"


def _upgrade_payload_hash(project_id: str, document_id: str, base_revision: int) -> str:
    """Hash the canonical upgrade request so no raw request is ever retained."""
    canonical = f"{project_id}|{document_id}|{base_revision}".encode()
    return hashlib.sha256(canonical).hexdigest()


class EditDocumentConflict(Exception):
    """A revision already exists and cannot be overwritten."""

    def __init__(self) -> None:
        super().__init__("edit document revision already exists")


class EditDocumentPersistenceError(Exception):
    """The editor store is unavailable without leaking connection details."""

    def __init__(self) -> None:
        super().__init__("edit document persistence unavailable")


class PostgresEditDocumentRepository:
    """Open one short-lived async connection per immutable repository operation."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def insert_revision(self, document: EditDocument) -> None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    INSERT INTO edit_document_revisions
                        (project_id, document_id, revision, document_json)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (
                        document.project_id,
                        document.document_id,
                        document.revision,
                        Jsonb(document.model_dump(mode="json")),
                    ),
                )
        except UniqueViolation as error:
            raise EditDocumentConflict() from error
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    async def get_latest(self, *, project_id: str, document_id: str) -> EditDocument | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT document_json
                    FROM edit_document_revisions
                    WHERE project_id = %s AND document_id = %s
                    ORDER BY revision DESC LIMIT 1
                    """,
                    (project_id, document_id),
                )
                row = await cursor.fetchone()
                return DOCUMENT_ADAPTER.validate_python(row[0]) if row else None
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    async def apply_operations(
        self,
        project_id: str,
        document_id: str,
        base_revision: int,
        operations: list[EditDocumentOperation],
    ) -> EditDocument:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))
                    """,
                    (project_id, document_id),
                )
                await cursor.execute(
                    """
                    SELECT document_json
                    FROM edit_document_revisions
                    WHERE project_id = %s AND document_id = %s
                    ORDER BY revision DESC LIMIT 1
                    FOR UPDATE
                    """,
                    (project_id, document_id),
                )
                row = await cursor.fetchone()
                if row is None:
                    raise EditDocumentPersistenceError()
                latest = DOCUMENT_ADAPTER.validate_python(row[0])
                if latest.revision != base_revision:
                    raise EditDocumentRevisionConflict(latest)
                resolved = await self._resolve_assets(cursor, project_id, operations)
                updated = apply_edit_operations(latest, operations, resolved_assets=resolved)
                result = DOCUMENT_ADAPTER.validate_python(
                    {**updated.model_dump(mode="json"), "revision": latest.revision + 1}
                )
                await self._insert_revision(cursor, result)
                return result
        except EditDocumentRevisionConflict:
            raise
        except EditDocumentPersistenceError:
            raise
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    async def upgrade_to_timeline(
        self,
        *,
        project_id: str,
        document_id: str,
        base_revision: int,
        idempotency_key: str,
    ) -> EditDocument:
        """Append exactly one version 2 revision, replaying a recorded key safely."""
        payload_hash = _upgrade_payload_hash(project_id, document_id, base_revision)
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))
                    """,
                    (project_id, document_id),
                )
                await cursor.execute(
                    """
                    SELECT payload_hash, result_revision
                    FROM edit_document_upgrade_idempotency
                    WHERE project_id = %s AND idempotency_key = %s
                    FOR UPDATE
                    """,
                    (project_id, idempotency_key),
                )
                recorded = await cursor.fetchone()
                if recorded is not None:
                    if recorded[0] != payload_hash:
                        raise EditDocumentUpgradeConflict()
                    return await self._revision(cursor, project_id, document_id, recorded[1])

                await cursor.execute(
                    """
                    SELECT document_json
                    FROM edit_document_revisions
                    WHERE project_id = %s AND document_id = %s
                    ORDER BY revision DESC LIMIT 1
                    FOR UPDATE
                    """,
                    (project_id, document_id),
                )
                row = await cursor.fetchone()
                if row is None:
                    raise EditDocumentPersistenceError()
                latest = DOCUMENT_ADAPTER.validate_python(row[0])
                if not isinstance(latest, EditDocumentV1):
                    raise EditDocumentUpgradeConflict()
                if latest.revision != base_revision:
                    raise EditDocumentRevisionConflict(latest)

                upgraded = upgrade_edit_document_v1(latest)
                result = EditDocumentV2.model_validate(
                    {**upgraded.model_dump(mode="json"), "revision": latest.revision + 1}
                )
                await self._insert_revision(cursor, result)
                await cursor.execute(
                    """
                    INSERT INTO edit_document_upgrade_idempotency
                        (project_id, idempotency_key, payload_hash, document_id, result_revision)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (project_id, idempotency_key, payload_hash, document_id, result.revision),
                )
                return result
        except (EditDocumentRevisionConflict, EditDocumentUpgradeConflict):
            raise
        except EditDocumentPersistenceError:
            raise
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    @staticmethod
    async def _insert_revision(cursor: Any, document: EditDocument) -> None:
        await cursor.execute(
            """
            INSERT INTO edit_document_revisions
                (project_id, document_id, revision, document_json)
            VALUES (%s, %s, %s, %s)
            """,
            (
                document.project_id,
                document.document_id,
                document.revision,
                Jsonb(document.model_dump(mode="json")),
            ),
        )

    @staticmethod
    async def _revision(
        cursor: Any, project_id: str, document_id: str, revision: int
    ) -> EditDocument:
        await cursor.execute(
            """
            SELECT document_json
            FROM edit_document_revisions
            WHERE project_id = %s AND document_id = %s AND revision = %s
            """,
            (project_id, document_id, revision),
        )
        row = await cursor.fetchone()
        if row is None:
            raise EditDocumentPersistenceError()
        return DOCUMENT_ADAPTER.validate_python(row[0])

    @staticmethod
    async def _resolve_assets(
        cursor: Any, project_id: str, operations: list[EditDocumentOperation]
    ) -> dict[str, AssetRef]:
        """Resolve every referenced asset inside the caller's transaction.

        Only assets that are both owned by ``project_id`` and ``ready`` come
        back, and only as safe projections: the operation engine never sees an
        artifact locator, so a locator cannot enter a persisted document.
        """
        asset_ids = sorted(
            {
                operation.asset_id
                for operation in operations
                if isinstance(operation, AddClipFromAsset)
            }
        )
        if not asset_ids:
            return {}

        await cursor.execute(
            f"""
            SELECT {SAFE_ASSET_COLUMNS}
            FROM editor_assets
            WHERE project_id = %s AND validation_state = 'ready' AND asset_id = ANY(%s)
            """,
            (project_id, asset_ids),
        )
        rows = await cursor.fetchall()
        return {
            row[0]: AssetRef(
                asset_id=row[0],
                project_id=project_id,
                kind=row[1],
                duration_in_frames=row[2],
                width=row[3],
                height=row[4],
                fps=row[5],
                has_audio=row[6],
                validation_state="ready",
                checksum=row[7],
            )
            for row in rows
        }
