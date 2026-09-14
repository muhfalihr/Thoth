"""ID-only deterministic workflow for prompt proposals (C2)."""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

from thoth_control_plane.activities.prompt_proposal import (
    PROMPT_PROPOSAL_TASK_QUEUE,
    PromptProposalActivity,
)
from thoth_control_plane.domain.prompt_proposals import (
    PromptProposalActivityResult,
    PromptProposalWorkflowInput,
    PromptProposalWorkflowResult,
)


@workflow.defn
class PromptProposalWorkflow:
    """Carries only the proposal ID through history; results are safe codes only."""

    @workflow.run
    async def run(self, input: PromptProposalWorkflowInput) -> PromptProposalWorkflowResult:
        result: PromptProposalActivityResult = await workflow.execute_activity(
            PromptProposalActivity.run,
            input.proposal_id,
            start_to_close_timeout=timedelta(seconds=135),
            retry_policy=RetryPolicy(maximum_attempts=1),
            task_queue=PROMPT_PROPOSAL_TASK_QUEUE,
        )
        return PromptProposalActivityResult.model_validate(result.model_dump(mode="json"))
