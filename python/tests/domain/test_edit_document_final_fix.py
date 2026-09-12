"""Regression tests for final guided-editing contract polish."""

from thoth_control_plane.domain.edit_documents import EditDocument


def test_edit_document_description_is_not_limited_to_revision_one() -> None:
    assert "revision-one" not in (EditDocument.__doc__ or "")
