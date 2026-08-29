import json

import pytest
import respx
from typer.testing import CliRunner

from thoth_control_plane.cli import app

runner = CliRunner()

QUEUED_SUMMARY = {
    "workflow_id": "wf_001",
    "status": "queued",
    "created_at": "2026-08-28T08:00:00Z",
    "updated_at": "2026-08-28T08:00:00Z",
    "source": {"display_url": "https://example.test/post/1", "platform": "example"},
    "stages": [],
    "artifacts": [],
    "approval": None,
    "failure": None,
}


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("THOTH_CONTROL_PLANE_URL", "http://control-plane.test")
    monkeypatch.setenv("THOTH_CONTROL_PLANE_API_KEY", "test-key")


def test_cli_posts_the_same_v1_request(respx_mock: respx.MockRouter, monkeypatch) -> None:
    _configure(monkeypatch)
    route = respx_mock.post("http://control-plane.test/api/v1/workflows").respond(
        202, json=QUEUED_SUMMARY
    )

    result = runner.invoke(
        app,
        ["workflow", "start", "--url", "https://example.test/post/1", "--style", "news-vertical"],
    )

    assert result.exit_code == 0
    assert route.called
    request = route.calls[0].request
    assert request.headers["Authorization"] == "Bearer test-key"
    assert request.headers["Idempotency-Key"]
    assert json.loads(request.content) == {
        "source": {"url": "https://example.test/post/1", "intent": "produce_video"},
        "style": {"preset_id": "news-vertical"},
        "output": {"format": "mp4", "language": "id"},
        "review": {"require_publish_approval": True},
    }


def test_cli_watch_reads_and_renders_the_authoritative_v1_summary(
    respx_mock: respx.MockRouter, monkeypatch
) -> None:
    _configure(monkeypatch)
    route = respx_mock.get("http://control-plane.test/api/v1/workflows/wf_001").respond(
        200, json=QUEUED_SUMMARY
    )

    result = runner.invoke(app, ["workflow", "watch", "wf_001"])

    assert result.exit_code == 0
    assert route.called
    assert '"workflow_id": "wf_001"' in result.stdout
    assert '"status": "queued"' in result.stdout


@pytest.mark.parametrize(
    ("arguments", "path", "expected_json"),
    [
        (
            [
                "approve",
                "wf_001",
                "--approval-id",
                "approval_001",
                "--decision",
                "approve",
                "--note",
                "Looks good",
            ],
            "/api/v1/workflows/wf_001/approve",
            {"approval_id": "approval_001", "decision": "approve", "note": "Looks good"},
        ),
        (["cancel", "wf_001"], "/api/v1/workflows/wf_001/cancel", None),
        (
            ["retry", "wf_001", "--from-stage", "source"],
            "/api/v1/workflows/wf_001/retry",
            {"from_stage": "source"},
        ),
    ],
)
def test_cli_mutations_use_the_v1_http_api(
    arguments: list[str],
    path: str,
    expected_json: dict[str, str] | None,
    respx_mock: respx.MockRouter,
    monkeypatch,
) -> None:
    _configure(monkeypatch)
    route = respx_mock.post(f"http://control-plane.test{path}").respond(200, json=QUEUED_SUMMARY)

    result = runner.invoke(app, ["workflow", *arguments])

    assert result.exit_code == 0
    assert route.called
    request = route.calls[0].request
    assert request.headers["Authorization"] == "Bearer test-key"
    assert (
        json.loads(request.content) == expected_json
        if expected_json is not None
        else not request.content
    )
