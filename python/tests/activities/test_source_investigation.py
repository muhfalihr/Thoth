"""Tests for the Python TikTok source-investigation activity boundary."""

import asyncio
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from thoth_control_plane.acquisition.models import (
    AcquisitionAttempt,
    AcquisitionOutcome,
    AcquisitionReason,
    AcquisitionStrategy,
    AttemptStatus,
    TikTokAcquisitionFailure,
    TikTokAcquisitionResult,
    TikTokSourceReport,
)
from thoth_control_plane.activities.source_investigation import (
    SourceInvestigationActivityInput,
    build_source_investigation_activity,
)
from thoth_control_plane.config import Settings

FIXTURE_PATH = Path("tests/fixtures/tiktok/normalized_report.json")

INPUT = SourceInvestigationActivityInput(
    workflow_id="wf_activity_001",
    request_snapshot_id="req_activity_001",
    canonical_source_url="https://www.tiktok.com/@creator/video/1234567890",
)


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        THOTH_CONTROL_PLANE_API_KEY="test-key",
        THOTH_CONTROL_PLANE_ARTIFACT_ROOT=tmp_path,
    )


def _load_fixture_report() -> TikTokSourceReport:
    return TikTokSourceReport.model_validate_json(FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def successful_runner():
    async def run(workflow_id: str, source_url: str, artifact_root: Path):
        del source_url
        media_path = artifact_root / f"reports/{workflow_id}/media/tiktok-1234567890.mp4"
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 10_100)
        return TikTokAcquisitionResult(report=_load_fixture_report())

    return run


@pytest.fixture
def cancelling_runner():
    class Runner:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.closed = False

        async def __call__(self, workflow_id: str, source_url: str, artifact_root: Path):
            del workflow_id, source_url, artifact_root
            self.started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.closed = True

    return Runner()


@pytest.mark.asyncio
async def test_activity_persists_strict_report_and_returns_existing_artifact_shape(
    tmp_path: Path, successful_runner
) -> None:
    configured = build_source_investigation_activity(_settings(tmp_path), runner=successful_runner)
    result = await configured(INPUT)
    report_path = tmp_path / "reports/wf_activity_001/source-report.json"
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    assert result.failure is None
    assert result.report is not None
    assert result.report.location == "reports/wf_activity_001/source-report.json"
    assert result.report.checksum.startswith("sha256:")
    assert payload["source"]["platform"] == "tiktok"
    assert "signed" not in report_path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_missing_acquisition_dependency_returns_safe_failure_without_runner(
    tmp_path: Path,
) -> None:
    called = False

    async def runner(*args, **kwargs):
        nonlocal called
        called = True

    configured = build_source_investigation_activity(
        _settings(tmp_path),
        runner=runner,
        capability={"available": False, "code": "acquisition_dependency_unavailable"},
    )
    result = await configured(INPUT)
    assert result.failure is not None
    assert result.failure.code == "acquisition_dependency_unavailable"
    assert called is False


@pytest.mark.asyncio
async def test_activity_cancellation_propagates_and_leaves_no_partial_artifact(
    tmp_path: Path, cancelling_runner
) -> None:
    configured = build_source_investigation_activity(_settings(tmp_path), runner=cancelling_runner)
    task = asyncio.create_task(configured(INPUT))
    await cancelling_runner.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert list(tmp_path.rglob("*.part")) == []
    assert cancelling_runner.closed is True


@pytest.mark.asyncio
async def test_activity_leaves_no_part_file_after_success(
    tmp_path: Path, successful_runner
) -> None:
    configured = build_source_investigation_activity(_settings(tmp_path), runner=successful_runner)
    result = await configured(INPUT)
    assert result.failure is None
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.parametrize(
    ("code", "retryable"),
    [
        ("unsupported_platform", False),
        ("invalid_tiktok_url", False),
        ("headless_timeout", True),
        ("cdn_rate_limited", True),
    ],
)
@pytest.mark.asyncio
async def test_acquisition_failures_map_to_safe_activity_failure(
    tmp_path: Path, code: str, retryable: bool
) -> None:
    async def failing_runner(workflow_id: str, source_url: str, artifact_root: Path):
        del workflow_id, source_url, artifact_root
        return TikTokAcquisitionResult(
            failure=TikTokAcquisitionFailure(code=code, retryable=retryable)
        )

    configured = build_source_investigation_activity(_settings(tmp_path), runner=failing_runner)
    result = await configured(INPUT)
    assert result.report is None
    assert result.failure is not None
    assert result.failure.code == code
    assert result.failure.retryable == retryable
    assert not (tmp_path / "reports").exists()


