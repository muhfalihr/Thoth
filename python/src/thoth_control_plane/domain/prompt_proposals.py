"""Strict C2 prompt-proposal contracts with deterministic change hunks."""

from __future__ import annotations

from collections.abc import Sequence
from hashlib import sha256
from typing import Annotated, Literal, TypeAlias

from pydantic import Field, field_validator, model_validator

from thoth_control_plane.domain.models import OpaqueId, ProjectId, StrictModel

SafeIdentifier: TypeAlias = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")]
PositiveInt: TypeAlias = Annotated[int, Field(gt=0)]
NonNegativeInt: TypeAlias = Annotated[int, Field(ge=0)]
NonEmptyText: TypeAlias = Annotated[str, Field(min_length=1, max_length=200)]
PromptBody: TypeAlias = Annotated[str, Field(min_length=1, max_length=12_000)]
PromptOverride: TypeAlias = Annotated[str, Field(max_length=12_000)]
PromptInstructions: TypeAlias = Annotated[str, Field(min_length=1, max_length=2_000)]
PROMPT_LANGUAGE_PATTERN = r"^[a-z]{2}(?:-[A-Z]{2})?$"
PromptLanguage: TypeAlias = Annotated[str, Field(pattern=PROMPT_LANGUAGE_PATTERN)]

PromptLayer: TypeAlias = Literal["template", "project_override"]
PromptProposalKind: TypeAlias = Literal["improve", "translate"]
PromptProposalStatus: TypeAlias = Literal[
    "queued",
    "running",
    "succeeded",
    "failed",
    "applied",
    "rejected",
    "superseded",
]

PROMPT_PROPOSAL_FAILURE_CODES = frozenset(
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
PromptProposalFailureCode: TypeAlias = Literal[
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
]

PROMPT_PROPOSAL_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "failed"}),
    "running": frozenset({"succeeded", "failed"}),
    "succeeded": frozenset({"applied", "rejected", "superseded"}),
    "failed": frozenset(),
    "applied": frozenset(),
    "rejected": frozenset(),
    "superseded": frozenset(),
}


def is_legal_transition(current: str, next_status: str) -> bool:
    """Return whether the proposal lifecycle allows this transition."""
    return next_status in PROMPT_PROPOSAL_TRANSITIONS.get(current, frozenset())


class PromptModelDefinition(StrictModel):
    model_id: SafeIdentifier
    label: NonEmptyText
    capabilities: tuple[Literal["improve", "translate"], ...]
    max_input_chars: Annotated[int, Field(gt=0, le=200_000)]

    @field_validator("capabilities", mode="before")
    @classmethod
    def _normalize_capabilities(cls, value: object) -> object:
        if isinstance(value, (list, tuple, set, frozenset)):
            return tuple(sorted(set(value)))
        return value


class PromptProviderDefinition(StrictModel):
    """The browser-safe catalog projection; never carries endpoints or credentials."""

    provider_id: SafeIdentifier
    label: NonEmptyText
    enabled: bool
    models: tuple[PromptModelDefinition, ...]


class ProjectPromptModelPreference(StrictModel):
    project_id: ProjectId
    stage_id: str
    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    revision: PositiveInt
    updated_at: str


class ProjectPromptLayerLock(StrictModel):
    project_id: ProjectId
    stage_id: str
    layer: PromptLayer
    locked: bool
    revision: PositiveInt
    updated_at: str


class SavePromptModelPreferenceRequest(StrictModel):
    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    base_revision: PositiveInt | None = None


class SavePromptLayerLockRequest(StrictModel):
    locked: bool
    base_revision: PositiveInt | None = None


class PromptProposalSource(StrictModel):
    template_id: OpaqueId
    template_revision: PositiveInt
    binding_revision: PositiveInt
    template_language: PromptLanguage
    template_body: PromptBody
    project_override: PromptOverride | None = None

    @field_validator("project_override", mode="before")
    @classmethod
    def _empty_override_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value


class PromptProposalChange(StrictModel):
    change_id: OpaqueId
    layer: PromptLayer
    before_text: Annotated[str, Field(max_length=12_000)]
    after_text: Annotated[str, Field(max_length=12_000)]
    start_line: NonNegativeInt
    end_line: NonNegativeInt

    @model_validator(mode="after")
    def validate_span(self) -> PromptProposalChange:
        if self.end_line < self.start_line:
            raise ValueError("change span end_line must not precede start_line")
        return self


class PromptProposal(StrictModel):
    proposal_id: OpaqueId
    project_id: ProjectId
    stage_id: str
    kind: PromptProposalKind
    status: PromptProposalStatus
    target_layers: tuple[PromptLayer, ...]
    source: PromptProposalSource
    target_language: PromptLanguage | None = None
    improvement_instructions: PromptInstructions | None = None
    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    changes: tuple[PromptProposalChange, ...] = ()
    translated_template_body: PromptBody | None = None
    translated_project_override: PromptOverride | None = None
    failure_code: PromptProposalFailureCode | None = None
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None

    @model_validator(mode="after")
    def validate_layers(self) -> PromptProposal:
        if not self.target_layers:
            raise ValueError("a proposal must target at least one layer")
        if len(set(self.target_layers)) != len(self.target_layers):
            raise ValueError("a proposal must not target the same layer twice")
        if self.kind == "improve" and len(self.target_layers) != 1:
            raise ValueError("improve targets exactly one layer")
        if self.kind == "translate" and self.target_language is None:
            raise ValueError("translate requires a target language")
        if self.kind == "improve" and self.target_language is not None:
            raise ValueError("improve does not take a target language")
        if self.status == "failed" and self.failure_code is None:
            raise ValueError("a failed proposal requires a safe failure code")
        if self.status != "failed" and self.failure_code is not None:
            raise ValueError("only a failed proposal carries a failure code")
        return self


