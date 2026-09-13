"""Typed outbound ports and safe errors for Prompt Lab AI proposals (C2)."""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, ConfigDict

from thoth_control_plane.domain.prompt_proposals import (
    ProjectPromptLayerLock,
    ProjectPromptModelPreference,
    PromptProposal,
    PromptProposalChange,
    PromptProposalPage,
    ProviderPromptRequest,
    ProviderPromptResult,
    SavePromptLayerLockRequest,
    SavePromptModelPreferenceRequest,
)


class PromptProposalApplyResult(BaseModel):
    """Immutable provenance for one explicit Apply action."""

    model_config = ConfigDict(extra="forbid", strict=True)

    proposal: PromptProposal
    resulting_template_id: str
    resulting_template_revision: int
    resulting_binding_revision: int


class PromptProposalStoreUnavailable(Exception):
    """The proposal store is unavailable without leaking connection details."""

    def __init__(self) -> None:
        super().__init__("prompt proposal store unavailable")


class PromptPreferenceRevisionConflict(Exception):
    """The preference changed after the caller's base revision."""

    def __init__(self, latest: ProjectPromptModelPreference) -> None:
        self.latest = latest
        super().__init__("prompt preference revision conflict")


class PromptLockRevisionConflict(Exception):
    """The layer lock changed after the caller's base revision."""

    def __init__(self, latest: ProjectPromptLayerLock) -> None:
        self.latest = latest
        super().__init__("prompt layer lock revision conflict")


class PromptIdempotencyConflict(Exception):
    """The idempotency key was replayed with a different payload."""

    def __init__(self, proposal_id: str) -> None:
        self.proposal_id = proposal_id
        super().__init__("prompt proposal idempotency conflict")


class PromptProposalActiveGeneration(Exception):
    """One queued or running proposal already exists for the project-stage."""

    def __init__(self, proposal_id: str) -> None:
        self.proposal_id = proposal_id
        super().__init__("prompt proposal already running")


class PromptProposalInvalidTransition(Exception):
    """The proposal lifecycle does not allow this transition."""

    def __init__(self) -> None:
        super().__init__("prompt proposal transition not allowed")


class PromptProposalNotFound(Exception):
    """The project-scoped proposal does not exist."""

    def __init__(self) -> None:
        super().__init__("prompt proposal not found")


class PromptProposalStale(Exception):
    """The proposal source revisions drifted before Apply."""

    def __init__(self) -> None:
        super().__init__("stale prompt proposal source")


class PromptProposalLayerLocked(Exception):
    """A targeted layer is locked against generation and application."""

    def __init__(self) -> None:
        super().__init__("prompt layer is locked")


class PromptProposalInvalidSelection(Exception):
    """The accepted change IDs are not all stored on the proposal."""

    def __init__(self) -> None:
        super().__init__("prompt proposal change selection is invalid")


class ProviderTimeout(Exception):
    """The provider request timed out."""

    def __init__(self) -> None:
        super().__init__("provider timeout")


class ProviderRateLimited(Exception):
    """The provider rate limit was hit."""

    def __init__(self) -> None:
        super().__init__("provider rate limited")


class ProviderUnavailable(Exception):
    """The provider is unreachable or returned an unusable response."""

    def __init__(self) -> None:
        super().__init__("provider unavailable")


class ProviderInvalidOutput(Exception):
    """The provider output failed strict validation."""

    def __init__(self) -> None:
        super().__init__("invalid provider output")


class PromptWorkflowUnavailable(Exception):
    """The workflow start boundary is unavailable."""

    def __init__(self) -> None:
        super().__init__("prompt proposal workflow unavailable")


class PromptProposalProvider(Protocol):
    """Worker-owned provider boundary; performs exactly one request."""

    async def propose(self, request: ProviderPromptRequest) -> ProviderPromptResult: ...


class PromptProposalWorkflowGateway(Protocol):
    """Starts an ID-only proposal workflow exactly once per reservation."""

    async def start(self, proposal_id: str) -> None: ...


class PromptProposalRepository(Protocol):
    """Durable project-scoped storage boundary for prompt proposals."""

    async def get_preference(
        self, project_id: str, stage_id: str
    ) -> ProjectPromptModelPreference | None: ...

    async def save_preference(
        self, project_id: str, stage_id: str, request: SavePromptModelPreferenceRequest
    ) -> ProjectPromptModelPreference: ...

    async def get_locks(
        self, project_id: str, stage_id: str
    ) -> tuple[ProjectPromptLayerLock, ...]: ...

    async def save_lock(
        self, project_id: str, stage_id: str, layer: str, request: SavePromptLayerLockRequest
    ) -> ProjectPromptLayerLock: ...

    async def reserve_proposal(
        self, proposal: PromptProposal, idempotency_key: str, payload_hash: str
    ) -> PromptProposal: ...

    async def get_proposal(self, project_id: str, proposal_id: str) -> PromptProposal | None: ...

    async def list_proposals(
        self, project_id: str, stage_id: str, cursor: str | None, limit: int
    ) -> PromptProposalPage: ...

    async def mark_running(self, proposal_id: str) -> PromptProposal: ...

    async def record_success(
        self, proposal_id: str, text_by_layer: dict[str, str]
    ) -> PromptProposal: ...

    async def record_failure(self, proposal_id: str, failure_code: str) -> PromptProposal: ...

    async def reject_proposal(self, project_id: str, proposal_id: str) -> PromptProposal: ...

    async def apply_improvement(
        self, project_id: str, proposal_id: str, change_ids: list[str], actor: str
    ) -> PromptProposalApplyResult: ...

    async def apply_translation(
        self, project_id: str, proposal_id: str, actor: str
    ) -> PromptProposalApplyResult: ...


__all__ = [
    "PromptIdempotencyConflict",
    "PromptLockRevisionConflict",
    "PromptPreferenceRevisionConflict",
    "PromptProposalActiveGeneration",
    "PromptProposalApplyResult",
    "PromptProposalChange",
    "PromptProposalInvalidSelection",
    "PromptProposalInvalidTransition",
    "PromptProposalLayerLocked",
    "PromptProposalNotFound",
    "PromptProposalProvider",
    "PromptProposalRepository",
    "PromptProposalStale",
    "PromptProposalStoreUnavailable",
    "PromptProposalWorkflowGateway",
    "PromptWorkflowUnavailable",
    "ProviderInvalidOutput",
    "ProviderRateLimited",
    "ProviderTimeout",
    "ProviderUnavailable",
]
