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


ASSET = "FROM editor_assets"


def asset_row(asset_id: str = "asset_clip", kind: str = "video", duration: int | None = 60):
    width, height = (None, None) if kind == "audio" else (1080, 1920)
    return (asset_id, kind, duration, width, height, 30.0, kind != "image", None)


def attach_cursor(
    rows: list[object], *, revision: int = 1, document: dict[str, Any] | None = None, **kwargs: Any
) -> Cursor:
    return Cursor(
        {
            MANIFEST: [manifest_row(revision)],
            DECISIONS: [[]],
            LATEST: [(document,) if document else document_row(revision)],
            ASSET: [rows],
        },
        **kwargs,
    )


def attach(asset_id: str = "asset_clip") -> AttachImportAsset:
    return AttachImportAsset(kind="attach_asset", asset_id=asset_id)


def saved_document(cursor: Cursor) -> dict[str, Any]:
    return cursor.params_of(INSERT_REVISION)[3].obj


def scene_of(document: dict[str, Any], scene_id: str) -> dict[str, Any]:
    return next(scene for scene in document["scenes"] if scene["scene_id"] == scene_id)


@pytest.mark.asyncio
async def test_attach_inserts_the_media_clip_into_its_scene_with_the_decision(
    monkeypatch,
) -> None:
    cursor = attach_cursor([asset_row()])
    repository, opened = store(monkeypatch, cursor)

    result = await resolve(repository, "footage_001", attach())

    entry = next(item for item in result.items if item.item_id == "footage_001")
    assert (entry.disposition, entry.asset_id, result.revision) == ("attached", "asset_clip", 2)
    document = saved_document(cursor)
    scene = scene_of(document, "scene_003")
    clip = next(clip for clip in document["clips"] if clip["clip_id"] == "clip_footage_001")
    assert (clip["kind"], clip["track_id"], clip["scene_id"], clip["asset_id"]) == (
        "video",
        "track_b_roll",
        "scene_003",
        "asset_clip",
    )
    assert (clip["from_frame"], clip["duration_in_frames"]) == (
        scene["start_frame"],
        min(60, scene["duration_in_frames"]),
    )
    assert [ref["asset_id"] for ref in document["asset_refs"]] == ["asset_clip"]
    assert cursor.params_of(ASSET) == (PROJECT, ["asset_clip"])
    assert cursor.params_of(INSERT_DECISION) == (
        PROJECT,
        DOCUMENT,
        "footage_001",
        2,
        "attached",
        "asset_clip",
    )
    assert opened[0].exited_with is None


@pytest.mark.asyncio
async def test_the_main_item_attaches_to_the_main_video_track(monkeypatch) -> None:
    cursor = attach_cursor([asset_row(duration=900)])
    repository, _ = store(monkeypatch, cursor)

    await resolve(repository, "main_000", attach())

    document = saved_document(cursor)
    clip = next(clip for clip in document["clips"] if clip["clip_id"] == "clip_main_000")
    assert (clip["track_id"], clip["scene_id"]) == ("track_main_video", "scene_001")
    assert clip["duration_in_frames"] == scene_of(document, "scene_001")["duration_in_frames"]


@pytest.mark.asyncio
async def test_the_main_item_starts_at_its_trim_and_keeps_its_source_length(monkeypatch) -> None:
    cursor = attach_cursor([asset_row(duration=900)])
    repository, _ = store(monkeypatch, cursor)

    await resolve(repository, "main_000", attach())

    document = saved_document(cursor)
    clip = next(clip for clip in document["clips"] if clip["clip_id"] == "clip_main_000")
    # The source skips its first 1.5 s: 45 frames at 30 fps, leaving 855 to play.
    assert (clip["source_from_frame"], clip["duration_in_frames"]) == (45, 855)
    assert scene_of(document, "scene_001")["duration_in_frames"] == 855
    assert scene_of(document, "scene_002")["start_frame"] == 855


@pytest.mark.asyncio
async def test_a_footage_scene_takes_the_length_of_its_source(monkeypatch) -> None:
    cursor = attach_cursor([asset_row(duration=240)])
    repository, _ = store(monkeypatch, cursor)

    await resolve(repository, "footage_001", attach())

    document = saved_document(cursor)
    scene = scene_of(document, "scene_003")
    clip = next(clip for clip in document["clips"] if clip["clip_id"] == "clip_footage_001")
    assert (clip["source_from_frame"], clip["duration_in_frames"]) == (0, 240)
    assert scene["duration_in_frames"] == 240
    assert scene_of(document, "scene_004")["start_frame"] == scene["start_frame"] + 240


