"""PostgreSQL persistence for immutable Creator Studio document revisions."""

from __future__ import annotations

from psycopg import AsyncConnection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from thoth_control_plane.domain.edit_documents import EditDocument


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
                return EditDocument.model_validate(row[0]) if row else None
        except Exception as error:
            raise EditDocumentPersistenceError() from error
