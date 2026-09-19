"""Shared version 2 edit-document payloads for domain tests."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

TRACK_ROLES = (
    ("track_main_video", "main_video", "Main Video", 0),
    ("track_b_roll", "b_roll", "B-Roll", 1),
    ("track_overlay", "overlay", "Overlay", 2),
    ("track_caption", "caption", "Captions", 3),
    ("track_narration", "narration", "Narration", 4),
    ("track_music", "music", "Music", 5),
    ("track_sfx", "sfx", "SFX", 6),
)


def empty_tracks() -> list[dict[str, Any]]:
    return [
        {
            "track_id": track_id,
            "kind": kind,
            "label": label,
            "order": order,
            "hidden": False,
            "muted": False,
            "locked": False,
            "clip_ids": [],
        }
        for track_id, kind, label, order in TRACK_ROLES
    ]


def document_v2_payload() -> dict[str, Any]:
    """A valid version 2 document with text scenes plus one main-video clip."""
    tracks = empty_tracks()
    tracks[0]["clip_ids"] = ["clip_main"]
    tracks[2]["clip_ids"] = ["clip_001", "clip_002"]

    return {
        "schema_version": 2,
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
        "tracks": tracks,
        "clips": [
            {
                "kind": "text",
                "clip_id": "clip_001",
                "track_id": "track_overlay",
                "scene_id": "scene_001",
                "from_frame": 0,
                "duration_in_frames": 150,
                "ownership": "ai_managed",
                "hidden": False,
                "locked": False,
                "heading": "Title",
                "body": "Summary",
                "style_slot": "title",
            },
            {
                "kind": "text",
                "clip_id": "clip_002",
                "track_id": "track_overlay",
                "scene_id": "scene_002",
                "from_frame": 150,
                "duration_in_frames": 150,
                "ownership": "ai_managed",
                "hidden": False,
                "locked": False,
                "heading": "Source",
                "body": "tiktok",
                "style_slot": "source",
            },
            {
                "kind": "video",
                "clip_id": "clip_main",
                "track_id": "track_main_video",
                "scene_id": None,
                "from_frame": 0,
                "duration_in_frames": 300,
                "ownership": "ai_managed",
                "hidden": False,
                "locked": False,
                "asset_id": "asset_main",
                "source_from_frame": 0,
                "fit": "cover",
                "crop": None,
                "position": None,
            },
        ],
        "asset_refs": [
            {
                "asset_id": "asset_main",
                "project_id": "project_001",
                "kind": "video",
                "duration_in_frames": 900,
                "width": 1080,
                "height": 1920,
                "fps": 30.0,
                "has_audio": True,
                "validation_state": "ready",
                "checksum": "sha256:" + "a" * 64,
            }
        ],
    }


def audio_asset_payload(asset_id: str = "asset_music") -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "project_id": "project_001",
        "kind": "audio",
        "duration_in_frames": 600,
        "width": None,
        "height": None,
        "fps": None,
        "has_audio": True,
        "validation_state": "ready",
        "checksum": None,
    }


def audio_clip_payload(clip_id: str = "clip_music", **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": "audio",
        "clip_id": clip_id,
        "track_id": "track_music",
        "scene_id": None,
        "from_frame": 0,
        "duration_in_frames": 120,
        "ownership": "ai_managed",
        "hidden": False,
        "locked": False,
        "asset_id": "asset_music",
        "source_from_frame": 0,
        "volume": 1.0,
        "fade_in_frames": 0,
        "fade_out_frames": 0,
    }
    payload.update(overrides)
    return payload


def document_with_every_clip_kind() -> dict[str, Any]:
    """Extend the base payload with caption, overlay, and audio clips."""
    payload = document_v2_payload()
    payload["asset_refs"].append(audio_asset_payload())
    tracks = {track["track_id"]: track for track in payload["tracks"]}
    tracks["track_caption"]["clip_ids"] = ["clip_caption"]
    tracks["track_overlay"]["clip_ids"].append("clip_overlay")
    tracks["track_music"]["clip_ids"] = ["clip_music"]
    payload["clips"].extend(
        [
            {
                "kind": "caption",
                "clip_id": "clip_caption",
                "track_id": "track_caption",
                "scene_id": None,
                "from_frame": 0,
                "duration_in_frames": 120,
                "ownership": "ai_managed",
                "hidden": False,
                "locked": False,
                "style_slot": "caption_default",
                "cues": [{"from_frame": 0, "duration_in_frames": 60, "text": "hello"}],
            },
            {
                "kind": "overlay",
                "clip_id": "clip_overlay",
                "track_id": "track_overlay",
                "scene_id": None,
                "from_frame": 0,
                "duration_in_frames": 90,
                "ownership": "ai_managed",
                "hidden": False,
                "locked": False,
                "preset_id": "lower_third",
                "parameters": {"text": "Breaking", "accent_slot": None},
            },
            audio_clip_payload(),
        ]
    )
    return payload


def mutate(payload: dict[str, Any], path: tuple[Any, ...], value: Any) -> dict[str, Any]:
    """Return a deep copy of ``payload`` with ``path`` set to ``value``."""
    result = deepcopy(payload)
    target: Any = result
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    return result


def clip_by_id(payload: dict[str, Any], clip_id: str) -> dict[str, Any]:
    for clip in payload["clips"]:
        if clip["clip_id"] == clip_id:
            return clip
    raise KeyError(clip_id)


def track_by_id(payload: dict[str, Any], track_id: str) -> dict[str, Any]:
    for track in payload["tracks"]:
        if track["track_id"] == track_id:
            return track
    raise KeyError(track_id)
