"""Tests for the private, credentialed, single-request renderer gateway."""

from __future__ import annotations

import httpx
import pytest

from thoth_control_plane.application.render_job_ports import (
    RendererNotConfigured,
    RendererRejected,
    RendererUnavailable,
)
from thoth_control_plane.infrastructure.renderer_gateway import (
    HttpRendererGateway,
    UnavailableRendererGateway,
)

BASE_URL = "http://renderer.internal:8080"
CREDENTIAL = "internal-render-credential"
JOB = "rj_1"
DISPATCH = "dispatch_1"


class Recorder:
    """Answer every request with one scripted outcome and record the request."""

    def __init__(self, *, status: int = 202, error: Exception | None = None) -> None:
        self.status = status
        self.error = error
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return httpx.Response(self.status, json={"accepted": True})


def gateway(recorder: Recorder) -> HttpRendererGateway:
    return HttpRendererGateway(
        base_url=BASE_URL,
        credential=CREDENTIAL,
        transport=httpx.MockTransport(recorder.handle),
    )


@pytest.mark.asyncio
async def test_start_sends_one_authenticated_request_carrying_only_identity() -> None:
    recorder = Recorder()

    await gateway(recorder).start(render_job_id=JOB, dispatch_id=DISPATCH)

    assert len(recorder.requests) == 1
    request = recorder.requests[0]
    assert request.method == "POST"
    assert str(request.url) == f"{BASE_URL}/internal/render-jobs/{JOB}/start"
    assert request.headers["authorization"] == f"Bearer {CREDENTIAL}"
    body = request.content.decode("utf-8")
    assert '"dispatch_id":"dispatch_1"' in body.replace(" ", "")
    for forbidden in ("postgresql", "artifact", "path", "document", "project"):
        assert forbidden not in body


@pytest.mark.asyncio
async def test_cancel_sends_one_authenticated_request_with_no_body_detail() -> None:
    recorder = Recorder(status=200)

    await gateway(recorder).cancel(render_job_id=JOB)

    assert len(recorder.requests) == 1
    request = recorder.requests[0]
    assert str(request.url) == f"{BASE_URL}/internal/render-jobs/{JOB}/cancel"
    assert request.headers["authorization"] == f"Bearer {CREDENTIAL}"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 201, 202, 204])
async def test_any_success_status_is_accepted_once(status: int) -> None:
    recorder = Recorder(status=status)

    await gateway(recorder).start(render_job_id=JOB, dispatch_id=DISPATCH)

    assert len(recorder.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 404, 409, 422])
async def test_a_client_refusal_is_reported_as_a_fixed_rejection(status: int) -> None:
    recorder = Recorder(status=status)

    with pytest.raises(RendererRejected, match=r"^renderer rejected the dispatch$"):
        await gateway(recorder).start(render_job_id=JOB, dispatch_id=DISPATCH)

    assert len(recorder.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [500, 502, 503, 504])
async def test_a_server_failure_is_reported_as_unavailable_without_retrying(status: int) -> None:
    recorder = Recorder(status=status)

    with pytest.raises(RendererUnavailable, match=r"^renderer unavailable$"):
        await gateway(recorder).cancel(render_job_id=JOB)

    assert len(recorder.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("connect to 10.1.2.3:8080 failed"),
        httpx.ReadTimeout("read timed out on http://renderer.internal:8080"),
        httpx.RemoteProtocolError("server disconnected"),
    ],
)
async def test_a_transport_failure_never_echoes_the_underlying_message(
    error: Exception,
) -> None:
    recorder = Recorder(error=error)

    with pytest.raises(RendererUnavailable) as raised:
        await gateway(recorder).start(render_job_id=JOB, dispatch_id=DISPATCH)

    assert str(raised.value) == "renderer unavailable"
    assert "10.1.2.3" not in str(raised.value)
    assert len(recorder.requests) == 1


@pytest.mark.asyncio
async def test_a_redirect_is_never_followed() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(307, headers={"location": "http://attacker.test/steal"})

    dispatcher = HttpRendererGateway(
        base_url=BASE_URL,
        credential=CREDENTIAL,
        transport=httpx.MockTransport(handle),
    )

    with pytest.raises(RendererRejected):
        await dispatcher.start(render_job_id=JOB, dispatch_id=DISPATCH)


def test_the_gateway_is_bounded_and_never_follows_redirects() -> None:
    dispatcher = gateway(Recorder())

    assert dispatcher.follow_redirects_enabled is False
    assert 0 < dispatcher.request_timeout_seconds <= 30.0


def test_the_credential_never_appears_in_a_representation() -> None:
    dispatcher = gateway(Recorder())

    assert CREDENTIAL not in repr(dispatcher)
    assert CREDENTIAL not in str(dispatcher)


@pytest.mark.parametrize(
    "identifier",
    ["../job", "rj_1/../rj_2", "rj 1", "", "/absolute", "rj_1?x=1", "a" * 129],
)
def test_an_unsafe_job_identity_never_becomes_a_private_url(identifier: str) -> None:
    dispatcher = gateway(Recorder())

    with pytest.raises(RendererRejected):
        dispatcher.dispatch_url(identifier, "start")


@pytest.mark.asyncio
async def test_an_unconfigured_renderer_refuses_without_reaching_the_network() -> None:
    dispatcher = UnavailableRendererGateway()

    with pytest.raises(RendererNotConfigured, match=r"^renderer not configured$"):
        await dispatcher.start(render_job_id=JOB, dispatch_id=DISPATCH)
    with pytest.raises(RendererNotConfigured):
        await dispatcher.cancel(render_job_id=JOB)
