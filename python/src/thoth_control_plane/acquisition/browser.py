"""Scrapling stealthy-headless browser adapter for single-post TikTok acquisition.

This module is the sole boundary where raw browser state (HTML, captured XHR
bodies, cookies, headers, signed URLs) is inspected. Only validated scalar
fields and media URLs, reduced into a `BrowserSnapshot`, ever cross back out.
Scrapling/Patchright are imported lazily so importing this module (and the
rest of the control plane) never requires the optional `acquisition` extra.
"""

from __future__ import annotations

import contextlib
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
    ResolvedMedia,
    TikTokPost,
)

CAPTURE_XHR_PATTERN = r"https://[^\s]+"
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


def _xhr_item_struct(captured_xhr: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the first `itemStruct` parsed out of captured TikTok XHR bodies."""
    for entry in captured_xhr:
        if not isinstance(entry, dict) or entry.get("status") != 200:
            continue
        body = entry.get("body")
        if not isinstance(body, dict):
            continue
        item_info = body.get("itemInfo")
        if not isinstance(item_info, dict):
            continue
        item_struct = item_info.get("itemStruct")
        if isinstance(item_struct, dict):
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


def extract_browser_snapshot(
    *,
    final_url: str,
    og_title: str | None,
    author: str | None,
    video_sources: list[str],
    captured_xhr: list[dict[str, Any]],
) -> BrowserSnapshot:
    """Reduce raw headless browser output to a sanitized `BrowserSnapshot`.

    `final_url` is validated through Task 2's canonicalization before any
    candidate is accepted. Raw XHR bodies are inspected only long enough to
    pull out `id`/`desc`/`author.uniqueId`; nothing raw is retained.
    """
    identity = canonicalize_tiktok_post_url(final_url)

    item_struct = _xhr_item_struct(captured_xhr)
    caption = og_title or ""
    owner_matches = author is None or author.strip().lower() == identity.owner_handle.lower()
    if item_struct is not None and str(item_struct.get("id")) == identity.post_id:
        xhr_desc = item_struct.get("desc")
        if isinstance(xhr_desc, str) and xhr_desc:
            caption = xhr_desc
        xhr_author = item_struct.get("author")
        if isinstance(xhr_author, dict):
            unique_id = xhr_author.get("uniqueId")
            if isinstance(unique_id, str):
                owner_matches = owner_matches and unique_id.lower() == identity.owner_handle.lower()

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
    media_candidates = [ResolvedMedia(ephemeral_url=SecretStr(url)) for url in media_urls if url]

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
    return extract_browser_snapshot(
        final_url=str(response.url),
        og_title=og_title,
        author=author,
        video_sources=list(video_sources),
        captured_xhr=captured_xhr,
    )


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
