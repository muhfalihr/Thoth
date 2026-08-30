"""Framework-neutral boundary for read-only source investigation."""

from __future__ import annotations

from typing import Annotated, Literal, Protocol

from pydantic import Field, model_validator

from thoth_control_plane.domain.models import OpaqueId, StrictModel

ReadOnlyToolName = Literal[
    "inspect_source_candidates",
    "explain_source_choice",
    "request_next_stage",
]


class SourceInvestigatorInput(StrictModel):
    """History-safe input containing identifiers only, never credentials or media."""

    workflow_id: OpaqueId
    correlation_id: OpaqueId
    candidate_ids: Annotated[list[OpaqueId], Field(min_length=1, max_length=100)]

    @model_validator(mode="after")
    def require_unique_candidates(self) -> SourceInvestigatorInput:
        if len(self.candidate_ids) != len(set(self.candidate_ids)):
            raise ValueError("candidate IDs must be unique")
        return self


class SourceCitation(StrictModel):
    """A durable citation to normalized, already-known candidate evidence."""

    candidate_id: OpaqueId
    evidence_id: OpaqueId
    summary: Annotated[str, Field(min_length=1, max_length=2_000)]


class ProposedApproval(StrictModel):
    """A proposal for the application service; it is not an approval decision."""

    kind: Literal["continue_to_acquisition"]
    evidence_ids: Annotated[list[OpaqueId], Field(min_length=1, max_length=100)]


class SourceExplanation(StrictModel):
    """Cited source choice and proposed next-stage approval, without side effects."""

    candidate_id: OpaqueId
    explanation: Annotated[str, Field(min_length=1, max_length=4_000)]
    citations: Annotated[list[SourceCitation], Field(min_length=1, max_length=100)]
    proposed_approval: ProposedApproval
    executed_tools: Annotated[list[ReadOnlyToolName], Field(min_length=1, max_length=3)]
    correlation_id: OpaqueId

    @model_validator(mode="after")
    def require_selected_candidate_evidence(self) -> SourceExplanation:
        if any(citation.candidate_id != self.candidate_id for citation in self.citations):
            raise ValueError("citations must belong to the selected candidate")
        citation_ids = {citation.evidence_id for citation in self.citations}
        if not set(self.proposed_approval.evidence_ids).issubset(citation_ids):
            raise ValueError("approval evidence must cite the selected candidate")
        if len(self.executed_tools) != len(set(self.executed_tools)):
            raise ValueError("executed tools must not contain duplicates")
        return self


class SourceInvestigator(Protocol):
    """Replaceable application protocol implemented only by isolated adapters."""

    async def explain(self, input: SourceInvestigatorInput) -> SourceExplanation:
        """Explain a source choice without performing or authorizing sensitive work."""


class SourceInvestigatorCheckpoint(Protocol):
    """Durable explanation checkpoint used across disposable adapter instances."""

    async def load(self, workflow_id: str) -> SourceExplanation | None:
        """Load a completed explanation for a workflow, if one exists."""

    async def save(self, workflow_id: str, explanation: SourceExplanation) -> None:
        """Persist a completed explanation before an approval pause."""
