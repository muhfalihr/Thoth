import asyncio
from itertools import pairwise
from pathlib import Path

import httpx
import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from thoth_control_plane.acquisition.models import TikTokAcquisitionResult, TikTokSourceReport
from thoth_control_plane.activities import build_source_investigation_activity
from thoth_control_plane.api import create_app
from thoth_control_plane.config import Settings
from thoth_control_plane.infrastructure.temporal_gateway import TASK_QUEUE, TemporalWorkflowGateway
from thoth_control_plane.workflows import SourceInvestigationWorkflow

_FIXTURE_REPORT_PATH = Path("tests/fixtures/tiktok/normalized_report.json")


def _offline_successful_runner():
    """Deterministic, offline `AcquisitionRunner` double for this smoke test.

    Task 6 replaced the generic source-report stub with real TikTok
    acquisition, so exercising the production activity builder here (without
    stubbing Temporal/the API away, unlike `control_plane`'s fixture activity
    above) now needs an injected runner to stay offline and deterministic.
    """

    async def run(workflow_id: str, source_url: str, artifact_root: Path):
        del source_url
        media_path = artifact_root / f"reports/{workflow_id}/media/tiktok-1234567890.mp4"
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 10_100)
        report = TikTokSourceReport.model_validate_json(
            _FIXTURE_REPORT_PATH.read_text(encoding="utf-8")
        ).model_copy(update={"workflow_id": workflow_id})
        return TikTokAcquisitionResult(report=report)

    return run


VALID_PRODUCE_REQUEST = {
    "source": {
        "url": "https://example.com/source/ready",
        "intent": "produce_video",
    },
    "style": {"preset_id": "news-vertical"},
    "output": {"format": "vertical_video", "language": "id"},
    "review": {"require_publish_approval": True},
}


@pytest.mark.asyncio
async def test_source_workflow_survives_restart_and_never_uses_a_cli_route(
    control_plane,
) -> None:
    created = await control_plane.create(
        VALID_PRODUCE_REQUEST,
        idempotency_key="smoke-approval-001",
    )
    awaiting = await control_plane.wait_for_status(created["workflow_id"], "awaiting_approval")

    initial_events = await control_plane.events(created["workflow_id"])
    assert initial_events[0]["event"] == "workflow.snapshot"
    assert initial_events[-1]["event"] == "approval.required"
    durable_sequences = [event["sequence"] for event in initial_events[1:]]
    assert len(durable_sequences) == len(set(durable_sequences))
    assert all(previous < current for previous, current in pairwise(durable_sequences))

    await control_plane.restart_api_and_worker()
    await control_plane.approve(
        created["workflow_id"],
        approval_id=awaiting["approval"]["approval_id"],
        decision="approve",
    )
    finished = await control_plane.wait_for_terminal(created["workflow_id"])
    assert finished["status"] == "succeeded"

    artifact = finished["artifacts"][0]
    assert await control_plane.fetch_artifact(created["workflow_id"], artifact["artifact_id"]) == {
        "request_snapshot_id": control_plane.request_snapshot_id(created["workflow_id"])
    }
    assert (
        await control_plane.artifact_status(
            created["workflow_id"], artifact["artifact_id"], api_key="not-the-owner-key"
        )
        == 403
    )

    failed = await control_plane.create(
        {
            **VALID_PRODUCE_REQUEST,
            "source": {
                "url": "https://example.com/source/retryable-failure",
                "intent": "identify_original",
            },
        },
        idempotency_key="smoke-retry-001",
    )
    failed_summary = await control_plane.wait_for_terminal(failed["workflow_id"])
    assert failed_summary["status"] == "failed"
    assert failed_summary["failure"]["retryable"] is True
    assert await control_plane.retry_status(failed["workflow_id"], from_stage="source") == 503

    cancelled = await control_plane.create(
        {
            **VALID_PRODUCE_REQUEST,
            "source": {
                "url": "https://example.com/source/block-until-cancelled",
                "intent": "identify_original",
            },
        },
        idempotency_key="smoke-cancel-001",
    )
    await control_plane.wait_for_status(cancelled["workflow_id"], "running")
    await control_plane.cancel(cancelled["workflow_id"])
    cancelled_summary = await control_plane.wait_for_terminal(cancelled["workflow_id"])
    assert cancelled_summary["status"] == "cancelled"

    assert all(path.startswith("/api/v1/workflows") for path in control_plane.recorded_http_paths)
    assert all("/api/scout/" not in path for path in control_plane.recorded_http_paths)


@pytest.mark.asyncio
async def test_production_activity_and_api_share_a_custom_artifact_root(tmp_path) -> None:
    settings = Settings(
        THOTH_CONTROL_PLANE_API_KEY="custom-root-key",
        THOTH_CONTROL_PLANE_ARTIFACT_ROOT=tmp_path,
        THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE="python",
    )
    environment = await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    )
    try:
        configured_activity = build_source_investigation_activity(
            settings, runner=_offline_successful_runner()
        )
        async with Worker(
            environment.client,
            task_queue=TASK_QUEUE,
            workflows=[SourceInvestigationWorkflow],
            activities=[configured_activity],
            max_cached_workflows=0,
        ):
            app = create_app(settings, TemporalWorkflowGateway(environment.client))
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://offline-control-plane"
            ) as client:
                headers = {
                    "Authorization": "Bearer custom-root-key",
                    "Idempotency-Key": "custom-root-001",
                }
                response = await client.post(
                    "/api/v1/workflows",
                    headers=headers,
                    json={
                        **VALID_PRODUCE_REQUEST,
                        "source": {
                            "url": "https://example.com/source/custom-root",
                            "intent": "identify_original",
                        },
                    },
                )
                workflow_id = response.json()["workflow_id"]
                summary = response.json()
                for _ in range(300):
                    summary_response = await client.get(
                        f"/api/v1/workflows/{workflow_id}", headers=headers
                    )
                    summary = summary_response.json()
                    if summary["status"] == "succeeded":
                        break
                    await asyncio.sleep(0.01)
                assert summary["status"] == "succeeded"

                artifact = summary["artifacts"][0]
                download = await client.get(
                    f"/api/v1/workflows/{workflow_id}/artifacts/{artifact['artifact_id']}",
                    headers=headers,
                )

        assert download.status_code == 200
        assert download.json()["workflow_id"] == workflow_id
        assert (tmp_path / "reports" / workflow_id / "source-report.json").is_file()
    finally:
        await environment.shutdown()
