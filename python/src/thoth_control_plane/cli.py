"""A thin command-line client for the public control-plane HTTP API."""

from __future__ import annotations

import json
import os
import uuid
from typing import Annotated, Any

import httpx
import typer

from thoth_control_plane.application import ApprovalSubmission, RetryRequest
from thoth_control_plane.domain import WorkflowRequest

app = typer.Typer(no_args_is_help=True)
workflow_app = typer.Typer(no_args_is_help=True)
app.add_typer(workflow_app, name="workflow")


def _settings() -> tuple[str, str]:
    base_url = os.environ.get("THOTH_CONTROL_PLANE_URL", "http://localhost:8000").rstrip("/")
    api_key = os.environ.get("THOTH_CONTROL_PLANE_API_KEY", "")
    if not api_key:
        raise typer.BadParameter("THOTH_CONTROL_PLANE_API_KEY must be set")
    return base_url, api_key


def _request(method: str, path: str, *, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    base_url, api_key = _settings()
    headers = {"Authorization": f"Bearer {api_key}"}
    if method == "POST" and path == "/api/v1/workflows":
        headers["Idempotency-Key"] = str(uuid.uuid4())
    response = httpx.request(method, f"{base_url}{path}", headers=headers, json=payload, timeout=30)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        detail = error.response.text or str(error)
        raise typer.Exit(code=1) from typer.BadParameter(detail)
    return response.json()


def _render(summary: dict[str, Any]) -> None:
    typer.echo(json.dumps(summary, indent=2, sort_keys=True, default=str))


@workflow_app.command("start")
def start(
    url: Annotated[str, typer.Option("--url")],
    style: Annotated[str, typer.Option("--style")],
    format_: Annotated[str, typer.Option("--format")] = "mp4",
    language: Annotated[str, typer.Option("--language")] = "id",
    require_publish_approval: Annotated[bool, typer.Option("--review/--no-review")] = True,
) -> None:
    """Start one video workflow through the v1 API."""
    request = WorkflowRequest.model_validate(
        {
            "source": {"url": url, "intent": "produce_video"},
            "style": {"preset_id": style},
            "output": {"format": format_, "language": language},
            "review": {"require_publish_approval": require_publish_approval},
        }
    )
    _render(_request("POST", "/api/v1/workflows", payload=request.model_dump(mode="json")))


@workflow_app.command("watch")
def watch(workflow_id: str) -> None:
    """Read the latest authoritative workflow snapshot."""
    _render(_request("GET", f"/api/v1/workflows/{workflow_id}"))


@workflow_app.command("approve")
def approve(
    workflow_id: str,
    approval_id: Annotated[str, typer.Option("--approval-id")],
    decision: Annotated[str, typer.Option("--decision")] = "approve",
    note: Annotated[str | None, typer.Option("--note")] = None,
) -> None:
    """Record a publish decision."""
    approval = ApprovalSubmission.model_validate(
        {"approval_id": approval_id, "decision": decision, "note": note}
    )
    _render(
        _request(
            "POST",
            f"/api/v1/workflows/{workflow_id}/approve",
            payload=approval.model_dump(mode="json", exclude_none=True),
        )
    )


@workflow_app.command("cancel")
def cancel(workflow_id: str) -> None:
    """Cancel a workflow."""
    _render(_request("POST", f"/api/v1/workflows/{workflow_id}/cancel"))


@workflow_app.command("retry")
def retry(
    workflow_id: str,
    from_stage: Annotated[str | None, typer.Option("--from-stage")] = None,
) -> None:
    """Retry a workflow from an optional safe checkpoint."""
    request = RetryRequest.model_validate({"from_stage": from_stage})
    _render(
        _request(
            "POST",
            f"/api/v1/workflows/{workflow_id}/retry",
            payload=request.model_dump(mode="json", exclude_none=True),
        )
    )
