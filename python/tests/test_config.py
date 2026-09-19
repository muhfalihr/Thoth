"""Tests for editor preview settings and their fail-closed guards."""

from __future__ import annotations

import pytest

from thoth_control_plane.config import Settings, SettingsValidationError


def settings(**overrides: object) -> Settings:
    return Settings(THOTH_CONTROL_PLANE_API_KEY="test-key", **overrides)


def test_preview_settings_default_to_disabled_with_a_bounded_ttl() -> None:
    configured = settings()

    assert configured.THOTH_EDITOR_PREVIEW_SIGNING_KEY is None
    assert configured.THOTH_EDITOR_PREVIEW_TTL_SECONDS == 300
    assert configured.THOTH_EDITOR_PREVIEW_BASE_URL is None


@pytest.mark.parametrize("ttl", [29, 3601, 0, -1])
def test_preview_ttl_stays_inside_its_bounds(ttl: int) -> None:
    with pytest.raises(ValueError):
        settings(THOTH_EDITOR_PREVIEW_TTL_SECONDS=ttl)


@pytest.mark.parametrize(
    "base_url",
    [
        "https://cdn.example.test/preview",
        "http://localhost:8000/api/v1",
        "//cdn.example.test/api/v1",
        "api/v1",
        "/api/v1?capability=leaked",
        "/api/v1#fragment",
        "/api\\v1",
    ],
)
def test_a_cross_origin_preview_base_url_is_refused(base_url: str) -> None:
    with pytest.raises(SettingsValidationError) as error:
        settings(THOTH_EDITOR_PREVIEW_BASE_URL=base_url)

    assert base_url not in str(error.value)


def test_a_same_origin_preview_base_url_is_accepted() -> None:
    assert settings(THOTH_EDITOR_PREVIEW_BASE_URL="/api/v1").THOTH_EDITOR_PREVIEW_BASE_URL == (
        "/api/v1"
    )


def test_the_preview_signing_key_is_never_rendered_in_plain_text() -> None:
    configured = settings(THOTH_EDITOR_PREVIEW_SIGNING_KEY="super-secret-signing-key")

    assert "super-secret-signing-key" not in repr(configured)
    assert configured.THOTH_EDITOR_PREVIEW_SIGNING_KEY is not None
    assert (
        configured.THOTH_EDITOR_PREVIEW_SIGNING_KEY.get_secret_value() == "super-secret-signing-key"
    )
