"""Offline coverage for the paired TikTok parity comparison helper.

Every test builds its evidence on disk and compares it: nothing here acquires,
contacts a provider, or touches restricted evidence. The helper has to be
trustworthy before it is pointed at a real sample, so the cases below cover a
match, a contract mismatch, malformed reports, missing files, path escapes,
invalid integrity, and two legitimately different valid encodings.
"""

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from thoth_control_plane.cli import app
from thoth_control_plane.operations.tiktok_parity import (
    PARITY_FIELDS,
    ScoutArtifactMeasurement,
    TikTokParityEvidenceError,
    compare_parity_sample,
    measure_scout_reference_artifact,
    render_parity_comparison,
    resolve_artifact_path,
    validate_scout_reference_artifact,
)

runner = CliRunner()

_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "tiktok" / "normalized_report.json"
_CANONICAL_URL = "https://www.tiktok.com/@creator/video/1234567890"
_PYTHON_MEDIA_LOCATION = "reports/wf_contract_001/media/tiktok-1234567890.mp4"
_RECORDED_MEDIA = "/opt/thoth/scout/output/acquisition-media/main.mp4"


def _mp4(size: int, filler: bytes = b"\x2a") -> bytes:
    """One structurally valid MP4 header padded to `size`."""
    header = b"\x00\x00\x00\x18ftypmp42"
    return header + filler * (size - len(header))


