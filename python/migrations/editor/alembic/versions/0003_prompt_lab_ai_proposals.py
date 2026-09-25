"""Apply the shipped 0003_prompt_lab_ai_proposals.sql verbatim."""

from thoth_control_plane.operations.editor_migrations import execute_sql_file

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    execute_sql_file(__file__)
