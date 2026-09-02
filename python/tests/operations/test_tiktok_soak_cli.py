"""Tests for the strict TikTok Stage 1 soak JSONL loader, the atomic report
writer, and the `operations tiktok-stage1-soak` CLI command."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tests.operations.test_tiktok_soak import GENERATED_AT, duplicate_observation_id, route_mix
from thoth_control_plane import cli as cli_module
from thoth_control_plane.cli import app
from thoth_control_plane.operations.tiktok_soak import TikTokSoakReport, evaluate_tiktok_soak
from thoth_control_plane.operations.tiktok_soak_cli import (
    REPORT_NAME,
    TikTokSoakInputError,
    load_tiktok_soak_observations,
    write_tiktok_soak_report,
)

runner = CliRunner()

READY_OBSERVATIONS = route_mix(native=95, fallback=3, failed=2)
READY_REPORT = evaluate_tiktok_soak(READY_OBSERVATIONS, generated_at=GENERATED_AT)
READY_JSONL = "\n".join(json.dumps(item.model_dump(mode="json")) for item in READY_OBSERVATIONS)


def _observation_payload(index: int = 0) -> dict[str, object]:
    return json.loads(READY_OBSERVATIONS[index].model_dump_json())


# --- load_tiktok_soak_observations: strict, fail-closed parsing ------------


def test_loader_accepts_one_strict_observation_per_nonempty_line(tmp_path: Path) -> None:
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text(READY_JSONL, encoding="utf-8")
    assert load_tiktok_soak_observations(input_path) == READY_OBSERVATIONS


@pytest.mark.parametrize("content", ["not-json\n", '{"schema_version":2}\n', "\n"])
def test_loader_fails_closed_without_echoing_input(tmp_path: Path, content: str) -> None:
    input_path = tmp_path / "secret-observations.jsonl"
    input_path.write_text(content, encoding="utf-8")
    with pytest.raises(TikTokSoakInputError) as captured:
        load_tiktok_soak_observations(input_path)
    assert str(captured.value) == "invalid tiktok soak observation input"
    assert "secret" not in str(captured.value)


def test_loader_rejects_a_completely_empty_file(tmp_path: Path) -> None:
    """Isolates the empty-file guard: without it, zero lines would silently
    become an empty list instead of a failure."""
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text("", encoding="utf-8")
    with pytest.raises(TikTokSoakInputError) as captured:
        load_tiktok_soak_observations(input_path)
    assert str(captured.value) == "invalid tiktok soak observation input"


def test_loader_rejects_a_well_formed_but_non_object_line(tmp_path: Path) -> None:
    """A syntactically valid JSON array, not an object: isolates rejection of
    a non-object line from a JSON syntax error."""
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text(json.dumps([1, 2, 3]) + "\n", encoding="utf-8")
    with pytest.raises(TikTokSoakInputError):
        load_tiktok_soak_observations(input_path)


def test_loader_rejects_an_unknown_field(tmp_path: Path) -> None:
    payload = _observation_payload()
    payload["unexpected_field"] = "not-part-of-the-contract"
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    with pytest.raises(TikTokSoakInputError):
        load_tiktok_soak_observations(input_path)


def test_loader_rejects_an_unknown_enum_value(tmp_path: Path) -> None:
    payload = _observation_payload()
    payload["route"] = "not_a_real_route"
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    with pytest.raises(TikTokSoakInputError):
        load_tiktok_soak_observations(input_path)


def test_loader_rejects_a_non_utc_timestamp(tmp_path: Path) -> None:
    payload = _observation_payload()
    payload["occurred_at"] = "2026-09-02T19:00:00+07:00"
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    with pytest.raises(TikTokSoakInputError):
        load_tiktok_soak_observations(input_path)


def test_loader_fails_closed_when_any_single_line_is_invalid(tmp_path: Path) -> None:
    """One bad line among otherwise-valid lines still aborts the whole load
    rather than skipping it or returning a partial list."""
    lines = [
        json.dumps(READY_OBSERVATIONS[0].model_dump(mode="json")),
        "not-json",
        json.dumps(READY_OBSERVATIONS[1].model_dump(mode="json")),
    ]
    input_path = tmp_path / "observations.jsonl"
    input_path.write_text("\n".join(lines), encoding="utf-8")
    with pytest.raises(TikTokSoakInputError):
        load_tiktok_soak_observations(input_path)


# --- write_tiktok_soak_report: atomic, cleaned up on failure/cancellation --


def test_writer_atomically_replaces_report_and_leaves_no_part(tmp_path: Path) -> None:
    destination = write_tiktok_soak_report(READY_REPORT, tmp_path)
    assert destination == tmp_path / "tiktok-stage1-soak-report.json"
    assert TikTokSoakReport.model_validate_json(destination.read_text()) == READY_REPORT
    assert not destination.with_suffix(".json.part").exists()


def test_writer_creates_missing_output_directory(tmp_path: Path) -> None:
    output_directory = tmp_path / "nested" / "dir"
    destination = write_tiktok_soak_report(READY_REPORT, output_directory)
    assert destination == output_directory / REPORT_NAME
    assert destination.exists()


def test_writer_creates_part_before_final_name_appears(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Atomicity, not just eventual content: the `.part` file must already
    exist and the final name must NOT exist at the instant `os.replace`
    runs."""
    observed: dict[str, bool] = {}
    real_replace = os.replace

    def spy_replace(source: Path, destination: Path) -> None:
        observed["part_existed"] = Path(source).exists()
        observed["final_existed"] = Path(destination).exists()
        real_replace(source, destination)

    monkeypatch.setattr(os, "replace", spy_replace)
    destination = write_tiktok_soak_report(READY_REPORT, tmp_path)
    assert observed == {"part_existed": True, "final_existed": False}
    assert destination.exists()
    assert not destination.with_suffix(".json.part").exists()


