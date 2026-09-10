"""Behavioural tests for the `f1` controlled fallback preflight and evidence contract.

Every fixture URL below is synthetic: none is the real `f1` fixture, a p1-p6
parity fixture, or a live provider credential. The tests prove the gate is
fail-closed before any container would be created and that its evidence is
atomic, append-only, and never wider than the fixed safe schema.
"""

from __future__ import annotations

import json
import os
import stat
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from thoth_control_plane.operations.stage1_controlled_fallback import (
    ATTEMPT_NAME,
    GATE_ID,
    INDEX_NAME,
    PRIVATE_INTEGRITY_NAME,
    ControlledFallbackEvidenceError,
    ControlledFallbackFacts,
    PrivateArtifactIntegrity,
    append_index,
    check_controlled_fallback_inputs,
    classify_attempt,
    finalize_attempt,
    reserve_attempt,
)
from thoth_control_plane.operations.stage1_local_preflight import Stage1PreflightError

posix_only = pytest.mark.skipif(
    os.name != "posix", reason="file mode bits are only meaningful on POSIX hosts"
)

VALID_DIGEST_REF = "ghcr.io/muhfalihr/thoth@sha256:" + "a1" * 32
VALID_DIGEST = "sha256:" + "a1" * 32
VALID_ACQUISITION_REVISION = "b2" * 20
VALID_HARNESS_REVISION = "c3" * 20
CANARY_KEY = "synthetic-canary-only-not-a-real-key"
VALID_OCR_MODEL = "deepseek/deepseek-ocr"
VALID_PROVIDER_CONTENT = (
    f"THOTH_NOVITA_API_KEY={CANARY_KEY}\nTHOTH_SUBTITLE_OCR_MODEL={VALID_OCR_MODEL}\n"
)
FIXTURE_URL = "https://www.tiktok.com/@creator/video/1111111111\n"
OTHER_FIXTURE_URL = "https://www.tiktok.com/@creator/video/2222222222\n"
OCCURRED_AT = datetime(2026, 9, 10, 12, 0, 0, tzinfo=UTC)


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    return repo


def _data_root(tmp_path: Path) -> Path:
    root = tmp_path / "deployment-data"
    root.mkdir()
    return root


def _parity_root(
    tmp_path: Path, *, name: str = "parity-samples", samples: dict[str, str] | None = None
) -> Path:
    root = tmp_path / name
    root.mkdir()
    for name, content in (samples or {"p1": OTHER_FIXTURE_URL}).items():
        directory = root / name
        directory.mkdir()
        (directory / "url.txt").write_text(content, encoding="utf-8")
    return root


def _provider(tmp_path: Path) -> Path:
    provider = tmp_path / "restricted" / "provider.env"
    provider.parent.mkdir(parents=True, exist_ok=True)
    provider.write_text(VALID_PROVIDER_CONTENT, encoding="utf-8")
    if os.name == "posix":
        provider.chmod(0o600)
    return provider


def _gate(
    tmp_path: Path,
    *,
    name: str = GATE_ID,
    url: str = FIXTURE_URL,
    evidence_root: Path | None = None,
) -> Path:
    root = evidence_root if evidence_root is not None else (tmp_path / "evidence")
    root.mkdir(parents=True, exist_ok=True)
    gate = root / name
    gate.mkdir()
    if os.name == "posix":
        gate.chmod(0o700)
    fixture = gate / "url.txt"
    fixture.write_text(url, encoding="utf-8")
    if os.name == "posix":
        fixture.chmod(0o600)
    return gate


def _valid_inputs(tmp_path: Path) -> dict[str, object]:
    return {
        "image": VALID_DIGEST_REF,
        "sample": _gate(tmp_path),
        "provider": _provider(tmp_path),
        "repository_root": _repo(tmp_path),
        "data_root": _data_root(tmp_path),
        "parity_root": _parity_root(tmp_path),
    }


# -- Preflight: release identity, location, fixture, provider, prior evidence --


