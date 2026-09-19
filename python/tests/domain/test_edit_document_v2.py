"""Tests for the strict version 2 Creator Studio document contract."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from tests.domain.edit_document_v2_fixtures import (
    audio_clip_payload,
    clip_by_id,
    document_v2_payload,
    document_with_every_clip_kind,
    mutate,
    track_by_id,
)
from tests.domain.test_edit_documents import valid_document
from thoth_control_plane.domain.edit_document_v2 import EditDocument, EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1

DOCUMENT_ADAPTER: TypeAdapter[Any] = TypeAdapter(EditDocument)


def document_v2_fixture() -> EditDocumentV2:
    return EditDocumentV2.model_validate(document_v2_payload())


def test_version_two_accepts_all_registered_track_and_clip_kinds() -> None:
    document = EditDocumentV2.model_validate(document_with_every_clip_kind())

    assert document.schema_version == 2
    assert {track.kind for track in document.tracks} == {
        "main_video",
        "b_roll",
        "overlay",
        "caption",
        "narration",
        "music",
        "sfx",
    }
    assert {clip.kind for clip in document.clips} == {
        "text",
        "video",
        "caption",
        "overlay",
        "audio",
    }


def test_version_two_round_trips_without_coercion() -> None:
    payload = document_with_every_clip_kind()

    document = EditDocumentV2.model_validate(payload)

    assert EditDocumentV2.model_validate_json(document.model_dump_json()) == document
    assert document.model_dump(mode="json") == payload


def cross_project_asset(payload: dict[str, Any]) -> dict[str, Any]:
    return mutate(payload, ("asset_refs", 0, "project_id"), "project_999")


def clip_on_wrong_track(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    clip_by_id(result, "clip_main")["track_id"] = "track_caption"
    track_by_id(result, "track_main_video")["clip_ids"] = []
    track_by_id(result, "track_caption")["clip_ids"] = ["clip_main"]
    return result


def clip_past_canvas(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    clip_by_id(result, "clip_main")["duration_in_frames"] = 301
    return result


def duplicate_track_id(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    track_by_id(result, "track_b_roll")["track_id"] = "track_main_video"
    return result


def clip_past_source(payload: dict[str, Any]) -> dict[str, Any]:
    return mutate(payload, ("asset_refs", 0, "duration_in_frames"), 299)


def unknown_asset(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    clip_by_id(result, "clip_main")["asset_id"] = "asset_missing"
    return result


def audio_clip_on_video_asset(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    track_by_id(result, "track_music")["clip_ids"] = ["clip_music"]
    result["clips"].append(audio_clip_payload(asset_id="asset_main"))
    return result


def overlapping_main_video(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    clip_by_id(result, "clip_main")["duration_in_frames"] = 200
    second = deepcopy(clip_by_id(result, "clip_main"))
    second["clip_id"] = "clip_main_two"
    second["from_frame"] = 100
    second["duration_in_frames"] = 200
    result["clips"].append(second)
    track_by_id(result, "track_main_video")["clip_ids"] = ["clip_main", "clip_main_two"]
    return result


def track_membership_mismatch(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    track_by_id(result, "track_main_video")["clip_ids"] = []
    return result


def duplicate_track_order(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    track_by_id(result, "track_b_roll")["order"] = 0
    return result


def scene_range_escape(payload: dict[str, Any]) -> dict[str, Any]:
    return mutate(payload, ("clips", 0, "duration_in_frames"), 151)


def unknown_scene(payload: dict[str, Any]) -> dict[str, Any]:
    return mutate(payload, ("clips", 0, "scene_id"), "scene_999")


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (cross_project_asset, "asset reference project must match document"),
        (clip_on_wrong_track, "clip kind is incompatible with track"),
        (clip_past_canvas, "clip range exceeds canvas"),
        (duplicate_track_id, "duplicate track IDs are not allowed"),
        (clip_past_source, "clip range exceeds source asset duration"),
        (unknown_asset, "clip references an unknown asset"),
        (audio_clip_on_video_asset, "clip kind is incompatible with asset"),
        (overlapping_main_video, "main video clips must not overlap"),
        (track_membership_mismatch, "track clip IDs must match assigned clips"),
        (duplicate_track_order, "track order values must be unique"),
        (scene_range_escape, "clip range must stay inside its scene"),
        (unknown_scene, "clip references an unknown scene"),
    ],
)
def test_version_two_rejects_invalid_structure(mutation: Any, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        EditDocumentV2.model_validate(mutation(document_v2_payload()))


def test_version_two_rejects_unknown_fields_and_non_integer_timing() -> None:
    with pytest.raises(ValidationError):
        EditDocumentV2.model_validate({**document_v2_payload(), "unsafe": "nope"})

    with pytest.raises(ValidationError):
        EditDocumentV2.model_validate(
            mutate(document_v2_payload(), ("clips", 0, "from_frame"), 0.5)
        )


def test_version_two_rejects_locator_like_asset_fields() -> None:
    payload = document_v2_payload()
    payload["asset_refs"][0]["artifact_location"] = "assets/project_001/asset_main.mp4"

    with pytest.raises(ValidationError):
        EditDocumentV2.model_validate(payload)


def test_asset_reference_exposes_no_artifact_location() -> None:
    document = document_v2_fixture()

    assert "artifact_location" not in document.asset_refs[0].model_dump()
    assert (
        "artifact_location"
        not in EditDocumentV2.model_json_schema()["$defs"]["AssetRef"]["properties"]
    )


def test_version_one_fixture_and_discriminator_still_work() -> None:
    v1_payload = valid_document()

    assert DOCUMENT_ADAPTER.validate_python(v1_payload).schema_version == 1
    assert isinstance(DOCUMENT_ADAPTER.validate_python(v1_payload), EditDocumentV1)
    assert DOCUMENT_ADAPTER.validate_python(document_v2_payload()).schema_version == 2

    with pytest.raises(ValidationError):
        DOCUMENT_ADAPTER.validate_python({**v1_payload, "schema_version": 3})
