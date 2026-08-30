from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from thoth_control_plane.application.source_investigator import (
    ProposedApproval,
    SourceCitation,
    SourceExplanation,
    SourceInvestigatorInput,
)

FIXTURE_INPUT = SourceInvestigatorInput(
    workflow_id="wf_source_001",
    correlation_id="corr_source_001",
    candidate_ids=["candidate_vincentius", "candidate_repost"],
)


class ContractInvestigator:
    """Small framework-neutral implementation used to exercise the public contract."""

    def __init__(self) -> None:
        self.last_context: dict[str, Any] = {}

    async def explain(self, input: SourceInvestigatorInput) -> SourceExplanation:
        self.last_context = input.model_dump(mode="json")
        return SourceExplanation(
            candidate_id="candidate_vincentius",
            explanation="The watermark and earlier timestamp identify the original upload.",
            citations=[
                SourceCitation(
                    candidate_id="candidate_vincentius",
                    evidence_id="evidence_timestamp_001",
                    summary="Published 14 minutes before the repost.",
                )
            ],
            proposed_approval=ProposedApproval(
                kind="continue_to_acquisition",
                evidence_ids=["evidence_timestamp_001"],
            ),
            executed_tools=[
                "inspect_source_candidates",
                "explain_source_choice",
                "request_next_stage",
            ],
            correlation_id=input.correlation_id,
        )


@pytest.mark.asyncio
async def test_investigator_returns_citations_but_has_no_side_effect_tool() -> None:
    investigator = ContractInvestigator()

    explanation = await investigator.explain(FIXTURE_INPUT)

    assert explanation.candidate_id == "candidate_vincentius"
    assert explanation.citations
    assert explanation.proposed_approval.kind == "continue_to_acquisition"
    assert set(explanation.executed_tools).issubset(
        {
            "inspect_source_candidates",
            "explain_source_choice",
            "request_next_stage",
        }
    )


@pytest.mark.asyncio
async def test_investigator_input_cannot_receive_credentials_or_media_bytes() -> None:
    investigator = ContractInvestigator()

    await investigator.explain(FIXTURE_INPUT)

    assert "cookie" not in investigator.last_context
    assert "credential" not in investigator.last_context
    assert "media" not in investigator.last_context
    with pytest.raises(ValidationError):
        SourceInvestigatorInput.model_validate(
            {
                **FIXTURE_INPUT.model_dump(mode="json"),
                "cookie": "session=secret",
                "media_bytes": b"video",
            }
        )


def test_explanation_rejects_citation_for_another_candidate() -> None:
    with pytest.raises(ValidationError, match="selected candidate"):
        SourceExplanation(
            candidate_id="candidate_vincentius",
            explanation="Unsupported selection",
            citations=[
                SourceCitation(
                    candidate_id="candidate_repost",
                    evidence_id="evidence_wrong_001",
                    summary="Evidence belongs to another candidate.",
                )
            ],
            proposed_approval=ProposedApproval(
                kind="continue_to_acquisition",
                evidence_ids=["evidence_wrong_001"],
            ),
            executed_tools=["inspect_source_candidates"],
            correlation_id="corr_source_001",
        )
