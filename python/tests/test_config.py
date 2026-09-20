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


def test_renderer_settings_default_to_a_disabled_but_startable_control_plane() -> None:
    configured = settings()

    assert configured.THOTH_RENDERER_INTERNAL_URL is None
    assert configured.THOTH_RENDERER_INTERNAL_CREDENTIAL is None
    assert configured.THOTH_RENDER_MAX_SECONDS == 900
    assert configured.THOTH_RENDERER_VERSION == "remotion-4.0.523"
    assert configured.THOTH_RENDER_PRESET_ID == "standard_vertical_mp4_v1"
    assert configured.renderer_enabled is False


def test_a_fully_configured_renderer_is_enabled() -> None:
    configured = settings(
        THOTH_RENDERER_INTERNAL_URL="http://renderer:8080",
        THOTH_RENDERER_INTERNAL_CREDENTIAL="internal-render-credential",
    )

    assert configured.renderer_enabled is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"THOTH_RENDERER_INTERNAL_URL": "http://renderer:8080"},
        {"THOTH_RENDERER_INTERNAL_CREDENTIAL": "internal-render-credential"},
        {
            "THOTH_RENDERER_INTERNAL_URL": "http://renderer:8080",
            "THOTH_RENDERER_INTERNAL_CREDENTIAL": "   ",
        },
    ],
)
def test_a_partial_renderer_configuration_is_refused(overrides: dict[str, str]) -> None:
    with pytest.raises(SettingsValidationError) as error:
        settings(**overrides)

    assert "internal-render-credential" not in str(error.value)
    assert "renderer:8080" not in str(error.value)


def test_the_renderer_credential_is_never_rendered_in_plain_text() -> None:
    configured = settings(
        THOTH_RENDERER_INTERNAL_URL="http://renderer:8080",
        THOTH_RENDERER_INTERNAL_CREDENTIAL="internal-render-credential",
    )

    assert "internal-render-credential" not in repr(configured)
    assert "internal-render-credential" not in str(configured)
    assert configured.THOTH_RENDERER_INTERNAL_CREDENTIAL is not None
    assert (
        configured.THOTH_RENDERER_INTERNAL_CREDENTIAL.get_secret_value()
        == "internal-render-credential"
    )


@pytest.mark.parametrize("seconds", [0, -1, 30, 7201])
def test_the_render_deadline_stays_inside_its_bounds(seconds: int) -> None:
    with pytest.raises(ValueError):
        settings(THOTH_RENDER_MAX_SECONDS=seconds)


def test_the_render_preset_cannot_be_switched_to_another_value() -> None:
    with pytest.raises(ValueError):
        settings(THOTH_RENDER_PRESET_ID="wide_1080p_prores")
