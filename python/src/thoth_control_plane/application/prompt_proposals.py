"""C2 Prompt Proposal application service: validation, lifecycle, and Apply."""

from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256

from thoth_control_plane.application.ports import (
    PromptBindingNotFound,
    PromptLabRepository,
    PromptTemplateNotFound,
)
from thoth_control_plane.application.prompt_lab import (
    PromptLabStoreUnavailable,
    PromptStageNotRegistered,
)
from thoth_control_plane.application.prompt_proposal_ports import (
    PromptIdempotencyConflict,
    PromptLockRevisionConflict,
    PromptModelNotInCatalog,
    PromptPreferenceRevisionConflict,
    PromptProposalActiveGeneration,
    PromptProposalApplyResult,
    PromptProposalEmptyLayer,
    PromptProposalInvalidSelection,
    PromptProposalInvalidTransition,
    PromptProposalLayerLocked,
    PromptProposalNotFound,
    PromptProposalRepository,
    PromptProposalStale,
    PromptProposalStoreUnavailable,
    PromptProposalWorkflowGateway,
    PromptWorkflowUnavailable,
)
from thoth_control_plane.domain.prompt_proposals import (
    ApplyPromptProposalRequest,
    CreatePromptProposalRequest,
    ProjectPromptLayerLock,
    ProjectPromptModelPreference,
    PromptProposal,
    PromptProposalPage,
    PromptProviderDefinition,
    SavePromptLayerLockRequest,
    SavePromptModelPreferenceRequest,
)
from thoth_control_plane.domain.prompts import (
    PROMPT_STAGES,
    PROMPT_STARTERS,
    PromptStarterDefinition,
)

PASSTHROUGH_REPO_ERRORS = (
    PromptIdempotencyConflict,
    PromptLockRevisionConflict,
    PromptPreferenceRevisionConflict,
    PromptProposalActiveGeneration,
    PromptProposalStale,
    PromptProposalLayerLocked,
    PromptProposalInvalidSelection,
    PromptProposalInvalidTransition,
    PromptProposalNotFound,
    PromptModelNotInCatalog,
    PromptProposalEmptyLayer,
)


def _stage_ids() -> frozenset[str]:
    return frozenset(stage.stage_id for stage in PROMPT_STAGES)


