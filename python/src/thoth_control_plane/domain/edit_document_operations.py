"""Pure, typed operations for immutable Creator Studio edit documents."""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field, model_validator

from thoth_control_plane.domain.edit_documents import BodyText, EditDocument, Frame, Ownership
from thoth_control_plane.domain.models import OpaqueId, StrictModel


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


EditDocumentOperation: TypeAlias = Annotated[
    ReplaceText | SetOwnership | SetSceneDuration, Field(discriminator="kind")
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
    document: EditDocument, operations: list[EditDocumentOperation]
) -> EditDocument:
    """Apply ordered operations to a copy and return a freshly validated document."""
    result = document.model_copy(deep=True)

    for operation in operations:
        if isinstance(operation, ReplaceText):
            clip = _find_clip(result, operation.clip_id)
            setattr(clip, operation.field, operation.value)
            clip.ownership = "user_edited"
        elif isinstance(operation, SetOwnership):
            _find_clip(result, operation.clip_id).ownership = operation.ownership
        else:
            _set_scene_duration(result, operation)

    return EditDocument.model_validate(result.model_dump())


def _find_clip(document: EditDocument, clip_id: str):
    for clip in document.clips:
        if clip.clip_id == clip_id:
            return clip
    raise ValueError("operation references an unknown clip")


def _set_scene_duration(document: EditDocument, operation: SetSceneDuration) -> None:
    if not any(scene.scene_id == operation.scene_id for scene in document.scenes):
        raise ValueError("operation references an unknown scene")

    start_frame = 0
    for scene in document.scenes:
        if scene.scene_id == operation.scene_id:
            scene.duration_in_frames = operation.duration_in_frames
        scene.start_frame = start_frame
        clip = _find_clip(document, scene.clip_ids[0])
        clip.start_frame = start_frame
        clip.duration_in_frames = scene.duration_in_frames
        start_frame += scene.duration_in_frames
    document.canvas.duration_in_frames = start_frame
