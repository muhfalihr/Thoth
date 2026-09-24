"""Pure conversion from a sanitized Content Set into a v1 edit document."""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Literal
from uuid import uuid4

from pydantic import Field, TypeAdapter, field_validator

from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    EditDocumentUpgradeConflict,
)
from thoth_control_plane.domain.edit_document_operations import EditDocumentPatch
from thoth_control_plane.domain.edit_document_v2 import EditDocument
from thoth_control_plane.domain.edit_documents import (
    Canvas,
    EditDocumentV1,
    Scene,
    TemplateRef,
    TextClip,
    Track,
)
from thoth_control_plane.domain.models import OpaqueId, ProjectId, StrictModel

if TYPE_CHECKING:
    from thoth_control_plane.application.ports import EditDocumentRepository

TEMPLATE_ID = "vertical_text_story"
TEMPLATE_VERSION = 1
SCENE_DURATION_FRAMES = 150


class EditDocumentNotFound(Exception):
    """The requested immutable document does not exist for this project."""


class EditorUnavailable(Exception):
    """The optional editor persistence is not configured or reachable."""


#: Opaque, caller-supplied replay key. Bounded and free of whitespace so it can
#: never carry a path, a newline, or an unbounded blob into the store.
IDEMPOTENCY_KEY_ADAPTER: TypeAdapter[str] = TypeAdapter(
    Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")]
)


class UpgradeTimelineRequest(StrictModel):
    """An explicit, user-initiated upgrade of one document to schema version 2."""

    base_revision: Annotated[int, Field(gt=0)]


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
    project_id: ProjectId, request: ContentSetImportRequest, document_id: OpaqueId
) -> EditDocumentV1:
    """Build the deterministic, text-only schema-v1 document without side effects."""

    clips: list[TextClip] = [
        text_clip(
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
            text_clip(
                index=len(clips) + 1,
                role="source",
                heading=footage.title,
                body=footage.platform or "",
            )
        )
    return document_from_text_clips(project_id, document_id, clips)


def document_from_text_clips(
    project_id: ProjectId, document_id: OpaqueId, clips: list[TextClip]
) -> EditDocumentV1:
    """Wrap consecutive one-per-scene text clips in a revision-1 v1 document."""
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
    return EditDocumentV1(
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


def text_clip(*, index: int, role: Literal["title", "source"], heading: str, body: str) -> TextClip:
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


class EditDocumentService:
    """Application service for importing and retrieving immutable v1 documents."""

    def __init__(self, repository: EditDocumentRepository | None) -> None:
        self._repository = repository

    async def import_content_set(
        self, project_id: ProjectId, request: ContentSetImportRequest
    ) -> EditDocumentV1:
        if self._repository is None:
            raise EditorUnavailable()
        document = build_edit_document(project_id, request, f"edoc_{uuid4().hex}")
        try:
            await self._repository.insert_revision(document)
        except Exception as error:
            raise EditorUnavailable() from error
        return document

    async def get_latest(self, project_id: ProjectId, document_id: OpaqueId) -> EditDocument:
        if self._repository is None:
            raise EditorUnavailable()
        try:
            document = await self._repository.get_latest(
                project_id=project_id, document_id=document_id
            )
        except Exception as error:
            raise EditorUnavailable() from error
        if document is None:
            raise EditDocumentNotFound()
        return document

    async def apply_patch(
        self, project_id: ProjectId, document_id: OpaqueId, patch: EditDocumentPatch
    ) -> EditDocument:
        await self.get_latest(project_id, document_id)
        assert self._repository is not None
        try:
            return await self._repository.apply_operations(
                project_id, document_id, patch.base_revision, patch.operations
            )
        except EditDocumentRevisionConflict:
            raise
        except Exception as error:
            raise EditorUnavailable() from error

    async def upgrade_to_timeline(
        self,
        project_id: ProjectId,
        document_id: OpaqueId,
        request: UpgradeTimelineRequest,
        idempotency_key: str,
    ) -> EditDocument:
        """Upgrade one document to schema version 2, replaying a known key safely.

        Transactionality, revision assignment, and idempotency all belong to the
        repository; this service only validates the request and the ownership of
        the document before delegating.
        """
        IDEMPOTENCY_KEY_ADAPTER.validate_python(idempotency_key)
        await self.get_latest(project_id, document_id)
        assert self._repository is not None
        try:
            return await self._repository.upgrade_to_timeline(
                project_id=project_id,
                document_id=document_id,
                base_revision=request.base_revision,
                idempotency_key=idempotency_key,
            )
        except (EditDocumentRevisionConflict, EditDocumentUpgradeConflict):
            raise
        except Exception as error:
            raise EditorUnavailable() from error
