"""Contract tests for the Stage 1 TikTok soak dataset schema."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from annotated_types import MaxLen
from pydantic import ValidationError

from thoth_control_plane.acquisition.models import (
    AcquisitionAttempt,
    AcquisitionReason,
    AcquisitionStrategy,
    AttemptStatus,
)
from thoth_control_plane.operations import tiktok_soak as soak_module
from thoth_control_plane.operations.tiktok_soak import (
    TikTokSoakBlocker,
    TikTokSoakDatasetError,
    TikTokSoakDatasetErrorCode,
    TikTokSoakObservation,
    TikTokSoakPolicy,
    TikTokSoakReport,
    TikTokSoakRoute,
    evaluate_tiktok_soak,
)

HEADLESS_SUCCEEDED = AcquisitionAttempt(
    strategy=AcquisitionStrategy.SCRAPLING_HEADLESS,
    status=AttemptStatus.SUCCEEDED,
    reason=None,
    attempt_count=1,
    elapsed_ms=500,
)
HEADLESS_FAILED = AcquisitionAttempt(
    strategy=AcquisitionStrategy.SCRAPLING_HEADLESS,
    status=AttemptStatus.FAILED,
    reason=AcquisitionReason.HEADLESS_TIMEOUT,
    attempt_count=1,
    elapsed_ms=500,
)
TIKWM_FAILED = AcquisitionAttempt(
    strategy=AcquisitionStrategy.TIKWM_CDN,
    status=AttemptStatus.FAILED,
    reason=AcquisitionReason.CDN_UNAVAILABLE,
    attempt_count=1,
    elapsed_ms=500,
)
TIKWM_SUCCEEDED = AcquisitionAttempt(
    strategy=AcquisitionStrategy.TIKWM_CDN,
    status=AttemptStatus.SUCCEEDED,
    reason=None,
    attempt_count=1,
    elapsed_ms=500,
)


@pytest.fixture
def valid_observation() -> dict[str, object]:
    return {
        "schema_version": 1,
        "observation_id": "obs_" + "a" * 16,
        "workflow_id": "wf_soak_001",
        "occurred_at": "2026-09-02T12:00:00Z",
        "activity_mode": "python",
        "route": TikTokSoakRoute.PYTHON_NATIVE,
        "attempts": [HEADLESS_SUCCEEDED],
        "failure_code": None,
        "artifact_validated": True,
        "partial_cleanup_passed": True,
        "browser_cleanup_passed": True,
        "parity_passed": None,
    }


def test_valid_observation_round_trips(valid_observation: dict[str, object]) -> None:
    observation = TikTokSoakObservation.model_validate(valid_observation)
    assert observation.route is TikTokSoakRoute.PYTHON_NATIVE
    assert observation.schema_version == 1


def test_observation_rejects_extra_and_non_utc_fields(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "source_url": "https://x"})
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {**valid_observation, "occurred_at": "2026-09-02T19:00:00+07:00"}
        )
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {**valid_observation, "occurred_at": datetime(2026, 9, 2, 19, 0, 0)}
        )


def test_observation_rejects_unsupported_schema_version(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "schema_version": 2})


def test_observation_rejects_unknown_activity_mode(valid_observation: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "activity_mode": "not_a_mode"})


def test_observation_rejects_non_route_instance(valid_observation: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "route": "python_native"})


def test_observation_rejects_unknown_failure_code(valid_observation: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.FAILED,
                "attempts": [],
                "artifact_validated": False,
                "failure_code": "not_a_real_code",
            }
        )


def test_attempts_field_declares_a_maximum_of_three(
    valid_observation: dict[str, object],
) -> None:
    """Only assert the field's own declared metadata here. A `pytest.raises`
    block that actually submits >3 attempts would never isolate this
    constraint: 4 identical `HEADLESS_SUCCEEDED` attempts also violate the
    headless-first attempt-order invariant, so a rejection would be
    ambiguous about which rule fired."""
    metadata = TikTokSoakObservation.model_fields["attempts"].metadata
    assert any(isinstance(item, MaxLen) and item.max_length == 3 for item in metadata)


@pytest.mark.parametrize(
    "changes",
    [
        {"route": TikTokSoakRoute.PYTHON_NATIVE, "failure_code": "cdn_unavailable"},
        {"route": TikTokSoakRoute.LEGACY_FALLBACK, "failure_code": None},
        {"route": TikTokSoakRoute.INVALID_INPUT, "attempts": [HEADLESS_FAILED]},
        {"attempts": [TIKWM_FAILED, HEADLESS_FAILED]},
    ],
)
def test_observation_rejects_inconsistent_route_evidence(
    valid_observation: dict[str, object], changes: dict[str, object]
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, **changes})


def test_invalid_input_route_rejects_non_empty_attempts_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    """Isolate the "attempts must be empty" clause: every other invalid-input
    condition is satisfied, so non-empty attempts is the only possible cause
    of rejection. The existing parametrized invalid-input case also flips
    `failure_code` to an ineligible value, so it never isolates this clause;
    this test supplies an eligible `failure_code` and an unvalidated artifact
    so only the `attempts` clause can be the reason for rejection."""
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.INVALID_INPUT,
                "failure_code": "invalid_tiktok_url",
                "attempts": [HEADLESS_FAILED],
                "artifact_validated": False,
                "parity_passed": None,
            }
        )


def test_invalid_input_route_rejects_ineligible_failure_code_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.INVALID_INPUT,
                "failure_code": "cdn_unavailable",
                "attempts": [],
                "artifact_validated": False,
                "parity_passed": None,
            }
        )


def test_invalid_input_route_rejects_validated_artifact_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.INVALID_INPUT,
                "failure_code": "invalid_tiktok_url",
                "attempts": [],
                "artifact_validated": True,
                "parity_passed": None,
            }
        )


def test_python_native_route_rejects_empty_attempts_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "attempts": []})


def test_python_native_route_rejects_non_succeeded_last_attempt_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "attempts": [HEADLESS_FAILED]})


def test_python_native_route_rejects_unvalidated_artifact_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "artifact_validated": False})


def test_legacy_fallback_route_rejects_empty_attempts_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "activity_mode": "python_tiktok_with_legacy_fallback",
                "route": TikTokSoakRoute.LEGACY_FALLBACK,
                "failure_code": "cdn_unavailable",
                "attempts": [],
                "artifact_validated": True,
            }
        )


def test_legacy_fallback_route_rejects_succeeded_last_attempt_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "activity_mode": "python_tiktok_with_legacy_fallback",
                "route": TikTokSoakRoute.LEGACY_FALLBACK,
                "failure_code": "cdn_unavailable",
                "attempts": [HEADLESS_SUCCEEDED],
                "artifact_validated": True,
            }
        )


def test_legacy_fallback_route_rejects_unvalidated_artifact_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "activity_mode": "python_tiktok_with_legacy_fallback",
                "route": TikTokSoakRoute.LEGACY_FALLBACK,
                "failure_code": "cdn_unavailable",
                "attempts": [HEADLESS_FAILED],
                "artifact_validated": False,
            }
        )


def test_operator_cancelled_route_rejects_validated_artifact_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.OPERATOR_CANCELLED,
                "artifact_validated": True,
            }
        )


def test_failed_route_rejects_missing_failure_code_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.FAILED,
                "attempts": [],
                "artifact_validated": False,
            }
        )


def test_failed_route_rejects_validated_artifact_in_isolation(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.FAILED,
                "attempts": [],
                "failure_code": "cdn_unavailable",
                "artifact_validated": True,
            }
        )


def test_observation_model_forbids_free_form_audit_fields() -> None:
    """Redaction/absolute-path audit failures must ride the closed
    `failure_code` taxonomy, never a new free-form evidence field."""
    forbidden = {
        "redaction_audit_detail",
        "absolute_path_audit_detail",
        "redaction_failure",
        "absolute_path_failure",
        "audit_error",
        "audit_detail",
    }
    assert forbidden.isdisjoint(TikTokSoakObservation.model_fields)


def test_observation_rejects_tikwm_before_scrapling_headless(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "attempts": [TIKWM_SUCCEEDED]})


def test_python_mode_cannot_report_legacy_fallback_route(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.LEGACY_FALLBACK,
                "failure_code": "cdn_unavailable",
                "attempts": [HEADLESS_FAILED],
            }
        )


def test_legacy_scout_mode_cannot_report_python_native_route(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "activity_mode": "legacy_scout"})


def test_legacy_fallback_route_accepts_eligible_failure_code(
    valid_observation: dict[str, object],
) -> None:
    observation = TikTokSoakObservation.model_validate(
        {
            **valid_observation,
            "activity_mode": "python_tiktok_with_legacy_fallback",
            "route": TikTokSoakRoute.LEGACY_FALLBACK,
            "failure_code": "cdn_unavailable",
            "attempts": [HEADLESS_FAILED],
            "artifact_validated": True,
        }
    )
    assert observation.route is TikTokSoakRoute.LEGACY_FALLBACK


def test_legacy_fallback_route_rejects_ineligible_failure_code(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "activity_mode": "python_tiktok_with_legacy_fallback",
                "route": TikTokSoakRoute.LEGACY_FALLBACK,
                "failure_code": "invalid_tiktok_url",
                "attempts": [HEADLESS_FAILED],
                "artifact_validated": True,
            }
        )


def test_operator_cancelled_route_accepts_neutral_evidence(
    valid_observation: dict[str, object],
) -> None:
    observation = TikTokSoakObservation.model_validate(
        {
            **valid_observation,
            "route": TikTokSoakRoute.OPERATOR_CANCELLED,
            "failure_code": None,
            "attempts": [],
            "artifact_validated": False,
            "parity_passed": None,
        }
    )
    assert observation.route is TikTokSoakRoute.OPERATOR_CANCELLED


def test_operator_cancelled_route_rejects_failure_code(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.OPERATOR_CANCELLED,
                "failure_code": "cdn_unavailable",
                "attempts": [],
                "artifact_validated": False,
            }
        )


@pytest.mark.parametrize("code", ["redaction_audit_failed", "absolute_path_audit_failed"])
def test_failed_route_accepts_redaction_and_absolute_path_audit_codes(
    valid_observation: dict[str, object], code: str
) -> None:
    observation = TikTokSoakObservation.model_validate(
        {
            **valid_observation,
            "route": TikTokSoakRoute.FAILED,
            "attempts": [],
            "failure_code": code,
            "artifact_validated": False,
            "parity_passed": None,
        }
    )
    assert observation.failure_code == code


def test_redaction_audit_failure_code_rejected_outside_failed_route(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {**valid_observation, "failure_code": "redaction_audit_failed"}
        )


def test_parity_requires_validated_artifact(valid_observation: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate(
            {
                **valid_observation,
                "route": TikTokSoakRoute.FAILED,
                "attempts": [],
                "artifact_validated": False,
                "failure_code": "cdn_unavailable",
                "parity_passed": True,
            }
        )


def test_policy_defaults_match_fixed_stage1_thresholds() -> None:
    policy = TikTokSoakPolicy()
    assert policy.minimum_window_days == 7
    assert policy.minimum_valid_completed_runs == 50
    assert policy.minimum_parity_samples == 5
    assert policy.minimum_python_native_success_rate == 0.95
    assert policy.maximum_legacy_fallback_rate == 0.05
    assert policy.maximum_terminal_failure_rate == 0.02


def test_policy_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        TikTokSoakPolicy.model_validate({"minimum_window_days": 7, "extra": 1})


def test_policy_rejects_out_of_range_rate() -> None:
    with pytest.raises(ValidationError):
        TikTokSoakPolicy.model_validate({"minimum_python_native_success_rate": 1.5})


def _valid_report_kwargs() -> dict[str, object]:
    return {
        "schema_version": 1,
        "generated_at": "2026-09-02T12:30:00Z",
        "policy": TikTokSoakPolicy(),
        "window": {"started_at": None, "ended_at": None, "duration_hours": 0},
        "counts": {
            "valid_completed": 0,
            "python_native": 0,
            "legacy_fallback": 0,
            "failed": 0,
            "invalid_input": 0,
            "operator_cancelled": 0,
            "parity_samples": 0,
        },
        "rates": {"python_native": 0.0, "legacy_fallback": 0.0, "terminal_failure": 0.0},
        "ready": False,
        "blockers": [TikTokSoakBlocker.INSUFFICIENT_VALID_COMPLETED_RUNS],
    }


def test_aggregate_report_schema_has_no_per_run_identity() -> None:
    report = TikTokSoakReport(**_valid_report_kwargs())
    payload = report.model_dump(mode="json")
    forbidden = {"observation_id", "workflow_id", "attempts", "source_url", "path"}
    assert forbidden.isdisjoint(json.dumps(payload).split('"'))


def test_report_rejects_naive_and_non_utc_generated_at() -> None:
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(
            {**_valid_report_kwargs(), "generated_at": datetime(2026, 9, 2, 12, 30, 0)}
        )
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(
            {**_valid_report_kwargs(), "generated_at": "2026-09-02T19:30:00+07:00"}
        )


def test_report_window_rejects_non_utc_bound() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["window"] = {
        "started_at": "2026-09-02T19:00:00+07:00",
        "ended_at": None,
        "duration_hours": 0,
    }
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_report_graph_cannot_represent_per_run_fields() -> None:
    forbidden_field_names = {
        "observation_id",
        "workflow_id",
        "url",
        "source_url",
        "post_id",
        "caption",
        "checksum",
        "path",
        "location",
        "attempts",
        "occurred_at",
    }
    from thoth_control_plane.operations.tiktok_soak import (
        TikTokSoakCounts,
        TikTokSoakRates,
        TikTokSoakWindow,
    )

    models = (
        TikTokSoakReport,
        TikTokSoakWindow,
        TikTokSoakCounts,
        TikTokSoakRates,
        TikTokSoakPolicy,
    )
    for model in models:
        assert forbidden_field_names.isdisjoint(model.model_fields)


def test_report_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate({**_valid_report_kwargs(), "note": "extra"})


def test_report_submodels_reject_extra_fields() -> None:
    """`TikTokSoakReport.model_fields` inheriting `StrictModel` is not the same
    as each submodel actually enforcing `extra="forbid"` at construction time;
    exercise the three submodels directly rather than only the top-level
    report."""
    from thoth_control_plane.operations.tiktok_soak import (
        TikTokSoakCounts,
        TikTokSoakRates,
        TikTokSoakWindow,
    )

    valid_window = {"started_at": None, "ended_at": None, "duration_hours": 0}
    valid_counts = {
        "valid_completed": 0,
        "python_native": 0,
        "legacy_fallback": 0,
        "failed": 0,
        "invalid_input": 0,
        "operator_cancelled": 0,
        "parity_samples": 0,
    }
    valid_rates = {"python_native": 0.0, "legacy_fallback": 0.0, "terminal_failure": 0.0}

    with pytest.raises(ValidationError):
        TikTokSoakWindow.model_validate({**valid_window, "extra": 1})
    with pytest.raises(ValidationError):
        TikTokSoakCounts.model_validate({**valid_counts, "extra": 1})
    with pytest.raises(ValidationError):
        TikTokSoakRates.model_validate({**valid_rates, "extra": 1})


def test_report_blockers_rejects_unknown_value() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["blockers"] = ["not_a_real_blocker"]
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_report_window_rejects_non_utc_ended_at() -> None:
    naive_kwargs = _valid_report_kwargs()
    naive_kwargs["window"] = {
        "started_at": None,
        "ended_at": datetime(2026, 9, 2, 19, 0, 0),
        "duration_hours": 0,
    }
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(naive_kwargs)

    offset_kwargs = _valid_report_kwargs()
    offset_kwargs["window"] = {
        "started_at": None,
        "ended_at": "2026-09-02T19:00:00+07:00",
        "duration_hours": 0,
    }
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(offset_kwargs)


def test_report_rejects_unsupported_schema_version() -> None:
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate({**_valid_report_kwargs(), "schema_version": 2})


def test_report_counts_rejects_negative_value() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["counts"] = {**kwargs["counts"], "valid_completed": -1}
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_report_rates_rejects_out_of_range_value() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["rates"] = {**kwargs["rates"], "python_native": 1.5}
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_report_window_rejects_negative_duration_hours() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["window"] = {**kwargs["window"], "duration_hours": -1}
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_observation_rejects_malformed_observation_id(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "observation_id": "not_obs_id"})


def test_observation_rejects_malformed_workflow_id(
    valid_observation: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        TikTokSoakObservation.model_validate({**valid_observation, "workflow_id": "1_invalid"})


def test_legacy_fallback_route_accepts_two_step_attempt_ladder(
    valid_observation: dict[str, object],
) -> None:
    observation = TikTokSoakObservation.model_validate(
        {
            **valid_observation,
            "activity_mode": "python_tiktok_with_legacy_fallback",
            "route": TikTokSoakRoute.LEGACY_FALLBACK,
            "failure_code": "cdn_unavailable",
            "attempts": [HEADLESS_FAILED, TIKWM_FAILED],
            "artifact_validated": True,
        }
    )
    assert observation.route is TikTokSoakRoute.LEGACY_FALLBACK
    assert observation.attempts == [HEADLESS_FAILED, TIKWM_FAILED]


def test_report_ready_rejects_non_empty_blockers() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["ready"] = True
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_report_rejects_duplicate_blockers() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["ready"] = False
    kwargs["blockers"] = [
        TikTokSoakBlocker.INSUFFICIENT_VALID_COMPLETED_RUNS,
        TikTokSoakBlocker.INSUFFICIENT_VALID_COMPLETED_RUNS,
    ]
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_report_window_rejects_ended_before_started() -> None:
    kwargs = _valid_report_kwargs()
    kwargs["window"] = {
        "started_at": "2026-09-02T12:00:00Z",
        "ended_at": "2026-09-02T11:00:00Z",
        "duration_hours": 1,
    }
    with pytest.raises(ValidationError):
        TikTokSoakReport.model_validate(kwargs)


def test_dataset_error_message_is_fixed_per_code() -> None:
    for code in TikTokSoakDatasetErrorCode:
        error = TikTokSoakDatasetError(code)
        assert error.code is code
        message = str(error)
        assert message
        forbidden_substrings = ("http", "://", "obs_", "wf_", "C:", "/", "\\")
        assert not any(term in message for term in forbidden_substrings)


# --- Deterministic soak evaluation (evaluate_tiktok_soak) --------------------
#
# The fixtures below build datasets purely from `TikTokSoakObservation`
# instances (never raw dicts), so every dataset already satisfies the
# per-route evidence invariants enforced by Task 5. Each mutator/boundary
# helper changes exactly one thing relative to a known-ready baseline, so a
# rejection or a blocker can only ever be attributed to the one rule it
# claims to exercise.

GENERATED_AT = datetime(2026, 9, 2, 12, 30, tzinfo=UTC)
_BASE_TIME = datetime(2026, 8, 1, tzinfo=UTC)
_READY_WINDOW = timedelta(hours=168)


def _obs_id(n: int) -> str:
    return f"obs_{n:016x}"


def _wf_id(n: int) -> str:
    return f"wf_soak_{n:06d}"


def _timestamps(count: int, duration: timedelta) -> list[datetime]:
    """`count` non-decreasing timestamps spanning exactly `duration`: the
    first `count - 1` are one second apart starting at `_BASE_TIME`, and the
    last lands at exactly `_BASE_TIME + duration` so window-duration math
    stays float-exact for whole-hour durations."""
    if count == 1:
        return [_BASE_TIME]
    return [_BASE_TIME + timedelta(seconds=i) for i in range(count - 1)] + [_BASE_TIME + duration]


def _run(
    n: int,
    occurred_at: datetime,
    kind: str,
    *,
    parity_passed: bool | None = None,
) -> TikTokSoakObservation:
    if kind == "native":
        return TikTokSoakObservation(
            observation_id=_obs_id(n),
            workflow_id=_wf_id(n),
            occurred_at=occurred_at,
            activity_mode="python_tiktok_with_legacy_fallback",
            route=TikTokSoakRoute.PYTHON_NATIVE,
            attempts=[HEADLESS_SUCCEEDED],
            failure_code=None,
            artifact_validated=True,
            partial_cleanup_passed=True,
            browser_cleanup_passed=True,
            parity_passed=parity_passed,
        )
    if kind == "fallback":
        return TikTokSoakObservation(
            observation_id=_obs_id(n),
            workflow_id=_wf_id(n),
            occurred_at=occurred_at,
            activity_mode="python_tiktok_with_legacy_fallback",
            route=TikTokSoakRoute.LEGACY_FALLBACK,
            attempts=[HEADLESS_FAILED],
            failure_code="cdn_unavailable",
            artifact_validated=True,
            partial_cleanup_passed=True,
            browser_cleanup_passed=True,
            parity_passed=None,
        )
    if kind == "failed":
        return TikTokSoakObservation(
            observation_id=_obs_id(n),
            workflow_id=_wf_id(n),
            occurred_at=occurred_at,
            activity_mode="python_tiktok_with_legacy_fallback",
            route=TikTokSoakRoute.FAILED,
            attempts=[],
            failure_code="cdn_unavailable",
            artifact_validated=False,
            partial_cleanup_passed=True,
            browser_cleanup_passed=True,
            parity_passed=None,
        )
    raise ValueError(kind)


def _dataset(
    routes: list[str], *, duration: timedelta = _READY_WINDOW, parity_true: int = 5
) -> list[TikTokSoakObservation]:
    timestamps = _timestamps(len(routes), duration)
    native_seen = 0
    observations = []
    for i, (kind, occurred_at) in enumerate(zip(routes, timestamps, strict=True)):
        parity_passed = None
        if kind == "native" and native_seen < parity_true:
            parity_passed = True
            native_seen += 1
        observations.append(_run(i, occurred_at, kind, parity_passed=parity_passed))
    return observations


def route_mix(*, native: int, fallback: int, failed: int) -> list[TikTokSoakObservation]:
    routes = ["native"] * native + ["fallback"] * fallback + ["failed"] * failed
    return _dataset(routes)


def completed_runs(count: int) -> list[TikTokSoakObservation]:
    return _dataset(["native"] * count)


def parity_samples(count: int) -> list[TikTokSoakObservation]:
    return _dataset(["native"] * 50, parity_true=count)


def window_at(*, hours: int, minutes: int, seconds: int) -> list[TikTokSoakObservation]:
    duration = timedelta(hours=hours, minutes=minutes, seconds=seconds)
    return _dataset(["native"] * 95 + ["fallback"] * 3 + ["failed"] * 2, duration=duration)


def duplicate_observation_id(
    observations: list[TikTokSoakObservation],
) -> list[TikTokSoakObservation]:
    mutated = list(observations)
    mutated[1] = mutated[1].model_copy(update={"observation_id": mutated[0].observation_id})
    return mutated


def duplicate_workflow_id(
    observations: list[TikTokSoakObservation],
) -> list[TikTokSoakObservation]:
    mutated = list(observations)
    mutated[1] = mutated[1].model_copy(update={"workflow_id": mutated[0].workflow_id})
    return mutated


def reverse_timestamp_order(
    observations: list[TikTokSoakObservation],
) -> list[TikTokSoakObservation]:
    return list(reversed(observations))


def swap_adjacent_interior_observations(
    observations: list[TikTokSoakObservation],
) -> list[TikTokSoakObservation]:
    """Swap two adjacent interior observations, leaving both endpoints in
    order. Unlike `reverse_timestamp_order`, this cannot also be rejected by
    `TikTokSoakWindow`'s non-negative-duration guard (endpoints are
    untouched, so `duration_hours` stays positive) — it isolates the
    chronological-order check as the only possible reason for rejection."""
    mutated = list(observations)
    mid = len(mutated) // 2
    mutated[mid], mutated[mid + 1] = mutated[mid + 1], mutated[mid]
    return mutated


def failure_observation(code: str) -> TikTokSoakObservation:
    return TikTokSoakObservation(
        observation_id=_obs_id(9000),
        workflow_id=_wf_id(9000),
        occurred_at=_BASE_TIME + _READY_WINDOW + timedelta(seconds=1),
        activity_mode="python_tiktok_with_legacy_fallback",
        route=TikTokSoakRoute.FAILED,
        attempts=[],
        failure_code=code,
        artifact_validated=False,
        partial_cleanup_passed=True,
        browser_cleanup_passed=True,
        parity_passed=None,
    )


def cleanup_failure(*, partial: bool = True, browser: bool = True) -> TikTokSoakObservation:
    return TikTokSoakObservation(
        observation_id=_obs_id(9001),
        workflow_id=_wf_id(9001),
        occurred_at=_BASE_TIME + _READY_WINDOW + timedelta(seconds=2),
        activity_mode="python_tiktok_with_legacy_fallback",
        route=TikTokSoakRoute.PYTHON_NATIVE,
        attempts=[HEADLESS_SUCCEEDED],
        failure_code=None,
        artifact_validated=True,
        partial_cleanup_passed=partial,
        browser_cleanup_passed=browser,
        parity_passed=None,
    )


def parity_failure() -> TikTokSoakObservation:
    return TikTokSoakObservation(
        observation_id=_obs_id(9002),
        workflow_id=_wf_id(9002),
        occurred_at=_BASE_TIME + _READY_WINDOW + timedelta(seconds=3),
        activity_mode="python_tiktok_with_legacy_fallback",
        route=TikTokSoakRoute.PYTHON_NATIVE,
        attempts=[HEADLESS_SUCCEEDED],
        failure_code=None,
        artifact_validated=True,
        partial_cleanup_passed=True,
        browser_cleanup_passed=True,
        parity_passed=False,
    )


def invalid_input() -> TikTokSoakObservation:
    return TikTokSoakObservation(
        observation_id=_obs_id(9003),
        workflow_id=_wf_id(9003),
        occurred_at=_BASE_TIME + _READY_WINDOW + timedelta(seconds=4),
        activity_mode="python_tiktok_with_legacy_fallback",
        route=TikTokSoakRoute.INVALID_INPUT,
        attempts=[],
        failure_code="invalid_tiktok_url",
        artifact_validated=False,
        partial_cleanup_passed=True,
        browser_cleanup_passed=True,
        parity_passed=None,
    )


def operator_cancelled() -> TikTokSoakObservation:
    return TikTokSoakObservation(
        observation_id=_obs_id(9004),
        workflow_id=_wf_id(9004),
        occurred_at=_BASE_TIME + _READY_WINDOW + timedelta(seconds=5),
        activity_mode="python_tiktok_with_legacy_fallback",
        route=TikTokSoakRoute.OPERATOR_CANCELLED,
        attempts=[],
        failure_code=None,
        artifact_validated=False,
        partial_cleanup_passed=True,
        browser_cleanup_passed=True,
        parity_passed=None,
    )


@pytest.fixture
def ready_observations() -> list[TikTokSoakObservation]:
    """A dataset that lands exactly on every Stage 1 threshold at once: a
    168-hour window, 100 completed runs, 5 parity samples, 95% native,
    3% fallback, 2% terminal failure — every rate boundary that is a `<=`
    or `>=` limit sits exactly at its edge, so this fixture alone proves the
    evaluator treats `==` as passing, not failing."""
    return route_mix(native=95, fallback=3, failed=2)


def test_ready_observations_yield_a_ready_report(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    report = evaluate_tiktok_soak(ready_observations, generated_at=GENERATED_AT)
    assert report.ready is True
    assert report.blockers == []
    assert report.window.started_at == ready_observations[0].occurred_at
    assert report.window.ended_at == ready_observations[-1].occurred_at
    assert report.window.duration_hours == 168.0
    assert (
        report.counts.valid_completed,
        report.counts.python_native,
        report.counts.legacy_fallback,
        report.counts.failed,
        report.counts.invalid_input,
        report.counts.operator_cancelled,
        report.counts.parity_samples,
    ) == (100, 95, 3, 2, 0, 0, 5)
    assert (
        report.rates.python_native,
        report.rates.legacy_fallback,
        report.rates.terminal_failure,
    ) == (0.95, 0.03, 0.02)


@pytest.mark.parametrize(
    ("mutator", "expected_code"),
    [
        (duplicate_observation_id, "duplicate_observation_id"),
        (duplicate_workflow_id, "duplicate_workflow_id"),
        (reverse_timestamp_order, "observations_not_chronological"),
        (swap_adjacent_interior_observations, "observations_not_chronological"),
    ],
)
def test_invalid_dataset_raises_safe_finite_error(
    ready_observations: list[TikTokSoakObservation],
    mutator,
    expected_code: str,
) -> None:
    with pytest.raises(TikTokSoakDatasetError) as captured:
        evaluate_tiktok_soak(mutator(ready_observations), generated_at=GENERATED_AT)
    assert captured.value.code.value == expected_code
    assert "wf_" not in str(captured.value)
    assert "obs_" not in str(captured.value)


def test_empty_dataset_raises_safe_finite_error() -> None:
    with pytest.raises(TikTokSoakDatasetError) as captured:
        evaluate_tiktok_soak([], generated_at=GENERATED_AT)
    assert captured.value.code is TikTokSoakDatasetErrorCode.EMPTY_DATASET


@pytest.mark.parametrize(
    ("observations", "blocker"),
    [
        (window_at(hours=167, minutes=59, seconds=59), "insufficient_window"),
        (completed_runs(49), "insufficient_valid_completed_runs"),
        (parity_samples(4), "insufficient_parity_samples"),
        (route_mix(native=94, fallback=5, failed=1), "python_native_rate_below_minimum"),
        (route_mix(native=94, fallback=6, failed=0), "legacy_fallback_rate_above_maximum"),
        (route_mix(native=97, fallback=0, failed=3), "terminal_failure_rate_above_maximum"),
    ],
)
def test_policy_boundary_below_or_above_limit_blocks(
    observations: list[TikTokSoakObservation], blocker: str
) -> None:
    report = evaluate_tiktok_soak(observations, generated_at=GENERATED_AT)
    assert blocker in [item.value for item in report.blockers]


@pytest.mark.parametrize(
    "observations",
    [
        window_at(hours=168, minutes=0, seconds=0),
        completed_runs(50),
        parity_samples(5),
        route_mix(native=95, fallback=5, failed=0),
        route_mix(native=96, fallback=2, failed=2),
    ],
)
def test_policy_boundary_at_exact_limit_passes(
    observations: list[TikTokSoakObservation],
) -> None:
    report = evaluate_tiktok_soak(observations, generated_at=GENERATED_AT)
    assert report.ready is True
    assert report.blockers == []


@pytest.mark.parametrize(
    ("observation", "blocker"),
    [
        (
            failure_observation("artifact_persistence_failed"),
            "artifact_persistence_failure_present",
        ),
        (
            failure_observation("acquisition_dependency_unavailable"),
            "acquisition_dependency_failure_present",
        ),
        (failure_observation("acquisition_runner_failed"), "acquisition_runner_failure_present"),
        (failure_observation("redaction_audit_failed"), "redaction_audit_failure_present"),
        (
            failure_observation("absolute_path_audit_failed"),
            "absolute_path_audit_failure_present",
        ),
        (cleanup_failure(partial=False), "partial_cleanup_failure_present"),
        (cleanup_failure(browser=False), "browser_cleanup_failure_present"),
        (parity_failure(), "parity_failure_present"),
    ],
)
def test_zero_tolerance_evidence_always_blocks(
    ready_observations: list[TikTokSoakObservation],
    observation: TikTokSoakObservation,
    blocker: str,
) -> None:
    report = evaluate_tiktok_soak([*ready_observations, observation], generated_at=GENERATED_AT)
    assert blocker in [item.value for item in report.blockers]


def test_invalid_and_cancelled_routes_are_excluded_from_rates(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    baseline = evaluate_tiktok_soak(ready_observations, generated_at=GENERATED_AT)
    report = evaluate_tiktok_soak(
        sorted(
            [*ready_observations, invalid_input(), operator_cancelled()],
            key=lambda item: item.occurred_at,
        ),
        generated_at=GENERATED_AT,
    )
    assert report.rates == baseline.rates
    assert report.blockers == sorted(report.blockers, key=lambda item: item.value)


def test_invalid_and_cancelled_routes_are_counted_but_not_completed(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    report = evaluate_tiktok_soak(
        sorted(
            [*ready_observations, invalid_input(), operator_cancelled()],
            key=lambda item: item.occurred_at,
        ),
        generated_at=GENERATED_AT,
    )
    assert report.counts.invalid_input == 1
    assert report.counts.operator_cancelled == 1
    assert report.counts.valid_completed == 100


def test_report_window_start_ignores_a_leading_non_completed_run(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    """A leading `invalid_input` run must not push `window.started_at`
    earlier than the first completed run."""
    leading = invalid_input().model_copy(
        update={"occurred_at": ready_observations[0].occurred_at - timedelta(seconds=1)}
    )
    report = evaluate_tiktok_soak([leading, *ready_observations], generated_at=GENERATED_AT)
    assert report.window.started_at == ready_observations[0].occurred_at


def test_report_window_end_ignores_a_trailing_non_completed_run(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    """A trailing `operator_cancelled` run must not push `window.ended_at`
    (and therefore `duration_hours`) past the last completed run."""
    trailing = operator_cancelled().model_copy(
        update={"occurred_at": ready_observations[-1].occurred_at + timedelta(seconds=1)}
    )
    report = evaluate_tiktok_soak([*ready_observations, trailing], generated_at=GENERATED_AT)
    assert report.window.ended_at == ready_observations[-1].occurred_at
    assert report.window.duration_hours == 168.0


def test_zero_tolerance_cleanup_failure_blocks_on_a_non_completed_route(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    """Zero-tolerance evidence must be swept across every observation, not
    only completed runs: an aborted (`operator_cancelled`) run is exactly
    where a leaked temp directory or orphaned browser is most likely, and
    losing that route from the sweep would silently drop the blocker."""
    non_completed_cleanup_failure = operator_cancelled().model_copy(
        update={"partial_cleanup_passed": False}
    )
    report = evaluate_tiktok_soak(
        [*ready_observations, non_completed_cleanup_failure], generated_at=GENERATED_AT
    )
    assert "partial_cleanup_failure_present" in [item.value for item in report.blockers]


def test_evaluator_is_pure_and_uses_the_supplied_generated_at(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    first = evaluate_tiktok_soak(ready_observations, generated_at=GENERATED_AT)
    second = evaluate_tiktok_soak(list(ready_observations), generated_at=GENERATED_AT)
    assert first == second
    assert first.generated_at == GENERATED_AT


def test_blocker_order_is_deterministic_lexicographic_by_value() -> None:
    dataset = [
        TikTokSoakObservation(
            observation_id=_obs_id(1),
            workflow_id=_wf_id(1),
            occurred_at=_BASE_TIME,
            activity_mode="python_tiktok_with_legacy_fallback",
            route=TikTokSoakRoute.FAILED,
            attempts=[],
            failure_code="artifact_persistence_failed",
            artifact_validated=False,
            partial_cleanup_passed=True,
            browser_cleanup_passed=True,
            parity_passed=None,
        )
    ]
    report = evaluate_tiktok_soak(dataset, generated_at=GENERATED_AT)
    assert [item.value for item in report.blockers] == [
        "artifact_persistence_failure_present",
        "insufficient_parity_samples",
        "insufficient_valid_completed_runs",
        "insufficient_window",
        "python_native_rate_below_minimum",
        "terminal_failure_rate_above_maximum",
    ]
    repeat = evaluate_tiktok_soak(list(dataset), generated_at=GENERATED_AT)
    assert repeat.blockers == report.blockers


def test_blocker_order_is_stable_across_input_permutation(
    ready_observations: list[TikTokSoakObservation],
) -> None:
    """Two observations share one timestamp (a tie the chronological-order
    check permits), so feeding them in either order is a genuine input
    permutation. Whichever order they are appended in, the final `blockers`
    sequence must come out identical.

    This does NOT by itself prove the evaluator never leaks `set` iteration
    order: both orderings build the same set of blocker members in the same
    interpreter, so `set` iteration order is identical on both sides
    regardless of implementation. That guarantee rests entirely on
    `test_blocker_order_is_deterministic_lexicographic_by_value`, which pins
    an exact known sequence. This test's own value is as two more
    zero-tolerance assertions (`partial_cleanup_failure_present` and
    `redaction_audit_failure_present` both surviving a tied-timestamp
    input) plus confirming permutation-stability of the final list."""
    tie_time = _BASE_TIME + _READY_WINDOW + timedelta(seconds=10)
    cleanup_break = TikTokSoakObservation(
        observation_id=_obs_id(9101),
        workflow_id=_wf_id(9101),
        occurred_at=tie_time,
        activity_mode="python_tiktok_with_legacy_fallback",
        route=TikTokSoakRoute.PYTHON_NATIVE,
        attempts=[HEADLESS_SUCCEEDED],
        failure_code=None,
        artifact_validated=True,
        partial_cleanup_passed=False,
        browser_cleanup_passed=True,
        parity_passed=None,
    )
    audit_break = TikTokSoakObservation(
        observation_id=_obs_id(9102),
        workflow_id=_wf_id(9102),
        occurred_at=tie_time,
        activity_mode="python_tiktok_with_legacy_fallback",
        route=TikTokSoakRoute.FAILED,
        attempts=[],
        failure_code="redaction_audit_failed",
        artifact_validated=False,
        partial_cleanup_passed=True,
        browser_cleanup_passed=True,
        parity_passed=None,
    )
    forward = evaluate_tiktok_soak(
        [*ready_observations, cleanup_break, audit_break], generated_at=GENERATED_AT
    )
    backward = evaluate_tiktok_soak(
        [*ready_observations, audit_break, cleanup_break], generated_at=GENERATED_AT
    )
    assert forward.blockers == backward.blockers
    values = [item.value for item in forward.blockers]
    assert "partial_cleanup_failure_present" in values
    assert "redaction_audit_failure_present" in values


def test_dataset_error_from_evaluator_carries_no_raw_identifier() -> None:
    dataset = route_mix(native=1, fallback=0, failed=0)
    duplicated = [dataset[0], dataset[0].model_copy(update={"workflow_id": _wf_id(999)})]
    with pytest.raises(TikTokSoakDatasetError) as captured:
        evaluate_tiktok_soak(duplicated, generated_at=GENERATED_AT)
    message = str(captured.value)
    for forbidden in ("http", "://", "obs_", "wf_", "C:", "/", "\\"):
        assert forbidden not in message


def test_invalid_input_route_accepts_unsupported_platform(
    valid_observation: dict[str, object],
) -> None:
    """`unsupported_platform` stays a valid `invalid_input` failure code.

    Removing it from the fallback-eligible set must not remove it from the
    soak taxonomy: it is still a real pre-provider rejection an operator can
    observe, and it is representable exactly as the route defines -- zero
    attempts, no fallback transition, no validated artifact.
    """
    observation = TikTokSoakObservation.model_validate(
        {
            **valid_observation,
            "route": TikTokSoakRoute.INVALID_INPUT,
            "failure_code": "unsupported_platform",
            "attempts": [],
            "artifact_validated": False,
            "parity_passed": None,
        }
    )
    assert observation.route is TikTokSoakRoute.INVALID_INPUT
    assert observation.failure_code == "unsupported_platform"
    assert observation.attempts == []


def test_soak_contract_shares_the_domain_fallback_allowlist() -> None:
    """One allowlist, three consumers.

    The soak contract must not carry its own copy of the fallback taxonomy.
    Asserting object identity -- not equality -- is what makes a future
    divergence impossible rather than merely unlikely: an equal-but-separate
    frozenset would pass an equality check today and drift tomorrow.
    """
    from thoth_control_plane.domain import models as domain_models
    from thoth_control_plane.workflows import source_investigation as workflow_module

    assert soak_module.LEGACY_FALLBACK_ELIGIBLE_CODES is (
        domain_models.LEGACY_FALLBACK_ELIGIBLE_CODES
    )
    assert workflow_module.LEGACY_FALLBACK_ELIGIBLE_CODES is (
        domain_models.LEGACY_FALLBACK_ELIGIBLE_CODES
    )
    assert "unsupported_platform" not in domain_models.LEGACY_FALLBACK_ELIGIBLE_CODES
