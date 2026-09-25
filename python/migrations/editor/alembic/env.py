"""Alembic environment for the editor schema; online only, on the caller's connection."""

from alembic import context

context.configure(connection=context.config.attributes["connection"])
with context.begin_transaction():
    context.run_migrations()
