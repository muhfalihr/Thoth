"""Contract tests for the Stage 1 TikTok soak dataset schema."""

from __future__ import annotations

import json
from datetime import datetime

import pytest
from annotated_types import MaxLen
from pydantic import ValidationError

from thoth_control_plane.acquisition.models import (
    AcquisitionAttempt,
    AcquisitionReason,
    AcquisitionStrategy,
    AttemptStatus,
)
from thoth_control_plane.operations.tiktok_soak import (
    TikTokSoakBlocker,
    TikTokSoakDatasetError,
    TikTokSoakDatasetErrorCode,
    TikTokSoakObservation,
    TikTokSoakPolicy,
    TikTokSoakReport,
    TikTokSoakRoute,
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
