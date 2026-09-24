"""Strict, immutable v2 Creator Studio multi-track edit-document contracts."""

from __future__ import annotations

from itertools import pairwise
from typing import Annotated, Literal, TypeAlias

from pydantic import Field, model_validator

from thoth_control_plane.domain.edit_documents import (
    BodyText,
    Canvas,
    EditDocumentV1,
    Frame,
    FrameStart,
    Ownership,
    Scene,
    ShortText,
    StyleSlot,
    TemplateRef,
)
from thoth_control_plane.domain.models import Checksum, OpaqueId, ProjectId, StrictModel

TrackKind: TypeAlias = Literal[
    "main_video", "b_roll", "overlay", "caption", "narration", "music", "sfx"
]
AssetKind: TypeAlias = Literal["video", "image", "audio"]
ValidationState: TypeAlias = Literal["ready", "rejected", "pending"]
FitMode: TypeAlias = Literal["cover", "contain", "fill"]
OverlayPreset: TypeAlias = Literal["lower_third", "badge", "progress_bar"]
#: The caption styles `CAPTION_STYLES` in @thoth/remotion-composition renders.
CaptionStyle: TypeAlias = Literal["caption_default", "source"]

PositiveInt = Annotated[int, Field(gt=0)]
NormalizedUnit = Annotated[float, Field(ge=0.0, le=1.0)]
Offset = Annotated[float, Field(ge=-1.0, le=1.0)]
Scale = Annotated[float, Field(gt=0.0, le=4.0)]
Volume = Annotated[float, Field(ge=0.0, le=2.0)]
FadeFrames = Annotated[int, Field(ge=0, le=300)]
Fps = Annotated[float, Field(gt=0.0, le=240.0)]

#: Which clip kinds a track of each kind accepts.
TRACK_CLIP_KINDS: dict[str, frozenset[str]] = {
    "main_video": frozenset({"video"}),
    "b_roll": frozenset({"video"}),
    "overlay": frozenset({"overlay", "text"}),
    "caption": frozenset({"caption"}),
    "narration": frozenset({"audio"}),
    "music": frozenset({"audio"}),
    "sfx": frozenset({"audio"}),
}

#: Which asset kinds a media-backed clip kind accepts.
CLIP_ASSET_KINDS: dict[str, frozenset[str]] = {
    "video": frozenset({"video", "image"}),
    "audio": frozenset({"audio"}),
}


class AssetRef(StrictModel):
    """Safe, immutable projection of a validated project asset.

    Carries identity and playback metadata only. The artifact locator and any
    preview capability stay server-side and never enter a persisted document.
    """

    asset_id: OpaqueId
    project_id: ProjectId
    kind: AssetKind
    duration_in_frames: Frame | None = None
    width: PositiveInt | None = None
    height: PositiveInt | None = None
    fps: Fps | None = None
    has_audio: bool
    validation_state: ValidationState
    checksum: Checksum | None = None


class TimelineTrack(StrictModel):
    track_id: OpaqueId
    kind: TrackKind
    label: Annotated[str, Field(min_length=1, max_length=120)]
    order: Annotated[int, Field(ge=0)]
    hidden: bool = False
    muted: bool = False
    locked: bool = False
    clip_ids: Annotated[list[OpaqueId], Field(max_length=500)] = Field(default_factory=list)


class TimelineClipBase(StrictModel):
    clip_id: OpaqueId
    track_id: OpaqueId
    scene_id: OpaqueId | None = None
    from_frame: FrameStart
    duration_in_frames: Frame
    ownership: Ownership
    hidden: bool = False
    locked: bool = False

    @property
    def end_frame(self) -> int:
        return self.from_frame + self.duration_in_frames


class Crop(StrictModel):
    left: NormalizedUnit = 0.0
    top: NormalizedUnit = 0.0
    width: NormalizedUnit = 1.0
    height: NormalizedUnit = 1.0

    @model_validator(mode="after")
    def validate_bounds(self) -> Crop:
        if self.left + self.width > 1.0 or self.top + self.height > 1.0:
            raise ValueError("crop must stay inside the source frame")
        if self.width == 0.0 or self.height == 0.0:
            raise ValueError("crop must have a positive size")
        return self


