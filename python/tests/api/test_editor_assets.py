"""Contract tests for the project-scoped editor asset catalog endpoint."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

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
from thoth_control_plane.infrastructure.editor_preview import (
    PREVIEW_COOKIE_NAME,
    EditorPreviewSigner,
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
    def __init__(
        self,
        page: EditorAssetPage | None = None,
        records: dict[tuple[str, str], EditorAssetRecord] | None = None,
    ) -> None:
        self.page = page or EditorAssetPage(assets=(asset(),), next_cursor="Y3Vyc29yXzAwMQ==")
        self.records = records if records is not None else {}
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


PREVIEW_KEY = "api-test-signing-key"
CAPABILITY_URL = f"{ASSETS_URL}/asset_main/preview-capability"
PREVIEW_URL = f"{ASSETS_URL}/asset_main/preview"
MEDIA_BYTES = b"0123456789abcdef"


def record(
    location: str = "project_001/asset_main.mp4", validation_state: str = "ready"
) -> EditorAssetRecord:
    payload = asset().model_dump()
    payload["validation_state"] = validation_state
    return EditorAssetRecord.model_construct(
        asset=EditorAsset.model_construct(**payload),
        artifact_location=location,
        provenance="operator_upload",
    )


def seeded_root(tmp_path: Path) -> Path:
    media = tmp_path / "project_001"
    media.mkdir()
    (media / "asset_main.mp4").write_bytes(MEDIA_BYTES)
    return tmp_path


def preview_app(gateway, tmp_path: Path, records=None, **overrides):
    repository = MemoryEditorAssetRepository(
        records=records if records is not None else {("project_001", "asset_main"): record()}
    )
    return create_app(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_CONTROL_PLANE_ARTIFACT_ROOT=seeded_root(tmp_path),
            THOTH_EDITOR_PREVIEW_SIGNING_KEY=PREVIEW_KEY,
            **overrides,
        ),
        gateway,
        None,
        editor_asset_repository=repository,
    )


def client_for(app, base_url: str = "http://test") -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=base_url)


def cookie_header(token: str) -> dict[str, str]:
    return {**AUTH_HEADERS, "Cookie": f"{PREVIEW_COOKIE_NAME}={token}"}


@pytest.mark.asyncio
async def test_capability_issuance_returns_a_relative_url_and_an_httponly_cookie(
    gateway, tmp_path: Path
) -> None:
    async with client_for(preview_app(gateway, tmp_path)) as client:
        issued = await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)

    body = issued.json()
    cookie = issued.headers["set-cookie"]

    assert issued.status_code == 200
    assert set(body) == {"preview_url", "expires_at"}
    assert body["preview_url"] == PREVIEW_URL
    assert f"{PREVIEW_COOKIE_NAME}=" in cookie
    assert "HttpOnly" in cookie
    assert f"Path={PREVIEW_URL}" in cookie
    assert "SameSite=strict" in cookie.replace("SameSite=Strict", "SameSite=strict")
    assert "Max-Age=300" in cookie
    assert "Secure" not in cookie


@pytest.mark.asyncio
async def test_capability_value_never_appears_in_the_url_the_body_or_the_log(
    gateway, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        async with client_for(preview_app(gateway, tmp_path)) as client:
            issued = await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)
            served = await client.get(PREVIEW_URL)

    token = issued.cookies[PREVIEW_COOKIE_NAME]

    assert served.status_code == 200
    assert token not in issued.text
    assert token not in issued.json()["preview_url"]
    assert PREVIEW_KEY not in issued.text
    assert token not in caplog.text
    assert PREVIEW_KEY not in caplog.text


@pytest.mark.asyncio
async def test_capability_cookie_is_marked_secure_over_https(gateway, tmp_path: Path) -> None:
    async with client_for(preview_app(gateway, tmp_path), "https://test") as client:
        issued = await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)

    assert "Secure" in issued.headers["set-cookie"]


@pytest.mark.asyncio
async def test_capability_issuance_requires_bearer_auth_and_a_ready_same_project_asset(
    gateway, tmp_path: Path
) -> None:
    app = preview_app(gateway, tmp_path)
    async with client_for(app) as client:
        unauthenticated = await client.post(CAPABILITY_URL)
        unknown = await client.post(
            f"{ASSETS_URL}/asset_absent/preview-capability", headers=AUTH_HEADERS
        )
        cross_project = await client.post(
            "/api/v1/projects/project_999/editor-assets/asset_main/preview-capability",
            headers=AUTH_HEADERS,
        )

    assert unauthenticated.status_code == 403
    assert "set-cookie" not in unauthenticated.headers
    assert unknown.status_code == 404
    assert cross_project.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["pending", "rejected"])
async def test_capability_issuance_refuses_an_unvalidated_asset(
    gateway, tmp_path: Path, state: str
) -> None:
    records = {("project_001", "asset_main"): record(validation_state=state)}
    async with client_for(preview_app(gateway, tmp_path, records=records)) as client:
        response = await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_preview_serves_the_whole_file_with_a_controlled_content_type(
    gateway, tmp_path: Path
) -> None:
    async with client_for(preview_app(gateway, tmp_path)) as client:
        await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)
        served = await client.get(PREVIEW_URL)

    assert served.status_code == 200
    assert served.headers["content-type"] == "video/mp4"
    assert served.content == MEDIA_BYTES
    assert served.headers["cache-control"] == "private, no-store"
    assert served.headers["x-content-type-options"] == "nosniff"
    assert "attachment" not in served.headers.get("content-disposition", "")


@pytest.mark.asyncio
async def test_preview_honours_a_byte_range_request(gateway, tmp_path: Path) -> None:
    async with client_for(preview_app(gateway, tmp_path)) as client:
        await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)
        ranged = await client.get(PREVIEW_URL, headers={"Range": "bytes=0-3"})

    assert ranged.status_code == 206
    assert ranged.headers["content-range"] == f"bytes 0-3/{len(MEDIA_BYTES)}"
    assert ranged.content == MEDIA_BYTES[:4]


@pytest.mark.asyncio
async def test_preview_refuses_a_missing_wrong_or_expired_capability(
    gateway, tmp_path: Path
) -> None:
    signer = EditorPreviewSigner(key=PREVIEW_KEY, ttl_seconds=300)
    now = datetime.now(tz=UTC)
    other_asset = signer.issue(project_id="project_001", asset_id="asset_other", now=now).token
    other_project = signer.issue(project_id="project_999", asset_id="asset_main", now=now).token
    expired = signer.issue(
        project_id="project_001",
        asset_id="asset_main",
        now=now - timedelta(hours=2),
    ).token

    async with client_for(preview_app(gateway, tmp_path)) as client:
        absent = await client.get(PREVIEW_URL)
        forged = await client.get(PREVIEW_URL, headers=cookie_header("not-a-capability"))
        wrong_asset = await client.get(PREVIEW_URL, headers=cookie_header(other_asset))
        wrong_project = await client.get(PREVIEW_URL, headers=cookie_header(other_project))
        stale = await client.get(PREVIEW_URL, headers=cookie_header(expired))

    for response in (absent, forged, wrong_asset, wrong_project, stale):
        assert response.status_code == 403
        assert PREVIEW_KEY not in response.text
    assert "Max-Age=0" in forged.headers["set-cookie"]


@pytest.mark.asyncio
async def test_preview_reports_a_missing_file_without_revealing_a_path(
    gateway, tmp_path: Path
) -> None:
    records = {("project_001", "asset_main"): record(location="project_001/absent.mp4")}
    async with client_for(preview_app(gateway, tmp_path, records=records)) as client:
        await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)
        served = await client.get(PREVIEW_URL)

    assert served.status_code == 404
    assert served.json()["detail"] == {"code": "asset_not_ready"}
    assert "absent.mp4" not in served.text
    assert str(tmp_path) not in served.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "location",
    [
        "../secret.mp4",
        "project_001/../../secret.mp4",
        "/etc/passwd",
        "C:/Windows/system32/config",
        "https://example.test/clip.mp4",
        "project_001/asset_main.mp4?token=abc",
    ],
)
async def test_preview_never_serves_an_unsafe_locator(
    gateway, tmp_path: Path, location: str
) -> None:
    records = {("project_001", "asset_main"): record(location=location)}
    async with client_for(preview_app(gateway, tmp_path, records=records)) as client:
        await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)
        served = await client.get(PREVIEW_URL)

    assert served.status_code == 404
    assert location not in served.text


@pytest.mark.asyncio
async def test_preview_routes_report_an_unconfigured_signing_key(gateway, tmp_path: Path) -> None:
    app = create_app(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_CONTROL_PLANE_ARTIFACT_ROOT=seeded_root(tmp_path),
        ),
        gateway,
        None,
        editor_asset_repository=MemoryEditorAssetRepository(
            records={("project_001", "asset_main"): record()}
        ),
    )
    async with client_for(app) as client:
        issued = await client.post(CAPABILITY_URL, headers=AUTH_HEADERS)
        served = await client.get(PREVIEW_URL, headers=cookie_header("anything"))

    assert issued.status_code == 503
    assert served.status_code == 503


@pytest.mark.asyncio
async def test_preview_contract_never_publishes_the_capability_or_the_signing_key(
    gateway, tmp_path: Path
) -> None:
    document = preview_app(gateway, tmp_path).openapi()
    preview_operation = document["paths"][
        "/api/v1/projects/{project_id}/editor-assets/{asset_id}/preview"
    ]["get"]
    schema = json.dumps(document)

    assert PREVIEW_KEY not in schema
    assert "THOTH_EDITOR_PREVIEW_SIGNING_KEY" not in schema
    # The capability is declared as a cookie and nowhere else: no path segment,
    # no query parameter, and no published example carrying a signed value.
    locations = {
        parameter["name"]: parameter["in"] for parameter in preview_operation["parameters"]
    }
    assert locations[PREVIEW_COOKIE_NAME] == "cookie"
    assert PREVIEW_COOKIE_NAME not in json.dumps(document["paths"]).replace(
        json.dumps(preview_operation["parameters"]), ""
    )
    assert "example" not in json.dumps(preview_operation["parameters"])
