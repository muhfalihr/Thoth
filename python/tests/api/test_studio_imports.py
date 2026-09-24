"""Contract tests for opening a Content Set in Studio: inspect, create, list, and resolve."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.api.test_edit_documents import PAYLOAD, MemoryEditDocumentRepository
from tests.application.test_studio_imports import MemoryStudioImports
from tests.domain.test_studio_imports import projection_payload
from thoth_control_plane.api import create_app
from thoth_control_plane.application.ports import EditDocumentRevisionConflict
from thoth_control_plane.application.studio_imports import build_studio_draft
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.studio_imports import StudioSourceProjection, source_key

AUTH_HEADERS = {"Authorization": "Bearer test-key"}
BASE = "/api/v1/projects/project_001/studio-imports"
KEY = source_key(StudioSourceProjection.model_validate(projection_payload()))
CREATE = {"source": projection_payload(), "source_key": KEY}


class StaleStudioImports(MemoryStudioImports):
    async def resolve_item(self, **_: Any) -> Any:
        raise EditDocumentRevisionConflict(
            build_studio_draft(
                "project_001",
                "edoc_first",
                StudioSourceProjection.model_validate(projection_payload()),
            ).model_copy(update={"revision": 3})
        )


def client(repository: MemoryStudioImports | None = None) -> httpx.AsyncClient:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"),
        None,
        MemoryEditDocumentRepository(),
        studio_import_repository=repository or MemoryStudioImports(),
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_open_in_studio_inspects_then_creates_and_replays_one_draft() -> None:
    repository = MemoryStudioImports()
    async with client(repository) as api:
        inspected = await api.post(
            f"{BASE}/inspect", headers=AUTH_HEADERS, json=projection_payload()
        )
        assert inspected.status_code == 200
        assert inspected.json()["source_key"] == KEY
        assert inspected.json()["drafts"] == []

        headers = {**AUTH_HEADERS, "Idempotency-Key": "open-1"}
        created = await api.post(BASE, headers=headers, json=CREATE)
        replay = await api.post(BASE, headers=headers, json=CREATE)
        assert created.status_code == 201
        assert replay.json()["document_id"] == created.json()["document_id"]
        assert await repository.count_drafts("project_001", KEY) == 1

        listed = await api.get(f"{BASE}/{KEY}", headers=AUTH_HEADERS)
        assert [draft["document_id"] for draft in listed.json()["drafts"]] == [
            created.json()["document_id"]
        ]
        manifest = await api.get(
            f"{BASE}/documents/{created.json()['document_id']}", headers=AUTH_HEADERS
        )
        assert manifest.status_code == 200
        assert {entry["item_id"] for entry in manifest.json()["items"]} >= {"main_000"}

        for response in (inspected, created, listed, manifest):
            assert "example.com" not in response.text
            assert "source_url" not in response.text


@pytest.mark.asyncio
async def test_create_requires_a_safe_idempotency_key() -> None:
    async with client() as api:
        missing = await api.post(BASE, headers=AUTH_HEADERS, json=CREATE)
        unsafe = await api.post(
            BASE, headers={**AUTH_HEADERS, "Idempotency-Key": "../key"}, json=CREATE
        )
    assert (missing.status_code, missing.json()["detail"]) == (
        422,
        {"code": "missing_idempotency_key"},
    )
    assert (unsafe.status_code, unsafe.json()["detail"]) == (
        422,
        {"code": "invalid_idempotency_key"},
    )


@pytest.mark.asyncio
async def test_a_stale_source_key_or_reused_key_is_a_conflict() -> None:
    headers = {**AUTH_HEADERS, "Idempotency-Key": "open-1"}
    async with client() as api:
        stale = await api.post(BASE, headers=headers, json={**CREATE, "source_key": "0" * 64})
        await api.post(BASE, headers=headers, json=CREATE)
        other = projection_payload()
        other["items"][0]["title"] = "Another source"
        reused = await api.post(
            BASE,
            headers=headers,
            json={
                "source": other,
                "source_key": source_key(StudioSourceProjection.model_validate(other)),
            },
        )
    assert (stale.status_code, stale.json()["detail"]) == (409, {"code": "stale_source_key"})
    assert (reused.status_code, reused.json()["detail"]) == (
        409,
        {"code": "studio_import_conflict"},
    )


@pytest.mark.asyncio
async def test_a_stale_resolve_returns_the_latest_document() -> None:
    async with client(StaleStudioImports()) as api:
        response = await api.post(
            f"{BASE}/documents/edoc_first/items/unsupported_000/resolve",
            headers=AUTH_HEADERS,
            json={"base_revision": 1, "decision": {"kind": "exclude"}},
        )
    assert response.status_code == 409
    assert response.json()["latest"]["revision"] == 3


@pytest.mark.asyncio
async def test_unknown_drafts_are_not_found_and_routes_need_auth() -> None:
    async with client() as api:
        missing = await api.get(f"{BASE}/documents/edoc_missing", headers=AUTH_HEADERS)
        anonymous = await api.post(f"{BASE}/inspect", json=projection_payload())
    assert missing.status_code == 404
    assert anonymous.status_code == 403


@pytest.mark.asyncio
async def test_the_legacy_content_set_import_still_serves_old_callers() -> None:
    async with client() as api:
        response = await api.post(
            "/api/v1/projects/project_001/edit-documents/import-content-set",
            headers=AUTH_HEADERS,
            json=PAYLOAD,
        )
    assert response.status_code == 201
    assert response.json()["schema_version"] == 1
