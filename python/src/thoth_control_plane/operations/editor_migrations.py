"""Explicit database migration command for Creator Studio metadata."""

from __future__ import annotations

from pathlib import Path

import psycopg


def apply_editor_migrations(database_url: str, migrations_root: Path) -> int:
    """Apply sorted editor migrations in one transaction and return their count."""

    migrations = sorted(migrations_root.glob("*.sql"))
    try:
        with psycopg.connect(database_url) as connection, connection.cursor() as cursor:
            for migration in migrations:
                cursor.execute(migration.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError("editor migration failed") from error
    return len(migrations)
