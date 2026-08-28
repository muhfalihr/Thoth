"""Configuration for the Thoth control plane."""

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables or explicit values."""

    model_config = SettingsConfigDict(env_prefix="", case_sensitive=True)

    THOTH_CONTROL_PLANE_API_KEY: SecretStr
    THOTH_CONTROL_PLANE_CORS_ORIGINS: list[str] = Field(default_factory=list)
    THOTH_TEMPORAL_TARGET: str = "localhost:7233"
    THOTH_TEMPORAL_NAMESPACE: str = "default"
    THOTH_LEGACY_API_BASE_URL: str | None = None
    THOTH_LEGACY_API_KEY: SecretStr | None = None

    @model_validator(mode="after")
    def validate_legacy_gateway_pair(self) -> "Settings":
        """Require both legacy gateway settings together, or neither."""

        has_base_url = self.THOTH_LEGACY_API_BASE_URL is not None
        has_api_key = self.THOTH_LEGACY_API_KEY is not None
        if has_base_url != has_api_key:
            raise ValueError("legacy gateway base URL and API key must be configured together")
        return self
