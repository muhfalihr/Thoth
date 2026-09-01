import asyncio
import hashlib
from pathlib import PurePosixPath

import httpx
import pytest
from pydantic import SecretStr

import thoth_control_plane.acquisition.materializer as materializer_module
from thoth_control_plane.acquisition.materializer import (
    MAX_MEDIA_BYTES,
    MAX_REDIRECTS,
    MIN_MEDIA_BYTES,
    MediaMaterializationError,
    MediaMaterializer,
)
from thoth_control_plane.acquisition.models import ResolvedMedia

MP4_BODY = b"\x00\x00\x00\x18ftypmp42" + b"0" * 10_100


async def public_resolver(host: str) -> list[str]:
    del host
    return ["93.184.216.34"]


def media(url: str = "https://cdn.example/video.mp4") -> ResolvedMedia:
    return ResolvedMedia(ephemeral_url=SecretStr(url), media_type="video/mp4")


@pytest.mark.asyncio
async def test_materializer_streams_valid_mp4_and_atomically_renames(tmp_path) -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Content-Type": "video/mp4"},
            content=MP4_BODY,
            request=request,
        )
    )
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        result = await MediaMaterializer(client, public_resolver).materialize(
            media(),
            tmp_path / "media" / "tiktok-123.mp4",
            PurePosixPath("reports/wf_1/media/tiktok-123.mp4"),
            "scrapling_headless",
        )
    assert result.bytes == len(MP4_BODY)
    assert result.checksum == f"sha256:{hashlib.sha256(MP4_BODY).hexdigest()}"
    assert (tmp_path / "media" / "tiktok-123.mp4").read_bytes() == MP4_BODY
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_materializer_rejects_private_resolution_before_request(tmp_path) -> None:
    requests = 0

    async def private_resolver(host: str) -> list[str]:
        del host
        return ["127.0.0.1"]

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(200, content=MP4_BODY, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaMaterializationError, match="media_validation_failed"):
            await MediaMaterializer(client, private_resolver).materialize(
                media("https://localhost/video.mp4"),
                tmp_path / "blocked.mp4",
                PurePosixPath("reports/wf_1/media/blocked.mp4"),
                "scrapling_headless",
            )
    assert requests == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "headers", "body"),
    [
        (302, {}, b""),
        (302, {"Location": "http://127.0.0.1/video.mp4"}, b""),
        (200, {"Content-Length": str(524_288_001)}, b""),
        (200, {"Content-Type": "text/html"}, b"<html>blocked</html>"),
        (200, {"Content-Type": "video/mp4"}, b"too-small"),
    ],
)
async def test_invalid_response_never_leaves_final_or_partial_file(
    tmp_path, status: int, headers: dict[str, str], body: bytes
) -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(status, headers=headers, content=body, request=request)
    )
    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_cancelling_materialize_removes_partial_file(tmp_path) -> None:
    started = asyncio.Event()

    async def slow_body():
        yield MP4_BODY[:20]
        started.set()
        await asyncio.sleep(3600)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "video/mp4"},
            content=slow_body(),
            request=request,
        )

    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as client:
        task = asyncio.create_task(
            MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "scrapling_headless",
            )
        )
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_redirect_chain_exceeding_cap_is_rejected_even_with_valid_hops(tmp_path) -> None:
    """Pins the redirect cap: every hop here is a valid https/public target, so
    only MAX_REDIRECTS enforcement (not the scheme/SSRF checks) can reject it.
    """
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        if request_count <= MAX_REDIRECTS + 2:
            return httpx.Response(
                302,
                headers={"Location": "https://cdn.example/video.mp4"},
                content=b"",
                request=request,
            )
        return httpx.Response(
            200, headers={"Content-Type": "video/mp4"}, content=MP4_BODY, request=request
        )

    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )
    # Exactly MAX_REDIRECTS + 1 requests were attempted (the cap stopped it),
    # never reaching the terminal success response prepared beyond that.
    assert request_count == MAX_REDIRECTS + 1
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_oversized_content_length_with_body_is_rejected_before_reading(tmp_path) -> None:
    """Pins the Content-Length pre-check: the actual body is a small valid MP4,
    so only the declared-length gate (not the streamed byte cap) can reject it.
    """
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={
                "Content-Type": "video/mp4",
                "Content-Length": str(MAX_MEDIA_BYTES + 1),
            },
            content=MP4_BODY,
            request=request,
        )
    )
    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_non_positive_content_length_is_rejected(tmp_path) -> None:
    """Pins the non-positive Content-Length guard specifically (Finding 3)."""
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Content-Type": "video/mp4", "Content-Length": "-1"},
            content=MP4_BODY,
            request=request,
        )
    )
    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_streamed_body_exceeding_cap_without_content_length_is_rejected(
    tmp_path, monkeypatch
) -> None:
    """Pins the per-chunk running byte cap. The body is streamed from an async
    generator (so httpx emits chunked transfer-encoding with no Content-Length
    header, meaning the pre-check can't fire) and is otherwise a fully valid
    MP4 (real ftyp header, over MIN_MEDIA_BYTES) so only the live running-total
    comparison against MAX_MEDIA_BYTES can reject it.
    """
    monkeypatch.setattr(materializer_module, "MAX_MEDIA_BYTES", 5_000)

    async def chunked_body():
        # Multiple chunks: proves the cap is enforced while iterating, not
        # just checked once against a fully-buffered body.
        yield MP4_BODY[:12]
        yield MP4_BODY[12:]

    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, headers={"Content-Type": "video/mp4"}, content=chunked_body(), request=request
        )
    )
    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_redirect_hop_revalidates_host_and_rejects_private_target(tmp_path) -> None:
    """Pins per-hop resolver revalidation: the first hop resolves public and is
    accepted; the redirect target resolves private and must be rejected before
    any request reaches it, even though the first hop was fine.
    """
    requests = 0

    async def per_host_resolver(host: str) -> list[str]:
        if host == "cdn.example":
            return ["93.184.216.34"]
        return ["127.0.0.1"]

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        if requests == 1:
            return httpx.Response(
                302,
                headers={"Location": "https://cdn2.example/video.mp4"},
                content=b"",
                request=request,
            )
        return httpx.Response(
            200, headers={"Content-Type": "video/mp4"}, content=MP4_BODY, request=request
        )

    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, per_host_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )
    assert requests == 1
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_filesystem_error_is_wrapped_without_leaking_path(tmp_path, monkeypatch) -> None:
    """Finding 2: an OSError from a filesystem op (e.g. os.replace) must become
    a safe MediaMaterializationError, and its message must never contain the
    absolute destination path.
    """

    def boom(_src: object, _dst: object) -> None:
        raise OSError(f"disk full: {tmp_path}")

    monkeypatch.setattr(materializer_module.os, "replace", boom)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, headers={"Content-Type": "video/mp4"}, content=MP4_BODY, request=request
        )
    )
    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        with pytest.raises(MediaMaterializationError) as exc_info:
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )
    assert str(tmp_path) not in str(exc_info.value)
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_resolver_error_is_wrapped_without_leaking_hostname(tmp_path) -> None:
    async def failing_resolver(host: str) -> list[str]:
        raise RuntimeError(f"resolver failed for {host}")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unsafe request reached transport: {request}")

    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaMaterializationError) as exc_info:
            await MediaMaterializer(client, failing_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )

    assert str(exc_info.value) == "media_validation_failed"
    assert "cdn.example" not in str(exc_info.value)
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_malformed_redirect_is_wrapped_without_leaking_target(tmp_path) -> None:
    malformed_target = "https://[private.invalid/video.mp4"
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            302,
            headers={"Location": malformed_target},
            request=request,
        )
    )
    destination = tmp_path / "video.mp4"

    async with httpx.AsyncClient(transport=transport, follow_redirects=False) as client:
        with pytest.raises(MediaMaterializationError) as exc_info:
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )

    assert str(exc_info.value) == "media_validation_failed"
    assert malformed_target not in str(exc_info.value)
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unsafe_url",
    [
        "http://cdn.example/video.mp4",
        "https://user:password@cdn.example/video.mp4",
        "https://cdn.example:8443/video.mp4",
    ],
)
async def test_unsafe_url_forms_are_rejected_before_request(tmp_path, unsafe_url: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unsafe request reached transport: {request}")

    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, public_resolver).materialize(
                media(unsafe_url),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )

    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_relative_redirect_is_resolved_and_revalidated(tmp_path) -> None:
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if len(requested_urls) == 1:
            return httpx.Response(302, headers={"Location": "/final.mp4"}, request=request)
        return httpx.Response(
            200,
            headers={"Content-Type": "video/mp4"},
            content=MP4_BODY,
            request=request,
        )

    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ) as client:
        await MediaMaterializer(client, public_resolver).materialize(
            media("https://cdn.example/start"),
            destination,
            PurePosixPath("reports/wf_1/media/video.mp4"),
            "tikwm_cdn",
        )

    assert requested_urls == [
        "https://cdn.example/start",
        "https://cdn.example/final.mp4",
    ]
    assert destination.read_bytes() == MP4_BODY


