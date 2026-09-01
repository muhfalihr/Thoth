"""Strict, serializable contracts for single-post TikTok acquisition."""

from __future__ import annotations

from enum import StrEnum
from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import Field, HttpUrl, SecretStr, field_validator, model_validator

from thoth_control_plane.domain.models import Checksum, OpaqueId, StrictModel


class AcquisitionStrategy(StrEnum):
    SCRAPLING_HEADLESS = "scrapling_headless"
    TIKWM_CDN = "tikwm_cdn"


class AttemptStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    INCOMPLETE = "incomplete"


class AcquisitionReason(StrEnum):
    HEADLESS_TIMEOUT = "headless_timeout"
    HEADLESS_BLOCKED = "headless_blocked"
    HEADLESS_INCOMPLETE = "headless_incomplete"
    CDN_RATE_LIMITED = "cdn_rate_limited"
    CDN_UNAVAILABLE = "cdn_unavailable"
    MEDIA_VALIDATION_FAILED = "media_validation_failed"


class AcquisitionAttempt(StrictModel):
    strategy: AcquisitionStrategy
    status: AttemptStatus
    reason: AcquisitionReason | None = None
    attempt_count: Annotated[int, Field(ge=1, le=3)]
    elapsed_ms: Annotated[int, Field(ge=0)]


class TikTokPost(StrictModel):
    post_id: Annotated[str, Field(pattern=r"^[0-9]{5,32}$")]
    owner_handle: Annotated[str, Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")]
    caption: Annotated[str, Field(max_length=10_000)] = ""
    published_at: str | None = None
    engagement: dict[str, Annotated[int, Field(ge=0)]] = Field(default_factory=dict)


class ResolvedMedia(StrictModel):
    kind: Literal["video"] = "video"
    ephemeral_url: SecretStr = Field(exclude=True, repr=False)
    media_type: Literal["video/mp4"] = "video/mp4"
    duration_seconds: Annotated[float, Field(ge=0)] | None = None


class MaterializedMedia(StrictModel):
    media_id: OpaqueId
    kind: Literal["video"] = "video"
    index: Literal[1] = 1
    location: PurePosixPath
    media_type: Literal["video/mp4"] = "video/mp4"
    bytes: Annotated[int, Field(ge=10_000, le=524_288_000)]
    checksum: Checksum
    acquisition_strategy: AcquisitionStrategy
    width: Annotated[int, Field(gt=0)] | None = None
    height: Annotated[int, Field(gt=0)] | None = None
    duration_seconds: Annotated[float, Field(ge=0)] | None = None

    @field_validator("location")
    @classmethod
    def validate_location(cls, location: PurePosixPath) -> PurePosixPath:
        if location.is_absolute() or ".." in location.parts:
            raise ValueError("media location must be a safe relative path")
        return location


class BrowserSnapshot(StrictModel):
    final_url: HttpUrl
    post_candidates: list[TikTokPost] = Field(default_factory=list)
    media_candidates: list[ResolvedMedia] = Field(default_factory=list)


class TikTokSource(StrictModel):
    platform: Literal["tiktok"] = "tiktok"
    canonical_url: HttpUrl


class AcquisitionOutcome(StrictModel):
    status: Literal["resolved"] = "resolved"
    attempts: Annotated[list[AcquisitionAttempt], Field(min_length=1, max_length=3)]


class TikTokSourceReport(StrictModel):
    schema_version: Literal[1] = 1
    workflow_id: OpaqueId
    source: TikTokSource
    post: TikTokPost
    media: Annotated[list[MaterializedMedia], Field(min_length=1, max_length=1)]
    outcome: AcquisitionOutcome


class TikTokAcquisitionFailure(StrictModel):
    code: Literal[
        "invalid_tiktok_url",
        "unsupported_platform",
        "headless_timeout",
        "headless_blocked",
        "headless_incomplete",
        "cdn_rate_limited",
        "cdn_unavailable",
        "media_validation_failed",
        "artifact_persistence_failed",
        "acquisition_dependency_unavailable",
    ]
    retryable: bool


class TikTokAcquisitionResult(StrictModel):
    report: TikTokSourceReport | None = None
    failure: TikTokAcquisitionFailure | None = None

    @model_validator(mode="after")
    def require_exactly_one_outcome(self) -> TikTokAcquisitionResult:
        if (self.report is None) == (self.failure is None):
            raise ValueError("acquisition result requires exactly one outcome")
        return self
