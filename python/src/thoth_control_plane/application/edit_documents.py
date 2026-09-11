"""Pure conversion from a sanitized Content Set into a v1 edit document."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, field_validator

from thoth_control_plane.domain.edit_documents import (
    Canvas,
    EditDocument,
    Scene,
    TemplateRef,
    TextClip,
    Track,
)
from thoth_control_plane.domain.models import OpaqueId, StrictModel

TEMPLATE_ID = "vertical_text_story"
TEMPLATE_VERSION = 1
SCENE_DURATION_FRAMES = 150

OptionalTitle = Annotated[str | None, Field(max_length=300)]
OptionalDescription = Annotated[str | None, Field(max_length=2_000)]
OptionalPlatform = Annotated[str | None, Field(max_length=64, pattern=r"^[a-z][a-z0-9_-]{0,63}$")]


def _trim_optional(value: object) -> object:
    return value.strip() or None if isinstance(value, str) else value


def _normalize_platform(value: object) -> object:
    return value.strip().lower() or None if isinstance(value, str) else value


class MainImport(StrictModel):
    title: OptionalTitle = None
    description: OptionalDescription = None

    _trim_fields = field_validator("title", "description", mode="before")(_trim_optional)


class FootageImport(StrictModel):
    title: OptionalTitle = None
    platform: OptionalPlatform = None

    _trim_title = field_validator("title", mode="before")(_trim_optional)
    _normalize_platform = field_validator("platform", mode="before")(_normalize_platform)


class ContentSetImportRequest(StrictModel):
    main: MainImport
    footage: Annotated[list[FootageImport], Field(max_length=100)]


def build_edit_document(
    project_id: OpaqueId, request: ContentSetImportRequest, document_id: OpaqueId
) -> EditDocument:
    """Build the deterministic, text-only revision-one document without side effects."""

    clips: list[TextClip] = [
        _text_clip(
            index=1,
            role="title",
            heading=request.main.title or "Untitled video",
            body=request.main.description or "",
        )
    ]
    for footage in (item for item in request.footage if item.title):
        if len(clips) == 4:
            break
        clips.append(
            _text_clip(
                index=len(clips) + 1,
                role="source",
                heading=footage.title,
                body=footage.platform or "",
            )
        )
    scenes = [
        Scene(
            scene_id=f"scene_{index:03d}",
            role="title" if index == 1 else "source",
            start_frame=(index - 1) * SCENE_DURATION_FRAMES,
            duration_in_frames=SCENE_DURATION_FRAMES,
            clip_ids=[clip.clip_id],
        )
        for index, clip in enumerate(clips, start=1)
    ]
    return EditDocument(
        schema_version=1,
        document_id=document_id,
        project_id=project_id,
        revision=1,
        template=TemplateRef(template_id=TEMPLATE_ID, version=TEMPLATE_VERSION),
        canvas=Canvas(
            width=1080,
            height=1920,
            fps=30,
            duration_in_frames=len(scenes) * SCENE_DURATION_FRAMES,
        ),
        scenes=scenes,
        tracks=[
            Track(track_id="track_visual", kind="visual", clip_ids=[clip.clip_id for clip in clips])
        ],
        clips=clips,
    )


def _text_clip(
    *, index: int, role: Literal["title", "source"], heading: str, body: str
) -> TextClip:
    return TextClip(
        kind="text",
        clip_id=f"clip_{index:03d}",
        scene_id=f"scene_{index:03d}",
        track_id="track_visual",
        start_frame=(index - 1) * SCENE_DURATION_FRAMES,
        duration_in_frames=SCENE_DURATION_FRAMES,
        heading=heading,
        body=body,
        style_slot=role,
        ownership="ai_managed",
    )
