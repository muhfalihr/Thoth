from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

from thoth_control_plane.operations.editor_migrations import apply_editor_migrations

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "editor"
DATABASE_URL = os.environ.get("THOTH_TEST_EDITOR_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(
    not DATABASE_URL, reason="THOTH_TEST_EDITOR_DATABASE_URL points at a disposable Postgres"
)


@pytest.fixture(autouse=True)
def empty_schema() -> None:
    with psycopg.connect(DATABASE_URL, autocommit=True) as connection:
        connection.execute("DROP SCHEMA public CASCADE")
        connection.execute("CREATE SCHEMA public")


def _tables() -> set[str]:
    with psycopg.connect(DATABASE_URL) as connection:
        rows = connection.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
        return {row[0] for row in rows}


def test_fresh_database_applies_every_revision_and_a_rerun_applies_none() -> None:
    assert apply_editor_migrations(DATABASE_URL, MIGRATIONS) == 7
    assert apply_editor_migrations(DATABASE_URL, MIGRATIONS) == 0
    assert {"alembic_version", "studio_import_drafts", "studio_import_decisions"} <= _tables()


def test_database_migrated_before_alembic_is_adopted_and_only_the_rest_applied() -> None:
    with psycopg.connect(DATABASE_URL) as connection:
        for migration in sorted(MIGRATIONS.glob("*.sql"))[:6]:
            connection.execute(migration.read_text(encoding="utf-8"))

    assert apply_editor_migrations(DATABASE_URL, MIGRATIONS) == 1
    assert {"studio_import_drafts", "studio_import_decisions"} <= _tables()


def test_schema_that_is_not_a_chain_prefix_is_refused_untouched() -> None:
    with psycopg.connect(DATABASE_URL) as connection:
        connection.execute("CREATE TABLE studio_review_events (id integer)")

    with pytest.raises(RuntimeError, match="editor migration failed"):
        apply_editor_migrations(DATABASE_URL, MIGRATIONS)
    assert _tables() == {"studio_review_events"}
