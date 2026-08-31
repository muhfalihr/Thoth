import asyncio
from pathlib import PurePosixPath

import httpx
import pytest
from pydantic import SecretStr

from thoth_control_plane.acquisition.materializer import (
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
    assert result.checksum.startswith("sha256:")
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
