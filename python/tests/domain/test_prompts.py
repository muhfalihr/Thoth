"""Tests for the Prompt Lab stage registry and strict prompt contracts."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.prompts import (
    PROMPT_STAGES,
    ProjectPromptBinding,
    PromptTemplateRevision,
    ResolvedPromptDraft,
    SaveProjectPromptBindingRequest,
    SavePromptTemplateRequest,
    resolve_prompt_draft,
)


def template(**overrides: object) -> PromptTemplateRevision:
    values: dict[str, object] = {
        "project_id": "project_a",
        "template_id": "ptpl_001",
        "revision": 1,
        "stage_id": "narrative_plan",
        "language": "id-ID",
        "body": "Write a hook",
    }
    values.update(overrides)
    return PromptTemplateRevision.model_validate(values)


def binding(**overrides: object) -> ProjectPromptBinding:
    values: dict[str, object] = {
        "project_id": "project_a",
        "stage_id": "narrative_plan",
        "template_id": "ptpl_001",
        "template_revision": 1,
        "project_override": "Use Indonesian",
        "revision": 1,
    }
    values.update(overrides)
    return ProjectPromptBinding.model_validate(values)


def test_stage_registry_is_ordered_and_draft_only() -> None:
    assert [stage.stage_id for stage in PROMPT_STAGES] == [
        "narrative_plan",
        "visual_plan",
        "caption_copy",
    ]
    assert all(stage.status == "draft_only" for stage in PROMPT_STAGES)
    assert [stage.label for stage in PROMPT_STAGES] == [
        "Narrative plan",
        "Visual plan",
        "Caption and copy",
    ]


def test_prompt_template_revision_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        PromptTemplateRevision.model_validate(
            {**template().model_dump(), "system_policy": "secret instructions"}
        )


def test_prompt_template_revision_rejects_unsupported_stage() -> None:
    with pytest.raises(ValidationError):
        template(stage_id="improve_prompt")


@pytest.mark.parametrize("body", ["", "   "])
def test_prompt_template_revision_rejects_blank_body(body: str) -> None:
    with pytest.raises(ValidationError):
        template(body=body)


def test_prompt_template_revision_rejects_over_limit_body() -> None:
    with pytest.raises(ValidationError):
        template(body="a" * 12_001)


def test_prompt_template_revision_accepts_limit_body() -> None:
    assert template(body="a" * 12_000).body == "a" * 12_000


@pytest.mark.parametrize("language", ["en_US", "e", "ENG", "en-us", "toolong"])
def test_prompt_template_revision_rejects_invalid_language(language: str) -> None:
    with pytest.raises(ValidationError):
        template(language=language)


@pytest.mark.parametrize("revision", [0, -1])
def test_prompt_template_revision_rejects_non_positive_revision(revision: int) -> None:
    with pytest.raises(ValidationError):
        template(revision=revision)


@pytest.mark.parametrize(
    ("template_id", "base_revision"),
    [(None, 1), ("ptpl_001", None)],
)
def test_save_template_request_rejects_partial_revision_identity(
    template_id: str | None, base_revision: int | None
) -> None:
    with pytest.raises(ValidationError):
        SavePromptTemplateRequest.model_validate(
            {
                "stage_id": "narrative_plan",
                "language": "id-ID",
                "body": "Write a hook",
                "template_id": template_id,
                "base_revision": base_revision,
            }
        )


def test_save_template_request_accepts_creation_and_revision_identities() -> None:
    creation = SavePromptTemplateRequest.model_validate(
        {"stage_id": "narrative_plan", "language": "id-ID", "body": "Write a hook"}
    )
    revision = SavePromptTemplateRequest.model_validate(
        {
            "stage_id": "narrative_plan",
            "language": "id-ID",
            "body": "Write a hook",
            "template_id": "ptpl_001",
            "base_revision": 1,
        }
    )

    assert creation.template_id is None and creation.base_revision is None
    assert revision.template_id == "ptpl_001" and revision.base_revision == 1


def test_save_template_request_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        SavePromptTemplateRequest.model_validate(
            {
                "stage_id": "narrative_plan",
                "language": "id-ID",
                "body": "Write a hook",
                "provider": "unavailable",
            }
        )


@pytest.mark.parametrize("revision", [0, -1])
def test_project_prompt_binding_rejects_non_positive_revisions(revision: int) -> None:
    with pytest.raises(ValidationError):
        binding(template_revision=revision) if revision < 1 else binding(revision=revision)


def test_project_prompt_binding_rejects_over_limit_override() -> None:
    with pytest.raises(ValidationError):
        binding(project_override="a" * 12_001)


def test_project_prompt_binding_allows_absent_override() -> None:
    assert binding(project_override=None).project_override is None


def test_save_project_prompt_binding_request_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        SaveProjectPromptBindingRequest.model_validate(
            {
                "template_id": "ptpl_001",
                "template_revision": 1,
                "base_revision": 1,
                "provider": "unavailable",
            }
        )


def test_save_project_prompt_binding_request_allows_first_binding_without_base_revision() -> None:
    request = SaveProjectPromptBindingRequest.model_validate(
        {"template_id": "ptpl_001", "template_revision": 1}
    )

    assert request.base_revision is None
    assert request.project_override is None


def test_resolve_prompt_draft_labels_only_visible_sections() -> None:
    resolved = resolve_prompt_draft(template(), binding())

    assert [section.kind for section in resolved.sections] == ["template", "project_override"]
    assert resolved.visible_text == "Template\nWrite a hook\n\nProject override\nUse Indonesian"


def test_resolve_prompt_draft_omits_absent_override_section() -> None:
    resolved = resolve_prompt_draft(template(), binding(project_override=None))

    assert isinstance(resolved, ResolvedPromptDraft)
    assert [section.kind for section in resolved.sections] == ["template"]
    assert resolved.visible_text == "Template\nWrite a hook"


def test_resolve_prompt_draft_ignores_blank_override_section() -> None:
    resolved = resolve_prompt_draft(template(), binding(project_override=""))

    assert [section.kind for section in resolved.sections] == ["template"]


def test_resolve_prompt_draft_rejects_project_mismatch() -> None:
    with pytest.raises(ValueError):
        resolve_prompt_draft(template(), binding(project_id="project_b"))


def test_resolve_prompt_draft_rejects_stage_mismatch() -> None:
    with pytest.raises(ValueError):
        resolve_prompt_draft(template(), binding(stage_id="caption_copy"))
