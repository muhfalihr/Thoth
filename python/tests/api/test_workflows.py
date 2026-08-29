from pathlib import Path

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.config import Settings
from thoth_control_plane.infrastructure.legacy_reader import LegacyJobReader

VALID_REQUEST = {
    "source": {"url": "https://example.test/post", "intent": "identify_original"},
    "style": {"preset_id": "news-vertical"},
    "output": {"format": "vertical_video", "language": "id"},
    "review": {"require_publish_approval": True},
}
AUTH_HEADERS = {"Authorization": "Bearer test-key"}


@pytest.mark.asyncio
async def test_create_workflow_returns_accepted_v1_summary(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=VALID_REQUEST,
    )

    assert response.status_code == 202
    assert response.headers["X-Thoth-Contract-Version"] == "1"
    assert response.json()["status"] == "queued"


@pytest.mark.asyncio
async def test_style_presets_expose_display_data_not_executor_options(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/api/v1/style-presets", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json() == [
        {
            "preset_id": "news-vertical",
            "label": "News vertical",
            "description": "Fast-paced vertical news treatment",
        }
    ]


@pytest.mark.asyncio
async def test_get_workflow_returns_the_current_summary(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=VALID_REQUEST,
    )

    response = await client.get(
        f"/api/v1/workflows/{created.json()['workflow_id']}",
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    assert response.json()["workflow_id"] == "wf_001"


@pytest.mark.asyncio
async def test_cancel_workflow_returns_the_latest_summary(client: httpx.AsyncClient) -> None:
    await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=VALID_REQUEST,
    )

    response = await client.post("/api/v1/workflows/wf_001/cancel", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_retry_workflow_uses_the_requested_checkpoint(
    client: httpx.AsyncClient,
    gateway,
) -> None:
    await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=VALID_REQUEST,
    )

    response = await client.post(
        "/api/v1/workflows/wf_001/retry",
        headers=AUTH_HEADERS,
        json={"from_stage": "source"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert gateway.last_from_stage == "source"


@pytest.mark.asyncio
async def test_approve_workflow_records_the_authenticated_actor(
    client: httpx.AsyncClient,
    gateway,
) -> None:
    await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=VALID_REQUEST,
    )

    response = await client.post(
        "/api/v1/workflows/wf_001/approve",
        headers=AUTH_HEADERS,
        json={"approval_id": "apr_001", "decision": "approve", "note": "Continue"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "running"
    assert gateway.last_approval.approval_id == "apr_001"
    assert gateway.actors[-1].actor_id == "owner"


@pytest.mark.asyncio
async def test_idempotency_key_reuse_with_a_different_body_returns_conflict(
    client: httpx.AsyncClient,
) -> None:
    await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=VALID_REQUEST,
    )
    changed = {
        **VALID_REQUEST,
        "output": {"format": "vertical_video", "language": "en"},
    }

    response = await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=changed,
    )

    assert response.status_code == 409
    assert response.headers["X-Thoth-Contract-Version"] == "1"


@pytest.mark.asyncio
async def test_missing_workflow_returns_not_found(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/workflows/wf_missing", headers=AUTH_HEADERS)

    assert response.status_code == 404
    assert response.json() == {"detail": "Workflow not found"}


@pytest.mark.asyncio
async def test_disallowed_approval_returns_conflict(client: httpx.AsyncClient, gateway) -> None:
    await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json=VALID_REQUEST,
    )
    gateway.approval_allowed = False

    response = await client.post(
        "/api/v1/workflows/wf_001/approve",
        headers=AUTH_HEADERS,
        json={"approval_id": "apr_001", "decision": "approve"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Approval is not allowed"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer wrong-key"}, {"Authorization": "Basic test-key"}],
)
async def test_unauthorized_actor_is_forbidden(
    client: httpx.AsyncClient,
    headers: dict[str, str],
) -> None:
    response = await client.get("/api/v1/style-presets", headers=headers)

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_request_validation_rejects_actor_identity_in_json(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(
        "/api/v1/workflows",
        headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
        json={**VALID_REQUEST, "actor_id": "forged-owner"},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_approval_input_rejects_provider_payloads(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/v1/workflows/wf_001/approve",
        headers=AUTH_HEADERS,
        json={
            "approval_id": "apr_001",
            "decision": "approve",
            "provider_payload": {"token": "must-not-enter-contract"},
        },
    )

    assert response.status_code == 422


def test_route_modules_do_not_depend_on_a_process_runner() -> None:
    routes = Path("src/thoth_control_plane/api/routes")
    source = "\n".join(path.read_text(encoding="utf-8") for path in routes.glob("*.py"))
    lowered = source.lower()

    assert "Command(" not in source
    assert "subprocess" not in lowered
    assert "bun" not in lowered
    assert "scout" not in lowered
    assert "stdout" not in lowered
    assert '"thoth"' not in lowered
    assert "'thoth'" not in lowered
    assert "thoth.exe" not in lowered


def test_openapi_exposes_exact_required_path_method_pairs(gateway) -> None:
    document = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway).openapi()
    http_methods = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
    actual = {
        (path, method)
        for path, item in document["paths"].items()
        for method in item
        if method in http_methods
    }

    assert actual == {
        ("/api/v1/style-presets", "get"),
        ("/api/v1/workflows", "post"),
        ("/api/v1/workflows/{workflow_id}", "get"),
        ("/api/v1/workflows/{workflow_id}/cancel", "post"),
        ("/api/v1/workflows/{workflow_id}/retry", "post"),
        ("/api/v1/workflows/{workflow_id}/approve", "post"),
        ("/api/v1/legacy/jobs/{legacy_job_id}", "get"),
        ("/api/v1/legacy/jobs/{legacy_job_id}/events", "get"),
        ("/healthz", "get"),
        ("/readyz", "get"),
    }


def test_openapi_declares_workflow_create_as_accepted(gateway) -> None:
    document = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway).openapi()
    responses = document["paths"]["/api/v1/workflows"]["post"]["responses"]

    assert "202" in responses
    assert "200" not in responses


