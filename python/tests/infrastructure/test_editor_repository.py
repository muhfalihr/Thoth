"""Unit tests for immutable PostgreSQL edit-document persistence."""

from __future__ import annotations

from typing import Any

import pytest

from thoth_control_plane.application.ports import EditDocumentRevisionConflict
from thoth_control_plane.domain.edit_document_operations import EditDocumentPatch
from thoth_control_plane.domain.edit_documents import EditDocument
from thoth_control_plane.infrastructure.editor_repository import (
    EditDocumentConflict,
    EditDocumentPersistenceError,
    PostgresEditDocumentRepository,
)


def document() -> EditDocument:
    return EditDocument.model_validate(
        {
            "schema_version": 1,
            "document_id": "edoc_abc123",
            "project_id": "project_001",
            "revision": 1,
            "template": {"template_id": "vertical_text_story", "version": 1},
            "canvas": {"width": 1080, "height": 1920, "fps": 30, "duration_in_frames": 150},
            "scenes": [
                {
                    "scene_id": "scene_001",
                    "role": "title",
                    "start_frame": 0,
                    "duration_in_frames": 150,
                    "clip_ids": ["clip_001"],
                }
            ],
            "tracks": [{"track_id": "track_visual", "kind": "visual", "clip_ids": ["clip_001"]}],
            "clips": [
                {
                    "kind": "text",
                    "clip_id": "clip_001",
                    "scene_id": "scene_001",
                    "track_id": "track_visual",
                    "start_frame": 0,
                    "duration_in_frames": 150,
                    "heading": "Title",
                    "body": "",
                    "style_slot": "title",
                    "ownership": "ai_managed",
                }
            ],
        }
    )


class Cursor:
    def __init__(
        self,
        *,
        row: tuple[dict[str, Any]] | None = None,
        rows: list[tuple[dict[str, Any]] | None] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.row = row
        self.rows = rows or []
        self.error = error
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.calls.append((query, params))
        if self.error:
            raise self.error

    async def fetchone(self) -> tuple[dict[str, Any]] | None:
        return self.rows.pop(0) if self.rows else self.row


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_value = cursor

    async def __aenter__(self) -> Connection:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def cursor(self) -> Cursor:
        return self.cursor_value


@pytest.mark.asyncio
async def test_insert_uses_parameterized_jsonb_statement(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = Cursor()

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )

    await PostgresEditDocumentRepository("postgresql://redacted").insert_revision(document())

    query, params = cursor.calls[0]
    assert "INSERT INTO edit_document_revisions" in query
    assert "%s" in query
    assert params[:3] == ("project_001", "edoc_abc123", 1)


@pytest.mark.asyncio
async def test_get_latest_validates_stored_json(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = Cursor(row=(document().model_dump(mode="json"),))

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )

    result = await PostgresEditDocumentRepository("postgresql://redacted").get_latest(
        project_id="project_001", document_id="edoc_abc123"
    )

    assert result == document()
    query, params = cursor.calls[0]
    assert "ORDER BY revision DESC LIMIT 1" in query
    assert params == ("project_001", "edoc_abc123")


@pytest.mark.asyncio
async def test_connection_errors_are_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect", broken
    )

    with pytest.raises(
        EditDocumentPersistenceError, match=r"^edit document persistence unavailable$"
    ):
        await PostgresEditDocumentRepository("postgresql://redacted").get_latest(
            project_id="project_001", document_id="edoc_abc123"
        )


def test_conflict_error_is_safe() -> None:
    assert str(EditDocumentConflict()) == "edit document revision already exists"


@pytest.mark.asyncio
async def test_apply_operations_locks_applies_and_appends_next_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[(document().model_dump(mode="json"),)])

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )

    result = await PostgresEditDocumentRepository("postgresql://redacted").apply_operations(
        "project_001",
        "edoc_abc123",
        1,
        EditDocumentPatch.model_validate(
            {
                "base_revision": 1,
                "operations": [
                    {
                        "kind": "replace_text",
                        "operation_id": "op_001",
                        "clip_id": "clip_001",
                        "field": "heading",
                        "value": "Revised title",
                    }
                ],
            }
        ).operations,
    )

    assert result.revision == 2
    assert result.clips[0].heading == "Revised title"
    assert result.clips[0].ownership == "user_edited"
    select_query, select_params = cursor.calls[0]
    assert "SELECT document_json" in select_query
    assert "FOR UPDATE" in select_query
    assert select_params == ("project_001", "edoc_abc123")
    insert_query, insert_params = cursor.calls[1]
    assert "INSERT INTO edit_document_revisions" in insert_query
    assert "%s" in insert_query
    assert insert_params[:3] == ("project_001", "edoc_abc123", 2)


@pytest.mark.asyncio
async def test_apply_operations_stale_revision_carries_latest_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = document().model_copy(update={"revision": 2})
    cursor = Cursor(rows=[(current.model_dump(mode="json"),)])

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )

    with pytest.raises(EditDocumentRevisionConflict) as error:
        await PostgresEditDocumentRepository("postgresql://redacted").apply_operations(
            "project_001", "edoc_abc123", 1, []
        )

    assert error.value.latest == current
    assert len(cursor.calls) == 1


@pytest.mark.asyncio
async def test_apply_operations_invalid_stored_json_is_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[({"revision": "invalid"},)])

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )

    with pytest.raises(
        EditDocumentPersistenceError, match=r"^edit document persistence unavailable$"
    ):
        await PostgresEditDocumentRepository("postgresql://redacted").apply_operations(
            "project_001", "edoc_abc123", 1, []
        )


@pytest.mark.asyncio
async def test_apply_operations_connection_errors_are_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect", broken
    )

    with pytest.raises(
        EditDocumentPersistenceError, match=r"^edit document persistence unavailable$"
    ):
        await PostgresEditDocumentRepository("postgresql://redacted").apply_operations(
            "project_001", "edoc_abc123", 1, []
        )


def test_revision_conflict_error_is_safe() -> None:
    assert str(EditDocumentRevisionConflict(document())) == "edit document revision conflict"
