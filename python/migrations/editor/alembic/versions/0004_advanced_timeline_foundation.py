"""Apply the shipped 0004_advanced_timeline_foundation.sql verbatim."""

from thoth_control_plane.operations.editor_migrations import execute_sql_file

revision = "0004"
down_revision = "0003"


def upgrade() -> None:
    execute_sql_file(__file__)
