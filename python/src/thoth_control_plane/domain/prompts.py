"""Strict Prompt Lab contracts with a backend-owned stage registry.

Prompt text is bounded plain Unicode data. It is never executable content and
is never rendered as HTML anywhere in the product.
"""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field, field_validator, model_validator

from thoth_control_plane.domain.models import OpaqueId, ProjectId, StrictModel

PromptStageId: TypeAlias = Literal["narrative_plan", "visual_plan", "caption_copy"]

PROMPT_LANGUAGE_PATTERN = r"^[a-z]{2}(?:-[A-Z]{2})?$"
PROMPT_TEXT_MAX_LENGTH = 12_000


def _validate_plain_text(value: str) -> str:
    if not value.strip():
        raise ValueError("prompt text must not be blank")
    return value


class PromptStageDefinition(StrictModel):
    stage_id: PromptStageId
    label: Annotated[str, Field(min_length=1, max_length=200)]
    status: Literal["draft_only", "proposal_ready"]


class PromptStarterDefinition(StrictModel):
    starter_id: OpaqueId
    label: Annotated[str, Field(min_length=1, max_length=200)]
    language: Annotated[str, Field(pattern=PROMPT_LANGUAGE_PATTERN)]
    body: Annotated[str, Field(min_length=1, max_length=12_000)]

    _validate_body = field_validator("body")(_validate_plain_text)


class PromptTemplateRevision(StrictModel):
    project_id: ProjectId
    template_id: OpaqueId
    revision: Annotated[int, Field(gt=0)]
    stage_id: PromptStageId
    language: Annotated[str, Field(pattern=PROMPT_LANGUAGE_PATTERN)]
    body: Annotated[str, Field(min_length=1, max_length=PROMPT_TEXT_MAX_LENGTH)]

    _validate_body = field_validator("body")(_validate_plain_text)


class ProjectPromptBinding(StrictModel):
    project_id: ProjectId
    stage_id: PromptStageId
    template_id: OpaqueId
    template_revision: Annotated[int, Field(gt=0)]
    project_override: Annotated[str | None, Field(max_length=PROMPT_TEXT_MAX_LENGTH)] = None
    revision: Annotated[int, Field(gt=0)]


class SavePromptTemplateRequest(StrictModel):
    stage_id: PromptStageId
    language: Annotated[str, Field(pattern=PROMPT_LANGUAGE_PATTERN)]
    body: Annotated[str, Field(min_length=1, max_length=PROMPT_TEXT_MAX_LENGTH)]
    template_id: OpaqueId | None = None
    base_revision: Annotated[int, Field(gt=0)] | None = None

    _validate_body = field_validator("body")(_validate_plain_text)

    @model_validator(mode="after")
    def validate_revision_identity(self) -> SavePromptTemplateRequest:
        if (self.template_id is None) != (self.base_revision is None):
            raise ValueError("template_id and base_revision must be provided together")
        return self


class SaveProjectPromptBindingRequest(StrictModel):
    template_id: OpaqueId
    template_revision: Annotated[int, Field(gt=0)]
    project_override: Annotated[str | None, Field(max_length=PROMPT_TEXT_MAX_LENGTH)] = None
    base_revision: Annotated[int, Field(gt=0)] | None = None


class ResolvedPromptSection(StrictModel):
    kind: Literal["template", "project_override"]
    label: Annotated[str, Field(min_length=1, max_length=200)]
    text: Annotated[str, Field(max_length=PROMPT_TEXT_MAX_LENGTH)]


class ResolvedPromptDraft(StrictModel):
    stage_id: PromptStageId
    sections: list[ResolvedPromptSection]
    visible_text: Annotated[str, Field(min_length=1)]


PROMPT_STAGES = (
    PromptStageDefinition(
        stage_id="narrative_plan", label="Narrative plan", status="proposal_ready"
    ),
    PromptStageDefinition(stage_id="visual_plan", label="Visual plan", status="proposal_ready"),
    PromptStageDefinition(
        stage_id="caption_copy", label="Caption and copy", status="proposal_ready"
    ),
)

PROMPT_STARTERS: dict[PromptStageId, PromptStarterDefinition] = {
    "narrative_plan": PromptStarterDefinition(
        starter_id="starter_narrative_plan_v1",
        label="Narrative plan starter",
        language="id-ID",
        body=(
            "Buat rencana narasi untuk video vertikal.\n"
            "1. Hook 3 detik pertama: sebutkan masalah penonton.\n"
            "2. Konteks singkat: satu fakta pendukung.\n"
            "3. Alur cerita: tiga beat menuju kesimpulan.\n"
            "4. Ajakan akhir: satu ajakan yang jelas."
        ),
    ),
    "visual_plan": PromptStarterDefinition(
        starter_id="starter_visual_plan_v1",
        label="Visual plan starter",
        language="id-ID",
        body=(
            "Rencanakan visual pendukung untuk setiap beat narasi.\n"
            "1. Hook: rekaman close-up yang relevan.\n"
            "2. Konteks: b-roll lokasi atau aktivitas.\n"
            "3. Beat cerita: satu visual per beat, durasi singkat.\n"
            "4. Penutup: visual yang menguatkan ajakan."
        ),
    ),
    "caption_copy": PromptStarterDefinition(
        starter_id="starter_caption_copy_v1",
        label="Caption and copy starter",
        language="id-ID",
        body=(
            "Tulis teks publikasi yang ringkas.\n"
            "1. Hook satu kalimat yang membuat berhenti scroll.\n"
            "2. Dua kalimat konteks tanpa jargon.\n"
            "3. Tagar relevan maksimal tiga.\n"
            "4. Ajakan interaksi satu kalimat."
        ),
    ),
}


def resolve_prompt_draft(
    template: PromptTemplateRevision, binding: ProjectPromptBinding
) -> ResolvedPromptDraft:
    """Compose the exact visible resolved draft with labelled sections only."""
    if template.project_id != binding.project_id or template.stage_id != binding.stage_id:
        raise ValueError("prompt template and binding must share project and stage")
    sections = [ResolvedPromptSection(kind="template", label="Template", text=template.body)]
    if binding.project_override:
        sections.append(
            ResolvedPromptSection(
                kind="project_override", label="Project override", text=binding.project_override
            )
        )
    visible_text = "\n\n".join(f"{section.label}\n{section.text}" for section in sections)
    return ResolvedPromptDraft(
        stage_id=binding.stage_id, sections=sections, visible_text=visible_text
    )