class Position(StrictModel):
    x: Offset = 0.0
    y: Offset = 0.0
    scale: Scale = 1.0


class OverlayParameters(StrictModel):
    text: ShortText | None = None
    accent_slot: StyleSlot | None = None


class CaptionCue(StrictModel):
    """Cue timing is relative to the start of its caption clip."""

    from_frame: FrameStart
    duration_in_frames: Frame
    text: ShortText


class TimelineTextClip(TimelineClipBase):
    kind: Literal["text"]
    heading: ShortText
    body: BodyText
    style_slot: StyleSlot


class TimelineVideoClip(TimelineClipBase):
    kind: Literal["video"]
    asset_id: OpaqueId
    source_from_frame: FrameStart = 0
    fit: FitMode = "cover"
    crop: Crop | None = None
    position: Position | None = None


class TimelineOverlayClip(TimelineClipBase):
    kind: Literal["overlay"]
    preset_id: OverlayPreset
    parameters: OverlayParameters = Field(default_factory=OverlayParameters)


class TimelineCaptionClip(TimelineClipBase):
    kind: Literal["caption"]
    style_slot: StyleSlot
    cues: Annotated[list[CaptionCue], Field(min_length=1, max_length=500)]


class TimelineAudioClip(TimelineClipBase):
    kind: Literal["audio"]
    asset_id: OpaqueId
    source_from_frame: FrameStart = 0
    volume: Volume = 1.0
    fade_in_frames: FadeFrames = 0
    fade_out_frames: FadeFrames = 0


TimelineClip: TypeAlias = Annotated[
    TimelineTextClip
    | TimelineVideoClip
    | TimelineOverlayClip
    | TimelineCaptionClip
    | TimelineAudioClip,
    Field(discriminator="kind"),
]


