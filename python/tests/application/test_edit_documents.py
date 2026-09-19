"""Tests for sanitized Content Set import into Creator Studio documents."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from thoth_control_plane.application.edit_documents import (
    ContentSetImportRequest,
    EditDocumentNotFound,
    EditDocumentService,
    EditorUnavailable,
    UpgradeTimelineRequest,
    build_edit_document,
)
from thoth_control_plane.application.ports import (
    EditDocumentRevisionConflict,
    EditDocumentUpgradeConflict,
)
from thoth_control_plane.domain.edit_document_operations import (
    EditDocumentOperation,
    EditDocumentPatch,
    apply_edit_operations,
)
from thoth_control_plane.domain.edit_document_upgrade import upgrade_edit_document_v1
from thoth_control_plane.domain.edit_document_v2 import EditDocument, EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1
from thoth_control_plane.infrastructure.editor_repository import EditDocumentPersistenceError


def request_payload() -> dict[str, object]:
    return {
        "main": {"title": "  Main title  ", "description": "  Main description  "},
        "footage": [
            {"title": "  First source  ", "platform": "  tiktok  "},
            {"title": "", "platform": "youtube"},
            {"title": " Second source ", "platform": " Instagram "},
            {"title": " Third source ", "platform": None},
            {"title": " Fourth source ", "platform": "x"},
        ],
    }


def test_importer_uses_only_text_and_first_three_non_empty_sources() -> None:
    request = ContentSetImportRequest.model_validate(request_payload())

    document = build_edit_document("project_001", request, "edoc_abc123")

    assert request.main.title == "Main title"
    assert request.main.description == "Main description"
    assert request.footage[1].title is None
    assert document.canvas.duration_in_frames == 600
    assert [scene.scene_id for scene in document.scenes] == [
        "scene_001",
        "scene_002",
        "scene_003",
        "scene_004",
    ]
    assert [scene.role for scene in document.scenes] == ["title", "source", "source", "source"]
    assert [clip.clip_id for clip in document.clips] == [
        "clip_001",
        "clip_002",
        "clip_003",
        "clip_004",
    ]
    assert [clip.heading for clip in document.clips] == [
        "Main title",
        "First source",
        "Second source",
        "Third source",
    ]
    assert [clip.body for clip in document.clips] == [
        "Main description",
        "tiktok",
        "instagram",
        "",
    ]
    assert all(scene.duration_in_frames == 150 for scene in document.scenes)
    assert document.tracks[0].clip_ids == ["clip_001", "clip_002", "clip_003", "clip_004"]
    assert all(clip.ownership == "ai_managed" for clip in document.clips)


def test_importer_supplies_title_when_content_set_title_is_missing() -> None:
    request = ContentSetImportRequest.model_validate({"main": {}, "footage": []})

    document = build_edit_document("project_001", request, "edoc_abc123")

    assert len(document.scenes) == 1
    assert document.clips[0].heading == "Untitled video"
    assert document.clips[0].body == ""


@pytest.mark.parametrize("field", ["url", "image_path", "comments", "profile", "references"])
def test_import_request_rejects_unsafe_legacy_content_set_fields(field: str) -> None:
    payload = request_payload()
    payload[field] = "unsafe"

    with pytest.raises(ValidationError):
        ContentSetImportRequest.model_validate(payload)


def test_import_request_has_no_route_for_raw_content_values() -> None:
    request = ContentSetImportRequest.model_validate(request_payload())
    serialized = json.dumps(request.model_dump(mode="json"))

    for forbidden in ("https://", r"C:\\", "/home/", "token", "secret_fixture_value"):
        assert forbidden not in serialized


def test_import_request_rejects_unknown_nested_content_values() -> None:
    payload = request_payload()
    payload["main"]["url"] = "https://example.test/secret"  # type: ignore[index]

    with pytest.raises(ValidationError):
        ContentSetImportRequest.model_validate(payload)


class MemoryEditDocumentRepository:
    def __init__(self, document_id: str) -> None:
        self.document = build_edit_document(
            "project_001", ContentSetImportRequest.model_validate(request_payload()), document_id
        )

    async def insert_revision(self, document: EditDocument) -> None:
        self.document = document

    async def get_latest(self, *, project_id: str, document_id: str) -> EditDocument | None:
        if (project_id, document_id) == ("project_001", self.document.document_id):
            return self.document
        return None

    async def apply_operations(
        self,
        project_id: str,
        document_id: str,
        base_revision: int,
        operations: list[EditDocumentOperation],
    ) -> EditDocument:
        assert (project_id, document_id, base_revision) == (
            "project_001",
            self.document.document_id,
            1,
        )
        self.document = apply_edit_operations(self.document, operations).model_copy(
            update={"revision": 2}
        )
        return self.document


@pytest.mark.asyncio
async def test_service_delegates_validated_patch_and_returns_next_revision() -> None:
    repository = MemoryEditDocumentRepository("edoc_abc123")
    service = EditDocumentService(repository)
    patch = EditDocumentPatch.model_validate(
        {
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
    )

    result = await service.apply_patch("project_001", "edoc_abc123", patch)

    assert result.revision == 2
    assert result.clips[0].heading == "Revised title"


class UpgradeRepository(MemoryEditDocumentRepository):
    """Records upgrades the way the SQL store does: one key binds one revision."""

    def __init__(self, document_id: str = "edoc_abc123") -> None:
        super().__init__(document_id)
        self.insert_count = 0
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
            raise EditDocumentPersistenceError()
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
        self.insert_count += 1
        self.document = result
        self.recorded[idempotency_key] = (payload, result)
        return result


class BrokenUpgradeRepository(UpgradeRepository):
    async def upgrade_to_timeline(self, **_: object) -> EditDocument:
        raise EditDocumentPersistenceError()


async def upgrade(
    service: EditDocumentService, *, key: str = "upgrade_001", base_revision: int = 1
) -> EditDocument:
    return await service.upgrade_to_timeline(
        project_id="project_001",
        document_id="edoc_abc123",
        request=UpgradeTimelineRequest(base_revision=base_revision),
        idempotency_key=key,
    )


@pytest.mark.asyncio
async def test_upgrade_is_explicit_idempotent_and_appends_one_revision() -> None:
    repository = UpgradeRepository()
    service = EditDocumentService(repository)

    first = await upgrade(service)
    replay = await upgrade(service)

    assert first == replay
    assert first.schema_version == 2
    assert first.revision == 2
    assert repository.insert_count == 1


@pytest.mark.asyncio
async def test_upgrade_refuses_a_document_that_is_already_version_two() -> None:
    repository = UpgradeRepository()
    service = EditDocumentService(repository)
    await upgrade(service)

    with pytest.raises(EditDocumentUpgradeConflict):
        await upgrade(service, key="upgrade_002", base_revision=2)


@pytest.mark.asyncio
async def test_upgrade_reports_a_missing_document_without_touching_the_store() -> None:
    service = EditDocumentService(UpgradeRepository("edoc_other"))

    with pytest.raises(EditDocumentNotFound):
        await upgrade(service)


@pytest.mark.asyncio
async def test_upgrade_propagates_a_stale_base_revision_as_a_conflict() -> None:
    service = EditDocumentService(UpgradeRepository())

    with pytest.raises(EditDocumentRevisionConflict):
        await upgrade(service, base_revision=7)


@pytest.mark.asyncio
async def test_upgrade_conflicts_when_a_key_is_replayed_with_another_base() -> None:
    repository = UpgradeRepository()
    service = EditDocumentService(repository)
    await upgrade(service)

    with pytest.raises(EditDocumentUpgradeConflict):
        await upgrade(service, base_revision=2)

    assert repository.insert_count == 1


@pytest.mark.asyncio
async def test_upgrade_reports_a_repository_failure_as_editor_unavailable() -> None:
    service = EditDocumentService(BrokenUpgradeRepository())

    with pytest.raises(EditorUnavailable) as error:
        await upgrade(service)

    assert "postgres" not in str(error.value).lower()


@pytest.mark.asyncio
async def test_upgrade_requires_configured_editor_persistence() -> None:
    with pytest.raises(EditorUnavailable):
        await upgrade(EditDocumentService(None))


@pytest.mark.parametrize("base_revision", [0, -1, "1", 1.0])
def test_upgrade_request_rejects_a_non_positive_or_loose_base_revision(
    base_revision: object,
) -> None:
    with pytest.raises(ValidationError):
        UpgradeTimelineRequest.model_validate({"base_revision": base_revision})


def test_upgrade_request_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        UpgradeTimelineRequest.model_validate({"base_revision": 1, "idempotency_key": "k"})


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["", "   ", "k" * 129, "key with space", "key\n001"])
async def test_upgrade_rejects_an_unsafe_idempotency_key(key: str) -> None:
    repository = UpgradeRepository()
    service = EditDocumentService(repository)

    with pytest.raises(ValidationError):
        await upgrade(service, key=key)

    assert repository.insert_count == 0
