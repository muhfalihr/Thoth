"""Apply the shipped 0002_prompt_lab_foundation.sql verbatim."""

from thoth_control_plane.operations.editor_migrations import execute_sql_file

revision = "0002"
down_revision = "0001"


def upgrade() -> None:
    execute_sql_file(__file__)
