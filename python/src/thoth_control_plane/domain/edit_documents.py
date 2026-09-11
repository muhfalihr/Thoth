"""Strict, immutable v1 Creator Studio edit-document contracts."""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field, model_validator

from thoth_control_plane.domain.models import OpaqueId, StrictModel

Frame = Annotated[int, Field(gt=0)]
FrameStart = Annotated[int, Field(ge=0)]
ShortText = Annotated[str, Field(min_length=1, max_length=300)]
BodyText = Annotated[str, Field(max_length=2_000)]
StyleSlot = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
Ownership: TypeAlias = Literal["ai_managed", "user_edited", "locked"]


class Canvas(StrictModel):
    width: Literal[1080]
    height: Literal[1920]
    fps: Literal[30]
    duration_in_frames: Frame


class TemplateRef(StrictModel):
    template_id: Literal["vertical_text_story"]
    version: Literal[1]


class Scene(StrictModel):
    scene_id: OpaqueId
    role: Literal["title", "source"]
    start_frame: FrameStart
    duration_in_frames: Frame
    clip_ids: Annotated[list[OpaqueId], Field(min_length=1, max_length=1)]


class Track(StrictModel):
    track_id: Literal["track_visual"]
    kind: Literal["visual"]
    clip_ids: Annotated[list[OpaqueId], Field(min_length=1, max_length=200)]


class TextClip(StrictModel):
    kind: Literal["text"]
    clip_id: OpaqueId
    scene_id: OpaqueId
    track_id: Literal["track_visual"]
    start_frame: FrameStart
    duration_in_frames: Frame
    heading: ShortText
    body: BodyText
    style_slot: StyleSlot
    ownership: Ownership


Clip: TypeAlias = TextClip


class EditDocument(StrictModel):
    """A complete, validated, immutable revision-one vertical text story."""

    schema_version: Literal[1]
    document_id: OpaqueId
    project_id: OpaqueId
    revision: Literal[1]
    template: TemplateRef
    canvas: Canvas
    scenes: Annotated[list[Scene], Field(min_length=1, max_length=100)]
    tracks: Annotated[list[Track], Field(min_length=1, max_length=1)]
    clips: Annotated[list[Clip], Field(min_length=1, max_length=200)]

    @model_validator(mode="after")
    def validate_structure(self) -> EditDocument:
        self._require_unique_ids()
        clips_by_id = {clip.clip_id: clip for clip in self.clips}
        scenes_by_id = {scene.scene_id: scene for scene in self.scenes}
        self._validate_scenes(clips_by_id)
        self._validate_tracks(clips_by_id)
        self._validate_clips(clips_by_id, scenes_by_id)
        return self

    def _require_unique_ids(self) -> None:
        for values, label in (
            ([scene.scene_id for scene in self.scenes], "scene"),
            ([track.track_id for track in self.tracks], "track"),
            ([clip.clip_id for clip in self.clips], "clip"),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"duplicate {label} IDs are not allowed")

    def _validate_scenes(self, clips_by_id: dict[str, Clip]) -> None:
        expected_start = 0
        referenced_clip_ids: set[str] = set()
        for scene in self.scenes:
            if scene.start_frame != expected_start:
                raise ValueError("scenes must be contiguous from frame zero")
            expected_start += scene.duration_in_frames
            clip_id = scene.clip_ids[0]
            if clip_id not in clips_by_id:
                raise ValueError("scene references an unknown clip")
            if clip_id in referenced_clip_ids:
                raise ValueError("a clip may belong to only one scene")
            referenced_clip_ids.add(clip_id)
            clip = clips_by_id[clip_id]
            if (
                clip.scene_id != scene.scene_id
                or clip.start_frame != scene.start_frame
                or clip.duration_in_frames != scene.duration_in_frames
            ):
                raise ValueError("scene and text clip ranges must agree")
        if expected_start != self.canvas.duration_in_frames:
            raise ValueError("canvas duration must equal the final scene end")
        if referenced_clip_ids != set(clips_by_id):
            raise ValueError("every clip must belong to exactly one scene")

    def _validate_tracks(self, clips_by_id: dict[str, Clip]) -> None:
        track = self.tracks[0]
        if len(track.clip_ids) != len(set(track.clip_ids)):
            raise ValueError("track clip IDs must be unique")
        if set(track.clip_ids) != set(clips_by_id):
            raise ValueError("visual track must reference every clip exactly once")

    def _validate_clips(self, clips_by_id: dict[str, Clip], scenes_by_id: dict[str, Scene]) -> None:
        for clip in clips_by_id.values():
            if clip.scene_id not in scenes_by_id:
                raise ValueError("clip references an unknown scene")