class CreatePromptProposalRequest(StrictModel):
    kind: PromptProposalKind
    stage_id: str
    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    target_layer: PromptLayer | None = None
    target_language: PromptLanguage | None = None
    improvement_instructions: PromptInstructions | None = None
    source_template_id: OpaqueId
    source_template_revision: PositiveInt
    source_binding_revision: PositiveInt

    @model_validator(mode="after")
    def validate_kind_fields(self) -> CreatePromptProposalRequest:
        if self.kind == "improve" and self.target_layer is None:
            raise ValueError("improve requires a target layer")
        if self.kind == "translate" and self.target_layer is not None:
            raise ValueError("translate targets the template plus a non-empty override")
        if self.kind == "translate" and self.target_language is None:
            raise ValueError("translate requires a target language")
        if self.kind == "improve" and self.target_language is not None:
            raise ValueError("improve does not take a target language")
        return self


class ApplyPromptProposalRequest(StrictModel):
    source_template_revision: PositiveInt
    source_binding_revision: PositiveInt
    change_ids: tuple[OpaqueId, ...] = ()

    @field_validator("change_ids", mode="before")
    @classmethod
    def _coerce_change_ids(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(value)
        return value


def _change(
    layer: PromptLayer, start: int, end: int, before_lines: list[str], after_lines: list[str]
) -> PromptProposalChange:
    before_text = "".join(before_lines)
    after_text = "".join(after_lines)
    digest = sha256(f"{layer}|{start}:{end}|{before_text}|{after_text}".encode()).hexdigest()
    return PromptProposalChange.model_validate(
        {
            "change_id": f"change_{digest[:24]}",
            "layer": layer,
            "before_text": before_text,
            "after_text": after_text,
            "start_line": start,
            "end_line": end,
        }
    )


def build_prompt_changes(
    layer: PromptLayer, before: str, after: str
) -> tuple[PromptProposalChange, ...]:
    """Derive deterministic, non-overlapping line hunks with stable IDs."""
    from difflib import SequenceMatcher

    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    matcher = SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
    return tuple(
        _change(layer, i1, i2, before_lines[i1:i2], after_lines[j1:j2])
        for opcode, i1, i2, j1, j2 in matcher.get_opcodes()
        if opcode != "equal"
    )


def apply_prompt_changes(
    before: str, changes: tuple[PromptProposalChange, ...], selected_ids: Sequence[str]
) -> str:
    """Reconstruct text from stored hunks only; never trust client replacement text."""
    if len(selected_ids) != len(set(selected_ids)):
        raise ValueError("duplicate change selection is not allowed")
    by_id = {change.change_id: change for change in changes}
    if set(selected_ids) - set(by_id):
        raise ValueError("unknown change selection")
    selected = sorted(
        (by_id[change_id] for change_id in selected_ids), key=lambda change: change.start_line
    )
    before_lines = before.splitlines(keepends=True)
    result_lines: list[str] = []
    cursor = 0
    for change in selected:
        if change.start_line < cursor:
            raise ValueError("overlapping change selection is not allowed")
        if change.end_line > len(before_lines):
            raise ValueError("change span exceeds the source text")
        result_lines.extend(before_lines[cursor : change.start_line])
        result_lines.append(change.after_text)
        cursor = change.end_line
    result_lines.extend(before_lines[cursor:])
    result = "".join(result_lines)
    if not result.strip():
        raise ValueError("the reconstructed prompt must not be blank")
    if len(result) > 12_000:
        raise ValueError("the reconstructed prompt exceeds the length limit")
    return result


class ProviderPromptRequest(StrictModel):
    """Worker-internal provider input; never crosses the activity boundary."""

    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    kind: PromptProposalKind
    text_by_layer: dict[PromptLayer, str]
    target_language: PromptLanguage | None = None
    improvement_instructions: PromptInstructions | None = None
    hidden_instruction: NonEmptyText


class ProviderPromptResult(StrictModel):
    text_by_layer: dict[PromptLayer, str]

    @field_validator("text_by_layer")
    @classmethod
    def validate_layers(cls, text_by_layer: dict[str, str]) -> dict[str, str]:
        if not text_by_layer:
            raise ValueError("provider result must contain at least one layer")
        for layer, text in text_by_layer.items():
            if layer not in ("template", "project_override"):
                raise ValueError("provider result layer is unsupported")
            if not text.strip():
                raise ValueError("provider result text must not be blank")
            if len(text) > 12_000:
                raise ValueError("provider result text exceeds the length limit")
        return text_by_layer


class PromptProposalWorkflowInput(StrictModel):
    """The only Temporal-history-facing workflow input; carries an ID alone."""

    proposal_id: OpaqueId


class PromptProposalActivityResult(StrictModel):
    """The only Temporal-history-facing result; carries safe status and code only."""

    proposal_id: OpaqueId
    status: Literal["succeeded", "failed"]
    failure_code: PromptProposalFailureCode | None = None

    @model_validator(mode="after")
    def validate_outcome(self) -> PromptProposalActivityResult:
        if (self.status == "failed") != (self.failure_code is not None):
            raise ValueError("failed results require a safe failure code")
        return self


PromptProposalWorkflowResult: TypeAlias = PromptProposalActivityResult


class PromptProposalPage(StrictModel):
    """Bounded newest-first history page with an opaque cursor."""

    proposals: tuple[PromptProposal, ...]
    next_cursor: str | None = None
