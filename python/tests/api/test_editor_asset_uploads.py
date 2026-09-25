"""Contract tests for one explicit, streamed, project-scoped media upload."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.application.editor_asset_uploads import (
    UPLOAD_MAX_BYTES,
    EditorAssetUploadService,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.editor_assets import EditorAssetPage, EditorAssetRecord
from thoth_control_plane.infrastructure.artifact_root import LocalArtifactRoot

AUTH_HEADERS = {"Authorization": "Bearer test-key"}
UPLOAD_URL = "/api/v1/projects/project_001/editor-assets"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
IMAGE_REPORT = {"streams": [{"codec_type": "video", "width": 64, "height": 32}], "format": {}}


class MemoryRepository:
    def __init__(self) -> None:
        self.records: dict[tuple[str, str], EditorAssetRecord] = {}

    async def register_ready(self, record: EditorAssetRecord) -> None:
        self.records[(record.asset.project_id, record.asset.asset_id)] = record

    async def list_ready(self, *, project_id: str, **_: object) -> EditorAssetPage:
        return EditorAssetPage(
            assets=tuple(
                record.asset for key, record in self.records.items() if key[0] == project_id
            )
        )

    async def get_ready_record(self, *, project_id: str, asset_id: str) -> EditorAssetRecord | None:
        return self.records.get((project_id, asset_id))


def upload_app(gateway, root: Path, repository: MemoryRepository, report: Any = IMAGE_REPORT):
    app = create_app(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_CONTROL_PLANE_ARTIFACT_ROOT=root,
            THOTH_EDITOR_PREVIEW_SIGNING_KEY="api-test-signing-key",
        ),
        gateway,
        None,
        editor_asset_repository=repository,
    )

    async def probe(_: Path) -> dict[str, Any]:
        if isinstance(report, Exception):
            raise report
        return report

    app.state.editor_asset_upload_service = EditorAssetUploadService(
        repository, LocalArtifactRoot(root), probe
    )
    return app


def leftovers(root: Path) -> list[str]:
    return sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())


@pytest.mark.asyncio
async def test_upload_returns_a_locator_free_ready_asset_scoped_to_its_project(
    gateway, tmp_path: Path
) -> None:
    repository = MemoryRepository()
    transport = httpx.ASGITransport(app=upload_app(gateway, tmp_path, repository))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            UPLOAD_URL, content=PNG, headers={**AUTH_HEADERS, "Content-Type": "image/png"}
        )
        asset_id = created.json()["asset_id"]
        listed = await client.get(UPLOAD_URL, headers=AUTH_HEADERS)
        elsewhere = await client.get(
            "/api/v1/projects/project_002/editor-assets", headers=AUTH_HEADERS
        )
        foreign = await client.post(
            f"/api/v1/projects/project_002/editor-assets/{asset_id}/preview-capability",
            headers=AUTH_HEADERS,
        )

    assert created.status_code == 201
    body = created.json()
    assert body["project_id"] == "project_001"
    assert body["kind"] == "image"
    assert body["validation_state"] == "ready"
    assert "artifact_location" not in created.text
    assert "uploads/" not in created.text
    assert "provenance" not in created.text
    assert [item["asset_id"] for item in listed.json()["assets"]] == [asset_id]
    assert elsewhere.json()["assets"] == []
    assert foreign.status_code == 404


@pytest.mark.parametrize("content_type", ["text/html", "application/json", ""])
@pytest.mark.asyncio
async def test_upload_refuses_an_unsupported_media_type(
    gateway, tmp_path: Path, content_type: str
) -> None:
    repository = MemoryRepository()
    transport = httpx.ASGITransport(app=upload_app(gateway, tmp_path, repository))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            UPLOAD_URL, content=PNG, headers={**AUTH_HEADERS, "Content-Type": content_type}
        )

    assert response.status_code == 415
    assert response.json() == {"detail": {"code": "unsupported_media_type"}}
    assert repository.records == {}
    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_upload_refuses_spoofed_bytes(gateway, tmp_path: Path) -> None:
    repository = MemoryRepository()
    transport = httpx.ASGITransport(app=upload_app(gateway, tmp_path, repository))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            UPLOAD_URL, content=b"<html>" * 8, headers={**AUTH_HEADERS, "Content-Type": "image/png"}
        )

    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "media_type_mismatch"}}
    assert repository.records == {}
    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_upload_refuses_a_declared_length_over_the_ceiling_without_reading(
    gateway, tmp_path: Path
) -> None:
    transport = httpx.ASGITransport(app=upload_app(gateway, tmp_path, MemoryRepository()))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            UPLOAD_URL,
            content=PNG,
            headers={
                **AUTH_HEADERS,
                "Content-Type": "image/png",
                "Content-Length": str(UPLOAD_MAX_BYTES + 1),
            },
        )

    assert response.status_code == 413
    assert response.json() == {"detail": {"code": "upload_too_large"}}
    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_upload_reports_unusable_storage_as_a_safe_503(gateway, tmp_path: Path) -> None:
    missing = tmp_path / "absent"
    transport = httpx.ASGITransport(app=upload_app(gateway, missing, MemoryRepository()))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            UPLOAD_URL, content=PNG, headers={**AUTH_HEADERS, "Content-Type": "image/png"}
        )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "asset_storage_unavailable"}}
    assert str(tmp_path) not in response.text


@pytest.mark.asyncio
async def test_upload_requires_authentication_and_a_safe_project(gateway, tmp_path: Path) -> None:
    transport = httpx.ASGITransport(app=upload_app(gateway, tmp_path, MemoryRepository()))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        anonymous = await client.post(
            UPLOAD_URL, content=PNG, headers={"Content-Type": "image/png"}
        )
        unsafe = await client.post(
            "/api/v1/projects/project..001/editor-assets",
            content=PNG,
            headers={**AUTH_HEADERS, "Content-Type": "image/png"},
        )

    assert anonymous.status_code == 403
    assert unsafe.status_code == 422
    assert leftovers(tmp_path) == []
