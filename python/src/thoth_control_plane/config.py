"""Configuration for the Thoth control plane."""

from pathlib import Path
from typing import Annotated, Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from thoth_control_plane.domain.models import SourceActivityMode
from thoth_control_plane.domain.prompt_proposals import PromptModelDefinition, SafeIdentifier


class PromptProviderRuntimeDefinition(BaseModel):
    """Worker/API shared runtime definition; base_url and credential stay server-side."""

    model_config = ConfigDict(extra="forbid", strict=True)

    provider_id: SafeIdentifier
    label: Annotated[str, Field(min_length=1, max_length=200)]
    protocol: Literal["openai_compatible"]
    base_url: AnyHttpUrl
    credential_id: SafeIdentifier
    models: tuple[PromptModelDefinition, ...]
    enabled: bool = True

    @field_validator("models", mode="before")
    @classmethod
    def _coerce_models(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value


class SettingsValidationError(ValueError):
    """Safe settings validation error that does not retain constructor inputs."""

    def errors(self) -> list[dict[str, str]]:
        """Provide a Pydantic-like sanitized error shape without input values."""

        return [{"type": "value_error", "msg": str(self)}]


def _is_same_origin_path(value: str) -> bool:
    """A preview URL must stay same-origin so no capability can travel to another host."""
    return (
        value.startswith("/")
        and not value.startswith("//")
        and not any(character in value for character in ":\\?#")
    )


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables or explicit values."""

    model_config = SettingsConfigDict(env_prefix="", case_sensitive=True)

    THOTH_CONTROL_PLANE_API_KEY: SecretStr
    THOTH_CONTROL_PLANE_CORS_ORIGINS: list[str] = Field(default_factory=list)
    THOTH_CONTROL_PLANE_ARTIFACT_ROOT: Path = Path(".thoth-artifacts")
    THOTH_TEMPORAL_TARGET: str = "localhost:7233"
    THOTH_TEMPORAL_NAMESPACE: str = "default"
    THOTH_LEGACY_API_BASE_URL: str | None = None
    THOTH_LEGACY_API_KEY: SecretStr | None = None
    THOTH_EDITOR_DATABASE_URL: SecretStr | None = None
    THOTH_EDITOR_PREVIEW_SIGNING_KEY: SecretStr | None = None
    THOTH_EDITOR_PREVIEW_TTL_SECONDS: Annotated[int, Field(ge=30, le=3600)] = 300
    THOTH_EDITOR_PREVIEW_BASE_URL: str | None = None
    THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: SourceActivityMode = (
        "python_tiktok_with_legacy_fallback"
    )
    THOTH_PROMPT_PROVIDER_CATALOG: tuple[PromptProviderRuntimeDefinition, ...] = ()
    THOTH_PROMPT_PROVIDER_SECRETS: dict[SafeIdentifier, SecretStr] = Field(default_factory=dict)

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
        preview_base_url = self.THOTH_EDITOR_PREVIEW_BASE_URL
        if preview_base_url is not None and not _is_same_origin_path(preview_base_url):
            raise SettingsValidationError(
                "editor preview base URL must be a same-origin relative path"
            )
        provider_ids: set[str] = set()
        for provider in self.THOTH_PROMPT_PROVIDER_CATALOG:
            if provider.provider_id in provider_ids:
                raise SettingsValidationError("prompt provider catalog contains a duplicate id")
            provider_ids.add(provider.provider_id)
            model_ids: set[str] = set()
            for model in provider.models:
                if model.model_id in model_ids:
                    raise SettingsValidationError(
                        "prompt provider catalog contains a duplicate model id"
                    )
                model_ids.add(model.model_id)

    @property
    def prompt_provider_secrets(self) -> dict[str, SecretStr]:
        """Worker-only credential map keyed by catalog credential_id."""
        return dict(self.THOTH_PROMPT_PROVIDER_SECRETS)

    @property
    def legacy_bridge_enabled(self) -> bool:
        """Whether the validated legacy observation bridge can be constructed."""
        return self.THOTH_LEGACY_API_BASE_URL is not None and self.THOTH_LEGACY_API_KEY is not None

    @property
    def source_investigation_activity_mode(self) -> SourceActivityMode:
        """Worker-owned activity selection, intentionally outside HTTP request handling."""
        return self.THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
