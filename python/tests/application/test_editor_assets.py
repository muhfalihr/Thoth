"""Tests for project-scoped editor asset orchestration."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from thoth_control_plane.application.editor_asset_ports import EditorAssetPersistenceError
from thoth_control_plane.application.editor_assets import (
    EditorAssetNotFound,
    EditorAssetService,
    EditorAssetsUnavailable,
    ListEditorAssetsRequest,
)
from thoth_control_plane.domain.editor_assets import (
    ASSET_PAGE_LIMIT_MAX,
    EditorAsset,
    EditorAssetPage,
    EditorAssetRecord,
)


def asset(asset_id: str = "asset_main", **overrides: object) -> EditorAsset:
    payload: dict[str, object] = {
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
        "checksum": "sha256:" + "a" * 64,
    }
    payload.update(overrides)
    return EditorAsset.model_validate(payload)


def record(**overrides: object) -> EditorAssetRecord:
    return EditorAssetRecord(
        asset=asset(**overrides),
        artifact_location="project_001/asset_main.mp4",
        provenance="operator_upload",
    )


class MemoryEditorAssetRepository:
    def __init__(
        self,
        *,
        page: EditorAssetPage | None = None,
        records: dict[tuple[str, str], EditorAssetRecord] | None = None,
    ) -> None:
        self.page = page or EditorAssetPage()
        self.records = records or {}
        self.calls: list[tuple[str, int, str | None]] = []

    async def list_ready(
        self, *, project_id: str, limit: int, cursor: str | None
    ) -> EditorAssetPage:
        self.calls.append((project_id, limit, cursor))
        if project_id != "project_001":
            return EditorAssetPage()
        return self.page

    async def get_ready_record(self, *, project_id: str, asset_id: str) -> EditorAssetRecord | None:
        return self.records.get((project_id, asset_id))


class BrokenEditorAssetRepository(MemoryEditorAssetRepository):
    async def list_ready(self, **_: object) -> EditorAssetPage:
        raise EditorAssetPersistenceError()

    async def get_ready_record(self, **_: object) -> EditorAssetRecord | None:
        raise EditorAssetPersistenceError()


def service(repository: MemoryEditorAssetRepository | None) -> EditorAssetService:
    return EditorAssetService(repository)


@pytest.mark.asyncio
async def test_list_returns_an_empty_page_for_a_project_without_assets() -> None:
    result = await service(MemoryEditorAssetRepository()).list_ready(
        "project_001", ListEditorAssetsRequest()
    )

    assert result.assets == ()
    assert result.next_cursor is None


@pytest.mark.asyncio
async def test_list_returns_only_ready_locator_free_projections() -> None:
    repository = MemoryEditorAssetRepository(
        page=EditorAssetPage(assets=(asset(),), next_cursor="Y3Vyc29y")
    )

    result = await service(repository).list_ready("project_001", ListEditorAssetsRequest())

    assert [item.asset_id for item in result.assets] == ["asset_main"]
    assert all(item.validation_state == "ready" for item in result.assets)
    assert "artifact_location" not in result.assets[0].model_dump()
    assert result.next_cursor == "Y3Vyc29y"


@pytest.mark.asyncio
async def test_list_replays_a_cursor_and_default_limit_to_the_repository() -> None:
    repository = MemoryEditorAssetRepository()

    await service(repository).list_ready(
        "project_001", ListEditorAssetsRequest(limit=10, cursor="Y3Vyc29y")
    )

    assert repository.calls == [("project_001", 10, "Y3Vyc29y")]


@pytest.mark.asyncio
async def test_list_isolates_another_project_without_leaking_assets() -> None:
    repository = MemoryEditorAssetRepository(page=EditorAssetPage(assets=(asset(),)))

    result = await service(repository).list_ready("project_999", ListEditorAssetsRequest())

    assert result.assets == ()


@pytest.mark.parametrize("limit", [0, -1, ASSET_PAGE_LIMIT_MAX + 1, "10", 10.0])
def test_list_request_rejects_an_out_of_range_or_loose_limit(limit: object) -> None:
    with pytest.raises(ValidationError):
        ListEditorAssetsRequest.model_validate({"limit": limit})


def test_list_request_rejects_unknown_fields_and_an_unsafe_cursor() -> None:
    with pytest.raises(ValidationError):
        ListEditorAssetsRequest.model_validate({"limit": 10, "project_id": "project_002"})
    with pytest.raises(ValidationError):
        ListEditorAssetsRequest.model_validate({"cursor": "../../etc/passwd"})


@pytest.mark.asyncio
async def test_get_ready_record_returns_the_server_side_record() -> None:
    repository = MemoryEditorAssetRepository(records={("project_001", "asset_main"): record()})

    result = await service(repository).get_ready_record("project_001", "asset_main")

    assert result.artifact_location == "project_001/asset_main.mp4"
    assert result.asset.asset_id == "asset_main"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("project_id", "asset_id"),
    [("project_001", "asset_missing"), ("project_999", "asset_main")],
)
async def test_get_ready_record_hides_an_unknown_or_cross_project_asset(
    project_id: str, asset_id: str
) -> None:
    repository = MemoryEditorAssetRepository(records={("project_001", "asset_main"): record()})

    with pytest.raises(EditorAssetNotFound):
        await service(repository).get_ready_record(project_id, asset_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["pending", "rejected"])
async def test_get_ready_record_never_serves_an_unvalidated_asset(state: str) -> None:
    repository = MemoryEditorAssetRepository(
        records={("project_001", "asset_main"): record(validation_state=state)}
    )

    with pytest.raises(EditorAssetNotFound):
        await service(repository).get_ready_record("project_001", "asset_main")


@pytest.mark.asyncio
async def test_repository_failures_surface_as_a_safe_unavailable_error() -> None:
    broken = service(BrokenEditorAssetRepository())

    with pytest.raises(EditorAssetsUnavailable) as listing:
        await broken.list_ready("project_001", ListEditorAssetsRequest())
    with pytest.raises(EditorAssetsUnavailable) as lookup:
        await broken.get_ready_record("project_001", "asset_main")

    for error in (listing, lookup):
        assert str(error.value) == "editor assets unavailable"


@pytest.mark.asyncio
async def test_unconfigured_asset_persistence_is_reported_as_unavailable() -> None:
    with pytest.raises(EditorAssetsUnavailable):
        await service(None).list_ready("project_001", ListEditorAssetsRequest())
    with pytest.raises(EditorAssetsUnavailable):
        await service(None).get_ready_record("project_001", "asset_main")
