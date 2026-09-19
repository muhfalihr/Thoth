"""Tests for atomic, strictly typed version 2 timeline operations."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from tests.domain.edit_document_v2_fixtures import (
    audio_asset_payload,
    clip_by_id,
    document_v2_payload,
    document_with_every_clip_kind,
    track_by_id,
)
from tests.domain.test_edit_documents import valid_document
from thoth_control_plane.domain.edit_document_operations import (
    EditDocumentOperation,
    apply_edit_operations,
)
from thoth_control_plane.domain.edit_document_v2 import AssetRef, EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1
from thoth_control_plane.domain.timeline_operations import (
    AddClipFromAsset,
    AddTrack,
    MoveClip,
    RemoveClip,
    RemoveEmptyTrack,
    ReorderTrack,
    SetClipHidden,
    SetClipLocked,
    SetClipVolume,
    SetTrackLocked,
    SetTrackMuted,
    SetTrackVisibility,
    SplitClip,
    TrimClipEnd,
    TrimClipStart,
)

OPERATION_ADAPTER: TypeAdapter[Any] = TypeAdapter(EditDocumentOperation)


def document_v2_fixture() -> EditDocumentV2:
    return EditDocumentV2.model_validate(document_v2_payload())


def document_with_locked_b_roll_clip() -> EditDocumentV2:
    """Base document plus a locked b-roll clip a batch can fail on."""
    payload = document_v2_payload()
    locked = deepcopy(clip_by_id(payload, "clip_main"))
    locked.update(
        {
            "clip_id": "clip_locked",
            "track_id": "track_b_roll",
            "duration_in_frames": 100,
            "locked": True,
        }
    )
    payload["clips"].append(locked)
    track_by_id(payload, "track_b_roll")["clip_ids"] = ["clip_locked"]
    return EditDocumentV2.model_validate(payload)


def document_with_locked_track() -> EditDocumentV2:
    payload = document_v2_payload()
    track_by_id(payload, "track_main_video")["locked"] = True
    return EditDocumentV2.model_validate(payload)


def ready_assets() -> dict[str, AssetRef]:
    return {"asset_music": AssetRef.model_validate(audio_asset_payload())}


def track_ranges(document: EditDocumentV2, track_id: str) -> list[tuple[str, int, int]]:
    return sorted(
        (clip.clip_id, clip.from_frame, clip.duration_in_frames)
        for clip in document.clips
        if clip.track_id == track_id
    )


def find_clip(document: EditDocumentV2, clip_id: str) -> Any:
    return next(clip for clip in document.clips if clip.clip_id == clip_id)


def find_track(document: EditDocumentV2, track_id: str) -> Any:
    return next(track for track in document.tracks if track.track_id == track_id)


def move(clip_id: str, track_id: str, from_frame: int, *, ripple: bool = False) -> MoveClip:
    return MoveClip(
        kind="move_clip",
        operation_id=f"op_move_{clip_id}",
        clip_id=clip_id,
        target_track_id=track_id,
        from_frame=from_frame,
        ripple=ripple,
    )


def split_main(split_frame: int, left: str, right: str) -> SplitClip:
    return SplitClip(
        kind="split_clip",
        operation_id="op_split",
        clip_id="clip_main",
        split_frame=split_frame,
        left_clip_id=left,
        right_clip_id=right,
    )


def trim_end(clip_id: str, end_frame: int) -> TrimClipEnd:
    return TrimClipEnd(
        kind="trim_clip_end",
        operation_id=f"op_trim_{clip_id}",
        clip_id=clip_id,
        end_frame=end_frame,
    )


# --------------------------------------------------------------------------
# Operation parsing
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {
            "kind": "add_track",
            "operation_id": "op_1",
            "track_id": "track_extra",
            "track_kind": "b_roll",
            "label": "Extra",
            "order": 9,
        },
        {"kind": "remove_empty_track", "operation_id": "op_1", "track_id": "track_sfx"},
        {"kind": "reorder_track", "operation_id": "op_1", "track_id": "track_sfx", "order": 2},
        {
            "kind": "add_clip_from_asset",
            "operation_id": "op_1",
            "clip_id": "clip_new",
            "track_id": "track_music",
            "asset_id": "asset_music",
            "from_frame": 0,
            "duration_in_frames": 60,
            "source_from_frame": 0,
        },
        {"kind": "remove_clip", "operation_id": "op_1", "clip_id": "clip_main"},
        {
            "kind": "move_clip",
            "operation_id": "op_1",
            "clip_id": "clip_main",
            "target_track_id": "track_b_roll",
            "from_frame": 10,
            "ripple": False,
        },
        {
            "kind": "trim_clip_start",
            "operation_id": "op_1",
            "clip_id": "clip_main",
            "from_frame": 10,
        },
        {"kind": "trim_clip_end", "operation_id": "op_1", "clip_id": "clip_main", "end_frame": 200},
        {
            "kind": "split_clip",
            "operation_id": "op_1",
            "clip_id": "clip_main",
            "split_frame": 90,
            "left_clip_id": "clip_left",
            "right_clip_id": "clip_right",
        },
        {"kind": "set_clip_hidden", "operation_id": "op_1", "clip_id": "clip_main", "hidden": True},
        {"kind": "set_clip_locked", "operation_id": "op_1", "clip_id": "clip_main", "locked": True},
        {
            "kind": "set_track_visibility",
            "operation_id": "op_1",
            "track_id": "track_b_roll",
            "hidden": True,
        },
        {
            "kind": "set_track_muted",
            "operation_id": "op_1",
            "track_id": "track_music",
            "muted": True,
        },
        {
            "kind": "set_track_locked",
            "operation_id": "op_1",
            "track_id": "track_b_roll",
            "locked": True,
        },
        {"kind": "set_clip_volume", "operation_id": "op_1", "clip_id": "clip_main", "volume": 0.5},
        {
            "kind": "replace_text",
            "operation_id": "op_1",
            "clip_id": "clip_001",
            "field": "heading",
            "value": "New",
        },
    ],
)
def test_every_operation_parses_through_the_shared_union(payload: dict[str, Any]) -> None:
    operation = OPERATION_ADAPTER.validate_python(payload)

    assert operation.kind == payload["kind"]
    assert operation.model_dump(mode="json") == payload


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "not_a_real_operation", "operation_id": "op_1"},
        {"kind": "remove_clip", "operation_id": "op_1", "clip_id": "clip_main", "extra": 1},
        {"kind": "remove_clip", "operation_id": "op_1"},
        {"kind": "set_clip_volume", "operation_id": "op_1", "clip_id": "clip_main", "volume": 2.5},
        {"kind": "set_clip_volume", "operation_id": "op_1", "clip_id": "clip_main", "volume": -0.1},
        {
            "kind": "set_clip_volume",
            "operation_id": "op_1",
            "clip_id": "clip_main",
            "volume": float("nan"),
        },
        {
            "kind": "set_clip_volume",
            "operation_id": "op_1",
            "clip_id": "clip_main",
            "volume": float("inf"),
        },
        {
            "kind": "add_clip_from_asset",
            "operation_id": "op_1",
            "clip_id": "clip_new",
            "track_id": "track_music",
            "asset_id": "asset_music",
            "from_frame": 0,
            "duration_in_frames": 60,
            "artifact_location": "../../etc/passwd",
        },
        {"kind": "trim_clip_end", "operation_id": "op_1", "clip_id": "clip_main", "end_frame": 0},
        {
            "kind": "move_clip",
            "operation_id": "op_1",
            "clip_id": "clip_main",
            "target_track_id": "track_b_roll",
            "from_frame": -1,
            "ripple": False,
        },
    ],
)
def test_unknown_kinds_fields_and_out_of_range_values_are_rejected(
    payload: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        OPERATION_ADAPTER.validate_python(payload)


def test_timeline_operations_carry_no_locator_field_in_their_schema() -> None:
    schema = TypeAdapter(AddClipFromAsset).json_schema()

    assert set(schema["properties"]) == {
        "kind",
        "operation_id",
        "clip_id",
        "track_id",
        "asset_id",
        "from_frame",
        "duration_in_frames",
        "source_from_frame",
    }


# --------------------------------------------------------------------------
# Split identity and batch atomicity
# --------------------------------------------------------------------------


def test_split_uses_supplied_unique_ids_and_preserves_source_range() -> None:
    result = apply_edit_operations(
        document_v2_fixture(), [split_main(90, "clip_left", "clip_right")]
    )

    assert track_ranges(result, "track_main_video") == [
        ("clip_left", 0, 90),
        ("clip_right", 90, 210),
    ]
    assert find_clip(result, "clip_left").source_from_frame == 0
    assert find_clip(result, "clip_right").source_from_frame == 90
    assert set(find_track(result, "track_main_video").clip_ids) == {"clip_left", "clip_right"}


def test_operation_batch_is_atomic_when_last_operation_is_invalid() -> None:
    document = document_with_locked_b_roll_clip()
    before = document.model_dump()

    with pytest.raises(ValueError, match="locked"):
        apply_edit_operations(
            document,
            [move("clip_main", "track_main_video", 0), move("clip_locked", "track_b_roll", 50)],
        )

    assert document.model_dump() == before


def test_a_failed_batch_discards_every_earlier_operation() -> None:
    document = document_v2_fixture()

    with pytest.raises(ValueError, match="operation references an unknown clip"):
        apply_edit_operations(
            document,
            [
                SetClipHidden(
                    kind="set_clip_hidden", operation_id="op_a", clip_id="clip_main", hidden=True
                ),
                RemoveClip(kind="remove_clip", operation_id="op_b", clip_id="clip_missing"),
            ],
        )

    assert find_clip(document, "clip_main").hidden is False


# --------------------------------------------------------------------------
# Rejected operations
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("operation", "message"),
    [
        (split_main(0, "clip_left", "clip_right"), "split frame must fall inside the clip"),
        (split_main(300, "clip_left", "clip_right"), "split frame must fall inside the clip"),
        (split_main(90, "clip_same", "clip_same"), "split requires two distinct new clip IDs"),
        (split_main(90, "clip_001", "clip_right"), "operation reuses an existing clip ID"),
        (
            TrimClipStart(
                kind="trim_clip_start", operation_id="op_1", clip_id="clip_main", from_frame=300
            ),
            "trim must leave a positive duration",
        ),
        (trim_end("clip_002", 100), "trim must leave a positive duration"),
        (
            move("clip_main", "track_caption", 0),
            "clip kind is incompatible with track",
        ),
        (move("clip_main", "track_main_video", 10), "clip range exceeds canvas"),
        (move("clip_main", "track_missing", 0), "operation references an unknown track"),
        (
            RemoveClip(kind="remove_clip", operation_id="op_1", clip_id="clip_missing"),
            "operation references an unknown clip",
        ),
        (
            RemoveEmptyTrack(
                kind="remove_empty_track", operation_id="op_1", track_id="track_main_video"
            ),
            "only an empty track can be removed",
        ),
        (
            ReorderTrack(kind="reorder_track", operation_id="op_1", track_id="track_sfx", order=0),
            "track order values must be unique",
        ),
        (
            AddTrack(
                kind="add_track",
                operation_id="op_1",
                track_id="track_main_video",
                track_kind="b_roll",
                label="Duplicate",
                order=9,
            ),
            "operation reuses an existing track ID",
        ),
        (
            SetTrackMuted(
                kind="set_track_muted", operation_id="op_1", track_id="track_missing", muted=True
            ),
            "operation references an unknown track",
        ),
    ],
)
def test_invalid_timeline_operations_are_rejected(
    operation: EditDocumentOperation, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        apply_edit_operations(document_v2_fixture(), [operation])


# --------------------------------------------------------------------------
# Trimming
# --------------------------------------------------------------------------


def test_trim_start_moves_the_source_window_and_keeps_the_end_fixed() -> None:
    result = apply_edit_operations(
        document_v2_fixture(),
        [
            TrimClipStart(
                kind="trim_clip_start", operation_id="op_1", clip_id="clip_main", from_frame=60
            )
        ],
    )

    clip = find_clip(result, "clip_main")
    assert (clip.from_frame, clip.duration_in_frames, clip.source_from_frame) == (60, 240, 60)


def test_trim_end_shortens_the_clip_without_touching_the_source_window() -> None:
    result = apply_edit_operations(document_v2_fixture(), [trim_end("clip_main", 120)])

    clip = find_clip(result, "clip_main")
    assert (clip.from_frame, clip.duration_in_frames, clip.source_from_frame) == (0, 120, 0)


def test_trim_start_cannot_run_past_the_beginning_of_the_source() -> None:
    document = apply_edit_operations(
        document_v2_fixture(),
        [trim_end("clip_main", 100), move("clip_main", "track_main_video", 100)],
    )

    with pytest.raises(ValueError, match="trim cannot start before the source"):
        apply_edit_operations(
            document,
            [
                TrimClipStart(
                    kind="trim_clip_start", operation_id="op_1", clip_id="clip_main", from_frame=0
                )
            ],
        )


# --------------------------------------------------------------------------
# Main-track layout, overlap, gaps, and ripple
# --------------------------------------------------------------------------


def split_then(operations: list[EditDocumentOperation]) -> EditDocumentV2:
    return apply_edit_operations(
        document_v2_fixture(), [split_main(100, "clip_a", "clip_b"), *operations]
    )


def test_main_video_overlap_is_rejected_but_b_roll_overlap_is_allowed() -> None:
    document = split_then([])
    assert track_ranges(document, "track_main_video") == [("clip_a", 0, 100), ("clip_b", 100, 200)]

    with pytest.raises(ValueError, match="main video clips must not overlap"):
        apply_edit_operations(document, [move("clip_b", "track_main_video", 50)])

    overlapping = apply_edit_operations(
        document, [move("clip_a", "track_b_roll", 0), move("clip_b", "track_b_roll", 0)]
    )
    assert track_ranges(overlapping, "track_b_roll") == [("clip_a", 0, 100), ("clip_b", 0, 200)]
    assert track_ranges(overlapping, "track_main_video") == []


def test_a_gap_on_the_main_track_is_allowed_without_ripple() -> None:
    document = split_then(
        [move("clip_a", "track_b_roll", 0), move("clip_b", "track_main_video", 50)]
    )

    assert track_ranges(document, "track_main_video") == [("clip_b", 50, 200)]


def test_explicit_ripple_reorders_and_repacks_the_main_track() -> None:
    rippled = split_then([move("clip_b", "track_main_video", 0, ripple=True)])

    assert track_ranges(rippled, "track_main_video") == [("clip_a", 200, 100), ("clip_b", 0, 200)]


def test_ripple_closes_a_gap_left_by_an_earlier_trim() -> None:
    document = split_then([trim_end("clip_a", 50)])
    assert track_ranges(document, "track_main_video") == [("clip_a", 0, 50), ("clip_b", 100, 200)]

    rippled = apply_edit_operations(
        document, [move("clip_b", "track_main_video", 100, ripple=True)]
    )

    assert track_ranges(rippled, "track_main_video") == [("clip_a", 0, 50), ("clip_b", 50, 200)]


# --------------------------------------------------------------------------
# Locks, visibility, and volume
# --------------------------------------------------------------------------


def test_a_locked_clip_rejects_edits_but_can_still_be_unlocked() -> None:
    locked = document_with_locked_b_roll_clip()

    with pytest.raises(ValueError, match="clip is locked"):
        apply_edit_operations(locked, [trim_end("clip_locked", 50)])

    unlocked = apply_edit_operations(
        locked,
        [
            SetClipLocked(
                kind="set_clip_locked", operation_id="op_1", clip_id="clip_locked", locked=False
            )
        ],
    )
    assert find_clip(unlocked, "clip_locked").locked is False


def test_a_locked_track_rejects_edits_to_its_clips_and_to_itself() -> None:
    locked = document_with_locked_track()

    with pytest.raises(ValueError, match="track is locked"):
        apply_edit_operations(locked, [trim_end("clip_main", 100)])

    with pytest.raises(ValueError, match="track is locked"):
        apply_edit_operations(
            locked,
            [
                SetTrackMuted(
                    kind="set_track_muted",
                    operation_id="op_1",
                    track_id="track_main_video",
                    muted=True,
                )
            ],
        )

    unlocked = apply_edit_operations(
        locked,
        [
            SetTrackLocked(
                kind="set_track_locked",
                operation_id="op_1",
                track_id="track_main_video",
                locked=False,
            )
        ],
    )
    assert find_track(unlocked, "track_main_video").locked is False


def test_a_locked_track_also_refuses_to_receive_a_moved_clip() -> None:
    with pytest.raises(ValueError, match="track is locked"):
        apply_edit_operations(
            document_with_locked_track(), [move("clip_001", "track_main_video", 0)]
        )


def test_track_visibility_mute_and_clip_flags_round_trip() -> None:
    result = apply_edit_operations(
        document_v2_fixture(),
        [
            SetTrackVisibility(
                kind="set_track_visibility",
                operation_id="op_1",
                track_id="track_b_roll",
                hidden=True,
            ),
            SetTrackMuted(
                kind="set_track_muted", operation_id="op_2", track_id="track_music", muted=True
            ),
            SetClipHidden(
                kind="set_clip_hidden", operation_id="op_3", clip_id="clip_main", hidden=True
            ),
        ],
    )

    assert find_track(result, "track_b_roll").hidden is True
    assert find_track(result, "track_music").muted is True
    assert find_clip(result, "clip_main").hidden is True


def test_set_clip_volume_only_applies_to_audio_clips() -> None:
    document = EditDocumentV2.model_validate(document_with_every_clip_kind())

    result = apply_edit_operations(
        document,
        [
            SetClipVolume(
                kind="set_clip_volume", operation_id="op_1", clip_id="clip_music", volume=0.25
            )
        ],
    )
    assert find_clip(result, "clip_music").volume == 0.25

    with pytest.raises(ValueError, match="volume applies only to audio clips"):
        apply_edit_operations(
            document,
            [
                SetClipVolume(
                    kind="set_clip_volume", operation_id="op_1", clip_id="clip_main", volume=0.25
                )
            ],
        )


# --------------------------------------------------------------------------
# Track lifecycle
# --------------------------------------------------------------------------


def test_add_track_then_remove_empty_track_round_trips() -> None:
    added = apply_edit_operations(
        document_v2_fixture(),
        [
            AddTrack(
                kind="add_track",
                operation_id="op_1",
                track_id="track_b_roll_2",
                track_kind="b_roll",
                label="B-Roll 2",
                order=7,
            )
        ],
    )
    assert find_track(added, "track_b_roll_2").clip_ids == []

    removed = apply_edit_operations(
        added,
        [
            RemoveEmptyTrack(
                kind="remove_empty_track", operation_id="op_2", track_id="track_b_roll_2"
            )
        ],
    )
    assert all(track.track_id != "track_b_roll_2" for track in removed.tracks)


def test_reorder_track_changes_lane_order_without_reordering_the_list() -> None:
    result = apply_edit_operations(
        document_v2_fixture(),
        [ReorderTrack(kind="reorder_track", operation_id="op_1", track_id="track_sfx", order=99)],
    )

    assert find_track(result, "track_sfx").order == 99
    assert [track.track_id for track in result.tracks] == [
        track.track_id for track in document_v2_fixture().tracks
    ]


def test_remove_clip_drops_it_from_its_track_membership() -> None:
    result = apply_edit_operations(
        document_v2_fixture(),
        [RemoveClip(kind="remove_clip", operation_id="op_1", clip_id="clip_main")],
    )

    assert find_track(result, "track_main_video").clip_ids == []
    assert all(clip.clip_id != "clip_main" for clip in result.clips)


# --------------------------------------------------------------------------
# Asset boundary
# --------------------------------------------------------------------------


def add_music(clip_id: str, track_id: str, duration: int, **overrides: Any) -> AddClipFromAsset:
    payload: dict[str, Any] = {
        "kind": "add_clip_from_asset",
        "operation_id": f"op_{clip_id}",
        "clip_id": clip_id,
        "track_id": track_id,
        "asset_id": "asset_music",
        "from_frame": 0,
        "duration_in_frames": duration,
        "source_from_frame": 0,
    }
    payload.update(overrides)
    return AddClipFromAsset.model_validate(payload)


def test_add_clip_from_asset_copies_the_safe_projection_exactly_once() -> None:
    result = apply_edit_operations(
        document_v2_fixture(),
        [add_music("clip_music", "track_music", 60), add_music("clip_sfx", "track_sfx", 30)],
        resolved_assets=ready_assets(),
    )

    assert [asset.asset_id for asset in result.asset_refs] == ["asset_main", "asset_music"]
    assert {clip.clip_id for clip in result.clips if clip.kind == "audio"} == {
        "clip_music",
        "clip_sfx",
    }
    assert "artifact_location" not in result.asset_refs[1].model_dump()


def test_add_clip_from_asset_requires_a_resolved_same_project_asset() -> None:
    operation = add_music("clip_music", "track_music", 60)

    with pytest.raises(ValueError, match="operation references an unavailable asset"):
        apply_edit_operations(document_v2_fixture(), [operation])

    foreign = {
        "asset_music": AssetRef.model_validate(
            {**audio_asset_payload(), "project_id": "project_999"}
        )
    }
    with pytest.raises(ValueError, match="asset belongs to another project"):
        apply_edit_operations(document_v2_fixture(), [operation], resolved_assets=foreign)


def test_add_clip_from_asset_rejects_a_range_beyond_the_source() -> None:
    with pytest.raises(ValueError, match="clip range exceeds source asset duration"):
        apply_edit_operations(
            document_v2_fixture(),
            [add_music("clip_music", "track_music", 120, source_from_frame=550)],
            resolved_assets=ready_assets(),
        )


def test_add_clip_from_asset_rejects_an_unready_asset() -> None:
    pending = {
        "asset_music": AssetRef.model_validate(
            {**audio_asset_payload(), "validation_state": "pending"}
        )
    }

    with pytest.raises(ValueError, match="asset is not ready for use"):
        apply_edit_operations(
            document_v2_fixture(),
            [add_music("clip_music", "track_music", 60)],
            resolved_assets=pending,
        )


def test_add_clip_from_asset_puts_a_video_asset_on_a_video_track() -> None:
    assets = {"asset_main": AssetRef.model_validate(document_v2_payload()["asset_refs"][0])}
    operation = AddClipFromAsset(
        kind="add_clip_from_asset",
        operation_id="op_1",
        clip_id="clip_b_roll",
        track_id="track_b_roll",
        asset_id="asset_main",
        from_frame=0,
        duration_in_frames=120,
        source_from_frame=300,
    )

    result = apply_edit_operations(document_v2_fixture(), [operation], resolved_assets=assets)

    clip = find_clip(result, "clip_b_roll")
    assert (clip.kind, clip.source_from_frame) == ("video", 300)
    assert [asset.asset_id for asset in result.asset_refs] == ["asset_main"]


# --------------------------------------------------------------------------
# Version 1 compatibility
# --------------------------------------------------------------------------


def test_timeline_operations_are_refused_on_a_version_one_document() -> None:
    with pytest.raises(ValueError, match="requires a version 2 document"):
        apply_edit_operations(
            EditDocumentV1.model_validate(valid_document()),
            [RemoveClip(kind="remove_clip", operation_id="op_1", clip_id="clip_001")],
        )
