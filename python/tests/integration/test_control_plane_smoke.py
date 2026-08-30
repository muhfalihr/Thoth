import pytest

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
    assert [event["sequence"] for event in initial_events] == sorted(
        event["sequence"] for event in initial_events
    )

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
