"""Strict contracts for validated project assets available to the timeline.

The public :class:`EditorAsset` projection is what a browser may ever see: it
carries identity and playback metadata only. The artifact locator lives on the
server-only :class:`EditorAssetRecord`, is always a bounded relative path, and
never reaches a persisted document, a URL, or a response body.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, Field

from thoth_control_plane.domain.edit_document_v2 import (
    AssetKind,
    AssetRef,
    Fps,
    PositiveInt,
    ValidationState,
)
from thoth_control_plane.domain.edit_documents import Frame
from thoth_control_plane.domain.models import Checksum, OpaqueId, ProjectId, StrictModel

#: Hard ceiling on one asset page, mirroring the Prompt Lab history limit.
ASSET_PAGE_LIMIT_MAX = 50


def _reject_traversal(value: str) -> str:
    if ".." in value:
        raise ValueError("artifact location must not traverse")
    return value


#: A server-resolvable relative path. The pattern already rejects a leading
#: separator, a backslash, and any colon, so an absolute path, a drive path,
#: and a URL-like value cannot validate.
RelativeArtifactLocation = Annotated[
    str,
    Field(min_length=1, max_length=512, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$"),
    AfterValidator(_reject_traversal),
]

SafeMediaType = Annotated[str, Field(pattern=r"^[a-z]+/[a-z0-9.+-]{1,64}$")]
Provenance = Annotated[str, Field(min_length=1, max_length=200)]


class EditorAsset(StrictModel):
    """Locator-free projection of one validated project asset."""

    asset_id: OpaqueId
    project_id: ProjectId
    kind: AssetKind
    media_type: SafeMediaType
    duration_in_frames: Frame | None = None
    width: PositiveInt | None = None
    height: PositiveInt | None = None
    fps: Fps | None = None
    has_audio: bool
    validation_state: ValidationState
    checksum: Checksum | None = None

    def to_asset_ref(self) -> AssetRef:
        """Return the document-embeddable reference for this asset."""
        return AssetRef(
            asset_id=self.asset_id,
            project_id=self.project_id,
            kind=self.kind,
            duration_in_frames=self.duration_in_frames,
            width=self.width,
            height=self.height,
            fps=self.fps,
            has_audio=self.has_audio,
            validation_state=self.validation_state,
            checksum=self.checksum,
        )


class EditorAssetPage(StrictModel):
    """One bounded page of ready assets plus an opaque continuation token."""

    assets: Annotated[tuple[EditorAsset, ...], Field(max_length=ASSET_PAGE_LIMIT_MAX)] = ()
    next_cursor: str | None = None


class EditorAssetRecord(StrictModel):
    """Server-only asset view: the public projection plus its artifact locator."""

    asset: EditorAsset
    artifact_location: RelativeArtifactLocation
    provenance: Provenance
