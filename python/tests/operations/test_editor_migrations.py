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
        "0005_revision_bound_render_jobs.sql",
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
    assert "ALTER TABLE" not in migration("0005_revision_bound_render_jobs.sql").upper()


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


def test_render_jobs_allow_exactly_one_active_render_for_the_installation() -> None:
    sql = " ".join(migration("0005_revision_bound_render_jobs.sql").split())

    assert "CREATE UNIQUE INDEX render_jobs_one_active_slot" in sql
    assert "WHERE status IN ('preparing', 'rendering', 'finalizing')" in sql
    assert "CREATE TABLE render_job_idempotency" in sql
    assert "PRIMARY KEY (project_id, idempotency_key)" in sql
    assert "payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$')" in sql
    assert (
        "CREATE INDEX render_jobs_project_history_idx ON render_jobs "
        "(project_id, created_at DESC, render_job_id DESC)" in sql
    )


def test_render_jobs_bind_one_immutable_saved_revision_and_retry_lineage() -> None:
    sql = " ".join(migration("0005_revision_bound_render_jobs.sql").split())

    assert "CREATE TABLE render_jobs" in sql
    assert "document_revision INTEGER NOT NULL CHECK (document_revision > 0)" in sql
    assert (
        "FOREIGN KEY (document_id, document_revision) "
        "REFERENCES edit_document_revisions (document_id, revision)" in sql
    )
    assert "retry_of_job_id TEXT REFERENCES render_jobs (render_job_id)" in sql
    assert "CHECK (retry_of_job_id IS NULL OR retry_of_job_id <> render_job_id)" in sql


def test_render_job_columns_carry_closed_status_progress_and_provenance_bounds() -> None:
    sql = " ".join(migration("0005_revision_bound_render_jobs.sql").split())

    assert (
        "status TEXT NOT NULL CHECK (status IN ('preparing', 'rendering', 'finalizing', "
        "'completed', 'failed', 'cancelled'))" in sql
    )
    assert (
        "progress_percent INTEGER CHECK (progress_percent IS NULL "
        "OR (progress_percent BETWEEN 0 AND 100))" in sql
    )
    assert "last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0)" in sql
    assert "template_id TEXT NOT NULL CHECK (template_id = 'vertical_text_story')" in sql
    assert "preset_id TEXT NOT NULL CHECK (preset_id = 'standard_vertical_mp4_v1')" in sql
    assert "provenance JSONB NOT NULL" in sql
    assert (
        "failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN "
        "('render_asset_unavailable', 'render_bundle_invalid', 'render_deadline_exceeded', "
        "'render_dispatch_failed', 'render_engine_failed', 'render_output_invalid', "
        "'render_storage_failed', 'renderer_unavailable'))" in sql
    )


def test_render_job_terminal_rows_close_timestamps_codes_and_output_together() -> None:
    sql = " ".join(migration("0005_revision_bound_render_jobs.sql").split())

    assert (
        "CHECK ( (status IN ('preparing', 'rendering', 'finalizing') AND finished_at IS NULL) "
        "OR (status NOT IN ('preparing', 'rendering', 'finalizing') "
        "AND finished_at IS NOT NULL) )" in sql
    )
    assert "CHECK ((status = 'failed') = (failure_code IS NOT NULL))" in sql
    assert (
        "CHECK ( (status = 'completed' AND output_relative_path IS NOT NULL "
        "AND output_media_type IS NOT NULL AND output_size_bytes IS NOT NULL "
        "AND output_checksum IS NOT NULL) OR (status <> 'completed' "
        "AND output_relative_path IS NULL AND output_media_type IS NULL "
        "AND output_size_bytes IS NULL AND output_checksum IS NULL) )" in sql
    )


def test_render_job_output_projection_is_one_relative_validated_mp4() -> None:
    sql = " ".join(migration("0005_revision_bound_render_jobs.sql").split())

    assert (
        "output_relative_path TEXT CHECK ( output_relative_path IS NULL "
        "OR ( length(output_relative_path) BETWEEN 1 AND 512 "
        "AND output_relative_path ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' "
        "AND output_relative_path NOT LIKE '%..%' ) )" in sql
    )
    assert (
        "output_media_type TEXT CHECK (output_media_type IS NULL "
        "OR output_media_type = 'video/mp4')" in sql
    )
    assert (
        "output_size_bytes BIGINT CHECK (output_size_bytes IS NULL OR output_size_bytes > 0)" in sql
    )
    assert (
        "output_checksum TEXT CHECK (output_checksum IS NULL "
        "OR output_checksum ~ '^sha256:[0-9a-f]{64}$')" in sql
    )
    assert "artifacts_cleaned_at TIMESTAMPTZ" in sql


def test_render_job_migration_stores_no_secret_endpoint_or_absolute_path() -> None:
    sql = migration("0005_revision_bound_render_jobs.sql").lower()

    for forbidden in ("secret", "token", "cookie", "credential", "password", "http", "queue"):
        assert forbidden not in sql
