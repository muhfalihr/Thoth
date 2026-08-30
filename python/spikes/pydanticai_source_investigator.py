"""Disposable PydanticAI adapter for the bounded source-investigator comparison."""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from thoth_control_plane.application.source_investigator import (
    ProposedApproval,
    SourceCitation,
    SourceExplanation,
    SourceInvestigatorCheckpoint,
    SourceInvestigatorInput,
)


class ReadOnlyToolService(Protocol):
    async def inspect_source_candidates(
        self, workflow_id: str, correlation_id: str
    ) -> list[dict[str, object]]: ...

    async def explain_source_choice(
        self, candidate_ids: list[str], correlation_id: str
    ) -> dict[str, object]: ...

    async def request_next_stage(
        self, kind: str, evidence_ids: list[str], correlation_id: str
    ) -> dict[str, object]: ...


class PydanticAISourceInvestigator:
    """PydanticAI structured-output seam over exactly three read-only tools."""

    tool_names = (
        "inspect_source_candidates",
        "explain_source_choice",
        "request_next_stage",
    )

    def __init__(
        self,
        tools: ReadOnlyToolService,
        *,
        checkpoint: SourceInvestigatorCheckpoint | None = None,
    ) -> None:
        self._tools = tools
        self._checkpoint = checkpoint
        self._active_task: asyncio.Task[Any] | None = None
        self.last_context: dict[str, Any] = {}
        self.sdk_registered_tools: tuple[str, ...] = ()
        self.sdk_invoked_tools: tuple[str, ...] = ()
        self.loaded_from_checkpoint = False

    async def explain(self, input: SourceInvestigatorInput) -> SourceExplanation:
        self._active_task = asyncio.current_task()
        self.last_context = input.model_dump(mode="json")
        self.sdk_registered_tools = ()
        self.sdk_invoked_tools = ()
        self.loaded_from_checkpoint = False
        try:
            if self._checkpoint is not None:
                recovered = await self._checkpoint.load(input.workflow_id)
                if recovered is not None:
                    self.loaded_from_checkpoint = True
                    return recovered

            citation = SourceCitation(
                candidate_id="candidate_vincentius",
                evidence_id="evidence_timestamp_001",
                summary="Published 14 minutes before the repost.",
            )
            fixture = SourceExplanation(
                candidate_id="candidate_vincentius",
                explanation="The timestamp and watermark identify the original upload.",
                citations=[citation],
                proposed_approval=ProposedApproval(
                    kind="continue_to_acquisition",
                    evidence_ids=[citation.evidence_id],
                ),
                executed_tools=list(self.tool_names),
                correlation_id=input.correlation_id,
            )

            async def inspect_source_candidates() -> list[dict[str, object]]:
                self.sdk_invoked_tools += ("inspect_source_candidates",)
                return await self._tools.inspect_source_candidates(
                    input.workflow_id, input.correlation_id
                )

            async def explain_source_choice() -> dict[str, object]:
                self.sdk_invoked_tools += ("explain_source_choice",)
                return await self._tools.explain_source_choice(
                    input.candidate_ids, input.correlation_id
                )

            async def request_next_stage() -> dict[str, object]:
                self.sdk_invoked_tools += ("request_next_stage",)
                return await self._tools.request_next_stage(
                    "continue_to_acquisition",
                    [citation.evidence_id],
                    input.correlation_id,
                )

            registered_tools = (
                inspect_source_candidates,
                explain_source_choice,
                request_next_stage,
            )
            self.sdk_registered_tools = tuple(tool.__name__ for tool in registered_tools)
            agent = Agent(
                TestModel(
                    call_tools="all",
                    custom_output_args=fixture.model_dump(mode="json"),
                ),
                output_type=SourceExplanation,
                tools=list(registered_tools),
            )
            run = await agent.run("Return the fixture source explanation.")
            if self._checkpoint is not None:
                await self._checkpoint.save(input.workflow_id, run.output)
            return run.output
        finally:
            self._active_task = None

    async def cancel(self) -> None:
        if self._active_task is not None:
            self._active_task.cancel()
            await asyncio.sleep(0)
