"""Unit tests for immutable PostgreSQL edit-document persistence."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    EditDocumentUpgradeConflict,
)
from thoth_control_plane.domain.edit_document_operations import EditDocumentPatch
from thoth_control_plane.domain.edit_document_upgrade import upgrade_edit_document_v1
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1
from thoth_control_plane.infrastructure.editor_repository import (
    EditDocumentConflict,
    EditDocumentPersistenceError,
    PostgresEditDocumentRepository,
)


def document() -> EditDocumentV1:
    return EditDocumentV1.model_validate(
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
        asset_rows: list[tuple[Any, ...]] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.row = row
        self.rows = rows or []
        self.asset_rows = asset_rows or []
        self.error = error
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.calls.append((query, params))
        if self.error:
            raise self.error

    async def fetchone(self) -> tuple[dict[str, Any]] | None:
        return self.rows.pop(0) if self.rows else self.row

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.asset_rows


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_value = cursor

    async def __aenter__(self) -> Connection:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def cursor(self) -> Cursor:
        return self.cursor_value


class InterleavedStore:
    def __init__(self) -> None:
        self.current = document()
        self.lock = asyncio.Lock()
        self.first_insert_started = asyncio.Event()
        self.allow_first_insert = asyncio.Event()


class InterleavedCursor:
    def __init__(self, connection: InterleavedConnection, first: bool) -> None:
        self.connection = connection
        self.first = first

    async def execute(self, query: str, _: tuple[object, ...]) -> None:
        if "pg_advisory_xact_lock" in query:
            await self.connection.store.lock.acquire()
            self.connection.locked = True
        if "INSERT INTO edit_document_revisions" in query and self.first:
            pending = document().model_copy(deep=True)
            pending.revision = 2
            pending.clips[0].heading = "First title"
            pending.clips[0].ownership = "user_edited"
            self.connection.pending = pending
            self.connection.store.first_insert_started.set()
            await self.connection.store.allow_first_insert.wait()

    async def fetchone(self) -> tuple[dict[str, Any]]:
        return (self.connection.store.current.model_dump(mode="json"),)


class InterleavedConnection:
    def __init__(self, store: InterleavedStore, first: bool) -> None:
        self.store = store
        self.first = first
        self.locked = False
        self.pending: EditDocumentV1 | None = None

    async def __aenter__(self) -> InterleavedConnection:
        return self

    async def __aexit__(self, *_: object) -> None:
        if self.pending:
            self.store.current = self.pending
        if self.locked:
            self.store.lock.release()

    def cursor(self) -> InterleavedCursor:
        return InterleavedCursor(self, self.first)


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
    lock_query, lock_params = cursor.calls[0]
    assert "pg_advisory_xact_lock" in lock_query
    assert lock_params == ("project_001", "edoc_abc123")
    select_query, select_params = cursor.calls[1]
    assert "SELECT document_json" in select_query
    assert "FOR UPDATE" in select_query
    assert select_params == ("project_001", "edoc_abc123")
    insert_query, insert_params = cursor.calls[2]
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
    assert len(cursor.calls) == 2


@pytest.mark.asyncio
async def test_interleaved_stale_save_returns_latest_revision_conflict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InterleavedStore()
    connections = 0

    async def connect(_: str) -> InterleavedConnection:
        nonlocal connections
        connections += 1
        return InterleavedConnection(store, first=connections == 1)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )
    repository = PostgresEditDocumentRepository("postgresql://redacted")
    first = asyncio.create_task(
        repository.apply_operations(
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
                            "value": "First title",
                        }
                    ],
                }
            ).operations,
        )
    )
    await store.first_insert_started.wait()
    second = asyncio.create_task(
        repository.apply_operations(
            "project_001",
            "edoc_abc123",
            1,
            EditDocumentPatch.model_validate(
                {
                    "base_revision": 1,
                    "operations": [
                        {
                            "kind": "replace_text",
                            "operation_id": "op_002",
                            "clip_id": "clip_001",
                            "field": "heading",
                            "value": "Second title",
                        }
                    ],
                }
            ).operations,
        )
    )
    await asyncio.sleep(0)
    store.allow_first_insert.set()

    assert (await first).revision == 2
    with pytest.raises(EditDocumentRevisionConflict) as error:
        await second
    assert error.value.latest.revision == 2
    assert error.value.latest.clips[0].heading == "First title"


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


def timeline_document() -> EditDocumentV2:
    return upgrade_edit_document_v1(document())


def asset_row() -> tuple[Any, ...]:
    return ("asset_main", "video", 900, 1080, 1920, 30.0, True, "sha256:" + "a" * 64)


def add_clip_patch() -> list[Any]:
    return EditDocumentPatch.model_validate(
        {
            "base_revision": 1,
            "operations": [
                {
                    "kind": "add_clip_from_asset",
                    "operation_id": "op_1",
                    "clip_id": "clip_b_roll",
                    "track_id": "track_b_roll",
                    "asset_id": "asset_main",
                    "from_frame": 0,
                    "duration_in_frames": 60,
                }
            ],
        }
    ).operations


def repository(monkeypatch: pytest.MonkeyPatch, cursor: Cursor) -> PostgresEditDocumentRepository:
    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )
    return PostgresEditDocumentRepository("postgresql://redacted")


@pytest.mark.asyncio
async def test_apply_operations_resolves_assets_in_the_same_project_and_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(
        rows=[(timeline_document().model_dump(mode="json"),)],
        asset_rows=[asset_row()],
    )

    result = await repository(monkeypatch, cursor).apply_operations(
        "project_001", "edoc_abc123", 1, add_clip_patch()
    )

    query, params = cursor.calls[2]
    assert "FROM editor_assets" in query
    assert "WHERE project_id = %s" in query
    assert "validation_state = 'ready'" in query
    assert "artifact_location" not in query
    assert params == ("project_001", ["asset_main"])
    assert [ref.asset_id for ref in result.asset_refs] == ["asset_main"]
    assert result.revision == 2


@pytest.mark.asyncio
async def test_apply_operations_skips_the_asset_lookup_without_an_asset_operation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[(document().model_dump(mode="json"),)])
    patch = EditDocumentPatch.model_validate(
        {
            "base_revision": 1,
            "operations": [
                {
                    "kind": "replace_text",
                    "operation_id": "op_1",
                    "clip_id": "clip_001",
                    "field": "heading",
                    "value": "New title",
                }
            ],
        }
    )

    await repository(monkeypatch, cursor).apply_operations(
        "project_001", "edoc_abc123", 1, patch.operations
    )

    assert all("editor_assets" not in query for query, _ in cursor.calls)


@pytest.mark.asyncio
async def test_apply_operations_rejects_an_asset_missing_from_this_project(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[(timeline_document().model_dump(mode="json"),)], asset_rows=[])

    with pytest.raises(EditDocumentPersistenceError):
        await repository(monkeypatch, cursor).apply_operations(
            "project_001", "edoc_abc123", 1, add_clip_patch()
        )

    assert all("INSERT INTO edit_document_revisions" not in query for query, _ in cursor.calls)


@pytest.mark.asyncio
async def test_upgrade_locks_appends_one_version_two_revision_and_records_the_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[None, (document().model_dump(mode="json"),)])

    result = await repository(monkeypatch, cursor).upgrade_to_timeline(
        project_id="project_001",
        document_id="edoc_abc123",
        base_revision=1,
        idempotency_key="key_001",
    )

    queries = [query for query, _ in cursor.calls]
    assert "pg_advisory_xact_lock" in queries[0]
    assert "FROM edit_document_upgrade_idempotency" in queries[1]
    assert "FOR UPDATE" in queries[1]
    assert "FOR UPDATE" in queries[2]
    assert sum("INSERT INTO edit_document_revisions" in query for query in queries) == 1
    assert sum("INSERT INTO edit_document_upgrade_idempotency" in query for query in queries) == 1
    assert result.schema_version == 2
    assert result.revision == 2

    _, params = cursor.calls[-1]
    assert params[0] == "project_001"
    assert params[1] == "key_001"
    assert len(params[2]) == 64
    assert all(char in "0123456789abcdef" for char in params[2])
    assert params[3] == "edoc_abc123"
    assert params[4] == 2


@pytest.mark.asyncio
async def test_upgrade_replay_returns_the_recorded_revision_without_inserting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probe = Cursor(rows=[None, (document().model_dump(mode="json"),)])
    await repository(monkeypatch, probe).upgrade_to_timeline(
        project_id="project_001",
        document_id="edoc_abc123",
        base_revision=1,
        idempotency_key="key_001",
    )
    recorded_hash = probe.calls[-1][1][2]

    upgraded = timeline_document().model_dump(mode="json")
    upgraded["revision"] = 2
    cursor = Cursor(rows=[(recorded_hash, 2), (upgraded,)])

    result = await repository(monkeypatch, cursor).upgrade_to_timeline(
        project_id="project_001",
        document_id="edoc_abc123",
        base_revision=1,
        idempotency_key="key_001",
    )

    assert result.revision == 2
    assert result.schema_version == 2
    assert all("INSERT INTO" not in query for query, _ in cursor.calls)


@pytest.mark.asyncio
async def test_upgrade_conflicts_when_a_key_is_replayed_with_another_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[("b" * 64, 2)])

    with pytest.raises(EditDocumentUpgradeConflict):
        await repository(monkeypatch, cursor).upgrade_to_timeline(
            project_id="project_001",
            document_id="edoc_abc123",
            base_revision=1,
            idempotency_key="key_001",
        )

    assert all("INSERT INTO" not in query for query, _ in cursor.calls)


@pytest.mark.asyncio
async def test_upgrade_conflicts_when_the_base_revision_moved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    moved = document().model_dump(mode="json")
    moved["revision"] = 4
    cursor = Cursor(rows=[None, (moved,)])

    with pytest.raises(EditDocumentRevisionConflict) as conflict:
        await repository(monkeypatch, cursor).upgrade_to_timeline(
            project_id="project_001",
            document_id="edoc_abc123",
            base_revision=1,
            idempotency_key="key_001",
        )

    assert conflict.value.latest.revision == 4
    assert all("INSERT INTO" not in query for query, _ in cursor.calls)


@pytest.mark.asyncio
async def test_upgrade_conflicts_when_the_document_is_already_version_two(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[None, (timeline_document().model_dump(mode="json"),)])

    with pytest.raises(EditDocumentUpgradeConflict):
        await repository(monkeypatch, cursor).upgrade_to_timeline(
            project_id="project_001",
            document_id="edoc_abc123",
            base_revision=1,
            idempotency_key="key_001",
        )

    assert all("INSERT INTO" not in query for query, _ in cursor.calls)


@pytest.mark.asyncio
async def test_get_revision_reads_exactly_the_requested_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(row=(document().model_dump(mode="json"),))

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )

    result = await PostgresEditDocumentRepository("postgresql://redacted").get_revision(
        project_id="project_001", document_id="edoc_abc123", revision=1
    )

    assert result == document()
    query, params = cursor.calls[0]
    assert "revision = %s" in query
    assert "ORDER BY" not in query
    assert params == ("project_001", "edoc_abc123", 1)


@pytest.mark.asyncio
async def test_get_revision_returns_none_when_no_row_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(row=None)

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        connect,
    )

    result = await PostgresEditDocumentRepository("postgresql://redacted").get_revision(
        project_id="project_999", document_id="edoc_abc123", revision=7
    )

    assert result is None


@pytest.mark.asyncio
async def test_get_revision_never_leaks_the_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example/thoth")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_repository.AsyncConnection.connect",
        broken,
    )

    with pytest.raises(
        EditDocumentPersistenceError, match=r"^edit document persistence unavailable$"
    ):
        await PostgresEditDocumentRepository("postgresql://redacted").get_revision(
            project_id="project_001", document_id="edoc_abc123", revision=1
        )
