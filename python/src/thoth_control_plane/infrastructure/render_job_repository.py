"""PostgreSQL persistence for the one active render slot and its history.

Every mutation runs inside one short-lived transaction. Creation serializes on a
single advisory lock so the idempotency record and the active slot are decided
together, and the database keeps the same invariant independently through the
partial unique index on active rows. Lifecycle changes re-read the row `FOR
UPDATE` and hand it to the pure domain transition, so a duplicate, late, or
superseded callback can never win a race against a terminal state.
"""

from __future__ import annotations

import base64
import re
from datetime import datetime
from typing import Any

from psycopg import AsyncConnection
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from thoth_control_plane.application.render_job_ports import (
    InvalidRenderCursor,
    RenderBusy,
    RenderIdempotencyConflict,
    RenderJobNotFound,
    RenderPersistenceError,
)
from thoth_control_plane.domain.render_jobs import (
    InvalidRenderEvent,
    InvalidRenderTransition,
    RenderJob,
    RenderJobEvent,
    RenderJobPage,
    apply_render_event,
    mark_cancel_requested,
)

#: Selected in this exact order by every read and rebuilt by :func:`_row_to_job`.
RENDER_JOB_COLUMNS = (
    "render_job_id, project_id, document_id, document_revision, dispatch_id, "
    "template_id, template_version, preset_id, renderer_version, status, "
    "progress_percent, last_event_sequence, retry_of_job_id, created_by, created_at, "
    "started_at, finished_at, cancel_requested_at, artifacts_cleaned_at, failure_code, "
    "output_relative_path, output_media_type, output_size_bytes, output_checksum, provenance"
)

ACTIVE_STATUS_SQL = "('preparing', 'rendering', 'finalizing')"

#: One installation-wide lock namespace: creation is the only serialized path.
RENDER_LOCK_NAMESPACE = "render-jobs"
RENDER_LOCK_KEY = 1

#: The largest history page any caller may ask for, matching `RenderJobPage`.
MAX_PAGE_SIZE = 50

_CURSOR_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_JOB_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")

#: Typed outcomes the application maps to fixed safe codes; never redacted.
_PASSTHROUGH = (
    RenderBusy,
    RenderIdempotencyConflict,
    RenderJobNotFound,
    InvalidRenderCursor,
    InvalidRenderTransition,
    InvalidRenderEvent,
)

_UPDATE_SQL = """
    UPDATE render_jobs
    SET status = %s,
        progress_percent = %s,
        last_event_sequence = %s,
        started_at = %s,
        finished_at = %s,
        cancel_requested_at = %s,
        artifacts_cleaned_at = %s,
        failure_code = %s,
        output_relative_path = %s,
        output_media_type = %s,
        output_size_bytes = %s,
        output_checksum = %s,
        provenance = %s
    WHERE render_job_id = %s
"""


def _row_to_job(row: tuple[Any, ...]) -> RenderJob:
    """Rebuild one job, taking output facts from the provenance record."""
    provenance = row[24]
    return RenderJob.model_validate(
        {
            "render_job_id": row[0],
            "project_id": row[1],
            "document_id": row[2],
            "document_revision": row[3],
            "dispatch_id": row[4],
            "template_id": row[5],
            "template_version": row[6],
            "preset_id": row[7],
            "renderer_version": row[8],
            "status": row[9],
            "progress_percent": row[10],
            "last_event_sequence": row[11],
            "retry_of_job_id": row[12],
            "created_by": row[13],
            "created_at": row[14],
            "started_at": row[15],
            "finished_at": row[16],
            "cancel_requested_at": row[17],
            "artifacts_cleaned_at": row[18],
            "failure_code": row[19],
            "output_relative_path": row[20],
            "output": provenance.get("output"),
            "provenance": provenance,
        }
    )


def _update_params(job: RenderJob) -> tuple[Any, ...]:
    output = job.output
    return (
        job.status,
        job.progress_percent,
        job.last_event_sequence,
        job.started_at,
        job.finished_at,
        job.cancel_requested_at,
        job.artifacts_cleaned_at,
        job.failure_code,
        job.output_relative_path,
        None if output is None else output.media_type,
        None if output is None else output.size_bytes,
        None if output is None else output.checksum,
        Jsonb(job.provenance.model_dump(mode="json")),
        job.render_job_id,
    )


