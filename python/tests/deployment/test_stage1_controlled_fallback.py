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

from thoth_control_plane.operations import stage1_controlled_fallback_runner as runner_module
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
from thoth_control_plane.operations.stage1_controlled_fallback_runner import (
    ALL_SERVICES,
    RECLAIM_OUTPUT_SCRIPT,
    STAGE_FIXTURE_SCRIPT,
    TEARDOWN_FIXTURE_SCRIPT,
    CommandResult,
    ControlledFallbackRunConfig,
    ControlledFallbackRunner,
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


@pytest.mark.parametrize("leftover", ["output", "reference-input"])
def test_rejects_leftover_staging_directory(tmp_path: Path, leftover: str) -> None:
    """A stale output could validate as this attempt's artifact; staging must start empty."""
    kwargs = _valid_inputs(tmp_path)
    (kwargs["sample"] / leftover).mkdir()
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


_F1_HARNESS_AMENDMENT = {
    "record_type": "classification_amendment",
    "target_gate_id": "f1",
    "failure_attribution": "gate_harness_defect",
}


def _f2_inputs(tmp_path: Path, index_rows: list[dict[str, object]]) -> dict[str, object]:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"] = _gate(tmp_path, name="f2")
    index = kwargs["sample"].parent / INDEX_NAME
    index.write_text("".join(json.dumps(row) + "\n" for row in index_rows), encoding="utf-8")
    return kwargs


def test_f2_passes_preflight_after_a_recorded_f1_harness_defect(tmp_path: Path) -> None:
    kwargs = _f2_inputs(tmp_path, [{"gate_id": "f1"}, _F1_HARNESS_AMENDMENT])
    check_controlled_fallback_inputs(**kwargs)


@pytest.mark.parametrize(
    "rows",
    [
        [{"gate_id": "f1"}],
        [{"gate_id": "f1"}, {**_F1_HARNESS_AMENDMENT, "failure_attribution": "other"}],
        [{"gate_id": "f1"}, {**_F1_HARNESS_AMENDMENT, "target_gate_id": "f2"}],
    ],
)
def test_f2_requires_a_recorded_f1_harness_defect(
    tmp_path: Path, rows: list[dict[str, object]]
) -> None:
    kwargs = _f2_inputs(tmp_path, rows)
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_f2_does_not_retry_itself(tmp_path: Path) -> None:
    kwargs = _f2_inputs(tmp_path, [{"gate_id": "f1"}, _F1_HARNESS_AMENDMENT, {"gate_id": "f2"}])
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_f1_stays_non_retryable_after_its_amendment(tmp_path: Path) -> None:
    kwargs = _valid_inputs(tmp_path)
    index = kwargs["sample"].parent / INDEX_NAME
    index.write_text(json.dumps(_F1_HARNESS_AMENDMENT) + "\n", encoding="utf-8")
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


_OLDER_DIGEST = "sha256:" + "d4" * 32


def _f3_inputs(tmp_path: Path, index_rows: list[dict[str, object]]) -> dict[str, object]:
    kwargs = _valid_inputs(tmp_path)
    kwargs["sample"] = _gate(tmp_path, name="f3")
    index = kwargs["sample"].parent / INDEX_NAME
    index.write_text("".join(json.dumps(row) + "\n" for row in index_rows), encoding="utf-8")
    return kwargs


def test_f3_activates_a_digest_no_earlier_gate_recorded(tmp_path: Path) -> None:
    kwargs = _f3_inputs(
        tmp_path,
        [
            {"gate_id": "f1", "acquisition_digest": _OLDER_DIGEST},
            _F1_HARNESS_AMENDMENT,
            {"gate_id": "f2", "acquisition_digest": _OLDER_DIGEST},
        ],
    )
    check_controlled_fallback_inputs(**kwargs)


def test_f3_refuses_a_digest_an_earlier_gate_already_recorded(tmp_path: Path) -> None:
    """`f3` activates a corrected image; on an already-gated digest it would be a retry."""
    kwargs = _f3_inputs(tmp_path, [{"gate_id": "f2", "acquisition_digest": VALID_DIGEST}])
    with pytest.raises(Stage1PreflightError):
        check_controlled_fallback_inputs(**kwargs)


def test_f3_does_not_retry_itself(tmp_path: Path) -> None:
    kwargs = _f3_inputs(tmp_path, [{"gate_id": "f3", "acquisition_digest": _OLDER_DIGEST}])
    with pytest.raises(Stage1PreflightError):
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


@pytest.mark.parametrize("gate_id", ["f2", "f3"])
def test_reserve_and_finalize_carry_the_gate_directory_id(tmp_path: Path, gate_id: str) -> None:
    sample = tmp_path / gate_id
    sample.mkdir()
    _reserve(sample)
    assert json.loads((sample / ATTEMPT_NAME).read_text(encoding="utf-8"))["gate_id"] == gate_id
    assert finalize_attempt(sample, _facts(), _INTEGRITY).gate_id == gate_id


def test_reserve_refuses_an_unknown_gate_directory(tmp_path: Path) -> None:
    sample = tmp_path / "f4"
    sample.mkdir()
    with pytest.raises(ControlledFallbackEvidenceError):
        _reserve(sample)
    assert not (sample / ATTEMPT_NAME).exists()


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


# -- Runner: deterministic, shell-free Docker orchestration --------------------

VALID_REVISION = "d4" * 20
GATE_CONTAINER_ID = "fedcba9876543210"
FORBIDDEN_STRINGS = (
    "example.test",
    FIXTURE_URL.strip(),
    CANARY_KEY,
    "ws://",
    "18800",
)


def _service_row(service: str, *, state: str = "running", health: str = "healthy") -> dict:
    return {"Service": service, "Name": f"svc-{service}", "State": state, "Health": health}


def _default_ps_rows() -> list[dict]:
    rows = [_service_row(name) for name in ALL_SERVICES]
    for row in rows:
        if row["Service"] == "worker":
            row["Health"] = ""
    return rows


def _ndjson(rows: list[dict]) -> bytes:
    return "\n".join(json.dumps(row) for row in rows).encode("utf-8")


def _role_inspect(*, image: str = VALID_DIGEST_REF, revision: str = VALID_REVISION) -> bytes:
    return json.dumps(
        [
            {
                "Config": {
                    "Image": image,
                    "User": "10001:10001",
                    "Env": [
                        "THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback"
                    ],
                    "Labels": {"org.opencontainers.image.revision": revision},
                },
                "State": {"Health": {"Status": "healthy"}},
                "RestartCount": 0,
                "NetworkSettings": {"Ports": {"18800/tcp": None}},
            }
        ]
    ).encode("utf-8")


def _plain_inspect(*, restart_count: int = 0) -> bytes:
    return json.dumps([{"RestartCount": restart_count}]).encode("utf-8")


def _probe_payload(*, present: bool = True, count: int = 1) -> bytes:
    return json.dumps({"target_present": present, "target_count": count}).encode("utf-8")


def _classify(argv: list[str]) -> str:
    if argv[:2] == ["docker", "inspect"]:
        return f"inspect:{argv[-1]}"
    if argv[:2] == ["docker", "logs"]:
        return "logs"
    if argv[:2] == ["docker", "rm"]:
        return "rm"
    if argv[:2] == ["docker", "run"]:
        return "stage"
    if argv[0] == "git":
        return "git-status"
    if argv[:2] == ["docker", "compose"]:
        if "--quiet" in argv:
            return "config-quiet"
        if "--images" in argv:
            return "config-images"
        if "exec" in argv:
            return "probe"
        if "up" in argv:
            return "up"
        if "-q" in argv:
            return "ps-q"
        if "ps" in argv:
            return "ps"
    return f"unknown:{argv}"


class FakeExecutor:
    """Records every call and replays canned, synthetic Docker JSON only."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.envs: list[dict[str, str]] = []
        self._queues: dict[str, list[CommandResult | Exception]] = {}
        self.wait_queue: list[CommandResult | Exception] = [CommandResult(0, b"", b"")]

    def queue(self, kind: str, *results: CommandResult | Exception) -> None:
        self._queues[kind] = list(results)

    def run(
        self, argv: list[str], *, env: dict[str, str], timeout: float | None = None
    ) -> CommandResult:
        argv = list(argv)
        self.calls.append(argv)
        self.envs.append(dict(env))
        kind = _classify(argv)
        queue = self._queues.get(kind)
        if queue:
            result = queue.pop(0) if len(queue) > 1 else queue[0]
            if isinstance(result, BaseException):
                raise result
            return result
        return CommandResult(0, b"", b"")

    def wait_container(self, container_id: str, *, timeout: float) -> CommandResult:
        result = self.wait_queue.pop(0) if len(self.wait_queue) > 1 else self.wait_queue[0]
        if isinstance(result, BaseException):
            raise result
        return result


def _happy_executor() -> FakeExecutor:
    executor = FakeExecutor()
    executor.queue("config-quiet", CommandResult(0, b"", b""))
    executor.queue("config-images", CommandResult(0, VALID_DIGEST_REF.encode() + b"\n", b""))
    executor.queue("ps", CommandResult(0, _ndjson(_default_ps_rows()), b""))
    for service in ALL_SERVICES:
        name = f"svc-{service}"
        payload = (
            _role_inspect() if service in ("api", "worker", "legacy-cdp") else _plain_inspect()
        )
        executor.queue(f"inspect:{name}", CommandResult(0, payload, b""))
    executor.queue("probe", CommandResult(0, _probe_payload(), b""))
    executor.queue("git-status", CommandResult(0, b"", b""))
    executor.queue("stage", CommandResult(0, b"", b""))
    executor.queue("up", CommandResult(0, b"", b""))
    executor.queue(
        "ps-q",
        CommandResult(0, GATE_CONTAINER_ID.encode() + b"\n", b""),
        CommandResult(0, b"", b""),
    )
    executor.queue(
        "logs", CommandResult(0, b"synthetic supervisor stdout", b"synthetic supervisor stderr")
    )
    executor.queue("rm", CommandResult(0, b"", b""))
    executor.wait_queue = [CommandResult(0, b"", b"")]
    return executor


def _run_config(tmp_path: Path) -> ControlledFallbackRunConfig:
    kwargs = _valid_inputs(tmp_path)
    return ControlledFallbackRunConfig(
        repository_root=kwargs["repository_root"],
        sample=kwargs["sample"],
        provider=kwargs["provider"],
        data_root=kwargs["data_root"],
        parity_root=kwargs["parity_root"],
        digest=VALID_DIGEST,
        acquisition_revision=VALID_REVISION,
        harness_revision=VALID_HARNESS_REVISION,
        base_compose_file=tmp_path / "compose.stage1.local.yml",
        gate_compose_file=tmp_path / "compose.stage1.controlled-fallback.yml",
    )


def _no_leaked_values(executor: FakeExecutor) -> None:
    for argv in executor.calls:
        rendered = " ".join(argv)
        for forbidden in FORBIDDEN_STRINGS:
            assert forbidden not in rendered
    for env in executor.envs:
        for value in env.values():
            for forbidden in FORBIDDEN_STRINGS:
                assert forbidden not in value


def test_preflight_passes_with_a_healthy_matching_deployment(tmp_path: Path) -> None:
    executor = _happy_executor()
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    runner.preflight()
    _no_leaked_values(executor)


def test_preflight_uses_only_allowlisted_docker_commands(tmp_path: Path) -> None:
    executor = _happy_executor()
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    runner.preflight()
    kinds = {_classify(argv) for argv in executor.calls if argv[0] == "docker"}
    assert kinds <= {
        "config-quiet",
        "config-images",
        "ps",
        "probe",
    } | {f"inspect:svc-{service}" for service in ALL_SERVICES}


def test_preflight_rejects_a_role_running_the_wrong_digest(tmp_path: Path) -> None:
    executor = _happy_executor()
    executor.queue(
        "inspect:svc-api",
        CommandResult(0, _role_inspect(image="ghcr.io/muhfalihr/thoth@sha256:" + "9" * 64), b""),
    )
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_a_role_with_the_wrong_oci_revision(tmp_path: Path) -> None:
    executor = _happy_executor()
    executor.queue(
        "inspect:svc-worker",
        CommandResult(0, _role_inspect(revision="0" * 40), b""),
    )
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_a_service_that_is_not_running(tmp_path: Path) -> None:
    executor = _happy_executor()
    rows = _default_ps_rows()
    rows[0]["State"] = "exited"
    executor.queue("ps", CommandResult(0, _ndjson(rows), b""))
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_an_unhealthy_required_service(tmp_path: Path) -> None:
    executor = _happy_executor()
    rows = _default_ps_rows()
    for row in rows:
        if row["Service"] == "legacy-cdp":
            row["Health"] = "unhealthy"
    executor.queue("ps", CommandResult(0, _ndjson(rows), b""))
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_a_published_cdp_host_port(tmp_path: Path) -> None:
    executor = _happy_executor()
    payload = json.loads(_role_inspect())
    payload[0]["NetworkSettings"]["Ports"]["18800/tcp"] = [{"HostPort": "18800"}]
    executor.queue("inspect:svc-legacy-cdp", CommandResult(0, json.dumps(payload).encode(), b""))
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_a_worker_missing_the_fallback_activity_mode(tmp_path: Path) -> None:
    executor = _happy_executor()
    payload = json.loads(_role_inspect())
    payload[0]["Config"]["Env"] = []
    executor.queue("inspect:svc-worker", CommandResult(0, json.dumps(payload).encode(), b""))
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_a_non_steady_state_shared_cdp_target_count(tmp_path: Path) -> None:
    executor = _happy_executor()
    executor.queue("probe", CommandResult(0, _probe_payload(count=2), b""))
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_an_invalid_compose_configuration(tmp_path: Path) -> None:
    executor = _happy_executor()
    executor.queue("config-quiet", CommandResult(1, b"", b""))
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_rejects_a_dirty_deployment_baseline(tmp_path: Path) -> None:
    executor = _happy_executor()
    executor.queue("git-status", CommandResult(0, b" M some/file.py\n", b""))
    runner = ControlledFallbackRunner(_run_config(tmp_path), executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def test_preflight_still_rejects_invalid_gate_inputs(tmp_path: Path) -> None:
    executor = _happy_executor()
    config = _run_config(tmp_path)
    (config.sample / "url.txt").unlink()
    runner = ControlledFallbackRunner(config, executor)
    with pytest.raises(Stage1PreflightError):
        runner.preflight()


def _mp4(size: int) -> bytes:
    """One structurally valid MP4 header padded to `size`."""
    header = b"\x00\x00\x00\x18ftypmp42"
    return header + b"\x2a" * (size - len(header))


def _write_source_report(sample: Path) -> None:
    output = sample / "output"
    output.mkdir(parents=True, exist_ok=True)
    (output / "main.mp4").write_bytes(_mp4(12_000))
    # Scout records media as an absolute path under its fixed output root, as the live f1 did.
    report = {"main": {"source_local": "/opt/thoth/scout/output/main.mp4"}}
    (output / "source-report.json").write_text(json.dumps(report), encoding="utf-8")


def _run_success(tmp_path: Path) -> tuple[FakeExecutor, ControlledFallbackRunner]:
    executor = _happy_executor()
    config = _run_config(tmp_path)
    _write_source_report(config.sample)
    runner = ControlledFallbackRunner(config, executor)
    return executor, runner


def test_run_once_reserves_before_touching_docker(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    attempt = runner.run_once()
    assert attempt.gate_id == GATE_ID
    first_docker_call = next(argv for argv in executor.calls if argv[0] == "docker")
    assert first_docker_call[:2] in (["docker", "compose"], ["docker", "inspect"])


def test_run_once_follows_the_mandated_step_order(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    runner.run_once()
    kinds = [_classify(argv) for argv in executor.calls if argv[0] in ("docker", "git")]
    assert kinds.index("stage") < kinds.index("up")
    assert kinds.index("up") < kinds.index("logs")
    assert kinds.index("logs") < kinds.index("rm")


def _helper_scripts(executor: FakeExecutor) -> list[str]:
    return [argv[-1] for argv in executor.calls if _classify(argv) == "stage"]


def test_staging_gives_the_gate_user_a_fresh_output_directory() -> None:
    """The overlay binds `output` with `create_host_path: false` and runs as 10001."""
    assert "mkdir -m 0700 /staging/output" in STAGE_FIXTURE_SCRIPT
    assert "chown 10001:10001 /staging/output" in STAGE_FIXTURE_SCRIPT


def test_reclaim_returns_output_to_the_gate_directory_owner() -> None:
    assert 'chown -R "$(stat -c %u:%g /staging)" /staging/output' in RECLAIM_OUTPUT_SCRIPT
    assert "chmod -R u=rwX,go= /staging/output" in RECLAIM_OUTPUT_SCRIPT


def test_run_once_reclaims_output_before_validation_and_tears_down_last(
    tmp_path: Path,
) -> None:
    executor, runner = _run_success(tmp_path)
    runner.run_once()
    assert _helper_scripts(executor) == [
        STAGE_FIXTURE_SCRIPT,
        RECLAIM_OUTPUT_SCRIPT,
        TEARDOWN_FIXTURE_SCRIPT,
    ]


def test_run_once_reclaims_output_even_when_the_gate_never_started(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.queue("up", RuntimeError("synthetic docker failure"))
    runner.run_once()
    assert RECLAIM_OUTPUT_SCRIPT in _helper_scripts(executor)


def test_run_once_reclaim_failure_fails_cleanup(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.queue(
        "stage",
        CommandResult(0, b"", b""),
        CommandResult(1, b"", b""),
        CommandResult(0, b"", b""),
    )
    attempt = runner.run_once()
    assert attempt.cleanup_passed is False
    assert attempt.verdict == "failed"


def test_every_compose_call_resolves_the_gate_from_the_runner_config(tmp_path: Path) -> None:
    """The overlay's `:?` guards need these values; the operator's shell must not supply them."""
    executor, runner = _run_success(tmp_path)
    config = runner._config
    runner.run_once()
    compose_calls = [
        (argv, env)
        for argv, env in zip(executor.calls, executor.envs, strict=True)
        if argv[:2] == ["docker", "compose"]
    ]
    assert compose_calls
    for argv, env in compose_calls:
        assert argv[2:4] == ["--env-file", str(config.repository_root / ".env.stage1.local")]
        assert env == {
            "THOTH_CONTROLLED_FALLBACK_IMAGE": VALID_DIGEST_REF,
            "THOTH_CONTROLLED_FALLBACK_SAMPLE_DIR": str(config.sample),
            "THOTH_STAGE1_PROVIDER_ENV_FILE": str(config.provider),
        }


def test_gate_start_never_touches_a_deployed_dependency(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    runner.run_once()
    (up,) = [argv for argv in executor.calls if _classify(argv) == "up"]
    assert up[-3:] == ["-d", "--no-deps", "controlled-fallback"]


def test_run_once_never_leaks_a_secret_or_url(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    runner.run_once()
    _no_leaked_values(executor)


def test_run_once_success_yields_passed(tmp_path: Path) -> None:
    _executor, runner = _run_success(tmp_path)
    attempt = runner.run_once()
    assert attempt.supervisor_exit_code == 0
    assert attempt.verdict == "passed"


def test_run_once_child_nonzero_yields_failed(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.wait_queue = [CommandResult(1, b"", b"")]
    attempt = runner.run_once()
    assert attempt.supervisor_exit_code == 1
    assert attempt.verdict == "failed"


def test_run_once_signal_exit_yields_failed(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.wait_queue = [CommandResult(-15, b"", b"")]
    attempt = runner.run_once()
    assert attempt.supervisor_exit_code == -15
    assert attempt.verdict == "failed"


def test_run_once_wait_timeout_yields_inconclusive(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.wait_queue = [TimeoutError("bounded wait exceeded")]
    attempt = runner.run_once()
    assert attempt.supervisor_exit_code is None
    assert attempt.verdict == "inconclusive"


def test_run_once_executor_exception_during_start_yields_a_terminal_attempt(
    tmp_path: Path,
) -> None:
    executor, runner = _run_success(tmp_path)
    executor.queue("up", RuntimeError("synthetic docker failure"))
    attempt = runner.run_once()
    assert attempt.supervisor_exit_code is None
    assert attempt.verdict in ("failed", "inconclusive")


def test_run_once_target_count_mismatch_yields_failed(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.queue(
        "probe",
        CommandResult(0, _probe_payload(count=1), b""),
        CommandResult(0, _probe_payload(count=1), b""),
        CommandResult(0, _probe_payload(count=2), b""),
    )
    attempt = runner.run_once()
    assert attempt.target_count_restored is False
    assert attempt.verdict == "failed"


def test_run_once_health_loss_after_yields_failed(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    rows = _default_ps_rows()
    healthy_rows = _ndjson(rows)
    unhealthy_rows = _default_ps_rows()
    for row in unhealthy_rows:
        if row["Service"] == "legacy-cdp":
            row["Health"] = "unhealthy"
    executor.queue(
        "ps", CommandResult(0, healthy_rows, b""), CommandResult(0, _ndjson(unhealthy_rows), b"")
    )
    attempt = runner.run_once()
    assert attempt.cdp_healthy_after is False
    assert attempt.verdict == "failed"


def test_run_once_restart_drift_yields_failed(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.queue(
        "inspect:svc-temporal",
        CommandResult(0, _plain_inspect(restart_count=0), b""),
        CommandResult(0, _plain_inspect(restart_count=1), b""),
    )
    attempt = runner.run_once()
    assert attempt.restart_counts_unchanged is False
    assert attempt.verdict == "failed"


def test_run_once_log_copy_failure_yields_failed(tmp_path: Path) -> None:
    _executor, runner = _run_success(tmp_path)
    (runner._config.sample / "supervisor.stdout.log").mkdir()
    attempt = runner.run_once()
    assert attempt.cleanup_passed is False
    assert attempt.verdict == "failed"


def test_run_once_container_removal_failure_yields_failed(tmp_path: Path) -> None:
    executor, runner = _run_success(tmp_path)
    executor.queue("rm", CommandResult(1, b"", b""))
    attempt = runner.run_once()
    assert attempt.cleanup_passed is False
    assert attempt.verdict == "failed"


def test_gate_container_lookups_include_stopped_containers(tmp_path: Path) -> None:
    """A supervisor that exits before the lookup must still be found, logged, and removed."""
    executor, runner = _run_success(tmp_path)
    runner.run_once()
    lookups = [argv for argv in executor.calls if _classify(argv) == "ps-q"]
    assert len(lookups) == 2
    assert all("--all" in argv for argv in lookups)


def test_run_once_unreadable_output_still_tears_down(tmp_path: Path, monkeypatch) -> None:
    executor, runner = _run_success(tmp_path)

    def refuse(*_args, **_kwargs):
        raise PermissionError("synthetic unreadable output")

    monkeypatch.setattr(runner_module, "measure_scout_reference_artifact", refuse)
    attempt = runner.run_once()
    assert attempt.artifact_validated is False
    assert attempt.verdict == "failed"
    assert TEARDOWN_FIXTURE_SCRIPT in _helper_scripts(executor)


def test_run_once_finalizes_and_appends_exactly_once(tmp_path: Path) -> None:
    _executor, runner = _run_success(tmp_path)
    runner.run_once()
    index_lines = (
        (runner._config.sample.parent / INDEX_NAME).read_text(encoding="utf-8").splitlines()
    )
    assert len(index_lines) == 1
    assert json.loads(index_lines[0])["gate_id"] == GATE_ID


def test_run_once_writes_a_private_integrity_record_never_the_attempt(tmp_path: Path) -> None:
    _executor, runner = _run_success(tmp_path)
    runner.run_once()
    safe_payload = json.loads((runner._config.sample / ATTEMPT_NAME).read_text(encoding="utf-8"))
    assert "media_bytes" not in safe_payload
    assert (runner._config.sample / PRIVATE_INTEGRITY_NAME).exists()


def test_run_once_refuses_a_second_attempt_on_the_same_sample(tmp_path: Path) -> None:
    _executor, runner = _run_success(tmp_path)
    runner.run_once()
    with pytest.raises(ControlledFallbackEvidenceError):
        runner.run_once()
