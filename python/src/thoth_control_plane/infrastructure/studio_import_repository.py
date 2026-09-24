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
from thoth_control_plane.domain.edit_document_operations import apply_edit_operations
from thoth_control_plane.domain.edit_document_v2 import EditDocument, EditDocumentV2
from thoth_control_plane.domain.studio_imports import (
    AttachImportAsset,
    ExcludeImportItem,
    StudioDraft,
    StudioImportInventory,
    StudioImportItem,
)
from thoth_control_plane.domain.timeline_operations import AddClipFromAsset
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
                asset_id = decision.asset_id if isinstance(decision, AttachImportAsset) else None
                disposition = "excluded" if asset_id is None else "attached"
                if asset_id and (entry.media_kind == "none" or entry.scene_id is None):
                    raise StudioImportDecisionRejected("item_not_attachable")

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
                updated = (
                    latest
                    if asset_id is None
                    else await self._attached(cursor, latest, entry, asset_id)
                )
                result = DOCUMENT_ADAPTER.validate_python(
                    {**updated.model_dump(mode="json"), "revision": latest.revision + 1}
                )
                await PostgresEditDocumentRepository._insert_revision(cursor, result)
                await cursor.execute(
                    """
                    INSERT INTO studio_import_decisions
                        (project_id, document_id, item_id, revision, disposition, asset_id)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        project_id,
                        document_id,
                        item_id,
                        result.revision,
                        disposition,
                        asset_id,
                    ),
                )
                return current.model_copy(
                    update={
                        "revision": result.revision,
                        "items": [
                            item.model_copy(
                                update={"disposition": disposition, "asset_id": asset_id}
                            )
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
    async def _attached(
        cursor: Any, latest: EditDocument, entry: StudioImportItem, asset_id: str
    ) -> EditDocument:
        """``latest`` with the item's ready asset spanning its scene, capped at the asset length.

        The main item fills the main video track; every other item is b-roll over its scene.
        """
        asset = (
            await PostgresEditDocumentRepository.ready_assets(cursor, latest.project_id, [asset_id])
        ).get(asset_id)
        if asset is None:
            raise StudioImportDecisionRejected("asset_unavailable")
        if asset.kind != entry.media_kind:
            raise StudioImportDecisionRejected("asset_kind_mismatch")
        scene = next((scene for scene in latest.scenes if scene.scene_id == entry.scene_id), None)
        if scene is None:
            raise StudioImportDecisionRejected("item_not_attachable")
        operation = AddClipFromAsset(
            kind="add_clip_from_asset",
            operation_id=f"attach_{entry.item_id}",
            clip_id=f"clip_{entry.item_id}",
            track_id="track_main_video" if entry.role == "main" else "track_b_roll",
            asset_id=asset_id,
            from_frame=scene.start_frame,
            duration_in_frames=min(
                scene.duration_in_frames, asset.duration_in_frames or scene.duration_in_frames
            ),
            scene_id=scene.scene_id,
        )
        try:
            return apply_edit_operations(latest, [operation], resolved_assets={asset_id: asset})
        except ValueError as error:
            raise StudioImportDecisionRejected("attach_rejected") from error

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
