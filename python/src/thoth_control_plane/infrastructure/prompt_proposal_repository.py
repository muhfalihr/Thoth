"""Project-scoped PostgreSQL persistence for Prompt Lab AI proposals (C2)."""

from __future__ import annotations

import base64
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from psycopg import AsyncConnection

from thoth_control_plane.application.ports import PromptTemplateNotFound
from thoth_control_plane.application.prompt_proposal_ports import (
    PromptIdempotencyConflict,
    PromptLockRevisionConflict,
    PromptPreferenceRevisionConflict,
    PromptProposalActiveGeneration,
    PromptProposalApplyResult,
    PromptProposalInvalidSelection,
    PromptProposalInvalidTransition,
    PromptProposalLayerLocked,
    PromptProposalNotFound,
    PromptProposalStale,
    PromptProposalStoreUnavailable,
)
from thoth_control_plane.domain.prompt_proposals import (
    PROMPT_PROPOSAL_FAILURE_CODES,
    ProjectPromptLayerLock,
    ProjectPromptModelPreference,
    PromptProposal,
    PromptProposalChange,
    PromptProposalPage,
    SavePromptLayerLockRequest,
    SavePromptModelPreferenceRequest,
    apply_prompt_changes,
    build_prompt_changes,
    is_legal_transition,
)

HISTORY_LIMIT_MAX = 50

PROPOSAL_KEYS = (
    "proposal_id",
    "project_id",
    "stage_id",
    "kind",
    "status",
    "target_layers",
    "source_template_id",
    "source_template_revision",
    "source_binding_revision",
    "source_language",
    "source_template_body",
    "source_project_override",
    "target_language",
    "improvement_instructions",
    "provider_id",
    "model_id",
    "translated_template_body",
    "translated_project_override",
    "failure_code",
    "created_at",
    "started_at",
    "finished_at",
)


def _iso(value: object) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return value if isinstance(value, str) else None


def _proposal(row: tuple[object, ...]) -> PromptProposal:
    values = dict(zip(PROPOSAL_KEYS, row, strict=True))
    return PromptProposal.model_validate(
        {
            "proposal_id": values["proposal_id"],
            "project_id": values["project_id"],
            "stage_id": values["stage_id"],
            "kind": values["kind"],
            "status": values["status"],
            "target_layers": values["target_layers"],
            "source": {
                "template_id": values["source_template_id"],
                "template_revision": values["source_template_revision"],
                "binding_revision": values["source_binding_revision"],
                "template_language": values["source_language"],
                "template_body": values["source_template_body"],
                "project_override": values["source_project_override"],
            },
            "target_language": values["target_language"],
            "improvement_instructions": values["improvement_instructions"],
            "provider_id": values["provider_id"],
            "model_id": values["model_id"],
            "translated_template_body": values["translated_template_body"],
            "translated_project_override": values["translated_project_override"],
            "failure_code": values["failure_code"],
            "created_at": _iso(values["created_at"]),
            "started_at": _iso(values["started_at"]),
            "finished_at": _iso(values["finished_at"]),
        }
    )


def _cursor_token(created_at: datetime, proposal_id: str) -> str:
    raw = f"{created_at.isoformat()}|{proposal_id}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
    created_at_raw, proposal_id = raw.split("|", 1)
    return datetime.fromisoformat(created_at_raw), proposal_id


