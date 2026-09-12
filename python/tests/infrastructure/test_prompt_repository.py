"""Unit tests for project-scoped PostgreSQL Prompt Lab persistence."""

from __future__ import annotations

from typing import Any

import pytest

from thoth_control_plane.application.ports import (
    PromptBindingNotFound,
    PromptBindingRevisionConflict,
    PromptTemplateNotFound,
    PromptTemplateRevisionConflict,
)
from thoth_control_plane.domain.prompts import (
    ProjectPromptBinding,
    PromptTemplateRevision,
    SaveProjectPromptBindingRequest,
)
from thoth_control_plane.infrastructure.prompt_repository import (
    PostgresPromptLabRepository,
    PromptLabPersistenceError,
)


def template_values(**overrides: object) -> dict[str, Any]:
    values: dict[str, Any] = {
        "project_id": "project_a",
        "template_id": "ptpl_001",
        "revision": 1,
        "stage_id": "narrative_plan",
        "language": "id-ID",
        "body": "Original prompt",
    }
    values.update(overrides)
    return values


def template_row(**overrides: object) -> tuple[object, ...]:
    values = template_values(**overrides)
    return (
        values["project_id"],
        values["template_id"],
        values["revision"],
        values["stage_id"],
        values["language"],
        values["body"],
    )


def binding_values(**overrides: object) -> dict[str, Any]:
    values: dict[str, Any] = {
        "project_id": "project_a",
        "stage_id": "narrative_plan",
        "template_id": "ptpl_001",
        "template_revision": 1,
        "project_override": "Use Indonesian",
        "revision": 1,
    }
    values.update(overrides)
    return values


def binding_row(**overrides: object) -> tuple[object, ...]:
    values = binding_values(**overrides)
    return (
        values["project_id"],
        values["stage_id"],
        values["template_id"],
        values["template_revision"],
        values["project_override"],
        values["revision"],
    )


class Cursor:
    def __init__(
        self,
        *,
        row: tuple[object, ...] | None = None,
        rows: list[tuple[object, ...]] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.row = row
        self.rows = rows or []
        self.error = error
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.calls.append((query, params))
        if self.error:
            raise self.error

    async def fetchone(self) -> tuple[object, ...] | None:
        return self.rows.pop(0) if self.rows else self.row

    async def fetchall(self) -> list[tuple[object, ...]]:
        rows = self.rows
        self.rows = []
        return rows


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_value = cursor

    async def __aenter__(self) -> Connection:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def cursor(self) -> Cursor:
        return self.cursor_value


def patched_cursor(
    monkeypatch: pytest.MonkeyPatch,
    *,
    row: tuple[object, ...] | None = None,
    rows: list[tuple[object, ...]] | None = None,
    error: Exception | None = None,
) -> Cursor:
    cursor = Cursor(row=row, rows=rows, error=error)

    async def connect(_: str) -> Connection:
        return Connection(cursor)

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.prompt_repository.AsyncConnection.connect",
        connect,
    )
    return cursor


