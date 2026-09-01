"""Safe Python source-investigation activity boundary."""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import Awaitable, Callable, Mapping
from hashlib import sha256
from pathlib import Path, PurePosixPath

import httpx
from pydantic import HttpUrl, TypeAdapter
from temporalio import activity

from thoth_control_plane.acquisition.adapters.tikwm import TikWmResolver
from thoth_control_plane.acquisition.browser import ScraplingCapability, ScraplingHeadlessBrowser
from thoth_control_plane.acquisition.materializer import (
    MediaMaterializer,
    resolve_host_via_getaddrinfo,
)
from thoth_control_plane.acquisition.models import (
    AcquisitionAttempt,
    AcquisitionStrategy,
    AttemptStatus,
    TikTokAcquisitionResult,
    TikTokSourceReport,
)
from thoth_control_plane.acquisition.service import TikTokAcquisitionService
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import (
    ArtifactRef,
    SourceInvestigationActivityResult,
)
from thoth_control_plane.domain.models import (
    OpaqueId,
    SafeActivityError,
    SourceProgressEvent,
    StrictModel,
)

AcquisitionRunner = Callable[[str, str, Path], Awaitable[TikTokAcquisitionResult]]

_CAPABILITY_ADAPTER = TypeAdapter(ScraplingCapability)

_STAGE_NAMES: dict[AcquisitionStrategy, str] = {
    AcquisitionStrategy.SCRAPLING_HEADLESS: "tiktok_headless",
    AcquisitionStrategy.TIKWM_CDN: "tiktok_cdn",
}


class SourceInvestigationActivityInput(StrictModel):
    """Small typed activity input carried in Temporal history."""

    workflow_id: OpaqueId
    request_snapshot_id: OpaqueId
    canonical_source_url: HttpUrl


def _coerce_capability(
    capability: ScraplingCapability | Mapping[str, object] | None,
) -> ScraplingCapability:
    """Accept a real capability, a plain mapping (e.g. from a test double), or None."""
    if capability is None:
        return ScraplingCapability(available=True, code=None)
    return _CAPABILITY_ADAPTER.validate_python(capability)


def build_production_acquisition_runner(settings: Settings) -> AcquisitionRunner:
    """Build a fresh headless-browser + HTTP acquisition stack per activity call.

    `settings` is accepted for interface symmetry with `build_source_investigation_activity`
    and future acquisition-stack configuration; the stack itself needs no settings today.
    """
    del settings

    async def run(
        workflow_id: str, source_url: str, artifact_root: Path
    ) -> TikTokAcquisitionResult:
        browser = ScraplingHeadlessBrowser()
        client = httpx.AsyncClient(follow_redirects=False)
        try:
            resolver = TikWmResolver(client)
            materializer = MediaMaterializer(client, resolve_host_via_getaddrinfo)
            service = TikTokAcquisitionService(browser, resolver, materializer)
            return await service.inspect(
                workflow_id=workflow_id, source_url=source_url, artifact_root=artifact_root
            )
        finally:
            await browser.close()
            await client.aclose()

    return run


def _attempt_events(attempts: list[AcquisitionAttempt]) -> list[SourceProgressEvent]:
    """Reduce acquisition attempts to safe, fixed-taxonomy progress events.

    Only enum values and elapsed milliseconds cross this boundary; no raw
    diagnostic, URL, or provider response ever reaches Temporal history.
    """
    events: list[SourceProgressEvent] = []
    for attempt in attempts:
        stage = _STAGE_NAMES[attempt.strategy]
        events.append(SourceProgressEvent(kind="stage.started", payload={"stage": stage}))
        completion_kind = (
            "stage.failed" if attempt.status == AttemptStatus.FAILED else "stage.completed"
        )
        payload: dict[str, str | int | float | bool | None] = {
            "stage": stage,
            "status": attempt.status.value,
            "elapsed_ms": attempt.elapsed_ms,
        }
        if attempt.reason is not None:
            payload["reason"] = attempt.reason.value
        events.append(SourceProgressEvent(kind=completion_kind, payload=payload))
    return events


def _cleanup_after_persistence_failure(
    part_path: Path, report: TikTokSourceReport, artifact_root: Path
) -> None:
    """Remove the partial report and every materialized media file the report recorded.

    `media.location` is validated as a `PurePosixPath` (POSIX separators only),
    but a Windows-style backslash string can slip past that check as a single
    opaque segment and then, once joined with a real `Path`, resolve to an
    absolute path or a `..` escape outside `artifact_root`. Only unlink
    candidates that resolve inside the artifact root; skip anything else.
    """
    with contextlib.suppress(OSError):
        part_path.unlink(missing_ok=True)
    resolved_root = artifact_root.resolve()
    for media in report.media:
        candidate = (artifact_root / media.location).resolve()
        if not candidate.is_relative_to(resolved_root):
            continue
        with contextlib.suppress(OSError):
            candidate.unlink(missing_ok=True)


