"""Short-lived, asset-scoped preview capabilities and safe artifact resolution.

The capability is an opaque HMAC-SHA256 value carried only in an HttpOnly,
path-scoped cookie. It never appears in a URL, a JSON body, a persisted
document, or a log line, and no error raised here repeats the capability, the
signing key, or a filesystem path.
"""

from __future__ import annotations

import base64
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

#: Bumped only when the canonical claim set changes shape.
CAPABILITY_VERSION = 1

#: Fixed cookie name; isolation comes from the exact preview path, not the name.
PREVIEW_COOKIE_NAME = "thoth_editor_preview"

#: Tolerance for a small clock difference between issuing and serving.
CLOCK_SKEW_SECONDS = 30


class PreviewCapabilityInvalid(Exception):
    """The capability is unreadable, unsigned by this key, or out of scope."""

    def __init__(self) -> None:
        super().__init__("preview capability invalid")


class PreviewCapabilityExpired(Exception):
    """The capability is well formed and in scope but no longer valid."""

    def __init__(self) -> None:
        super().__init__("preview capability expired")


class PreviewArtifactInvalid(Exception):
    """The locator does not resolve to a readable file inside the artifact root."""

    def __init__(self) -> None:
        super().__init__("preview artifact invalid")


@dataclass(frozen=True)
class PreviewCapability:
    """One issued capability and the moment it stops being accepted."""

    token: str
    expires_at: datetime


@dataclass(frozen=True)
class PreviewClaims:
    """The verified scope a capability was issued for."""

    actor_id: str
    project_id: str
    asset_id: str
    issued_at: datetime
    expires_at: datetime


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment.encode("ascii") + padding.encode("ascii"))


class EditorPreviewSigner:
    """Issues and verifies capabilities with the stdlib HMAC primitive only."""

    def __init__(self, key: str | bytes, ttl_seconds: int) -> None:
        material = key.encode("utf-8") if isinstance(key, str) else key
        if not material.strip():
            raise ValueError("preview signing key must not be empty")
        if ttl_seconds <= 0:
            raise ValueError("preview capability TTL must be positive")
        self._key = material
        self._ttl_seconds = ttl_seconds

    def issue(
        self, *, actor_id: str, project_id: str, asset_id: str, now: datetime
    ) -> PreviewCapability:
        issued_at = int(now.timestamp())
        expires_at = issued_at + self._ttl_seconds
        payload = _encode(
            json.dumps(
                {
                    "v": CAPABILITY_VERSION,
                    "act": actor_id,
                    "prj": project_id,
                    "ast": asset_id,
                    "iat": issued_at,
                    "exp": expires_at,
                },
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        )
        token = f"{payload}.{self._sign(payload)}"
        return PreviewCapability(token=token, expires_at=datetime.fromtimestamp(expires_at, tz=UTC))

    def verify(
        self,
        token: str,
        *,
        project_id: str,
        asset_id: str,
        now: datetime,
        actor_id: str | None = None,
    ) -> PreviewClaims:
        """Return the verified claims, or fail without echoing any supplied value."""
        payload, _, signature = token.partition(".")
        if not payload or not signature or "." in signature:
            raise PreviewCapabilityInvalid()
        if not hmac.compare_digest(signature, self._sign(payload)):
            raise PreviewCapabilityInvalid()
        try:
            claims = json.loads(_decode(payload))
        except (ValueError, TypeError) as error:
            raise PreviewCapabilityInvalid() from error
        if not isinstance(claims, dict) or claims.get("v") != CAPABILITY_VERSION:
            raise PreviewCapabilityInvalid()
        scope = (claims.get("prj"), claims.get("ast"))
        if scope != (project_id, asset_id):
            raise PreviewCapabilityInvalid()
        if actor_id is not None and claims.get("act") != actor_id:
            raise PreviewCapabilityInvalid()
        issued_at, expires_at = claims.get("iat"), claims.get("exp")
        if not isinstance(issued_at, int) or not isinstance(expires_at, int):
            raise PreviewCapabilityInvalid()
        moment = int(now.timestamp())
        if issued_at - CLOCK_SKEW_SECONDS > moment:
            raise PreviewCapabilityInvalid()
        if expires_at < moment:
            raise PreviewCapabilityExpired()
        return PreviewClaims(
            actor_id=str(claims.get("act")),
            project_id=project_id,
            asset_id=asset_id,
            issued_at=datetime.fromtimestamp(issued_at, tz=UTC),
            expires_at=datetime.fromtimestamp(expires_at, tz=UTC),
        )

    def _sign(self, payload: str) -> str:
        return _encode(hmac.new(self._key, payload.encode("ascii"), sha256).digest())


def resolve_preview_path(root: Path, location: str) -> Path:
    """Resolve a repository locator under the artifact root, or refuse it.

    The repository already constrains the stored locator, so this is the second
    of two independent checks: the resolved file must still be a readable
    regular file inside the configured root.
    """
    if not location or location.startswith(("/", "\\")) or any(ch in location for ch in ":?#\\"):
        raise PreviewArtifactInvalid()
    base = root.resolve()
    candidate = (base / location).resolve()
    if not candidate.is_relative_to(base) or not candidate.is_file():
        raise PreviewArtifactInvalid()
    return candidate