@pytest.mark.asyncio
async def test_save_template_scopes_revision_lookup_to_project(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched_cursor(monkeypatch, rows=[template_row()])
    repository = PostgresPromptLabRepository("postgresql://restricted")

    saved = await repository.save_template(
        project_id="project_a",
        template_id="ptpl_001",
        base_revision=1,
        stage_id="narrative_plan",
        language="id-ID",
        body="Updated prompt",
    )

    assert saved == PromptTemplateRevision.model_validate(
        template_values(revision=2, body="Updated prompt")
    )
    lock_query, lock_params = cursor.calls[0]
    assert "pg_advisory_xact_lock" in lock_query
    assert lock_params == ("project_a", "ptpl_001")
    query, parameters = cursor.calls[1]
    assert "project_id = %s" in query
    assert "FOR UPDATE" in query
    assert parameters[:2] == ("project_a", "ptpl_001")
    insert_query, insert_params = cursor.calls[2]
    assert "INSERT INTO prompt_template_revisions" in insert_query
    assert "%s" in insert_query
    assert insert_params == (
        "project_a",
        "ptpl_001",
        2,
        "narrative_plan",
        "id-ID",
        "Updated prompt",
    )


@pytest.mark.asyncio
async def test_save_template_creation_appends_revision_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched_cursor(monkeypatch)
    repository = PostgresPromptLabRepository("postgresql://restricted")

    saved = await repository.save_template(
        project_id="project_a",
        template_id="ptpl_new",
        base_revision=None,
        stage_id="visual_plan",
        language="en",
        body="Describe each shot",
    )

    assert saved.revision == 1
    insert_query, insert_params = cursor.calls[2]
    assert "INSERT INTO prompt_template_revisions" in insert_query
    assert insert_params == ("project_a", "ptpl_new", 1, "visual_plan", "en", "Describe each shot")


@pytest.mark.asyncio
async def test_save_template_creation_conflict_carries_latest_head(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    latest = PromptTemplateRevision.model_validate(template_values())
    cursor = patched_cursor(monkeypatch, rows=[template_row()])
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptTemplateRevisionConflict) as error:
        await repository.save_template(
            project_id="project_a",
            template_id="ptpl_001",
            base_revision=None,
            stage_id="narrative_plan",
            language="id-ID",
            body="Original prompt",
        )

    assert error.value.latest == latest
    assert len(cursor.calls) == 2


@pytest.mark.asyncio
async def test_save_template_stale_revision_conflict_carries_latest_head(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    latest = PromptTemplateRevision.model_validate(template_values(revision=2))
    patched_cursor(monkeypatch, rows=[template_row(revision=2)])
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptTemplateRevisionConflict) as error:
        await repository.save_template(
            project_id="project_a",
            template_id="ptpl_001",
            base_revision=1,
            stage_id="narrative_plan",
            language="id-ID",
            body="Updated prompt",
        )

    assert error.value.latest == latest


@pytest.mark.asyncio
async def test_save_template_unknown_template_revision_is_typed_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched_cursor(monkeypatch)
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptTemplateNotFound):
        await repository.save_template(
            project_id="project_a",
            template_id="ptpl_missing",
            base_revision=3,
            stage_id="narrative_plan",
            language="id-ID",
            body="Updated prompt",
        )

    assert len(cursor.calls) == 2


@pytest.mark.asyncio
async def test_list_template_heads_returns_one_head_per_template(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched_cursor(
        monkeypatch,
        rows=[
            template_row(template_id="ptpl_001", revision=2),
            template_row(template_id="ptpl_002"),
        ],
    )
    repository = PostgresPromptLabRepository("postgresql://restricted")

    heads = await repository.list_template_heads(project_id="project_a", stage_id="narrative_plan")

    assert [head.template_id for head in heads] == ["ptpl_001", "ptpl_002"]
    assert heads[0].revision == 2
    query, params = cursor.calls[0]
    assert "DISTINCT ON (template_id)" in query
    assert "project_id = %s" in query
    assert params[:2] == ("project_a", "narrative_plan")


@pytest.mark.asyncio
async def test_get_template_revision_requires_project_and_behaves_as_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched_cursor(monkeypatch)
    repository = PostgresPromptLabRepository("postgresql://restricted")

    missing = await repository.get_template_revision(
        project_id="project_a", template_id="ptpl_001", revision=1
    )

    assert missing is None
    _, params = cursor.calls[0]
    assert params == ("project_a", "ptpl_001", 1)


@pytest.mark.asyncio
async def test_get_binding_scopes_to_project_and_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = patched_cursor(monkeypatch, row=binding_row())
    repository = PostgresPromptLabRepository("postgresql://restricted")

    result = await repository.get_binding(project_id="project_a", stage_id="narrative_plan")

    assert result == ProjectPromptBinding.model_validate(binding_values())
    _, params = cursor.calls[0]
    assert params == ("project_a", "narrative_plan")


@pytest.mark.asyncio
async def test_save_binding_creates_first_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    cursor = patched_cursor(monkeypatch)
    repository = PostgresPromptLabRepository("postgresql://restricted")

    saved = await repository.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {
                "template_id": "ptpl_001",
                "template_revision": 1,
                "project_override": "Use Indonesian",
            }
        ),
    )

    assert saved == ProjectPromptBinding.model_validate(binding_values())
    lock_query, lock_params = cursor.calls[0]
    assert "pg_advisory_xact_lock" in lock_query
    assert lock_params == ("project_a", "narrative_plan")
    select_query, select_params = cursor.calls[1]
    assert "FOR UPDATE" in select_query
    assert select_params == ("project_a", "narrative_plan")
    insert_query, insert_params = cursor.calls[2]
    assert "INSERT INTO project_prompt_bindings" in insert_query
    assert insert_params[:2] == ("project_a", "narrative_plan")


