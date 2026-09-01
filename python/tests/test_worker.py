"""Tests asserting worker startup ordering for provider log redaction."""

from __future__ import annotations

import pytest

from thoth_control_plane import worker
from thoth_control_plane.config import Settings


class _StopWorker(Exception):
    """Sentinel raised to stop `run_worker` right after the capability check."""


@pytest.mark.asyncio
async def test_worker_configures_provider_logging_before_capability_check(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(worker, "configure_provider_logging", lambda: calls.append("logging"))

    async def capability():
        calls.append("capability")
        raise _StopWorker

    monkeypatch.setattr(worker, "check_scrapling_capability", capability)
    with pytest.raises(_StopWorker):
        await worker.run_worker(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"))
    assert calls == ["logging", "capability"]
