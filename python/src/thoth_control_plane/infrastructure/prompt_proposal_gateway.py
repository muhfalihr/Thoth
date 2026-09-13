"""Idempotent Temporal start boundary for prompt proposal workflows (C2)."""

from __future__ import annotations

from temporalio.client import Client

from thoth_control_plane.activities.prompt_proposal import PROMPT_PROPOSAL_TASK_QUEUE
from thoth_control_plane.application.prompt_proposal_ports import PromptWorkflowUnavailable
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.prompt_proposals import (
    PromptProposalWorkflowInput,
)


class TemporalPromptProposalGateway:
    """Starts one ID-only workflow per proposal; already-started counts as success."""

    def __init__(self, client: Client, settings: Settings) -> None:
        self._client = client
        self._settings = settings

    async def start(self, proposal_id: str) -> None:
        try:
            await self._client.start_workflow(
                "PromptProposalWorkflow",
                PromptProposalWorkflowInput.model_validate({"proposal_id": proposal_id}),
                id=f"prompt-proposal/{proposal_id}",
                task_queue=PROMPT_PROPOSAL_TASK_QUEUE,
            )
        except Exception as error:
            # Temporal surfaces an already-running start as an ALREADY_EXISTS failure.
            if "already" in str(error).lower():
                return
            raise PromptWorkflowUnavailable() from error
