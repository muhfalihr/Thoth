"""Safe Python source-investigation activity boundary."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path

from pydantic import BaseModel, ConfigDict
from temporalio import activity

from thoth_control_plane.domain import (
    ArtifactRef,
    SourceInvestigationActivityResult,
)

ARTIFACT_ROOT = Path.cwd() / ".thoth-artifacts"


class SourceInvestigationActivityInput(BaseModel):
    """Small typed activity input carried in Temporal history."""

    model_config = ConfigDict(extra="forbid", strict=True)

    workflow_id: str
    request_snapshot_id: str


@activity.defn(name="inspect_source_candidates")
async def inspect_source_candidates(
    input_: SourceInvestigationActivityInput,
) -> SourceInvestigationActivityResult:
    """Create a safe source-report reference using the Python activity boundary.

    Provider-specific discovery is deliberately outside this first durable slice.
    The activity returns only the versioned safe result contract; Task 6 can select
    the temporary worker-only legacy implementation without changing the workflow.
    """

    content = json.dumps(
        {
            "request_snapshot_id": input_.request_snapshot_id,
            "schema_version": 1,
            "workflow_id": input_.workflow_id,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    report_fingerprint = sha256(content).hexdigest()
    report = ArtifactRef(
        artifact_id=f"art_source_{report_fingerprint[:20]}",
        kind="source_report",
        label="Source investigation report",
        media_type="application/json",
        location=f"reports/{input_.workflow_id}/source-report.json",
        checksum=f"sha256:{report_fingerprint}",
    )
    try:
        report_path = ARTIFACT_ROOT / report.location
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_bytes(content)
    except OSError:
        return SourceInvestigationActivityResult(
            failure={"code": "source_report_persistence_failed", "retryable": True}
        )
    return SourceInvestigationActivityResult(report=report)