def test_openapi_approval_and_retry_inputs_are_narrow(gateway) -> None:
    document = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), gateway).openapi()
    schemas = document["components"]["schemas"]
    approval_operation = document["paths"]["/api/v1/workflows/{workflow_id}/approve"]["post"]
    retry_operation = document["paths"]["/api/v1/workflows/{workflow_id}/retry"]["post"]

    assert approval_operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ApprovalSubmission"
    }
    assert set(schemas["ApprovalSubmission"]["properties"]) == {
        "approval_id",
        "decision",
        "note",
    }
    assert schemas["ApprovalSubmission"]["additionalProperties"] is False
    assert set(schemas["ApprovalSubmission"]["required"]) == {"approval_id", "decision"}
    assert retry_operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/RetryRequest"
    }
    assert set(schemas["RetryRequest"]["properties"]) == {"from_stage"}
    assert schemas["RetryRequest"]["additionalProperties"] is False


@pytest.mark.asyncio
async def test_health_and_readiness_endpoints_emit_the_v1_contract_header(
    client: httpx.AsyncClient,
) -> None:
    health = await client.get("/healthz")
    readiness = await client.get("/readyz")

    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert readiness.status_code == 200
    assert readiness.json() == {"status": "ready"}
    assert health.headers["X-Thoth-Contract-Version"] == "1"
    assert readiness.headers["X-Thoth-Contract-Version"] == "1"


@pytest.mark.asyncio
async def test_readiness_checks_the_current_temporal_connection(
    client: httpx.AsyncClient,
    gateway,
) -> None:
    gateway.connection_available = False

    readiness = await client.get("/readyz")

    assert readiness.status_code == 503


@pytest.mark.asyncio
async def test_unbound_production_wiring_is_not_ready_and_cannot_start_work() -> None:
    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), None)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        readiness = await client.get("/readyz")
        started = await client.post(
            "/api/v1/workflows",
            headers={**AUTH_HEADERS, "Idempotency-Key": "create-001"},
            json=VALID_REQUEST,
        )

    assert readiness.status_code == 503
    assert started.status_code == 503


@pytest.mark.asyncio
async def test_legacy_observation_endpoints_replay_only_unseen_safe_events() -> None:
    """Removing the migration bridge cursor boundary must fail this test."""
    legacy_job = {
        "id": "job_123",
        "spec": {"command": "run", "url": "https://example.test/post?signature=secret"},
        "status": "running",
        "stage": "scout",
        "pct": 0.5,
        "error": None,
        "output_dir": "C:\\private\\output\\job_123",
        "worker_id": "worker-1",
        "cancel_requested": False,
        "created_at": "2026-08-28T08:00:00Z",
        "started_at": "2026-08-28T08:01:00Z",
        "finished_at": None,
        "heartbeat_at": "2026-08-28T08:02:00Z",
        "updated_at": "2026-08-28T08:02:00Z",
    }
    stream = (
        "id: 3\n"
        'data: {"seq":3,"job_id":"job_123","type":"done","stage":"render",'
        '"pct":1.0,"message":"C:\\\\private\\\\done.mp4",'
        '"ts":"2026-08-28T08:04:00Z"}\n\n'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/jobs/job_123":
            return httpx.Response(200, json=legacy_job, request=request)
        if request.url.path == "/api/jobs/job_123/stream":
            return httpx.Response(200, text=stream, request=request)
        return httpx.Response(404, request=request)

    app = create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), None)
    app.state.legacy_job_reader = LegacyJobReader(
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://legacy.test"
        )
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as test_client:
        summary = await test_client.get("/api/v1/legacy/jobs/job_123", headers=AUTH_HEADERS)
        replay = await test_client.get(
            "/api/v1/legacy/jobs/job_123/events",
            headers={**AUTH_HEADERS, "Last-Event-ID": "3"},
        )
        malformed = await test_client.get(
            "/api/v1/legacy/jobs/job_123/events",
            headers={**AUTH_HEADERS, "Last-Event-ID": "last"},
        )

    assert summary.status_code == 200
    assert "private" not in summary.text
    assert "signature" not in summary.text
    assert replay.status_code == 200
    assert "id: 4" in replay.text
    assert "workflow.completed" in replay.text
    assert "snapshot" not in replay.text
    assert malformed.status_code == 422
