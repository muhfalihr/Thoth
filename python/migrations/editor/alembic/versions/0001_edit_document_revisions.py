"""Apply the shipped 0001_edit_document_revisions.sql verbatim."""

from thoth_control_plane.operations.editor_migrations import execute_sql_file

revision = "0001"
down_revision = None


def upgrade() -> None:
    execute_sql_file(__file__)