def test_writer_flushes_before_fsync(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The bytes must already be on disk (via `handle.flush()`) by the time
    `os.fsync` runs, not merely by the time the `with` block later closes
    the handle."""
    partial = tmp_path / f"{REPORT_NAME}.part"
    observed: dict[str, bytes] = {}
    real_fsync = os.fsync

    def spy_fsync(fd: int) -> None:
        observed["on_disk_at_fsync"] = partial.read_bytes()
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", spy_fsync)
    write_tiktok_soak_report(READY_REPORT, tmp_path)
    assert observed["on_disk_at_fsync"] == READY_REPORT.model_dump_json(indent=2).encode("utf-8")


@pytest.mark.parametrize("raised", [OSError("replace failed"), KeyboardInterrupt()])
def test_writer_removes_part_on_failure_or_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raised: BaseException
) -> None:
    def fail_replace(source: Path, destination: Path) -> None:
        del source, destination
        raise raised

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(type(raised)):
        write_tiktok_soak_report(READY_REPORT, tmp_path)
    assert list(tmp_path.glob("*.part")) == []
    assert not (tmp_path / REPORT_NAME).exists()


def test_writer_removes_part_when_cancelled_mid_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation before `os.replace` is ever reached (mid-write, not just
    mid-replace) must still leave no `.part` behind."""

    def cancel_fsync(fd: int) -> None:
        del fd
        raise KeyboardInterrupt

    monkeypatch.setattr(os, "fsync", cancel_fsync)
    with pytest.raises(KeyboardInterrupt):
        write_tiktok_soak_report(READY_REPORT, tmp_path)
    assert list(tmp_path.glob("*.part")) == []
    assert not (tmp_path / REPORT_NAME).exists()


# --- CLI: `thoth-control operations tiktok-stage1-soak` ---------------------


def test_cli_writes_ready_aggregate_report(tmp_path: Path) -> None:
    observations = tmp_path / "observations.jsonl"
    observations.write_text(READY_JSONL, encoding="utf-8")
    result = runner.invoke(
        app,
        [
            "operations",
            "tiktok-stage1-soak",
            "--observations",
            str(observations),
            "--output-directory",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 0
    payload = json.loads((tmp_path / REPORT_NAME).read_text())
    assert payload["ready"] is True
    assert "workflow_id" not in json.dumps(payload)


def test_cli_maps_loader_failure_to_exit_code_one_without_report(tmp_path: Path) -> None:
    observations = tmp_path / "observations.jsonl"
    observations.write_text("not-json\n", encoding="utf-8")
    result = runner.invoke(
        app,
        [
            "operations",
            "tiktok-stage1-soak",
            "--observations",
            str(observations),
            "--output-directory",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 1
    assert result.output.strip() == "tiktok stage 1 soak evaluation failed"
    assert not (tmp_path / REPORT_NAME).exists()
    assert list(tmp_path.glob("*.part")) == []


def test_cli_maps_write_failure_to_exit_code_one_without_leaking_a_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The writer's `OSError` can carry an absolute filesystem path in its
    `str()`; the CLI must still emit only the fixed safe string, never that
    path."""
    observations = tmp_path / "observations.jsonl"
    observations.write_text(READY_JSONL, encoding="utf-8")

    def fail_write(report: TikTokSoakReport, output_directory: Path) -> Path:
        del report, output_directory
        raise OSError(r"C:\secret\absolute\path\tiktok-stage1-soak-report.json")

    monkeypatch.setattr(cli_module, "write_tiktok_soak_report", fail_write)
    result = runner.invoke(
        app,
        [
            "operations",
            "tiktok-stage1-soak",
            "--observations",
            str(observations),
            "--output-directory",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 1
    assert result.output.strip() == "tiktok stage 1 soak evaluation failed"
    assert "secret" not in result.output
    assert not (tmp_path / REPORT_NAME).exists()


def test_cli_maps_dataset_failure_to_exit_code_one_without_report(tmp_path: Path) -> None:
    """Duplicate observation ids across two individually valid lines pass the
    loader and are rejected only by the evaluator's dataset check — isolates
    the `TikTokSoakDatasetError` mapping from the loader's own error path."""
    dataset = duplicate_observation_id(READY_OBSERVATIONS)
    content = "\n".join(json.dumps(item.model_dump(mode="json")) for item in dataset)
    observations = tmp_path / "observations.jsonl"
    observations.write_text(content, encoding="utf-8")
    result = runner.invoke(
        app,
        [
            "operations",
            "tiktok-stage1-soak",
            "--observations",
            str(observations),
            "--output-directory",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 1
    assert result.output.strip() == "tiktok stage 1 soak evaluation failed"
    assert not (tmp_path / REPORT_NAME).exists()
    assert list(tmp_path.glob("*.part")) == []
