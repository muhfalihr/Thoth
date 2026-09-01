from pathlib import Path, PurePosixPath

import pytest
from pydantic import SecretStr, ValidationError

from thoth_control_plane.acquisition.models import (
    AcquisitionAttempt,
    AcquisitionReason,
    AcquisitionStrategy,
    AttemptStatus,
    BrowserSnapshot,
    MaterializedMedia,
    ResolvedMedia,
    TikTokAcquisitionFailure,
    TikTokAcquisitionResult,
    TikTokPost,
    TikTokSourceReport,
)


def resolved_media() -> ResolvedMedia:
    return ResolvedMedia(
        kind="video",
        ephemeral_url=SecretStr("https://cdn.example/video.mp4?sig=secret"),
        media_type="video/mp4",
        duration_seconds=None,
    )


def test_ephemeral_media_url_is_excluded_from_dump_and_repr() -> None:
    media = resolved_media()
    assert "ephemeral_url" not in media.model_dump()
    assert "cdn.example" not in repr(media)


def test_report_serializes_only_relative_materialized_media() -> None:
    report = TikTokSourceReport(
        workflow_id="wf_contract_001",
        source={
            "platform": "tiktok",
            "canonical_url": "https://www.tiktok.com/@creator/video/1234567890",
        },
        post={"post_id": "1234567890", "owner_handle": "creator", "caption": ""},
        media=[
            MaterializedMedia(
                media_id="media_1",
                location=PurePosixPath("reports/wf_contract_001/media/tiktok-1234567890.mp4"),
                bytes=10_000,
                checksum="sha256:" + "a" * 64,
                acquisition_strategy=AcquisitionStrategy.SCRAPLING_HEADLESS,
            )
        ],
        outcome={
            "status": "resolved",
            "attempts": [
                AcquisitionAttempt(
                    strategy=AcquisitionStrategy.SCRAPLING_HEADLESS,
                    status=AttemptStatus.SUCCEEDED,
                    reason=None,
                    attempt_count=1,
                    elapsed_ms=12,
                )
            ],
        },
    )
    serialized = report.model_dump_json()
    assert "https://www.tiktok.com/@creator/video/1234567890" in serialized
    assert "absolute" not in serialized
    assert "signed" not in serialized


def test_result_requires_exactly_one_terminal_outcome() -> None:
    with pytest.raises(ValidationError):
        TikTokAcquisitionResult()
    with pytest.raises(ValidationError):
        TikTokAcquisitionResult(
            report=TikTokSourceReport.model_validate_json(
                (
                    Path(__file__).resolve().parent.parent
                    / "fixtures"
                    / "tiktok"
                    / "normalized_report.json"
                ).read_text(encoding="utf-8")
            ),
            failure={"code": "headless_blocked", "retryable": True},
        )


def test_failure_serializes_safe_ordered_attempts() -> None:
    # Note: strategy/status/reason use enum members rather than the raw string
    # literals shown in the plan brief, because `StrictModel` (unrelated to
    # this task, out of scope to change) sets `strict=True`, which rejects raw
    # strings for enum-typed fields with an `is_instance_of` error. The string
    # *values* below are identical to the brief's literals.
    attempts = [
        AcquisitionAttempt(
            strategy=AcquisitionStrategy.SCRAPLING_HEADLESS,
            status=AttemptStatus.FAILED,
            reason=AcquisitionReason.HEADLESS_BLOCKED,
            attempt_count=1,
            elapsed_ms=10,
        ),
        AcquisitionAttempt(
            strategy=AcquisitionStrategy.TIKWM_CDN,
            status=AttemptStatus.FAILED,
            reason=AcquisitionReason.CDN_UNAVAILABLE,
            attempt_count=1,
            elapsed_ms=20,
        ),
    ]
    failure = TikTokAcquisitionFailure(code="cdn_unavailable", retryable=True, attempts=attempts)

    assert failure.model_dump(mode="json") == {
        "code": "cdn_unavailable",
        "retryable": True,
        "attempts": [attempt.model_dump(mode="json") for attempt in attempts],
    }


def test_failure_rejects_more_than_three_attempts() -> None:
    attempt = AcquisitionAttempt(
        strategy=AcquisitionStrategy.SCRAPLING_HEADLESS,
        status=AttemptStatus.FAILED,
        reason=AcquisitionReason.HEADLESS_TIMEOUT,
        attempt_count=1,
        elapsed_ms=1,
    )
    with pytest.raises(ValidationError):
        TikTokAcquisitionFailure(code="headless_timeout", retryable=True, attempts=[attempt] * 4)


def test_browser_snapshot_contains_sanitized_candidates_only() -> None:
    snapshot = BrowserSnapshot(
        final_url="https://www.tiktok.com/@creator/video/1234567890",
        post_candidates=[
            TikTokPost(post_id="1234567890", owner_handle="creator", caption="caption")
        ],
        media_candidates=[resolved_media()],
    )
    dumped = snapshot.model_dump_json()
    assert "raw_html" not in dumped
    assert "cookie" not in dumped
    assert "cdn.example" not in dumped
