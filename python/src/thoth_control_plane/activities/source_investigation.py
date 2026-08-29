"""Safe Python source-investigation activity boundary."""

from __future__ import annotations

from hashlib import sha256

from pydantic import BaseModel, ConfigDict
from temporalio import activity

from thoth_control_plane.domain import ArtifactRef, SourceInvestigationResult, WorkflowRequest


class SourceInvestigationActivityInput(BaseModel):
    """Small typed activity input carried in Temporal history."""

    model_config = ConfigDict(extra="forbid", strict=True)

    request: WorkflowRequest
    workflow_id: str


@activity.defn(name="inspect_source_candidates")
async def inspect_source_candidates(
    input_: SourceInvestigationActivityInput,
) -> SourceInvestigationResult:
    """Create a safe source-report reference using the Python activity boundary.

    Provider-specific discovery is deliberately outside this first durable slice.
    The activity returns only the versioned safe result contract; Task 6 can select
    the temporary worker-only legacy implementation without changing the workflow.
    """

    report_fingerprint = sha256(
        f"{input_.workflow_id}:{input_.request.source.url}".encode()
    ).hexdigest()
    report = ArtifactRef(
        artifact_id=f"art_source_{report_fingerprint[:20]}",
        kind="source_report",
        label="Source investigation report",
        media_type="application/json",
        location=f"reports/{input_.workflow_id}/source-report.json",
        checksum=f"sha256:{report_fingerprint}",
    )
    return SourceInvestigationResult(candidates=[], report=report)
