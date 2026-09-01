"""SSRF-safe, atomic streaming download of a resolved TikTok media URL."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import ipaddress
import os
import socket
from collections.abc import Awaitable, Callable
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import ValidationError

from thoth_control_plane.acquisition.models import (
    AcquisitionStrategy,
    MaterializedMedia,
    ResolvedMedia,
)

MAX_MEDIA_BYTES = 500 * 1024 * 1024
MIN_MEDIA_BYTES = 10_000
MAX_REDIRECTS = 3
DOWNLOAD_TIMEOUT_SECONDS = 30.0

_FTYP_OFFSET = 4
_FTYP_MAGIC = b"ftyp"
_HEADER_PROBE_BYTES = 12

HostResolver = Callable[[str], Awaitable[list[str]]]


class MediaMaterializationError(RuntimeError):
    """Raised whenever a candidate media URL/response fails safety validation.

    The message is a fixed, safe reason: it never carries the offending URL,
    an absolute path, or raw exception text from an underlying library.
    """

    def __init__(self) -> None:
        super().__init__("media_validation_failed")


async def resolve_host_via_getaddrinfo(host: str) -> list[str]:
    """Production host resolver: system DNS run off the event loop, deduplicated."""
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError:
        raise MediaMaterializationError() from None
    return list(dict.fromkeys(info[4][0] for info in infos))


def _validate_public_https_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        # urlsplit()/`.port` raise a bare ValueError whose message embeds the
        # raw offending substring; re-raise without chaining so it never
        # reaches callers.
        raise MediaMaterializationError() from None
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        raise MediaMaterializationError()
    return host


async def _ensure_publicly_routable(host: str, resolver: HostResolver) -> None:
    try:
        addresses = await resolver(host)
    except Exception:
        raise MediaMaterializationError() from None
    if not addresses:
        raise MediaMaterializationError()
    for value in dict.fromkeys(addresses):
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            raise MediaMaterializationError() from None
        if not address.is_global:
            raise MediaMaterializationError()


class MediaMaterializer:
    """Streams a `ResolvedMedia` candidate to disk with SSRF and integrity checks."""

    def __init__(self, client: httpx.AsyncClient, resolver: HostResolver) -> None:
        self._client = client
        self._resolver = resolver

    async def materialize(
        self,
        candidate: ResolvedMedia,
        destination: Path,
        relative_location: PurePosixPath,
        strategy: AcquisitionStrategy | str,
    ) -> MaterializedMedia:
        # Ruling F-3: normalize plain str -> AcquisitionStrategy before it
        # reaches the strict MaterializedMedia field.
        acquisition_strategy = AcquisitionStrategy(strategy)
        part_path = destination.with_name(destination.name + ".part")
        current_url = candidate.ephemeral_url.get_secret_value()
        digest = hashlib.sha256()
        header = b""
        total_bytes = 0
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            for _ in range(MAX_REDIRECTS + 1):
                host = _validate_public_https_url(current_url)
                await _ensure_publicly_routable(host, self._resolver)
                try:
                    async with self._client.stream(
                        "GET",
                        current_url,
                        follow_redirects=False,
                        timeout=DOWNLOAD_TIMEOUT_SECONDS,
                    ) as response:
                        if 300 <= response.status_code < 400:
                            location = response.headers.get("Location")
                            if not location:
                                raise MediaMaterializationError()
                            try:
                                current_url = urljoin(current_url, location)
                            except ValueError:
                                raise MediaMaterializationError() from None
                            continue
                        if not 200 <= response.status_code < 300:
                            raise MediaMaterializationError()

                        content_length = response.headers.get("Content-Length")
                        if content_length is not None:
                            try:
                                declared_bytes = int(content_length)
                            except ValueError:
                                raise MediaMaterializationError() from None
                            if declared_bytes <= 0 or declared_bytes > MAX_MEDIA_BYTES:
                                raise MediaMaterializationError()

                        with part_path.open("wb") as handle:
                            async for chunk in response.aiter_bytes():
                                total_bytes += len(chunk)
                                if total_bytes > MAX_MEDIA_BYTES:
                                    raise MediaMaterializationError()
                                if len(header) < _HEADER_PROBE_BYTES:
                                    header += chunk[: _HEADER_PROBE_BYTES - len(header)]
                                digest.update(chunk)
                                handle.write(chunk)
                    break
                except httpx.HTTPError:
                    raise MediaMaterializationError() from None
            else:
                raise MediaMaterializationError()

            if (
                len(header) < _HEADER_PROBE_BYTES
                or header[_FTYP_OFFSET : _FTYP_OFFSET + len(_FTYP_MAGIC)] != _FTYP_MAGIC
            ):
                raise MediaMaterializationError()
            if total_bytes < MIN_MEDIA_BYTES:
                raise MediaMaterializationError()

            try:
                result = MaterializedMedia(
                    media_id="media_1",
                    location=relative_location,
                    bytes=total_bytes,
                    checksum=f"sha256:{digest.hexdigest()}",
                    acquisition_strategy=acquisition_strategy,
                    duration_seconds=candidate.duration_seconds,
                )
            except ValidationError:
                raise MediaMaterializationError() from None

            os.replace(part_path, destination)
            return result
        except OSError:
            # Filesystem errors (mkdir/open/write/replace) can carry an
            # absolute path in their message; never let that escape.
            raise MediaMaterializationError() from None
        finally:
            with contextlib.suppress(OSError):
                part_path.unlink(missing_ok=True)
