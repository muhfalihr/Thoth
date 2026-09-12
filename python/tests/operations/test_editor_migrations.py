"""Tests for the editor database migration set, including Prompt Lab tables."""

from __future__ import annotations

from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "editor"
MIGRATION_FILES = sorted(path.name for path in MIGRATIONS.glob("*.sql"))


def migration(name: str) -> str:
    return (MIGRATIONS / name).read_text(encoding="utf-8")


def test_editor_migrations_stay_two_explicit_files_without_a_framework() -> None:
    assert MIGRATION_FILES == [
        "0001_edit_document_revisions.sql",
        "0002_prompt_lab_foundation.sql",
    ]
    assert "schema_migrations" not in migration(MIGRATION_FILES[1]).lower()
    assert "alembic" not in migration(MIGRATION_FILES[1]).lower()


def test_prompt_template_revisions_table_is_append_only_and_project_scoped() -> None:
    sql = migration("0002_prompt_lab_foundation.sql")

    assert "CREATE TABLE IF NOT EXISTS prompt_template_revisions" in sql
    assert "revision INTEGER NOT NULL CHECK (revision > 0)" in sql
    assert (
        "stage_id TEXT NOT NULL CHECK (stage_id IN "
        "('narrative_plan', 'visual_plan', 'caption_copy'))" in sql
    )
    assert "language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$')" in sql
    assert "body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 12000)" in sql
    assert "PRIMARY KEY (project_id, template_id, revision)" in sql


def test_project_prompt_bindings_table_is_optimistically_versioned() -> None:
    sql = " ".join(migration("0002_prompt_lab_foundation.sql").split())

    assert "CREATE TABLE IF NOT EXISTS project_prompt_bindings" in sql
    assert "PRIMARY KEY (project_id, stage_id)" in sql
    assert (
        "FOREIGN KEY (project_id, template_id, template_revision) "
        "REFERENCES prompt_template_revisions (project_id, template_id, revision)" in sql
    )
    assert (
        "project_override TEXT CHECK (project_override IS NULL "
        "OR length(project_override) <= 12000)" in sql
    )
    assert "revision INTEGER NOT NULL CHECK (revision > 0)" in sql
