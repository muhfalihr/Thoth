"""Pure, typed timeline operations for version 2 edit documents.

Every operation mutates a caller-owned working copy in place. The caller is
responsible for revalidating the document once the whole ordered batch has
been applied, which is what makes a batch atomic: a rejection anywhere leaves
the caller's original document untouched.

Operations never accept an artifact locator. ``add_clip_from_asset`` names an
asset by identity only and copies the safe projection the repository resolved
for the owning project.
"""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field

from thoth_control_plane.domain.edit_document_v2 import (
    AssetRef,
    EditDocumentV2,
    TimelineAudioClip,
    TimelineCaptionClip,
    TimelineClip,
    TimelineTrack,
    TimelineVideoClip,
    TrackKind,
    Volume,
)
from thoth_control_plane.domain.edit_documents import Frame, FrameStart, ShortText
from thoth_control_plane.domain.models import OpaqueId, StrictModel


class AddTrack(StrictModel):
    kind: Literal["add_track"]
    operation_id: OpaqueId
    track_id: OpaqueId
    track_kind: TrackKind
    label: Annotated[str, Field(min_length=1, max_length=120)]
    order: Annotated[int, Field(ge=0)]


class RemoveEmptyTrack(StrictModel):
    kind: Literal["remove_empty_track"]
    operation_id: OpaqueId
    track_id: OpaqueId


class ReorderTrack(StrictModel):
    kind: Literal["reorder_track"]
    operation_id: OpaqueId
    track_id: OpaqueId
    order: Annotated[int, Field(ge=0)]


