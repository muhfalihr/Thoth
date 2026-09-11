"""Contract tests for Creator Studio document endpoints."""

from __future__ import annotations

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import EditDocument

AUTH_HEADERS = {"Authorization": "Bearer test-key"}
PAYLOAD = {
    "main": {"title": "Main", "description": "Summary"},
    "footage": [{"title": "Source", "platform": "tiktok"}],
}


class MemoryEditDocumentRepository:
    def __init__(self) -> None:
        self.documents: dict[tuple[str, str], EditDocument] = {}

    async def insert_revision(self, document: EditDocument) -> None:
        self.documents[(document.project_id, document.document_id)] = document

    async def get_latest(self, *, project_id: str, document_id: str) -> EditDocument | None:
        return self.documents.get((project_id, document_id))


@pytest.mark.asyncio
async def test_import_then_retrieve_an_authenticated_document(gateway) -> None:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"),
        gateway,
        MemoryEditDocumentRepository(),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_001/edit-documents/import-content-set",
            headers=AUTH_HEADERS,
            json=PAYLOAD,
        )
        assert created.status_code == 201
        document_id = created.json()["document_id"]

        retrieved = await client.get(
            f"/api/v1/projects/project_001/edit-documents/{document_id}", headers=AUTH_HEADERS
        )

    assert retrieved.status_code == 200
    assert retrieved.json() == created.json()


@pytest.mark.asyncio
async def test_editor_routes_fail_closed_for_auth_unknown_input_and_missing_document(
    gateway,
) -> None:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, MemoryEditDocumentRepository()
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        forbidden = await client.post(
            "/api/v1/projects/project_001/edit-documents/import-content-set", json=PAYLOAD
        )
        invalid = await client.post(
            "/api/v1/projects/project_001/edit-documents/import-content-set",
            headers=AUTH_HEADERS,
            json={**PAYLOAD, "url": "https://example.test"},
        )
        missing = await client.get(
            "/api/v1/projects/project_001/edit-documents/edoc_missing", headers=AUTH_HEADERS
        )

    assert forbidden.status_code == 403
    assert invalid.status_code == 422
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_editor_routes_report_unavailable_persistence_without_affecting_workflows(
    gateway,
) -> None:
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        unavailable = await client.post(
            "/api/v1/projects/project_001/edit-documents/import-content-set",
            headers=AUTH_HEADERS,
            json=PAYLOAD,
        )
        workflows = await client.get("/api/v1/style-presets", headers=AUTH_HEADERS)

    assert unavailable.status_code == 503
    assert workflows.status_code == 200
