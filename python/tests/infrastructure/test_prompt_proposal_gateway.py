"""Tests for the idempotent Temporal start boundary (C2)."""

from __future__ import annotations

import pytest

from thoth_control_plane.config import Settings
from thoth_control_plane.domain.prompt_proposals import (
    PromptProposalWorkflowInput,
)
from thoth_control_plane.infrastructure.prompt_proposal_gateway import (
    TemporalPromptProposalGateway,
)


class RecordingTemporalClient:
    """Minimal Temporal client double recording the workflow start call."""

    def __init__(self, *, already_started: bool = False, failure: Exception | None = None) -> None:
        self.calls = 0
        self.input = None
        self.task_queue = None
        self.workflow_id = None
        self.already_started = already_started
        self.failure = failure

    async def start_workflow(
        self,
        workflow,
        arg,
        *,
        id: str,
        task_queue: str,
    ):
        self.calls += 1
        self.input = arg
        self.task_queue = task_queue
        self.workflow_id = id
        return await self._start_result()

    async def _start_result(self):
        if self.failure is not None:
            raise self.failure
        return _StartedHandle()


class _StartedHandle:
    pass


def settings() -> Settings:
    return Settings(THOTH_CONTROL_PLANE_API_KEY="test-key")


@pytest.mark.asyncio
async def test_gateway_starts_id_only_workflow_without_retrying_start() -> None:
    client = RecordingTemporalClient()
    gateway = TemporalPromptProposalGateway(client, settings=settings())

    await gateway.start("proposal_1")

    assert client.calls == 1
    assert client.input == PromptProposalWorkflowInput(proposal_id="proposal_1")
    assert client.task_queue == "thoth-prompt-proposals"
    assert client.workflow_id == "prompt-proposal/proposal_1"


@pytest.mark.asyncio
async def test_gateway_treats_already_started_as_success() -> None:
    class AlreadyStartedClient(RecordingTemporalClient):
        async def start_workflow(self, *args, **kwargs):  # type: ignore[override]
            self.calls += 1
            self.input = args[1] if args else kwargs.get("arg")
            self.task_queue = kwargs["task_queue"]
            self.workflow_id = kwargs["id"]
            raise Exception("workflow execution already started")

    client = AlreadyStartedClient()
    gateway = TemporalPromptProposalGateway(client, settings=settings())

    await gateway.start("proposal_1")

    assert client.calls == 1


@pytest.mark.asyncio
async def test_gateway_maps_unreachable_temporal_to_safe_error() -> None:
    class UnreachableClient(RecordingTemporalClient):
        async def start_workflow(self, *args, **kwargs):  # type: ignore[override]
            self.calls += 1
            raise RuntimeError("connection refused")

    client = UnreachableClient()
    gateway = TemporalPromptProposalGateway(client, settings=settings())

    from thoth_control_plane.application.prompt_proposal_ports import PromptWorkflowUnavailable

    with pytest.raises(PromptWorkflowUnavailable):
        await gateway.start("proposal_1")
    assert client.calls == 1
