"""Contract tests for Creator Studio document endpoints."""

from __future__ import annotations

import httpx
import pytest

from tests.domain.edit_document_v2_fixtures import document_with_every_clip_kind
from thoth_control_plane.api import create_app
from thoth_control_plane.application.edit_documents import EditDocumentNotFound
from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    EditDocumentUpgradeConflict,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import EditDocument
from thoth_control_plane.domain.edit_document_operations import (
    EditDocumentOperation,
    apply_edit_operations,
)
from thoth_control_plane.domain.edit_document_upgrade import upgrade_edit_document_v1
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1

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
    assert stale.json()["code"] == "document_revision_conflict"
    assert stale.json()["latest"]["revision"] == 2
    assert stale.json()["latest"]["clips"][0]["heading"] == "Revised title"


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


class UpgradeRepository(MemoryEditDocumentRepository):
    """In-memory store with the same replay contract as the SQL upgrade."""

    def __init__(self) -> None:
        super().__init__()
        self.recorded: dict[str, tuple[str, EditDocument]] = {}

    async def upgrade_to_timeline(
        self,
        *,
        project_id: str,
        document_id: str,
        base_revision: int,
        idempotency_key: str,
    ) -> EditDocument:
        payload = f"{project_id}|{document_id}|{base_revision}"
        recorded = self.recorded.get(idempotency_key)
        if recorded is not None:
            if recorded[0] != payload:
                raise EditDocumentUpgradeConflict()
            return recorded[1]
        latest = await self.get_latest(project_id=project_id, document_id=document_id)
        if latest is None:
            raise EditDocumentNotFound()
        if not isinstance(latest, EditDocumentV1):
            raise EditDocumentUpgradeConflict()
        if latest.revision != base_revision:
            raise EditDocumentRevisionConflict(latest)
        result = EditDocumentV2.model_validate(
            {
                **upgrade_edit_document_v1(latest).model_dump(mode="json"),
                "revision": latest.revision + 1,
            }
        )
        self.documents[(project_id, document_id)] = result
        self.recorded[idempotency_key] = (payload, result)
        return result


def upgrade_app(gateway, repository: MemoryEditDocumentRepository | None = None):
    return create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, repository or UpgradeRepository()
    )


async def imported_document(client: httpx.AsyncClient) -> str:
    created = await client.post(
        "/api/v1/projects/project_001/edit-documents/import-content-set",
        headers=AUTH_HEADERS,
        json=PAYLOAD,
    )
    return created.json()["document_id"]


def upgrade_url(document_id: str, project_id: str = "project_001") -> str:
    return f"/api/v1/projects/{project_id}/edit-documents/{document_id}/upgrade-timeline"


