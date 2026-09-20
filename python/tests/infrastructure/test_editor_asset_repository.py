"""Unit tests for project-scoped PostgreSQL editor-asset persistence."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from thoth_control_plane.application.editor_asset_ports import EditorAssetPersistenceError
from thoth_control_plane.domain.editor_assets import ASSET_PAGE_LIMIT_MAX
from thoth_control_plane.infrastructure.editor_asset_repository import (
    PostgresEditorAssetRepository,
)

CREATED_AT = datetime(2026, 9, 19, 12, 0, tzinfo=UTC)


def public_row(asset_id: str = "asset_main", **overrides: Any) -> tuple[Any, ...]:
    values: dict[str, Any] = {
        "asset_id": asset_id,
        "project_id": "project_001",
        "kind": "video",
        "media_type": "video/mp4",
        "duration_in_frames": 900,
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
        "has_audio": True,
        "validation_state": "ready",
        "checksum": "sha256:" + "a" * 64,
        "created_at": CREATED_AT,
    }
    values.update(overrides)
    return tuple(values.values())


def record_row(**overrides: Any) -> tuple[Any, ...]:
    values: dict[str, Any] = {
        "asset_id": "asset_main",
        "project_id": "project_001",
        "kind": "video",
        "media_type": "video/mp4",
        "duration_in_frames": 900,
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
        "has_audio": True,
        "validation_state": "ready",
        "checksum": "sha256:" + "a" * 64,
        "artifact_location": "project_001/asset_main.mp4",
        "provenance": "operator_upload",
    }
    values.update(overrides)
    return tuple(values.values())


class Cursor:
    def __init__(
        self,
        *,
        row: tuple[Any, ...] | None = None,
        rows: list[tuple[Any, ...]] | None = None,
    ) -> None:
        self.row = row
        self.rows = rows or []
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.calls.append((query, params))

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.row

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_value = cursor

    async def __aenter__(self) -> Connection:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def cursor(self) -> Cursor:
        return self.cursor_value


def patched(monkeypatch: pytest.MonkeyPatch, cursor: Cursor) -> PostgresEditorAssetRepository:
    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_asset_repository.AsyncConnection.connect",
        connect,
    )
    return PostgresEditorAssetRepository("postgresql://redacted")


@pytest.mark.asyncio
async def test_list_ready_is_project_scoped_parameterized_and_locator_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[public_row()])

    page = await patched(monkeypatch, cursor).list_ready(
        project_id="project_001", limit=10, cursor=None
    )

    query, params = cursor.calls[0]
    assert "FROM editor_assets" in query
    assert "WHERE project_id = %s" in query
    assert "validation_state = 'ready'" in query
    assert "artifact_location" not in query
    assert "ORDER BY created_at DESC, asset_id DESC" in query
    assert params == ("project_001", 11)
    assert [asset.asset_id for asset in page.assets] == ["asset_main"]
    assert page.next_cursor is None
    assert "artifact_location" not in page.assets[0].model_dump()


@pytest.mark.asyncio
async def test_list_ready_clamps_the_page_size_and_emits_an_opaque_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [public_row(f"asset_{index:03d}") for index in range(ASSET_PAGE_LIMIT_MAX + 1)]
    cursor = Cursor(rows=rows)

    page = await patched(monkeypatch, cursor).list_ready(
        project_id="project_001", limit=10_000, cursor=None
    )

    assert cursor.calls[0][1] == ("project_001", ASSET_PAGE_LIMIT_MAX + 1)
    assert len(page.assets) == ASSET_PAGE_LIMIT_MAX
    assert page.next_cursor is not None
    assert "asset_" not in page.next_cursor
    assert "/" not in page.next_cursor


@pytest.mark.asyncio
async def test_list_ready_replays_a_cursor_as_a_keyset_predicate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = Cursor(
        rows=[public_row(f"asset_{index:03d}") for index in range(ASSET_PAGE_LIMIT_MAX + 1)]
    )
    repository = patched(monkeypatch, first)
    page = await repository.list_ready(project_id="project_001", limit=50, cursor=None)

    second = Cursor(rows=[public_row("asset_999")])
    repository = patched(monkeypatch, second)
    await repository.list_ready(project_id="project_001", limit=50, cursor=page.next_cursor)

    query, params = second.calls[0]
    assert "(created_at, asset_id) < (%s, %s)" in query
    assert params[0] == "project_001"
    assert params[1] == CREATED_AT
    assert params[2] == f"asset_{ASSET_PAGE_LIMIT_MAX - 1:03d}"


@pytest.mark.asyncio
async def test_list_ready_rejects_a_malformed_cursor_without_querying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[])

    with pytest.raises(EditorAssetPersistenceError, match=r"^editor asset unavailable$"):
        await patched(monkeypatch, cursor).list_ready(
            project_id="project_001", limit=10, cursor="not-a-cursor"
        )


@pytest.mark.asyncio
async def test_list_ready_returns_an_empty_page_when_the_project_has_no_asset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = await patched(monkeypatch, Cursor(rows=[])).list_ready(
        project_id="project_002", limit=10, cursor=None
    )

    assert page.assets == ()
    assert page.next_cursor is None


@pytest.mark.asyncio
async def test_get_ready_record_returns_the_server_only_locator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(row=record_row())

    record = await patched(monkeypatch, cursor).get_ready_record(
        project_id="project_001", asset_id="asset_main"
    )

    assert record is not None
    assert record.artifact_location == "project_001/asset_main.mp4"
    assert "artifact_location" not in record.asset.model_dump()
    query, params = cursor.calls[0]
    assert "WHERE project_id = %s AND asset_id = %s" in query
    assert "validation_state = 'ready'" in query
    assert params == ("project_001", "asset_main")


@pytest.mark.asyncio
async def test_get_ready_record_returns_none_for_an_unknown_or_cross_project_asset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = patched(monkeypatch, Cursor(row=None))

    assert (
        await repository.get_ready_record(project_id="project_999", asset_id="asset_main") is None
    )


@pytest.mark.asyncio
async def test_get_ready_record_refuses_a_traversing_locator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(row=record_row(artifact_location="../../etc/passwd"))

    with pytest.raises(EditorAssetPersistenceError, match=r"^editor asset unavailable$"):
        await patched(monkeypatch, cursor).get_ready_record(
            project_id="project_001", asset_id="asset_main"
        )


@pytest.mark.asyncio
async def test_connection_failures_never_leak_the_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_asset_repository.AsyncConnection.connect",
        broken,
    )

    with pytest.raises(EditorAssetPersistenceError, match=r"^editor asset unavailable$"):
        await PostgresEditorAssetRepository("postgresql://redacted").list_ready(
            project_id="project_001", limit=10, cursor=None
        )


@pytest.mark.asyncio
async def test_get_ready_records_reads_one_project_scoped_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[record_row(), record_row(asset_id="asset_music", kind="audio")])
    repository = patched(monkeypatch, cursor)

    records = await repository.get_ready_records(
        project_id="project_001", asset_ids=("asset_main", "asset_music")
    )

    assert [record.asset.asset_id for record in records] == ["asset_main", "asset_music"]
    assert records[0].artifact_location == "project_001/asset_main.mp4"
    assert len(cursor.calls) == 1
    query, params = cursor.calls[0]
    assert "validation_state = 'ready'" in query
    assert "%s" in query
    assert params[0] == "project_001"
    assert list(params[1]) == ["asset_main", "asset_music"]


@pytest.mark.asyncio
async def test_get_ready_records_returns_nothing_for_an_empty_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[record_row()])
    repository = patched(monkeypatch, cursor)

    assert await repository.get_ready_records(project_id="project_001", asset_ids=()) == ()
    assert cursor.calls == []


@pytest.mark.asyncio
async def test_get_ready_records_refuses_a_traversing_locator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(rows=[record_row(artifact_location="../../etc/passwd")])

    with pytest.raises(EditorAssetPersistenceError, match=r"^editor asset unavailable$"):
        await patched(monkeypatch, cursor).get_ready_records(
            project_id="project_001", asset_ids=("asset_main",)
        )


@pytest.mark.asyncio
async def test_get_ready_records_never_leaks_the_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example/thoth")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.editor_asset_repository.AsyncConnection.connect",
        broken,
    )

    with pytest.raises(EditorAssetPersistenceError, match=r"^editor asset unavailable$"):
        await PostgresEditorAssetRepository("postgresql://redacted").get_ready_records(
            project_id="project_001", asset_ids=("asset_main",)
        )
