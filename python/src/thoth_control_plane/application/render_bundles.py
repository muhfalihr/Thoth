"""The immutable input one render job is allowed to see.

A bundle binds exactly one saved document revision to one server-owned preset.
Everything the renderer may act on is decided here: the composition, the frame
geometry, and the staged asset names. Nothing a browser sent can widen it, and
nothing that leaves this module carries a locator, an absolute path, a
credential, or a renderer flag.
"""

from __future__ import annotations

from typing import Literal, Protocol

from pydantic import Field

from thoth_control_plane.application.render_job_ports import (
    ArtifactRoot,
    ArtifactUnavailable,
)
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.editor_assets import EditorAssetRecord
from thoth_control_plane.domain.models import Checksum, OpaqueId, ProjectId, StrictModel

#: The one composition both the browser preview and the server render mount.
TRUSTED_COMPOSITION_ID = "advanced_timeline_v1"

#: The one template a render is trusted to draw, matching the D1 document.
TRUSTED_TEMPLATE_ID = "vertical_text_story"
TRUSTED_TEMPLATE_VERSION = 1

#: Bumped when the shape the renderer reads changes, never per revision.
BUNDLE_VERSION = 1


class RenderBundleInvalid(Exception):
    """The requested revision cannot become a trusted render input."""

    def __init__(self) -> None:
        super().__init__("render bundle invalid")


class RenderPresetSettings(StrictModel):
    """The server-owned render contract; no browser input reaches these."""

    preset_id: Literal["standard_vertical_mp4_v1"]
    renderer_version: str
    max_asset_bytes: int = Field(gt=0)


class BuildRenderBundleRequest(StrictModel):
    """The authorized, already-scoped identity of one bundle build."""

    render_job_id: OpaqueId
    project_id: ProjectId
    document_id: OpaqueId
    document_revision: int = Field(gt=0)
    dispatch_id: OpaqueId


class RenderBundleAsset(StrictModel):
    """One staged copy, addressed by the name it has inside the workspace."""

    asset_id: OpaqueId
    relative_name: str
    size_bytes: int = Field(ge=0)
    checksum: Checksum


class RenderBundleV1(StrictModel):
    """The complete, self-contained input for exactly one render job."""

    bundle_version: Literal[1]
    render_job_id: OpaqueId
    project_id: ProjectId
    document_id: OpaqueId
    document_revision: int = Field(gt=0)
    dispatch_id: OpaqueId
    document: EditDocumentV2
    template_id: Literal["vertical_text_story"]
    template_version: Literal[1]
    preset_id: Literal["standard_vertical_mp4_v1"]
    renderer_version: str
    composition_id: Literal["advanced_timeline_v1"]
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    fps: int = Field(gt=0)
    duration_in_frames: int = Field(gt=0)
    assets: tuple[RenderBundleAsset, ...] = ()


class _Documents(Protocol):
    async def get_revision(
        self, *, project_id: str, document_id: str, revision: int
    ) -> object | None: ...


class _Assets(Protocol):
    async def get_ready_records(
        self, *, project_id: str, asset_ids: tuple[str, ...]
    ) -> tuple[EditorAssetRecord, ...]: ...


def _referenced_asset_ids(document: EditDocumentV2) -> tuple[str, ...]:
    """Collect every asset a clip actually plays, once, in a stable order."""
    used = {clip.asset_id for clip in document.clips if getattr(clip, "asset_id", None)}
    return tuple(sorted(used))


async def build_render_bundle(
    request: BuildRenderBundleRequest,
    *,
    documents: _Documents,
    assets: _Assets,
    artifacts: ArtifactRoot,
    settings: RenderPresetSettings,
) -> RenderBundleV1:
    """Stage one saved revision into a workspace and return its render input."""
    stored = await documents.get_revision(
        project_id=request.project_id,
        document_id=request.document_id,
        revision=request.document_revision,
    )
    if stored is None or not isinstance(stored, EditDocumentV2):
        raise RenderBundleInvalid()

    # Re-run canonical validation on the stored value: a row written by an
    # older build must still satisfy today's contract before it is rendered.
    document = EditDocumentV2.model_validate(stored.model_dump(mode="json"))
    if (
        document.project_id != request.project_id
        or document.document_id != request.document_id
        or document.revision != request.document_revision
    ):
        raise RenderBundleInvalid()
    if (document.template.template_id, document.template.version) != (
        TRUSTED_TEMPLATE_ID,
        TRUSTED_TEMPLATE_VERSION,
    ):
        raise RenderBundleInvalid()

    asset_ids = _referenced_asset_ids(document)
    records = (
        await assets.get_ready_records(project_id=request.project_id, asset_ids=asset_ids)
        if asset_ids
        else ()
    )
    by_id = {record.asset.asset_id: record for record in records}
    if set(by_id) != set(asset_ids):
        raise ArtifactUnavailable()

    workspace = artifacts.prepare(request.render_job_id)
    staged: list[RenderBundleAsset] = []
    for asset_id in asset_ids:
        record = by_id[asset_id]
        if record.asset.checksum is None:
            raise ArtifactUnavailable()
        copied = artifacts.stage_asset(
            workspace,
            asset_id=asset_id,
            source=artifacts.resolve_source(record.artifact_location),
            expected_checksum=record.asset.checksum,
            max_bytes=settings.max_asset_bytes,
        )
        staged.append(
            RenderBundleAsset(
                asset_id=copied.asset_id,
                relative_name=copied.relative_name,
                size_bytes=copied.size_bytes,
                checksum=copied.checksum,
            )
        )

    bundle = RenderBundleV1(
        bundle_version=BUNDLE_VERSION,
        render_job_id=request.render_job_id,
        project_id=request.project_id,
        document_id=request.document_id,
        document_revision=request.document_revision,
        dispatch_id=request.dispatch_id,
        document=document,
        template_id=TRUSTED_TEMPLATE_ID,
        template_version=TRUSTED_TEMPLATE_VERSION,
        preset_id=settings.preset_id,
        renderer_version=settings.renderer_version,
        composition_id=TRUSTED_COMPOSITION_ID,
        width=document.canvas.width,
        height=document.canvas.height,
        fps=document.canvas.fps,
        duration_in_frames=document.canvas.duration_in_frames,
        assets=tuple(staged),
    )
    artifacts.write_bundle(workspace, bundle.model_dump_json().encode("utf-8"))
    return bundle
