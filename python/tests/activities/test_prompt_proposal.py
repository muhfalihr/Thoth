"""Tests for the prompt proposal activity boundary (C2)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from thoth_control_plane.activities.prompt_proposal import (
    PROMPT_HIDDEN_INSTRUCTION,
    PromptProposalActivity,
    build_prompt_proposal_activity,
)
from thoth_control_plane.application.prompt_proposal_ports import (
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from thoth_control_plane.domain.prompt_proposals import (
    PromptProposal,
    PromptProposalActivityResult,
)


def default_proposal(**overrides: object) -> PromptProposal:
    values: dict[str, object] = {
        "proposal_id": "proposal_1",
        "project_id": "project_a",
        "stage_id": "narrative_plan",
        "kind": "improve",
        "status": "queued",
        "target_layers": ["template"],
        "source": {
            "template_id": "ptpl_001",
            "template_revision": 1,
            "binding_revision": 1,
            "template_language": "id-ID",
            "template_body": "Write a hook",
            "project_override": "Use Indonesian",
        },
        "target_language": None,
        "improvement_instructions": "Make it punchier",
        "provider_id": "novita",
        "model_id": "deepseek/deepseek-v3.1",
        "changes": [],
        "translated_template_body": None,
        "translated_project_override": None,
        "failure_code": None,
        "created_at": datetime(2026, 9, 13, 8, tzinfo=UTC).isoformat(),
        "started_at": None,
        "finished_at": None,
    }
    values.update(overrides)
    return PromptProposal.model_validate(values)


class FakeProposalRepository:
    def __init__(self, proposal: PromptProposal | None = None) -> None:
        self.proposal = proposal if proposal is not None else default_proposal()
        self.transitions: list[str] = []
        self.success_payloads: list[dict[str, str]] = []
        self.failure_codes: list[str] = []

    async def get_proposal(self, project_id: str, proposal_id: str) -> PromptProposal | None:
        return self.proposal

    async def get_proposal_for_worker(self, proposal_id: str) -> PromptProposal | None:
        return self.proposal

    async def mark_running(self, proposal_id: str) -> PromptProposal:
        self.transitions.append("running")
        return self.proposal.model_copy(update={"status": "running"})

    async def record_success(
        self, proposal_id: str, text_by_layer: dict[str, str]
    ) -> PromptProposal:
        self.transitions.append("succeeded")
        self.success_payloads.append(text_by_layer)
        return self.proposal.model_copy(update={"status": "succeeded"})

    async def record_failure(self, proposal_id: str, failure_code: str) -> PromptProposal:
        self.transitions.append("failed")
        self.failure_codes.append(failure_code)
        return self.proposal.model_copy(update={"status": "failed", "failure_code": failure_code})


class FakeProvider:
    def __init__(self, error: Exception | None = None) -> None:
        self.calls = 0
        self.requests: list[object] = []
        self.error = error

    async def propose(self, request):
        self.calls += 1
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        if request.kind == "translate":
            return {"text_by_layer": {"template": "T", "project_override": "O"}}
        return {"text_by_layer": {"template": "Improved hook"}}


@pytest.mark.asyncio
async def test_activity_calls_provider_once_and_persists_success() -> None:
    repository, provider = FakeProposalRepository(), FakeProvider()
    activity = PromptProposalActivity(repository=repository, provider=provider)

    result = await activity.run("proposal_1")

    assert result == PromptProposalActivityResult(
        proposal_id="proposal_1", status="succeeded", failure_code=None
    )
    assert provider.calls == 1
    assert repository.transitions == ["running", "succeeded"]
    assert repository.success_payloads == [{"template": "Improved hook"}]


@pytest.mark.asyncio
async def test_activity_builds_request_from_persisted_source_only() -> None:
    repository, provider = FakeProposalRepository(), FakeProvider()
    activity = PromptProposalActivity(repository=repository, provider=provider)

    await activity.run("proposal_1")

    request = provider.requests[0]
    assert request.provider_id == "novita"
    assert request.model_id == "deepseek/deepseek-v3.1"
    assert request.text_by_layer == {"template": "Write a hook"}
    assert request.improvement_instructions == "Make it punchier"
    assert request.hidden_instruction == PROMPT_HIDDEN_INSTRUCTION
    assert PROMPT_HIDDEN_INSTRUCTION.strip() != ""


@pytest.mark.asyncio
async def test_activity_preserves_translation_layers() -> None:
    repository = FakeProposalRepository(
        default_proposal(
            kind="translate",
            target_layers=["template", "project_override"],
            target_language="en-US",
        )
    )
    provider = FakeProvider()
    activity = PromptProposalActivity(repository=repository, provider=provider)

    result = await activity.run("proposal_1")

    assert result.status == "succeeded"
    assert repository.success_payloads == [{"template": "T", "project_override": "O"}]
    request = provider.requests[0]
    assert set(request.text_by_layer) == {"template", "project_override"}
    assert request.target_language == "en-US"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider_error", "expected_code"),
    [
        (ProviderTimeout(), "provider_timeout"),
        (ProviderRateLimited(), "provider_rate_limited"),
        (ProviderUnavailable(), "provider_unavailable"),
    ],
)
async def test_activity_persists_safe_provider_failures(
    provider_error: Exception, expected_code: str
) -> None:
    repository, provider = FakeProposalRepository(), FakeProvider(error=provider_error)
    activity = PromptProposalActivity(repository=repository, provider=provider)

    result = await activity.run("proposal_1")

    assert result == PromptProposalActivityResult(
        proposal_id="proposal_1", status="failed", failure_code=expected_code
    )
    assert provider.calls == 1
    assert repository.transitions == ["running", "failed"]
    assert repository.failure_codes == [expected_code]


@pytest.mark.asyncio
async def test_activity_invalid_output_fails_closed_with_safe_code() -> None:
    class BadProvider(FakeProvider):
        async def propose(self, request):
            self.calls += 1
            self.requests.append(request)
            return {"text_by_layer": {"template": "   "}}

    repository, provider = FakeProposalRepository(), BadProvider()
    activity = PromptProposalActivity(repository=repository, provider=provider)

    result = await activity.run("proposal_1")

    assert result.failure_code == "invalid_provider_output"
    assert provider.calls == 1
    assert repository.transitions == ["running", "failed"]


@pytest.mark.asyncio
async def test_activity_activity_result_contains_no_prompt_text() -> None:
    repository, provider = FakeProposalRepository(), FakeProvider()
    activity = PromptProposalActivity(repository=repository, provider=provider)

    result = await activity.run("proposal_1")

    dumped = result.model_dump(mode="json")
    dumped_text = str(dumped).lower()
    assert "write a hook" not in dumped_text
    assert "improved hook" not in dumped_text


@pytest.mark.asyncio
async def test_build_prompt_proposal_activity_registers_typed_activity() -> None:
    async def repository_factory():
        return None

    repository, provider = FakeProposalRepository(), FakeProvider()
    activity = build_prompt_proposal_activity(repository=repository, provider=provider)
    assert isinstance(activity, PromptProposalActivity)
    assert hasattr(PromptProposalActivity, "run")