async def _run(
    input_: SourceInvestigationActivityInput,
    artifact_root: Path,
    runner: AcquisitionRunner,
    capability: ScraplingCapability,
) -> SourceInvestigationActivityResult:
    """Run the injected acquisition runner and persist its report atomically."""
    if not capability.available:
        return SourceInvestigationActivityResult(
            failure=SafeActivityError(
                code=capability.code or "acquisition_dependency_unavailable", retryable=False
            )
        )

    try:
        acquisition_result = await runner(
            input_.workflow_id, str(input_.canonical_source_url), artifact_root
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        # Defense in depth: if the capability gate above is ever bypassed, a
        # raw exception (e.g. the lazy Scrapling ImportError) must not carry
        # its message into Temporal history. Nothing derived from the
        # exception crosses this boundary -- only a fixed, safe code.
        return SourceInvestigationActivityResult(
            failure=SafeActivityError(code="acquisition_runner_failed", retryable=False)
        )

    if acquisition_result.failure is not None:
        return SourceInvestigationActivityResult(
            failure=SafeActivityError(
                code=acquisition_result.failure.code,
                retryable=acquisition_result.failure.retryable,
            )
        )

    report = acquisition_result.report
    assert report is not None  # TikTokAcquisitionResult guarantees exactly one outcome

    events = _attempt_events(report.outcome.attempts)

    # Ruling F-4a: the report artifact location is derived solely from the
    # activity input's workflow_id, never from the report body.
    location = PurePosixPath("reports") / input_.workflow_id / "source-report.json"
    report_path = artifact_root / location
    part_path = report_path.with_name(report_path.name + ".part")
    content = report.model_dump_json(indent=2, exclude_none=False).encode("utf-8")

    try:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with part_path.open("wb") as handle:
            handle.write(content)
            handle.flush()
        os.replace(part_path, report_path)
    except asyncio.CancelledError:
        # Defensive: none of the calls above are `await`ed, so cancellation
        # cannot actually land inside this `try` today. Kept as a guard for
        # if that ever changes (e.g. an async persistence backend) so a
        # `.part` file is never left behind on cancellation; not covered by
        # a test since it is currently unreachable.
        _cleanup_after_persistence_failure(part_path, report, artifact_root)
        raise
    except OSError:
        _cleanup_after_persistence_failure(part_path, report, artifact_root)
        return SourceInvestigationActivityResult(
            failure=SafeActivityError(code="artifact_persistence_failed", retryable=True),
            events=events,
        )

    digest = sha256(content).hexdigest()
    artifact = ArtifactRef(
        artifact_id=f"art_source_{digest[:20]}",
        kind="source_report",
        label="Source investigation report",
        media_type="application/json",
        location=location.as_posix(),
        checksum=f"sha256:{digest}",
        size_bytes=len(content),
    )
    return SourceInvestigationActivityResult(report=artifact, events=events)


@activity.defn(name="inspect_source_candidates")
async def inspect_source_candidates(
    input_: SourceInvestigationActivityInput,
) -> SourceInvestigationActivityResult:
    """Activity-name reference for workflow definitions and direct local use."""
    configured = build_source_investigation_activity(Settings())  # type: ignore[call-arg]
    return await configured(input_)


def build_source_investigation_activity(
    settings: Settings,
    *,
    runner: AcquisitionRunner | None = None,
    capability: ScraplingCapability | Mapping[str, object] | None = None,
) -> Callable[
    [SourceInvestigationActivityInput],
    Awaitable[SourceInvestigationActivityResult],
]:
    """Bind the production activity to the same configured root used by FastAPI."""

    artifact_root = settings.THOTH_CONTROL_PLANE_ARTIFACT_ROOT.resolve()
    selected_runner = runner or build_production_acquisition_runner(settings)
    selected_capability = _coerce_capability(capability)

    @activity.defn(name="inspect_source_candidates")
    async def configured_source_investigation_activity(
        input_: SourceInvestigationActivityInput,
    ) -> SourceInvestigationActivityResult:
        return await _run(input_, artifact_root, selected_runner, selected_capability)

    return configured_source_investigation_activity
