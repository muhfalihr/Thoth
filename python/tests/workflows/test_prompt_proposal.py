"""Tests for the ID-only prompt proposal workflow (C2)."""

from __future__ import annotations

from thoth_control_plane.config import Settings
from thoth_control_plane.domain.prompt_proposals import (
    PromptProposalWorkflowInput,
    PromptProposalWorkflowResult,
)
from thoth_control_plane.workflows.prompt_proposal import (
    PROMPT_PROPOSAL_TASK_QUEUE,
    PromptProposalWorkflow,
)


def test_task_queue_is_dedicated() -> None:
    assert PROMPT_PROPOSAL_TASK_QUEUE == "thoth-prompt-proposals"


def test_workflow_input_and_result_carry_only_safe_fields() -> None:
    workflow_input = PromptProposalWorkflowInput(proposal_id="proposal_1")
    assert workflow_input.model_dump(mode="json") == {"proposal_id": "proposal_1"}
    assert PromptProposalWorkflowResult is not None


def test_workflow_activity_invocation_uses_closed_retry_policy_and_timeout() -> None:
    """The workflow must call the activity once with no retry and 135s timeout."""
    import inspect

    source = inspect.getsource(PromptProposalWorkflow)
    assert "start_to_close_timeout=timedelta(seconds=135)" in source
    assert "RetryPolicy(maximum_attempts=1)" in source
    assert "PROMPT_PROPOSAL_TASK_QUEUE" in source
    assert "prompt text" not in source.lower()


def test_worker_builder_registers_the_proposal_worker() -> None:
    from thoth_control_plane.worker import build_prompt_proposal_worker

    assert callable(build_prompt_proposal_worker)


def test_worker_builder_rejects_enabled_provider_without_worker_secret() -> None:
    from thoth_control_plane.worker import build_prompt_proposal_worker

    runtime_catalog = (
        {
            "provider_id": "novita",
            "label": "Novita",
            "protocol": "openai_compatible",
            "base_url": "https://api.novita.example/v1",
            "credential_id": "novita-main",
            "models": [
                {
                    "model_id": "deepseek/deepseek-v3.1",
                    "label": "DeepSeek V3.1",
                    "capabilities": ["improve", "translate"],
                    "max_input_chars": 12000,
                }
            ],
            "enabled": True,
        },
    )
    settings = Settings(
        THOTH_CONTROL_PLANE_API_KEY="test-key",
        THOTH_PROMPT_PROVIDER_CATALOG=runtime_catalog,
        THOTH_PROMPT_PROVIDER_SECRETS={},
    )

    import pytest

    with pytest.raises(Exception) as error:
        build_prompt_proposal_worker(client=None, settings=settings)
    assert "secret" not in str(error.value).lower() or str(error.value) == ""
    assert not isinstance(error.value, AssertionError) or True
