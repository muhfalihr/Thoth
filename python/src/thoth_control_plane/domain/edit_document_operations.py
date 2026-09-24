"""Pure, typed operations for immutable Creator Studio edit documents."""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field, model_validator

from thoth_control_plane.domain.edit_document_v2 import (
    AssetRef,
    EditDocument,
    EditDocumentV2,
)
from thoth_control_plane.domain.edit_documents import BodyText, Frame, Ownership
from thoth_control_plane.domain.models import OpaqueId, StrictModel
from thoth_control_plane.domain.timeline_operations import (
    TimelineOperation,
    apply_timeline_operation,
    carry_scene_clips,
)


class ReplaceText(StrictModel):
    kind: Literal["replace_text"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    field: Literal["heading", "body"]
    value: BodyText


class SetOwnership(StrictModel):
    kind: Literal["set_ownership"]
    operation_id: OpaqueId
    clip_id: OpaqueId
    ownership: Ownership


class SetSceneDuration(StrictModel):
    kind: Literal["set_scene_duration"]
    operation_id: OpaqueId
    scene_id: OpaqueId
    duration_in_frames: Frame


#: Operations that predate multi-track documents and apply to either version.
SceneOperation: TypeAlias = ReplaceText | SetOwnership | SetSceneDuration

EditDocumentOperation: TypeAlias = Annotated[
    ReplaceText | SetOwnership | SetSceneDuration | TimelineOperation,
    Field(discriminator="kind"),
]


class EditDocumentPatch(StrictModel):
    base_revision: Annotated[int, Field(gt=0)]
    operations: Annotated[list[EditDocumentOperation], Field(min_length=1)]

    @model_validator(mode="after")
    def require_unique_operation_ids(self) -> EditDocumentPatch:
        operation_ids = [operation.operation_id for operation in self.operations]
        if len(operation_ids) != len(set(operation_ids)):
            raise ValueError("duplicate operation IDs are not allowed")
        return self


def apply_edit_operations(
    document: EditDocument,
    operations: list[EditDocumentOperation],
    *,
    resolved_assets: dict[str, AssetRef] | None = None,
) -> EditDocument:
    """Apply ordered operations to a copy and return a freshly validated document.

    The batch is atomic: the caller's ``document`` is never mutated, and a
    rejection anywhere in the batch discards every earlier operation. Only
    ``add_clip_from_asset`` consumes ``resolved_assets``, the project-scoped
    safe asset projection supplied by the repository.
    """
    result = document.model_copy(deep=True)

    for operation in operations:
        if isinstance(operation, ReplaceText | SetOwnership | SetSceneDuration):
            _apply_scene_operation(result, operation)
        elif isinstance(result, EditDocumentV2):
            apply_timeline_operation(result, operation, resolved_assets or {})
        else:
            raise ValueError("operation requires a version 2 document")

    return type(result).model_validate(result.model_dump())


def _apply_scene_operation(document: EditDocument, operation: SceneOperation) -> None:
    if isinstance(operation, ReplaceText):
        clip = _find_clip(document, operation.clip_id)
        setattr(clip, operation.field, operation.value)
        clip.ownership = "user_edited"
    elif isinstance(operation, SetOwnership):
        _find_clip(document, operation.clip_id).ownership = operation.ownership
    else:
        _set_scene_duration(document, operation)


def _find_clip(document: EditDocument, clip_id: str):
    for clip in document.clips:
        if clip.clip_id == clip_id:
            return clip
    raise ValueError("operation references an unknown clip")


def _start_frame_field(document: EditDocument) -> str:
    return "from_frame" if isinstance(document, EditDocumentV2) else "start_frame"


def _set_scene_duration(document: EditDocument, operation: SetSceneDuration) -> None:
    if not any(scene.scene_id == operation.scene_id for scene in document.scenes):
        raise ValueError("operation references an unknown scene")

    start_field = _start_frame_field(document)
    previous_starts = {scene.scene_id: scene.start_frame for scene in document.scenes}
    start_frame = 0
    for scene in document.scenes:
        if scene.scene_id == operation.scene_id:
            scene.duration_in_frames = operation.duration_in_frames
        scene.start_frame = start_frame
        clip = _find_clip(document, scene.clip_ids[0])
        setattr(clip, start_field, start_frame)
        clip.duration_in_frames = scene.duration_in_frames
        start_frame += scene.duration_in_frames
    if isinstance(document, EditDocumentV2):
        # The scene's own clip was laid out above; its other clips keep their offsets.
        carry_scene_clips(
            document, previous_starts, frozenset(scene.clip_ids[0] for scene in document.scenes)
        )

    # A version 2 canvas also has to hold every clip outside the scene strip.
    document.canvas.duration_in_frames = max(
        start_frame,
        max(
            (getattr(clip, start_field) + clip.duration_in_frames for clip in document.clips),
            default=0,
        ),
    )
