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
WindowsTreeKiller = Callable[[int], Awaitable[None]]


class LegacyScoutActivity:
    """Own exactly one Scout process and translate its lifecycle into safe results."""

    def __init__(
        self,
        *,
        process_factory: ProcessFactory | None = None,
        platform_name: str | None = None,
        process_group_killer: ProcessGroupKiller | None = None,
        windows_tree_killer: WindowsTreeKiller | None = None,
    ) -> None:
        self._process_factory = process_factory or asyncio.create_subprocess_exec
        self._platform_name = platform_name or os.name
        self._process_group_killer = process_group_killer
        self._windows_tree_killer = windows_tree_killer

    async def inspect(self, input_: LegacyScoutInput) -> SourceInvestigationResult:
        """Run the fixed legacy command without treating stdout as workflow state."""
        process = await self._process_factory(
            *self._argv(input_),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **self._process_group_options(),
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
        return self._success_result(input_, "legacy process completed")

    @staticmethod
    def _argv(input_: LegacyScoutInput) -> tuple[str, ...]:
        """Keep command construction fixed and typed; it is never passed to a shell."""
        return (
            "bun",
            "scout/cli.ts",
            "investigate",
            "--workflow-id",
            input_.workflow_id,
            "--source-url",
            str(input_.canonical_source_url),
            "--output-package-id",
            input_.output_package_id,
            "--output-destination",
            LegacyScoutActivity._output_destination(input_),
            "--timeout-seconds",
            str(int(input_.timeout.total_seconds())),
            "--cancellation-token",
            input_.cancellation_token,
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
            if self._windows_tree_killer is not None:
                await self._windows_tree_killer(process.pid)
            else:
                await self._taskkill_tree(process.pid)
        elif self._platform_name != "nt" and getattr(process, "pid", None):
            with contextlib.suppress(ProcessLookupError):
                killer = self._process_group_killer or os.killpg
                killer(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()

    @staticmethod
    def _output_destination(input_: LegacyScoutInput) -> str:
        return f"legacy-scout/{input_.workflow_id}/source-report.json"

    @classmethod
    async def _taskkill_tree(cls, pid: int) -> None:
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(killer.wait(), timeout=5)

    @classmethod
    def _success_result(
        cls, input_: LegacyScoutInput, diagnostic: str
    ) -> SourceInvestigationResult:
        fingerprint = sha256(input_.output_package_id.encode()).hexdigest()
        report = ArtifactRef(
            artifact_id=f"art_{fingerprint[:20]}",
            kind="source_report",
            label="Legacy Scout source report",
            media_type="application/json",
            location=cls._output_destination(input_),
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
    return SourceInvestigationActivityResult(
        report=result.report,
        failure=result.failure,
        events=result.events,
    )
