"""Tests for the pure, deterministic version 1 to version 2 document upgrade."""

from __future__ import annotations

import pytest

from tests.domain.test_edit_documents import valid_document
from thoth_control_plane.domain.edit_document_upgrade import (
    TIMELINE_TRACK_ROLES,
    upgrade_edit_document_v1,
)
from thoth_control_plane.domain.edit_documents import EditDocumentV1


def build_v1_document() -> EditDocumentV1:
    return EditDocumentV1.model_validate(valid_document())


def test_upgrade_preserves_v1_identity_text_and_timing() -> None:
    source = build_v1_document()

    upgraded = upgrade_edit_document_v1(source)

    assert upgraded.schema_version == 2
    assert upgraded.document_id == source.document_id
    assert upgraded.project_id == source.project_id
    assert upgraded.revision == source.revision
    assert upgraded.canvas == source.canvas
    assert upgraded.template == source.template
    assert [scene.scene_id for scene in upgraded.scenes] == [s.scene_id for s in source.scenes]
    assert [clip.clip_id for clip in upgraded.clips if clip.kind == "text"] == [
        clip.clip_id for clip in source.clips
    ]
    assert upgrade_edit_document_v1(source).model_dump() == upgraded.model_dump()


def test_upgrade_preserves_text_content_ownership_and_frames() -> None:
    source = build_v1_document()

    upgraded = upgrade_edit_document_v1(source)

    for original, migrated in zip(source.clips, upgraded.clips, strict=True):
        assert migrated.kind == "text"
        assert migrated.heading == original.heading
        assert migrated.body == original.body
        assert migrated.style_slot == original.style_slot
        assert migrated.ownership == original.ownership
        assert migrated.scene_id == original.scene_id
        assert migrated.from_frame == original.start_frame
        assert migrated.duration_in_frames == original.duration_in_frames


def test_upgrade_creates_every_typed_track_role_with_deterministic_ids() -> None:
    upgraded = upgrade_edit_document_v1(build_v1_document())

    assert [(track.track_id, track.kind, track.order) for track in upgraded.tracks] == [
        (track_id, kind, order)
        for order, (track_id, kind, _label) in enumerate(TIMELINE_TRACK_ROLES)
    ]
    assert all(track.label for track in upgraded.tracks)


def test_upgrade_leaves_media_tracks_and_assets_empty() -> None:
    upgraded = upgrade_edit_document_v1(build_v1_document())

    assert upgraded.asset_refs == []
    text_clip_ids = {clip.clip_id for clip in upgraded.clips}
    for track in upgraded.tracks:
        if track.kind == "overlay":
            assert set(track.clip_ids) == text_clip_ids
        else:
            assert track.clip_ids == []


def test_upgrade_never_mutates_or_revalidates_the_source_document() -> None:
    source = build_v1_document()
    before = source.model_dump()

    upgrade_edit_document_v1(source)

    assert source.model_dump() == before


def test_upgrade_refuses_a_document_that_is_already_version_two() -> None:
    upgraded = upgrade_edit_document_v1(build_v1_document())

    with pytest.raises(TypeError, match="version 1"):
        upgrade_edit_document_v1(upgraded)  # type: ignore[arg-type]
