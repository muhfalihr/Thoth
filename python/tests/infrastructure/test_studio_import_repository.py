"""Unit tests for append-only PostgreSQL persistence of Studio drafts and import decisions."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from tests.domain.test_studio_imports import projection_payload
from thoth_control_plane.application.edit_documents import EditDocumentNotFound
from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    StudioImportConflict,
    StudioImportDecisionRejected,
    StudioImportItemNotFound,
    StudioImportItemResolved,
)
from thoth_control_plane.application.studio_imports import build_studio_draft
from thoth_control_plane.domain.studio_imports import (
    AttachImportAsset,
    ExcludeImportItem,
    StudioSourceProjection,
    inventory,
    source_key,
)
from thoth_control_plane.infrastructure.editor_repository import EditDocumentPersistenceError
from thoth_control_plane.infrastructure.studio_import_repository import (
    PostgresStudioImportRepository,
)

NOW = datetime(2026, 9, 25, 9, 0, tzinfo=UTC)
PROJECT = "project_001"
DOCUMENT = "edoc_first"
PROJECTION = StudioSourceProjection.model_validate(projection_payload())
KEY = source_key(PROJECTION)
DRAFT = build_studio_draft(PROJECT, DOCUMENT, PROJECTION)
INVENTORY = inventory(PROJECTION)

LOCK = "pg_advisory_xact_lock"
REPLAY = "FROM studio_import_drafts d WHERE d.project_id = %s AND d.idempotency_key = %s"
INSERT_REVISION = "INSERT INTO edit_document_revisions"
INSERT_DRAFT = "INSERT INTO studio_import_drafts"
LIST = "FROM studio_import_drafts d WHERE d.project_id = %s AND d.source_key = %s"
MANIFEST = "FROM studio_import_drafts d WHERE d.project_id = %s AND d.document_id = %s"
DECISIONS = "FROM studio_import_decisions WHERE project_id = %s AND document_id = %s"
LATEST = "FROM edit_document_revisions WHERE project_id = %s AND document_id = %s ORDER BY"
INSERT_DECISION = "INSERT INTO studio_import_decisions"


class Cursor:
    """Route each statement to a scripted result by a marker in its normalized SQL."""

    def __init__(
        self, responses: dict[str, list[object]] | None = None, *, error_on: str | None = None
    ) -> None:
        self.responses = {key: list(value) for key, value in (responses or {}).items()}
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.error_on = error_on
        self._result: object = None

    async def execute(self, query: str, params: tuple[object, ...] = ()) -> None:
        statement = " ".join(query.split())
        self.calls.append((statement, params))
        if self.error_on is not None and self.error_on in statement:
            raise RuntimeError("connection reset with postgresql://secret@db")
        self._result = None
        for fragment, queue in self.responses.items():
            if fragment in statement:
                self._result = queue.pop(0) if queue else None
                return

    async def fetchone(self) -> object:
        return self._result

    async def fetchall(self) -> list[object]:
        return list(self._result) if isinstance(self._result, list) else []

    def ran(self, fragment: str) -> bool:
        return any(fragment in statement for statement, _ in self.calls)

    def params_of(self, fragment: str) -> tuple[object, ...]:
        return next(params for statement, params in self.calls if fragment in statement)


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_value = cursor
        self.exited_with: object = "open"

    async def __aenter__(self) -> Connection:
        return self

    async def __aexit__(self, exc_type: object, *_: object) -> None:
        # psycopg commits on a clean exit and rolls back when an exception escapes.
        self.exited_with = exc_type

    def cursor(self) -> Cursor:
        return self.cursor_value


def store(
    monkeypatch: pytest.MonkeyPatch, cursor: Cursor
) -> tuple[PostgresStudioImportRepository, list[Connection]]:
    opened: list[Connection] = []

    async def connect(_: str) -> Connection:
        opened.append(Connection(cursor))
        return opened[-1]

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.studio_import_repository.AsyncConnection.connect",
        connect,
    )
    return PostgresStudioImportRepository("postgresql://redacted"), opened


async def create(repository: PostgresStudioImportRepository, key: str = KEY) -> Any:
    return await repository.create_draft(
        project_id=PROJECT,
        source_key=key,
        idempotency_key="open-1",
        document=DRAFT,
        inventory=INVENTORY,
    )


def document_row(revision: int = 1) -> tuple[object, ...]:
    return ({**DRAFT.model_dump(mode="json"), "revision": revision},)


def manifest_row(revision: int = 1) -> tuple[object, ...]:
    return (KEY, [entry.model_dump(mode="json") for entry in INVENTORY], revision)


@pytest.mark.asyncio
async def test_create_writes_the_revision_and_manifest_in_one_transaction(monkeypatch) -> None:
    cursor = Cursor({INSERT_DRAFT: [(NOW,)]})
    repository, opened = store(monkeypatch, cursor)

    draft = await create(repository)

    assert (draft.document_id, draft.source_key, draft.revision, draft.created_at) == (
        DOCUMENT,
        KEY,
        1,
        NOW,
    )
    assert len(opened) == 1 and opened[0].exited_with is None
    statements = [statement for statement, _ in cursor.calls]
    assert LOCK in statements[0]
    assert [
        fragment for fragment in (REPLAY, INSERT_REVISION, INSERT_DRAFT) if cursor.ran(fragment)
    ]
    assert statements.index(next(s for s in statements if INSERT_REVISION in s)) < statements.index(
        next(s for s in statements if INSERT_DRAFT in s)
    )
    params = cursor.params_of(INSERT_DRAFT)
    assert params[:5] == (PROJECT, DOCUMENT, 1, KEY, "open-1")
    persisted = str(params) + str(cursor.params_of(INSERT_REVISION))
    assert "example.com" not in persisted
    assert "source_url" not in persisted


@pytest.mark.asyncio
async def test_a_replayed_key_returns_the_existing_draft_without_writing(monkeypatch) -> None:
    cursor = Cursor({REPLAY: [("edoc_existing", KEY, NOW, 4)]})
    repository, _ = store(monkeypatch, cursor)

    draft = await create(repository)

    assert (draft.document_id, draft.revision) == ("edoc_existing", 4)
    assert not cursor.ran(INSERT_REVISION)
    assert not cursor.ran(INSERT_DRAFT)


@pytest.mark.asyncio
async def test_a_key_reused_for_another_source_is_a_conflict(monkeypatch) -> None:
    cursor = Cursor({REPLAY: [("edoc_existing", "f" * 64, NOW, 1)]})
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportConflict):
        await create(repository)
    assert not cursor.ran(INSERT_REVISION)


@pytest.mark.asyncio
async def test_a_failed_manifest_insert_rolls_back_the_revision(monkeypatch) -> None:
    cursor = Cursor(error_on=INSERT_DRAFT)
    repository, opened = store(monkeypatch, cursor)

    with pytest.raises(EditDocumentPersistenceError) as raised:
        await create(repository)

    assert cursor.ran(INSERT_REVISION)
    # The exception escaped the connection block, so psycopg rolled the revision back.
    assert opened[0].exited_with is RuntimeError
    assert "postgresql" not in str(raised.value)


@pytest.mark.asyncio
async def test_listing_is_project_scoped_bounded_and_newest_first(monkeypatch) -> None:
    rows = [("edoc_b", KEY, NOW, 3), ("edoc_a", KEY, NOW, 1)]
    cursor = Cursor({LIST: [rows]})
    repository, _ = store(monkeypatch, cursor)

    drafts = await repository.list_drafts(project_id=PROJECT, source_key=KEY, limit=21)

    assert [(draft.document_id, draft.revision) for draft in drafts] == [
        ("edoc_b", 3),
        ("edoc_a", 1),
    ]
    statement = next(statement for statement, _ in cursor.calls if LIST in statement)
    assert "ORDER BY d.created_at DESC, d.document_id DESC LIMIT %s" in statement
    assert cursor.params_of(LIST) == (PROJECT, KEY, 21)


@pytest.mark.asyncio
async def test_the_manifest_reads_with_decisions_and_the_latest_revision(monkeypatch) -> None:
    cursor = Cursor(
        {MANIFEST: [manifest_row(3)], DECISIONS: [[("unsupported_000", "excluded", None)]]}
    )
    repository, _ = store(monkeypatch, cursor)

    result = await repository.get_inventory(project_id=PROJECT, document_id=DOCUMENT)

    assert result is not None
    assert (result.document_id, result.source_key, result.revision) == (DOCUMENT, KEY, 3)
    dispositions = {entry.item_id: entry.disposition for entry in result.items}
    assert dispositions["unsupported_000"] == "excluded"
    assert dispositions["main_000"] == "unresolved"
    assert not cursor.ran("INSERT")


@pytest.mark.asyncio
async def test_an_unknown_draft_has_no_manifest(monkeypatch) -> None:
    repository, _ = store(monkeypatch, Cursor())
    assert await repository.get_inventory(project_id=PROJECT, document_id=DOCUMENT) is None


async def resolve(repository: PostgresStudioImportRepository, item_id: str, decision: Any) -> Any:
    return await repository.resolve_item(
        project_id=PROJECT,
        document_id=DOCUMENT,
        item_id=item_id,
        base_revision=1,
        decision=decision,
    )


def resolve_cursor(*, revision: int = 1, decided: list[object] | None = None) -> Cursor:
    return Cursor(
        {
            MANIFEST: [manifest_row(revision)],
            DECISIONS: [decided or []],
            LATEST: [document_row(revision)],
        }
    )


@pytest.mark.asyncio
async def test_exclude_records_the_decision_with_a_new_revision(monkeypatch) -> None:
    cursor = resolve_cursor()
    repository, opened = store(monkeypatch, cursor)

    result = await resolve(repository, "unsupported_000", ExcludeImportItem(kind="exclude"))

    assert result.revision == 2
    assert {entry.item_id: entry.disposition for entry in result.items}["unsupported_000"] == (
        "excluded"
    )
    assert LOCK in cursor.calls[0][0]
    assert cursor.params_of(INSERT_REVISION)[:3] == (PROJECT, DOCUMENT, 2)
    assert cursor.params_of(INSERT_DECISION) == (
        PROJECT,
        DOCUMENT,
        "unsupported_000",
        2,
        "excluded",
        None,
    )
    assert opened[0].exited_with is None


@pytest.mark.asyncio
async def test_a_stale_revision_is_a_conflict_with_the_latest_document(monkeypatch) -> None:
    cursor = resolve_cursor(revision=3)
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(EditDocumentRevisionConflict) as raised:
        await resolve(repository, "unsupported_000", ExcludeImportItem(kind="exclude"))

    assert raised.value.latest.revision == 3
    assert not cursor.ran(INSERT_DECISION)


@pytest.mark.asyncio
async def test_an_item_is_decided_once(monkeypatch) -> None:
    cursor = resolve_cursor(decided=[("unsupported_000", "excluded", None)])
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportItemResolved):
        await resolve(repository, "unsupported_000", ExcludeImportItem(kind="exclude"))
    assert not cursor.ran(INSERT_DECISION)


@pytest.mark.asyncio
async def test_an_unknown_item_or_draft_is_not_found(monkeypatch) -> None:
    repository, _ = store(monkeypatch, resolve_cursor())
    with pytest.raises(StudioImportItemNotFound):
        await resolve(repository, "footage_999", ExcludeImportItem(kind="exclude"))

    repository, _ = store(monkeypatch, Cursor())
    with pytest.raises(EditDocumentNotFound):
        await resolve(repository, "main_000", ExcludeImportItem(kind="exclude"))


@pytest.mark.asyncio
async def test_an_unsupported_field_cannot_be_attached(monkeypatch) -> None:
    cursor = resolve_cursor()
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportDecisionRejected) as raised:
        await resolve(
            repository,
            "unsupported_000",
            AttachImportAsset(kind="attach_asset", asset_id="asset_001"),
        )
    assert raised.value.code == "item_not_attachable"
    assert not cursor.ran(INSERT_DECISION)