@pytest.mark.asyncio
async def test_upgrade_route_returns_a_version_two_document_and_replays_safely(gateway) -> None:
    transport = httpx.ASGITransport(app=upgrade_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        document_id = await imported_document(client)
        headers = {**AUTH_HEADERS, "Idempotency-Key": "upgrade_001"}
        upgrade = await client.post(
            upgrade_url(document_id), headers=headers, json={"base_revision": 1}
        )
        replay = await client.post(
            upgrade_url(document_id), headers=headers, json={"base_revision": 1}
        )

    assert upgrade.status_code == 200
    assert upgrade.json()["schema_version"] == 2
    assert upgrade.json()["revision"] == 2
    assert replay.json() == upgrade.json()


@pytest.mark.asyncio
async def test_upgrade_route_requires_authentication_and_an_idempotency_key(gateway) -> None:
    transport = httpx.ASGITransport(app=upgrade_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        document_id = await imported_document(client)
        unauthenticated = await client.post(
            upgrade_url(document_id),
            headers={"Idempotency-Key": "upgrade_001"},
            json={"base_revision": 1},
        )
        missing_key = await client.post(
            upgrade_url(document_id), headers=AUTH_HEADERS, json={"base_revision": 1}
        )
        blank_key = await client.post(
            upgrade_url(document_id),
            headers={**AUTH_HEADERS, "Idempotency-Key": "   "},
            json={"base_revision": 1},
        )

    assert unauthenticated.status_code == 403
    assert missing_key.status_code == 422
    assert missing_key.json()["detail"] == {"code": "missing_idempotency_key"}
    assert blank_key.status_code == 422
    assert blank_key.json()["detail"] == {"code": "missing_idempotency_key"}


@pytest.mark.asyncio
async def test_upgrade_route_rejects_an_unsafe_idempotency_key(gateway) -> None:
    transport = httpx.ASGITransport(app=upgrade_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        document_id = await imported_document(client)
        response = await client.post(
            upgrade_url(document_id),
            headers={**AUTH_HEADERS, "Idempotency-Key": "../../etc/passwd"},
            json={"base_revision": 1},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "invalid_idempotency_key"}
    assert "etc/passwd" not in response.text


@pytest.mark.asyncio
async def test_upgrade_route_rejects_unknown_fields_and_a_bad_base_revision(gateway) -> None:
    transport = httpx.ASGITransport(app=upgrade_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        document_id = await imported_document(client)
        headers = {**AUTH_HEADERS, "Idempotency-Key": "upgrade_001"}
        unknown = await client.post(
            upgrade_url(document_id),
            headers=headers,
            json={"base_revision": 1, "artifact_location": "/etc/passwd"},
        )
        invalid = await client.post(
            upgrade_url(document_id), headers=headers, json={"base_revision": 0}
        )

    assert unknown.status_code == 422
    assert invalid.status_code == 422


@pytest.mark.asyncio
async def test_upgrade_route_hides_a_missing_or_cross_project_document(gateway) -> None:
    transport = httpx.ASGITransport(app=upgrade_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        document_id = await imported_document(client)
        headers = {**AUTH_HEADERS, "Idempotency-Key": "upgrade_001"}
        missing = await client.post(
            upgrade_url("edoc_missing"), headers=headers, json={"base_revision": 1}
        )
        cross_project = await client.post(
            upgrade_url(document_id, "project_999"), headers=headers, json={"base_revision": 1}
        )

    assert missing.status_code == 404
    assert cross_project.status_code == 404


@pytest.mark.asyncio
async def test_upgrade_route_reports_a_stale_revision_with_the_typed_envelope(gateway) -> None:
    transport = httpx.ASGITransport(app=upgrade_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        document_id = await imported_document(client)
        stale = await client.post(
            upgrade_url(document_id),
            headers={**AUTH_HEADERS, "Idempotency-Key": "upgrade_001"},
            json={"base_revision": 9},
        )

    assert stale.status_code == 409
    assert stale.json()["code"] == "document_revision_conflict"
    assert stale.json()["latest"]["revision"] == 1


@pytest.mark.asyncio
async def test_upgrade_route_conflicts_on_a_replayed_key_with_another_payload(gateway) -> None:
    transport = httpx.ASGITransport(app=upgrade_app(gateway))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        document_id = await imported_document(client)
        headers = {**AUTH_HEADERS, "Idempotency-Key": "upgrade_001"}
        await client.post(upgrade_url(document_id), headers=headers, json={"base_revision": 1})
        replayed = await client.post(
            upgrade_url(document_id), headers=headers, json={"base_revision": 2}
        )

    assert replayed.status_code == 409
    assert replayed.json()["detail"] == {"code": "document_upgrade_conflict"}


@pytest.mark.asyncio
async def test_upgrade_route_reports_unavailable_persistence(gateway) -> None:
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            upgrade_url("edoc_missing"),
            headers={**AUTH_HEADERS, "Idempotency-Key": "upgrade_001"},
            json={"base_revision": 1},
        )

    assert response.status_code == 503


@pytest.mark.asyncio
async def test_patch_edits_one_caption_cue_under_the_base_revision(gateway) -> None:
    repository = MemoryEditDocumentRepository()
    document = EditDocumentV2.model_validate(document_with_every_clip_kind())
    await repository.insert_revision(document)
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway, repository)
    url = f"/api/v1/projects/project_001/edit-documents/{document.document_id}"

    def caption_patch(base_revision: int, cue_index: int) -> dict[str, object]:
        return {
            "base_revision": base_revision,
            "operations": [
                {
                    "kind": "set_caption_cue_text",
                    "operation_id": "op_caption_1",
                    "clip_id": "clip_caption",
                    "cue_index": cue_index,
                    "text": "Corrected caption",
                }
            ],
        }

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        rejected = await client.patch(url, headers=AUTH_HEADERS, json=caption_patch(1, 5))
        after_rejection = await client.get(url, headers=AUTH_HEADERS)
        saved = await client.patch(url, headers=AUTH_HEADERS, json=caption_patch(1, 0))
        stale = await client.patch(url, headers=AUTH_HEADERS, json=caption_patch(1, 0))

    assert rejected.status_code >= 400
    assert after_rejection.json()["revision"] == 1
    assert saved.status_code == 200
    assert saved.json()["revision"] == 2
    caption = next(clip for clip in saved.json()["clips"] if clip["clip_id"] == "clip_caption")
    assert caption["cues"][0]["text"] == "Corrected caption"
    assert stale.status_code == 409
    assert stale.json()["latest"]["revision"] == 2