@pytest.mark.asyncio
async def test_report_persistence_failure_removes_part_file_and_materialized_media(
    tmp_path: Path, successful_runner, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The fixture report records its media under its own internal workflow_id
    # ("wf_contract_001"), deliberately different from the activity input's
    # workflow_id ("wf_activity_001"): Ruling F-4a requires cleanup to trust
    # the report's own recorded media location, not the input workflow_id.
    report = _load_fixture_report()
    media_path = tmp_path / str(report.media[0].location)
    media_path.parent.mkdir(parents=True, exist_ok=True)
    media_path.write_bytes(b"0" * 10_100)

    async def runner(workflow_id: str, source_url: str, artifact_root: Path):
        del workflow_id, source_url, artifact_root
        return TikTokAcquisitionResult(report=report)

    import os

    from thoth_control_plane.activities import source_investigation as module

    def raising_replace(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(module.os, "replace", raising_replace)
    del os

    configured = build_source_investigation_activity(_settings(tmp_path), runner=runner)
    result = await configured(INPUT)

    assert result.failure is not None
    assert result.failure.code == "artifact_persistence_failed"
    assert result.failure.retryable is True
    assert not media_path.exists()
    assert list(tmp_path.rglob("*.part")) == []
    assert not (tmp_path / "reports/wf_activity_001/source-report.json").exists()


@pytest.mark.asyncio
async def test_attempts_convert_to_safe_progress_events_with_fixed_stage_names(
    tmp_path: Path,
) -> None:
    report = _load_fixture_report()
    report = report.model_copy(
        update={
            "outcome": AcquisitionOutcome(
                attempts=[
                    AcquisitionAttempt(
                        strategy=AcquisitionStrategy.SCRAPLING_HEADLESS,
                        status=AttemptStatus.FAILED,
                        reason=AcquisitionReason.HEADLESS_TIMEOUT,
                        attempt_count=1,
                        elapsed_ms=42,
                    ),
                    AcquisitionAttempt(
                        strategy=AcquisitionStrategy.TIKWM_CDN,
                        status=AttemptStatus.SUCCEEDED,
                        reason=None,
                        attempt_count=1,
                        elapsed_ms=7,
                    ),
                ]
            )
        }
    )

    async def runner(workflow_id: str, source_url: str, artifact_root: Path):
        del source_url
        media_path = artifact_root / f"reports/{workflow_id}/media/tiktok-1234567890.mp4"
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"0" * 10_100)
        return TikTokAcquisitionResult(report=report)

    configured = build_source_investigation_activity(_settings(tmp_path), runner=runner)
    result = await configured(INPUT)

    assert result.failure is None
    kinds = [event.kind for event in result.events]
    assert kinds == [
        "stage.started",
        "stage.failed",
        "stage.started",
        "stage.completed",
    ]
    stages = [event.payload["stage"] for event in result.events]
    assert stages == ["tiktok_headless", "tiktok_headless", "tiktok_cdn", "tiktok_cdn"]
    assert result.events[1].payload["reason"] == "headless_timeout"
    for event in result.events:
        assert "http" not in json.dumps(event.payload)
        assert "cookie" not in json.dumps(event.payload).lower()


def test_activity_input_rejects_extra_legacy_cli_flags() -> None:
    with pytest.raises(ValidationError):
        SourceInvestigationActivityInput.model_validate(
            {
                "workflow_id": "wf_activity_001",
                "request_snapshot_id": "req_activity_001",
                "canonical_source_url": "https://www.tiktok.com/@creator/video/1234567890",
                "output_package_id": "pkg_activity_001",
                "timeout": 300,
                "cancellation_token": "can_activity_001",
            }
        )