class PostgresPromptProposalRepository:
    """Open one short-lived async connection per project-scoped operation."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def get_preference(
        self, project_id: str, stage_id: str
    ) -> ProjectPromptModelPreference | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT provider_id, model_id, revision, updated_at
                    FROM prompt_provider_preferences
                    WHERE project_id = %s AND stage_id = %s
                    """,
                    (project_id, stage_id),
                )
                row = await cursor.fetchone()
                if row is None:
                    return None
                return ProjectPromptModelPreference.model_validate(
                    {
                        "project_id": project_id,
                        "stage_id": stage_id,
                        "provider_id": row[0],
                        "model_id": row[1],
                        "revision": row[2],
                        "updated_at": _iso(row[3]),
                    }
                )
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def save_preference(
        self, project_id: str, stage_id: str, request: SavePromptModelPreferenceRequest
    ) -> ProjectPromptModelPreference:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT provider_id, model_id, revision, updated_at
                    FROM prompt_provider_preferences
                    WHERE project_id = %s AND stage_id = %s
                    FOR UPDATE
                    """,
                    (project_id, stage_id),
                )
                row = await cursor.fetchone()
                if row is None:
                    preference = ProjectPromptModelPreference.model_validate(
                        {
                            "project_id": project_id,
                            "stage_id": stage_id,
                            "provider_id": request.provider_id,
                            "model_id": request.model_id,
                            "revision": 1,
                            "updated_at": datetime.now(UTC).isoformat(),
                        }
                    )
                    await cursor.execute(
                        """
                        INSERT INTO prompt_provider_preferences
                            (project_id, stage_id, provider_id, model_id, revision)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            project_id,
                            stage_id,
                            request.provider_id,
                            request.model_id,
                            1,
                        ),
                    )
                    return preference
                latest = ProjectPromptModelPreference.model_validate(
                    {
                        "project_id": project_id,
                        "stage_id": stage_id,
                        "provider_id": row[0],
                        "model_id": row[1],
                        "revision": row[2],
                        "updated_at": _iso(row[3]),
                    }
                )
                if request.base_revision is None or request.base_revision != latest.revision:
                    raise PromptPreferenceRevisionConflict(latest)
                next_revision = latest.revision + 1
                await cursor.execute(
                    """
                    UPDATE prompt_provider_preferences
                    SET provider_id = %s, model_id = %s, revision = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE project_id = %s AND stage_id = %s
                    """,
                    (
                        request.provider_id,
                        request.model_id,
                        next_revision,
                        project_id,
                        stage_id,
                    ),
                )
                return latest.model_copy(
                    update={
                        "provider_id": request.provider_id,
                        "model_id": request.model_id,
                        "revision": next_revision,
                    }
                )
        except PromptPreferenceRevisionConflict:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def get_locks(self, project_id: str, stage_id: str) -> tuple[ProjectPromptLayerLock, ...]:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT layer, locked, revision, updated_at
                    FROM prompt_layer_locks
                    WHERE project_id = %s AND stage_id = %s
                    ORDER BY layer
                    """,
                    (project_id, stage_id),
                )
                rows = await cursor.fetchall()
                locks = [
                    ProjectPromptLayerLock.model_validate(
                        {
                            "project_id": project_id,
                            "stage_id": stage_id,
                            "layer": row[0],
                            "locked": row[1],
                            "revision": row[2],
                            "updated_at": _iso(row[3]),
                        }
                    )
                    for row in rows
                ]
                locks.sort(key=lambda lock: (lock.layer != "template", lock.layer))
                return tuple(locks)
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def save_lock(
        self, project_id: str, stage_id: str, layer: str, request: SavePromptLayerLockRequest
    ) -> ProjectPromptLayerLock:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT layer, locked, revision, updated_at
                    FROM prompt_layer_locks
                    WHERE project_id = %s AND stage_id = %s AND layer = %s
                    FOR UPDATE
                    """,
                    (project_id, stage_id, layer),
                )
                row = await cursor.fetchone()
                if row is None:
                    lock = ProjectPromptLayerLock.model_validate(
                        {
                            "project_id": project_id,
                            "stage_id": stage_id,
                            "layer": layer,
                            "locked": request.locked,
                            "revision": 1,
                            "updated_at": datetime.now(UTC).isoformat(),
                        }
                    )
                    await cursor.execute(
                        """
                        INSERT INTO prompt_layer_locks
                            (project_id, stage_id, layer, locked, revision)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (project_id, stage_id, layer, request.locked, 1),
                    )
                    return lock
                latest = ProjectPromptLayerLock.model_validate(
                    {
                        "project_id": project_id,
                        "stage_id": stage_id,
                        "layer": row[0],
                        "locked": row[1],
                        "revision": row[2],
                        "updated_at": _iso(row[3]),
                    }
                )
                if request.base_revision is None or request.base_revision != latest.revision:
                    raise PromptLockRevisionConflict(latest)
                next_revision = latest.revision + 1
                await cursor.execute(
                    """
                    UPDATE prompt_layer_locks
                    SET locked = %s, revision = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE project_id = %s AND stage_id = %s AND layer = %s
                    """,
                    (request.locked, next_revision, project_id, stage_id, layer),
                )
                return latest.model_copy(
                    update={"locked": request.locked, "revision": next_revision}
                )
        except PromptLockRevisionConflict:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def reserve_proposal(
        self, proposal: PromptProposal, idempotency_key: str, payload_hash: str
    ) -> PromptProposal:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                    (proposal.project_id, proposal.stage_id),
                )
                await cursor.execute(
                    """
                    SELECT payload_hash, proposal_id
                    FROM prompt_proposal_idempotency
                    WHERE project_id = %s AND idempotency_key = %s
                    """,
                    (proposal.project_id, idempotency_key),
                )
                existing = await cursor.fetchone()
                if existing is not None:
                    if existing[0] != payload_hash:
                        raise PromptIdempotencyConflict(existing[1])
                    replayed = await self._select_proposal(cursor, proposal.project_id, existing[1])
                    if replayed is None:
                        raise PromptProposalNotFound()
                    return replayed
                await cursor.execute(
                    """
                    SELECT proposal_id
                    FROM prompt_proposals
                    WHERE project_id = %s AND stage_id = %s
                        AND status IN ('queued', 'running')
                    """,
                    (proposal.project_id, proposal.stage_id),
                )
                active = await cursor.fetchone()
                if active is not None:
                    raise PromptProposalActiveGeneration(active[0])
                saved = proposal.model_copy(update={"created_at": datetime.now(UTC).isoformat()})
                await cursor.execute(
                    """
                    INSERT INTO prompt_proposals
                        (proposal_id, project_id, stage_id, kind, status, target_layers,
                            source_template_id, source_template_revision, source_binding_revision,
                            source_language, source_template_body, source_project_override,
                            target_language, improvement_instructions, provider_id, model_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        saved.proposal_id,
                        saved.project_id,
                        saved.stage_id,
                        saved.kind,
                        saved.status,
                        list(saved.target_layers),
                        saved.source.template_id,
                        saved.source.template_revision,
                        saved.source.binding_revision,
                        saved.source.template_language,
                        saved.source.template_body,
                        saved.source.project_override,
                        saved.target_language,
                        saved.improvement_instructions,
                        saved.provider_id,
                        saved.model_id,
                    ),
                )
                await cursor.execute(
                    """
                    INSERT INTO prompt_proposal_idempotency
                        (project_id, idempotency_key, payload_hash, proposal_id)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (saved.project_id, idempotency_key, payload_hash, saved.proposal_id),
                )
                return saved
        except (
            PromptIdempotencyConflict,
            PromptProposalActiveGeneration,
            PromptProposalNotFound,
        ):
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def get_proposal(self, project_id: str, proposal_id: str) -> PromptProposal | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                return await self._select_proposal(cursor, project_id, proposal_id)
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def list_proposals(
        self, project_id: str, stage_id: str, cursor_token: str | None, limit: int
    ) -> PromptProposalPage:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                clamped = max(1, min(int(limit), HISTORY_LIMIT_MAX))
                params: list[Any] = [project_id, stage_id]
                condition = ""
                if cursor_token:
                    created_at, proposal_id = _decode_cursor(cursor_token)
                    condition = " AND (created_at, proposal_id) < (%s, %s)"
                    params.extend([created_at, proposal_id])
                params.append(clamped + 1)
                await cursor.execute(
                    f"""
                    SELECT {", ".join(PROPOSAL_KEYS)}
                    FROM prompt_proposals
                    WHERE project_id = %s AND stage_id = %s{condition}
                    ORDER BY created_at DESC, proposal_id DESC
                    LIMIT %s
                    """,
                    tuple(params),
                )
                rows = await cursor.fetchall()
                next_cursor = None
                if len(rows) > clamped:
                    rows = rows[:clamped]
                    next_cursor = _cursor_token(
                        rows[-1][PROPOSAL_KEYS.index("created_at")], rows[-1][0]
                    )
                proposals = [_proposal(row) for row in rows]
                return PromptProposalPage.model_validate(
                    {"proposals": proposals, "next_cursor": next_cursor}
                )
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def mark_running(self, proposal_id: str) -> PromptProposal:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current = await self._select_proposal_by_id(cursor, proposal_id)
                if not is_legal_transition(current.status, "running"):
                    raise PromptProposalInvalidTransition()
                await cursor.execute(
                    """
                    UPDATE prompt_proposals
                    SET status = %s, started_at = CURRENT_TIMESTAMP
                    WHERE proposal_id = %s
                    """,
                    ("running", proposal_id),
                )
                return current.model_copy(update={"status": "running"})
        except PromptProposalInvalidTransition:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def record_success(
        self, proposal_id: str, text_by_layer: dict[str, str]
    ) -> PromptProposal:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current = await self._select_proposal_by_id(cursor, proposal_id)
                if not is_legal_transition(current.status, "succeeded"):
                    raise PromptProposalInvalidTransition()
                if current.kind == "translate":
                    await cursor.execute(
                        """
                        UPDATE prompt_proposals
                        SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP,
                            translated_template_body = %s, translated_project_override = %s
                        WHERE proposal_id = %s
                        """,
                        (
                            text_by_layer.get("template"),
                            text_by_layer.get("project_override"),
                            proposal_id,
                        ),
                    )
                    return current.model_copy(
                        update={
                            "status": "succeeded",
                            "translated_template_body": text_by_layer.get("template"),
                            "translated_project_override": text_by_layer.get("project_override"),
                        }
                    )
                if not text_by_layer or set(text_by_layer) - set(current.target_layers):
                    raise PromptProposalInvalidTransition()
                if True:
                    layer = current.target_layers[0]
                    source_text = (
                        current.source.template_body
                        if layer == "template"
                        else current.source.project_override or ""
                    )
                    changes = build_prompt_changes(layer, source_text, text_by_layer[layer])
                    for ordinal, change in enumerate(changes):
                        await cursor.execute(
                            """
                            INSERT INTO prompt_proposal_changes
                                (proposal_id, change_id, ordinal, layer, before_text,
                                    after_text, start_line, end_line)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                            """,
                            (
                                proposal_id,
                                change.change_id,
                                ordinal,
                                change.layer,
                                change.before_text,
                                change.after_text,
                                change.start_line,
                                change.end_line,
                            ),
                        )
                    await cursor.execute(
                        """
                        UPDATE prompt_proposals
                        SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP
                        WHERE proposal_id = %s
                        """,
                        (proposal_id,),
                    )
                return current.model_copy(update={"status": "succeeded"})
        except PromptProposalInvalidTransition:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def record_failure(self, proposal_id: str, failure_code: str) -> PromptProposal:
        if failure_code not in PROMPT_PROPOSAL_FAILURE_CODES:
            raise ValueError("unsafe failure code")
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current = await self._select_proposal_by_id(cursor, proposal_id)
                if not is_legal_transition(current.status, "failed"):
                    raise PromptProposalInvalidTransition()
                await cursor.execute(
                    """
                    UPDATE prompt_proposals
                    SET status = 'failed', finished_at = CURRENT_TIMESTAMP, failure_code = %s
                    WHERE proposal_id = %s
                    """,
                    (failure_code, proposal_id),
                )
                return current.model_copy(update={"status": "failed", "failure_code": failure_code})
        except PromptProposalInvalidTransition:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def reject_proposal(self, project_id: str, proposal_id: str) -> PromptProposal:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current = await self._select_proposal(cursor, project_id, proposal_id)
                if current is None:
                    raise PromptProposalNotFound()
                if not is_legal_transition(current.status, "rejected"):
                    raise PromptProposalInvalidTransition()
                await cursor.execute(
                    """
                    UPDATE prompt_proposals
                    SET status = 'rejected', finished_at = CURRENT_TIMESTAMP
                    WHERE proposal_id = %s
                    """,
                    (proposal_id,),
                )
                return current.model_copy(update={"status": "rejected"})
        except (PromptProposalNotFound, PromptProposalInvalidTransition):
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def apply_improvement(
        self, project_id: str, proposal_id: str, change_ids: list[str], actor: str
    ) -> PromptProposalApplyResult:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current, binding, locks = await self._lock_for_apply(
                    cursor, project_id, proposal_id
                )
                if current.kind != "improve" or len(current.target_layers) != 1:
                    raise PromptProposalInvalidTransition()
                layer = current.target_layers[0]
                self._require_unlocked(locks, layer)
                stored = await self._select_changes(cursor, proposal_id)
                selected = [stored[change_id] for change_id in change_ids if change_id in stored]
                if len(selected) != len(change_ids):
                    raise PromptProposalInvalidSelection()
                source_text = (
                    current.source.template_body
                    if layer == "template"
                    else current.source.project_override or ""
                )
                new_text = apply_prompt_changes(
                    source_text, tuple(stored.values()), set(change_ids)
                )
                if layer == "template":
                    resulting_template_id = current.source.template_id
                    resulting_template_revision = binding["template_revision"] + 1
                    await cursor.execute(
                        """
                        INSERT INTO prompt_template_revisions
                            (project_id, template_id, revision, stage_id, language, body)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            project_id,
                            resulting_template_id,
                            resulting_template_revision,
                            current.stage_id,
                            current.source.template_language,
                            new_text,
                        ),
                    )
                    resulting_binding_revision = binding["revision"] + 1
                    await cursor.execute(
                        """
                        UPDATE project_prompt_bindings
                        SET template_revision = %s, revision = %s, updated_at = CURRENT_TIMESTAMP
                        WHERE project_id = %s AND stage_id = %s
                        """,
                        (
                            resulting_template_revision,
                            resulting_binding_revision,
                            project_id,
                            current.stage_id,
                        ),
                    )
                else:
                    resulting_template_id = binding["template_id"]
                    resulting_template_revision = binding["template_revision"]
                    resulting_binding_revision = binding["revision"] + 1
                    await cursor.execute(
                        """
                        UPDATE project_prompt_bindings
                        SET project_override = %s, revision = %s, updated_at = CURRENT_TIMESTAMP
                        WHERE project_id = %s AND stage_id = %s
                        """,
                        (new_text, resulting_binding_revision, project_id, current.stage_id),
                    )
                await cursor.execute(
                    """
                    INSERT INTO prompt_proposal_applications
                        (proposal_id, project_id, stage_id, accepted_change_ids,
                            approving_actor, resulting_template_id, resulting_template_revision,
                            resulting_binding_revision, ownership, approval_mode)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'ai_assisted', 'user_approved')
                    """,
                    (
                        proposal_id,
                        project_id,
                        current.stage_id,
                        list(change_ids),
                        actor,
                        resulting_template_id,
                        resulting_template_revision,
                        resulting_binding_revision,
                    ),
                )
                applied = await self._finish_apply(cursor, current)
                return PromptProposalApplyResult.model_validate(
                    {
                        "proposal": applied.model_dump(mode="json"),
                        "resulting_template_id": resulting_template_id,
                        "resulting_template_revision": resulting_template_revision,
                        "resulting_binding_revision": resulting_binding_revision,
                    }
                )
        except (
            PromptProposalInvalidTransition,
            PromptProposalStale,
            PromptProposalLayerLocked,
            PromptProposalInvalidSelection,
            PromptProposalNotFound,
            PromptTemplateNotFound,
        ):
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def apply_translation(
        self, project_id: str, proposal_id: str, actor: str
    ) -> PromptProposalApplyResult:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                current, binding, locks = await self._lock_for_apply(
                    cursor, project_id, proposal_id
                )
                if current.kind != "translate" or current.translated_template_body is None:
                    raise PromptProposalInvalidTransition()
                for layer in current.target_layers:
                    self._require_unlocked(locks, layer)
                resulting_template_id = f"ptpl_{uuid4().hex}"
                resulting_template_revision = 1
                resulting_binding_revision = binding["revision"] + 1
                await cursor.execute(
                    """
                    INSERT INTO prompt_template_revisions
                        (project_id, template_id, revision, stage_id, language, body)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        project_id,
                        resulting_template_id,
                        resulting_template_revision,
                        current.stage_id,
                        current.target_language,
                        current.translated_template_body,
                    ),
                )
                await cursor.execute(
                    """
                    UPDATE project_prompt_bindings
                    SET template_id = %s, template_revision = %s, project_override = %s,
                        revision = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE project_id = %s AND stage_id = %s
                    """,
                    (
                        resulting_template_id,
                        resulting_template_revision,
                        current.translated_project_override,
                        resulting_binding_revision,
                        project_id,
                        current.stage_id,
                    ),
                )
                await cursor.execute(
                    """
                    INSERT INTO prompt_proposal_applications
                        (proposal_id, project_id, stage_id, accepted_change_ids,
                            approving_actor, resulting_template_id, resulting_template_revision,
                            resulting_binding_revision, ownership, approval_mode)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'ai_assisted', 'user_approved')
                    """,
                    (
                        proposal_id,
                        project_id,
                        current.stage_id,
                        [],
                        actor,
                        resulting_template_id,
                        resulting_template_revision,
                        resulting_binding_revision,
                    ),
                )
                applied = await self._finish_apply(cursor, current)
                return PromptProposalApplyResult.model_validate(
                    {
                        "proposal": applied.model_dump(mode="json"),
                        "resulting_template_id": resulting_template_id,
                        "resulting_template_revision": resulting_template_revision,
                        "resulting_binding_revision": resulting_binding_revision,
                    }
                )
        except (
            PromptProposalInvalidTransition,
            PromptProposalStale,
            PromptProposalLayerLocked,
            PromptProposalNotFound,
            PromptTemplateNotFound,
        ):
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def _lock_for_apply(
        self, cursor: Any, project_id: str, proposal_id: str
    ) -> tuple[PromptProposal, dict[str, Any], list[ProjectPromptLayerLock]]:
        await cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
            (project_id, "stage-lock"),
        )
        current = await self._select_proposal(cursor, project_id, proposal_id)
        if current is None:
            raise PromptProposalNotFound()
        if current.status != "succeeded":
            raise PromptProposalInvalidTransition()
        await cursor.execute(
            """
            SELECT template_id, template_revision, project_override, revision
            FROM project_prompt_bindings
            WHERE project_id = %s AND stage_id = %s
            FOR UPDATE
            """,
            (project_id, current.stage_id),
        )
        binding_row = await cursor.fetchone()
        if binding_row is None:
            raise PromptProposalStale()
        binding = {
            "template_id": binding_row[0],
            "template_revision": binding_row[1],
            "project_override": binding_row[2],
            "revision": binding_row[3],
        }
        if (
            binding["template_id"] != current.source.template_id
            or binding["template_revision"] != current.source.template_revision
            or binding["revision"] != current.source.binding_revision
        ):
            raise PromptProposalStale()
        await cursor.execute(
            """
            SELECT layer, locked, revision, updated_at
            FROM prompt_layer_locks
            WHERE project_id = %s AND stage_id = %s
            """,
            (project_id, current.stage_id),
        )
        lock_rows = await cursor.fetchall()
        locks = [
            ProjectPromptLayerLock.model_validate(
                {
                    "project_id": project_id,
                    "stage_id": current.stage_id,
                    "layer": row[0],
                    "locked": row[1],
                    "revision": row[2],
                    "updated_at": _iso(row[3]),
                }
            )
            for row in lock_rows
        ]
        return current, binding, locks

    @staticmethod
    def _require_unlocked(locks: list[ProjectPromptLayerLock], layer: str) -> None:
        for lock in locks:
            if lock.layer == layer and lock.locked:
                raise PromptProposalLayerLocked()

    @staticmethod
    async def _select_changes(cursor: Any, proposal_id: str) -> dict[str, PromptProposalChange]:
        await cursor.execute(
            """
            SELECT change_id, layer, before_text, after_text, start_line, end_line
            FROM prompt_proposal_changes
            WHERE proposal_id = %s
            ORDER BY ordinal
            """,
            (proposal_id,),
        )
        rows = await cursor.fetchall()
        return {
            row[0]: PromptProposalChange.model_validate(
                {
                    "change_id": row[0],
                    "layer": row[1],
                    "before_text": row[2],
                    "after_text": row[3],
                    "start_line": row[4],
                    "end_line": row[5],
                }
            )
            for row in rows
        }

    @staticmethod
    async def _finish_apply(cursor: Any, current: PromptProposal) -> PromptProposal:
        await cursor.execute(
            """
            UPDATE prompt_proposals
            SET status = 'applied', finished_at = CURRENT_TIMESTAMP
            WHERE proposal_id = %s
            """,
            (current.proposal_id,),
        )
        return current.model_copy(update={"status": "applied"})

    @staticmethod
    async def _select_proposal(
        cursor: Any, project_id: str, proposal_id: str
    ) -> PromptProposal | None:
        await cursor.execute(
            f"""
            SELECT {", ".join(PROPOSAL_KEYS)}
            FROM prompt_proposals
            WHERE project_id = %s AND proposal_id = %s
            FOR UPDATE
            """,
            (project_id, proposal_id),
        )
        row = await cursor.fetchone()
        return _proposal(row) if row else None

    @staticmethod
    async def _select_proposal_by_id(cursor: Any, proposal_id: str) -> PromptProposal:
        await cursor.execute(
            f"""
            SELECT {", ".join(PROPOSAL_KEYS)}
            FROM prompt_proposals
            WHERE proposal_id = %s
            FOR UPDATE
            """,
            (proposal_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            raise PromptProposalNotFound()
        return _proposal(row)
