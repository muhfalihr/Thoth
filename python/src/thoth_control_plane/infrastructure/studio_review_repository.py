"""PostgreSQL persistence for append-only, revision-bound Studio review events.

Every write runs in one short-lived transaction that first takes the same
per-document advisory lock as editor saves, so a review can never attach to a
revision that a concurrent save is superseding. Rows are only ever inserted and
read: a newer saved revision leaves earlier comments and decisions historical.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
from datetime import datetime
from typing import Any

from psycopg import AsyncConnection
from pydantic import TypeAdapter

from thoth_control_plane.application.studio_review_ports import (
    InvalidStudioReviewPage,
    StudioReviewDocumentNotFound,
    StudioReviewFrameOutOfRange,
    StudioReviewIdempotencyConflict,
    StudioReviewNotEligible,
    StudioReviewPersistenceError,
    StudioReviewRevisionConflict,
)
from thoth_control_plane.domain.edit_document_v2 import EditDocument
from thoth_control_plane.domain.models import ActorSnapshot
from thoth_control_plane.domain.studio_review import (
    PAGE_LIMIT,
    CreateComment,
    CreateDecision,
    ReviewComment,
    ReviewCommentPage,
    ReviewDecision,
    ReviewDecisionPage,
    review_blocking_issues,
)

DOCUMENT_ADAPTER: TypeAdapter[EditDocument] = TypeAdapter(EditDocument)

#: Selected in this exact order by every read and rebuilt by :func:`_row_to_event`.
EVENT_COLUMNS = (
    "event_id, project_id, document_id, revision, event_kind, actor_id, actor_type, "
    "actor_display_name, comment_text, frame, decision, reason, created_at"
)

_CURSOR_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_EVENT_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")

#: Typed outcomes the application maps to fixed safe codes; never redacted.
_PASSTHROUGH = (
    StudioReviewDocumentNotFound,
    StudioReviewFrameOutOfRange,
    StudioReviewIdempotencyConflict,
    StudioReviewNotEligible,
    StudioReviewRevisionConflict,
)


def _request_hash(kind: str, request: CreateComment | CreateDecision, actor: ActorSnapshot) -> str:
    """Hash the kind, the complete request, and the author so no raw body is compared."""
    canonical = json.dumps(
        {"kind": kind, "request": request.model_dump(mode="json"), "actor": actor.actor_id},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _row_to_event(row: tuple[Any, ...]) -> ReviewComment | ReviewDecision:
    (
        event_id,
        project_id,
        document_id,
        revision,
        kind,
        actor_id,
        actor_type,
        display_name,
        text,
        frame,
        decision,
        reason,
        created_at,
    ) = row
    common = {
        "project_id": project_id,
        "document_id": document_id,
        "document_revision": revision,
        "actor": ActorSnapshot(actor_id=actor_id, actor_type=actor_type, display_name=display_name),
        "created_at": created_at,
    }
    if kind == "comment":
        return ReviewComment(comment_id=event_id, text=text, frame=frame, **common)
    return ReviewDecision(decision_id=event_id, decision=decision, reason=reason, **common)


def _encode_cursor(created_at: datetime, event_id: str) -> str:
    raw = f"{created_at.isoformat()}|{event_id}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _page_bounds(limit: int, cursor: str | None) -> tuple[int, tuple[datetime, str] | None]:
    """Accept only an in-range limit and a cursor this server issued."""
    if not 1 <= limit <= PAGE_LIMIT:
        raise InvalidStudioReviewPage()
    if cursor is None:
        return limit, None
    if not _CURSOR_PATTERN.match(cursor):
        raise InvalidStudioReviewPage()
    try:
        decoded = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("utf-8")
        stamp, separator, event_id = decoded.partition("|")
        created_at = datetime.fromisoformat(stamp)
    except (ValueError, UnicodeDecodeError) as error:
        raise InvalidStudioReviewPage() from error
    if not separator or not _EVENT_ID_PATTERN.match(event_id) or created_at.tzinfo is None:
        raise InvalidStudioReviewPage()
    return limit, (created_at, event_id)


class PostgresStudioReviewRepository:
    """Open one short-lived async connection per review operation."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def create_comment(
        self,
        *,
        project_id: str,
        document_id: str,
        request: CreateComment,
        actor: ActorSnapshot,
    ) -> ReviewComment:
        event = await self._append(project_id, document_id, "comment", request, actor)
        assert isinstance(event, ReviewComment)
        return event

    async def create_decision(
        self,
        *,
        project_id: str,
        document_id: str,
        request: CreateDecision,
        actor: ActorSnapshot,
    ) -> ReviewDecision:
        event = await self._append(project_id, document_id, "decision", request, actor)
        assert isinstance(event, ReviewDecision)
        return event

    async def list_comments(
        self, *, project_id: str, document_id: str, limit: int, cursor: str | None
    ) -> ReviewCommentPage:
        events, next_cursor = await self._list(project_id, document_id, "comment", limit, cursor)
        return ReviewCommentPage(comments=events, next_cursor=next_cursor)

    async def list_decisions(
        self, *, project_id: str, document_id: str, limit: int, cursor: str | None
    ) -> ReviewDecisionPage:
        events, next_cursor = await self._list(project_id, document_id, "decision", limit, cursor)
        return ReviewDecisionPage(decisions=events, next_cursor=next_cursor)

    async def _append(
        self,
        project_id: str,
        document_id: str,
        kind: str,
        request: CreateComment | CreateDecision,
        actor: ActorSnapshot,
    ) -> ReviewComment | ReviewDecision:
        request_hash = _request_hash(kind, request, actor)
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                    (project_id, document_id),
                )
                # Replay wins over staleness: an identical retry of a request that
                # already landed returns that record even after a newer save.
                await cursor.execute(
                    f"""
                    SELECT request_hash, {EVENT_COLUMNS}
                    FROM studio_review_events
                    WHERE project_id = %s AND document_id = %s AND operation_id = %s
                    """,
                    (project_id, document_id, request.operation_id),
                )
                recorded = await cursor.fetchone()
                if recorded is not None:
                    if recorded[0] != request_hash:
                        raise StudioReviewIdempotencyConflict()
                    return _row_to_event(recorded[1:])

                await cursor.execute(
                    """
                    SELECT revision, document_json
                    FROM edit_document_revisions
                    WHERE project_id = %s AND document_id = %s
                    ORDER BY revision DESC LIMIT 1
                    FOR UPDATE
                    """,
                    (project_id, document_id),
                )
                row = await cursor.fetchone()
                if row is None:
                    raise StudioReviewDocumentNotFound()
                if row[0] != request.base_revision:
                    raise StudioReviewRevisionConflict(latest_revision=row[0])
                document = DOCUMENT_ADAPTER.validate_python(row[1])
                self._check_eligible(document, request)

                event_id = f"review_{uuid.uuid4().hex}"
                comment = isinstance(request, CreateComment)
                await cursor.execute(
                    """
                    INSERT INTO studio_review_events
                        (event_id, project_id, document_id, revision, operation_id,
                         request_hash, event_kind, actor_id, actor_type, actor_display_name,
                         comment_text, frame, decision, reason)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING created_at
                    """,
                    (
                        event_id,
                        project_id,
                        document_id,
                        request.base_revision,
                        request.operation_id,
                        request_hash,
                        kind,
                        actor.actor_id,
                        actor.actor_type,
                        actor.display_name,
                        request.text if comment else None,
                        request.frame if comment else None,
                        None if comment else request.decision,
                        None if comment else request.reason,
                    ),
                )
                inserted = await cursor.fetchone()
                if inserted is None:
                    raise StudioReviewPersistenceError()
                return _row_to_event(
                    (
                        event_id,
                        project_id,
                        document_id,
                        request.base_revision,
                        kind,
                        actor.actor_id,
                        actor.actor_type,
                        actor.display_name,
                        request.text if comment else None,
                        request.frame if comment else None,
                        None if comment else request.decision,
                        None if comment else request.reason,
                        inserted[0],
                    )
                )
        except _PASSTHROUGH:
            raise
        except StudioReviewPersistenceError:
            raise
        except Exception as error:
            raise StudioReviewPersistenceError() from error

    @staticmethod
    def _check_eligible(document: EditDocument, request: CreateComment | CreateDecision) -> None:
        if isinstance(request, CreateComment):
            if request.frame is not None and request.frame >= document.canvas.duration_in_frames:
                raise StudioReviewFrameOutOfRange()
            return
        if request.decision == "approved":
            issues = review_blocking_issues(document)
            if issues:
                raise StudioReviewNotEligible(issues)

    async def _list(
        self, project_id: str, document_id: str, kind: str, limit: int, cursor: str | None
    ) -> tuple[tuple[Any, ...], str | None]:
        bounded, keyset = _page_bounds(limit, cursor)
        # Comments read oldest-first, decisions newest-first; the project and
        # document predicates always apply, so a cursor can only move a keyset.
        direction, comparison = ("", ">") if kind == "comment" else (" DESC", "<")
        keyset_sql = "" if keyset is None else f"AND (created_at, event_id) {comparison} (%s, %s)"
        params: tuple[Any, ...] = (project_id, document_id, *(keyset or ()), bounded + 1)
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                db_cursor = connection.cursor()
                await db_cursor.execute(
                    f"""
                    SELECT {EVENT_COLUMNS}
                    FROM studio_review_events
                    WHERE project_id = %s AND document_id = %s AND event_kind = '{kind}'
                    {keyset_sql}
                    ORDER BY created_at{direction}, event_id{direction}
                    LIMIT %s
                    """,
                    params,
                )
                rows = await db_cursor.fetchall()
        except Exception as error:
            raise StudioReviewPersistenceError() from error
        events = tuple(_row_to_event(row) for row in rows[:bounded])
        last = rows[bounded - 1] if len(rows) > bounded else None
        return events, None if last is None else _encode_cursor(last[12], last[0])
