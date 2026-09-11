"""Tests for the immutable Creator Studio document contract."""

from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.edit_documents import EditDocument


def valid_document() -> dict[str, object]:
    return {
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
            {"track_id": "track_visual", "kind": "visual", "clip_ids": ["clip_001", "clip_002"]}
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


def test_valid_document_round_trips_without_coercion() -> None:
    payload = valid_document()

    document = EditDocument.model_validate(payload)

    assert EditDocument.model_validate_json(document.model_dump_json()) == document
    assert document.model_dump(mode="json") == payload


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("schema_version",), 2),
        (("revision",), 0),
        (("template", "template_id"), "other_template"),
        (("canvas", "width"), 1920),
        (("canvas", "fps"), 24),
        (("clips", 0, "kind"), "video"),
        (("clips", 0, "heading"), "x" * 301),
        (("clips", 0, "body"), "x" * 2001),
        (("scenes", 0, "duration_in_frames"), 0),
    ],
)
def test_rejects_invalid_v1_field_values(path: tuple[object, ...], value: object) -> None:
    payload = valid_document()
    target: object = payload
    for part in path[:-1]:
        target = target[part]  # type: ignore[index]
    target[path[-1]] = value  # type: ignore[index]

    with pytest.raises(ValidationError):
        EditDocument.model_validate(payload)


def test_rejects_unknown_fields() -> None:
    payload = valid_document()
    payload["unsafe"] = "nope"

    with pytest.raises(ValidationError):
        EditDocument.model_validate(payload)


@pytest.mark.parametrize(
    ("collection", "field"),
    [
        ("scenes", "scene_id"),
        ("tracks", "track_id"),
        ("clips", "clip_id"),
    ],
)
def test_rejects_duplicate_ids(collection: str, field: str) -> None:
    payload = valid_document()
    if collection == "tracks":
        payload[collection].append(deepcopy(payload[collection][0]))  # type: ignore[index]
    else:
        payload[collection][1][field] = payload[collection][0][field]  # type: ignore[index]

    with pytest.raises(ValidationError):
        EditDocument.model_validate(payload)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("scenes", 0, "clip_ids"), ["unknown_clip"]),
        (("tracks", 0, "clip_ids"), ["clip_001"]),
        (("clips", 0, "scene_id"), "scene_002"),
        (("clips", 0, "track_id"), "other_track"),
        (("scenes", 1, "start_frame"), 151),
        (("clips", 1, "start_frame"), 149),
        (("canvas", "duration_in_frames"), 299),
    ],
)
def test_rejects_broken_cross_references_and_timing(
    path: tuple[object, ...], value: object
) -> None:
    payload = valid_document()
    target: object = payload
    for part in path[:-1]:
        target = target[part]  # type: ignore[index]
    target[path[-1]] = value  # type: ignore[index]

    with pytest.raises(ValidationError):
        EditDocument.model_validate(payload)


def test_rejects_more_than_v1_scene_or_clip_limits() -> None:
    too_many_scenes = valid_document()
    too_many_scenes["scenes"] = [deepcopy(too_many_scenes["scenes"][0]) for _ in range(101)]  # type: ignore[index]
    with pytest.raises(ValidationError):
        EditDocument.model_validate(too_many_scenes)

    too_many_clips = valid_document()
    too_many_clips["clips"] = [deepcopy(too_many_clips["clips"][0]) for _ in range(201)]  # type: ignore[index]
    with pytest.raises(ValidationError):
        EditDocument.model_validate(too_many_clips)
