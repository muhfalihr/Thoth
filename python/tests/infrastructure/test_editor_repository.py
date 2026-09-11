"""Unit tests for immutable PostgreSQL edit-document persistence."""

from __future__ import annotations

from typing import Any

import pytest

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
        self, *, row: tuple[dict[str, Any]] | None = None, error: Exception | None = None
    ) -> None:
        self.row = row
        self.error = error
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.calls.append((query, params))
        if self.error:
            raise self.error

    async def fetchone(self) -> tuple[dict[str, Any]] | None:
        return self.row


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
