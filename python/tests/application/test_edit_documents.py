"""Tests for sanitized Content Set import into Creator Studio documents."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from thoth_control_plane.application.edit_documents import (
    ContentSetImportRequest,
    build_edit_document,
)


def request_payload() -> dict[str, object]:
    return {
        "main": {"title": "  Main title  ", "description": "  Main description  "},
        "footage": [
            {"title": "  First source  ", "platform": "  tiktok  "},
            {"title": "", "platform": "youtube"},
            {"title": " Second source ", "platform": " Instagram "},
            {"title": " Third source ", "platform": None},
            {"title": " Fourth source ", "platform": "x"},
        ],
    }


def test_importer_uses_only_text_and_first_three_non_empty_sources() -> None:
    request = ContentSetImportRequest.model_validate(request_payload())

    document = build_edit_document("project_001", request, "edoc_abc123")

    assert request.main.title == "Main title"
    assert request.main.description == "Main description"
    assert request.footage[1].title is None
    assert document.canvas.duration_in_frames == 600
    assert [scene.scene_id for scene in document.scenes] == [
        "scene_001",
        "scene_002",
        "scene_003",
        "scene_004",
    ]
    assert [scene.role for scene in document.scenes] == ["title", "source", "source", "source"]
    assert [clip.clip_id for clip in document.clips] == [
        "clip_001",
        "clip_002",
        "clip_003",
        "clip_004",
    ]
    assert [clip.heading for clip in document.clips] == [
        "Main title",
        "First source",
        "Second source",
        "Third source",
    ]
    assert [clip.body for clip in document.clips] == [
        "Main description",
        "tiktok",
        "instagram",
        "",
    ]
    assert all(scene.duration_in_frames == 150 for scene in document.scenes)
    assert document.tracks[0].clip_ids == ["clip_001", "clip_002", "clip_003", "clip_004"]
    assert all(clip.ownership == "ai_managed" for clip in document.clips)


def test_importer_supplies_title_when_content_set_title_is_missing() -> None:
    request = ContentSetImportRequest.model_validate({"main": {}, "footage": []})

    document = build_edit_document("project_001", request, "edoc_abc123")

    assert len(document.scenes) == 1
    assert document.clips[0].heading == "Untitled video"
    assert document.clips[0].body == ""


@pytest.mark.parametrize("field", ["url", "image_path", "comments", "profile", "references"])
def test_import_request_rejects_unsafe_legacy_content_set_fields(field: str) -> None:
    payload = request_payload()
    payload[field] = "unsafe"

    with pytest.raises(ValidationError):
        ContentSetImportRequest.model_validate(payload)


def test_import_request_has_no_route_for_raw_content_values() -> None:
    request = ContentSetImportRequest.model_validate(request_payload())
    serialized = json.dumps(request.model_dump(mode="json"))

    for forbidden in ("https://", r"C:\\", "/home/", "token", "secret_fixture_value"):
        assert forbidden not in serialized


def test_import_request_rejects_unknown_nested_content_values() -> None:
    payload = request_payload()
    payload["main"]["url"] = "https://example.test/secret"  # type: ignore[index]

    with pytest.raises(ValidationError):
        ContentSetImportRequest.model_validate(payload)