def test_valid_inputs_pass_preflight(tmp_path: Path) -> None:
    check_controlled_fallback_inputs(**_valid_inputs(tmp_path))


def test_rejects_mutable_image_tag(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["image"] = "ghcr.io/muhfalihr/thoth:latest"
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_sample_inside_repository(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"] = _gate(tmp_path, evidence_root=kwargs["repository_root"] / "nested")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_sample_inside_deployment_data_root(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"] = _gate(tmp_path, evidence_root=kwargs["data_root"] / "nested")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_sample_inside_parity_root(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"] = _gate(tmp_path, evidence_root=kwargs["parity_root"] / "nested")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_relative_sample_path(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"] = Path("f1")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_gate_directory_named_anything_but_f1(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"] = _gate(tmp_path, name="not-f1")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


@posix_only
def test_rejects_group_or_world_accessible_gate_directory(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"].chmod(0o750)
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_missing_fixture(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / "url.txt").unlink()
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


@posix_only
def test_rejects_symlinked_fixture(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    fixture = kwargs["sample"] / "url.txt"
    fixture.unlink()
    target = tmp_path / "outside-url.txt"
    target.write_text(FIXTURE_URL, encoding="utf-8")
    try:
        fixture.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation is not permitted in this environment")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


@posix_only
def test_rejects_group_readable_fixture(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / "url.txt").chmod(0o640)
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_non_canonical_fixture_url(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / "url.txt").write_text("https://example.test/post/1\n", encoding="utf-8")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_fixture_reused_from_parity(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / "url.txt").write_text(OTHER_FIXTURE_URL, encoding="utf-8")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_accepts_fixture_distinct_from_every_parity_sample(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["parity_root"] = _parity_root(
        tmp_path,
        name="parity-samples-multi",
        samples={
            "p1": OTHER_FIXTURE_URL,
            "p2": "https://www.tiktok.com/@creator/video/3333333333\n",
        },
    )
    check_controlled_fallback_inputs(**kwargs)


@posix_only
def test_rejects_symlink_anywhere_in_gate_directory(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / "extra").mkdir()
    target = tmp_path / "elsewhere.txt"
    target.write_text("x", encoding="utf-8")
    try:
        (kwargs["sample"] / "extra" / "link").symlink_to(target)
    except OSError:
        pytest.skip("symlink creation is not permitted in this environment")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_invalid_provider_file(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    kwargs["provider"].write_text("garbage", encoding="utf-8")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_existing_attempt_record(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / ATTEMPT_NAME).write_text("{}", encoding="utf-8")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_existing_private_integrity_record(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / PRIVATE_INTEGRITY_NAME).write_text("{}", encoding="utf-8")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_rejects_existing_index_row_for_f1(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    index = kwargs["sample"].parent / INDEX_NAME
    index.write_text(
        json.dumps({"gate_id": GATE_ID, "status": "completed"}) + "\n", encoding="utf-8"
    )
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_ignores_index_rows_for_other_gates(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    index = kwargs["sample"].parent / INDEX_NAME
    index.write_text(json.dumps({"gate_id": "not-f1"}) + "\n", encoding="utf-8")
    check_controlled_fallback_inputs(**kwargs)


def test_no_failure_message_contains_the_fixture_value(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / "url.txt").write_text("https://example.test/post/1\n", encoding="utf-8")
    with pytest.raises(Stage1PreflightError) as failure:
        check_controlled_fallback_inputs(**kwargs)
    assert "example.test" not in str(failure.value)
    assert str(kwargs["sample"]) not in str(failure.value)


# -- Reservation / finalization / index: atomic and append-only ----------------


def _facts(**overrides: object) -> ControlledFallbackFacts:
    base: dict[str, object] = {
        "supervisor_exit_code": 0,
        "artifact_present": True,
        "artifact_validated": True,
        "temporary_target_observed": True,
        "health_target_preserved": True,
        "target_count_restored": True,
        "cdp_healthy_after": True,
        "api_healthy_after": True,
        "restart_counts_unchanged": True,
        "cleanup_passed": True,
        "teardown_leaves_nothing": True,
    }
    base.update(overrides)
    return ControlledFallbackFacts(**base)


_INTEGRITY = PrivateArtifactIntegrity(
    report_checksum="sha256:" + "0" * 64,
    media_checksum="sha256:" + "1" * 64,
    media_bytes=12_000,
)


def _reserve(sample: Path) -> None:
    reserve_attempt(
        sample,
        digest=VALID_DIGEST,
        acquisition_revision=VALID_ACQUISITION_REVISION,
        harness_revision=VALID_HARNESS_REVISION,
        occurred_at=OCCURRED_AT,
    )


def _reserved_sample(tmp_path: Path) -> Path:
    sample = tmp_path / GATE_ID
    sample.mkdir()
    _reserve(sample)
    return sample


def test_reserve_attempt_writes_a_pending_record(tmp_path: Path) -> None:
    sample = tmp_path / GATE_ID
    sample.mkdir()
    _reserve(sample)
    payload = json.loads((sample / ATTEMPT_NAME).read_text(encoding="utf-8"))
    assert payload["status"] == "pending"
    assert payload["gate_id"] == GATE_ID
    assert payload["acquisition_digest"] == VALID_DIGEST


@posix_only
def test_reserve_attempt_record_is_mode_0600(tmp_path: Path) -> None:
    sample = tmp_path / GATE_ID
    sample.mkdir()
    _reserve(sample)
    assert stat.S_IMODE((sample / ATTEMPT_NAME).stat().st_mode) == 0o600


def test_reserve_attempt_refuses_to_overwrite_an_existing_record(tmp_path: Path) -> None:
    sample = tmp_path / GATE_ID
    sample.mkdir()
    _reserve(sample)
    with pytest.raises(ControlledFallbackEvidenceError):
        _reserve(sample)


def test_reserve_attempt_rejects_a_malformed_digest(tmp_path: Path) -> None:
    sample = tmp_path / GATE_ID
    sample.mkdir()
    with pytest.raises(ControlledFallbackEvidenceError):
        reserve_attempt(
            sample,
            digest="not-a-digest",
            acquisition_revision=VALID_ACQUISITION_REVISION,
            harness_revision=VALID_HARNESS_REVISION,
            occurred_at=OCCURRED_AT,
        )


def test_reserve_attempt_rejects_a_malformed_revision(tmp_path: Path) -> None:
    sample = tmp_path / GATE_ID
    sample.mkdir()
    with pytest.raises(ControlledFallbackEvidenceError):
        reserve_attempt(
            sample,
            digest=VALID_DIGEST,
            acquisition_revision="too-short",
            harness_revision=VALID_HARNESS_REVISION,
            occurred_at=OCCURRED_AT,
        )


def test_finalize_requires_a_prior_reservation(tmp_path: Path) -> None:
    sample = tmp_path / GATE_ID
    sample.mkdir()
    with pytest.raises(ControlledFallbackEvidenceError):
        finalize_attempt(sample, _facts(), _INTEGRITY)


def test_finalize_writes_the_exact_safe_schema_keys(tmp_path: Path) -> None:
    sample = _reserved_sample(tmp_path)
    attempt = finalize_attempt(sample, _facts(), _INTEGRITY)
    payload = json.loads((sample / ATTEMPT_NAME).read_text(encoding="utf-8"))
    assert set(payload) == {
        "schema_version",
        "gate_id",
        "status",
        "occurred_at",
        "acquisition_digest",
        "acquisition_revision",
        "harness_revision",
        "supervisor_exit_code",
        "artifact_present",
        "artifact_validated",
        "temporary_target_observed",
        "health_target_preserved",
        "target_count_restored",
        "cdp_healthy_after",
        "api_healthy_after",
        "restart_counts_unchanged",
        "cleanup_passed",
        "teardown_leaves_nothing",
        "verdict",
    }
    assert payload["status"] == "completed"
    assert payload["verdict"] == "passed"
    assert attempt.verdict == "passed"


@posix_only
def test_finalize_replaces_the_pending_record_atomically_mode_0600(tmp_path: Path) -> None:
    sample = _reserved_sample(tmp_path)
    finalize_attempt(sample, _facts(), _INTEGRITY)
    path = sample / ATTEMPT_NAME
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert not (sample / f"{ATTEMPT_NAME}.part").exists()


def test_finalize_writes_a_separate_private_integrity_record(tmp_path: Path) -> None:
    sample = _reserved_sample(tmp_path)
    finalize_attempt(sample, _facts(), _INTEGRITY)
    private_payload = json.loads((sample / PRIVATE_INTEGRITY_NAME).read_text(encoding="utf-8"))
    assert private_payload["media_bytes"] == 12_000
    safe_payload = json.loads((sample / ATTEMPT_NAME).read_text(encoding="utf-8"))
    assert "media_bytes" not in safe_payload
    assert "report_checksum" not in safe_payload
    assert "media_checksum" not in safe_payload


@posix_only
def test_finalize_private_integrity_record_is_mode_0600(tmp_path: Path) -> None:
    sample = _reserved_sample(tmp_path)
    finalize_attempt(sample, _facts(), _INTEGRITY)
    assert stat.S_IMODE((sample / PRIVATE_INTEGRITY_NAME).stat().st_mode) == 0o600


def test_finalize_does_not_run_twice(tmp_path: Path) -> None:
    sample = _reserved_sample(tmp_path)
    finalize_attempt(sample, _facts(), _INTEGRITY)
    with pytest.raises(ControlledFallbackEvidenceError):
        finalize_attempt(sample, _facts(), _INTEGRITY)


def test_append_index_writes_one_line_per_call(tmp_path: Path) -> None:
    sample = _reserved_sample(tmp_path)
    attempt = finalize_attempt(sample, _facts(), _INTEGRITY)
    append_index(tmp_path, attempt)
    append_index(tmp_path, attempt)
    lines = (tmp_path / INDEX_NAME).read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert all(json.loads(line)["gate_id"] == GATE_ID for line in lines)


@posix_only
def test_append_index_file_is_mode_0600(tmp_path: Path) -> None:
    sample = _reserved_sample(tmp_path)
    attempt = finalize_attempt(sample, _facts(), _INTEGRITY)
    append_index(tmp_path, attempt)
    assert stat.S_IMODE((tmp_path / INDEX_NAME).stat().st_mode) == 0o600


def test_facts_model_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        ControlledFallbackFacts(**{**_facts().model_dump(), "extra": True})


def test_private_integrity_model_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        PrivateArtifactIntegrity(
            report_checksum="sha256:" + "0" * 64,
            media_checksum="sha256:" + "1" * 64,
            media_bytes=1,
            extra=True,
        )


# -- Verdict precedence: cleanup/teardown > health/restart > artifact > status --


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({}, "passed"),
        ({"cleanup_passed": False}, "failed"),
        ({"teardown_leaves_nothing": False}, "failed"),
        ({"cleanup_passed": False, "supervisor_exit_code": 0}, "failed"),
        ({"health_target_preserved": False}, "failed"),
        ({"target_count_restored": False}, "failed"),
        ({"cdp_healthy_after": False}, "failed"),
        ({"api_healthy_after": False}, "failed"),
        ({"restart_counts_unchanged": False}, "failed"),
        ({"artifact_present": False}, "failed"),
        ({"artifact_validated": False}, "failed"),
        ({"supervisor_exit_code": 1}, "failed"),
        ({"supervisor_exit_code": None}, "inconclusive"),
        ({"temporary_target_observed": False}, "passed"),
        ({"cleanup_passed": False, "supervisor_exit_code": None}, "failed"),
        ({"artifact_validated": False, "supervisor_exit_code": None}, "failed"),
    ],
)
def test_classify_attempt_precedence_matrix(overrides: dict[str, object], expected: str) -> None:
    assert classify_attempt(_facts(**overrides)) == expected
