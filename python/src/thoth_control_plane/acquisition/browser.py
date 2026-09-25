"""Scrapling stealthy-headless browser adapter for single-post TikTok acquisition.

This module is the sole boundary where raw browser state (HTML, captured XHR
bodies, cookies, headers, signed URLs) is inspected. Only validated scalar
fields and media URLs, reduced into a `BrowserSnapshot`, ever cross back out.
Scrapling/Patchright are imported lazily so importing this module (and the
rest of the control plane) never requires the optional `acquisition` extra.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from pydantic import SecretStr

from thoth_control_plane.acquisition.adapters.tiktok import (
    TikTokUrlError,
    canonicalize_tiktok_post_url,
)
from thoth_control_plane.acquisition.models import (
    AcquisitionReason,
    BrowserSnapshot,
    MediaRequestContext,
    ResolvedMedia,
    TikTokPost,
)

CAPTURE_XHR_PATTERN = r"https://[^\s]+"
EMBEDDED_DATA_SELECTOR = "script#__UNIVERSAL_DATA_FOR_REHYDRATION__::text"
MEDIA_REFERER = "https://www.tiktok.com/"
FETCH_TIMEOUT_MS = 45_000
FETCH_WAIT_MS = 1_000

_active_session_count = 0


class HeadlessBrowserError(RuntimeError):
    """Raised when the headless browser cannot produce a usable snapshot.

    Carries only a taxonomy `AcquisitionReason`; never the underlying
    exception, response, or browser state.
    """

    def __init__(self, reason: AcquisitionReason) -> None:
        self.reason = reason
        super().__init__(reason.value)


@dataclass(frozen=True, slots=True)
class ScraplingCapability:
    """Result of probing whether the optional Scrapling/Patchright stack is usable."""

    available: bool
    code: str | None = None


class HeadlessBrowser(Protocol):
    """Interface a headless browser adapter must satisfy for acquisition."""

    async def fetch(self, url: str) -> BrowserSnapshot: ...

    async def close(self) -> None: ...


def active_scrapling_session_count() -> int:
    """Return the number of currently-open Scrapling sessions (for lifecycle tests)."""
    return _active_session_count


def _increment_active_sessions() -> None:
    global _active_session_count
    _active_session_count += 1


def _decrement_active_sessions() -> None:
    global _active_session_count
    _active_session_count = max(0, _active_session_count - 1)


def _default_session_factory(**kwargs: Any) -> Any:
    from scrapling.fetchers import AsyncStealthySession

    return AsyncStealthySession(**kwargs)


def _item_struct(
    captured_xhr: list[dict[str, Any]], embedded_data: dict[str, Any] | None, post_id: str
) -> dict[str, Any] | None:
    """Return the `itemStruct` of `post_id`, from captured XHR bodies first, then from the
    page's embedded rehydration data (a direct post load embeds it; no item XHR fires)."""
    bodies = [
        entry.get("body")
        for entry in captured_xhr
        if isinstance(entry, dict) and entry.get("status") == 200
    ]
    scope = embedded_data.get("__DEFAULT_SCOPE__") if isinstance(embedded_data, dict) else None
    if isinstance(scope, dict):
        bodies.append(scope.get("webapp.video-detail"))
    for body in bodies:
        item_info = body.get("itemInfo") if isinstance(body, dict) else None
        item_struct = item_info.get("itemStruct") if isinstance(item_info, dict) else None
        if isinstance(item_struct, dict) and str(item_struct.get("id")) == post_id:
            return item_struct
    return None


def _xhr_media_urls(item_struct: dict[str, Any] | None) -> list[str]:
    if item_struct is None:
        return []
    video = item_struct.get("video")
    if not isinstance(video, dict):
        return []
    urls = []
    for key in ("playAddr", "downloadAddr"):
        value = video.get(key)
        if isinstance(value, str) and value:
            urls.append(value)
    return urls


