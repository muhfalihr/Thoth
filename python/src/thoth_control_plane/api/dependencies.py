"""Shared authenticated API dependencies."""

from __future__ import annotations

from hmac import compare_digest
from typing import Annotated

from fastapi import Header, HTTPException, Request, status

from thoth_control_plane.domain import Actor


def current_actor(
    request: Request,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> Actor:
    """Authenticate the control-plane bearer token without exposing it."""
    expected = request.app.state.settings.THOTH_CONTROL_PLANE_API_KEY.get_secret_value()
    scheme, _, credential = authorization.partition(" ") if authorization else ("", "", "")
    if scheme.lower() != "bearer" or not credential or not compare_digest(credential, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized")
    return Actor(actor_id="owner", actor_type="user")
