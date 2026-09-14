"""Unit tests for project-scoped PostgreSQL prompt-proposal persistence (C2)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from thoth_control_plane.application.prompt_proposal_ports import (
    PromptIdempotencyConflict,
    PromptLockRevisionConflict,
    PromptPreferenceRevisionConflict,
    PromptProposalActiveGeneration,
    PromptProposalApplyResult,
    PromptProposalInvalidSelection,
    PromptProposalInvalidTransition,
    PromptProposalLayerLocked,
    PromptProposalStale,
    PromptProposalStoreUnavailable,
)
from thoth_control_plane.domain.prompt_proposals import (
    ProjectPromptModelPreference,
    PromptProposal,
    PromptProposalChange,
    SavePromptLayerLockRequest,
    SavePromptModelPreferenceRequest,
    build_prompt_changes,
)
from thoth_control_plane.infrastructure.prompt_proposal_repository import (
    PostgresPromptProposalRepository,
)

NOW = datetime(2026, 9, 13, 8, tzinfo=UTC)


def proposal(**overrides: object) -> PromptProposal:
    values: dict[str, object] = {
        "proposal_id": "proposal_1",
        "project_id": "project_a",
        "stage_id": "narrative_plan",
        "kind": "improve",
        "status": "queued",
        "target_layers": ["template"],
        "source": {
            "template_id": "ptpl_001",
            "template_revision": 2,
            "binding_revision": 1,
            "template_language": "id-ID",
            "template_body": "Hook\nContext",
            "project_override": "Use Indonesian",
        },
        "target_language": None,
        "improvement_instructions": None,
        "provider_id": "novita",
        "model_id": "deepseek/deepseek-v3.1",
        "changes": [],
        "translated_template_body": None,
        "translated_project_override": None,
        "failure_code": None,
        "created_at": NOW,
        "started_at": None,
        "finished_at": None,
    }
    values.update(overrides)
    return PromptProposal.model_validate(values)


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


def proposal_row(source: PromptProposal) -> tuple[object, ...]:
    values = {
        "proposal_id": source.proposal_id,
        "project_id": source.project_id,
        "stage_id": source.stage_id,
        "kind": source.kind,
        "status": source.status,
        "target_layers": list(source.target_layers),
        "source_template_id": source.source.template_id,
        "source_template_revision": source.source.template_revision,
        "source_binding_revision": source.source.binding_revision,
        "source_language": source.source.template_language,
        "source_template_body": source.source.template_body,
        "source_project_override": source.source.project_override,
        "target_language": source.target_language,
        "improvement_instructions": source.improvement_instructions,
        "provider_id": source.provider_id,
        "model_id": source.model_id,
        "translated_template_body": source.translated_template_body,
        "translated_project_override": source.translated_project_override,
        "failure_code": source.failure_code,
        "created_at": source.created_at,
        "started_at": source.started_at,
        "finished_at": source.finished_at,
    }
    return tuple(values[key] for key in PROPOSAL_KEYS)


def binding_row(
    template_id: str = "ptpl_001",
    template_revision: int = 2,
    project_override: str | None = "Use Indonesian",
    revision: int = 1,
) -> tuple[object, ...]:
    return (template_id, template_revision, project_override, revision)


def lock_row(layer: str, locked: bool, revision: int = 1) -> tuple[object, ...]:
    return (layer, locked, revision, NOW)


class Cursor:
    """Fetch results are queued per fetch call; each entry feeds one fetchone/fetchall."""

    def __init__(self, fetch_results: list[list[tuple[object, ...]]] | None = None) -> None:
        self.fetch_results = list(fetch_results or [])
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.insert_count = 0
        self.update_count = 0

    async def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.calls.append((query, params))
        lowered = " ".join(query.split()).lower()
        if lowered.startswith("insert"):
            self.insert_count += 1
        if lowered.startswith("update"):
            self.update_count += 1

    async def fetchone(self) -> tuple[object, ...] | None:
        if not self.fetch_results:
            return None
        result = self.fetch_results.pop(0)
        return result[0] if result else None

    async def fetchall(self) -> list[tuple[object, ...]]:
        if not self.fetch_results:
            return []
        return self.fetch_results.pop(0)


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_value = cursor

    async def __aenter__(self) -> Connection:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def cursor(self) -> Cursor:
        return self.cursor_value


def patched(
    monkeypatch: pytest.MonkeyPatch,
    fetch_results: list[list[tuple[object, ...]]] | None = None,
) -> Cursor:
    cursor = Cursor(fetch_results)

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.prompt_proposal_repository.AsyncConnection.connect",
        connect,
    )
    return cursor


def repository() -> PostgresPromptProposalRepository:
    return PostgresPromptProposalRepository("postgresql://restricted")


@pytest.mark.asyncio
async def test_get_preference_scopes_to_project_and_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched(monkeypatch)
    result = await repository().get_preference("project_a", "narrative_plan")

    assert result is None
    _, params = cursor.calls[0]
    assert params == ("project_a", "narrative_plan")


@pytest.mark.asyncio
async def test_save_preference_inserts_revision_one_when_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched(monkeypatch)

    saved = await repository().save_preference(
        "project_a",
        "narrative_plan",
        SavePromptModelPreferenceRequest.model_validate(
            {"provider_id": "novita", "model_id": "deepseek/deepseek-v3.1"}
        ),
    )

    assert saved.revision == 1
    assert saved.provider_id == "novita"
    insert_query, insert_params = cursor.calls[1]
    assert "INSERT INTO prompt_provider_preferences" in insert_query
    assert insert_params == ("project_a", "narrative_plan", "novita", "deepseek/deepseek-v3.1", 1)


@pytest.mark.asyncio
async def test_save_preference_rebases_on_matching_base_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing = ProjectPromptModelPreference.model_validate(
        {
            "project_id": "project_a",
            "stage_id": "narrative_plan",
            "provider_id": "novita",
            "model_id": "deepseek/deepseek-v3.1",
            "revision": 3,
            "updated_at": NOW,
        }
    )
    cursor = patched(
        monkeypatch,
        [[("novita", "deepseek/deepseek-v3.1", existing.revision, NOW)]],
    )

    saved = await repository().save_preference(
        "project_a",
        "narrative_plan",
        SavePromptModelPreferenceRequest.model_validate(
            {
                "provider_id": "openrouter",
                "model_id": "openai/gpt-5",
                "base_revision": 3,
            }
        ),
    )

    assert saved.revision == 4
    _, update_params = cursor.calls[1]
    assert update_params == ("openrouter", "openai/gpt-5", 4, "project_a", "narrative_plan")


@pytest.mark.asyncio
async def test_save_preference_conflict_carries_latest(monkeypatch: pytest.MonkeyPatch) -> None:
    patched(
        monkeypatch,
        [[("novita", "deepseek/deepseek-v3.1", 5, NOW)]],
    )

    with pytest.raises(PromptPreferenceRevisionConflict) as error:
        await repository().save_preference(
            "project_a",
            "narrative_plan",
            SavePromptModelPreferenceRequest.model_validate(
                {
                    "provider_id": "novita",
                    "model_id": "deepseek/deepseek-v3.1",
                    "base_revision": 2,
                }
            ),
        )

    assert error.value.latest.revision == 5


@pytest.mark.asyncio
async def test_get_locks_returns_both_layers(monkeypatch: pytest.MonkeyPatch) -> None:
    patched(
        monkeypatch,
        [[lock_row("project_override", True), lock_row("template", False)]],
    )

    locks = await repository().get_locks("project_a", "narrative_plan")

    assert [lock.layer for lock in locks] == ["template", "project_override"]
    assert locks[0].locked is False
    assert locks[1].locked is True


@pytest.mark.asyncio
async def test_save_lock_updates_on_matching_base_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched(
        monkeypatch,
        [[("template", False, 2, NOW)]],
    )

    saved = await repository().save_lock(
        "project_a",
        "narrative_plan",
        "template",
        SavePromptLayerLockRequest.model_validate({"locked": True, "base_revision": 2}),
    )

    assert saved.locked is True
    assert saved.revision == 3
    _, update_params = cursor.calls[2]
    assert update_params == (True, 3, "project_a", "narrative_plan", "template")


@pytest.mark.asyncio
async def test_save_lock_conflict_carries_latest(monkeypatch: pytest.MonkeyPatch) -> None:
    patched(monkeypatch, [[("template", True, 7, NOW)]])

    with pytest.raises(PromptLockRevisionConflict) as error:
        await repository().save_lock(
            "project_a",
            "narrative_plan",
            "template",
            SavePromptLayerLockRequest.model_validate({"locked": True, "base_revision": 3}),
        )

    assert error.value.latest.revision == 7


@pytest.mark.asyncio
async def test_reserve_proposal_replays_matching_idempotency_without_insert(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing = proposal(status="queued")
    cursor = patched(
        monkeypatch,
        [[("same-hash", existing.proposal_id)], [proposal_row(existing)]],
    )

    saved = await repository().reserve_proposal(proposal(), "request-1", "same-hash")

    assert saved.proposal_id == existing.proposal_id
    assert cursor.insert_count == 0


@pytest.mark.asyncio
async def test_reserve_proposal_conflicting_payload_hash_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patched(monkeypatch, [[("other-hash", "proposal_other")]])

    with pytest.raises(PromptIdempotencyConflict):
        await repository().reserve_proposal(proposal(), "request-1", "same-hash")


@pytest.mark.asyncio
async def test_reserve_proposal_rejects_second_active_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    active = proposal(status="running")
    patched(monkeypatch, [[], [proposal_row(active)]])

    with pytest.raises(PromptProposalActiveGeneration) as error:
        await repository().reserve_proposal(proposal(), "request-2", "hash-2")

    assert error.value.proposal_id == "proposal_1"


@pytest.mark.asyncio
async def test_reserve_proposal_inserts_proposal_changes_and_idempotency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched(monkeypatch)

    saved = await repository().reserve_proposal(proposal(), "request-1", "hash-1")

    assert saved.status == "queued"
    inserted = [
        " ".join(query.split()).split("INTO ")[1].split(" ")[0]
        for query, _ in cursor.calls
        if " ".join(query.split()).lower().startswith("insert")
    ]
    assert inserted == ["prompt_proposals", "prompt_proposal_idempotency"]


@pytest.mark.asyncio
async def test_reserve_proposal_supersedes_only_prior_succeeded_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched(monkeypatch)

    await repository().reserve_proposal(proposal(), "request-1", "hash-1")

    supersede_query, supersede_params = next(
        (q, p) for q, p in cursor.calls if " ".join(q.split()).lower().startswith("update")
    )
    assert "SET status = 'superseded'" in supersede_query
    assert "AND status = 'succeeded'" in supersede_query
    assert supersede_params == ("project_a", "narrative_plan")
    assert cursor.update_count == 1


@pytest.mark.asyncio
async def test_get_proposal_is_project_scoped(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = patched(monkeypatch, [[proposal_row(proposal(status="succeeded"))]])

    found = await repository().get_proposal("project_a", "proposal_1")

    assert found is not None
    assert found.status == "succeeded"
    _, params = cursor.calls[0]
    assert params == ("project_a", "proposal_1")


@pytest.mark.asyncio
async def test_list_proposals_clamps_limit_and_emits_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        proposal_row(proposal(status="succeeded")),
        proposal_row(proposal(status="rejected")),
    ]
    cursor = patched(monkeypatch, [rows])

    page = await repository().list_proposals("project_a", "narrative_plan", None, 999)

    assert len(page.proposals) == 2
    assert page.next_cursor is None
    _, params = cursor.calls[0]
    assert params[2] == 51


@pytest.mark.asyncio
async def test_mark_running_transitions_queued_and_stamps_started_at(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched(monkeypatch, [[proposal_row(proposal(status="queued"))]])

    running = await repository().mark_running("proposal_1")

    assert running.status == "running"
    update_query, update_params = cursor.calls[1]
    assert "UPDATE prompt_proposals" in update_query
    assert update_params[0] == "running"
    assert update_params[-1] == "proposal_1"


@pytest.mark.asyncio
async def test_mark_running_rejects_illegal_transition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patched(monkeypatch, [[proposal_row(proposal(status="succeeded"))]])

    with pytest.raises(PromptProposalInvalidTransition):
        await repository().mark_running("proposal_1")


@pytest.mark.asyncio
async def test_record_success_persists_improvement_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    running = proposal(status="running")
    cursor = patched(monkeypatch, [[proposal_row(running)]])

    saved = await repository().record_success("proposal_1", {"template": "Hook improved\nContext"})

    assert saved.status == "succeeded"
    change_inserts = [
        params
        for query, params in cursor.calls
        if "INSERT INTO prompt_proposal_changes" in " ".join(query.split())
    ]
    assert len(change_inserts) == 1


@pytest.mark.asyncio
async def test_record_success_persists_translation_layers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    translated = proposal(
        status="running",
        kind="translate",
        target_layers=["template", "project_override"],
        target_language="en-US",
        translated_template_body="Translated body",
        translated_project_override="Translated override",
    )
    _cursor = patched(monkeypatch, [[proposal_row(translated)]])

    saved = await repository().record_success(
        "proposal_1", {"template": "Translated body", "project_override": "Translated override"}
    )

    assert saved.translated_template_body == "Translated body"
    assert saved.translated_project_override == "Translated override"


@pytest.mark.asyncio
async def test_record_failure_requires_running_and_safe_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _cursor = patched(
        monkeypatch,
        [
            [proposal_row(proposal(status="running"))],
            [proposal_row(proposal(status="failed", failure_code="provider_timeout"))],
        ],
    )

    failed = await repository().record_failure("proposal_1", "provider_timeout")

    assert failed.failure_code == "provider_timeout"
    with pytest.raises(PromptProposalInvalidTransition):
        await repository().record_failure("proposal_1", "provider_timeout")


@pytest.mark.asyncio
async def test_record_failure_rejects_unsafe_code(monkeypatch: pytest.MonkeyPatch) -> None:
    patched(monkeypatch, [[proposal_row(proposal(status="running"))]])

    with pytest.raises(ValueError):
        await repository().record_failure("proposal_1", "raw provider stack trace")


@pytest.mark.asyncio
async def test_reject_proposal_requires_succeeded_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _cursor = patched(
        monkeypatch,
        [
            [proposal_row(proposal(status="succeeded"))],
            [proposal_row(proposal(status="rejected"))],
        ],
    )

    rejected = await repository().reject_proposal("project_a", "proposal_1")

    assert rejected.status == "rejected"
    with pytest.raises(PromptProposalInvalidTransition):
        await repository().reject_proposal("project_a", "proposal_1")


def improvement_changes() -> list[PromptProposalChange]:
    return list(build_prompt_changes("template", "Hook\nContext", "Hook improved\nContext"))


def apply_rows(
    source: PromptProposal, *, binding: tuple[object, ...] | None, locks: list[tuple[object, ...]]
) -> list[list[tuple[object, ...]]]:
    entries: list[list[tuple[object, ...]]] = [[proposal_row(source)]]
    if binding is not None:
        entries.append([binding])
    entries.append(list(locks))
    entries.append(
        [
            (
                change.change_id,
                change.layer,
                change.before_text,
                change.after_text,
                change.start_line,
                change.end_line,
            )
            for change in improvement_changes()
        ]
    )
    return entries


@pytest.mark.asyncio
async def test_apply_improvement_writes_revisions_provenance_and_applied_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(status="succeeded")
    cursor = patched(
        monkeypatch,
        apply_rows(source, binding=binding_row(revision=1), locks=[lock_row("template", False)]),
    )

    result = await repository().apply_improvement(
        "project_a", "proposal_1", [improvement_changes()[0].change_id], "actor_owner"
    )

    assert isinstance(result, PromptProposalApplyResult)
    assert result.resulting_template_revision == 3
    assert result.resulting_binding_revision == 2
    assert result.proposal.status == "applied"
    writes = [
        " ".join(query.split())
        for query, _ in cursor.calls
        if " ".join(query.split()).lower().startswith(("insert", "update"))
    ]
    assert any("INSERT INTO prompt_template_revisions" in w for w in writes)
    assert any("UPDATE project_prompt_bindings" in w for w in writes)
    assert any("INSERT INTO prompt_proposal_applications" in w for w in writes)
    assert any("UPDATE prompt_proposals" in w for w in writes)
    _, application_params = next(
        (q, p)
        for q, p in cursor.calls
        if "INSERT INTO prompt_proposal_applications" in " ".join(q.split())
    )
    assert application_params[4] == "actor_owner"


@pytest.mark.asyncio
async def test_apply_improvement_stale_source_rolls_back_without_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(status="succeeded")
    cursor = patched(
        monkeypatch,
        apply_rows(source, binding=binding_row(revision=9), locks=[lock_row("template", False)]),
    )

    with pytest.raises(PromptProposalStale):
        await repository().apply_improvement(
            "project_a", "proposal_1", [improvement_changes()[0].change_id], "actor_owner"
        )

    assert cursor.insert_count == 0
    assert cursor.update_count == 0


@pytest.mark.asyncio
async def test_apply_improvement_locked_layer_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    source = proposal(status="succeeded")
    cursor = patched(
        monkeypatch,
        apply_rows(source, binding=binding_row(revision=1), locks=[lock_row("template", True)]),
    )

    with pytest.raises(PromptProposalLayerLocked):
        await repository().apply_improvement(
            "project_a", "proposal_1", [improvement_changes()[0].change_id], "actor_owner"
        )

    assert cursor.insert_count == 0
    assert cursor.update_count == 0


@pytest.mark.asyncio
async def test_apply_improvement_unknown_change_id_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(status="succeeded")
    cursor = patched(
        monkeypatch,
        apply_rows(source, binding=binding_row(revision=1), locks=[lock_row("template", False)]),
    )

    with pytest.raises(PromptProposalInvalidSelection):
        await repository().apply_improvement(
            "project_a", "proposal_1", ["change_unknown"], "actor_owner"
        )

    assert cursor.insert_count == 0
    assert cursor.update_count == 0


@pytest.mark.asyncio
async def test_apply_improvement_requires_succeeded_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(status="running")
    cursor = patched(monkeypatch, apply_rows(source, binding=binding_row(revision=1), locks=[]))

    with pytest.raises(PromptProposalInvalidTransition):
        await repository().apply_improvement(
            "project_a", "proposal_1", [improvement_changes()[0].change_id], "actor_owner"
        )

    assert cursor.insert_count == 0


@pytest.mark.asyncio
async def test_apply_improvement_override_layer_updates_binding_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(status="succeeded", target_layers=["project_override"])
    cursor = patched(
        monkeypatch,
        apply_rows(
            source, binding=binding_row(revision=1), locks=[lock_row("project_override", False)]
        ),
    )

    result = await repository().apply_improvement(
        "project_a", "proposal_1", [improvement_changes()[0].change_id], "actor_owner"
    )

    assert result.resulting_template_id == "ptpl_001"
    assert result.resulting_template_revision == 2
    assert result.resulting_binding_revision == 2
    writes = [" ".join(q.split()) for q, _ in cursor.calls]
    assert not any("INSERT INTO prompt_template_revisions" in w for w in writes)
    assert any("UPDATE project_prompt_bindings" in w for w in writes)


@pytest.mark.asyncio
async def test_apply_translation_creates_new_template_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(
        status="succeeded",
        kind="translate",
        target_layers=["template", "project_override"],
        target_language="en-US",
        translated_template_body="Translated body",
        translated_project_override="Translated override",
    )
    cursor = patched(
        monkeypatch,
        [
            [proposal_row(source)],
            [binding_row(revision=1)],
            [lock_row("template", False), lock_row("project_override", False)],
        ],
    )

    result = await repository().apply_translation("project_a", "proposal_1", "actor_owner")

    assert result.resulting_template_id != "ptpl_001"
    assert result.resulting_template_revision == 1
    assert result.resulting_binding_revision == 2
    writes = [" ".join(q.split()) for q, _ in cursor.calls]
    assert any("INSERT INTO prompt_template_revisions" in w for w in writes)
    assert any("UPDATE project_prompt_bindings" in w for w in writes)


@pytest.mark.asyncio
async def test_apply_translation_locked_target_layer_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(
        status="succeeded",
        kind="translate",
        target_layers=["template", "project_override"],
        target_language="en-US",
        translated_template_body="Translated body",
    )
    cursor = patched(
        monkeypatch,
        [
            [proposal_row(source)],
            [binding_row(revision=1)],
            [lock_row("template", False), lock_row("project_override", True)],
        ],
    )

    with pytest.raises(PromptProposalLayerLocked):
        await repository().apply_translation("project_a", "proposal_1", "actor_owner")

    assert cursor.insert_count == 0
    assert cursor.update_count == 0


@pytest.mark.asyncio
async def test_apply_improvement_advisory_lock_uses_project_and_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(status="succeeded")
    cursor = patched(
        monkeypatch,
        apply_rows(source, binding=binding_row(revision=1), locks=[lock_row("template", False)]),
    )

    await repository().apply_improvement(
        "project_a", "proposal_1", [improvement_changes()[0].change_id], "actor_owner"
    )

    _, advisory_params = next((q, p) for q, p in cursor.calls if "pg_advisory_xact_lock" in q)
    assert advisory_params == ("project_a", "narrative_plan")


@pytest.mark.asyncio
async def test_apply_improvement_reads_lock_rows_with_for_update(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = proposal(status="succeeded")
    cursor = patched(
        monkeypatch,
        apply_rows(source, binding=binding_row(revision=1), locks=[lock_row("template", False)]),
    )

    await repository().apply_improvement(
        "project_a", "proposal_1", [improvement_changes()[0].change_id], "actor_owner"
    )

    lock_query, _ = next((q, p) for q, p in cursor.calls if "FROM prompt_layer_locks" in q)
    assert "FOR UPDATE" in lock_query


@pytest.mark.asyncio
async def test_store_failures_are_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.prompt_proposal_repository.AsyncConnection.connect",
        broken,
    )

    with pytest.raises(
        PromptProposalStoreUnavailable, match=r"^prompt proposal store unavailable$"
    ):
        await repository().get_proposal("project_a", "proposal_1")


@pytest.mark.asyncio
async def test_save_lock_serializes_with_apply_via_stage_advisory_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched(monkeypatch, [[("template", False, 1, NOW)]])
    await repository().save_lock(
        "project_a",
        "narrative_plan",
        "template",
        SavePromptLayerLockRequest.model_validate({"locked": True, "base_revision": 1}),
    )

    lock_query, lock_params = cursor.calls[0]
    assert "pg_advisory_xact_lock" in lock_query
    assert lock_params == ("project_a", "narrative_plan")
