"""Unit tests for append-only, revision-bound PostgreSQL Studio review persistence."""

from __future__ import annotations

import inspect
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.domain.edit_document_v2_fixtures import clip_by_id, document_v2_payload
from thoth_control_plane.application.studio_review_ports import (
    InvalidStudioReviewPage,
    StudioReviewDocumentNotFound,
    StudioReviewFrameOutOfRange,
    StudioReviewIdempotencyConflict,
    StudioReviewNotEligible,
    StudioReviewPersistenceError,
    StudioReviewRevisionConflict,
)
from thoth_control_plane.domain.models import ActorSnapshot
from thoth_control_plane.domain.studio_review import CreateComment, CreateDecision
from thoth_control_plane.infrastructure import studio_review_repository
from thoth_control_plane.infrastructure.editor_repository import (
    EditDocumentPersistenceError,
    PostgresEditDocumentRepository,
)
from thoth_control_plane.infrastructure.studio_review_repository import (
    PostgresStudioReviewRepository,
)

NOW = datetime(2026, 9, 24, 9, 0, tzinfo=UTC)
LATER = datetime(2026, 9, 24, 9, 5, tzinfo=UTC)
PROJECT = "project_001"
DOCUMENT = "edoc_abc123"
ACTOR = ActorSnapshot(actor_id="user_owner", actor_type="user", display_name="Owner")

LOCK = "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))"
LOOKUP = "SELECT request_hash"
LATEST = "FROM edit_document_revisions"
INSERT = "INSERT INTO studio_review_events"
LIST = "FROM studio_review_events WHERE project_id"


class Cursor:
    """Route each statement to a scripted result by a marker in its normalized SQL."""

    def __init__(
        self,
        responses: dict[str, list[object]] | None = None,
        *,
        error: Exception | None = None,
        error_on: str | None = None,
    ) -> None:
        self.responses = {key: list(value) for key, value in (responses or {}).items()}
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.error = error
        self.error_on = error_on
        self._result: object = None

    async def execute(self, query: str, params: tuple[object, ...] = ()) -> None:
        self.calls.append((query, params))
        statement = " ".join(query.split())
        if self.error is not None and self.error_on is not None and self.error_on in statement:
            raise self.error
        self._result = None
        for fragment, queue in self.responses.items():
            if fragment in statement:
                self._result = queue.pop(0) if queue else None
                return

    async def fetchone(self) -> object:
        return self._result

    async def fetchall(self) -> list[object]:
        result = self._result
        return list(result) if isinstance(result, list) else []

    def statements(self) -> list[str]:
        return [" ".join(query.split()) for query, _ in self.calls]

    def params_of(self, fragment: str) -> tuple[object, ...]:
        return next(params for query, params in self.calls if fragment in " ".join(query.split()))


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


def connect_to(
    monkeypatch: pytest.MonkeyPatch, cursor: Cursor, module: str = "studio_review_repository"
) -> list[Connection]:
    opened: list[Connection] = []

    async def connect(_: str) -> Connection:
        opened.append(Connection(cursor))
        return opened[-1]

    monkeypatch.setattr(
        f"thoth_control_plane.infrastructure.{module}.AsyncConnection.connect", connect
    )
    return opened


def store(monkeypatch: pytest.MonkeyPatch, cursor: Cursor) -> PostgresStudioReviewRepository:
    connect_to(monkeypatch, cursor)
    return PostgresStudioReviewRepository("postgresql://redacted")


def latest(revision: int = 3, payload: dict[str, Any] | None = None) -> tuple[object, ...]:
    document = payload or document_v2_payload()
    return (revision, {**document, "revision": revision})


def comment_request(**overrides: object) -> CreateComment:
    payload: dict[str, object] = {
        "base_revision": 3,
        "operation_id": "op_review_1",
        "text": "Check title",
        "frame": 29,
    }
    return CreateComment.model_validate(payload | overrides)


def decision_request(**overrides: object) -> CreateDecision:
    payload: dict[str, object] = {
        "base_revision": 3,
        "operation_id": "op_decide_1",
        "decision": "approved",
    }
    return CreateDecision.model_validate(payload | overrides)


def recorded_row(cursor: Cursor, created_at: datetime = NOW) -> tuple[object, ...]:
    """Rebuild the stored event row, request hash first, from a captured INSERT."""
    (
        event_id,
        project_id,
        document_id,
        revision,
        _operation_id,
        request_hash,
        event_kind,
        *rest,
    ) = cursor.params_of(INSERT)
    return (
        request_hash,
        event_id,
        project_id,
        document_id,
        revision,
        event_kind,
        *rest,
        created_at,
    )


async def create_once(monkeypatch: pytest.MonkeyPatch, request: CreateComment) -> Cursor:
    cursor = Cursor({LOOKUP: [None], LATEST: [latest()], INSERT: [(NOW,)]})
    await store(monkeypatch, cursor).create_comment(
        project_id=PROJECT, document_id=DOCUMENT, request=request, actor=ACTOR
    )
    return cursor


