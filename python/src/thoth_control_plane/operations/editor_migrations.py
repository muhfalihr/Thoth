"""Explicit database migration command for Creator Studio metadata."""

from __future__ import annotations

from pathlib import Path

from alembic import command, op
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

# A table each shipped revision creates, used to adopt databases migrated before Alembic.
_LEGACY_MARKERS = {
    "0001": "edit_document_revisions",
    "0002": "prompt_template_revisions",
    "0003": "prompt_proposals",
    "0004": "editor_assets",
    "0005": "render_jobs",
    "0006": "studio_review_events",
    "0007": "studio_import_drafts",
}


def execute_sql_file(revision_file: str) -> None:
    """Run the shipped SQL file that shares the revision module's stem."""

    path = Path(revision_file).resolve()
    sql = (path.parents[2] / f"{path.stem}.sql").read_text(encoding="utf-8")
    # `no_parameters` keeps psycopg on the simple protocol: multi-statement, literal `%`.
    op.get_bind().exec_driver_sql(sql, execution_options={"no_parameters": True})


def apply_editor_migrations(database_url: str, migrations_root: Path) -> int:
    """Upgrade the editor schema to head in one transaction and return the revisions applied."""

    config = Config()
    config.set_main_option("script_location", str(migrations_root / "alembic"))
    chain = [
        revision.revision
        for revision in reversed(list(ScriptDirectory.from_config(config).walk_revisions()))
    ]
    engine = create_engine(
        make_url(database_url).set(drivername="postgresql+psycopg"), poolclass=NullPool
    )
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            current = MigrationContext.configure(connection).get_current_revision()
            if current is None:
                current = _legacy_revision(set(inspect(connection).get_table_names()), chain)
                if current is not None:
                    command.stamp(config, current)
            command.upgrade(config, "head")
    except Exception as error:
        raise RuntimeError("editor migration failed") from error
    finally:
        engine.dispose()
    return len(chain) - (chain.index(current) + 1 if current else 0)


def _legacy_revision(tables: set[str], chain: list[str]) -> str | None:
    """Return the last revision a pre-Alembic schema already holds, or None when empty."""

    applied = [revision for revision in chain if _LEGACY_MARKERS[revision] in tables]
    if applied != chain[: len(applied)]:
        raise RuntimeError("editor schema is not a prefix of the migration chain")
    return applied[-1] if applied else None