@pytest.mark.asyncio
async def test_valid_ftyp_body_below_minimum_size_is_rejected(tmp_path) -> None:
    small_mp4_body = b"\x00\x00\x00\x18ftypmp42" + b"0" * (MIN_MEDIA_BYTES - 13)
    assert len(small_mp4_body) == MIN_MEDIA_BYTES - 1
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Content-Type": "video/mp4"},
            content=small_mp4_body,
            request=request,
        )
    )
    destination = tmp_path / "video.mp4"

    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(MediaMaterializationError):
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )

    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_http_timeout_is_sanitized_and_cleans_partial_output(tmp_path) -> None:
    async def timeout_body(request: httpx.Request):
        yield MP4_BODY[:20]
        raise httpx.ReadTimeout("timed out at https://cdn.example/private-token", request=request)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "video/mp4"},
            content=timeout_body(request),
            request=request,
        )

    destination = tmp_path / "video.mp4"
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MediaMaterializationError) as exc_info:
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                PurePosixPath("reports/wf_1/media/video.mp4"),
                "tikwm_cdn",
            )

    assert str(exc_info.value) == "media_validation_failed"
    assert "cdn.example" not in str(exc_info.value)
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.asyncio
async def test_invalid_result_location_is_sanitized_before_atomic_replace(tmp_path) -> None:
    sensitive_location = PurePosixPath("/private/reports/video.mp4")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Content-Type": "video/mp4"},
            content=MP4_BODY,
            request=request,
        )
    )
    destination = tmp_path / "video.mp4"

    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(MediaMaterializationError) as exc_info:
            await MediaMaterializer(client, public_resolver).materialize(
                media(),
                destination,
                sensitive_location,
                "tikwm_cdn",
            )

    assert str(exc_info.value) == "media_validation_failed"
    assert str(sensitive_location) not in str(exc_info.value)
    assert not destination.exists()
    assert list(tmp_path.rglob("*.part")) == []
