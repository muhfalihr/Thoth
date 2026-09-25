"""Apply the shipped 0005_revision_bound_render_jobs.sql verbatim."""

from thoth_control_plane.operations.editor_migrations import execute_sql_file

revision = "0005"
down_revision = "0004"


def upgrade() -> None:
    execute_sql_file(__file__)
