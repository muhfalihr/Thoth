"""Strict Stage 1 TikTok soak contracts.

Defines the closed shape of a single observed acquisition run
(`TikTokSoakObservation`), the fixed Stage 1 readiness policy
(`TikTokSoakPolicy`), and the aggregate-only readiness report
(`TikTokSoakReport`) that a soak evaluator produces from many
observations. This module owns the schemas and finite taxonomies only;
it does not evaluate a dataset of observations into a report — that is
a separate, later concern.

The aggregate report graph carries no per-run identity, URL, path, or
timestamp: its submodels only ever hold counts, rates, and a fixed
window, so no caller can smuggle a per-run detail into it.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import StrEnum
from typing import Annotated, Literal, TypeAlias

from pydantic import Field, field_validator, model_validator

from thoth_control_plane.acquisition.models import (
    AcquisitionAttempt,
    AcquisitionStrategy,
    AttemptStatus,
)
from thoth_control_plane.domain.models import (
    LEGACY_FALLBACK_ELIGIBLE_CODES,
    OpaqueId,
    SourceActivityMode,
    StrictModel,
    _parse_rfc3339_timestamp,
)


class TikTokSoakRoute(StrEnum):
    PYTHON_NATIVE = "python_native"
    LEGACY_FALLBACK = "legacy_fallback"
    FAILED = "failed"
    INVALID_INPUT = "invalid_input"
    OPERATOR_CANCELLED = "operator_cancelled"


SoakFailureCode: TypeAlias = Literal[
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
    "acquisition_runner_failed",
    "redaction_audit_failed",
    "absolute_path_audit_failed",
]
"""Finite terminal failure codes, including the redaction and absolute-path
audit failures. These are the only two ways a diagnostic-safety check can
surface on a `route="failed"` observation — never as a new free-form field.
"""


def _parse_utc(value: datetime | str) -> datetime:
    """Parse an RFC 3339 timestamp; reject naive values. Does not itself
    require the UTC offset — callers check that separately."""
    return _parse_rfc3339_timestamp(value)


class TikTokSoakPolicy(StrictModel):
    """Fixed Stage 1 soak thresholds; not user-configurable at runtime."""

    minimum_window_days: Annotated[int, Field(ge=1)] = 7
    minimum_valid_completed_runs: Annotated[int, Field(ge=1)] = 50
    minimum_parity_samples: Annotated[int, Field(ge=1)] = 5
    minimum_python_native_success_rate: Annotated[float, Field(ge=0, le=1)] = 0.95
    maximum_legacy_fallback_rate: Annotated[float, Field(ge=0, le=1)] = 0.05
    maximum_terminal_failure_rate: Annotated[float, Field(ge=0, le=1)] = 0.02


class TikTokSoakObservation(StrictModel):
    """One evaluated Stage 1 acquisition run.

    Reuses `AcquisitionAttempt`/`AcquisitionStrategy`/`AttemptStatus` for the
    attempt ladder rather than a parallel taxonomy, and reuses
    `LEGACY_FALLBACK_ELIGIBLE_CODES` so the fallback allowlist cannot drift
    from the one the workflow itself uses to route.
    """

    schema_version: Literal[1] = 1
    observation_id: Annotated[str, Field(pattern=r"^obs_[a-f0-9]{16,64}$")]
    workflow_id: OpaqueId
    occurred_at: datetime
    activity_mode: SourceActivityMode
    route: TikTokSoakRoute
    attempts: Annotated[list[AcquisitionAttempt], Field(max_length=3)] = Field(default_factory=list)
    failure_code: SoakFailureCode | None = None
    artifact_validated: bool
    partial_cleanup_passed: bool
    browser_cleanup_passed: bool
    parity_passed: bool | None = None

    @field_validator("occurred_at", mode="before")
    @classmethod
    def require_utc(cls, value: datetime | str) -> datetime:
        parsed = _parse_utc(value)
        if parsed.utcoffset() != timedelta(0):
            raise ValueError("occurred_at must use UTC")
        return parsed

    @model_validator(mode="after")
    def validate_terminal_evidence(self) -> TikTokSoakObservation:
        strategies = [attempt.strategy for attempt in self.attempts]
        valid_orders = [
            [],
            [AcquisitionStrategy.SCRAPLING_HEADLESS],
            [AcquisitionStrategy.SCRAPLING_HEADLESS, AcquisitionStrategy.TIKWM_CDN],
        ]
        if strategies not in valid_orders:
            raise ValueError("attempt strategies are not in headless-first order")
        if self.activity_mode == "python" and self.route is TikTokSoakRoute.LEGACY_FALLBACK:
            raise ValueError("python mode cannot use legacy fallback")
        if self.activity_mode == "legacy_scout" and self.route in {
            TikTokSoakRoute.PYTHON_NATIVE,
            TikTokSoakRoute.LEGACY_FALLBACK,
        }:
            raise ValueError("legacy-only mode cannot report a Python route")
        if self.route is TikTokSoakRoute.PYTHON_NATIVE:
            if (
                self.failure_code is not None
                or not self.attempts
                or self.attempts[-1].status is not AttemptStatus.SUCCEEDED
                or not self.artifact_validated
            ):
                raise ValueError("python-native evidence is inconsistent")
        elif self.route is TikTokSoakRoute.LEGACY_FALLBACK:
            # The two guards above already reject activity_mode == "python" and
            # activity_mode == "legacy_scout" for this route, so the check below
            # is currently unreachable for both of them: it is mutually redundant
            # with those earlier guards for today's closed `SourceActivityMode`
            # set. Kept anyway as forward defense in case a fourth activity mode
            # is ever added without updating the guards above.
            if (
                self.activity_mode != "python_tiktok_with_legacy_fallback"
                or self.failure_code not in LEGACY_FALLBACK_ELIGIBLE_CODES
                or not self.attempts
                or self.attempts[-1].status is AttemptStatus.SUCCEEDED
                or not self.artifact_validated
            ):
                raise ValueError("legacy-fallback evidence is inconsistent")
        elif self.route is TikTokSoakRoute.INVALID_INPUT:
            if (
                self.failure_code not in {"invalid_tiktok_url", "unsupported_platform"}
                or self.attempts
                or self.artifact_validated
                or self.parity_passed is not None
            ):
                raise ValueError("invalid-input evidence is inconsistent")
        elif self.route is TikTokSoakRoute.OPERATOR_CANCELLED:
            if (
                self.failure_code is not None
                or self.artifact_validated
                or self.parity_passed is not None
            ):
                raise ValueError("operator-cancelled evidence is inconsistent")
        elif self.failure_code is None or self.artifact_validated:
            raise ValueError("terminal failure evidence is inconsistent")
        if self.parity_passed is not None and not self.artifact_validated:
            raise ValueError("parity evidence requires a validated artifact")
        return self


class TikTokSoakWindow(StrictModel):
    """The aggregate observation window; never a per-run timestamp."""

    started_at: datetime | None
    ended_at: datetime | None
    duration_hours: Annotated[float, Field(ge=0)]

    @field_validator("started_at", "ended_at", mode="before")
    @classmethod
    def require_utc_or_none(cls, value: datetime | str | None) -> datetime | None:
        if value is None:
            return None
        parsed = _parse_utc(value)
        if parsed.utcoffset() != timedelta(0):
            raise ValueError("window bounds must use UTC")
        return parsed


class TikTokSoakCounts(StrictModel):
    """Aggregate run counts only; never a per-run identity or attempt list."""

    valid_completed: Annotated[int, Field(ge=0)]
    python_native: Annotated[int, Field(ge=0)]
    legacy_fallback: Annotated[int, Field(ge=0)]
    failed: Annotated[int, Field(ge=0)]
    invalid_input: Annotated[int, Field(ge=0)]
    operator_cancelled: Annotated[int, Field(ge=0)]
    parity_samples: Annotated[int, Field(ge=0)]


class TikTokSoakRates(StrictModel):
    """Aggregate rates only; always derived, never a per-run value."""

    python_native: Annotated[float, Field(ge=0, le=1)]
    legacy_fallback: Annotated[float, Field(ge=0, le=1)]
    terminal_failure: Annotated[float, Field(ge=0, le=1)]


class TikTokSoakBlocker(StrEnum):
    INSUFFICIENT_WINDOW = "insufficient_window"
    INSUFFICIENT_VALID_COMPLETED_RUNS = "insufficient_valid_completed_runs"
    INSUFFICIENT_PARITY_SAMPLES = "insufficient_parity_samples"
    PYTHON_NATIVE_RATE_BELOW_MINIMUM = "python_native_rate_below_minimum"
    LEGACY_FALLBACK_RATE_ABOVE_MAXIMUM = "legacy_fallback_rate_above_maximum"
    TERMINAL_FAILURE_RATE_ABOVE_MAXIMUM = "terminal_failure_rate_above_maximum"
    ARTIFACT_PERSISTENCE_FAILURE_PRESENT = "artifact_persistence_failure_present"
    ACQUISITION_DEPENDENCY_FAILURE_PRESENT = "acquisition_dependency_failure_present"
    ACQUISITION_RUNNER_FAILURE_PRESENT = "acquisition_runner_failure_present"
    REDACTION_AUDIT_FAILURE_PRESENT = "redaction_audit_failure_present"
    ABSOLUTE_PATH_AUDIT_FAILURE_PRESENT = "absolute_path_audit_failure_present"
    PARTIAL_CLEANUP_FAILURE_PRESENT = "partial_cleanup_failure_present"
    BROWSER_CLEANUP_FAILURE_PRESENT = "browser_cleanup_failure_present"
    PARITY_FAILURE_PRESENT = "parity_failure_present"


class TikTokSoakReport(StrictModel):
    """Aggregate-only Stage 1 readiness report.

    By construction, none of this model's fields or submodels (`policy`,
    `window`, `counts`, `rates`, `blockers`) can hold an observation id,
    workflow id, URL, post identity, caption, checksum, path, per-run
    attempt list, or per-run timestamp: no such field exists anywhere in
    the graph, and every submodel forbids extra keys.
    """

    schema_version: Literal[1] = 1
    generated_at: datetime
    policy: TikTokSoakPolicy
    window: TikTokSoakWindow
    counts: TikTokSoakCounts
    rates: TikTokSoakRates
    ready: bool
    blockers: list[TikTokSoakBlocker]

    @field_validator("generated_at", mode="before")
    @classmethod
    def require_utc(cls, value: datetime | str) -> datetime:
        parsed = _parse_utc(value)
        if parsed.utcoffset() != timedelta(0):
            raise ValueError("generated_at must use UTC")
        return parsed

    @model_validator(mode="after")
    def validate_report_coherence(self) -> TikTokSoakReport:
        """Cross-field invariants the field types alone cannot express.

        Deliberately narrow: no counts-arithmetic invariant and no blocker
        sort-order pin, both out of scope for this contract.
        """
        if self.ready and self.blockers:
            raise ValueError("a ready report cannot carry any blockers")
        if len(set(self.blockers)) != len(self.blockers):
            raise ValueError("blockers must not contain duplicates")
        if (
            self.window.started_at is not None
            and self.window.ended_at is not None
            and self.window.ended_at < self.window.started_at
        ):
            raise ValueError("window end must not precede window start")
        return self


class TikTokSoakDatasetErrorCode(StrEnum):
    """Finite reasons a soak dataset fails a structural precondition.

    Defined here, alongside `TikTokSoakDatasetError`, so the evaluator
    (a later, separate concern) can raise a stable, closed-set reason
    without this module's own error contract changing shape underneath it.
    """

    EMPTY_DATASET = "empty_dataset"
    DUPLICATE_OBSERVATION = "duplicate_observation"
    UNSUPPORTED_SCHEMA_VERSION = "unsupported_schema_version"
    NON_MONOTONIC_OCCURRED_AT = "non_monotonic_occurred_at"


_DATASET_ERROR_MESSAGES: dict[TikTokSoakDatasetErrorCode, str] = {
    TikTokSoakDatasetErrorCode.EMPTY_DATASET: "the soak dataset contains no observations",
    TikTokSoakDatasetErrorCode.DUPLICATE_OBSERVATION: (
        "the soak dataset contains a duplicate observation"
    ),
    TikTokSoakDatasetErrorCode.UNSUPPORTED_SCHEMA_VERSION: (
        "the soak dataset contains an observation with an unsupported schema version"
    ),
    TikTokSoakDatasetErrorCode.NON_MONOTONIC_OCCURRED_AT: (
        "the soak dataset is not ordered by occurrence time"
    ),
}


class TikTokSoakDatasetError(ValueError):
    """Raised when a soak dataset fails a structural precondition.

    The message is fixed and derived only from `code` — never interpolated
    with an observation id, timestamp, or path.
    """

    def __init__(self, code: TikTokSoakDatasetErrorCode) -> None:
        self.code = code
        super().__init__(_DATASET_ERROR_MESSAGES[code])
