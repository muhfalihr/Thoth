import json
import math
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.models import (
    LEGACY_FALLBACK_ELIGIBLE_CODES,
    ApprovalDecision,
    ApprovalSignal,
    ArtifactRef,
    SourceInvestigationResult,
    SourceProgressEvent,
    WorkflowEvent,
    WorkflowRequest,
    WorkflowSummary,
)

VALID_REQUEST = {
    "source": {"url": "https://example.test/post", "intent": "identify_original"},
    "style": {"preset_id": "news-vertical"},
    "output": {"format": "vertical_video", "language": "id"},
    "review": {"require_publish_approval": True},
}


def test_request_rejects_executor_knobs_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        WorkflowRequest.model_validate({**VALID_REQUEST, "cap": 40})


def test_request_accepts_only_designed_source_intents() -> None:
    request = WorkflowRequest.model_validate(VALID_REQUEST)
    assert request.source.intent == "identify_original"

    with pytest.raises(ValidationError):
        WorkflowRequest.model_validate(
            {**VALID_REQUEST, "source": {"url": "https://example.test/post", "intent": "download"}}
        )


@pytest.mark.parametrize(
    "location", ["C:\\\\private\\\\video.mp4", "../escape.mp4", "https://cdn.test/x"]
)
def test_artifact_rejects_non_durable_or_unsafe_locations(location: str) -> None:
    with pytest.raises(ValidationError):
        ArtifactRef(
            artifact_id="art_1",
            kind="source_report",
            label="Evidence",
            media_type="application/json",
            location=location,
        )


@pytest.mark.parametrize(
    "location",
    ["reports/source-report.json", "artifacts/2026-08-28/evidence.json"],
)
def test_artifact_accepts_safe_relative_locations(location: str) -> None:
    artifact = ArtifactRef(
        artifact_id="art_1",
        kind="source_report",
        label="Evidence",
        media_type="application/json",
        location=location,
        checksum="sha256:" + "a" * 64,
    )
    assert artifact.location == location


@pytest.mark.parametrize("checksum", ["sha256:not-hex", "md5:" + "a" * 32, "sha256:" + "a" * 63])
def test_artifact_requires_a_sha256_checksum_when_present(checksum: str) -> None:
    with pytest.raises(ValidationError):
        ArtifactRef(
            artifact_id="art_1",
            kind="source_report",
            label="Evidence",
            media_type="application/json",
            location="reports/source-report.json",
            checksum=checksum,
        )


@pytest.mark.parametrize("progress", [-0.01, 1.01, math.inf, math.nan])
def test_event_rejects_invalid_stage_progress(progress: float) -> None:
    with pytest.raises(ValidationError):
        WorkflowEvent(
            workflow_id="wf_1",
            sequence=1,
            event_id="evt_1",
            kind="stage.progress",
            occurred_at=datetime.now(UTC),
            stage={"name": "investigate", "progress": progress},
        )


def test_event_requires_a_positive_sequence_and_known_kind() -> None:
    event = WorkflowEvent(
        workflow_id="wf_1",
        sequence=1,
        event_id="evt_1",
        kind="workflow.started",
        occurred_at=datetime.now(UTC),
    )
    assert event.sequence == 1

    with pytest.raises(ValidationError):
        WorkflowEvent(
            workflow_id="wf_1",
            event_id="evt_2",
            sequence=0,
            kind="workflow.started",
            occurred_at=event.occurred_at,
        )
    with pytest.raises(ValidationError):
        WorkflowEvent(
            workflow_id="wf_1",
            event_id="evt_2",
            sequence=1,
            kind="shell_command",
            occurred_at=event.occurred_at,
        )


def test_public_timestamp_fields_accept_rfc3339_strings() -> None:
    timestamp = "2026-08-28T08:00:00Z"

    event = WorkflowEvent.model_validate(
        {
            "workflow_id": "wf_1",
            "event_id": "evt_1",
            "sequence": 1,
            "kind": "workflow.started",
            "occurred_at": timestamp,
        }
    )
    summary = WorkflowSummary.model_validate(
        {
            "workflow_id": "wf_1",
            "status": "queued",
            "created_at": timestamp,
            "updated_at": timestamp,
            "source": {"display_url": "https://example.test/post", "platform": "tiktok"},
            "stages": [],
        }
    )
    signal = ApprovalSignal.model_validate(
        {
            "approval_id": "apr_1",
            "decision": {"decision": "approve"},
            "actor": {"actor_id": "usr_1", "actor_type": "user"},
            "decided_at": timestamp,
        }
    )

    assert event.occurred_at.isoformat() == "2026-08-28T08:00:00+00:00"
    assert summary.created_at == event.occurred_at
    assert signal.decided_at == event.occurred_at