@pytest.mark.asyncio
async def test_save_binding_existing_binding_without_base_revision_conflicts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    latest = ProjectPromptBinding.model_validate(binding_values())
    cursor = patched_cursor(monkeypatch, row=binding_row())
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptBindingRevisionConflict) as error:
        await repository.save_binding(
            project_id="project_a",
            stage_id="narrative_plan",
            request=SaveProjectPromptBindingRequest.model_validate(
                {"template_id": "ptpl_001", "template_revision": 1}
            ),
        )

    assert error.value.latest == latest
    assert len(cursor.calls) == 2


@pytest.mark.asyncio
async def test_save_binding_stale_base_revision_conflicts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    latest = ProjectPromptBinding.model_validate(binding_values(revision=3))
    cursor = patched_cursor(monkeypatch, row=binding_row(revision=3))
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptBindingRevisionConflict) as error:
        await repository.save_binding(
            project_id="project_a",
            stage_id="narrative_plan",
            request=SaveProjectPromptBindingRequest.model_validate(
                {"template_id": "ptpl_001", "template_revision": 1, "base_revision": 2}
            ),
        )

    assert error.value.latest == latest
    assert len(cursor.calls) == 2


@pytest.mark.asyncio
async def test_save_binding_updates_atomically_under_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = patched_cursor(monkeypatch, row=binding_row())
    repository = PostgresPromptLabRepository("postgresql://restricted")

    saved = await repository.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {
                "template_id": "ptpl_002",
                "template_revision": 4,
                "project_override": "Use conversational Indonesian",
                "base_revision": 1,
            }
        ),
    )

    assert saved.revision == 2
    update_query, update_params = cursor.calls[2]
    assert "UPDATE project_prompt_bindings" in update_query
    assert update_params == (
        "ptpl_002",
        4,
        "Use conversational Indonesian",
        2,
        "project_a",
        "narrative_plan",
    )


@pytest.mark.asyncio
async def test_save_binding_missing_binding_for_stale_base_revision_is_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patched_cursor(monkeypatch)
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptBindingNotFound):
        await repository.save_binding(
            project_id="project_a",
            stage_id="narrative_plan",
            request=SaveProjectPromptBindingRequest.model_validate(
                {"template_id": "ptpl_001", "template_revision": 1, "base_revision": 2}
            ),
        )


@pytest.mark.asyncio
async def test_invalid_stored_row_is_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    patched_cursor(
        monkeypatch,
        row=("project_a", "ptpl_001", "invalid", "narrative_plan", "id-ID", "Body"),
    )
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptLabPersistenceError, match=r"^prompt lab persistence unavailable$"):
        await repository.get_template_revision(
            project_id="project_a", template_id="ptpl_001", revision=1
        )


@pytest.mark.asyncio
async def test_connection_errors_are_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(_: str) -> Connection:
        raise RuntimeError("postgresql://secret.example")

    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.prompt_repository.AsyncConnection.connect", broken
    )
    repository = PostgresPromptLabRepository("postgresql://restricted")

    with pytest.raises(PromptLabPersistenceError, match=r"^prompt lab persistence unavailable$"):
        await repository.get_binding(project_id="project_a", stage_id="narrative_plan")


def test_conflict_errors_are_safe() -> None:
    assert (
        str(
            PromptTemplateRevisionConflict(PromptTemplateRevision.model_validate(template_values()))
        )
        == "prompt template revision conflict"
    )
    assert (
        str(PromptBindingRevisionConflict(ProjectPromptBinding.model_validate(binding_values())))
        == "prompt binding revision conflict"
    )


def test_repository_implements_the_application_seam() -> None:
    for method in (
        "list_template_heads",
        "get_template_revision",
        "save_template",
        "get_binding",
        "save_binding",
    ):
        assert callable(getattr(PostgresPromptLabRepository, method))
