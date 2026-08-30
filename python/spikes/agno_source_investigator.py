"""Disposable Agno adapter for the bounded source-investigator comparison."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from typing import Any, Protocol

from agno.agent import Agent
from agno.models.base import Model
from agno.models.response import ModelResponse

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


class _FixtureAgnoModel(Model):
    """Credential-free model returning one deterministic fixture response."""

    response_json: str

    def __init__(self, response_json: str) -> None:
        super().__init__(id="source-fixture", name="source-fixture", provider="fixture")
        self.response_json = response_json

    def invoke(self, *args: Any, **kwargs: Any) -> ModelResponse:
        del args, kwargs
        return ModelResponse(content=self.response_json)

    async def ainvoke(self, *args: Any, **kwargs: Any) -> ModelResponse:
        return self.invoke(*args, **kwargs)

    def invoke_stream(self, *args: Any, **kwargs: Any) -> Iterator[ModelResponse]:
        yield self.invoke(*args, **kwargs)

    async def ainvoke_stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[ModelResponse]:
        yield await self.ainvoke(*args, **kwargs)

    def _parse_provider_response(self, response: Any, **kwargs: Any) -> ModelResponse:
        del kwargs
        if not isinstance(response, ModelResponse):
            raise TypeError("fixture response must be a ModelResponse")
        return response

    def _parse_provider_response_delta(self, response: Any) -> ModelResponse:
        if not isinstance(response, ModelResponse):
            raise TypeError("fixture response delta must be a ModelResponse")
        return response


class AgnoSourceInvestigator:
    """Agno structured-output seam over exactly three read-only application tools."""

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
                model=_FixtureAgnoModel(fixture.model_dump_json()),
                tools=[
                    self._tools.inspect_source_candidates,
                    self._tools.explain_source_choice,
                    self._tools.request_next_stage,
                ],
                output_schema=SourceExplanation,
                parse_response=True,
                telemetry=False,
            )
            run = await agent.arun("Return the fixture source explanation.")
            return SourceExplanation.model_validate(run.content)
        finally:
            self._active_task = None

    async def cancel(self) -> None:
        if self._active_task is not None:
            self._active_task.cancel()
            await asyncio.sleep(0)
