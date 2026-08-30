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


class _FixtureAgnoModel(Model):
    """Credential-free model requesting three tools, then returning fixture output."""

    response_json: str

    def __init__(self, response_json: str, tool_names: tuple[str, ...]) -> None:
        super().__init__(id="source-fixture", name="source-fixture", provider="fixture")
        self.response_json = response_json
        self._tool_names = tool_names
        self._requested_tools = False

    def invoke(self, *args: Any, **kwargs: Any) -> ModelResponse:
        del args, kwargs
        if not self._requested_tools:
            self._requested_tools = True
            return ModelResponse(
                tool_calls=[
                    {
                        "id": f"fixture_call_{index}",
                        "type": "function",
                        "function": {"name": name, "arguments": "{}"},
                    }
                    for index, name in enumerate(self._tool_names, start=1)
                ]
            )
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
                model=_FixtureAgnoModel(fixture.model_dump_json(), self.sdk_registered_tools),
                tools=list(registered_tools),
                output_schema=SourceExplanation,
                parse_response=True,
                telemetry=False,
            )
            run = await agent.arun("Return the fixture source explanation.")
            explanation = SourceExplanation.model_validate(run.content)
            if self._checkpoint is not None:
                await self._checkpoint.save(input.workflow_id, explanation)
            return explanation
        finally:
            self._active_task = None

    async def cancel(self) -> None:
        if self._active_task is not None:
            self._active_task.cancel()
            await asyncio.sleep(0)
