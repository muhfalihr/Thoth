from __future__ import annotations

import httpx
import pytest

from thoth_control_plane.config import Settings
from thoth_control_plane.domain import Actor
from thoth_control_plane.infrastructure.event_store import LegacyEventStore
from thoth_control_plane.infrastructure.legacy_reader import LegacyJobMappingError, LegacyJobReader


def legacy_job(
    *, status: str = "running", stage: str = "scout", pct: float = 0.5
) -> dict[str, object]:
    return {
        "id": "job_123",
        "spec": {"command": "run", "url": "https://example.test/post?signature=secret"},
        "status": status,
        "stage": stage,
        "pct": pct,
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


def mock_client_with_job(**job_values: object) -> httpx.AsyncClient:
    payload = legacy_job(**job_values)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/jobs/job_123"
        return httpx.Response(200, json=payload)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://legacy.test")


class RecordingTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/api/jobs/job_123":
            return httpx.Response(200, json=legacy_job(), request=request)
        return httpx.Response(404, request=request)


@pytest.mark.asyncio
async def test_reader_maps_a_legacy_job_without_exposing_output_path() -> None:
    """Changing the safe stage map or source sanitization must fail this test."""
    reader = LegacyJobReader(client=mock_client_with_job(status="running", stage="scout", pct=0.5))

    summary = await reader.get_summary("job_123", actor=Actor(actor_id="owner", actor_type="user"))

    assert summary.workflow_id == "legacy_job_123"
    assert summary.status == "running"
    assert summary.stages[0].label == "Finding the original source"
    assert summary.stages[0].progress == 0.5
    serialized = summary.model_dump_json()
    assert "output_dir" not in serialized
    assert "private" not in serialized
    assert "signature" not in serialized


@pytest.mark.asyncio
async def test_reader_uses_only_get_requests() -> None:
    """Changing the bridge to call a mutation route must fail this test."""
    transport = RecordingTransport()
    reader = LegacyJobReader(
        client=httpx.AsyncClient(transport=transport, base_url="http://legacy.test")
    )

    await reader.get_summary("job_123", actor=Actor(actor_id="owner", actor_type="user"))

    assert {request.method for request in transport.requests} == {"GET"}
    assert [request.url.path for request in transport.requests] == ["/api/jobs/job_123"]


@pytest.mark.asyncio
async def test_reader_rejects_an_unsafe_legacy_job_id_before_making_a_request() -> None:
    """Removing the opaque-ID guard must fail this boundary test."""
    transport = RecordingTransport()
    reader = LegacyJobReader(
        client=httpx.AsyncClient(transport=transport, base_url="http://legacy.test")
    )

    with pytest.raises(LegacyJobMappingError):
        await reader.get_summary("../jobs", actor=Actor(actor_id="owner", actor_type="user"))

    assert transport.requests == []


@pytest.mark.asyncio
async def test_reader_orders_replayed_events_by_their_legacy_sequence() -> None:
    """Returning source transport order instead of sequence order must fail this test."""
    stream = "\n".join(
        (
            (
                'data: {"seq":3,"job_id":"job_123","type":"done","stage":null,'
                '"pct":null,"message":null,"ts":"2026-08-28T08:04:00Z"}'
            ),
            "",
            (
                'data: {"seq":2,"job_id":"job_123","type":"progress","stage":"render",'
                '"pct":0.75,"message":null,"ts":"2026-08-28T08:03:00Z"}'
            ),
            "",
        )
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=stream, request=request)

    reader = LegacyJobReader(
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://legacy.test"
        )
    )
    events = [event async for event in reader.iter_events("job_123", 0)]

    assert [event.sequence for event in events] == [2, 3]


@pytest.mark.asyncio
async def test_event_replay_emits_one_snapshot_then_unseen_normalized_events() -> None:
    """Removing the snapshot or replay cursor translation must fail this test."""
    stream = "\n".join(
        (
            "id: 2",
            (
                'data: {"seq":2,"job_id":"job_123","type":"progress","stage":"render",'
                '"pct":0.75,"message":null,"ts":"2026-08-28T08:03:00Z"}'
            ),
            "",
            "id: 3",
            (
                'data: {"seq":3,"job_id":"job_123","type":"done","stage":"render",'
                '"pct":1.0,"message":"output at C:\\\\private\\\\done.mp4",'
                '"ts":"2026-08-28T08:04:00Z"}'
            ),
            "",
        )
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/jobs/job_123":
            return httpx.Response(200, json=legacy_job(), request=request)
        if request.url.path == "/api/jobs/job_123/stream":
            return httpx.Response(200, text=stream, request=request)
        return httpx.Response(404, request=request)

    reader = LegacyJobReader(
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://legacy.test"
        )
    )
    store = LegacyEventStore(reader)

    actor = Actor(actor_id="owner", actor_type="user")
    events = [event async for event in store.replay("job_123", actor, 0)]
    reconnected = [event async for event in store.replay("job_123", actor, 3)]

    assert [(event.sequence, event.kind) for event in events] == [
        (1, "workflow.started"),
        (3, "stage.progress"),
        (4, "workflow.completed"),
    ]
    assert [(event.sequence, event.kind) for event in reconnected] == [(4, "workflow.completed")]
    assert "private" not in events[-1].model_dump_json()


def test_legacy_bridge_is_enabled_only_for_a_complete_nonblank_configuration() -> None:
    """Accepting one or blank bridge credential must fail this test."""
    disabled = Settings(THOTH_CONTROL_PLANE_API_KEY="control-key")
    enabled = Settings(
        THOTH_CONTROL_PLANE_API_KEY="control-key",
        THOTH_LEGACY_API_BASE_URL="https://legacy.test",
        THOTH_LEGACY_API_KEY="legacy-key",
    )

    assert disabled.legacy_bridge_enabled is False
    assert enabled.legacy_bridge_enabled is True
    with pytest.raises(ValueError, match="configured together"):
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="control-key",
            THOTH_LEGACY_API_BASE_URL="https://legacy.test",
        )
    with pytest.raises(ValueError, match="configured together"):
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="control-key",
            THOTH_LEGACY_API_BASE_URL="https://legacy.test",
            THOTH_LEGACY_API_KEY="",
        )
