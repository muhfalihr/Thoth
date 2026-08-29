"""Behaviour tests for the temporary worker-only Scout compatibility seam."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta

import pytest
from pydantic import ValidationError

from thoth_control_plane.activities.legacy_scout import LegacyScoutActivity, LegacyScoutInput
from thoth_control_plane.config import Settings

LEGACY_INPUT = LegacyScoutInput(
    workflow_id="wf_legacy_scout_001",
    canonical_source_url="https://example.test/source/123",
    output_package_id="pkg_legacy_scout_001",
    timeout=timedelta(seconds=30),
    cancellation_token="can_legacy_scout_001",
)


class FakeProcess:
    def __init__(self) -> None:
        self.args: tuple[str, ...] | None = None
        self.returncode: int | None = None
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.tree_terminated = False
        self._release = asyncio.Event()

    def block_until_cancelled(self) -> None:
        self.returncode = None

    async def wait(self) -> int:
        await self._release.wait()
        return 0 if self.returncode is None else self.returncode

    def terminate(self) -> None:
        self.tree_terminated = True
        self.returncode = -15
        self._release.set()

    def kill(self) -> None:
        self.tree_terminated = True
        self.returncode = -9
        self._release.set()

    async def communicate(self) -> tuple[bytes, bytes]:
        await self._release.wait()
        return (b"source=https://signed.example.test/path?token=secret", b"token=secret")


def fake_process_factory(
    process: FakeProcess, *, release_on_create: bool = True
) -> Callable[..., Awaitable[FakeProcess]]:
    async def create(*args: str, **kwargs: object) -> FakeProcess:
        assert kwargs["stdout"] is asyncio.subprocess.PIPE
        assert kwargs["stderr"] is asyncio.subprocess.PIPE
        assert "shell" not in kwargs
        process.args = args
        if release_on_create:
            process._release.set()
        return process

    return create


@pytest.mark.asyncio
async def test_adapter_emits_structured_progress_without_parsing_stdout_as_state() -> None:
    process = FakeProcess()

    result = await LegacyScoutActivity(process_factory=fake_process_factory(process)).inspect(
        LEGACY_INPUT
    )

    assert result.events[0].kind == "stage.started"
    assert all(
        event.kind != "stage.progress" or event.payload["progress"] is not None
        for event in result.events
    )
    assert result.diagnostics == ["legacy process completed"]
    assert process.args == (
        "bun",
        "scout/cli.ts",
        "investigate",
        "--workflow-id",
        "wf_legacy_scout_001",
        "--source-url",
        "https://example.test/source/123",
        "--output-package-id",
        "pkg_legacy_scout_001",
        "--timeout-seconds",
        "30",
        "--cancellation-token",
        "can_legacy_scout_001",
    )


@pytest.mark.asyncio
async def test_adapter_cancels_the_owned_process_tree_and_reraises_cancellation() -> None:
    process = FakeProcess()
    process.block_until_cancelled()
    activity = LegacyScoutActivity(
        process_factory=fake_process_factory(process, release_on_create=False)
    )
    task = asyncio.create_task(activity.inspect(LEGACY_INPUT))

    for _ in range(20):
        if process.args is not None:
            break
        await asyncio.sleep(0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.tree_terminated is True


def test_input_is_strict_and_has_no_dashboard_executor_knobs() -> None:
    with pytest.raises(ValidationError):
        LegacyScoutInput.model_validate(
            {
                **LEGACY_INPUT.model_dump(mode="json"),
                "cap": 40,
            }
        )


def test_legacy_selection_is_explicit_worker_configuration() -> None:
    settings = Settings(
        THOTH_CONTROL_PLANE_API_KEY="development-key",
        THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE="legacy_scout",
    )

    assert settings.source_investigation_activity_mode == "legacy_scout"
