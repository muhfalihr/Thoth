"""Guards on the public schema so no server-side locator or secret can be published."""

from __future__ import annotations

import json

import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.config import Settings

UPGRADE_PATH = "/api/v1/projects/{project_id}/edit-documents/{document_id}/upgrade-timeline"
ASSETS_PATH = "/api/v1/projects/{project_id}/editor-assets"
RENDER_JOBS_PATH = "/api/v1/projects/{project_id}/render-jobs"
RENDER_JOB_PATH = f"{RENDER_JOBS_PATH}/{{render_job_id}}"


@pytest.fixture
def schema(gateway) -> dict[str, object]:
    return create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway).openapi()


def test_schema_publishes_the_upgrade_and_asset_catalog_operations(schema) -> None:
    assert list(schema["paths"][UPGRADE_PATH]) == ["post"]
    assert list(schema["paths"][ASSETS_PATH]) == ["get"]


def test_upgrade_operation_declares_a_required_idempotency_key_header(schema) -> None:
    parameters = schema["paths"][UPGRADE_PATH]["post"]["parameters"]
    header = next(item for item in parameters if item["in"] == "header")

    assert header["name"] == "Idempotency-Key"
    assert header["required"] is True


def test_asset_catalog_operation_declares_bounded_paging_parameters(schema) -> None:
    parameters = {
        item["name"]: item
        for item in schema["paths"][ASSETS_PATH]["get"]["parameters"]
        if item["in"] == "query"
    }

    assert parameters["limit"]["schema"]["maximum"] == 50
    assert parameters["limit"]["schema"]["minimum"] == 1
    assert parameters["cursor"]["required"] is False


def test_schema_publishes_every_project_scoped_render_operation(schema) -> None:
    assert list(schema["paths"]["/api/v1/projects/{project_id}/render-capability"]) == ["get"]
    assert sorted(schema["paths"][RENDER_JOBS_PATH]) == ["get", "post"]
    assert list(schema["paths"][RENDER_JOB_PATH]) == ["get"]
    assert list(schema["paths"][f"{RENDER_JOB_PATH}/cancel"]) == ["post"]
    assert list(schema["paths"][f"{RENDER_JOB_PATH}/retry"]) == ["post"]
    assert list(schema["paths"][f"{RENDER_JOB_PATH}/output"]) == ["get"]
    assert list(schema["paths"][f"{RENDER_JOB_PATH}/artifacts"]) == ["delete"]


def test_no_private_renderer_route_is_published(schema) -> None:
    assert [path for path in schema["paths"] if "/internal/" in path] == []


@pytest.mark.parametrize("path", [RENDER_JOBS_PATH, f"{RENDER_JOB_PATH}/retry"])
def test_render_creation_declares_a_required_idempotency_key_header(schema, path: str) -> None:
    parameters = schema["paths"][path]["post"]["parameters"]
    header = next(item for item in parameters if item["in"] == "header")

    assert header["name"] == "Idempotency-Key"
    assert header["required"] is True


def test_render_history_declares_bounded_paging_parameters(schema) -> None:
    parameters = {
        item["name"]: item
        for item in schema["paths"][RENDER_JOBS_PATH]["get"]["parameters"]
        if item["in"] == "query"
    }

    assert parameters["limit"]["schema"]["maximum"] == 50
    assert parameters["limit"]["schema"]["minimum"] == 1
    assert parameters["cursor"]["required"] is False


def test_render_creation_accepts_only_a_document_and_a_revision(schema) -> None:
    body = schema["paths"][RENDER_JOBS_PATH]["post"]["requestBody"]
    reference = body["content"]["application/json"]["schema"]["$ref"].rsplit("/", 1)[-1]
    definition = schema["components"]["schemas"][reference]

    assert set(definition["properties"]) == {"document_id", "document_revision"}
    assert definition["additionalProperties"] is False


def test_public_render_job_schema_exposes_only_safe_projection_fields(schema) -> None:
    properties = set(schema["components"]["schemas"]["RenderJobView"]["properties"])

    assert properties == {
        "render_job_id",
        "project_id",
        "document_id",
        "document_revision",
        "status",
        "progress_percent",
        "failure_code",
        "template_id",
        "template_version",
        "preset_id",
        "renderer_version",
        "retry_of_job_id",
        "created_at",
        "started_at",
        "finished_at",
        "cancel_requested_at",
        "artifacts_cleaned_at",
        "output",
    }


#: Never publishable: a server-side locator, a signing secret, or a connection string.
FORBIDDEN_NAMES = frozenset(
    {
        "artifact_location",
        "provenance",
        "signing_key",
        "preview_signing_key",
        "capability",
        "capability_token",
        "database_url",
        "output_relative_path",
        "dispatch_id",
        "last_event_sequence",
        "created_by",
        "codec",
        "renderer_url",
        "artifact_root",
        "composition_id",
    }
)


@pytest.mark.parametrize(
    "forbidden",
    [
        "THOTH_EDITOR_PREVIEW_SIGNING_KEY",
        "THOTH_EDITOR_DATABASE_URL",
        "postgresql://",
        "THOTH_RENDERER_INTERNAL_URL",
        "THOTH_RENDERER_INTERNAL_CREDENTIAL",
        "THOTH_CONTROL_PLANE_ARTIFACT_ROOT",
        "/internal/",
    ],
)
def test_schema_never_publishes_a_secret_value(schema, forbidden: str) -> None:
    assert forbidden not in json.dumps(schema)


def test_no_published_schema_declares_a_server_side_field(schema) -> None:
    published = {
        name
        for definition in schema["components"]["schemas"].values()
        for name in definition.get("properties", {})
    }

    assert published & FORBIDDEN_NAMES == set()


def test_public_asset_schema_exposes_only_safe_projection_fields(schema) -> None:
    properties = set(schema["components"]["schemas"]["EditorAsset"]["properties"])

    assert properties == {
        "asset_id",
        "project_id",
        "kind",
        "media_type",
        "duration_in_frames",
        "width",
        "height",
        "fps",
        "has_audio",
        "validation_state",
        "checksum",
    }
