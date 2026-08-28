import json
import math
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.models import (
    ApprovalDecision,
    ArtifactRef,
    SourceInvestigationResult,
    WorkflowEvent,
    WorkflowRequest,
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


def test_redacted_dict_scrubs_sensitive_diagnostic_values() -> None:
    decision = ApprovalDecision.model_validate(
        {
            "decision": "approve",
            "note": "looks good",
            "provider_payload": {"authorization": "Bearer private"},
            "metadata": {"api_token": "private", "public": "keep"},
        }
    )
    assert decision.redacted_dict() == {
        "decision": "approve",
        "note": "looks good",
        "provider_payload": "[REDACTED]",
        "metadata": {"api_token": "[REDACTED]", "public": "keep"},
    }


def test_source_investigation_fixtures_parse_and_contain_only_safe_metadata() -> None:
    fixture_dir = Path(__file__).parents[1] / "fixtures" / "source_investigation"
    candidates = json.loads((fixture_dir / "candidates.json").read_text(encoding="utf-8"))
    report = json.loads((fixture_dir / "source_report.json").read_text(encoding="utf-8"))

    result = SourceInvestigationResult.model_validate({"candidates": candidates, "report": report})
    assert result.candidates[0].candidate_id == "candidate_001"
    assert result.report.artifact_id == "art_source_report_001"
