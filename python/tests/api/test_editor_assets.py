"""Contract tests for the project-scoped editor asset catalog endpoint."""

from __future__ import annotations

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.application.editor_asset_ports import EditorAssetPersistenceError
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.editor_assets import (
    EditorAsset,
    EditorAssetPage,
    EditorAssetRecord,
)

AUTH_HEADERS = {"Authorization": "Bearer test-key"}
ASSETS_URL = "/api/v1/projects/project_001/editor-assets"


def asset(asset_id: str = "asset_main") -> EditorAsset:
    return EditorAsset.model_validate(
        {
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
    )


class MemoryEditorAssetRepository:
    def __init__(self, page: EditorAssetPage | None = None) -> None:
        self.page = page or EditorAssetPage(assets=(asset(),), next_cursor="Y3Vyc29yXzAwMQ==")
        self.calls: list[tuple[str, int, str | None]] = []

    async def list_ready(
        self, *, project_id: str, limit: int, cursor: str | None
    ) -> EditorAssetPage:
        self.calls.append((project_id, limit, cursor))
        if project_id != "project_001":
            return EditorAssetPage()
        return self.page

    async def get_ready_record(self, *, project_id: str, asset_id: str) -> EditorAssetRecord | None:
        return None


class BrokenEditorAssetRepository(MemoryEditorAssetRepository):
    async def list_ready(self, **_: object) -> EditorAssetPage:
        raise EditorAssetPersistenceError()


def assets_app(gateway, repository: MemoryEditorAssetRepository | None = None):
    return create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"),
        gateway,
        None,
        editor_asset_repository=repository or MemoryEditorAssetRepository(),
    )


@pytest.mark.asyncio
async def test_asset_route_returns_a_bounded_locator_free_page(gateway) -> None:
    repository = MemoryEditorAssetRepository()
    transport = httpx.ASGITransport(app=assets_app(gateway, repository))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assets = await client.get(f"{ASSETS_URL}?limit=20", headers=AUTH_HEADERS)

    assert assets.status_code == 200
    assert [item["asset_id"] for item in assets.json()["assets"]] == ["asset_main"]
    assert assets.json()["next_cursor"] == "Y3Vyc29yXzAwMQ=="
    assert "artifact_location" not in assets.text
    assert "provenance" not in assets.text
    assert repository.calls == [("project_001", 20, None)]


@pytest.mark.asyncio
async def test_asset_route_applies_a_default_limit_and_forwards_a_cursor(gateway) -> None:
    repository = MemoryEditorAssetRepository()
    transport = httpx.ASGITransport(app=assets_app(gateway, repository))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await client.get(ASSETS_URL, headers=AUTH_HEADERS)
        await client.get(f"{ASSETS_URL}?cursor=Y3Vyc29yXzAwMQ==", headers=AUTH_HEADERS)

    assert repository.calls == [
        ("project_001", 20, None),
        ("project_001", 20, "Y3Vyc29yXzAwMQ=="),
    ]


@pytest.mark.asyncio
async def test_asset_route_requires_authentication(gateway) -> None:
    transport = httpx.ASGITransport(app=assets_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        forbidden = await client.get(ASSETS_URL)

    assert forbidden.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["limit=0", "limit=51", "limit=abc", "limit=10.5"])
async def test_asset_route_rejects_an_out_of_range_limit(gateway, query: str) -> None:
    transport = httpx.ASGITransport(app=assets_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(f"{ASSETS_URL}?{query}", headers=AUTH_HEADERS)

    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cursor", ["../../etc/passwd", "C:/Windows/system32", "https://example.test", "a" * 513]
)
async def test_asset_route_rejects_an_unsafe_cursor_without_echoing_it(
    gateway, cursor: str
) -> None:
    repository = MemoryEditorAssetRepository()
    transport = httpx.ASGITransport(app=assets_app(gateway, repository))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(ASSETS_URL, params={"cursor": cursor}, headers=AUTH_HEADERS)

    assert response.status_code == 422
    assert repository.calls == []
    assert "etc/passwd" not in response.text
    assert "system32" not in response.text


@pytest.mark.asyncio
async def test_asset_route_isolates_another_project(gateway) -> None:
    transport = httpx.ASGITransport(app=assets_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/api/v1/projects/project_999/editor-assets", headers=AUTH_HEADERS
        )

    assert response.status_code == 200
    assert response.json() == {"assets": [], "next_cursor": None}


@pytest.mark.asyncio
async def test_asset_route_reports_a_failing_store_as_unavailable(gateway) -> None:
    transport = httpx.ASGITransport(app=assets_app(gateway, BrokenEditorAssetRepository()))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(ASSETS_URL, headers=AUTH_HEADERS)

    assert response.status_code == 503
    assert "postgres" not in response.text.lower()


@pytest.mark.asyncio
async def test_asset_route_reports_unconfigured_persistence(gateway) -> None:
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(ASSETS_URL, headers=AUTH_HEADERS)

    assert response.status_code == 503
