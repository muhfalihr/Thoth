"""A thin command-line client for the public control-plane HTTP API."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

import httpx
import typer

from thoth_control_plane.application import ApprovalSubmission, RetryRequest
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import WorkflowEvent, WorkflowRequest
from thoth_control_plane.operations.editor_migrations import apply_editor_migrations
from thoth_control_plane.operations.stage1_controlled_fallback import (
    GATE_ID,
    ControlledFallbackEvidenceError,
)
from thoth_control_plane.operations.stage1_controlled_fallback_runner import (
    ControlledFallbackRunConfig,
    ControlledFallbackRunner,
    SubprocessCommandExecutor,
)
from thoth_control_plane.operations.stage1_local_preflight import (
    Stage1PreflightError,
    check_stage1_local_environment,
    load_stage1_local_environment,
)
from thoth_control_plane.operations.stage1_provider_preflight import (
    check_stage1_provider_file,
)
from thoth_control_plane.operations.tiktok_parity import (
    DEFAULT_SCOUT_RECORDED_ROOT,
    TikTokParityEvidenceError,
    compare_parity_sample,
    render_parity_comparison,
)
from thoth_control_plane.operations.tiktok_soak import TikTokSoakDatasetError, evaluate_tiktok_soak
from thoth_control_plane.operations.tiktok_soak_cli import (
    TikTokSoakInputError,
    load_tiktok_soak_observations,
    write_tiktok_soak_report,
)

app = typer.Typer(no_args_is_help=True)
workflow_app = typer.Typer(no_args_is_help=True)
app.add_typer(workflow_app, name="workflow")
operations_app = typer.Typer(no_args_is_help=True)
app.add_typer(operations_app, name="operations")
editor_app = typer.Typer(no_args_is_help=True)
app.add_typer(editor_app, name="editor")


@editor_app.command("migrate")
def editor_migrate() -> None:
    """Apply explicit Creator Studio editor schema migrations."""
    database_url = Settings().THOTH_EDITOR_DATABASE_URL
    if database_url is None:
        raise typer.BadParameter("THOTH_EDITOR_DATABASE_URL must be configured")
    root = Path(__file__).resolve().parents[2] / "migrations" / "editor"
    typer.echo(apply_editor_migrations(database_url.get_secret_value(), root))


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


def _stream_events(path: str) -> Iterator[WorkflowEvent]:
    """Read only typed SSE data from the public workflow API."""
    base_url, api_key = _settings()
    headers = {"Authorization": f"Bearer {api_key}"}
    with httpx.stream("GET", f"{base_url}{path}", headers=headers, timeout=30) as response:
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            detail = error.response.text or str(error)
            raise typer.Exit(code=1) from typer.BadParameter(detail)
        for line in response.iter_lines():
            if line.startswith("data:"):
                yield WorkflowEvent.model_validate_json(line.removeprefix("data:").strip())


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
    """Stream typed v1 workflow events until the API closes the SSE connection."""
    for event in _stream_events(f"/api/v1/workflows/{workflow_id}/events"):
        _render(event.model_dump(mode="json"))


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


@operations_app.command("tiktok-stage1-soak")
def tiktok_stage1_soak(
    observations: Annotated[Path, typer.Option("--observations")],
    output_directory: Annotated[Path, typer.Option("--output-directory")] = Path("."),
) -> None:
    """Load a Stage 1 TikTok soak dataset and write the aggregate report."""
    try:
        items = load_tiktok_soak_observations(observations)
        report = evaluate_tiktok_soak(items, generated_at=datetime.now(UTC))
        write_tiktok_soak_report(report, output_directory)
    except (TikTokSoakInputError, TikTokSoakDatasetError, OSError):
        typer.echo("tiktok stage 1 soak evaluation failed", err=True)
        raise typer.Exit(code=1) from None
    typer.echo("tiktok stage 1 soak report written")


@operations_app.command("tiktok-stage1-parity-compare")
def tiktok_stage1_parity_compare(
    python_report: Annotated[Path, typer.Option("--python-report")],
    python_artifact_root: Annotated[Path, typer.Option("--python-artifact-root")],
    python_report_checksum: Annotated[str, typer.Option("--python-report-checksum")],
    scout_report: Annotated[Path, typer.Option("--scout-report")],
    scout_artifact_root: Annotated[Path, typer.Option("--scout-artifact-root")],
    scout_report_checksum: Annotated[str, typer.Option("--scout-report-checksum")],
    scout_media_checksum: Annotated[str, typer.Option("--scout-media-checksum")],
    scout_media_bytes: Annotated[int, typer.Option("--scout-media-bytes")],
    scout_recorded_root: Annotated[
        str, typer.Option("--scout-recorded-root")
    ] = DEFAULT_SCOUT_RECORDED_ROOT,
    input_url_file: Annotated[Path | None, typer.Option("--input-url-file")] = None,
) -> None:
    """Compare one designated Python/Scout parity sample from existing reports.

    Read-only and offline: it acquires nothing, contacts nothing, writes nothing,
    and never labels an observation. Output is field names and booleans only, so
    the sample's URL, caption, identity, checksums, and paths stay in restricted
    evidence. Exits non-zero when the sample does not pass.
    """
    try:
        input_url = input_url_file.read_text(encoding="utf-8").strip() if input_url_file else ""
    except (OSError, UnicodeError):
        typer.echo("parity evidence url file is missing or unreadable", err=True)
        raise typer.Exit(code=1) from None
    try:
        comparison = compare_parity_sample(
            python_report=python_report,
            python_artifact_root=python_artifact_root,
            python_report_checksum=python_report_checksum,
            scout_report=scout_report,
            scout_artifact_root=scout_artifact_root,
            scout_report_checksum=scout_report_checksum,
            scout_media_checksum=scout_media_checksum,
            scout_media_bytes=scout_media_bytes,
            scout_recorded_root=scout_recorded_root,
            input_url=input_url,
        )
    except TikTokParityEvidenceError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from None
    for line in render_parity_comparison(comparison):
        typer.echo(line)
    if not comparison.passed:
        raise typer.Exit(code=1)


@operations_app.command("stage1-local-preflight")
def stage1_local_preflight(
    env_file: Annotated[Path, typer.Option("--env-file")] = Path(".env.stage1.local"),
    provider_env_file: Annotated[Path | None, typer.Option("--provider-env-file")] = None,
) -> None:
    """Validate the local Stage 1 deployment environment before pulling images.

    Run from the repository root: the working directory is the repository the
    data root must stay outside of. Output names variables only, never values.

    `--provider-env-file` additionally validates the restricted Scout provider file
    required for a fallback-ready deployment. Omitting it preserves the existing
    non-live behaviour.
    """
    try:
        values = load_stage1_local_environment(env_file)
        check_stage1_local_environment(values, repository_root=Path.cwd())
        if provider_env_file is not None:
            check_stage1_provider_file(provider_env_file, repository_root=Path.cwd())
    except Stage1PreflightError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from None
    typer.echo("stage 1 local preflight passed")


def _controlled_fallback_config(
    *,
    sample: Path,
    provider: Path,
    data_root: Path,
    parity_root: Path,
    digest: str,
    acquisition_revision: str,
    harness_revision: str,
    base_compose_file: Path,
    gate_compose_file: Path,
    command_timeout: float,
    wait_timeout: float,
) -> ControlledFallbackRunConfig:
    return ControlledFallbackRunConfig(
        repository_root=Path.cwd(),
        sample=sample,
        provider=provider,
        data_root=data_root,
        parity_root=parity_root,
        digest=digest,
        acquisition_revision=acquisition_revision,
        harness_revision=harness_revision,
        base_compose_file=base_compose_file,
        gate_compose_file=gate_compose_file,
        command_timeout=command_timeout,
        wait_timeout=wait_timeout,
    )


@operations_app.command("stage1-controlled-fallback-preflight")
def stage1_controlled_fallback_preflight(
    sample: Annotated[Path, typer.Option("--sample")],
    provider: Annotated[Path, typer.Option("--provider")],
    data_root: Annotated[Path, typer.Option("--data-root")],
    parity_root: Annotated[Path, typer.Option("--parity-root")],
    digest: Annotated[str, typer.Option("--digest")],
    acquisition_revision: Annotated[str, typer.Option("--acquisition-revision")],
    harness_revision: Annotated[str, typer.Option("--harness-revision")],
    base_compose_file: Annotated[Path, typer.Option("--base-compose-file")] = Path(
        "compose.stage1.local.yml"
    ),
    gate_compose_file: Annotated[Path, typer.Option("--gate-compose-file")] = Path(
        "compose.stage1.controlled-fallback.yml"
    ),
    command_timeout: Annotated[float, typer.Option("--command-timeout")] = 30.0,
    wait_timeout: Annotated[float, typer.Option("--wait-timeout")] = 300.0,
) -> None:
    """Validate the `f1` gate inputs and live deployment without starting a container.

    Fails closed on any input, deployment, health, identity, or steady-state
    mismatch. Output is one fixed boolean line: never a Docker error, path, or
    fixture value.
    """
    config = _controlled_fallback_config(
        sample=sample,
        provider=provider,
        data_root=data_root,
        parity_root=parity_root,
        digest=digest,
        acquisition_revision=acquisition_revision,
        harness_revision=harness_revision,
        base_compose_file=base_compose_file,
        gate_compose_file=gate_compose_file,
        command_timeout=command_timeout,
        wait_timeout=wait_timeout,
    )
    runner = ControlledFallbackRunner(config, SubprocessCommandExecutor())
    try:
        runner.preflight()
    except Stage1PreflightError:
        typer.echo("controlled_fallback_preflight_passed=false")
        raise typer.Exit(code=1) from None
    typer.echo("controlled_fallback_preflight_passed=true")


@operations_app.command("stage1-controlled-fallback-run")
def stage1_controlled_fallback_run(
    gate_id: Annotated[str, typer.Option("--gate-id")],
    sample: Annotated[Path, typer.Option("--sample")],
    provider: Annotated[Path, typer.Option("--provider")],
    data_root: Annotated[Path, typer.Option("--data-root")],
    parity_root: Annotated[Path, typer.Option("--parity-root")],
    digest: Annotated[str, typer.Option("--digest")],
    acquisition_revision: Annotated[str, typer.Option("--acquisition-revision")],
    harness_revision: Annotated[str, typer.Option("--harness-revision")],
    base_compose_file: Annotated[Path, typer.Option("--base-compose-file")] = Path(
        "compose.stage1.local.yml"
    ),
    gate_compose_file: Annotated[Path, typer.Option("--gate-compose-file")] = Path(
        "compose.stage1.controlled-fallback.yml"
    ),
    command_timeout: Annotated[float, typer.Option("--command-timeout")] = 30.0,
    wait_timeout: Annotated[float, typer.Option("--wait-timeout")] = 300.0,
) -> None:
    """Run exactly one `f1` controlled fallback attempt against the live deployment.

    `--gate-id` must be the literal `f1`; this gate never retries. This is the
    only command that starts a container from operator-supplied inputs. Output
    is fixed lines only, never a Docker error, child output, fixture value,
    evidence path, container ID, or provider value:

    \b
    controlled_fallback_completed=true|false
    verdict=passed|failed|inconclusive
    """
    if gate_id != GATE_ID:
        raise typer.BadParameter(f"--gate-id must be the literal {GATE_ID!r}")
    config = _controlled_fallback_config(
        sample=sample,
        provider=provider,
        data_root=data_root,
        parity_root=parity_root,
        digest=digest,
        acquisition_revision=acquisition_revision,
        harness_revision=harness_revision,
        base_compose_file=base_compose_file,
        gate_compose_file=gate_compose_file,
        command_timeout=command_timeout,
        wait_timeout=wait_timeout,
    )
    runner = ControlledFallbackRunner(config, SubprocessCommandExecutor())
    try:
        attempt = runner.run_once()
    except ControlledFallbackEvidenceError:
        typer.echo("controlled_fallback_completed=false")
        typer.echo("verdict=inconclusive")
        raise typer.Exit(code=1) from None
    typer.echo("controlled_fallback_completed=true")
    typer.echo(f"verdict={attempt.verdict}")
    if attempt.verdict != "passed":
        raise typer.Exit(code=1)
