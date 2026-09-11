"""Tests for pure, immutable Creator Studio document operations."""

from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.edit_document_operations import (
    EditDocumentPatch,
    apply_edit_operations,
)
from thoth_control_plane.domain.edit_documents import EditDocument


@pytest.fixture
def document() -> EditDocument:
    return EditDocument.model_validate(
        {
            "schema_version": 1,
            "document_id": "edoc_abc123",
            "project_id": "project_001",
            "revision": 1,
            "template": {"template_id": "vertical_text_story", "version": 1},
            "canvas": {"width": 1080, "height": 1920, "fps": 30, "duration_in_frames": 300},
            "scenes": [
                {
                    "scene_id": "scene_001",
                    "role": "title",
                    "start_frame": 0,
                    "duration_in_frames": 150,
                    "clip_ids": ["clip_001"],
                },
                {
                    "scene_id": "scene_002",
                    "role": "source",
                    "start_frame": 150,
                    "duration_in_frames": 150,
                    "clip_ids": ["clip_002"],
                },
            ],
            "tracks": [
                {
                    "track_id": "track_visual",
                    "kind": "visual",
                    "clip_ids": ["clip_001", "clip_002"],
                }
            ],
            "clips": [
                {
                    "kind": "text",
                    "clip_id": "clip_001",
                    "scene_id": "scene_001",
                    "track_id": "track_visual",
                    "start_frame": 0,
                    "duration_in_frames": 150,
                    "heading": "Title",
                    "body": "Summary",
                    "style_slot": "title",
                    "ownership": "ai_managed",
                },
                {
                    "kind": "text",
                    "clip_id": "clip_002",
                    "scene_id": "scene_002",
                    "track_id": "track_visual",
                    "start_frame": 150,
                    "duration_in_frames": 150,
                    "heading": "Source",
                    "body": "tiktok",
                    "style_slot": "source",
                    "ownership": "ai_managed",
                },
            ],
        }
    )


def patch(*operations: dict[str, object]) -> EditDocumentPatch:
    return EditDocumentPatch.model_validate({"base_revision": 1, "operations": list(operations)})


def test_replace_text_sets_user_ownership_without_mutating_input(document: EditDocument) -> None:
    original = deepcopy(document)

    result = apply_edit_operations(
        document,
        patch(
            {
                "kind": "replace_text",
                "operation_id": "op_001",
                "clip_id": "clip_001",
                "field": "heading",
                "value": "Updated title",
            }
        ).operations,
    )

    assert result.clips[0].heading == "Updated title"
    assert result.clips[0].ownership == "user_edited"
    assert result.clips[1] == document.clips[1]
    assert document == original


def test_set_ownership_changes_only_ownership(document: EditDocument) -> None:
    result = apply_edit_operations(
        document,
        patch(
            {
                "kind": "set_ownership",
                "operation_id": "op_001",
                "clip_id": "clip_001",
                "ownership": "locked",
            }
        ).operations,
    )

    assert result.clips[0].ownership == "locked"
    assert result.clips[0].model_dump(exclude={"ownership"}) == document.clips[0].model_dump(
        exclude={"ownership"}
    )


def test_set_scene_duration_reflows_later_scenes_and_canvas(document: EditDocument) -> None:
    result = apply_edit_operations(
        document,
        patch(
            {
                "kind": "set_scene_duration",
                "operation_id": "op_001",
                "scene_id": "scene_001",
                "duration_in_frames": 100,
            }
        ).operations,
    )

    assert [(scene.start_frame, scene.duration_in_frames) for scene in result.scenes] == [
        (0, 100),
        (100, 150),
    ]
    assert [(clip.start_frame, clip.duration_in_frames) for clip in result.clips] == [
        (0, 100),
        (100, 150),
    ]
    assert result.canvas.duration_in_frames == 250
    assert document.canvas.duration_in_frames == 300


@pytest.mark.parametrize(
    "payload",
    [
        {
            "base_revision": 1,
            "operations": [
                {
                    "kind": "set_ownership",
                    "operation_id": "op_001",
                    "clip_id": "clip_001",
                    "ownership": "locked",
                },
                {
                    "kind": "set_ownership",
                    "operation_id": "op_001",
                    "clip_id": "clip_002",
                    "ownership": "locked",
                },
            ],
        },
        {
            "base_revision": 1,
            "operations": [
                {
                    "kind": "replace_text",
                    "operation_id": "op_001",
                    "clip_id": "clip_001",
                    "field": "caption",
                    "value": "x",
                }
            ],
        },
        {
            "base_revision": 1,
            "operations": [
                {
                    "kind": "set_scene_duration",
                    "operation_id": "op_001",
                    "scene_id": "scene_001",
                    "duration_in_frames": 0,
                }
            ],
        },
    ],
)
def test_patch_rejects_invalid_operations(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        EditDocumentPatch.model_validate(payload)


@pytest.mark.parametrize(
    "operation",
    [
        {
            "kind": "set_ownership",
            "operation_id": "op_001",
            "clip_id": "clip_missing",
            "ownership": "locked",
        },
        {
            "kind": "set_scene_duration",
            "operation_id": "op_001",
            "scene_id": "scene_missing",
            "duration_in_frames": 100,
        },
        {
            "kind": "replace_text",
            "operation_id": "op_001",
            "clip_id": "clip_001",
            "field": "heading",
            "value": "",
        },
    ],
)
def test_apply_rejects_unknown_ids_and_invalid_results(
    document: EditDocument, operation: dict[str, object]
) -> None:
    with pytest.raises((ValidationError, ValueError)):
        apply_edit_operations(document, patch(operation).operations)
