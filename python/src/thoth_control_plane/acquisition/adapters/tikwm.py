"""TikWM CDN fallback adapter: rate-gated, sanitized single-post resolution.

This is the sole boundary where a raw TikWM JSON payload is inspected. Only
validated scalar fields and a normalized HTTPS media URL, reduced into a
`TikWmResolution`, ever cross back out. The raw payload, and the source URL
sent to TikWM, never appear in a raised error message.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from typing import Literal
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import SecretStr, ValidationError

from thoth_control_plane.acquisition.models import ResolvedMedia, TikTokPost
from thoth_control_plane.domain.models import StrictModel

TIKWM_ORIGIN = "https://www.tikwm.com"
_POST_ID_PATTERN = re.compile(r"^[0-9]{5,32}$")
_RATE_LIMIT_CODES = frozenset({-1})
_RATE_LIMIT_MARKERS = ("frequently", "rate limit", "too many request")


class TikWmResolution(StrictModel):
    post: TikTokPost
    media: ResolvedMedia


class TikWmError(RuntimeError):
    """Raised for any TikWM failure; carries only a fixed taxonomy code.

    Never carries the provider response body, the source URL, or raw
    exception text from the underlying HTTP/JSON layer.
    """

    def __init__(self, code: Literal["cdn_rate_limited", "cdn_unavailable"]) -> None:
        self.code = code
        super().__init__(code)


def _is_rate_limited(code: object, msg: object) -> bool:
    if isinstance(code, int) and code in _RATE_LIMIT_CODES:
        return True
    lowered = msg.lower() if isinstance(msg, str) else ""
    return any(marker in lowered for marker in _RATE_LIMIT_MARKERS)


def _first_media_url(data: dict[str, object]) -> str | None:
    for key in ("hdplay", "play", "wmplay"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def parse_tikwm_payload(payload: object) -> TikWmResolution:
    """Reduce a raw TikWM JSON payload to a sanitized `TikWmResolution`.

    Any missing/malformed field, a nonzero result code, or a non-HTTPS media
    URL is rejected as `cdn_unavailable`; rate-limit signals are rejected as
    `cdn_rate_limited`. The raw payload never reaches a raised error message.
    """
    if not isinstance(payload, dict):
        raise TikWmError("cdn_unavailable")

    code = payload.get("code")
    if _is_rate_limited(code, payload.get("msg")):
        raise TikWmError("cdn_rate_limited")
    if code != 0:
        raise TikWmError("cdn_unavailable")

    data = payload.get("data")
    if not isinstance(data, dict):
        raise TikWmError("cdn_unavailable")

    post_id = data.get("id")
    if not isinstance(post_id, str | int) or not _POST_ID_PATTERN.fullmatch(str(post_id)):
        raise TikWmError("cdn_unavailable")

    author = data.get("author")
    unique_id = author.get("unique_id") if isinstance(author, dict) else None
    if not isinstance(unique_id, str) or not unique_id:
        raise TikWmError("cdn_unavailable")

    media_url = _first_media_url(data)
    if media_url is None:
        raise TikWmError("cdn_unavailable")
    try:
        normalized_url = urljoin(TIKWM_ORIGIN, media_url)
        scheme = urlsplit(normalized_url).scheme
    except ValueError:
        raise TikWmError("cdn_unavailable") from None
    if scheme != "https":
        raise TikWmError("cdn_unavailable")

    caption = data.get("title")
    caption = caption if isinstance(caption, str) else ""
    duration = data.get("duration")
    try:
        duration_seconds = float(duration) if isinstance(duration, int | float) else None
    except OverflowError:
        raise TikWmError("cdn_unavailable") from None

    try:
        return TikWmResolution(
            post=TikTokPost(post_id=str(post_id), owner_handle=unique_id, caption=caption[:10_000]),
            media=ResolvedMedia(
                ephemeral_url=SecretStr(normalized_url), duration_seconds=duration_seconds
            ),
        )
    except ValidationError:
        raise TikWmError("cdn_unavailable") from None


class TikWmRateGate:
    """Serializes TikWM calls to at most one request per second, process-wide."""

    def __init__(self, min_interval_seconds: float = 1.0) -> None:
        self._min_interval_seconds = min_interval_seconds
        self._lock = asyncio.Lock()
        self._last_start: float | None = None

    async def wait(
        self,
        clock: Callable[[], float],
        sleep: Callable[[float], Awaitable[None]],
    ) -> None:
        async with self._lock:
            now = clock()
            if self._last_start is not None:
                remaining = self._min_interval_seconds - (now - self._last_start)
                if remaining > 0:
                    await sleep(remaining)
                    now = clock()
            self._last_start = now


SHARED_TIKWM_RATE_GATE = TikWmRateGate()


class TikWmResolver:
    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rate_gate: TikWmRateGate = SHARED_TIKWM_RATE_GATE,
    ) -> None:
        self._client = client
        self._clock = clock
        self._sleep = sleep
        self._rate_gate = rate_gate

    async def resolve(self, source_url: str) -> TikWmResolution:
        await self._rate_gate.wait(self._clock, self._sleep)
        try:
            response = await self._client.get(
                "https://www.tikwm.com/api/",
                params={"url": source_url, "hd": "1"},
                timeout=httpx.Timeout(15.0),
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            raise TikWmError("cdn_unavailable") from None
        return parse_tikwm_payload(payload)
