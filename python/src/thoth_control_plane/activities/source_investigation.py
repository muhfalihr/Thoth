"""Safe Python source-investigation activity boundary."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from hashlib import sha256
from pathlib import Path

from pydantic import BaseModel, ConfigDict
from temporalio import activity

from thoth_control_plane.config import Settings
from thoth_control_plane.domain import (
    ArtifactRef,
    SourceInvestigationActivityResult,
)


class SourceInvestigationActivityInput(BaseModel):
    """Small typed activity input carried in Temporal history."""

    model_config = ConfigDict(extra="forbid", strict=True)

    workflow_id: str
    request_snapshot_id: str


@activity.defn(name="inspect_source_candidates")
async def inspect_source_candidates(
    input_: SourceInvestigationActivityInput,
) -> SourceInvestigationActivityResult:
    """Activity-name reference for workflow definitions and direct local use."""

    return await _inspect_source_candidates(input_, Path.cwd() / ".thoth-artifacts")


def build_source_investigation_activity(
    settings: Settings,
) -> Callable[
    [SourceInvestigationActivityInput],
    Awaitable[SourceInvestigationActivityResult],
]:
    """Bind the production activity to the same configured root used by FastAPI."""

    artifact_root = settings.THOTH_CONTROL_PLANE_ARTIFACT_ROOT.resolve()

    @activity.defn(name="inspect_source_candidates")
    async def configured_source_investigation_activity(
        input_: SourceInvestigationActivityInput,
    ) -> SourceInvestigationActivityResult:
        return await _inspect_source_candidates(input_, artifact_root)

    return configured_source_investigation_activity


async def _inspect_source_candidates(
    input_: SourceInvestigationActivityInput,
    artifact_root: Path,
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
        report_path = artifact_root / report.location
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_bytes(content)
    except OSError:
        return SourceInvestigationActivityResult(
            failure={"code": "source_report_persistence_failed", "retryable": True}
        )
    return SourceInvestigationActivityResult(report=report)
