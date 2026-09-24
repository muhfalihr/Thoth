"""Open a projected Content Set in Studio: inspect it, create or resume drafts, resolve items."""

from __future__ import annotations

from uuid import uuid4

from thoth_control_plane.application.edit_documents import (
    IDEMPOTENCY_KEY_ADAPTER,
    EditDocumentNotFound,
    EditorUnavailable,
    document_from_text_clips,
    text_clip,
)
from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    StudioImportConflict,
    StudioImportDecisionRejected,
    StudioImportItemNotFound,
    StudioImportItemResolved,
    StudioImportRepository,
    StudioImportSourceMismatch,
)
from thoth_control_plane.domain.edit_document_upgrade import upgrade_edit_document_v1
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.models import OpaqueId, ProjectId
from thoth_control_plane.domain.studio_imports import (
    DRAFT_LIST_LIMIT,
    SCENE_LIMIT,
    CreateStudioImport,
    ResolveStudioImportItem,
    StudioDraft,
    StudioDraftList,
    StudioImportInventory,
    StudioSourceInspection,
    StudioSourceItem,
    StudioSourceProjection,
    inspect_source,
    inventory,
    scene_items,
    source_key,
)

#: Typed outcomes the routes map to responses; anything else means storage failed.
PASSTHROUGH = (
    EditDocumentNotFound,
    EditDocumentRevisionConflict,
    StudioImportConflict,
    StudioImportDecisionRejected,
    StudioImportItemNotFound,
    StudioImportItemResolved,
)


def _heading(item: StudioSourceItem) -> str:
    if item.title:
        return item.title
    if item.role == "main":
        return "Untitled video"
    return f"{item.role.capitalize()} {item.order + 1}"


def build_studio_draft(
    project_id: ProjectId, document_id: OpaqueId, projection: StudioSourceProjection
) -> EditDocumentV2:
    """One text scene per ordered source item, up to the document's scene bound."""
    clips = [
        text_clip(
            index=index,
            role="title" if item.role == "main" else "source",
            heading=_heading(item),
            body=item.text or "",
        )
        for index, item in enumerate(scene_items(projection)[:SCENE_LIMIT], start=1)
    ]
    return upgrade_edit_document_v1(document_from_text_clips(project_id, document_id, clips))


class StudioImportService:
    """Everything is keyed by a server-derived source key; nothing stores a source address."""

    def __init__(self, repository: StudioImportRepository | None) -> None:
        self._repository = repository

    def _store(self) -> StudioImportRepository:
        if self._repository is None:
            raise EditorUnavailable()
        return self._repository

    async def list_drafts(self, project_id: ProjectId, key: str) -> StudioDraftList:
        try:
            drafts = await self._store().list_drafts(
                project_id=project_id, source_key=key, limit=DRAFT_LIST_LIMIT + 1
            )
        except EditorUnavailable:
            raise
        except Exception as error:
            raise EditorUnavailable() from error
        return StudioDraftList(
            source_key=key,
            drafts=drafts[:DRAFT_LIST_LIMIT],
            more_drafts=len(drafts) > DRAFT_LIST_LIMIT,
        )

    async def inspect(
        self, project_id: ProjectId, projection: StudioSourceProjection
    ) -> StudioSourceInspection:
        """Read-only: what would be imported, and which drafts already exist."""
        inspection = inspect_source(project_id, projection)
        listing = await self.list_drafts(project_id, inspection.source_key)
        return inspection.model_copy(
            update={"drafts": listing.drafts, "more_drafts": listing.more_drafts}
        )

    async def create(
        self, project_id: ProjectId, request: CreateStudioImport, idempotency_key: str
    ) -> StudioDraft:
        IDEMPOTENCY_KEY_ADAPTER.validate_python(idempotency_key)
        repository = self._store()
        if source_key(request.source) != request.source_key:
            raise StudioImportSourceMismatch()
        try:
            return await repository.create_draft(
                project_id=project_id,
                source_key=request.source_key,
                idempotency_key=idempotency_key,
                document=build_studio_draft(project_id, f"edoc_{uuid4().hex}", request.source),
                inventory=inventory(request.source),
            )
        except PASSTHROUGH:
            raise
        except Exception as error:
            raise EditorUnavailable() from error

    async def get_inventory(
        self, project_id: ProjectId, document_id: OpaqueId
    ) -> StudioImportInventory:
        try:
            result = await self._store().get_inventory(
                project_id=project_id, document_id=document_id
            )
        except EditorUnavailable:
            raise
        except Exception as error:
            raise EditorUnavailable() from error
        if result is None:
            raise EditDocumentNotFound()
        return result

    async def resolve(
        self,
        project_id: ProjectId,
        document_id: OpaqueId,
        item_id: str,
        request: ResolveStudioImportItem,
    ) -> StudioImportInventory:
        repository = self._store()
        try:
            return await repository.resolve_item(
                project_id=project_id,
                document_id=document_id,
                item_id=item_id,
                base_revision=request.base_revision,
                decision=request.decision,
            )
        except PASSTHROUGH:
            raise
        except Exception as error:
            raise EditorUnavailable() from error
