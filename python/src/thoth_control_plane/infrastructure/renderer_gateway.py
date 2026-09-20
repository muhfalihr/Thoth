"""The private, credentialed transport to the isolated Remotion renderer.

One action is exactly one request: no redirect is followed, no retry is made,
and no transport detail survives. Callers see only the fixed renderer failures
declared in the application port, so an address, a credential, or a driver
message can never reach a public response.
"""

from __future__ import annotations

import re

import httpx
from pydantic import SecretStr

from thoth_control_plane.application.render_job_ports import (
    RendererNotConfigured,
    RendererRejected,
    RendererUnavailable,
)

#: Identical to the domain `OpaqueId`: one safe URL segment, never a path.
_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")

#: A dispatch is an acknowledgement, not a render: the wait stays short.
REQUEST_TIMEOUT_SECONDS = 10.0


class HttpRendererGateway:
    """Perform exactly one authenticated private request per action."""

    configured = True

    def __init__(
        self,
        *,
        base_url: str,
        credential: SecretStr | str,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = str(base_url).rstrip("/")
        self._credential = (
            credential if isinstance(credential, SecretStr) else SecretStr(str(credential))
        )
        self._transport = transport
        self._timeout = timeout

    @property
    def request_timeout_seconds(self) -> float:
        return self._timeout

    @property
    def follow_redirects_enabled(self) -> bool:
        return False

    def dispatch_url(self, render_job_id: str, action: str) -> str:
        """Compose one private URL, refusing any identity that is not a segment."""
        if not isinstance(render_job_id, str) or not _IDENTIFIER.match(render_job_id):
            raise RendererRejected()
        return f"{self._base_url}/internal/render-jobs/{render_job_id}/{action}"

    async def start(self, *, render_job_id: str, dispatch_id: str) -> None:
        if not isinstance(dispatch_id, str) or not _IDENTIFIER.match(dispatch_id):
            raise RendererRejected()
        await self._post(self.dispatch_url(render_job_id, "start"), {"dispatch_id": dispatch_id})

    async def cancel(self, *, render_job_id: str) -> None:
        await self._post(self.dispatch_url(render_job_id, "cancel"), {})

    async def _post(self, url: str, payload: dict[str, str]) -> None:
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout),
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self._credential.get_secret_value()}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except httpx.HTTPError as error:
            # Includes timeouts: a dispatch is never retried here, because the
            # job's own deadline is the single authority on how long it lives.
            raise RendererUnavailable() from error
        if response.status_code >= 500:
            raise RendererUnavailable()
        if response.status_code >= 300:
            raise RendererRejected()

    def __repr__(self) -> str:
        return f"{type(self).__name__}(configured=True)"


class UnavailableRendererGateway:
    """Stand in when no renderer is configured, so the control plane still starts."""

    configured = False

    async def start(self, *, render_job_id: str, dispatch_id: str) -> None:
        raise RendererNotConfigured()

    async def cancel(self, *, render_job_id: str) -> None:
        raise RendererNotConfigured()
