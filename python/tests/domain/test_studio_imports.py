"""Tests for the Studio import source projection and its server-side identity."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.studio_imports import (
    StudioSourceProjection,
    inspect_source,
    source_key,
)


def item(role: str, order: int, **overrides: Any) -> dict[str, Any]:
    return {
        "role": role,
        "order": order,
        "title": f"{role} {order}",
        "text": None,
        "platform": "youtube",
        "source_url": f"https://example.com/{role}/{order}",
        "media_kind": "video",
        "trim_start_seconds": None,
        **overrides,
    }


def projection_payload() -> dict[str, Any]:
    return {
        "items": [
            item("main", 0, text="Main caption", platform="tiktok", trim_start_seconds=1.5),
            item("main_footage", 0, title=None, platform=None, source_url=None),
            *(item("footage", index) for index in range(4)),
            item(
                "comment",
                0,
                title="viewer_one",
                text="First",
                platform=None,
                source_url=None,
                media_kind="image",
            ),
            item(
                "comment",
                1,
                title="viewer_two",
                text="Second",
                platform=None,
                source_url=None,
                media_kind="none",
            ),
        ],
        "unsupported": [
            {
                "field": "mute_audio",
                "role": "main",
                "order": 0,
                "reason": "Per-clip mute is not supported",
            },
            {
                "field": "unknown_creative_field",
                "role": None,
                "order": None,
                "reason": "Not recognized by Studio import",
            },
        ],
    }


def test_inventory_names_every_media_item_and_unsupported_field() -> None:
    projection = StudioSourceProjection.model_validate(projection_payload())
    inspection = inspect_source("project_001", projection)

    assert inspection.project_id == "project_001"
    assert [
        (entry.item_id, entry.role, entry.order, entry.disposition) for entry in inspection.items
    ] == [
        ("main_000", "main", 0, "unresolved"),
        ("main_footage_000", "main_footage", 0, "unresolved"),
        ("footage_000", "footage", 0, "unresolved"),
        ("footage_001", "footage", 1, "unresolved"),
        ("footage_002", "footage", 2, "unresolved"),
        ("footage_003", "footage", 3, "unresolved"),
        ("comment_000", "comment", 0, "unresolved"),
        ("unsupported_000", "main", 0, "unresolved"),
        ("unsupported_001", None, None, "unresolved"),
    ]
    assert inspection.items[1].label == "Main footage"
    assert inspection.items[7].label == "mute_audio"
    assert inspection.items[7].reason == "Per-clip mute is not supported"
    assert inspection.items[0].reason is None
    assert [entry.trim_start_seconds for entry in inspection.items[:3]] == [1.5, None, None]


def test_public_inspection_never_contains_a_source_address() -> None:
    inspection = inspect_source(
        "project_001", StudioSourceProjection.model_validate(projection_payload())
    )
    serialized = inspection.model_dump_json()
    assert "example.com" not in serialized
    assert "source_url" not in serialized


def test_source_key_is_a_stable_sha256_of_the_canonical_projection() -> None:
    payload = projection_payload()
    key = source_key(StudioSourceProjection.model_validate(payload))
    reordered_keys = json.loads(json.dumps(payload, sort_keys=True))

    assert len(key) == 64
    assert all(character in "0123456789abcdef" for character in key)
    assert source_key(StudioSourceProjection.model_validate(reordered_keys)) == key
    assert (
        inspect_source("project_001", StudioSourceProjection.model_validate(payload)).source_key
        == key
    )

    swapped = projection_payload()
    swapped["items"][2]["title"], swapped["items"][3]["title"] = (
        swapped["items"][3]["title"],
        swapped["items"][2]["title"],
    )
    assert source_key(StudioSourceProjection.model_validate(swapped)) != key


def test_distinct_unsupported_values_give_distinct_source_keys() -> None:
    def keyed(digest: str) -> str:
        payload = projection_payload()
        payload["unsupported"][0]["value_digest"] = digest
        return source_key(StudioSourceProjection.model_validate(payload))

    assert keyed("a" * 64) != keyed("b" * 64)
    payload = projection_payload()
    payload["unsupported"][0]["value_digest"] = "C:\\Users\\operator\\manifest.json"
    with pytest.raises(ValidationError):
        StudioSourceProjection.model_validate(payload)


@pytest.mark.parametrize(
    "source_url",
    [
        "https://cdn.example/v.mp4?x-signature=abc",
        "https://cdn.example/v.mp4#t=4",
        "C:\\Users\\operator\\main.mp4",
        "file:///C:/Users/operator/main.mp4",
        "ftp://example.com/v.mp4",
        "https://user:secret@example.com/v.mp4",
    ],
)
def test_rejects_a_source_address_that_is_not_a_canonical_web_url(source_url: str) -> None:
    payload = projection_payload()
    payload["items"][0]["source_url"] = source_url
    with pytest.raises(ValidationError):
        StudioSourceProjection.model_validate(payload)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda payload: payload.update(source_key="0" * 64),
        lambda payload: payload["items"][0].update(image_path="C:\\Users\\operator\\main.png"),
        lambda payload: payload["items"].pop(0),
        lambda payload: payload["items"].append(item("footage", 3)),
        lambda payload: payload["items"].append(item("footage", 9)),
        lambda payload: payload["items"].insert(1, item("comment", 2)),
        lambda payload: payload["items"][0].update(title="x" * 301),
        lambda payload: payload["items"][0].update(text="x" * 2001),
        lambda payload: payload["items"].extend(item("footage", index) for index in range(4, 400)),
        lambda payload: payload["unsupported"][0].update(field="C:\\path"),
        lambda payload: payload["unsupported"].extend([payload["unsupported"][1]] * 400),
        lambda payload: payload["items"][6].update(trim_start_seconds=2.0),
    ],
)
def test_rejects_malformed_or_oversize_projections(mutate: Any) -> None:
    payload = projection_payload()
    mutate(payload)
    with pytest.raises(ValidationError):
        StudioSourceProjection.model_validate(payload)


def test_every_item_with_content_gets_a_scene_and_media_points_at_it() -> None:
    payload = projection_payload()
    payload["items"].append(
        item("comment", 2, title=None, text=None, platform=None, source_url=None, media_kind="none")
    )
    inspection = inspect_source("project_001", StudioSourceProjection.model_validate(payload))
    scenes = {entry.item_id: entry.scene_id for entry in inspection.items}

    assert scenes["main_000"] == "scene_001"
    assert scenes["main_footage_000"] == "scene_001"
    assert scenes["footage_000"] == "scene_002"
    assert scenes["footage_003"] == "scene_005"
    assert scenes["comment_000"] == "scene_006"
    assert scenes["unsupported_000"] is None


def test_scenes_beyond_the_document_limit_are_reported_not_dropped() -> None:
    payload = projection_payload()
    payload["items"] = [
        payload["items"][0],
        *(item("footage", index) for index in range(120)),
    ]
    inspection = inspect_source("project_001", StudioSourceProjection.model_validate(payload))
    by_id = {entry.item_id: entry for entry in inspection.items}

    assert by_id["footage_098"].scene_id == "scene_100"
    assert by_id["footage_099"].scene_id is None
    overflow = by_id["scene_overflow"]
    assert overflow.disposition == "unresolved"
    assert overflow.label == "21 items beyond the 100-scene limit"
    assert overflow.reason == "Studio documents hold at most 100 scenes"