def _encode_cursor(job: RenderJob) -> str:
    raw = f"{job.created_at.isoformat()}|{job.render_job_id}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    """Accept only a cursor this server issued, so no filter is caller-authored."""
    if not _CURSOR_PATTERN.match(cursor):
        raise InvalidRenderCursor()
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise InvalidRenderCursor() from error
    stamp, separator, render_job_id = decoded.partition("|")
    if not separator or not _JOB_ID_PATTERN.match(render_job_id):
        raise InvalidRenderCursor()
    try:
        created_at = datetime.fromisoformat(stamp)
    except ValueError as error:
        raise InvalidRenderCursor() from error
    if created_at.tzinfo is None:
        raise InvalidRenderCursor()
    return created_at, render_job_id


class PostgresRenderJobRepository:
    """Open one short-lived async connection per render-job operation."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def reserve(
        self, job: RenderJob, *, idempotency_key: str, payload_hash: str
    ) -> RenderJob:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), %s)",
                    (RENDER_LOCK_NAMESPACE, RENDER_LOCK_KEY),
                )
                # Replay wins over the slot: an identical retry of a request that
                # already created the active job must return that same job.
                await cursor.execute(
                    """
                    SELECT payload_hash, render_job_id
                    FROM render_job_idempotency
                    WHERE project_id = %s AND idempotency_key = %s
                    FOR UPDATE
                    """,
                    (job.project_id, idempotency_key),
                )
                recorded = await cursor.fetchone()
                if recorded is not None:
                    if recorded[0] != payload_hash:
                        raise RenderIdempotencyConflict()
                    return await self._require_job(cursor, render_job_id=recorded[1])

                await cursor.execute(
                    f"""
                    SELECT render_job_id, project_id
                    FROM render_jobs
                    WHERE status IN {ACTIVE_STATUS_SQL}
                    FOR UPDATE
                    """,
                    (),
                )
                active = await cursor.fetchone()
                if active is not None:
                    raise RenderBusy(active_render_job_id=active[0], active_project_id=active[1])

                await self._insert(cursor, job)
                await cursor.execute(
                    """
                    INSERT INTO render_job_idempotency
                        (project_id, idempotency_key, payload_hash, render_job_id)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (job.project_id, idempotency_key, payload_hash, job.render_job_id),
                )
                return job
        except UniqueViolation as error:
            # The partial unique index is the authority even if the read above raced.
            raise RenderBusy() from error
        except _PASSTHROUGH:
            raise
        except Exception as error:
            raise RenderPersistenceError() from error

    async def get(self, *, project_id: str, render_job_id: str) -> RenderJob | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    f"""
                    SELECT {RENDER_JOB_COLUMNS}
                    FROM render_jobs
                    WHERE render_job_id = %s AND project_id = %s
                    """,
                    (render_job_id, project_id),
                )
                row = await cursor.fetchone()
                return None if row is None else _row_to_job(row)
        except Exception as error:
            raise RenderPersistenceError() from error

    async def get_internal(self, *, render_job_id: str) -> RenderJob | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    f"""
                    SELECT {RENDER_JOB_COLUMNS}
                    FROM render_jobs
                    WHERE render_job_id = %s
                    """,
                    (render_job_id,),
                )
                row = await cursor.fetchone()
                return None if row is None else _row_to_job(row)
        except Exception as error:
            raise RenderPersistenceError() from error

    async def list(self, *, project_id: str, limit: int, cursor: str | None) -> RenderJobPage:
        bounded = max(1, min(int(limit), MAX_PAGE_SIZE))
        keyset = None if cursor is None else _decode_cursor(cursor)
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                db_cursor = connection.cursor()
                if keyset is None:
                    await db_cursor.execute(
                        f"""
                        SELECT {RENDER_JOB_COLUMNS}
                        FROM render_jobs
                        WHERE project_id = %s
                        ORDER BY created_at DESC, render_job_id DESC
                        LIMIT %s
                        """,
                        (project_id, bounded + 1),
                    )
                else:
                    await db_cursor.execute(
                        f"""
                        SELECT {RENDER_JOB_COLUMNS}
                        FROM render_jobs
                        WHERE project_id = %s AND (created_at, render_job_id) < (%s, %s)
                        ORDER BY created_at DESC, render_job_id DESC
                        LIMIT %s
                        """,
                        (project_id, keyset[0], keyset[1], bounded + 1),
                    )
                rows = await db_cursor.fetchall()
        except _PASSTHROUGH:
            raise
        except Exception as error:
            raise RenderPersistenceError() from error

        jobs = tuple(_row_to_job(row) for row in rows[:bounded])
        next_cursor = _encode_cursor(jobs[-1]) if len(rows) > bounded and jobs else None
        return RenderJobPage(jobs=jobs, next_cursor=next_cursor)

    async def apply_event(
        self, *, render_job_id: str, event: RenderJobEvent, now: datetime
    ) -> RenderJob:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current = await self._require_job(cursor, render_job_id=render_job_id, lock=True)
                updated = apply_render_event(current, event, now)
                if updated != current:
                    await cursor.execute(_UPDATE_SQL, _update_params(updated))
                return updated
        except _PASSTHROUGH:
            raise
        except Exception as error:
            raise RenderPersistenceError() from error

    async def mark_cancel_requested(
        self, *, project_id: str, render_job_id: str, now: datetime
    ) -> tuple[RenderJob, bool]:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current = await self._require_job(
                    cursor, render_job_id=render_job_id, project_id=project_id, lock=True
                )
                updated = mark_cancel_requested(current, now)
                if updated == current:
                    return current, False
                await cursor.execute(_UPDATE_SQL, _update_params(updated))
                return updated, True
        except _PASSTHROUGH:
            raise
        except Exception as error:
            raise RenderPersistenceError() from error

    async def mark_cleaned(
        self, *, project_id: str, render_job_id: str, now: datetime
    ) -> RenderJob:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current = await self._require_job(
                    cursor, render_job_id=render_job_id, project_id=project_id, lock=True
                )
                if current.finished_at is None:
                    raise InvalidRenderTransition("an active render job cannot be cleaned up")
                if current.artifacts_cleaned_at is not None:
                    return current
                # The audit row and its safe provenance stay; only files go away.
                updated = current.model_copy(update={"artifacts_cleaned_at": now})
                await cursor.execute(_UPDATE_SQL, _update_params(updated))
                return updated
        except _PASSTHROUGH:
            raise
        except Exception as error:
            raise RenderPersistenceError() from error

    async def list_expired_active(self, *, deadline: datetime, limit: int) -> tuple[RenderJob, ...]:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    f"""
                    SELECT {RENDER_JOB_COLUMNS}
                    FROM render_jobs
                    WHERE status IN {ACTIVE_STATUS_SQL} AND created_at < %s
                    ORDER BY created_at ASC
                    LIMIT %s
                    """,
                    (deadline, max(1, min(int(limit), MAX_PAGE_SIZE))),
                )
                rows = await cursor.fetchall()
                return tuple(_row_to_job(row) for row in rows)
        except Exception as error:
            raise RenderPersistenceError() from error

    async def _insert(self, cursor: Any, job: RenderJob) -> None:
        output = job.output
        await cursor.execute(
            """
            INSERT INTO render_jobs
                (render_job_id, project_id, document_id, document_revision, dispatch_id,
                 template_id, template_version, preset_id, renderer_version, status,
                 progress_percent, last_event_sequence, retry_of_job_id, created_by,
                 created_at, started_at, finished_at, cancel_requested_at,
                 artifacts_cleaned_at, failure_code, output_relative_path,
                 output_media_type, output_size_bytes, output_checksum, provenance)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                job.render_job_id,
                job.project_id,
                job.document_id,
                job.document_revision,
                job.dispatch_id,
                job.template_id,
                job.template_version,
                job.preset_id,
                job.renderer_version,
                job.status,
                job.progress_percent,
                job.last_event_sequence,
                job.retry_of_job_id,
                job.created_by,
                job.created_at,
                job.started_at,
                job.finished_at,
                job.cancel_requested_at,
                job.artifacts_cleaned_at,
                job.failure_code,
                job.output_relative_path,
                None if output is None else output.media_type,
                None if output is None else output.size_bytes,
                None if output is None else output.checksum,
                Jsonb(job.provenance.model_dump(mode="json")),
            ),
        )

    async def _require_job(
        self,
        cursor: Any,
        *,
        render_job_id: str,
        project_id: str | None = None,
        lock: bool = False,
    ) -> RenderJob:
        scope = "" if project_id is None else " AND project_id = %s"
        params: tuple[Any, ...] = (
            (render_job_id,) if project_id is None else (render_job_id, project_id)
        )
        await cursor.execute(
            f"""
            SELECT {RENDER_JOB_COLUMNS}
            FROM render_jobs
            WHERE render_job_id = %s{scope}
            {"FOR UPDATE" if lock else ""}
            """,
            params,
        )
        row = await cursor.fetchone()
        if row is None:
            raise RenderJobNotFound()
        return _row_to_job(row)
