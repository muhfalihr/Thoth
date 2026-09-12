"""Contract tests for Creator Studio document endpoints."""

from __future__ import annotations

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.application.edit_documents import EditDocumentNotFound
from thoth_control_plane.application.ports import EditDocumentRevisionConflict
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import EditDocument
from thoth_control_plane.domain.edit_document_operations import (
    EditDocumentOperation,
    apply_edit_operations,
)

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

    async def apply_operations(
        self,
        project_id: str,
        document_id: str,
        base_revision: int,
        operations: list[EditDocumentOperation],
    ) -> EditDocument:
        latest = await self.get_latest(project_id=project_id, document_id=document_id)
        if latest is None:
            raise EditDocumentNotFound()
        if latest.revision != base_revision:
            raise EditDocumentRevisionConflict(latest)
        updated = apply_edit_operations(latest, operations)
        result = updated.model_copy(update={"revision": latest.revision + 1})
        self.documents[(project_id, document_id)] = result
        return result


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
async def test_import_content_set_accepts_legacy_uuid_project_id(gateway) -> None:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, MemoryEditDocumentRepository()
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/645bc68c-d549-4a46-a295-201d836d9180/edit-documents/import-content-set",
            headers=AUTH_HEADERS,
            json=PAYLOAD,
        )

    assert created.status_code == 201
    assert created.json()["project_id"] == "645bc68c-d549-4a46-a295-201d836d9180"


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


@pytest.mark.asyncio
async def test_patch_saves_an_authenticated_document_revision(gateway) -> None:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, MemoryEditDocumentRepository()
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_001/edit-documents/import-content-set",
            headers=AUTH_HEADERS,
            json=PAYLOAD,
        )
        saved = await client.patch(
            f"/api/v1/projects/project_001/edit-documents/{created.json()['document_id']}",
            headers=AUTH_HEADERS,
            json={
                "base_revision": 1,
                "operations": [
                    {
                        "kind": "replace_text",
                        "operation_id": "op_001",
                        "clip_id": "clip_001",
                        "field": "heading",
                        "value": "Revised title",
                    }
                ],
            },
        )

    assert saved.status_code == 200
    assert saved.json()["revision"] == 2
    assert saved.json()["clips"][0]["heading"] == "Revised title"


@pytest.mark.asyncio
async def test_patch_fails_closed_for_auth_unknown_input_and_missing_document(gateway) -> None:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, MemoryEditDocumentRepository()
    )
    transport = httpx.ASGITransport(app=app)
    payload = {
        "base_revision": 1,
        "operations": [
            {
                "kind": "replace_text",
                "operation_id": "op_001",
                "clip_id": "clip_001",
                "field": "heading",
                "value": "Revised title",
            }
        ],
    }
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        forbidden = await client.patch(
            "/api/v1/projects/project_001/edit-documents/edoc_missing", json=payload
        )
        invalid = await client.patch(
            "/api/v1/projects/project_001/edit-documents/edoc_missing",
            headers=AUTH_HEADERS,
            json={**payload, "url": "https://example.test"},
        )
        missing = await client.patch(
            "/api/v1/projects/project_001/edit-documents/edoc_missing",
            headers=AUTH_HEADERS,
            json=payload,
        )

    assert forbidden.status_code == 403
    assert invalid.status_code == 422
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_patch_returns_validated_latest_document_for_a_stale_revision(gateway) -> None:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, MemoryEditDocumentRepository()
    )
    transport = httpx.ASGITransport(app=app)
    patch = {
        "base_revision": 1,
        "operations": [
            {
                "kind": "replace_text",
                "operation_id": "op_001",
                "clip_id": "clip_001",
                "field": "heading",
                "value": "Revised title",
            }
        ],
    }
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_001/edit-documents/import-content-set",
            headers=AUTH_HEADERS,
            json=PAYLOAD,
        )
        document_id = created.json()["document_id"]
        await client.patch(
            f"/api/v1/projects/project_001/edit-documents/{document_id}",
            headers=AUTH_HEADERS,
            json=patch,
        )
        stale = await client.patch(
            f"/api/v1/projects/project_001/edit-documents/{document_id}",
            headers=AUTH_HEADERS,
            json=patch,
        )

    assert stale.status_code == 409
    assert stale.json()["revision"] == 2
    assert stale.json()["clips"][0]["heading"] == "Revised title"


@pytest.mark.asyncio
async def test_patch_reports_unavailable_persistence(gateway) -> None:
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.patch(
            "/api/v1/projects/project_001/edit-documents/edoc_missing",
            headers=AUTH_HEADERS,
            json={
                "base_revision": 1,
                "operations": [
                    {
                        "kind": "replace_text",
                        "operation_id": "op_001",
                        "clip_id": "clip_001",
                        "field": "heading",
                        "value": "Revised title",
                    }
                ],
            },
        )

    assert response.status_code == 503


@pytest.mark.asyncio
async def test_openapi_includes_one_patch_edit_document_operation(gateway) -> None:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, MemoryEditDocumentRepository()
    )

    operation = app.openapi()["paths"]["/api/v1/projects/{project_id}/edit-documents/{document_id}"]

    assert list(operation) == ["get", "patch"]
