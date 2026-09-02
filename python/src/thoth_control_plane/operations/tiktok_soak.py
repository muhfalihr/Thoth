"""Strict Stage 1 TikTok soak contracts.

Defines the closed shape of a single observed acquisition run
(`TikTokSoakObservation`), the fixed Stage 1 readiness policy
(`TikTokSoakPolicy`), and the aggregate-only readiness report
(`TikTokSoakReport`) that a soak evaluator produces from many
observations. It also owns `evaluate_tiktok_soak`, the pure, deterministic
function that turns a validated dataset of observations into that
aggregate report — no clock reads, no filesystem, no network, no
randomness. Loading a dataset from disk and writing the report file is a
separate, later concern.

The aggregate report graph carries no per-run identity, URL, path, or
timestamp: its submodels only ever hold counts, rates, and a fixed
window, so no caller can smuggle a per-run detail into it.

`evaluate_tiktok_soak` sorts `blockers` lexicographically by their fixed
string value (`TikTokSoakBlocker.value`). This is the one deliberate,
documented, stable ordering rule: it does not depend on evaluation order,
dict/set iteration order, or which observations happen to trigger which
blocker first, so the same set of violations always renders in the same
sequence.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from fractions import Fraction
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
    # The three members below are the specific reasons `evaluate_tiktok_soak`
    # raises: a duplicate `observation_id`, a duplicate `workflow_id` (checked
    # separately so each mismatch is unambiguous), and observations out of
    # occurrence order. The four members above predate the evaluator and are
    # currently unused with no planned producer — they are Task 5's legacy,
    # kept as-is rather than deleted since removing them is not this task's
    # concern; two of them overlap in meaning with the members below
    # (`DUPLICATE_OBSERVATION` ~ `DUPLICATE_OBSERVATION_ID`,
    # `NON_MONOTONIC_OCCURRED_AT` ~ `OBSERVATIONS_NOT_CHRONOLOGICAL`).
    DUPLICATE_OBSERVATION_ID = "duplicate_observation_id"
    DUPLICATE_WORKFLOW_ID = "duplicate_workflow_id"
    OBSERVATIONS_NOT_CHRONOLOGICAL = "observations_not_chronological"


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
    TikTokSoakDatasetErrorCode.DUPLICATE_OBSERVATION_ID: (
        "the soak dataset contains a duplicate observation id"
    ),
    TikTokSoakDatasetErrorCode.DUPLICATE_WORKFLOW_ID: (
        "the soak dataset contains a duplicate workflow id"
    ),
    TikTokSoakDatasetErrorCode.OBSERVATIONS_NOT_CHRONOLOGICAL: (
        "the soak dataset's observations are not in chronological order"
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


_COMPLETED_ROUTES = frozenset(
    {TikTokSoakRoute.PYTHON_NATIVE, TikTokSoakRoute.LEGACY_FALLBACK, TikTokSoakRoute.FAILED}
)

_ZERO_TOLERANCE_CODES: dict[SoakFailureCode, TikTokSoakBlocker] = {
    "artifact_persistence_failed": TikTokSoakBlocker.ARTIFACT_PERSISTENCE_FAILURE_PRESENT,
    "acquisition_dependency_unavailable": TikTokSoakBlocker.ACQUISITION_DEPENDENCY_FAILURE_PRESENT,
    "acquisition_runner_failed": TikTokSoakBlocker.ACQUISITION_RUNNER_FAILURE_PRESENT,
    "redaction_audit_failed": TikTokSoakBlocker.REDACTION_AUDIT_FAILURE_PRESENT,
    "absolute_path_audit_failed": TikTokSoakBlocker.ABSOLUTE_PATH_AUDIT_FAILURE_PRESENT,
}


def _rate(count: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else count / denominator


def _fraction(value: float) -> Fraction:
    """Convert a policy threshold to an exact `Fraction` via its decimal
    string, so `0.95` compares as exactly 95/100 rather than the nearest
    float64 — a rate that lands exactly on a threshold must always compare
    the same way, on every machine.

    Float division would already agree with this at any completed-run count
    below roughly 9e14 (the scale at which IEEE-754 rounding could first
    disagree with the exact rational for these thresholds) — far beyond any
    soak this evaluator will ever see. `Fraction` is kept anyway because it
    is correct without needing that bound to hold.
    """
    return Fraction(str(value))


def _validate_dataset(observations: list[TikTokSoakObservation]) -> None:
    """Reject a structurally invalid dataset before any aggregation runs.

    Fail closed: any of these conditions must prevent a report from ever
    being constructed, so this always runs first and raises immediately.
    """
    if not observations:
        raise TikTokSoakDatasetError(TikTokSoakDatasetErrorCode.EMPTY_DATASET)
    if len({item.observation_id for item in observations}) != len(observations):
        raise TikTokSoakDatasetError(TikTokSoakDatasetErrorCode.DUPLICATE_OBSERVATION_ID)
    if len({item.workflow_id for item in observations}) != len(observations):
        raise TikTokSoakDatasetError(TikTokSoakDatasetErrorCode.DUPLICATE_WORKFLOW_ID)
    timestamps = [item.occurred_at for item in observations]
    if timestamps != sorted(timestamps):
        raise TikTokSoakDatasetError(TikTokSoakDatasetErrorCode.OBSERVATIONS_NOT_CHRONOLOGICAL)


def evaluate_tiktok_soak(
    observations: list[TikTokSoakObservation],
    policy: TikTokSoakPolicy = TikTokSoakPolicy(),  # noqa: B008 - fixed Stage 1 policy, never mutated
    *,
    generated_at: datetime | None = None,
) -> TikTokSoakReport:
    """Turn a validated dataset of observations into an aggregate readiness
    report. Pure and deterministic: no clock read, no filesystem, no
    network, no randomness — `generated_at` is a parameter, never sampled
    from the clock here, so the CLI (a separate, later concern) is the only
    caller that ever supplies the current time.

    Raises `TikTokSoakDatasetError` for a structurally invalid dataset and
    never returns a partial report in that case.
    """
    _validate_dataset(observations)

    completed = [item for item in observations if item.route in _COMPLETED_ROUTES]
    denominator = len(completed)
    native = sum(item.route is TikTokSoakRoute.PYTHON_NATIVE for item in completed)
    fallback = sum(item.route is TikTokSoakRoute.LEGACY_FALLBACK for item in completed)
    failed = sum(item.route is TikTokSoakRoute.FAILED for item in completed)
    invalid_input = sum(item.route is TikTokSoakRoute.INVALID_INPUT for item in observations)
    operator_cancelled = sum(
        item.route is TikTokSoakRoute.OPERATOR_CANCELLED for item in observations
    )
    parity_sample_count = sum(item.parity_passed is not None for item in observations)

    started_at = completed[0].occurred_at if completed else None
    ended_at = completed[-1].occurred_at if completed else None
    duration_hours = (
        (ended_at - started_at).total_seconds() / 3600
        if started_at is not None and ended_at is not None
        else 0.0
    )

    blockers: set[TikTokSoakBlocker] = set()
    if duration_hours < policy.minimum_window_days * 24:
        blockers.add(TikTokSoakBlocker.INSUFFICIENT_WINDOW)
    if denominator < policy.minimum_valid_completed_runs:
        blockers.add(TikTokSoakBlocker.INSUFFICIENT_VALID_COMPLETED_RUNS)
    if parity_sample_count < policy.minimum_parity_samples:
        blockers.add(TikTokSoakBlocker.INSUFFICIENT_PARITY_SAMPLES)
    if Fraction(native, denominator or 1) < _fraction(policy.minimum_python_native_success_rate):
        blockers.add(TikTokSoakBlocker.PYTHON_NATIVE_RATE_BELOW_MINIMUM)
    if Fraction(fallback, denominator or 1) > _fraction(policy.maximum_legacy_fallback_rate):
        blockers.add(TikTokSoakBlocker.LEGACY_FALLBACK_RATE_ABOVE_MAXIMUM)
    if Fraction(failed, denominator or 1) > _fraction(policy.maximum_terminal_failure_rate):
        blockers.add(TikTokSoakBlocker.TERMINAL_FAILURE_RATE_ABOVE_MAXIMUM)

    for item in observations:
        zero_tolerance = _ZERO_TOLERANCE_CODES.get(item.failure_code)
        if zero_tolerance is not None:
            blockers.add(zero_tolerance)
        if not item.partial_cleanup_passed:
            blockers.add(TikTokSoakBlocker.PARTIAL_CLEANUP_FAILURE_PRESENT)
        if not item.browser_cleanup_passed:
            blockers.add(TikTokSoakBlocker.BROWSER_CLEANUP_FAILURE_PRESENT)
        if item.parity_passed is False:
            blockers.add(TikTokSoakBlocker.PARITY_FAILURE_PRESENT)

    # Deterministic, documented order: lexicographic by the blocker's own
    # fixed string value. Never the `set`'s own iteration order.
    ordered_blockers = sorted(blockers, key=lambda blocker: blocker.value)

    return TikTokSoakReport(
        # Fallback is a soak-window bound (`ended_at`), not a wall clock —
        # it never leaks a fresher timestamp than `window.ended_at` itself.
        generated_at=generated_at or ended_at or datetime(1970, 1, 1, tzinfo=UTC),
        policy=policy,
        window=TikTokSoakWindow(
            started_at=started_at, ended_at=ended_at, duration_hours=duration_hours
        ),
        counts=TikTokSoakCounts(
            valid_completed=denominator,
            python_native=native,
            legacy_fallback=fallback,
            failed=failed,
            invalid_input=invalid_input,
            operator_cancelled=operator_cancelled,
            parity_samples=parity_sample_count,
        ),
        rates=TikTokSoakRates(
            python_native=_rate(native, denominator),
            legacy_fallback=_rate(fallback, denominator),
            terminal_failure=_rate(failed, denominator),
        ),
        ready=not ordered_blockers,
        blockers=ordered_blockers,
    )