class EditDocumentV2(StrictModel):
    """A complete, validated, immutable schema-v2 multi-track document revision."""

    schema_version: Literal[2]
    document_id: OpaqueId
    project_id: ProjectId
    revision: Annotated[int, Field(gt=0)]
    template: TemplateRef
    canvas: Canvas
    scenes: Annotated[list[Scene], Field(min_length=1, max_length=100)]
    tracks: Annotated[list[TimelineTrack], Field(min_length=1, max_length=50)]
    clips: Annotated[list[TimelineClip], Field(max_length=500)] = Field(default_factory=list)
    asset_refs: Annotated[list[AssetRef], Field(max_length=200)] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_structure(self) -> EditDocumentV2:
        self._require_unique_ids()
        tracks_by_id = {track.track_id: track for track in self.tracks}
        scenes_by_id = {scene.scene_id: scene for scene in self.scenes}
        assets_by_id = {asset.asset_id: asset for asset in self.asset_refs}
        self._validate_assets(assets_by_id)
        self._validate_scenes()
        self._validate_clips(tracks_by_id, scenes_by_id, assets_by_id)
        self._validate_track_membership(tracks_by_id)
        self._validate_main_video_layout()
        return self

    def _require_unique_ids(self) -> None:
        for values, label in (
            ([scene.scene_id for scene in self.scenes], "scene"),
            ([track.track_id for track in self.tracks], "track"),
            ([clip.clip_id for clip in self.clips], "clip"),
            ([asset.asset_id for asset in self.asset_refs], "asset"),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"duplicate {label} IDs are not allowed")

        orders = [track.order for track in self.tracks]
        if len(orders) != len(set(orders)):
            raise ValueError("track order values must be unique")

    def _validate_assets(self, assets_by_id: dict[str, AssetRef]) -> None:
        for asset in assets_by_id.values():
            if asset.project_id != self.project_id:
                raise ValueError("asset reference project must match document")

    def _validate_scenes(self) -> None:
        expected_start = 0
        for scene in self.scenes:
            if scene.start_frame != expected_start:
                raise ValueError("scenes must be contiguous from frame zero")
            expected_start += scene.duration_in_frames
        if expected_start > self.canvas.duration_in_frames:
            raise ValueError("scenes must not extend beyond the canvas")

    def _validate_clips(
        self,
        tracks_by_id: dict[str, TimelineTrack],
        scenes_by_id: dict[str, Scene],
        assets_by_id: dict[str, AssetRef],
    ) -> None:
        for clip in self.clips:
            track = tracks_by_id.get(clip.track_id)
            if track is None:
                raise ValueError("clip references an unknown track")
            if clip.kind not in TRACK_CLIP_KINDS[track.kind]:
                raise ValueError("clip kind is incompatible with track")
            if clip.end_frame > self.canvas.duration_in_frames:
                raise ValueError("clip range exceeds canvas")
            self._validate_clip_scene(clip, scenes_by_id)
            self._validate_clip_asset(clip, assets_by_id)
            if isinstance(clip, TimelineCaptionClip):
                for cue in clip.cues:
                    if cue.from_frame + cue.duration_in_frames > clip.duration_in_frames:
                        raise ValueError("caption cues must stay inside their clip")
            if isinstance(clip, TimelineAudioClip) and (
                clip.fade_in_frames + clip.fade_out_frames > clip.duration_in_frames
            ):
                raise ValueError("audio fades must stay inside their clip")

    @staticmethod
    def _validate_clip_scene(clip: TimelineClip, scenes_by_id: dict[str, Scene]) -> None:
        if clip.scene_id is None:
            return
        scene = scenes_by_id.get(clip.scene_id)
        if scene is None:
            raise ValueError("clip references an unknown scene")
        scene_end = scene.start_frame + scene.duration_in_frames
        if clip.from_frame < scene.start_frame or clip.end_frame > scene_end:
            raise ValueError("clip range must stay inside its scene")

    @staticmethod
    def _validate_clip_asset(clip: TimelineClip, assets_by_id: dict[str, AssetRef]) -> None:
        asset_id = getattr(clip, "asset_id", None)
        if asset_id is None:
            return
        asset = assets_by_id.get(asset_id)
        if asset is None:
            raise ValueError("clip references an unknown asset")
        if asset.kind not in CLIP_ASSET_KINDS[clip.kind]:
            raise ValueError("clip kind is incompatible with asset")
        source_from = getattr(clip, "source_from_frame", 0)
        if (
            asset.duration_in_frames is not None
            and source_from + clip.duration_in_frames > asset.duration_in_frames
        ):
            raise ValueError("clip range exceeds source asset duration")

    def _validate_track_membership(self, tracks_by_id: dict[str, TimelineTrack]) -> None:
        assigned: dict[str, set[str]] = {track_id: set() for track_id in tracks_by_id}
        for clip in self.clips:
            assigned[clip.track_id].add(clip.clip_id)
        for track in self.tracks:
            if len(track.clip_ids) != len(set(track.clip_ids)):
                raise ValueError("track clip IDs must be unique")
            if set(track.clip_ids) != assigned[track.track_id]:
                raise ValueError("track clip IDs must match assigned clips")

    def _validate_main_video_layout(self) -> None:
        for track in self.tracks:
            if track.kind != "main_video":
                continue
            ranges = sorted(
                (clip.from_frame, clip.end_frame)
                for clip in self.clips
                if clip.track_id == track.track_id
            )
            for (_, previous_end), (next_start, _) in pairwise(ranges):
                if next_start < previous_end:
                    raise ValueError("main video clips must not overlap")


#: A plain union rather than a tagged one: the two integer ``schema_version``
#: constants already make it unambiguous, and an OpenAPI discriminator makes the
#: generated TypeScript declare the tag as the *string* ``"1"`` instead of the
#: integer this API actually sends.
EditDocument: TypeAlias = EditDocumentV1 | EditDocumentV2


class DocumentRevisionConflictBody(StrictModel):
    """Typed 409 body carrying the latest document so a client can reconcile."""

    code: Literal["document_revision_conflict"] = "document_revision_conflict"
    latest: EditDocument