@pytest.mark.asyncio
async def test_main_footage_stays_within_the_main_scene(monkeypatch) -> None:
    cursor = attach_cursor([asset_row(duration=900)])
    repository, _ = store(monkeypatch, cursor)

    await resolve(repository, "main_footage_000", attach())

    document = saved_document(cursor)
    scene = scene_of(document, "scene_001")
    clip = next(clip for clip in document["clips"] if clip["clip_id"] == "clip_main_footage_000")
    assert scene["duration_in_frames"] == DRAFT.scenes[0].duration_in_frames
    assert (clip["track_id"], clip["duration_in_frames"]) == (
        "track_b_roll",
        scene["duration_in_frames"],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("item_id", "duration", "code"),
    [
        ("main_000", 45, "trim_exceeds_asset"),
        ("main_000", None, "asset_duration_unknown"),
        ("footage_001", None, "asset_duration_unknown"),
    ],
)
async def test_a_source_range_the_asset_cannot_hold_leaves_the_item_unresolved(
    monkeypatch, item_id: str, duration: int | None, code: str
) -> None:
    cursor = attach_cursor([asset_row(duration=duration)])
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportDecisionRejected) as raised:
        await resolve(repository, item_id, attach())

    assert raised.value.code == code
    assert not cursor.ran(INSERT_REVISION)
    assert not cursor.ran(INSERT_DECISION)


@pytest.mark.asyncio
async def test_an_image_item_takes_a_still_for_the_whole_scene(monkeypatch) -> None:
    cursor = attach_cursor([asset_row("asset_still", "image", None)])
    repository, _ = store(monkeypatch, cursor)

    await resolve(repository, "comment_000", attach("asset_still"))

    document = saved_document(cursor)
    clip = next(clip for clip in document["clips"] if clip["clip_id"] == "clip_comment_000")
    assert clip["duration_in_frames"] == scene_of(document, "scene_006")["duration_in_frames"]


@pytest.mark.asyncio
async def test_attach_refuses_an_asset_that_is_not_ready_in_this_project(monkeypatch) -> None:
    # The lookup is project-scoped and ready-only, so another project's asset,
    # an unready one, and an invalidated one all come back as nothing.
    cursor = attach_cursor([])
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportDecisionRejected) as raised:
        await resolve(repository, "footage_001", attach("asset_elsewhere"))

    assert raised.value.code == "asset_unavailable"
    assert cursor.params_of(ASSET)[0] == PROJECT
    assert not cursor.ran(INSERT_REVISION)
    assert not cursor.ran(INSERT_DECISION)


@pytest.mark.asyncio
async def test_attach_refuses_an_asset_of_another_media_kind(monkeypatch) -> None:
    cursor = attach_cursor([asset_row("asset_voice", "audio", 60)])
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportDecisionRejected) as raised:
        await resolve(repository, "footage_001", attach("asset_voice"))

    assert raised.value.code == "asset_kind_mismatch"
    assert not cursor.ran(INSERT_REVISION)


@pytest.mark.asyncio
async def test_attach_refuses_a_document_that_cannot_take_the_clip(monkeypatch) -> None:
    locked = {**DRAFT.model_dump(mode="json"), "revision": 1}
    for track in locked["tracks"]:
        track["locked"] = track["locked"] or track["track_id"] == "track_b_roll"
    cursor = attach_cursor([asset_row()], document=locked)
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportDecisionRejected) as raised:
        await resolve(repository, "footage_001", attach())

    assert raised.value.code == "attach_rejected"
    assert not cursor.ran(INSERT_REVISION)


@pytest.mark.asyncio
async def test_an_attached_item_cannot_be_resolved_again(monkeypatch) -> None:
    cursor = resolve_cursor(decided=[("footage_001", "attached", "asset_clip")])
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(StudioImportItemResolved):
        await resolve(repository, "footage_001", attach("asset_other"))
    assert not cursor.ran(ASSET)


@pytest.mark.asyncio
async def test_attach_at_a_stale_revision_is_a_conflict(monkeypatch) -> None:
    cursor = attach_cursor([asset_row()], revision=4)
    repository, _ = store(monkeypatch, cursor)

    with pytest.raises(EditDocumentRevisionConflict) as raised:
        await resolve(repository, "footage_001", attach())

    assert raised.value.latest.revision == 4
    assert not cursor.ran(INSERT_REVISION)


@pytest.mark.asyncio
async def test_a_failed_decision_insert_rolls_back_the_attached_clip(monkeypatch) -> None:
    cursor = attach_cursor([asset_row()], error_on=INSERT_DECISION)
    repository, opened = store(monkeypatch, cursor)

    with pytest.raises(EditDocumentPersistenceError) as raised:
        await resolve(repository, "footage_001", attach())

    assert cursor.ran(INSERT_REVISION)
    assert opened[0].exited_with is RuntimeError
    assert "postgresql" not in str(raised.value)