class AddClipFromAsset(StrictModel):
    kind: Literal["add_clip_from_asset"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    track_id: OpaqueId
    asset_id: OpaqueId
    from_frame: FrameStart
    duration_in_frames: Frame
    source_from_frame: FrameStart = 0
    #: Binds the clip to a scene, so it moves with the scene and stays inside it.
    scene_id: OpaqueId | None = None


class ReorderScene(StrictModel):
    kind: Literal["reorder_scene"]
    operation_id: OpaqueId
    scene_id: OpaqueId
    to_index: Annotated[int, Field(ge=0)]


class RemoveClip(StrictModel):
    kind: Literal["remove_clip"]
    operation_id: OpaqueId
    clip_id: OpaqueId


class MoveClip(StrictModel):
    kind: Literal["move_clip"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    target_track_id: OpaqueId
    from_frame: FrameStart
    ripple: bool = False


class TrimClipStart(StrictModel):
    kind: Literal["trim_clip_start"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    from_frame: FrameStart


class TrimClipEnd(StrictModel):
    kind: Literal["trim_clip_end"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    end_frame: Frame


class SplitClip(StrictModel):
    kind: Literal["split_clip"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    split_frame: FrameStart
    left_clip_id: OpaqueId
    right_clip_id: OpaqueId


class SetClipHidden(StrictModel):
    kind: Literal["set_clip_hidden"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    hidden: bool


class SetClipLocked(StrictModel):
    kind: Literal["set_clip_locked"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    locked: bool


class SetClipVolume(StrictModel):
    kind: Literal["set_clip_volume"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    volume: Volume


class SetCaptionCueText(StrictModel):
    kind: Literal["set_caption_cue_text"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    cue_index: Annotated[int, Field(ge=0)]
    text: ShortText


class SetTrackVisibility(StrictModel):
    kind: Literal["set_track_visibility"]
    operation_id: OpaqueId
    track_id: OpaqueId
    hidden: bool


class SetTrackMuted(StrictModel):
    kind: Literal["set_track_muted"]
    operation_id: OpaqueId
    track_id: OpaqueId
    muted: bool


class SetTrackLocked(StrictModel):
    kind: Literal["set_track_locked"]
    operation_id: OpaqueId
    track_id: OpaqueId
    locked: bool


TimelineOperation: TypeAlias = Annotated[
    AddTrack
    | RemoveEmptyTrack
    | ReorderTrack
    | ReorderScene
    | AddClipFromAsset
    | RemoveClip
    | MoveClip
    | TrimClipStart
    | TrimClipEnd
    | SplitClip
    | SetClipHidden
    | SetClipLocked
    | SetClipVolume
    | SetCaptionCueText
    | SetTrackVisibility
    | SetTrackMuted
    | SetTrackLocked,
    Field(discriminator="kind"),
]


def apply_timeline_operation(
    document: EditDocumentV2,
    operation: TimelineOperation,
    resolved_assets: dict[str, AssetRef],
) -> None:
    """Apply one timeline operation to ``document`` in place."""
    match operation:
        case AddTrack():
            _add_track(document, operation)
        case RemoveEmptyTrack():
            _remove_empty_track(document, operation)
        case ReorderTrack():
            _unlocked_track(document, operation.track_id).order = operation.order
        case ReorderScene():
            _reorder_scene(document, operation)
        case AddClipFromAsset():
            _add_clip_from_asset(document, operation, resolved_assets)
        case RemoveClip():
            _remove_clip(document, operation)
        case MoveClip():
            _move_clip(document, operation)
        case TrimClipStart():
            _trim_clip_start(document, operation)
        case TrimClipEnd():
            _trim_clip_end(document, operation)
        case SplitClip():
            _split_clip(document, operation)
        case SetClipHidden():
            _unlocked_clip(document, operation.clip_id).hidden = operation.hidden
        case SetClipLocked():
            _clip(document, operation.clip_id).locked = operation.locked
        case SetClipVolume():
            _set_clip_volume(document, operation)
        case SetCaptionCueText():
            clip = _unlocked_clip(document, operation.clip_id)
            if not isinstance(clip, TimelineCaptionClip) or operation.cue_index >= len(clip.cues):
                raise ValueError("caption cue unavailable")
            clip.cues[operation.cue_index].text = operation.text
        case SetTrackVisibility():
            _unlocked_track(document, operation.track_id).hidden = operation.hidden
        case SetTrackMuted():
            _unlocked_track(document, operation.track_id).muted = operation.muted
        case SetTrackLocked():
            _track(document, operation.track_id).locked = operation.locked


# --------------------------------------------------------------------------
# Lookup and lock gates
# --------------------------------------------------------------------------


def _track(document: EditDocumentV2, track_id: str) -> TimelineTrack:
    for track in document.tracks:
        if track.track_id == track_id:
            return track
    raise ValueError("operation references an unknown track")


def _clip(document: EditDocumentV2, clip_id: str) -> TimelineClip:
    for clip in document.clips:
        if clip.clip_id == clip_id:
            return clip
    raise ValueError("operation references an unknown clip")


def _unlocked_track(document: EditDocumentV2, track_id: str) -> TimelineTrack:
    track = _track(document, track_id)
    if track.locked:
        raise ValueError("track is locked")
    return track


def _unlocked_clip(document: EditDocumentV2, clip_id: str) -> TimelineClip:
    clip = _clip(document, clip_id)
    if clip.locked:
        raise ValueError("clip is locked")
    _unlocked_track(document, clip.track_id)
    return clip


# --------------------------------------------------------------------------
# Scene strip
# --------------------------------------------------------------------------


def carry_scene_clips(
    document: EditDocumentV2, previous_starts: dict[str, int], skip: frozenset[str] = frozenset()
) -> None:
    """Keep every scene-bound clip at its offset after the scene strip is laid out again.

    A clip that no longer fits a shortened scene is trimmed at its end.
    """
    scenes = {scene.scene_id: scene for scene in document.scenes}
    for clip in document.clips:
        scene = scenes.get(clip.scene_id or "")
        if scene is None or clip.clip_id in skip:
            continue
        clip.from_frame += scene.start_frame - previous_starts[scene.scene_id]
        clip.duration_in_frames = min(
            clip.duration_in_frames, scene.start_frame + scene.duration_in_frames - clip.from_frame
        )


def _reorder_scene(document: EditDocumentV2, operation: ReorderScene) -> None:
    moving = next(
        (scene for scene in document.scenes if scene.scene_id == operation.scene_id), None
    )
    if moving is None:
        raise ValueError("operation references an unknown scene")
    if operation.to_index >= len(document.scenes):
        raise ValueError("scene index is out of range")

    previous_starts = {scene.scene_id: scene.start_frame for scene in document.scenes}
    document.scenes.remove(moving)
    document.scenes.insert(operation.to_index, moving)
    start_frame = 0
    for scene in document.scenes:
        scene.start_frame = start_frame
        start_frame += scene.duration_in_frames
    starts = {scene.scene_id: scene.start_frame for scene in document.scenes}
    for clip in document.clips:
        if clip.scene_id in starts and starts[clip.scene_id] != previous_starts[clip.scene_id]:
            _unlocked_clip(document, clip.clip_id)
    carry_scene_clips(document, previous_starts)


# --------------------------------------------------------------------------
# Track lifecycle
# --------------------------------------------------------------------------


def _add_track(document: EditDocumentV2, operation: AddTrack) -> None:
    if any(track.track_id == operation.track_id for track in document.tracks):
        raise ValueError("operation reuses an existing track ID")
    document.tracks.append(
        TimelineTrack(
            track_id=operation.track_id,
            kind=operation.track_kind,
            label=operation.label,
            order=operation.order,
        )
    )


def _remove_empty_track(document: EditDocumentV2, operation: RemoveEmptyTrack) -> None:
    track = _unlocked_track(document, operation.track_id)
    if track.clip_ids:
        raise ValueError("only an empty track can be removed")
    document.tracks.remove(track)


# --------------------------------------------------------------------------
# Clip lifecycle
# --------------------------------------------------------------------------


def _add_clip_from_asset(
    document: EditDocumentV2,
    operation: AddClipFromAsset,
    resolved_assets: dict[str, AssetRef],
) -> None:
    track = _unlocked_track(document, operation.track_id)
    if any(clip.clip_id == operation.clip_id for clip in document.clips):
        raise ValueError("operation reuses an existing clip ID")

    asset = resolved_assets.get(operation.asset_id)
    if asset is None:
        raise ValueError("operation references an unavailable asset")
    if asset.project_id != document.project_id:
        raise ValueError("asset belongs to another project")
    if asset.validation_state != "ready":
        raise ValueError("asset is not ready for use")
    if all(known.asset_id != asset.asset_id for known in document.asset_refs):
        document.asset_refs.append(asset.model_copy(deep=True))

    fields = {
        "clip_id": operation.clip_id,
        "track_id": track.track_id,
        "scene_id": operation.scene_id,
        "from_frame": operation.from_frame,
        "duration_in_frames": operation.duration_in_frames,
        "ownership": "user_edited",
        "asset_id": asset.asset_id,
        "source_from_frame": operation.source_from_frame,
    }
    clip: TimelineClip = (
        TimelineAudioClip(kind="audio", **fields)
        if asset.kind == "audio"
        else TimelineVideoClip(kind="video", **fields)
    )
    document.clips.append(clip)
    track.clip_ids.append(clip.clip_id)


def _remove_clip(document: EditDocumentV2, operation: RemoveClip) -> None:
    clip = _unlocked_clip(document, operation.clip_id)
    document.clips.remove(clip)
    _track(document, clip.track_id).clip_ids.remove(clip.clip_id)


def _move_clip(document: EditDocumentV2, operation: MoveClip) -> None:
    clip = _unlocked_clip(document, operation.clip_id)
    target = _unlocked_track(document, operation.target_track_id)

    if target.track_id != clip.track_id:
        _track(document, clip.track_id).clip_ids.remove(clip.clip_id)
        target.clip_ids.append(clip.clip_id)
        clip.track_id = target.track_id
    clip.from_frame = operation.from_frame

    if operation.ripple:
        _repack(document, target, clip.clip_id)


def _repack(document: EditDocumentV2, track: TimelineTrack, moved_clip_id: str) -> None:
    """Close gaps and overlaps on ``track``, letting the moved clip claim its slot."""
    clips = [clip for clip in document.clips if clip.track_id == track.track_id]
    clips.sort(key=lambda clip: (clip.from_frame, clip.clip_id != moved_clip_id))
    start = min(clip.from_frame for clip in clips)
    for clip in clips:
        clip.from_frame = start
        start += clip.duration_in_frames


# --------------------------------------------------------------------------
# Timing
# --------------------------------------------------------------------------


def _trim_clip_start(document: EditDocumentV2, operation: TrimClipStart) -> None:
    clip = _unlocked_clip(document, operation.clip_id)
    end_frame = clip.end_frame
    if operation.from_frame >= end_frame:
        raise ValueError("trim must leave a positive duration")

    delta = operation.from_frame - clip.from_frame
    source_from_frame = getattr(clip, "source_from_frame", None)
    if source_from_frame is not None:
        if source_from_frame + delta < 0:
            raise ValueError("trim cannot start before the source")
        clip.source_from_frame = source_from_frame + delta
    clip.from_frame = operation.from_frame
    clip.duration_in_frames = end_frame - operation.from_frame


def _trim_clip_end(document: EditDocumentV2, operation: TrimClipEnd) -> None:
    clip = _unlocked_clip(document, operation.clip_id)
    if operation.end_frame <= clip.from_frame:
        raise ValueError("trim must leave a positive duration")
    clip.duration_in_frames = operation.end_frame - clip.from_frame


def _split_clip(document: EditDocumentV2, operation: SplitClip) -> None:
    clip = _unlocked_clip(document, operation.clip_id)
    if not clip.from_frame < operation.split_frame < clip.end_frame:
        raise ValueError("split frame must fall inside the clip")
    if operation.left_clip_id == operation.right_clip_id:
        raise ValueError("split requires two distinct new clip IDs")

    taken = {other.clip_id for other in document.clips if other is not clip}
    if taken & {operation.left_clip_id, operation.right_clip_id}:
        raise ValueError("operation reuses an existing clip ID")

    end_frame = clip.end_frame
    left_duration = operation.split_frame - clip.from_frame
    right = clip.model_copy(deep=True)
    right.clip_id = operation.right_clip_id
    right.from_frame = operation.split_frame
    right.duration_in_frames = end_frame - operation.split_frame
    if getattr(right, "source_from_frame", None) is not None:
        right.source_from_frame += left_duration

    track = _track(document, clip.track_id)
    track.clip_ids[track.clip_ids.index(clip.clip_id)] = operation.left_clip_id
    track.clip_ids.append(right.clip_id)
    clip.clip_id = operation.left_clip_id
    clip.duration_in_frames = left_duration
    document.clips.append(right)


def _set_clip_volume(document: EditDocumentV2, operation: SetClipVolume) -> None:
    clip = _unlocked_clip(document, operation.clip_id)
    if not isinstance(clip, TimelineAudioClip):
        raise ValueError("volume applies only to audio clips")
    clip.volume = operation.volume