def _parse_captured_xhr(raw_entries: list[Any]) -> list[dict[str, Any]]:
    """Normalize captured XHR entries (already-parsed dicts, or Scrapling `Response`
    objects exposing `.status` and a synchronous `.json()`) into plain dicts.

    Anything that cannot be safely parsed is silently dropped; raw bodies never
    propagate past this function.
    """
    parsed: list[dict[str, Any]] = []
    for entry in raw_entries:
        if isinstance(entry, dict):
            parsed.append(entry)
            continue
        status = getattr(entry, "status", None)
        json_method = getattr(entry, "json", None)
        if status is None or not callable(json_method):
            continue
        try:
            body = json_method()
        except Exception:
            continue
        if isinstance(body, dict):
            parsed.append({"status": status, "body": body})
    return parsed


def _normalize_handle(value: str) -> str:
    return value.strip().removeprefix("@").casefold()


def extract_browser_snapshot(
    *,
    final_url: str,
    og_title: str | None,
    author: str | None,
    video_sources: list[str],
    captured_xhr: list[dict[str, Any]],
    embedded_data: dict[str, Any] | None = None,
    request_context: MediaRequestContext | None = None,
) -> BrowserSnapshot:
    """Reduce raw headless browser output to a sanitized `BrowserSnapshot`.

    `final_url` is validated through Task 2's canonicalization before any
    candidate is accepted. Raw XHR bodies are inspected only long enough to
    pull out `id`/`desc`/`author.uniqueId`; nothing raw is retained.

    Owner-handle cross-check precedence: the XHR `uniqueId` is an
    authoritative signal straight from TikTok's own item data, so when it is
    present it alone decides the match. The `meta[name="author"]` tag is a
    page-rendering artifact (can be absent, differently formatted, or a
    display name) and is only consulted as a fallback when the XHR signal is
    absent. Either signal fails safe: a mismatch downgrades to no candidate.

    Caption precedence: the XHR `desc` is the only caption source. `og_title`
    is TikTok's page title ("<display name> on TikTok") on every post measured,
    including posts that carry a long caption, so it holds no caption
    information and must never stand in for one -- an empty caption is a valid
    result, while a fabricated one would poison downstream narration grounding.

    Media candidates are https only (the player's `blob:` src is unfetchable)
    and come only from the item of this post, never from another video's.
    """
    identity = canonicalize_tiktok_post_url(final_url)
    canonical_handle = _normalize_handle(identity.owner_handle)

    item_struct = _item_struct(captured_xhr, embedded_data, identity.post_id)
    caption = ""
    xhr_unique_id: str | None = None
    if item_struct is not None:
        xhr_desc = item_struct.get("desc")
        if isinstance(xhr_desc, str):
            caption = xhr_desc
        xhr_author = item_struct.get("author")
        if isinstance(xhr_author, dict):
            unique_id = xhr_author.get("uniqueId")
            if isinstance(unique_id, str) and unique_id:
                xhr_unique_id = unique_id

    if xhr_unique_id is not None:
        owner_matches = _normalize_handle(xhr_unique_id) == canonical_handle
    else:
        owner_matches = author is None or _normalize_handle(author) == canonical_handle

    post_candidates: list[TikTokPost] = []
    if owner_matches:
        post_candidates.append(
            TikTokPost(
                post_id=identity.post_id,
                owner_handle=identity.owner_handle,
                caption=caption[:10_000],
            )
        )

    media_urls = list(dict.fromkeys([*video_sources, *_xhr_media_urls(item_struct)]))
    media_candidates = [
        ResolvedMedia(ephemeral_url=SecretStr(url), request_context=request_context)
        for url in media_urls
        if url.startswith("https://")
    ]

    return BrowserSnapshot(
        final_url=identity.canonical_url,
        post_candidates=post_candidates,
        media_candidates=media_candidates,
    )


def _extract_from_response(response: Any) -> BrowserSnapshot:
    og_title = response.css('meta[property="og:title"]::attr(content)').get()
    author = response.css('meta[name="author"]::attr(content)').get()
    video_sources = response.css("video::attr(src)").getall()
    captured_xhr = _parse_captured_xhr(getattr(response, "captured_xhr", []))
    embedded_data: Any = None
    with contextlib.suppress(ValueError):
        embedded_data = json.loads(response.css(EMBEDDED_DATA_SELECTOR).get() or "null")
    return extract_browser_snapshot(
        final_url=str(response.url),
        og_title=og_title,
        author=author,
        video_sources=list(video_sources),
        captured_xhr=captured_xhr,
        embedded_data=embedded_data if isinstance(embedded_data, dict) else None,
        request_context=_media_request_context(response),
    )