# --- writes -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_comment_locks_then_checks_the_latest_saved_revision_then_inserts_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({LOOKUP: [None], LATEST: [latest()], INSERT: [(NOW,)]})

    comment = await store(monkeypatch, cursor).create_comment(
        project_id=PROJECT, document_id=DOCUMENT, request=comment_request(), actor=ACTOR
    )

    statements = cursor.statements()
    assert statements[0] == LOCK
    assert cursor.calls[0][1] == (PROJECT, DOCUMENT)
    assert LOOKUP in statements[1]
    assert LATEST in statements[2] and statements[2].endswith("FOR UPDATE")
    assert cursor.calls[2][1] == (PROJECT, DOCUMENT)
    assert sum(INSERT in statement for statement in statements) == 1
    assert all(PROJECT not in query and "Check title" not in query for query, _ in cursor.calls)
    assert comment.document_revision == 3
    assert comment.actor == ACTOR
    assert comment.frame == 29
    assert comment.created_at == NOW


@pytest.mark.asyncio
async def test_review_writes_take_the_same_document_lock_as_editor_saves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    editor_cursor = Cursor({LATEST: [None]})
    connect_to(monkeypatch, editor_cursor, module="editor_repository")
    with pytest.raises(EditDocumentPersistenceError):
        await PostgresEditDocumentRepository("postgresql://redacted").apply_operations(
            PROJECT, DOCUMENT, 3, []
        )
    review_cursor = await create_once(monkeypatch, comment_request())

    assert editor_cursor.statements()[0] == review_cursor.statements()[0] == LOCK
    assert editor_cursor.calls[0][1] == review_cursor.calls[0][1] == (PROJECT, DOCUMENT)


@pytest.mark.asyncio
async def test_replaying_the_same_operation_returns_the_original_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = await create_once(monkeypatch, comment_request())
    replay_cursor = Cursor({LOOKUP: [recorded_row(first)], LATEST: [latest(revision=4)]})

    replayed = await store(monkeypatch, replay_cursor).create_comment(
        project_id=PROJECT, document_id=DOCUMENT, request=comment_request(), actor=ACTOR
    )

    assert replayed.comment_id == first.params_of(INSERT)[0]
    assert replayed.document_revision == 3
    assert not any(INSERT in statement for statement in replay_cursor.statements())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reuse",
    [
        lambda repo: repo.create_comment(
            project_id=PROJECT,
            document_id=DOCUMENT,
            request=comment_request(text="Different words"),
            actor=ACTOR,
        ),
        lambda repo: repo.create_comment(
            project_id=PROJECT,
            document_id=DOCUMENT,
            request=comment_request(frame=None),
            actor=ACTOR,
        ),
        lambda repo: repo.create_decision(
            project_id=PROJECT,
            document_id=DOCUMENT,
            request=decision_request(operation_id="op_review_1"),
            actor=ACTOR,
        ),
    ],
)
async def test_reusing_an_operation_id_for_another_body_or_kind_conflicts(
    monkeypatch: pytest.MonkeyPatch, reuse: Any
) -> None:
    first = await create_once(monkeypatch, comment_request())
    cursor = Cursor({LOOKUP: [recorded_row(first)], LATEST: [latest()]})

    with pytest.raises(StudioReviewIdempotencyConflict):
        await reuse(store(monkeypatch, cursor))
    assert not any(INSERT in statement for statement in cursor.statements())


@pytest.mark.asyncio
async def test_a_stale_base_revision_conflicts_with_the_latest_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({LOOKUP: [None], LATEST: [latest(revision=4)]})

    with pytest.raises(StudioReviewRevisionConflict) as conflict:
        await store(monkeypatch, cursor).create_decision(
            project_id=PROJECT, document_id=DOCUMENT, request=decision_request(), actor=ACTOR
        )
    assert conflict.value.latest_revision == 4
    assert not any(INSERT in statement for statement in cursor.statements())


@pytest.mark.asyncio
async def test_a_document_the_project_does_not_own_is_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({LOOKUP: [None], LATEST: [None]})

    with pytest.raises(StudioReviewDocumentNotFound):
        await store(monkeypatch, cursor).create_comment(
            project_id="project_other", document_id=DOCUMENT, request=comment_request(), actor=ACTOR
        )
    assert cursor.params_of(LATEST) == ("project_other", DOCUMENT)
    assert not any(INSERT in statement for statement in cursor.statements())


@pytest.mark.asyncio
async def test_a_frame_must_fall_inside_the_saved_canvas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    at_end = Cursor({LOOKUP: [None], LATEST: [latest()]})
    with pytest.raises(StudioReviewFrameOutOfRange):
        await store(monkeypatch, at_end).create_comment(
            project_id=PROJECT,
            document_id=DOCUMENT,
            request=comment_request(frame=300),
            actor=ACTOR,
        )
    assert not any(INSERT in statement for statement in at_end.statements())

    last = Cursor({LOOKUP: [None], LATEST: [latest()], INSERT: [(NOW,)]})
    comment = await store(monkeypatch, last).create_comment(
        project_id=PROJECT, document_id=DOCUMENT, request=comment_request(frame=299), actor=ACTOR
    )
    assert comment.frame == 299