def _sha(payload: bytes) -> str:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _write_json(path: Path, payload: dict[str, Any]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(payload).encode("utf-8")
    path.write_bytes(content)
    return _sha(content)


def _pair(
    tmp_path: Path,
    *,
    python_media: bytes | None = _mp4(12_000),
    scout_media: bytes | None = _mp4(15_000, b"\x37"),
    python_media_location: str = _PYTHON_MEDIA_LOCATION,
    scout_main: dict[str, Any] | None = None,
    scout_recorded_media: str = _RECORDED_MEDIA,
) -> dict[str, Any]:
    """Write one valid pair on disk and return `compare_parity_sample` kwargs.

    The two sides carry deliberately different media bytes: the same post
    acquired headless and through the CDN is not expected to be byte-identical.
    """
    python_root = tmp_path / "python-root"
    python_root.mkdir(parents=True, exist_ok=True)
    payload = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    payload["media"][0]["location"] = python_media_location
    if python_media is not None:
        media_path = python_root / python_media_location
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(python_media)
        payload["media"][0]["bytes"] = len(python_media)
        payload["media"][0]["checksum"] = _sha(python_media)
    python_report = tmp_path / "python-source-report.json"
    python_report_checksum = _write_json(python_report, payload)

    scout_root = tmp_path / "scout-root"
    scout_root.mkdir(parents=True, exist_ok=True)
    if scout_media is not None:
        scout_media_path = scout_root / "acquisition-media" / "main.mp4"
        scout_media_path.parent.mkdir(parents=True, exist_ok=True)
        scout_media_path.write_bytes(scout_media)
    main: dict[str, Any] = {
        "source_url": _CANONICAL_URL,
        "platform": "tiktok",
        "description": "",
        "is_video": True,
        "source_local": scout_recorded_media,
        "profile": {"username": "creator", "followers": 12},
        "engagement": {"likes": 3},
    }
    main.update(scout_main or {})
    scout_report = tmp_path / "scout-source-report.json"
    scout_report_checksum = _write_json(scout_report, {"main": main, "footage": [], "comments": []})
    return {
        "python_report": python_report,
        "python_artifact_root": python_root,
        "python_report_checksum": python_report_checksum,
        "scout_report": scout_report,
        "scout_artifact_root": scout_root,
        "scout_report_checksum": scout_report_checksum,
        "scout_media_checksum": _sha(scout_media if scout_media is not None else b""),
        "scout_media_bytes": len(scout_media) if scout_media is not None else 0,
    }


def _scout_side(
    tmp_path: Path,
    *,
    scout_media: bytes | None = _mp4(15_000, b"\x37"),
    scout_main: dict[str, Any] | None = None,
    scout_recorded_media: str = _RECORDED_MEDIA,
) -> tuple[Path, Path]:
    """Write one Scout report/media pair and return `(report_path, artifact_root)`."""
    scout_root = tmp_path / "scout-root"
    scout_root.mkdir(parents=True, exist_ok=True)
    if scout_media is not None:
        scout_media_path = scout_root / "acquisition-media" / "main.mp4"
        scout_media_path.parent.mkdir(parents=True, exist_ok=True)
        scout_media_path.write_bytes(scout_media)
    main: dict[str, Any] = {
        "source_url": _CANONICAL_URL,
        "platform": "tiktok",
        "description": "",
        "is_video": True,
        "source_local": scout_recorded_media,
        "profile": {"username": "creator", "followers": 12},
    }
    main.update(scout_main or {})
    scout_report = tmp_path / "scout-source-report.json"
    _write_json(scout_report, {"main": main, "footage": [], "comments": []})
    return scout_report, scout_root


def test_measure_and_validate_scout_artifact_round_trips(tmp_path: Path) -> None:
    report, root = _scout_side(tmp_path)
    measurement = measure_scout_reference_artifact(report, root)
    assert isinstance(measurement, ScoutArtifactMeasurement)
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.passed is True


def test_validate_scout_artifact_detects_missing_media(tmp_path: Path) -> None:
    """A resolvable but absent file is `media_contained` yet fails checksum."""
    report, root = _scout_side(tmp_path)
    measurement = measure_scout_reference_artifact(report, root)
    (root / "acquisition-media" / "main.mp4").unlink()
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.media_contained is True
    assert integrity.media_checksum_verified is False
    assert integrity.passed is False


def test_validate_scout_artifact_detects_changed_media_bytes(tmp_path: Path) -> None:
    report, root = _scout_side(tmp_path)
    measurement = measure_scout_reference_artifact(report, root)
    (root / "acquisition-media" / "main.mp4").write_bytes(_mp4(15_000, b"\x99"))
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.media_checksum_verified is False
    assert integrity.passed is False


def test_validate_scout_artifact_detects_changed_report(tmp_path: Path) -> None:
    report, root = _scout_side(tmp_path)
    measurement = measure_scout_reference_artifact(report, root)
    payload = json.loads(report.read_text(encoding="utf-8"))
    payload["main"]["description"] = "changed after measurement"
    _write_json(report, payload)
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.report_checksum_verified is False
    assert integrity.passed is False


def test_measure_and_validate_scout_artifact_reject_report_escape(tmp_path: Path) -> None:
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(_mp4(15_000, b"\x37"))
    report, root = _scout_side(tmp_path, scout_recorded_media=str(outside.as_posix()))
    measurement = measure_scout_reference_artifact(report, root)
    assert measurement.media_bytes == 0
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.media_contained is False
    assert integrity.passed is False


def test_validate_scout_artifact_detects_symlinked_media_escape(tmp_path: Path) -> None:
    report, root = _scout_side(tmp_path, scout_media=None)
    outside = tmp_path / "linked.mp4"
    outside.write_bytes(_mp4(12_000))
    link = root / "acquisition-media" / "main.mp4"
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted in this environment")
    measurement = measure_scout_reference_artifact(report, root)
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.media_contained is False
    assert integrity.passed is False


def test_validate_scout_artifact_rejects_invalid_signature(tmp_path: Path) -> None:
    report, root = _scout_side(tmp_path, scout_media=b"\x00" * 15_000)
    measurement = measure_scout_reference_artifact(report, root)
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.media_signature_valid is False
    assert integrity.passed is False


def test_validate_scout_artifact_rejects_below_minimum_size(tmp_path: Path) -> None:
    report, root = _scout_side(tmp_path, scout_media=_mp4(5_000, b"\x37"))
    measurement = measure_scout_reference_artifact(report, root)
    integrity = validate_scout_reference_artifact(report, root, measurement)
    assert integrity.media_minimum_size_met is False
    assert integrity.passed is False


def test_measure_scout_artifact_rejects_malformed_report(tmp_path: Path) -> None:
    report, root = _scout_side(tmp_path)
    report.write_text("{ not json", encoding="utf-8")
    with pytest.raises(TikTokParityEvidenceError):
        measure_scout_reference_artifact(report, root)


def test_compare_parity_sample_still_matches_after_extraction(tmp_path: Path) -> None:
    """The refactor must not change `compare_parity_sample()`'s own behavior."""
    comparison = compare_parity_sample(**_pair(tmp_path))
    assert comparison.passed is True


def test_matching_pair_with_different_valid_encodings_passes(tmp_path: Path) -> None:
    """Different bytes for the same post are parity, not a mismatch."""
    comparison = compare_parity_sample(**_pair(tmp_path))
    assert set(comparison.fields) == set(PARITY_FIELDS)
    assert comparison.fields_match is True
    assert comparison.artifacts_validated is True
    assert comparison.passed is True


def test_contract_mismatch_keeps_the_artifacts_valid(tmp_path: Path) -> None:
    """A caption difference must fail parity without discrediting the artifacts."""
    comparison = compare_parity_sample(**_pair(tmp_path, scout_main={"description": "other"}))
    assert comparison.fields["caption"] is False
    assert comparison.fields["post_id"] is True
    assert comparison.artifacts_validated is True
    assert comparison.passed is False


def test_missing_media_file_fails_integrity_and_presence(tmp_path: Path) -> None:
    comparison = compare_parity_sample(**_pair(tmp_path, python_media=None))
    assert comparison.python_artifact.media_contained is True
    assert comparison.python_artifact.media_checksum_verified is False
    assert comparison.python_artifact.passed is False
    assert comparison.fields["local_media_present"] is False
    assert comparison.passed is False


def test_missing_report_file_is_rejected(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["scout_report"].unlink()
    with pytest.raises(TikTokParityEvidenceError):
        compare_parity_sample(**kwargs)


def test_malformed_report_is_rejected(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["python_report"].write_text("{ not json", encoding="utf-8")
    with pytest.raises(TikTokParityEvidenceError):
        compare_parity_sample(**kwargs)


def test_python_report_failing_schema_is_rejected(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    payload = json.loads(kwargs["python_report"].read_text(encoding="utf-8"))
    payload["media"] = []
    kwargs["python_report_checksum"] = _write_json(kwargs["python_report"], payload)
    with pytest.raises(TikTokParityEvidenceError):
        compare_parity_sample(**kwargs)


def test_scout_report_without_main_is_rejected(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["scout_report_checksum"] = _write_json(kwargs["scout_report"], {"footage": []})
    with pytest.raises(TikTokParityEvidenceError):
        compare_parity_sample(**kwargs)


def test_unusable_post_url_is_rejected(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path, scout_main={"source_url": "https://example.test/post/1"})
    with pytest.raises(TikTokParityEvidenceError):
        compare_parity_sample(**kwargs)


def test_input_url_covers_a_reference_without_its_own_page_url(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path, scout_main={"source_url": None})
    comparison = compare_parity_sample(**kwargs, input_url=_CANONICAL_URL)
    assert comparison.passed is True


def test_malformed_checksum_input_is_rejected(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["scout_media_checksum"] = "not-a-digest"
    with pytest.raises(TikTokParityEvidenceError):
        compare_parity_sample(**kwargs)


def test_scout_location_outside_the_recorded_root_is_never_resolved(tmp_path: Path) -> None:
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(_mp4(15_000, b"\x37"))
    kwargs = _pair(tmp_path, scout_recorded_media=str(outside.as_posix()))
    comparison = compare_parity_sample(**kwargs)
    assert comparison.scout_artifact.media_contained is False
    assert comparison.scout_artifact.media_checksum_verified is False
    assert comparison.fields["local_media_present"] is False


def test_python_report_claiming_a_traversal_is_rejected(tmp_path: Path) -> None:
    """A traversing location never reaches containment: the schema refuses it."""
    (tmp_path / "escape.mp4").write_bytes(_mp4(12_000))
    kwargs = _pair(tmp_path, python_media_location="../escape.mp4")
    with pytest.raises(TikTokParityEvidenceError):
        compare_parity_sample(**kwargs)


def test_resolve_artifact_path_refuses_traversal_and_foreign_roots(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    assert resolve_artifact_path(root, "media/main.mp4") == (root / "media" / "main.mp4").resolve()
    assert resolve_artifact_path(root, "../main.mp4") is None
    assert resolve_artifact_path(root, "") is None
    assert resolve_artifact_path(root, str(tmp_path / "main.mp4")) is None
    assert (
        resolve_artifact_path(root, "/other/output/main.mp4", recorded_root="/opt/thoth/output")
        is None
    )
    assert (
        resolve_artifact_path(root, "/opt/thoth/output/main.mp4", recorded_root="/opt/thoth/output")
        == (root / "main.mp4").resolve()
    )


def test_symlinked_media_outside_the_root_fails_containment(tmp_path: Path) -> None:
    """`resolve()` follows the link, so a link out of the root is an escape."""
    kwargs = _pair(tmp_path, python_media=None)
    outside = tmp_path / "linked.mp4"
    outside.write_bytes(_mp4(12_000))
    link = kwargs["python_artifact_root"] / _PYTHON_MEDIA_LOCATION
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted in this environment")
    comparison = compare_parity_sample(**kwargs)
    assert comparison.python_artifact.media_contained is False
    assert comparison.fields["local_media_present"] is False


def test_recorded_checksum_mismatch_fails_integrity(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["scout_media_checksum"] = _sha(b"a different artifact")
    comparison = compare_parity_sample(**kwargs)
    assert comparison.scout_artifact.media_checksum_verified is False
    assert comparison.scout_artifact.media_signature_valid is True
    assert comparison.fields_match is True
    assert comparison.passed is False


def test_recorded_byte_count_mismatch_fails_integrity(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["scout_media_bytes"] += 1
    comparison = compare_parity_sample(**kwargs)
    assert comparison.scout_artifact.media_byte_count_verified is False
    assert comparison.passed is False


def test_report_checksum_mismatch_fails_integrity(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["python_report_checksum"] = _sha(b"an earlier report")
    comparison = compare_parity_sample(**kwargs)
    assert comparison.python_artifact.report_checksum_verified is False
    assert comparison.passed is False


def test_media_without_an_mp4_signature_fails(tmp_path: Path) -> None:
    comparison = compare_parity_sample(**_pair(tmp_path, scout_media=b"\x00" * 15_000))
    assert comparison.scout_artifact.media_signature_valid is False
    assert comparison.scout_artifact.media_minimum_size_met is True
    assert comparison.passed is False


def test_media_below_the_minimum_size_fails(tmp_path: Path) -> None:
    comparison = compare_parity_sample(**_pair(tmp_path, scout_media=_mp4(5_000, b"\x37")))
    assert comparison.scout_artifact.media_minimum_size_met is False
    assert comparison.scout_artifact.media_checksum_verified is True
    assert comparison.passed is False


def test_rendered_output_carries_no_sample_values(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path, scout_main={"description": "a caption that must not leak"})
    rendered = "\n".join(render_parity_comparison(compare_parity_sample(**kwargs)))
    assert "tiktok.com" not in rendered
    assert "creator" not in rendered
    assert "caption that must not leak" not in rendered
    assert "sha256" not in rendered
    assert str(tmp_path) not in rendered
    assert "1234567890" not in rendered
    assert rendered.endswith("result: fail")


def test_comparison_never_writes_to_the_evidence(tmp_path: Path) -> None:
    """The helper is read-only: it can never edit an observation or an artifact."""
    kwargs = _pair(tmp_path)
    before = {path: path.stat().st_mtime_ns for path in sorted(tmp_path.rglob("*"))}
    compare_parity_sample(**kwargs)
    after = {path: path.stat().st_mtime_ns for path in sorted(tmp_path.rglob("*"))}
    assert before == after


def _cli_arguments(kwargs: dict[str, Any]) -> list[str]:
    return [
        "operations",
        "tiktok-stage1-parity-compare",
        "--python-report",
        str(kwargs["python_report"]),
        "--python-artifact-root",
        str(kwargs["python_artifact_root"]),
        "--python-report-checksum",
        kwargs["python_report_checksum"],
        "--scout-report",
        str(kwargs["scout_report"]),
        "--scout-artifact-root",
        str(kwargs["scout_artifact_root"]),
        "--scout-report-checksum",
        kwargs["scout_report_checksum"],
        "--scout-media-checksum",
        kwargs["scout_media_checksum"],
        "--scout-media-bytes",
        str(kwargs["scout_media_bytes"]),
    ]


def test_cli_reports_a_passing_sample(tmp_path: Path) -> None:
    result = runner.invoke(app, _cli_arguments(_pair(tmp_path)))
    assert result.exit_code == 0
    assert "result: pass" in result.stdout
    assert "sha256" not in result.stdout


def test_cli_exits_non_zero_on_a_failing_sample(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path, scout_main={"description": "other"})
    result = runner.invoke(app, _cli_arguments(kwargs))
    assert result.exit_code == 1
    assert "field caption: mismatch" in result.stdout


def test_cli_rejects_unusable_evidence_without_leaking_details(tmp_path: Path) -> None:
    kwargs = _pair(tmp_path)
    kwargs["python_report"].write_text("{ not json", encoding="utf-8")
    result = runner.invoke(app, _cli_arguments(kwargs), catch_exceptions=False)
    assert result.exit_code == 1
    assert str(tmp_path) not in result.output
    assert "Traceback" not in result.output
