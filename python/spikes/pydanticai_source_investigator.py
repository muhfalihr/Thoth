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

    def __init__(self, tools: ReadOnlyToolService) -> None:
        self._tools = tools
        self._active_task: asyncio.Task[Any] | None = None
        self.last_context: dict[str, Any] = {}

    async def explain(self, input: SourceInvestigatorInput) -> SourceExplanation:
        self._active_task = asyncio.current_task()
        self.last_context = input.model_dump(mode="json")
        try:
            await self._tools.inspect_source_candidates(input.workflow_id, input.correlation_id)
            choice = await self._tools.explain_source_choice(
                input.candidate_ids, input.correlation_id
            )
            citation = SourceCitation.model_validate(choice["citation"])
            proposed = await self._tools.request_next_stage(
                "continue_to_acquisition",
                [citation.evidence_id],
                input.correlation_id,
            )
            fixture = SourceExplanation(
                candidate_id=str(choice["candidate_id"]),
                explanation=str(choice["explanation"]),
                citations=[citation],
                proposed_approval=ProposedApproval.model_validate(
                    {
                        "kind": proposed["kind"],
                        "evidence_ids": proposed["evidence_ids"],
                    }
                ),
                executed_tools=list(self.tool_names),
                correlation_id=input.correlation_id,
            )
            agent = Agent(
                TestModel(call_tools=[], custom_output_args=fixture.model_dump(mode="json")),
                output_type=SourceExplanation,
                tools=[
                    self._tools.inspect_source_candidates,
                    self._tools.explain_source_choice,
                    self._tools.request_next_stage,
                ],
            )
            run = await agent.run("Return the fixture source explanation.")
            return run.output
        finally:
            self._active_task = None

    async def cancel(self) -> None:
        if self._active_task is not None:
            self._active_task.cancel()
            await asyncio.sleep(0)
