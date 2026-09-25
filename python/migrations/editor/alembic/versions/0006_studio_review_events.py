"""Apply the shipped 0006_studio_review_events.sql verbatim."""

from thoth_control_plane.operations.editor_migrations import execute_sql_file

revision = "0006"
down_revision = "0005"


def upgrade() -> None:
    execute_sql_file(__file__)
