"""Tests for C2 prompt proposal contracts, starters, and deterministic changes."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.prompt_proposals import (
    PROMPT_PROPOSAL_FAILURE_CODES,
    ApplyPromptProposalRequest,
    PromptProposalActivityResult,
    PromptProposalChange,
    PromptProposalWorkflowInput,
    PromptProviderDefinition,
    ProviderPromptRequest,
    ProviderPromptResult,
    SavePromptLayerLockRequest,
    SavePromptModelPreferenceRequest,
    apply_prompt_changes,
    build_prompt_changes,
    is_legal_transition,
)
from thoth_control_plane.domain.prompts import PROMPT_STAGES, PROMPT_STARTERS

MODEL = {
    "model_id": "deepseek/deepseek-v3.1",
    "label": "DeepSeek V3.1",
    "capabilities": ["improve", "translate"],
    "max_input_chars": 12000,
}


def test_every_prompt_stage_has_one_non_blank_starter() -> None:
    assert set(PROMPT_STARTERS) == {"narrative_plan", "visual_plan", "caption_copy"}
    assert all(starter.body.strip() for starter in PROMPT_STARTERS.values())
    assert all(starter.language == "id-ID" for starter in PROMPT_STARTERS.values())


def test_all_registered_stages_are_proposal_ready() -> None:
    assert all(stage.status == "proposal_ready" for stage in PROMPT_STAGES)


def test_public_provider_contract_contains_only_safe_catalog_fields() -> None:
    public = PromptProviderDefinition(
        provider_id="novita",
        label="Novita",
        enabled=True,
        models=(MODEL,),
    )
    assert public.model_dump(mode="json") == {
        "provider_id": "novita",
        "label": "Novita",
        "enabled": True,
        "models": [
            {
                "model_id": "deepseek/deepseek-v3.1",
                "label": "DeepSeek V3.1",
                "capabilities": ["improve", "translate"],
                "max_input_chars": 12000,
            }
        ],
    }


def test_provider_definition_rejects_unsafe_model_id() -> None:
    with pytest.raises(ValidationError):
        PromptProviderDefinition.model_validate(
            {
                "provider_id": "novita",
                "label": "Novita",
                "enabled": True,
                "models": [{**MODEL, "model_id": "../escape"}],
            }
        )


def test_selected_line_changes_reconstruct_without_accepting_client_text() -> None:
    changes = build_prompt_changes("template", "Hook\nContext\nCTA", "Hook!\nContext\nCTA now")
    selected = [changes[0].change_id]
    result = apply_prompt_changes("Hook\nContext\nCTA", changes, selected)
    assert result == "Hook!\nContext\nCTA"


def test_change_ids_are_stable_for_identical_spans() -> None:
    first = build_prompt_changes("template", "Hook\nContext", "Hook!\nContext")
    second = build_prompt_changes("template", "Hook\nContext", "Hook!\nContext")
    assert [change.change_id for change in first] == [change.change_id for change in second]


def test_changes_carry_ordered_non_overlapping_source_spans() -> None:
    changes = build_prompt_changes("project_override", "a\nb\nc\nd", "a\nX\nc\nY")
    assert [(change.start_line, change.end_line) for change in changes] == [(1, 2), (3, 4)]
    assert all(change.layer == "project_override" for change in changes)
    assert all(change.before_text and change.after_text for change in changes)


def test_apply_rejects_unknown_and_duplicate_change_ids() -> None:
    changes = build_prompt_changes("template", "a\nb", "a\nb!")
    with pytest.raises(ValueError):
        apply_prompt_changes("a\nb", changes, ["change_missing"])
    with pytest.raises(ValueError):
        apply_prompt_changes("a\nb", changes, [changes[0].change_id, changes[0].change_id])


def test_apply_without_selection_returns_the_source_text() -> None:
    changes = build_prompt_changes("template", "a\nb", "a\nb!")
    assert apply_prompt_changes("a\nb", changes, []) == "a\nb"


def test_apply_rejects_blank_or_oversized_result() -> None:
    blank = build_prompt_changes("template", "a", "")
    with pytest.raises(ValueError):
        apply_prompt_changes("a", blank, [blank[0].change_id])
    long_line = "x" * 12_000
    source = f"{long_line}\na"
    replacement = build_prompt_changes("template", source, f"{long_line}\nb")
    with pytest.raises(ValueError):
        apply_prompt_changes(source, replacement, [replacement[0].change_id])


def test_change_rejects_out_of_order_spans() -> None:
    with pytest.raises(ValidationError):
        PromptProposalChange.model_validate(
            {
                "change_id": "change_1",
                "layer": "template",
                "before_text": "a",
                "after_text": "b",
                "start_line": 3,
                "end_line": 1,
            }
        )


@pytest.mark.parametrize(
    ("current", "next_status", "legal"),
    [
        ("queued", "running", True),
        ("queued", "failed", True),
        ("queued", "succeeded", False),
        ("running", "succeeded", True),
        ("running", "failed", True),
        ("succeeded", "applied", True),
        ("succeeded", "rejected", True),
        ("succeeded", "superseded", True),
        ("succeeded", "running", False),
        ("applied", "rejected", False),
        ("failed", "running", False),
        ("rejected", "queued", False),
        ("superseded", "queued", False),
    ],
)
def test_proposal_status_transition_matrix(current: str, next_status: str, legal: bool) -> None:
    assert is_legal_transition(current, next_status) is legal


def test_safe_failure_code_allowlist_is_closed() -> None:
    assert (
        frozenset(
            {
                "provider_unavailable",
                "provider_timeout",
                "provider_rate_limited",
                "invalid_provider_output",
                "source_revision_changed",
                "layer_locked",
                "proposal_already_running",
                "model_not_allowed",
                "store_unavailable",
                "workflow_unavailable",
            }
        )
        == PROMPT_PROPOSAL_FAILURE_CODES
    )


def test_workflow_facing_contracts_carry_no_prompt_content() -> None:
    workflow_input = PromptProposalWorkflowInput(proposal_id="proposal_1")
    activity_result = PromptProposalActivityResult(
        proposal_id="proposal_1", status="succeeded", failure_code=None
    )

    assert workflow_input.model_dump() == {"proposal_id": "proposal_1"}
    assert activity_result.model_dump() == {
        "proposal_id": "proposal_1",
        "status": "succeeded",
        "failure_code": None,
    }


def test_provider_request_carries_only_typed_operation_fields() -> None:
    request = ProviderPromptRequest.model_validate(
        {
            "provider_id": "novita",
            "model_id": "deepseek/deepseek-v3.1",
            "kind": "improve",
            "text_by_layer": {"template": "Write a hook"},
            "target_language": None,
            "improvement_instructions": "Make it punchier",
            "hidden_instruction": "system-owned instruction",
        }
    )

    assert request.text_by_layer == {"template": "Write a hook"}
    assert request.target_language is None
    with pytest.raises(ValidationError):
        ProviderPromptResult.model_validate({"text_by_layer": {"unknown_layer": "text"}})


def test_preference_and_lock_requests_reject_invalid_revisions() -> None:
    with pytest.raises(ValidationError):
        SavePromptModelPreferenceRequest.model_validate(
            {"provider_id": "novita", "model_id": "deepseek/deepseek-v3.1", "base_revision": 0}
        )
    with pytest.raises(ValidationError):
        SavePromptLayerLockRequest.model_validate({"locked": True, "base_revision": -1})


def test_apply_request_accepts_only_change_ids_and_revisions() -> None:
    request = ApplyPromptProposalRequest.model_validate(
        {
            "source_template_revision": 3,
            "source_binding_revision": 2,
            "change_ids": ["change_abc"],
        }
    )
    assert request.change_ids == ("change_abc",)
    with pytest.raises(ValidationError):
        ApplyPromptProposalRequest.model_validate(
            {
                "source_template_revision": 3,
                "source_binding_revision": 2,
                "replacement_text": "client-authored",
            }
        )
