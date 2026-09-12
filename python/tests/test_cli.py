import json

import pytest
import respx
from pydantic import SecretStr
from typer.testing import CliRunner

from thoth_control_plane import cli
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


def test_cli_watch_streams_and_renders_typed_v1_sse_events(
    respx_mock: respx.MockRouter, monkeypatch
) -> None:
    _configure(monkeypatch)
    route = respx_mock.get("http://control-plane.test/api/v1/workflows/wf_001/events").respond(
        200,
        text=(
            "id: 1\n"
            "event: workflow.queued\n"
            'data: {"workflow_id":"wf_001","event_id":"evt_1","sequence":1,'
            '"kind":"workflow.queued","occurred_at":"2026-08-28T08:00:00Z"}\n\n'
        ),
        headers={"content-type": "text/event-stream"},
    )

    result = runner.invoke(app, ["workflow", "watch", "wf_001"])

    assert result.exit_code == 0
    assert route.called
    assert '"workflow_id": "wf_001"' in result.stdout
    assert '"kind": "workflow.queued"' in result.stdout


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


@pytest.mark.parametrize(
    "command",
    ["stage1-controlled-fallback-preflight", "stage1-controlled-fallback-run"],
)
def test_controlled_fallback_help_exits_zero_without_touching_docker(command: str) -> None:
    """`--help` must never require Docker, real digests, or a live gate directory."""
    result = runner.invoke(app, ["operations", command, "--help"])

    assert result.exit_code == 0
    assert "f1" in result.stdout


def test_controlled_fallback_run_rejects_a_non_literal_gate_id(tmp_path) -> None:
    """`--gate-id` must be the literal `f1`; the guard must fire before any Docker call."""
    sample = tmp_path / "not-f1"
    sample.mkdir()

    result = runner.invoke(
        app,
        [
            "operations",
            "stage1-controlled-fallback-run",
            "--gate-id",
            "not-f1",
            "--sample",
            str(sample),
            "--provider",
            str(tmp_path / "provider.env"),
            "--data-root",
            str(tmp_path / "data"),
            "--parity-root",
            str(tmp_path / "parity"),
            "--digest",
            "sha256:" + "a1" * 32,
            "--acquisition-revision",
            "b2" * 20,
            "--harness-revision",
            "c3" * 20,
        ],
    )

    assert result.exit_code != 0
    assert "controlled_fallback_completed" not in result.stdout
    assert "verdict=" not in result.stdout


def test_editor_migrate_uses_the_runtime_python_migrations_directory(monkeypatch, tmp_path) -> None:
    runtime_root = tmp_path / "python"
    expected_root = runtime_root / "migrations" / "editor"
    expected_root.mkdir(parents=True)
    (expected_root / "0001_edit_document_revisions.sql").write_text("SELECT 1;", encoding="utf-8")
    monkeypatch.setattr(
        cli,
        "__file__",
        str(runtime_root / "src" / "thoth_control_plane" / "cli.py"),
    )
    monkeypatch.setattr(
        cli,
        "Settings",
        lambda: type(
            "SettingsStub", (), {"THOTH_EDITOR_DATABASE_URL": SecretStr("postgresql://test")}
        )(),
    )
    called_with: list[object] = []

    def migrate(database_url: str, migrations_root) -> int:
        called_with.extend((database_url, migrations_root))
        return 1

    monkeypatch.setattr(cli, "apply_editor_migrations", migrate)

    result = runner.invoke(app, ["editor", "migrate"])

    assert result.exit_code == 0
    assert called_with == ["postgresql://test", expected_root]
