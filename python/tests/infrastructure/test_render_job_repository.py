"""Unit tests for singleton-slot, idempotent PostgreSQL render-job persistence."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from psycopg.errors import UniqueViolation

from thoth_control_plane.application.render_job_ports import (
    InvalidRenderCursor,
    RenderBusy,
    RenderIdempotencyConflict,
    RenderJobNotFound,
    RenderPersistenceError,
)
from thoth_control_plane.domain.render_jobs import (
    InvalidRenderTransition,
    RenderJob,
    RenderJobEvent,
)
from thoth_control_plane.infrastructure.render_job_repository import (
    PostgresRenderJobRepository,
)

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
LATER = datetime(2026, 9, 20, 12, 5, tzinfo=UTC)
CHECKSUM = "sha256:" + "a" * 64
HASH = "b" * 64
OTHER_HASH = "c" * 64
OUTPUT_PATH = "renders/rj_1/output.mp4"


def output_facts() -> dict[str, Any]:
    return {
        "media_type": "video/mp4",
        "size_bytes": 2_048_000,
        "checksum": CHECKSUM,
        "codec": "h264",
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
        "duration_seconds": 20.0,
        "has_audio": True,
    }


def job(**overrides: object) -> RenderJob:
    payload: dict[str, object] = {
        "render_job_id": "rj_1",
        "project_id": "project_alpha",
        "document_id": "doc_1",
        "document_revision": 7,
        "dispatch_id": "dispatch_1",
        "template_id": "vertical_text_story",
        "template_version": 1,
        "preset_id": "standard_vertical_mp4_v1",
        "renderer_version": "remotion-4.0.523",
        "status": "preparing",
        "last_event_sequence": 0,
        "created_by": "user_1",
        "created_at": NOW,
        "provenance": {
            "document_revision": 7,
            "template_id": "vertical_text_story",
            "template_version": 1,
            "preset_id": "standard_vertical_mp4_v1",
            "renderer_version": "remotion-4.0.523",
            "asset_checksums": [{"asset_id": "asset_main", "checksum": CHECKSUM}],
            "output": None,
        },
    }
    payload.update(overrides)
    return RenderJob.model_validate(payload)


def completed_job(**overrides: object) -> RenderJob:
    provenance = dict(job().provenance.model_dump(mode="json"))
    provenance["output"] = output_facts()
    payload: dict[str, object] = {
        "status": "completed",
        "last_event_sequence": 6,
        "finished_at": LATER,
        "output_relative_path": OUTPUT_PATH,
        "output": output_facts(),
        "provenance": provenance,
    }
    payload.update(overrides)
    return job(**payload)


def row_for(record: RenderJob) -> tuple[object, ...]:
    """Build the exact column tuple the repository selects for one job."""
    dumped = record.model_dump(mode="json")
    return (
        record.render_job_id,
        record.project_id,
        record.document_id,
        record.document_revision,
        record.dispatch_id,
        record.template_id,
        record.template_version,
        record.preset_id,
        record.renderer_version,
        record.status,
        record.progress_percent,
        record.last_event_sequence,
        record.retry_of_job_id,
        record.created_by,
        record.created_at,
        record.started_at,
        record.finished_at,
        record.cancel_requested_at,
        record.artifacts_cleaned_at,
        record.failure_code,
        record.output_relative_path,
        None if record.output is None else record.output.media_type,
        None if record.output is None else record.output.size_bytes,
        None if record.output is None else record.output.checksum,
        dumped["provenance"],
    )


def event(**overrides: object) -> RenderJobEvent:
    payload: dict[str, object] = {
        "render_job_id": "rj_1",
        "dispatch_id": "dispatch_1",
        "sequence": 1,
        "status": "rendering",
        "occurred_at": LATER,
    }
    payload.update(overrides)
    return RenderJobEvent.model_validate(payload)


class Cursor:
    """Route each read to a scripted result by a marker in its normalized SQL."""

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
        if self.error is not None and (self.error_on is None or self.error_on in statement):
            raise self.error
        self._result = None
        if not statement.startswith("SELECT"):
            return
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


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_value = cursor

    async def __aenter__(self) -> Connection:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def cursor(self) -> Cursor:
        return self.cursor_value


def repository(monkeypatch: pytest.MonkeyPatch, cursor: Cursor) -> PostgresRenderJobRepository:
    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.render_job_repository.AsyncConnection.connect",
        connect,
    )
    return PostgresRenderJobRepository("postgresql://redacted")


IDEMPOTENCY = "SELECT payload_hash"
ACTIVE_SLOT = "SELECT render_job_id, project_id FROM render_jobs"
JOB_SELECT = "project_id, document_id"
ADVISORY = "pg_advisory_xact_lock"


# --- reserve --------------------------------------------------------------


@pytest.mark.asyncio
async def test_reserve_serializes_on_one_render_lock_before_any_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({IDEMPOTENCY: [None], ACTIVE_SLOT: [None]})

    reserved = await repository(monkeypatch, cursor).reserve(
        job(), idempotency_key="rk_1", payload_hash=HASH
    )

    assert reserved == job()
    statements = cursor.statements()
    assert ADVISORY in statements[0]
    assert cursor.calls[0][1] == ("render-jobs", 1)
    assert IDEMPOTENCY in statements[1]
    assert ACTIVE_SLOT in statements[2]
    assert any("INSERT INTO render_jobs" in statement for statement in statements)
    assert any("INSERT INTO render_job_idempotency" in statement for statement in statements)
    assert all("project_alpha" not in query and "rk_1" not in query for query, _ in cursor.calls)


@pytest.mark.asyncio
async def test_identical_replay_wins_even_while_another_project_is_active(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = job()
    cursor = Cursor(
        {
            IDEMPOTENCY: [(HASH, "rj_1")],
            ACTIVE_SLOT: [("rj_9", "project_beta")],
            JOB_SELECT: [row_for(original)],
        }
    )
    store = repository(monkeypatch, cursor)

    replay = await store.reserve(original, idempotency_key="rk_1", payload_hash=HASH)
    assert replay.render_job_id == original.render_job_id
    assert not any("INSERT INTO render_jobs" in head for head in cursor.statements())

    with pytest.raises(RenderBusy) as busy:
        await store.reserve(
            job(render_job_id="rj_2", project_id="project_gamma"),
            idempotency_key="rk_2",
            payload_hash=OTHER_HASH,
        )
    assert str(busy.value) == "render busy"
    assert busy.value.active_render_job_id == "rj_9"
    assert busy.value.active_project_id == "project_beta"


@pytest.mark.asyncio
async def test_same_key_with_a_different_request_conflicts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({IDEMPOTENCY: [(OTHER_HASH, "rj_1")]})

    with pytest.raises(RenderIdempotencyConflict, match=r"^render idempotency conflict$"):
        await repository(monkeypatch, cursor).reserve(
            job(), idempotency_key="rk_1", payload_hash=HASH
        )


@pytest.mark.asyncio
async def test_database_active_slot_uniqueness_maps_to_render_busy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor(
        {IDEMPOTENCY: [None], ACTIVE_SLOT: [None]},
        error=UniqueViolation("render_jobs_one_active_slot"),
        error_on="INSERT INTO render_jobs",
    )

    with pytest.raises(RenderBusy) as busy:
        await repository(monkeypatch, cursor).reserve(
            job(), idempotency_key="rk_1", payload_hash=HASH
        )
    assert busy.value.active_render_job_id is None
    assert "render_jobs_one_active_slot" not in str(busy.value)


@pytest.mark.asyncio
async def test_unexpected_database_failure_is_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example/thoth")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.render_job_repository.AsyncConnection.connect",
        broken,
    )

    with pytest.raises(RenderPersistenceError, match=r"^render persistence unavailable$"):
        await PostgresRenderJobRepository("postgresql://redacted").get(
            project_id="project_alpha", render_job_id="rj_1"
        )


# --- reads ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_is_project_scoped_and_rebuilds_output_from_provenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [row_for(completed_job())]})

    found = await repository(monkeypatch, cursor).get(
        project_id="project_alpha", render_job_id="rj_1"
    )

    assert found == completed_job()
    assert found is not None and found.output is not None
    assert found.output.codec == "h264"
    query, params = cursor.calls[0]
    assert "WHERE render_job_id = %s AND project_id = %s" in " ".join(query.split())
    assert params == ("rj_1", "project_alpha")


@pytest.mark.asyncio
async def test_get_returns_none_for_another_project(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = Cursor({JOB_SELECT: [None]})

    assert (
        await repository(monkeypatch, cursor).get(project_id="project_beta", render_job_id="rj_1")
        is None
    )


@pytest.mark.asyncio
async def test_internal_read_is_not_project_scoped(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = Cursor({JOB_SELECT: [row_for(job())]})

    found = await repository(monkeypatch, cursor).get_internal(render_job_id="rj_1")

    assert found == job()
    query, params = cursor.calls[0]
    assert "project_id = %s" not in " ".join(query.split()).split("WHERE")[1]
    assert params == ("rj_1",)


@pytest.mark.asyncio
async def test_history_is_newest_first_bounded_and_keyset_paginated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    newest = job(render_job_id="rj_3", created_at=LATER)
    middle = job(render_job_id="rj_2")
    overflow = job(render_job_id="rj_1")
    cursor = Cursor({JOB_SELECT: [[row_for(newest), row_for(middle), row_for(overflow)]]})

    page = await repository(monkeypatch, cursor).list(
        project_id="project_alpha", limit=2, cursor=None
    )

    assert [entry.render_job_id for entry in page.jobs] == ["rj_3", "rj_2"]
    assert page.next_cursor is not None
    query, params = cursor.calls[0]
    normalized = " ".join(query.split())
    assert "ORDER BY created_at DESC, render_job_id DESC" in normalized
    assert params[0] == "project_alpha"
    assert params[-1] == 3


@pytest.mark.asyncio
async def test_history_continues_after_the_returned_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = Cursor({JOB_SELECT: [[row_for(job(render_job_id="rj_2")), row_for(job())]]})
    store = repository(monkeypatch, first)
    page = await store.list(project_id="project_alpha", limit=1, cursor=None)

    second = Cursor({JOB_SELECT: [[row_for(job())]]})
    store = repository(monkeypatch, second)
    await store.list(project_id="project_alpha", limit=1, cursor=page.next_cursor)

    _, params = second.calls[0]
    assert params[0] == "project_alpha"
    assert params[1] == job(render_job_id="rj_2").created_at
    assert params[2] == "rj_2"


@pytest.mark.asyncio
async def test_history_limit_is_clamped_to_the_server_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [[]]})

    await repository(monkeypatch, cursor).list(project_id="project_alpha", limit=5_000, cursor=None)

    assert cursor.calls[0][1][-1] == 51


@pytest.mark.asyncio
async def test_unreadable_cursor_is_refused_without_a_database_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [[]]})

    with pytest.raises(InvalidRenderCursor, match=r"^render cursor invalid$"):
        await repository(monkeypatch, cursor).list(
            project_id="project_alpha", limit=10, cursor="../../etc/passwd"
        )
    assert cursor.calls == []


# --- event application ----------------------------------------------------


@pytest.mark.asyncio
async def test_apply_event_locks_the_row_and_persists_the_transition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [row_for(job())]})

    updated = await repository(monkeypatch, cursor).apply_event(
        render_job_id="rj_1", event=event(sequence=1, status="rendering"), now=LATER
    )

    assert updated.status == "rendering"
    assert updated.started_at == LATER
    select, _ = cursor.calls[0]
    assert "FOR UPDATE" in select
    update_query, update_params = cursor.calls[1]
    assert "UPDATE render_jobs" in update_query
    assert "%s" in update_query
    assert update_params[-1] == "rj_1"


@pytest.mark.asyncio
async def test_apply_event_writes_nothing_when_the_event_changes_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [row_for(job(status="rendering", last_event_sequence=4))]})

    unchanged = await repository(monkeypatch, cursor).apply_event(
        render_job_id="rj_1", event=event(sequence=4, status="finalizing"), now=LATER
    )

    assert unchanged.status == "rendering"
    assert not any("UPDATE render_jobs" in head for head in cursor.statements())


@pytest.mark.asyncio
async def test_apply_event_never_reopens_a_terminal_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancelled = job(status="cancelled", last_event_sequence=6, finished_at=LATER)
    cursor = Cursor({JOB_SELECT: [row_for(cancelled)]})

    unchanged = await repository(monkeypatch, cursor).apply_event(
        render_job_id="rj_1", event=event(sequence=9, status="rendering"), now=LATER
    )

    assert unchanged.status == "cancelled"
    assert not any("UPDATE render_jobs" in head for head in cursor.statements())


@pytest.mark.asyncio
async def test_apply_event_for_a_missing_job_is_reported_as_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [None]})

    with pytest.raises(RenderJobNotFound, match=r"^render job not found$"):
        await repository(monkeypatch, cursor).apply_event(
            render_job_id="rj_missing", event=event(), now=LATER
        )


# --- cancel and cleanup ---------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_request_is_recorded_once(monkeypatch: pytest.MonkeyPatch) -> None:
    active = job(status="rendering", last_event_sequence=2)
    cursor = Cursor({JOB_SELECT: [row_for(active)]})

    first, requested = await repository(monkeypatch, cursor).mark_cancel_requested(
        project_id="project_alpha", render_job_id="rj_1", now=NOW
    )
    assert requested is True
    assert first.cancel_requested_at == NOW
    assert any("UPDATE render_jobs" in head for head in cursor.statements())

    repeat = Cursor({JOB_SELECT: [row_for(first)]})
    _, again = await repository(monkeypatch, repeat).mark_cancel_requested(
        project_id="project_alpha", render_job_id="rj_1", now=LATER
    )
    assert again is False
    assert not any("UPDATE render_jobs" in head for head in repeat.statements())


@pytest.mark.asyncio
async def test_cancel_request_is_refused_for_a_terminal_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [row_for(completed_job())]})

    with pytest.raises(InvalidRenderTransition):
        await repository(monkeypatch, cursor).mark_cancel_requested(
            project_id="project_alpha", render_job_id="rj_1", now=LATER
        )


@pytest.mark.asyncio
async def test_cleanup_marks_a_terminal_job_once_and_keeps_the_audit_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [row_for(completed_job())]})

    cleaned = await repository(monkeypatch, cursor).mark_cleaned(
        project_id="project_alpha", render_job_id="rj_1", now=LATER
    )

    assert cleaned.artifacts_cleaned_at == LATER
    assert cleaned.output_relative_path == OUTPUT_PATH
    assert cleaned.provenance.output is not None
    assert not any("DELETE" in head for head in cursor.statements())

    repeat = Cursor({JOB_SELECT: [row_for(cleaned)]})
    again = await repository(monkeypatch, repeat).mark_cleaned(
        project_id="project_alpha", render_job_id="rj_1", now=NOW
    )
    assert again.artifacts_cleaned_at == LATER
    assert not any("UPDATE render_jobs" in head for head in repeat.statements())


@pytest.mark.asyncio
async def test_cleanup_is_refused_while_the_job_is_active(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [row_for(job(status="rendering"))]})

    with pytest.raises(InvalidRenderTransition):
        await repository(monkeypatch, cursor).mark_cleaned(
            project_id="project_alpha", render_job_id="rj_1", now=LATER
        )


@pytest.mark.asyncio
async def test_expired_active_scan_is_bounded_to_active_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = Cursor({JOB_SELECT: [[row_for(job(status="rendering"))]]})

    expired = await repository(monkeypatch, cursor).list_expired_active(deadline=LATER, limit=10)

    assert [entry.render_job_id for entry in expired] == ["rj_1"]
    query, params = cursor.calls[0]
    normalized = " ".join(query.split())
    assert "WHERE status IN ('preparing', 'rendering', 'finalizing')" in normalized
    assert "created_at < %s" in normalized
    assert params == (LATER, 10)
