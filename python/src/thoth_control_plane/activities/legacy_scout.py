"""Temporary worker-only bridge to the legacy Scout command.

Retirement gate: a Python replacement must pass the same offline fixture, controlled
live smoke, cancellation, and worker-restart checks before this module and the
``bun scout/cli.ts`` dependency can be removed.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
from collections.abc import Awaitable, Callable
from datetime import timedelta
from hashlib import sha256
from pathlib import Path
from typing import Protocol

from pydantic import Field, HttpUrl
from temporalio import activity

from thoth_control_plane.domain import (
    ArtifactRef,
    SourceInvestigationActivityResult,
    SourceInvestigationResult,
)
from thoth_control_plane.domain.models import (
    LegacyScoutProgressEvent,
    OpaqueId,
    SafeActivityError,
    StrictModel,
)

LEGACY_ADAPTER_TASK_QUEUE = "thoth-legacy-adapter"
LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES = 1
_HEARTBEAT_SECONDS = 1


class LegacyScoutInput(StrictModel):
    """Typed compatibility input with no dashboard or legacy executor controls."""

    workflow_id: OpaqueId
    canonical_source_url: HttpUrl
    output_package_id: OpaqueId
    timeout: timedelta = Field(gt=timedelta(0), le=timedelta(minutes=30))
    cancellation_token: OpaqueId
    progress_records: list[LegacyScoutProgressRecord] = Field(default_factory=list)


class LegacyScoutProgressRecord(StrictModel):
    """Optional explicit progress supplied by a typed caller, never parsed CLI output."""

    stage: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    progress: float = Field(ge=0, le=1)


class _Process(Protocol):
    pid: int
    returncode: int | None

    async def communicate(self) -> tuple[bytes, bytes]: ...

    async def wait(self) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


ProcessFactory = Callable[..., Awaitable[_Process]]
ProcessGroupKiller = Callable[[int, int], None]
WindowsTreeKiller = Callable[..., Awaitable[None]]


class LegacyScoutActivity:
    """Own exactly one Scout process and translate its lifecycle into safe results."""

    def __init__(
        self,
        *,
        process_factory: ProcessFactory | None = None,
        platform_name: str | None = None,
        process_group_killer: ProcessGroupKiller | None = None,
        windows_tree_killer: WindowsTreeKiller | None = None,
        artifact_root: Path | None = None,
        repository_root: Path | None = None,
        shutdown_grace_seconds: float = 5,
    ) -> None:
        self._process_factory = process_factory or asyncio.create_subprocess_exec
        self._platform_name = platform_name or os.name
        self._process_group_killer = process_group_killer
        self._windows_tree_killer = windows_tree_killer
        self._artifact_root = (artifact_root or Path.cwd() / ".thoth-artifacts").resolve()
        self._repository_root = (repository_root or Path(__file__).resolve().parents[4]).resolve()
        self._shutdown_grace_seconds = shutdown_grace_seconds

    async def inspect(self, input_: LegacyScoutInput) -> SourceInvestigationResult:
        """Run the fixed legacy command without treating stdout as workflow state."""
        report_path = self._artifact_path(input_)
        try:
            report_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return self._failure_result(
                input_,
                code="legacy_scout_report_persistence_failed",
                diagnostic="legacy report destination is unavailable",
            )
        try:
            process = await self._process_factory(
                *self._argv(input_),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._repository_root,
                **self._process_group_options(),
            )
        except OSError:
            return self._failure_result(
                input_,
                code="legacy_scout_launch_failed",
                diagnostic="legacy process could not start",
            )
        finished = asyncio.Event()
        heartbeat = asyncio.create_task(self._heartbeat_until(finished))
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=input_.timeout.total_seconds()
            )
        except asyncio.CancelledError:
            await self._terminate_owned_tree(process)
            raise
        except TimeoutError:
            await self._terminate_owned_tree(process)
            return self._failure_result(
                input_,
                code="legacy_scout_timeout",
                diagnostic="legacy process timed out",
            )
        finally:
            finished.set()
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat

        if process.returncode not in (None, 0):
            return self._failure_result(
                input_,
                code="legacy_scout_failed",
                diagnostic=self._redacted_diagnostic(process.returncode, stdout, stderr),
            )
        try:
            report_content = report_path.read_bytes()
        except OSError:
            return self._failure_result(
                input_,
                code="legacy_scout_report_missing",
                diagnostic="legacy process completed without a durable report",
            )
        return self._success_result(input_, "legacy process completed", report_content)

    def _argv(self, input_: LegacyScoutInput) -> tuple[str, ...]:
        """Keep command construction fixed and typed; it is never passed to a shell."""
        return (
            "bun",
            "scout/cli.ts",
            "run",
            str(input_.canonical_source_url),
            "--out",
            str(self._artifact_path(input_)),
        )

    def _process_group_options(self) -> dict[str, int | bool]:
        if self._platform_name == "nt":
            return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        return {"start_new_session": True}

    async def _heartbeat_until(self, finished: asyncio.Event) -> None:
        while not finished.is_set():
            # Direct unit tests do not execute inside a Temporal Activity context.
            with contextlib.suppress(RuntimeError):
                activity.heartbeat("legacy_scout_running")
            try:
                await asyncio.wait_for(finished.wait(), timeout=_HEARTBEAT_SECONDS)
            except TimeoutError:
                continue

    async def _terminate_owned_tree(self, process: _Process) -> None:
        if process.returncode is not None:
            return
        if self._platform_name == "nt" and getattr(process, "pid", None):
            await self._kill_windows_tree(process.pid, force=False)
        elif self._platform_name != "nt" and getattr(process, "pid", None):
            self._kill_posix_group(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=self._shutdown_grace_seconds)
        except TimeoutError:
            if self._platform_name == "nt" and getattr(process, "pid", None):
                await self._kill_windows_tree(process.pid, force=True)
            elif self._platform_name != "nt" and getattr(process, "pid", None):
                self._kill_posix_group(process.pid, getattr(signal, "SIGKILL", 9))
            else:
                process.kill()
            await process.wait()

    def _kill_posix_group(self, pid: int, signal_number: int) -> None:
        with contextlib.suppress(ProcessLookupError):
            killer = self._process_group_killer or os.killpg
            killer(pid, signal_number)

    async def _kill_windows_tree(self, pid: int, *, force: bool) -> None:
        if self._windows_tree_killer is not None:
            await self._windows_tree_killer(pid, force=force)
            return
        await self._taskkill_tree(pid, force=force)

    @staticmethod
    def _output_destination(input_: LegacyScoutInput) -> str:
        return f"legacy-scout/{input_.workflow_id}/source-report.json"

    def _artifact_path(self, input_: LegacyScoutInput) -> Path:
        return self._artifact_root / self._output_destination(input_)

    @classmethod
    async def _taskkill_tree(cls, pid: int, *, force: bool) -> None:
        args = ["taskkill", "/PID", str(pid), "/T"]
        if force:
            args.append("/F")
        killer = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(killer.wait(), timeout=5)

    @classmethod
    def _success_result(
        cls, input_: LegacyScoutInput, diagnostic: str, report_content: bytes
    ) -> SourceInvestigationResult:
        fingerprint = sha256(report_content).hexdigest()
        report = ArtifactRef(
            artifact_id=f"art_{fingerprint[:20]}",
            kind="source_report",
            label="Legacy Scout source report",
            media_type="application/json",
            location=cls._output_destination(input_),
            checksum=f"sha256:{fingerprint}",
            size_bytes=len(report_content),
        )
        return SourceInvestigationResult(
            candidates=[],
            report=report,
            events=[
                LegacyScoutProgressEvent(kind="stage.started", payload={"stage": "source"}),
                *[
                    LegacyScoutProgressEvent(
                        kind="stage.progress",
                        payload={"stage": record.stage, "progress": record.progress},
                    )
                    for record in input_.progress_records
                ],
                LegacyScoutProgressEvent(kind="stage.completed", payload={"stage": "source"}),
            ],
            diagnostics=[diagnostic],
        )

    @classmethod
    def _failure_result(
        cls,
        input_: LegacyScoutInput,
        *,
        code: str,
        diagnostic: str,
    ) -> SourceInvestigationResult:
        return SourceInvestigationResult(
            failure=SafeActivityError(code=code, retryable=False),
            events=[
                LegacyScoutProgressEvent(kind="stage.started", payload={"stage": "source"}),
                *[
                    LegacyScoutProgressEvent(
                        kind="stage.progress",
                        payload={"stage": record.stage, "progress": record.progress},
                    )
                    for record in input_.progress_records
                ],
                LegacyScoutProgressEvent(kind="stage.failed", payload={"stage": "source"}),
            ],
            diagnostics=[diagnostic],
        )

    @staticmethod
    def _redacted_diagnostic(returncode: int | None, stdout: bytes, stderr: bytes) -> str:
        """Record only safe stream metadata: stdout/stderr are never workflow state or logs."""
        del stdout, stderr
        return f"legacy process failed (exit code {returncode}; output redacted)"


@activity.defn(name="inspect_legacy_scout")
async def inspect_legacy_scout(input_: LegacyScoutInput) -> SourceInvestigationActivityResult:
    """Temporal registration wrapper; the adapter's public result remains inspect()."""
    result = await LegacyScoutActivity().inspect(input_)
    return _activity_result(result)


def build_legacy_scout_activity(
    artifact_root: Path,
) -> Callable[[LegacyScoutInput], Awaitable[SourceInvestigationActivityResult]]:
    """Bind the worker-only legacy adapter to the configured durable artifact root."""
    adapter = LegacyScoutActivity(artifact_root=artifact_root)

    @activity.defn(name="inspect_legacy_scout")
    async def configured_legacy_scout_activity(
        input_: LegacyScoutInput,
    ) -> SourceInvestigationActivityResult:
        return _activity_result(await adapter.inspect(input_))

    return configured_legacy_scout_activity


def _activity_result(result: SourceInvestigationResult) -> SourceInvestigationActivityResult:
    """Remove diagnostics from the Temporal activity boundary."""
    return SourceInvestigationActivityResult(
        report=result.report,
        failure=result.failure,
        events=result.events,
    )