def _media_request_context(response: Any) -> MediaRequestContext:
    """Capture the session TikTok binds its signed media URLs to (context cookies + UA)."""
    headers = getattr(response, "request_headers", None)
    user_agent = None
    if isinstance(headers, dict):
        user_agent = next(
            (str(v) for k, v in headers.items() if str(k).lower() == "user-agent"), None
        )
    raw_cookies = getattr(response, "cookies", None)
    cookies = [
        (str(c.get("domain") or ""), str(c["name"]), SecretStr(str(c.get("value") or "")))
        for c in (raw_cookies if isinstance(raw_cookies, (list, tuple)) else ())
        if isinstance(c, dict) and c.get("name") and c.get("domain")
    ]
    return MediaRequestContext(user_agent=user_agent, referer=MEDIA_REFERER, cookies=cookies)


def _classify_fetch_error(error: Exception) -> AcquisitionReason:
    if "timeout" in type(error).__name__.lower():
        return AcquisitionReason.HEADLESS_TIMEOUT
    return AcquisitionReason.HEADLESS_BLOCKED


class ScraplingHeadlessBrowser:
    """Primary TikTok acquisition strategy: a stealthy headless browser session."""

    def __init__(self, session_factory: Callable[..., Any] = _default_session_factory) -> None:
        self._session_factory = session_factory
        self._session: Any | None = None

    async def fetch(self, url: str) -> BrowserSnapshot:
        session = self._session_factory(headless=True, max_pages=1, capture_xhr=CAPTURE_XHR_PATTERN)
        try:
            active = await session.__aenter__()
        except Exception as error:
            raise HeadlessBrowserError(_classify_fetch_error(error)) from None

        self._session = session
        _increment_active_sessions()
        try:
            response = await active.fetch(
                url,
                timeout=FETCH_TIMEOUT_MS,
                network_idle=True,
                disable_resources=False,
                google_search=False,
                wait=FETCH_WAIT_MS,
            )
            snapshot = _extract_from_response(response)
        except TikTokUrlError:
            await self.close()
            raise HeadlessBrowserError(AcquisitionReason.HEADLESS_BLOCKED) from None
        except Exception as error:
            await self.close()
            raise HeadlessBrowserError(_classify_fetch_error(error)) from None
        except BaseException:
            # Cancellation and other non-Exception signals: still close, then
            # propagate unchanged (never reclassified as an acquisition reason).
            await self.close()
            raise

        if not snapshot.post_candidates or not snapshot.media_candidates:
            await self.close()
            raise HeadlessBrowserError(AcquisitionReason.HEADLESS_INCOMPLETE)

        return snapshot

    async def close(self) -> None:
        session, self._session = self._session, None
        if session is None:
            return
        try:
            await session.__aexit__(None, None, None)
        except Exception:
            pass
        finally:
            _decrement_active_sessions()


async def check_scrapling_capability() -> ScraplingCapability:
    """Probe whether the optional Scrapling/Patchright browser stack is usable.

    Never raises and never retains the underlying exception; a missing
    optional extra or an unusable browser binary both report the same safe
    `acquisition_dependency_unavailable` code.
    """
    try:
        from patchright.async_api import async_playwright
        from scrapling.fetchers import AsyncStealthySession  # noqa: F401
    except ImportError:
        return ScraplingCapability(available=False, code="acquisition_dependency_unavailable")

    playwright = None
    try:
        playwright = await async_playwright().start()
        executable_path = Path(playwright.chromium.executable_path)
        if not executable_path.is_file():
            return ScraplingCapability(available=False, code="acquisition_dependency_unavailable")
        return ScraplingCapability(available=True, code=None)
    except Exception:
        return ScraplingCapability(available=False, code="acquisition_dependency_unavailable")
    finally:
        if playwright is not None:
            with contextlib.suppress(Exception):
                await playwright.stop()
