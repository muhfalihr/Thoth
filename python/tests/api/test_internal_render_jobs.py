"""Contract tests for the private renderer protocol.

These routes exist only for the isolated renderer: they never appear in the
public schema, they accept only the shared internal credential, and the creator
API key must not open them.
"""

from __future__ import annotations

import inspect
import json
from datetime import UTC, datetime

import httpx
import pytest

from thoth_control_plane.api import create_app, dependencies
from thoth_control_plane.application.render_job_ports import (
    ArtifactUnavailable,
    RenderJobNotFound,
    RenderPersistenceError,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.render_jobs import RenderJob, RenderJobEvent

INTERNAL_HEADERS = {"Authorization": "Bearer internal-secret"}
CREATOR_HEADERS = {"Authorization": "Bearer test-key"}
BUNDLE_URL = "/internal/render-jobs/rj_001/bundle"
EVENTS_URL = "/internal/render-jobs/rj_001/events"
NOW = datetime(2026, 9, 20, 10, 0, tzinfo=UTC)
BUNDLE_BYTES = json.dumps({"bundle_version": 1, "render_job_id": "rj_001"}).encode("utf-8")
EVENT_BODY = {
    "render_job_id": "rj_001",
    "dispatch_id": "dsp_001",
    "sequence": 2,
    "status": "rendering",
    "progress_percent": 40,
    "occurred_at": "2026-09-20T10:00:00Z",
}


def render_job(**overrides: object) -> RenderJob:
    payload: dict[str, object] = {
        "render_job_id": "rj_001",
        "project_id": "project_001",
        "document_id": "doc_001",
        "document_revision": 3,
        "dispatch_id": "dsp_001",
        "template_id": "vertical_text_story",
        "template_version": 1,
        "preset_id": "standard_vertical_mp4_v1",
        "renderer_version": "remotion-4.0.523",
        "status": "rendering",
        "last_event_sequence": 2,
        "created_by": "owner",
        "created_at": NOW,
        "provenance": {
            "document_revision": 3,
            "template_id": "vertical_text_story",
            "template_version": 1,
            "preset_id": "standard_vertical_mp4_v1",
            "renderer_version": "remotion-4.0.523",
        },
    }
    payload.update(overrides)
    return RenderJob.model_validate(payload)


class StubRenderJobService:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.job = render_job()
        self.events: list[RenderJobEvent] = []
        self.bundles: list[str] = []

    async def bundle(self, render_job_id: str) -> bytes:
        self.bundles.append(render_job_id)
        if self.error is not None:
            raise self.error
        return BUNDLE_BYTES

    async def ingest_event(self, render_job_id: str, event: RenderJobEvent) -> RenderJob:
        self.events.append(event)
        if self.error is not None:
            raise self.error
        return self.job

    async def reconcile_expired(self, now: datetime) -> int:
        return 0


def internal_settings() -> Settings:
    return Settings(
        THOTH_CONTROL_PLANE_API_KEY="test-key",
        THOTH_RENDERER_INTERNAL_URL="http://renderer.internal:9000",
        THOTH_RENDERER_INTERNAL_CREDENTIAL="internal-secret",
    )


def client(
    gateway, service: StubRenderJobService, settings: Settings | None = None
) -> httpx.AsyncClient:
    app = create_app(settings or internal_settings(), gateway, render_job_service=service)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


# --- authentication -------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [BUNDLE_URL, EVENTS_URL])
@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer wrong-secret"},
        {"Authorization": "internal-secret"},
        {"Authorization": "Basic internal-secret"},
    ],
)
async def test_a_private_route_refuses_anything_but_the_internal_credential(
    gateway, url: str, headers: dict[str, str]
) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.request(
            "GET" if url == BUNDLE_URL else "POST", url, headers=headers, json=EVENT_BODY
        )

    assert response.status_code == 403
    assert service.bundles == []
    assert service.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [BUNDLE_URL, EVENTS_URL])
