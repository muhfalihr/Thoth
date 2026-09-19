"""Tests for the editor database migration set, including Prompt Lab tables."""

from __future__ import annotations

from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "editor"
MIGRATION_FILES = sorted(path.name for path in MIGRATIONS.glob("*.sql"))


def migration(name: str) -> str:
    return (MIGRATIONS / name).read_text(encoding="utf-8")


def test_editor_migrations_stay_explicit_forward_only_files_without_a_framework() -> None:
    assert MIGRATION_FILES == [
        "0001_edit_document_revisions.sql",
        "0002_prompt_lab_foundation.sql",
        "0003_prompt_lab_ai_proposals.sql",
        "0004_advanced_timeline_foundation.sql",
    ]
    for name in MIGRATION_FILES:
        sql = migration(name).lower()
        assert "schema_migrations" not in sql
        assert "alembic" not in sql


def test_prompt_proposal_schema_enforces_one_active_generation_per_stage() -> None:
    sql = migration("0003_prompt_lab_ai_proposals.sql")

    assert "CREATE UNIQUE INDEX prompt_proposals_one_active_generation" in sql
    assert "WHERE status IN ('queued', 'running')" in sql


def test_prompt_proposal_tables_carry_closed_constraints_and_bounds() -> None:
    sql = " ".join(migration("0003_prompt_lab_ai_proposals.sql").split())

    for table in (
        "prompt_provider_preferences",
        "prompt_layer_locks",
        "prompt_proposals",
        "prompt_proposal_changes",
        "prompt_proposal_idempotency",
        "prompt_proposal_applications",
    ):
        assert f"CREATE TABLE {table}" in sql
    assert "PRIMARY KEY (project_id, stage_id)" in sql
    assert "PRIMARY KEY (project_id, stage_id, layer)" in sql
    assert "PRIMARY KEY (proposal_id, change_id)" in sql
    assert "PRIMARY KEY (project_id, idempotency_key)" in sql
    assert "kind TEXT NOT NULL CHECK (kind IN ('improve', 'translate'))" in sql
    assert (
        "status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', "
        "'applied', 'rejected', 'superseded'))" in sql
    )
    assert "layer TEXT NOT NULL CHECK (layer IN ('template', 'project_override'))" in sql
    assert "REFERENCES prompt_template_revisions (project_id, template_id, revision)" in sql
    assert "ownership TEXT NOT NULL CHECK (ownership = 'ai_assisted')" in sql
    assert "approval_mode TEXT NOT NULL CHECK (approval_mode = 'user_approved')" in sql
    assert (
        "(status IN ('queued', 'running') AND finished_at IS NULL) "
        "OR (status NOT IN ('queued', 'running') AND finished_at IS NOT NULL)" in sql
    )


def test_earlier_editor_migrations_remain_byte_identical() -> None:
    assert "CREATE TABLE IF NOT EXISTS prompt_template_revisions" in migration(
        "0002_prompt_lab_foundation.sql"
    )
    assert "CREATE TABLE IF NOT EXISTS edit_document_revisions" in migration(
        "0001_edit_document_revisions.sql"
    )
    assert "ALTER TABLE" not in migration("0001_edit_document_revisions.sql").upper()
    assert "ALTER TABLE" not in migration("0002_prompt_lab_foundation.sql").upper()
    assert "ALTER TABLE" not in migration("0003_prompt_lab_ai_proposals.sql").upper()
    assert "ALTER TABLE" not in migration("0004_advanced_timeline_foundation.sql").upper()


def test_editor_assets_table_is_project_scoped_with_bounded_media_metadata() -> None:
    sql = " ".join(migration("0004_advanced_timeline_foundation.sql").split())

    assert "CREATE TABLE editor_assets" in sql
    assert "PRIMARY KEY (project_id, asset_id)" in sql
    assert "UNIQUE (asset_id)" in sql
    assert "kind TEXT NOT NULL CHECK (kind IN ('video', 'image', 'audio'))" in sql
    assert (
        "validation_state TEXT NOT NULL CHECK "
        "(validation_state IN ('ready', 'rejected', 'pending'))" in sql
    )
    assert "media_type TEXT NOT NULL CHECK (media_type ~ '^[a-z]+/[a-z0-9.+-]{1,64}$')" in sql
    assert (
        "duration_in_frames INTEGER CHECK "
        "(duration_in_frames IS NULL OR duration_in_frames > 0)" in sql
    )
    assert "width INTEGER CHECK (width IS NULL OR width > 0)" in sql
    assert "height INTEGER CHECK (height IS NULL OR height > 0)" in sql
    assert "fps DOUBLE PRECISION CHECK (fps IS NULL OR (fps > 0 AND fps <= 240))" in sql
    assert "checksum TEXT CHECK (checksum IS NULL OR checksum ~ '^sha256:[0-9a-f]{64}$')" in sql
    assert "provenance TEXT NOT NULL CHECK (length(btrim(provenance)) BETWEEN 1 AND 200)" in sql


def test_editor_asset_locator_is_server_only_relative_and_length_bounded() -> None:
    sql = " ".join(migration("0004_advanced_timeline_foundation.sql").split())

    assert (
        "artifact_location TEXT NOT NULL CHECK ( length(artifact_location) BETWEEN 1 AND 512" in sql
    )
    assert "artifact_location ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'" in sql
    assert "artifact_location NOT LIKE '%..%'" in sql


def test_editor_assets_index_supports_bounded_newest_first_ready_listing() -> None:
    sql = " ".join(migration("0004_advanced_timeline_foundation.sql").split())

    assert (
        "CREATE INDEX editor_assets_project_ready_created_idx ON editor_assets "
        "(project_id, created_at DESC, asset_id DESC) WHERE validation_state = 'ready'" in sql
    )


def test_upgrade_idempotency_table_binds_a_key_to_one_result_revision() -> None:
    sql = " ".join(migration("0004_advanced_timeline_foundation.sql").split())

    assert "CREATE TABLE edit_document_upgrade_idempotency" in sql
    assert "PRIMARY KEY (project_id, idempotency_key)" in sql
    assert (
        "idempotency_key TEXT NOT NULL CHECK "
        "(length(btrim(idempotency_key)) BETWEEN 1 AND 128)" in sql
    )
    assert "payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$')" in sql
    assert "result_revision INTEGER NOT NULL CHECK (result_revision > 1)" in sql
    assert (
        "FOREIGN KEY (document_id, result_revision) "
        "REFERENCES edit_document_revisions (document_id, revision)" in sql
    )


def test_advanced_timeline_migration_stores_no_capability_or_absolute_path() -> None:
    sql = migration("0004_advanced_timeline_foundation.sql").lower()

    for forbidden in ("capability", "signing", "cookie", "secret", "token", "http"):
        assert forbidden not in sql


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