class PromptProposalService:
    """Orchestrates durable AI prompt proposals for the three C2 stages."""

    def __init__(
        self,
        *,
        prompt_repository: PromptLabRepository | None,
        proposal_repository: PromptProposalRepository | None,
        catalog: tuple[PromptProviderDefinition, ...] = (),
        gateway: PromptProposalWorkflowGateway | None = None,
    ) -> None:
        self._prompt_repository = prompt_repository
        self._proposal_repository = proposal_repository
        self._catalog = catalog
        self._gateway = gateway

    def list_providers(self) -> tuple[PromptProviderDefinition, ...]:
        """Return only enabled providers from the server-owned catalog."""
        return tuple(provider for provider in self._catalog if provider.enabled)

    def get_starter(self, stage_id: str) -> PromptStarterDefinition | None:
        self._require_stage(stage_id)
        return PROMPT_STARTERS.get(stage_id)  # type: ignore[return-value]

    def _require_stage(self, stage_id: str) -> None:
        if stage_id not in _stage_ids():
            raise PromptStageNotRegistered()

    def _require_repository(self) -> PromptProposalRepository:
        if self._proposal_repository is None:
            raise PromptProposalStoreUnavailable()
        return self._proposal_repository

    def _require_prompt_repository(self) -> PromptLabRepository:
        if self._prompt_repository is None:
            raise PromptLabStoreUnavailable()
        return self._prompt_repository

    def _require_catalog_model(
        self, provider_id: str, model_id: str, kind: str
    ) -> tuple[PromptProviderDefinition, object]:
        for provider in self._catalog:
            if provider.provider_id != provider_id or not provider.enabled:
                continue
            for model in provider.models:
                if model.model_id == model_id and kind in model.capabilities:
                    return provider, model
        raise PromptModelNotInCatalog()

    def _require_catalog_model_any(
        self, provider_id: str, model_id: str
    ) -> tuple[PromptProviderDefinition, object]:
        """Accept any enabled catalog model that supports at least one capability.

        Each Generate action validates its own required capability separately
        via `_require_catalog_model`; saving a preference only needs the model
        to exist and be usable for something.
        """
        for provider in self._catalog:
            if provider.provider_id != provider_id or not provider.enabled:
                continue
            for model in provider.models:
                if model.model_id == model_id and model.capabilities:
                    return provider, model
        raise PromptModelNotInCatalog()

    async def get_preference(
        self, project_id: str, stage_id: str
    ) -> ProjectPromptModelPreference | None:
        self._require_stage(stage_id)
        try:
            return await self._require_repository().get_preference(project_id, stage_id)
        except PASSTHROUGH_REPO_ERRORS:
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def save_preference(
        self,
        project_id: str,
        stage_id: str,
        request: SavePromptModelPreferenceRequest,
    ) -> ProjectPromptModelPreference:
        self._require_stage(stage_id)
        self._require_catalog_model_any(request.provider_id, request.model_id)
        try:
            return await self._require_repository().save_preference(project_id, stage_id, request)
        except PASSTHROUGH_REPO_ERRORS:
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def get_locks(self, project_id: str, stage_id: str) -> tuple[ProjectPromptLayerLock, ...]:
        self._require_stage(stage_id)
        try:
            return await self._require_repository().get_locks(project_id, stage_id)
        except PASSTHROUGH_REPO_ERRORS:
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def save_lock(
        self, project_id: str, stage_id: str, layer: str, request: SavePromptLayerLockRequest
    ) -> ProjectPromptLayerLock:
        self._require_stage(stage_id)
        try:
            return await self._require_repository().save_lock(project_id, stage_id, layer, request)
        except PASSTHROUGH_REPO_ERRORS:
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def create_proposal(
        self,
        project_id: str,
        request: CreatePromptProposalRequest,
        actor: str,
        idempotency_key: str,
    ) -> PromptProposal:
        self._require_stage(request.stage_id)
        _, model = self._require_catalog_model(request.provider_id, request.model_id, request.kind)
        template = await self._load_template(
            project_id, request.source_template_id, request.source_template_revision
        )
        binding = await self._load_binding(project_id, request.stage_id)
        if (
            binding.template_id != request.source_template_id
            or binding.template_revision != request.source_template_revision
            or binding.revision != request.source_binding_revision
        ):
            raise PromptProposalStale()
        locks = await self.get_locks(project_id, request.stage_id)
        if request.kind == "improve":
            if request.target_layer is None:
                raise PromptProposalInvalidSelection()
            self._require_unlocked(locks, request.target_layer)
            target_layers = (request.target_layer,)
            layer_text = self._saved_layer_text(binding, template, request.target_layer)
            if layer_text is None or not layer_text.strip():
                raise PromptProposalEmptyLayer()
            input_chars = len(layer_text)
        else:
            override_text = binding.project_override
            has_override = override_text is not None and override_text.strip() != ""
            self._require_unlocked(locks, "template")
            if has_override:
                self._require_unlocked(locks, "project_override")
            target_layers = ("template", "project_override") if has_override else ("template",)
            input_chars = len(template.body) + len(override_text or "")
        if input_chars > model.max_input_chars:
            raise PromptModelNotInCatalog()

        proposal = PromptProposal.model_validate(
            {
                "proposal_id": self._proposal_id(project_id, idempotency_key),
                "project_id": project_id,
                "stage_id": request.stage_id,
                "kind": request.kind,
                "status": "queued",
                "target_layers": target_layers,
                "source": {
                    "template_id": template.template_id,
                    "template_revision": template.revision,
                    "binding_revision": binding.revision,
                    "template_language": template.language,
                    "template_body": template.body,
                    "project_override": binding.project_override,
                },
                "target_language": request.target_language,
                "improvement_instructions": request.improvement_instructions,
                "provider_id": request.provider_id,
                "model_id": request.model_id,
                "created_at": datetime.now(UTC),
            }
        )
        payload_hash = sha256(request.model_dump_json().encode("utf-8")).hexdigest()
        try:
            reserved = await self._require_repository().reserve_proposal(
                proposal, idempotency_key, payload_hash
            )
        except PASSTHROUGH_REPO_ERRORS:
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error
        try:
            if self._gateway is None:
                raise PromptWorkflowUnavailable()
            await self._gateway.start(reserved.proposal_id)
        except PromptWorkflowUnavailable:
            await self._record_workflow_failure(reserved.proposal_id)
            raise
        except Exception as error:
            await self._record_workflow_failure(reserved.proposal_id)
            raise PromptWorkflowUnavailable() from error
        return reserved

    async def list_proposals(
        self, project_id: str, stage_id: str, cursor: str | None, limit: int
    ) -> PromptProposalPage:
        self._require_stage(stage_id)
        try:
            return await self._require_repository().list_proposals(
                project_id, stage_id, cursor, limit
            )
        except PASSTHROUGH_REPO_ERRORS:
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def get_proposal(self, project_id: str, proposal_id: str) -> PromptProposal:
        try:
            proposal = await self._require_repository().get_proposal(project_id, proposal_id)
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error
        if proposal is None:
            raise PromptProposalNotFound()
        return proposal

    async def apply(
        self,
        project_id: str,
        proposal_id: str,
        request: ApplyPromptProposalRequest,
        actor: str,
    ) -> PromptProposalApplyResult:
        proposal = await self.get_proposal(project_id, proposal_id)
        if proposal.status != "succeeded":
            raise PromptProposalInvalidTransition()
        if (
            request.source_template_revision != proposal.source.template_revision
            or request.source_binding_revision != proposal.source.binding_revision
        ):
            raise PromptProposalStale()
        locks = await self.get_locks(project_id, proposal.stage_id)
        for layer in proposal.target_layers:
            self._require_unlocked(locks, layer)
        if proposal.kind == "improve":
            stored_ids = {change.change_id for change in proposal.changes}
            if not request.change_ids or set(request.change_ids) - stored_ids:
                raise PromptProposalInvalidSelection()
            try:
                return await self._require_repository().apply_improvement(
                    project_id, proposal_id, list(request.change_ids), actor
                )
            except PASSTHROUGH_REPO_ERRORS:
                raise
            except PromptProposalStoreUnavailable:
                raise
            except Exception as error:
                raise PromptProposalStoreUnavailable() from error
        try:
            return await self._require_repository().apply_translation(
                project_id, proposal_id, actor
            )
        except PASSTHROUGH_REPO_ERRORS:
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def reject(self, project_id: str, proposal_id: str, actor: str) -> PromptProposal:
        try:
            return await self._require_repository().reject_proposal(project_id, proposal_id)
        except (PromptProposalNotFound, PromptProposalInvalidTransition):
            raise
        except PromptProposalStoreUnavailable:
            raise
        except Exception as error:
            raise PromptProposalStoreUnavailable() from error

    async def _record_workflow_failure(self, proposal_id: str) -> None:
        try:
            await self._require_repository().record_failure(proposal_id, "workflow_unavailable")
        except Exception:
            return

    async def _load_template(self, project_id: str, template_id: str, revision: int):
        template = await self._require_prompt_repository().get_template_revision(
            project_id=project_id, template_id=template_id, revision=revision
        )
        if template is None:
            raise PromptTemplateNotFound()
        return template

    async def _load_binding(self, project_id: str, stage_id: str):
        binding = await self._require_prompt_repository().get_binding(
            project_id=project_id, stage_id=stage_id
        )
        if binding is None:
            raise PromptBindingNotFound()
        return binding

    @staticmethod
    def _require_unlocked(locks: tuple[ProjectPromptLayerLock, ...], layer: str) -> None:
        for lock in locks:
            if lock.layer == layer and lock.locked:
                raise PromptProposalLayerLocked()

    @staticmethod
    def _saved_layer_text(binding, template, layer: str) -> str | None:
        if layer == "template":
            return template.body
        return binding.project_override

    @staticmethod
    def _proposal_id(project_id: str, idempotency_key: str) -> str:
        digest = sha256(f"{project_id}|{idempotency_key}".encode()).hexdigest()
        return f"prop_{digest[:24]}"
