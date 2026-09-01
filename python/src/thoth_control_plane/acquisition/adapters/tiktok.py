"""SSRF-safe TikTok URL validation and canonical post identity parsing."""

from __future__ import annotations

import re
from urllib.parse import SplitResult, urlsplit, urlunsplit

from pydantic import HttpUrl

from thoth_control_plane.domain.models import StrictModel

ENTRY_HOSTS = frozenset(
    {"tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"}
)
CANONICAL_HOSTS = frozenset({"tiktok.com", "www.tiktok.com", "m.tiktok.com"})
POST_PATH = re.compile(r"^/@(?P<owner>[A-Za-z0-9._-]{1,64})/video/(?P<post_id>[0-9]{5,32})/?$")


class TikTokUrlError(ValueError):
    """Raised when a URL is not a safe, supported public TikTok post URL."""


class TikTokEntryUrl(StrictModel):
    url: HttpUrl
    host: str
    is_short: bool


class TikTokPostIdentity(StrictModel):
    canonical_url: HttpUrl
    post_id: str
    owner_handle: str


def _safe_split(url: str) -> tuple[SplitResult, str]:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        # urlsplit()/`.port` raise a bare ValueError whose message embeds the
        # raw offending substring (e.g. malformed port or IPv6 authority).
        # Re-raise without chaining so that text never reaches callers.
        raise TikTokUrlError("invalid_tiktok_url") from None
    if (
        parsed.scheme != "https"
        or host not in ENTRY_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        raise TikTokUrlError("invalid_tiktok_url")
    return parsed, host


def validate_tiktok_entry_url(url: str) -> TikTokEntryUrl:
    """Validate that `url` is a safe, supported public TikTok entry URL."""
    parsed, host = _safe_split(url)
    is_short = host in {"vm.tiktok.com", "vt.tiktok.com"}
    if is_short:
        if not parsed.path.strip("/"):
            raise TikTokUrlError("invalid_tiktok_url")
    elif POST_PATH.fullmatch(parsed.path) is None:
        raise TikTokUrlError("invalid_tiktok_url")
    return TikTokEntryUrl(url=url, host=host, is_short=is_short)


def canonicalize_tiktok_post_url(url: str) -> TikTokPostIdentity:
    """Reduce a canonical/mobile TikTok post URL to its stable identity."""
    parsed, host = _safe_split(url)
    match = POST_PATH.fullmatch(parsed.path)
    if host not in CANONICAL_HOSTS or match is None:
        raise TikTokUrlError("invalid_tiktok_url")
    canonical = urlunsplit(("https", "www.tiktok.com", parsed.path.rstrip("/"), "", ""))
    return TikTokPostIdentity(
        canonical_url=canonical,
        post_id=match.group("post_id"),
        owner_handle=match.group("owner"),
    )