@pytest.mark.asyncio
async def test_approval_is_refused_on_a_revision_with_blocking_issues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gapped = document_v2_payload()
    clip_by_id(gapped, "clip_main")["from_frame"] = 30
    clip_by_id(gapped, "clip_main")["duration_in_frames"] = 270

    refused = Cursor({LOOKUP: [None], LATEST: [latest(payload=gapped)]})
    with pytest.raises(StudioReviewNotEligible) as blocked:
        await store(monkeypatch, refused).create_decision(
            project_id=PROJECT, document_id=DOCUMENT, request=decision_request(), actor=ACTOR
        )
    assert blocked.value.issues == ("main_track_gap",)
    assert not any(INSERT in statement for statement in refused.statements())

    allowed = Cursor({LOOKUP: [None], LATEST: [latest(payload=gapped)], INSERT: [(NOW,)]})
    decision = await store(monkeypatch, allowed).create_decision(
        project_id=PROJECT,
        document_id=DOCUMENT,
        request=decision_request(decision="changes_requested", reason="Close the gap"),
        actor=ACTOR,
    )
    assert decision.decision == "changes_requested"
    assert decision.reason == "Close the gap"


@pytest.mark.asyncio
async def test_a_failed_insert_rolls_back_and_leaks_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(
        {LOOKUP: [None], LATEST: [latest()]},
        error=RuntimeError("postgresql://secret.example/thoth"),
        error_on=INSERT,
    )
    opened = connect_to(monkeypatch, cursor)

    with pytest.raises(StudioReviewPersistenceError) as failure:
        await PostgresStudioReviewRepository("postgresql://redacted").create_comment(
            project_id=PROJECT, document_id=DOCUMENT, request=comment_request(), actor=ACTOR
        )
    assert "secret" not in str(failure.value)
    assert opened[0].exited_with is RuntimeError


def test_the_review_store_only_ever_inserts_and_reads() -> None:
    source = inspect.getsource(studio_review_repository).upper()

    assert "UPDATE " not in source.replace("FOR UPDATE", "")
    assert "DELETE " not in source


# --- reads ------------------------------------------------------------------


def event_row(
    event_id: str, created_at: datetime, *, kind: str = "comment", revision: int = 3
) -> tuple[object, ...]:
    comment = kind == "comment"
    return (
        event_id,
        PROJECT,
        DOCUMENT,
        revision,
        kind,
        "user_owner",
        "user",
        "Owner",
        "Check title" if comment else None,
        None,
        None if comment else "approved",
        None,
        created_at,
    )


@pytest.mark.asyncio
async def test_comments_list_oldest_first_with_a_keyset_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [event_row("rev_a", NOW), event_row("rev_b", NOW), event_row("rev_c", LATER)]
    cursor = Cursor({LIST: [rows, [rows[2]]]})
    repo = store(monkeypatch, cursor)

    first = await repo.list_comments(project_id=PROJECT, document_id=DOCUMENT, limit=2, cursor=None)
    assert [comment.comment_id for comment in first.comments] == ["rev_a", "rev_b"]
    assert first.next_cursor is not None
    assert "ORDER BY created_at, event_id" in cursor.statements()[0]
    assert "event_kind = 'comment'" in cursor.statements()[0]
    assert cursor.calls[0][1] == (PROJECT, DOCUMENT, 3)

    second = await repo.list_comments(
        project_id=PROJECT, document_id=DOCUMENT, limit=2, cursor=first.next_cursor
    )
    assert [comment.comment_id for comment in second.comments] == ["rev_c"]
    assert second.next_cursor is None
    assert "(created_at, event_id) > (%s, %s)" in cursor.statements()[1]
    assert cursor.calls[1][1] == (PROJECT, DOCUMENT, NOW, "rev_b", 3)


@pytest.mark.asyncio
async def test_decisions_list_newest_first_and_keep_historical_approvals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        event_row("rev_new", LATER, kind="decision", revision=4),
        event_row("rev_old", NOW, kind="decision", revision=3),
    ]
    cursor = Cursor({LIST: [rows]})

    page = await store(monkeypatch, cursor).list_decisions(
        project_id=PROJECT, document_id=DOCUMENT, limit=50, cursor=None
    )

    assert [(item.decision_id, item.document_revision) for item in page.decisions] == [
        ("rev_new", 4),
        ("rev_old", 3),
    ]
    assert page.decisions[1].decision == "approved"
    assert "ORDER BY created_at DESC, event_id DESC" in cursor.statements()[0]
    assert "event_kind = 'decision'" in cursor.statements()[0]
    assert page.next_cursor is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("limit", "page_cursor"),
    [(0, None), (51, None), (10, "not a cursor!"), (10, "bm90LWEtY3Vyc29y"), (10, "")],
)
async def test_an_invalid_limit_or_cursor_is_refused_before_any_query(
    monkeypatch: pytest.MonkeyPatch, limit: int, page_cursor: str | None
) -> None:
    cursor = Cursor()

    with pytest.raises(InvalidStudioReviewPage):
        await store(monkeypatch, cursor).list_comments(
            project_id=PROJECT, document_id=DOCUMENT, limit=limit, cursor=page_cursor
        )
    assert cursor.calls == []