async def test_the_creator_api_key_never_opens_a_private_route(gateway, url: str) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.request(
            "GET" if url == BUNDLE_URL else "POST", url, headers=CREATOR_HEADERS, json=EVENT_BODY
        )

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_a_private_route_is_closed_when_no_renderer_is_configured(gateway) -> None:
    settings = Settings(THOTH_CONTROL_PLANE_API_KEY="test-key")
    async with client(gateway, StubRenderJobService(), settings) as http:
        response = await http.get(BUNDLE_URL, headers=INTERNAL_HEADERS)

    assert response.status_code == 403


def test_the_internal_credential_is_compared_in_constant_time() -> None:
    source = inspect.getsource(dependencies)

    assert "compare_digest" in source


# --- bundle ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_renderer_reads_the_immutable_bundle_it_was_dispatched(gateway) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.get(BUNDLE_URL, headers=INTERNAL_HEADERS)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.content == BUNDLE_BYTES
    assert service.bundles == ["rj_001"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (RenderJobNotFound(), 404, "render_job_not_found"),
        (ArtifactUnavailable(), 404, "render_bundle_unavailable"),
        (RenderPersistenceError(), 503, "render_unavailable"),
    ],
)
async def test_a_missing_bundle_answers_with_a_fixed_code(
    gateway, error: Exception, status_code: int, code: str
) -> None:
    async with client(gateway, StubRenderJobService(error)) as http:
        response = await http.get(BUNDLE_URL, headers=INTERNAL_HEADERS)

    assert response.status_code == status_code
    assert response.json()["detail"] == {"code": code}


# --- events ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_accepted_event_is_acknowledged_with_authoritative_state(gateway) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.post(EVENTS_URL, json=EVENT_BODY, headers=INTERNAL_HEADERS)

    assert response.status_code == 200
    assert response.json() == {"status": "rendering", "last_event_sequence": 2}
    assert service.events[0].sequence == 2
    assert service.events[0].progress_percent == 40


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {**EVENT_BODY, "render_job_id": "rj_other"},
        {**EVENT_BODY, "output_relative_path": "../../etc/passwd"},
        {**EVENT_BODY, "command": "ffmpeg -y"},
        {**EVENT_BODY, "stderr": "boom"},
        {**EVENT_BODY, "status": "unknown"},
        {**EVENT_BODY, "sequence": 0},
        {**EVENT_BODY, "progress_percent": 101},
        {**EVENT_BODY, "failure_code": "made_up"},
        {k: v for k, v in EVENT_BODY.items() if k != "occurred_at"},
    ],
)
async def test_an_event_body_outside_the_contract_is_refused(
    gateway, body: dict[str, object]
) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.post(EVENTS_URL, json=body, headers=INTERNAL_HEADERS)

    assert response.status_code == 422
    assert service.events == []


@pytest.mark.asyncio
async def test_a_completion_event_may_carry_verified_output_facts(gateway) -> None:
    service = StubRenderJobService()
    body = {
        **EVENT_BODY,
        "sequence": 5,
        "status": "completed",
        "progress_percent": 100,
        "output": {
            "media_type": "video/mp4",
            "size_bytes": 4096,
            "checksum": "sha256:" + "c" * 64,
            "codec": "h264",
            "width": 1080,
            "height": 1920,
            "fps": 30.0,
            "duration_seconds": 8.0,
            "has_audio": False,
        },
    }
    async with client(gateway, service) as http:
        response = await http.post(EVENTS_URL, json=body, headers=INTERNAL_HEADERS)

    assert response.status_code == 200
    assert service.events[0].output is not None
    assert service.events[0].output.size_bytes == 4096


@pytest.mark.asyncio
async def test_an_event_for_an_unknown_job_is_not_found(gateway) -> None:
    async with client(gateway, StubRenderJobService(RenderJobNotFound())) as http:
        response = await http.post(EVENTS_URL, json=EVENT_BODY, headers=INTERNAL_HEADERS)

    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "render_job_not_found"}


# --- isolation ------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_private_route_reaches_the_public_schema(gateway) -> None:
    schema = create_app(
        internal_settings(), gateway, render_job_service=StubRenderJobService()
    ).openapi()

    assert [path for path in schema["paths"] if path.startswith("/internal/")] == []
    assert "internal-secret" not in json.dumps(schema)
