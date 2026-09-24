"""PostgreSQL persistence for Studio drafts, their source inventory, and item decisions."""

from __future__ import annotations

from typing import Any

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from pydantic import TypeAdapter

from thoth_control_plane.application.edit_documents import EditDocumentNotFound
from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    StudioImportConflict,
    StudioImportDecisionRejected,
    StudioImportItemNotFound,
    StudioImportItemResolved,
)
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.studio_imports import (
    AttachImportAsset,
    ExcludeImportItem,
    StudioDraft,
    StudioImportInventory,
    StudioImportItem,
)
from thoth_control_plane.infrastructure.editor_repository import (
    DOCUMENT_ADAPTER,
    EditDocumentPersistenceError,
    PostgresEditDocumentRepository,
)

INVENTORY_ADAPTER: TypeAdapter[list[StudioImportItem]] = TypeAdapter(list[StudioImportItem])
TYPED = (
    EditDocumentNotFound,
    EditDocumentRevisionConflict,
    StudioImportConflict,
    StudioImportDecisionRejected,
    StudioImportItemNotFound,
    StudioImportItemResolved,
)

# Every draft query reports the document's latest revision, never the first one.
_DRAFT_COLUMNS = """
    d.document_id, d.source_key, d.created_at,
    (SELECT max(r.revision) FROM edit_document_revisions r
     WHERE r.project_id = d.project_id AND r.document_id = d.document_id)
"""


def _draft(row: Any) -> StudioDraft:
    return StudioDraft(document_id=row[0], source_key=row[1], created_at=row[2], revision=row[3])


class PostgresStudioImportRepository:
    """Open one short-lived async connection per operation; rows are never updated."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def create_draft(
        self,
        *,
        project_id: str,
        source_key: str,
        idempotency_key: str,
        document: EditDocumentV2,
        inventory: list[StudioImportItem],
    ) -> StudioDraft:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                    (project_id, f"studio-import:{idempotency_key}"),
                )
                await cursor.execute(
                    f"""
                    SELECT {_DRAFT_COLUMNS}
                    FROM studio_import_drafts d
                    WHERE d.project_id = %s AND d.idempotency_key = %s
                    """,
                    (project_id, idempotency_key),
                )
                recorded = await cursor.fetchone()
                if recorded is not None:
                    if recorded[1] != source_key:
                        raise StudioImportConflict()
                    return _draft(recorded)

                await PostgresEditDocumentRepository._insert_revision(cursor, document)
                await cursor.execute(
                    """
                    INSERT INTO studio_import_drafts
                        (project_id, document_id, first_revision, source_key, idempotency_key,
                         inventory)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING created_at
                    """,
                    (
                        project_id,
                        document.document_id,
                        document.revision,
                        source_key,
                        idempotency_key,
                        Jsonb([entry.model_dump(mode="json") for entry in inventory]),
                    ),
                )
                created = await cursor.fetchone()
                if created is None:
                    raise EditDocumentPersistenceError()
                return StudioDraft(
                    document_id=document.document_id,
                    source_key=source_key,
                    revision=document.revision,
                    created_at=created[0],
                )
        except TYPED:
            raise
        except EditDocumentPersistenceError:
            raise
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    async def list_drafts(
        self, *, project_id: str, source_key: str, limit: int
    ) -> list[StudioDraft]:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    f"""
                    SELECT {_DRAFT_COLUMNS}
                    FROM studio_import_drafts d
                    WHERE d.project_id = %s AND d.source_key = %s
                    ORDER BY d.created_at DESC, d.document_id DESC
                    LIMIT %s
                    """,
                    (project_id, source_key, limit),
                )
                return [_draft(row) for row in await cursor.fetchall()]
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    async def get_inventory(
        self, *, project_id: str, document_id: str
    ) -> StudioImportInventory | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                return await self._inventory(connection.cursor(), project_id, document_id)
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    async def resolve_item(
        self,
        *,
        project_id: str,
        document_id: str,
        item_id: str,
        base_revision: int,
        decision: ExcludeImportItem | AttachImportAsset,
    ) -> StudioImportInventory:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                # The editor's own lock: no patch can land between the check and the insert.
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                    (project_id, document_id),
                )
                current = await self._inventory(cursor, project_id, document_id)
                if current is None:
                    raise EditDocumentNotFound()
                entry = next((item for item in current.items if item.item_id == item_id), None)
                if entry is None:
                    raise StudioImportItemNotFound()
                if entry.disposition != "unresolved":
                    raise StudioImportItemResolved()
                if isinstance(decision, AttachImportAsset):
                    if entry.media_kind == "none":
                        raise StudioImportDecisionRejected("item_not_attachable")
                    # ponytail: attaching lands with the project-scoped upload path (Task 4).
                    raise StudioImportDecisionRejected("attach_unavailable")

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
                # Excluding changes no content; the new revision records when it was decided.
                result = DOCUMENT_ADAPTER.validate_python(
                    {**latest.model_dump(mode="json"), "revision": latest.revision + 1}
                )
                await PostgresEditDocumentRepository._insert_revision(cursor, result)
                await cursor.execute(
                    """
                    INSERT INTO studio_import_decisions
                        (project_id, document_id, item_id, revision, disposition, asset_id)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (project_id, document_id, item_id, result.revision, "excluded", None),
                )
                return current.model_copy(
                    update={
                        "revision": result.revision,
                        "items": [
                            item.model_copy(update={"disposition": "excluded"})
                            if item.item_id == item_id
                            else item
                            for item in current.items
                        ],
                    }
                )
        except TYPED:
            raise
        except EditDocumentPersistenceError:
            raise
        except Exception as error:
            raise EditDocumentPersistenceError() from error

    @staticmethod
    async def _inventory(
        cursor: Any, project_id: str, document_id: str
    ) -> StudioImportInventory | None:
        await cursor.execute(
            """
            SELECT d.source_key, d.inventory,
                (SELECT max(r.revision) FROM edit_document_revisions r
                 WHERE r.project_id = d.project_id AND r.document_id = d.document_id)
            FROM studio_import_drafts d
            WHERE d.project_id = %s AND d.document_id = %s
            """,
            (project_id, document_id),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        await cursor.execute(
            """
            SELECT item_id, disposition, asset_id
            FROM studio_import_decisions
            WHERE project_id = %s AND document_id = %s
            """,
            (project_id, document_id),
        )
        decided = {
            item_id: (disposition, asset_id)
            for item_id, disposition, asset_id in await cursor.fetchall()
        }
        items = [
            item.model_copy(
                update={
                    "disposition": decided[item.item_id][0],
                    "asset_id": decided[item.item_id][1],
                }
            )
            if item.item_id in decided
            else item
            for item in INVENTORY_ADAPTER.validate_python(row[1])
        ]
        return StudioImportInventory(
            document_id=document_id, source_key=row[0], revision=row[2], items=items
        )
