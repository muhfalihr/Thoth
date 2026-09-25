"""Apply the shipped 0007_studio_import_sources.sql verbatim."""

from thoth_control_plane.operations.editor_migrations import execute_sql_file

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    execute_sql_file(__file__)