def test_redacted_dict_scrubs_sensitive_diagnostic_values() -> None:
    decision = ApprovalDecision.model_validate(
        {
            "decision": "approve",
            "note": "looks good",
            "provider_payload": {"authorization": "Bearer private"},
            "metadata": {
                "api_token": "private",
                "signedUrl": "distinctive-signed-url",
                "providerPayload": "distinctive-provider-payload",
                "signed-url": "distinctive-hyphenated-url",
                "public": "keep",
            },
        }
    )
    assert decision.redacted_dict() == {
        "decision": "approve",
        "note": "looks good",
        "provider_payload": "[REDACTED]",
        "metadata": {
            "api_token": "[REDACTED]",
            "signedUrl": "[REDACTED]",
            "providerPayload": "[REDACTED]",
            "signed-url": "[REDACTED]",
            "public": "keep",
        },
    }


def test_source_investigation_fixtures_parse_and_contain_only_safe_metadata() -> None:
    fixture_dir = Path(__file__).parents[1] / "fixtures" / "source_investigation"
    candidates = json.loads((fixture_dir / "candidates.json").read_text(encoding="utf-8"))
    report = json.loads((fixture_dir / "source_report.json").read_text(encoding="utf-8"))

    result = SourceInvestigationResult.model_validate({"candidates": candidates, "report": report})
    assert result.candidates[0].candidate_id == "candidate_001"
    assert result.report.artifact_id == "art_source_report_001"


@pytest.mark.parametrize(
    "payload",
    [
        {"stage": "tiktok_cleanup", "path": "C:/private/report.part"},
        {"stage": "tiktok_cleanup", "diagnostic": "signed_url=https://cdn.test/x"},
        {"stage": "tiktok_cleanup", "fallback_from": "free form reason"},
    ],
)
def test_source_progress_event_rejects_non_allowlisted_payload(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        SourceProgressEvent(kind="stage.failed", payload=payload)


def test_source_progress_event_accepts_cleanup_booleans() -> None:
    event = SourceProgressEvent(
        kind="stage.completed",
        payload={
            "stage": "tiktok_cleanup",
            "status": "succeeded",
            "partial_cleanup_passed": True,
            "browser_cleanup_passed": True,
        },
    )
    assert event.payload["partial_cleanup_passed"] is True


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({}, id="stage_absent"),
        pytest.param({"stage": "https://cdn.test/x?sig=S"}, id="stage_is_a_url"),
        pytest.param({"stage": "C:/private/report.part"}, id="stage_is_a_windows_path"),
        pytest.param({"stage": "Tiktok_Cleanup"}, id="stage_outside_charset"),
    ],
)
def test_source_progress_event_rejects_unsafe_stage(payload: dict[str, object]) -> None:
    """`stage` is one of only two string-typed payload slots, so its charset is the thing
    that makes it impossible to smuggle a URL or a Windows path into Temporal history.

    Every case here violates ONLY the stage clause: each key is inside
    `SOURCE_EVENT_PAYLOAD_KEYS`, and no other closed-set or range clause is touched. A case
    that also tripped the key allowlist would prove nothing about this clause.
    """
    with pytest.raises(ValidationError):
        SourceProgressEvent(kind="stage.failed", payload=payload)


@pytest.mark.parametrize(
    "reason",
    ["https://cdn.test/x?sig=S", "provider said no", "HEADLESS_TIMEOUT"],
)
def test_source_progress_event_rejects_out_of_set_reason(reason: str) -> None:
    """`reason` is the other string-typed slot; only the fixed taxonomy may cross the boundary.

    `stage` is valid and `reason` is the only allowlisted key present, so the reason
    closed-set check is the sole clause under test.
    """
    with pytest.raises(ValidationError):
        SourceProgressEvent(kind="stage.failed", payload={"stage": "tiktok_cdn", "reason": reason})


def test_unsupported_platform_is_not_legacy_fallback_eligible() -> None:
    """`unsupported_platform` is a pre-provider rejection, not a Python failure.

    A code rejected before any provider or legacy attempt cannot also be
    fallback-eligible: the resulting observation would need both
    `route="legacy_fallback"` and `attempts=[]`, which the soak contract
    rejects. Routing a non-TikTok platform straight to legacy in an explicit
    migration mode is a separate routing seam, decided by the mode and the
    platform, never by this failure code.
    """
    assert "unsupported_platform" not in LEGACY_FALLBACK_ELIGIBLE_CODES
    assert "invalid_tiktok_url" not in LEGACY_FALLBACK_ELIGIBLE_CODES


def test_source_progress_event_rejects_unsupported_platform_as_fallback_from() -> None:
    """A fallback transition can only cite a code that can actually cause one.

    This case violates the `fallback_from` closed set and nothing else -- the
    stage is valid and the key is allowlisted -- so the rejection can only come
    from the clause under test.
    """
    with pytest.raises(ValidationError):
        SourceProgressEvent(
            kind="stage.failed",
            payload={"stage": "tiktok_cleanup", "fallback_from": "unsupported_platform"},
        )
