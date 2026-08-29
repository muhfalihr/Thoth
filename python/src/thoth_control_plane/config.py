"""Configuration for the Thoth control plane."""

from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class SettingsValidationError(ValueError):
    """Safe settings validation error that does not retain constructor inputs."""

    def errors(self) -> list[dict[str, str]]:
        """Provide a Pydantic-like sanitized error shape without input values."""

        return [{"type": "value_error", "msg": str(self)}]


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables or explicit values."""

    model_config = SettingsConfigDict(env_prefix="", case_sensitive=True)

    THOTH_CONTROL_PLANE_API_KEY: SecretStr
    THOTH_CONTROL_PLANE_CORS_ORIGINS: list[str] = Field(default_factory=list)
    THOTH_TEMPORAL_TARGET: str = "localhost:7233"
    THOTH_TEMPORAL_NAMESPACE: str = "default"
    THOTH_LEGACY_API_BASE_URL: str | None = None
    THOTH_LEGACY_API_KEY: SecretStr | None = None
    THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: Literal["python", "legacy_scout"] = "python"

    def __init__(self, **values: object) -> None:
        """Load settings, then reject an incomplete gateway pair without retaining inputs."""
        super().__init__(**values)
        has_base_url = bool((self.THOTH_LEGACY_API_BASE_URL or "").strip())
        has_api_key = bool(
            self.THOTH_LEGACY_API_KEY is not None
            and self.THOTH_LEGACY_API_KEY.get_secret_value().strip()
        )
        if has_base_url != has_api_key:
            raise SettingsValidationError(
                "legacy gateway base URL and API key must be configured together"
            )
        supplied_partial_value = (
            self.THOTH_LEGACY_API_BASE_URL is not None or self.THOTH_LEGACY_API_KEY is not None
        )
        if supplied_partial_value and not (has_base_url and has_api_key):
            raise SettingsValidationError(
                "legacy gateway base URL and API key must be configured together"
            )

    @property
    def legacy_bridge_enabled(self) -> bool:
        """Whether the validated legacy observation bridge can be constructed."""
        return self.THOTH_LEGACY_API_BASE_URL is not None and self.THOTH_LEGACY_API_KEY is not None

    @property
    def source_investigation_activity_mode(self) -> Literal["python", "legacy_scout"]:
        """Worker-owned activity selection, intentionally outside HTTP request handling."""
        return self.THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
