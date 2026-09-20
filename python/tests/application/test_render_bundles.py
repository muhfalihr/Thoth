"""Tests for immutable, revision-exact render bundles and asset staging."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from tests.domain.edit_document_v2_fixtures import document_v2_payload
from tests.domain.test_edit_documents import valid_document
from thoth_control_plane.application.render_bundles import (
    BuildRenderBundleRequest,
    RenderBundleInvalid,
    RenderBundleV1,
    RenderPresetSettings,
    build_render_bundle,
)
from thoth_control_plane.application.render_job_ports import (
    ArtifactUnavailable,
    JobWorkspace,
    StagedAsset,
)
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1
from thoth_control_plane.domain.editor_assets import EditorAsset, EditorAssetRecord

CHECKSUM = "sha256:" + "a" * 64
LOCATOR = "project_001/assets/asset_main.mp4"
REVISION = 3


def document(**overrides: Any) -> EditDocumentV2:
    payload = deepcopy(document_v2_payload())
    payload["revision"] = REVISION
    payload.update(overrides)
    return EditDocumentV2.model_validate(payload)


def record(asset_id: str = "asset_main", **overrides: Any) -> EditorAssetRecord:
    values: dict[str, Any] = {
        "asset_id": asset_id,
        "project_id": "project_001",
        "kind": "video",
        "media_type": "video/mp4",
        "duration_in_frames": 900,
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
        "has_audio": True,
        "validation_state": "ready",
        "checksum": CHECKSUM,
    }
    values.update(overrides)
    return EditorAssetRecord(
        asset=EditorAsset.model_validate(values),
        artifact_location=LOCATOR,
        provenance="operator_upload",
    )


class Documents:
    def __init__(self, revisions: dict[int, Any] | None = None) -> None:
        self.revisions = {REVISION: document()} if revisions is None else revisions
        self.calls: list[dict[str, Any]] = []

    async def get_revision(self, *, project_id: str, document_id: str, revision: int) -> Any | None:
        self.calls.append(
            {"project_id": project_id, "document_id": document_id, "revision": revision}
        )
        return self.revisions.get(revision)

    async def get_latest(self, *, project_id: str, document_id: str) -> Any:
        raise AssertionError("a render bundle must never read the latest revision")


class Assets:
    def __init__(self, records: tuple[EditorAssetRecord, ...] = (record(),)) -> None:
        self.records = records
        self.calls: list[tuple[str, tuple[str, ...]]] = []

    async def get_ready_records(
        self, *, project_id: str, asset_ids: tuple[str, ...]
    ) -> tuple[EditorAssetRecord, ...]:
        self.calls.append((project_id, asset_ids))
        wanted = set(asset_ids)
        return tuple(item for item in self.records if item.asset.asset_id in wanted)


class Artifacts:
    def __init__(self) -> None:
        self.staged: list[dict[str, Any]] = []
        self.bundles: list[bytes] = []
        self.prepared: list[str] = []

    def prepare(self, render_job_id: str) -> JobWorkspace:
        self.prepared.append(render_job_id)
        return JobWorkspace(render_job_id=render_job_id)

    def resolve_source(self, relative_location: str) -> Path:
        return Path("/srv/artifacts") / relative_location

    def stage_asset(
        self,
        workspace: JobWorkspace,
        *,
        asset_id: str,
        source: Path,
        expected_checksum: str,
        max_bytes: int,
    ) -> StagedAsset:
        self.staged.append(
            {
                "render_job_id": workspace.render_job_id,
                "asset_id": asset_id,
                "source": source,
                "expected_checksum": expected_checksum,
                "max_bytes": max_bytes,
            }
        )
        return StagedAsset(
            asset_id=asset_id,
            relative_name=f"assets/{asset_id}.mp4",
            size_bytes=2048,
            checksum=expected_checksum,
        )

    def write_bundle(self, workspace: JobWorkspace, bundle_json: bytes) -> str:
        self.bundles.append(bundle_json)
        return workspace.bundle_name


def settings() -> RenderPresetSettings:
    return RenderPresetSettings(
        preset_id="standard_vertical_mp4_v1",
        renderer_version="remotion-4.0.523",
        max_asset_bytes=512 * 1024 * 1024,
    )


def build_request(**overrides: Any) -> BuildRenderBundleRequest:
    values: dict[str, Any] = {
        "render_job_id": "rj_1",
        "project_id": "project_001",
        "document_id": "edoc_abc123",
        "document_revision": REVISION,
        "dispatch_id": "dispatch_1",
    }
    values.update(overrides)
    return BuildRenderBundleRequest.model_validate(values)


async def build(
    *,
    documents: Documents | None = None,
    assets: Assets | None = None,
    artifacts: Artifacts | None = None,
    request: BuildRenderBundleRequest | None = None,
) -> tuple[RenderBundleV1, Documents, Assets, Artifacts]:
    documents = documents or Documents()
    assets = assets or Assets()
    artifacts = artifacts or Artifacts()
    bundle = await build_render_bundle(
        request or build_request(),
        documents=documents,
        assets=assets,
        artifacts=artifacts,
        settings=settings(),
    )
    return bundle, documents, assets, artifacts


# --- exact revision -------------------------------------------------------


@pytest.mark.asyncio
async def test_bundle_reads_the_requested_saved_revision_only() -> None:
    bundle, documents, _, _ = await build()

    assert documents.calls == [
        {"project_id": "project_001", "document_id": "edoc_abc123", "revision": REVISION}
    ]
    assert bundle.document_revision == REVISION
    assert bundle.document.revision == REVISION


@pytest.mark.asyncio
async def test_a_missing_revision_is_refused() -> None:
    with pytest.raises(RenderBundleInvalid):
        await build(documents=Documents(revisions={}))


@pytest.mark.asyncio
async def test_a_revision_from_another_project_is_refused() -> None:
    with pytest.raises(RenderBundleInvalid):
        await build(request=build_request(project_id="project_002"))


@pytest.mark.asyncio
async def test_a_row_that_does_not_carry_the_requested_revision_is_refused() -> None:
    mismatched = Documents(revisions={REVISION: document(revision=REVISION + 1)})

    with pytest.raises(RenderBundleInvalid):
        await build(documents=mismatched)


@pytest.mark.asyncio
async def test_a_legacy_schema_v1_revision_is_refused() -> None:
    payload = valid_document()
    payload["revision"] = REVISION
    legacy = EditDocumentV1.model_validate(payload)

    with pytest.raises(RenderBundleInvalid):
        await build(documents=Documents(revisions={REVISION: legacy}))


# --- assets ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_referenced_assets_are_requested_once_and_staged_as_copies() -> None:
    bundle, _, assets, artifacts = await build()

    assert assets.calls == [("project_001", ("asset_main",))]
    assert artifacts.prepared == ["rj_1"]
    assert [item["asset_id"] for item in artifacts.staged] == ["asset_main"]
    assert artifacts.staged[0]["expected_checksum"] == CHECKSUM
    assert artifacts.staged[0]["max_bytes"] == settings().max_asset_bytes
    assert [asset.relative_name for asset in bundle.assets] == ["assets/asset_main.mp4"]
    assert bundle.assets[0].checksum == CHECKSUM


@pytest.mark.asyncio
async def test_one_asset_used_by_several_clips_is_staged_once() -> None:
    payload = deepcopy(document_v2_payload())
    payload["revision"] = REVISION
    payload["tracks"][1]["clip_ids"] = ["clip_broll"]
    payload["clips"].append(
        {
            "kind": "video",
            "clip_id": "clip_broll",
            "track_id": "track_b_roll",
            "scene_id": None,
            "from_frame": 0,
            "duration_in_frames": 120,
            "ownership": "ai_managed",
            "hidden": False,
            "locked": False,
            "asset_id": "asset_main",
            "source_from_frame": 0,
            "fit": "cover",
            "crop": None,
            "position": None,
        }
    )
    reused = EditDocumentV2.model_validate(payload)

    bundle, _, assets, artifacts = await build(documents=Documents(revisions={REVISION: reused}))

    assert assets.calls == [("project_001", ("asset_main",))]
    assert [item["asset_id"] for item in artifacts.staged] == ["asset_main"]
    assert len(bundle.assets) == 1


@pytest.mark.asyncio
async def test_an_asset_that_is_not_ready_stops_the_bundle() -> None:
    with pytest.raises(ArtifactUnavailable):
        await build(assets=Assets(records=()))


@pytest.mark.asyncio
async def test_a_document_without_assets_stages_nothing() -> None:
    payload = deepcopy(document_v2_payload())
    payload["revision"] = REVISION
    payload["clips"] = [clip for clip in payload["clips"] if clip["kind"] != "video"]
    payload["tracks"][0]["clip_ids"] = []
    payload["asset_refs"] = []
    text_only = EditDocumentV2.model_validate(payload)

    bundle, _, assets, artifacts = await build(documents=Documents(revisions={REVISION: text_only}))

    assert assets.calls == []
    assert artifacts.staged == []
    assert bundle.assets == ()


# --- bundle content -------------------------------------------------------


@pytest.mark.asyncio
async def test_bundle_carries_the_server_owned_render_contract() -> None:
    bundle, _, _, artifacts = await build()

    assert bundle.bundle_version == 1
    assert bundle.render_job_id == "rj_1"
    assert bundle.dispatch_id == "dispatch_1"
    assert bundle.template_id == "vertical_text_story"
    assert bundle.template_version == 1
    assert bundle.preset_id == "standard_vertical_mp4_v1"
    assert bundle.renderer_version == "remotion-4.0.523"
    assert bundle.composition_id == "advanced_timeline_v1"
    assert (bundle.width, bundle.height, bundle.fps) == (1080, 1920, 30)
    assert bundle.duration_in_frames == 300
    assert artifacts.bundles and json.loads(artifacts.bundles[0])["bundle_version"] == 1


@pytest.mark.asyncio
async def test_bundle_json_never_carries_a_locator_path_or_renderer_flag() -> None:
    _, _, _, artifacts = await build()

    written = artifacts.bundles[0].decode("utf-8")
    for forbidden in (
        LOCATOR,
        "artifact_location",
        "/srv/artifacts",
        "C:\\",
        "postgresql://",
        "credential",
        "latest",
        "codec",
        "--",
    ):
        assert forbidden not in written


@pytest.mark.asyncio
async def test_bundle_serialization_is_stable_for_the_same_revision() -> None:
    first, _, _, _ = await build()
    second, _, _, _ = await build()

    assert first.model_dump_json() == second.model_dump_json()


def test_bundle_rejects_any_field_the_contract_does_not_define() -> None:
    with pytest.raises(Exception):  # noqa: B017 - pydantic raises ValidationError
        RenderBundleV1.model_validate(
            {
                "bundle_version": 1,
                "render_job_id": "rj_1",
                "project_id": "project_001",
                "document_id": "edoc_abc123",
                "document_revision": REVISION,
                "dispatch_id": "dispatch_1",
                "document": document().model_dump(mode="json"),
                "template_id": "vertical_text_story",
                "template_version": 1,
                "preset_id": "standard_vertical_mp4_v1",
                "renderer_version": "remotion-4.0.523",
                "composition_id": "advanced_timeline_v1",
                "width": 1080,
                "height": 1920,
                "fps": 30,
                "duration_in_frames": 300,
                "assets": [],
                "renderer_flags": ["--headless"],
            }
        )
