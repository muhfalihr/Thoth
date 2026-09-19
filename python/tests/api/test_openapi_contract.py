"""Guards on the public schema so no server-side locator or secret can be published."""

from __future__ import annotations

import json

import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.config import Settings

UPGRADE_PATH = "/api/v1/projects/{project_id}/edit-documents/{document_id}/upgrade-timeline"
ASSETS_PATH = "/api/v1/projects/{project_id}/editor-assets"


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
    }
)


@pytest.mark.parametrize(
    "forbidden", ["THOTH_EDITOR_PREVIEW_SIGNING_KEY", "THOTH_EDITOR_DATABASE_URL", "postgresql://"]
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
