"""Contract tests for the project-scoped render-job endpoints.

The route layer owns exactly three things: creator authentication and project
scoping, a fixed safe code for every failure, and a response that carries no
server-side identity. Lifecycle behaviour itself belongs to the application
service and is proven in `tests/application/test_render_jobs.py`.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.application.render_bundles import RenderBundleInvalid
from thoth_control_plane.application.render_job_ports import (
    ArtifactUnavailable,
    InvalidRenderCursor,
    RenderBusy,
    RendererNotConfigured,
    RendererUnavailable,
    RenderIdempotencyConflict,
    RenderJobNotCancellable,
    RenderJobNotCleanable,
    RenderJobNotFound,
    RenderJobNotRetryable,
    RenderPersistenceError,
)
from thoth_control_plane.application.render_jobs import DownloadableRender
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.render_jobs import RenderCapability, RenderJob, RenderJobPage

AUTH_HEADERS = {"Authorization": "Bearer test-key"}
IDEMPOTENT_HEADERS = {**AUTH_HEADERS, "Idempotency-Key": "key-001"}
BASE_URL = "/api/v1/projects/project_001"
JOB_URL = f"{BASE_URL}/render-jobs/rj_001"
CREATE_BODY = {"document_id": "doc_001", "document_revision": 3}
NOW = datetime(2026, 9, 20, 10, 0, tzinfo=UTC)
CHECKSUM = "sha256:" + "b" * 64


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
        "status": "preparing",
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


OUTPUT_FACTS = {
    "media_type": "video/mp4",
    "size_bytes": 2048,
    "checksum": CHECKSUM,
    "codec": "h264",
    "width": 1080,
    "height": 1920,
    "fps": 30.0,
    "duration_seconds": 12.5,
    "has_audio": True,
}


def completed_job(path: str = "renders/rj_001/output.mp4") -> RenderJob:
    return render_job(
        status="completed",
        finished_at=NOW,
        last_event_sequence=4,
        output_relative_path=path,
        output=OUTPUT_FACTS,
        provenance={
            "document_revision": 3,
            "template_id": "vertical_text_story",
            "template_version": 1,
            "preset_id": "standard_vertical_mp4_v1",
            "renderer_version": "remotion-4.0.523",
            "output": OUTPUT_FACTS,
        },
    )


class StubRenderJobService:
    """Answer every route call with a recorded result or one fixed failure."""

    def __init__(self, error: Exception | None = None, job: RenderJob | None = None) -> None:
        self.error = error
        self.job = job or render_job()
        self.download: DownloadableRender | None = None
        self.calls: list[tuple[str, object]] = []

    def _answer(self, name: str, arguments: object) -> RenderJob:
        self.calls.append((name, arguments))
        if self.error is not None:
            raise self.error
        return self.job

    async def capability(self, project_id: str) -> RenderCapability:
        self.calls.append(("capability", project_id))
        return RenderCapability.model_validate(
            {
                "available": True,
                "reason": None,
                "preset_id": "standard_vertical_mp4_v1",
                "renderer_version": "remotion-4.0.523",
                "active_render_job_id": None,
            }
        )

    async def create(
        self, *, project_id: str, actor_id: str, request: object, idempotency_key: str
    ) -> RenderJob:
        return self._answer("create", (project_id, actor_id, request, idempotency_key))

    async def retry(
        self, project_id: str, actor_id: str, render_job_id: str, idempotency_key: str
    ) -> RenderJob:
        return self._answer("retry", (project_id, actor_id, render_job_id, idempotency_key))

    async def get(self, project_id: str, render_job_id: str) -> RenderJob:
        return self._answer("get", (project_id, render_job_id))

    async def list(self, project_id: str, request: object) -> RenderJobPage:
        self.calls.append(("list", (project_id, request)))
        if self.error is not None:
            raise self.error
        return RenderJobPage(jobs=(self.job,), next_cursor="Y3Vyc29yXzAwMQ==")

    async def cancel(self, project_id: str, render_job_id: str) -> RenderJob:
        return self._answer("cancel", (project_id, render_job_id))

    async def cleanup(self, project_id: str, render_job_id: str) -> RenderJob:
        return self._answer("cleanup", (project_id, render_job_id))

    async def output_path(self, project_id: str, render_job_id: str) -> DownloadableRender:
        self.calls.append(("output_path", (project_id, render_job_id)))
        if self.error is not None:
            raise self.error
        assert self.download is not None
        return self.download

    async def reconcile_expired(self, now: datetime) -> int:
        self.calls.append(("reconcile_expired", now))
        return 0


def render_app(gateway, service: StubRenderJobService):
    return create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"),
        gateway,
        render_job_service=service,
    )


def client(gateway, service: StubRenderJobService) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=render_app(gateway, service))
    return httpx.AsyncClient(transport=transport, base_url="http://test")


# --- authentication and scoping ------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "url"),
    [
        ("GET", f"{BASE_URL}/render-capability"),
        ("POST", f"{BASE_URL}/render-jobs"),
        ("GET", f"{BASE_URL}/render-jobs"),
        ("GET", JOB_URL),
        ("POST", f"{JOB_URL}/cancel"),
        ("POST", f"{JOB_URL}/retry"),
        ("GET", f"{JOB_URL}/output"),
        ("DELETE", f"{JOB_URL}/artifacts"),
    ],
)
async def test_every_render_route_refuses_an_unauthenticated_caller(
    gateway, method: str, url: str
) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.request(method, url, json=CREATE_BODY)

    assert response.status_code == 403
    assert service.calls == []


@pytest.mark.asyncio
async def test_a_route_passes_the_path_project_to_the_service(gateway) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        await http.get("/api/v1/projects/project_042/render-jobs/rj_001", headers=AUTH_HEADERS)

    assert service.calls == [("get", ("project_042", "rj_001"))]


# --- capability -----------------------------------------------------------


@pytest.mark.asyncio
async def test_capability_publishes_only_safe_installation_facts(gateway) -> None:
    async with client(gateway, StubRenderJobService()) as http:
        response = await http.get(f"{BASE_URL}/render-capability", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert set(response.json()) == {
        "available",
        "reason",
        "preset_id",
        "renderer_version",
        "active_render_job_id",
    }


# --- create ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_refuses_a_request_without_an_idempotency_key(gateway) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.post(
            f"{BASE_URL}/render-jobs", json=CREATE_BODY, headers=AUTH_HEADERS
        )

    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "missing_idempotency_key"}
    assert service.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"document_id": "doc_001", "document_revision": 0},
        {"document_id": "doc_001", "document_revision": "3"},
        {"document_id": "doc_001"},
        {"document_id": "doc_001", "document_revision": 3, "preset_id": "other"},
        {"document_id": "doc_001", "document_revision": 3, "composition_id": "other"},
        {"document_id": "doc_001", "document_revision": 3, "codec": "vp9"},
    ],
)
async def test_create_accepts_only_a_document_and_a_positive_revision(
    gateway, body: dict[str, object]
) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.post(f"{BASE_URL}/render-jobs", json=body, headers=IDEMPOTENT_HEADERS)

    assert response.status_code == 422
    assert service.calls == []


@pytest.mark.asyncio
async def test_create_returns_the_persisted_job_without_server_side_identity(gateway) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.post(
            f"{BASE_URL}/render-jobs", json=CREATE_BODY, headers=IDEMPOTENT_HEADERS
        )

    assert response.status_code == 201
    body = response.json()
    assert body["render_job_id"] == "rj_001"
    assert body["status"] == "preparing"
    assert (
        set(body)
        & {
            "dispatch_id",
            "provenance",
            "output_relative_path",
            "created_by",
            "last_event_sequence",
        }
        == set()
    )


@pytest.mark.asyncio
async def test_create_forwards_the_idempotency_key_it_was_given(gateway) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        await http.post(f"{BASE_URL}/render-jobs", json=CREATE_BODY, headers=IDEMPOTENT_HEADERS)

    name, arguments = service.calls[0]
    assert name == "create"
    assert arguments[0] == "project_001"
    assert arguments[3] == "key-001"


@pytest.mark.asyncio
async def test_create_refuses_one_key_reused_for_a_different_render(gateway) -> None:
    service = StubRenderJobService(RenderIdempotencyConflict())
    async with client(gateway, service) as http:
        response = await http.post(
            f"{BASE_URL}/render-jobs", json=CREATE_BODY, headers=IDEMPOTENT_HEADERS
        )

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "idempotency_conflict"}


@pytest.mark.asyncio
async def test_a_busy_installation_never_names_another_project_job(gateway) -> None:
    service = StubRenderJobService(
        RenderBusy(active_render_job_id="rj_secret", active_project_id="project_999")
    )
    async with client(gateway, service) as http:
        response = await http.post(
            f"{BASE_URL}/render-jobs", json=CREATE_BODY, headers=IDEMPOTENT_HEADERS
        )

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "render_busy"}
    assert "rj_secret" not in response.text
    assert "project_999" not in response.text


@pytest.mark.asyncio
async def test_create_reports_an_unconfigured_renderer_as_a_fixed_degradation(gateway) -> None:
    service = StubRenderJobService(RendererNotConfigured())
    async with client(gateway, service) as http:
        response = await http.post(
            f"{BASE_URL}/render-jobs", json=CREATE_BODY, headers=IDEMPOTENT_HEADERS
        )

    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "renderer_not_configured"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (RenderBundleInvalid(), 422, "render_document_invalid"),
        (ArtifactUnavailable(), 409, "render_preparation_failed"),
        (RendererUnavailable(), 503, "render_dispatch_failed"),
        (RenderPersistenceError(), 503, "render_unavailable"),
    ],
)
async def test_create_maps_every_preparation_failure_to_a_fixed_code(
    gateway, error: Exception, status_code: int, code: str
) -> None:
    service = StubRenderJobService(error)
    async with client(gateway, service) as http:
        response = await http.post(
            f"{BASE_URL}/render-jobs", json=CREATE_BODY, headers=IDEMPOTENT_HEADERS
        )

    assert response.status_code == status_code
    assert response.json()["detail"] == {"code": code}
    assert str(error) not in response.text


# --- read -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_history_returns_one_bounded_safe_page(gateway) -> None:
    service = StubRenderJobService(job=completed_job())
    async with client(gateway, service) as http:
        response = await http.get(f"{BASE_URL}/render-jobs?limit=20", headers=AUTH_HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"jobs", "next_cursor"}
    assert body["next_cursor"] == "Y3Vyc29yXzAwMQ=="
    assert "renders/rj_001/output.mp4" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["?limit=0", "?limit=51", "?limit=abc", "?cursor="])
async def test_history_refuses_an_out_of_bounds_page_request(gateway, query: str) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.get(f"{BASE_URL}/render-jobs{query}", headers=AUTH_HEADERS)

    assert response.status_code == 422
    assert service.calls == []


@pytest.mark.asyncio
async def test_history_refuses_a_cursor_this_server_never_issued(gateway) -> None:
    service = StubRenderJobService(InvalidRenderCursor())
    async with client(gateway, service) as http:
        response = await http.get(f"{BASE_URL}/render-jobs?cursor=nope", headers=AUTH_HEADERS)

    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "invalid_render_cursor"}


@pytest.mark.asyncio
async def test_reading_a_job_outside_the_project_is_not_found(gateway) -> None:
    service = StubRenderJobService(RenderJobNotFound())
    async with client(gateway, service) as http:
        response = await http.get(JOB_URL, headers=AUTH_HEADERS)

    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "render_job_not_found"}


@pytest.mark.asyncio
async def test_a_completed_job_publishes_output_facts_without_a_path(gateway) -> None:
    service = StubRenderJobService(job=completed_job())
    async with client(gateway, service) as http:
        response = await http.get(JOB_URL, headers=AUTH_HEADERS)

    output = response.json()["output"]
    assert output["size_bytes"] == 2048
    assert output["checksum"] == CHECKSUM
    assert set(output) == {
        "media_type",
        "size_bytes",
        "checksum",
        "width",
        "height",
        "fps",
        "duration_seconds",
        "has_audio",
    }


# --- cancel and retry -----------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_returns_the_recorded_request(gateway) -> None:
    service = StubRenderJobService(job=render_job(status="rendering", cancel_requested_at=NOW))
    async with client(gateway, service) as http:
        response = await http.post(f"{JOB_URL}/cancel", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["cancel_requested_at"] is not None
    assert service.calls == [("cancel", ("project_001", "rj_001"))]


@pytest.mark.asyncio
async def test_cancel_refuses_to_reopen_a_finished_job(gateway) -> None:
    service = StubRenderJobService(RenderJobNotCancellable())
    async with client(gateway, service) as http:
        response = await http.post(f"{JOB_URL}/cancel", headers=AUTH_HEADERS)

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "render_job_not_cancellable"}


@pytest.mark.asyncio
async def test_retry_requires_its_own_idempotency_key(gateway) -> None:
    service = StubRenderJobService()
    async with client(gateway, service) as http:
        response = await http.post(f"{JOB_URL}/retry", headers=AUTH_HEADERS)

    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "missing_idempotency_key"}
    assert service.calls == []


@pytest.mark.asyncio
async def test_retry_starts_a_new_job_for_the_same_revision(gateway) -> None:
    service = StubRenderJobService(job=render_job(render_job_id="rj_002", retry_of_job_id="rj_001"))
    async with client(gateway, service) as http:
        response = await http.post(f"{JOB_URL}/retry", headers=IDEMPOTENT_HEADERS)

    assert response.status_code == 201
    assert response.json()["render_job_id"] == "rj_002"
    assert response.json()["retry_of_job_id"] == "rj_001"


@pytest.mark.asyncio
async def test_retry_refuses_a_job_that_has_not_finished(gateway) -> None:
    service = StubRenderJobService(RenderJobNotRetryable())
    async with client(gateway, service) as http:
        response = await http.post(f"{JOB_URL}/retry", headers=IDEMPOTENT_HEADERS)

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "render_job_not_retryable"}


# --- output ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_output_streams_the_authenticated_file_with_fixed_media_facts(
    gateway, tmp_path: Path
) -> None:
    media = tmp_path / "output.mp4"
    media.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 24)
    service = StubRenderJobService(job=completed_job())
    service.download = DownloadableRender(
        path=media,
        media_type="video/mp4",
        filename="rj_001.mp4",
        size_bytes=media.stat().st_size,
        checksum=CHECKSUM,
    )
    async with client(gateway, service) as http:
        response = await http.get(f"{JOB_URL}/output", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.headers["content-type"] == "video/mp4"
    assert response.headers["content-disposition"] == 'attachment; filename="rj_001.mp4"'
    assert response.headers["content-length"] == str(media.stat().st_size)
    assert response.headers["x-thoth-render-checksum"] == CHECKSUM
    assert response.headers["cache-control"] == "private, no-store"
    assert "location" not in response.headers
    assert response.content == media.read_bytes()
    assert str(tmp_path) not in str(response.headers)


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ArtifactUnavailable(), RenderJobNotFound()])
async def test_output_is_not_found_when_no_render_was_published(gateway, error: Exception) -> None:
    service = StubRenderJobService(error)
    async with client(gateway, service) as http:
        response = await http.get(f"{JOB_URL}/output", headers=AUTH_HEADERS)

    assert response.status_code == 404
    assert response.json()["detail"]["code"] in {
        "render_output_unavailable",
        "render_job_not_found",
    }


# --- cleanup --------------------------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_keeps_the_audit_row_it_returns(gateway) -> None:
    service = StubRenderJobService(
        job=completed_job().model_copy(update={"artifacts_cleaned_at": NOW})
    )
    async with client(gateway, service) as http:
        response = await http.delete(f"{JOB_URL}/artifacts", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["artifacts_cleaned_at"] is not None
    assert service.calls == [("cleanup", ("project_001", "rj_001"))]


@pytest.mark.asyncio
async def test_cleanup_refuses_a_job_a_renderer_may_still_be_writing(gateway) -> None:
    service = StubRenderJobService(RenderJobNotCleanable())
    async with client(gateway, service) as http:
        response = await http.delete(f"{JOB_URL}/artifacts", headers=AUTH_HEADERS)

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "render_job_not_cleanable"}


# --- degradation ----------------------------------------------------------


@pytest.mark.asyncio
async def test_an_app_without_a_renderer_still_serves_capability(gateway) -> None:
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.get(f"{BASE_URL}/render-capability", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["available"] is False
    assert response.json()["reason"] == "renderer_not_configured"


@pytest.mark.asyncio
async def test_no_render_response_carries_a_local_path_or_credential(gateway) -> None:
    service = StubRenderJobService(job=completed_job())
    async with client(gateway, service) as http:
        history = await http.get(f"{BASE_URL}/render-jobs", headers=AUTH_HEADERS)
        job = await http.get(JOB_URL, headers=AUTH_HEADERS)

    for response in (history, job):
        payload = json.dumps(response.json())
        assert "renders/" not in payload
        assert "work/" not in payload
        assert "temp/" not in payload
        assert "http://" not in payload
