"""Application-service tests for Prompt Lab AI proposal use cases (C2)."""

from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256

import pytest

from tests.application.test_prompt_lab import MemoryPromptLabRepository
from thoth_control_plane.application.prompt_proposal_ports import (
    ProjectPromptLayerLock,
    ProjectPromptModelPreference,
    PromptIdempotencyConflict,
    PromptModelNotInCatalog,
    PromptProposalActiveGeneration,
    PromptProposalApplyResult,
    PromptProposalEmptyLayer,
    PromptProposalInvalidSelection,
    PromptProposalLayerLocked,
    PromptProposalNotFound,
    PromptProposalStale,
    PromptProposalStoreUnavailable,
    PromptWorkflowUnavailable,
)
from thoth_control_plane.application.prompt_proposals import PromptProposalService
from thoth_control_plane.domain.prompt_proposals import (
    ApplyPromptProposalRequest,
    CreatePromptProposalRequest,
    PromptProposal,
    PromptProposalPage,
    PromptProviderDefinition,
    SavePromptLayerLockRequest,
    SavePromptModelPreferenceRequest,
    build_prompt_changes,
)
from thoth_control_plane.domain.prompts import SaveProjectPromptBindingRequest

NOW = datetime(2026, 9, 13, 9, tzinfo=UTC)

PROVIDER = {
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
DISABLED_PROVIDER = {
    "provider_id": "secret-provider",
    "label": "Secret",
    "enabled": False,
    "models": [PROVIDER["models"][0]],
}

ACTOR = "actor_owner"


class MemoryProposalRepository:
    """In-memory repository seam matching the PostgreSQL service contract."""

    def __init__(self, *, locked_layers: set[str] | None = None) -> None:
        self.locked_layers = locked_layers or set()
        self.proposals: dict[tuple[str, str], PromptProposal] = {}
        self.reserved: list[tuple[PromptProposal, str, str]] = []
        self.apply_calls: list[tuple[str, str, list[str] | None, str]] = []
        self.failures: list[str] = []
        self.preferences: dict[tuple[str, str], ProjectPromptModelPreference] = {}
        self.locks: dict[tuple[str, str, str], ProjectPromptLayerLock] = {}
        self.fail_reserve: Exception | None = None

    async def get_preference(
        self, project_id: str, stage_id: str
    ) -> ProjectPromptModelPreference | None:
        return self.preferences.get((project_id, stage_id))

    async def save_preference(
        self, project_id: str, stage_id: str, request: SavePromptModelPreferenceRequest
    ) -> ProjectPromptModelPreference:
        key = (project_id, stage_id)
        previous = self.preferences.get(key)
        preference = ProjectPromptModelPreference.model_validate(
            {
                "project_id": project_id,
                "stage_id": stage_id,
                "provider_id": request.provider_id,
                "model_id": request.model_id,
                "revision": (previous.revision + 1) if previous else 1,
                "updated_at": NOW.isoformat(),
            }
        )
        self.preferences[key] = preference
        return preference

    async def get_locks(self, project_id: str, stage_id: str) -> tuple[ProjectPromptLayerLock, ...]:
        return tuple(
            ProjectPromptLayerLock.model_validate(
                {
                    "project_id": project_id,
                    "stage_id": stage_id,
                    "layer": layer,
                    "locked": layer in self.locked_layers,
                    "revision": 1,
                    "updated_at": NOW.isoformat(),
                }
            )
            for layer in ("template", "project_override")
        )

    async def save_lock(
        self, project_id: str, stage_id: str, layer: str, request: SavePromptLayerLockRequest
    ) -> ProjectPromptLayerLock:
        key = (project_id, stage_id, layer)
        previous = self.locks.get(key)
        lock = ProjectPromptLayerLock.model_validate(
            {
                "project_id": project_id,
                "stage_id": stage_id,
                "layer": layer,
                "locked": request.locked,
                "revision": (previous.revision + 1) if previous else 1,
                "updated_at": NOW.isoformat(),
            }
        )
        self.locks[key] = lock
        return lock

    async def reserve_proposal(
        self, proposal: PromptProposal, idempotency_key: str, payload_hash: str
    ) -> PromptProposal:
        if self.fail_reserve:
            raise self.fail_reserve
        stored = proposal.model_copy(update={"created_at": NOW.isoformat()})
        self.reserved.append((stored, idempotency_key, payload_hash))
        self.proposals[(proposal.project_id, proposal.proposal_id)] = stored
        return stored

    async def get_proposal(self, project_id: str, proposal_id: str) -> PromptProposal | None:
        return self.proposals.get((project_id, proposal_id))

    async def list_proposals(
        self, project_id: str, stage_id: str, cursor: str | None, limit: int
    ) -> PromptProposalPage:
        return PromptProposalPage.model_validate({"proposals": [], "next_cursor": None})

    async def mark_running(self, proposal_id: str) -> PromptProposal:
        return self._patch(proposal_id, status="running")

    async def record_success(
        self, proposal_id: str, text_by_layer: dict[str, str]
    ) -> PromptProposal:
        return self._patch(proposal_id, status="succeeded")

    async def record_failure(self, proposal_id: str, failure_code: str) -> PromptProposal:
        self.failures.append(failure_code)
        return self._patch(proposal_id, status="failed", failure_code=failure_code)

    async def reject_proposal(self, project_id: str, proposal_id: str) -> PromptProposal:
        if (project_id, proposal_id) not in self.proposals:
            raise PromptProposalNotFound()
        return self._patch(proposal_id, status="rejected")

    async def apply_improvement(
        self, project_id: str, proposal_id: str, change_ids: list[str], actor: str
    ) -> PromptProposalApplyResult:
        self.apply_calls.append((project_id, proposal_id, change_ids, actor))
        applied = self._patch(proposal_id, status="applied")
        return PromptProposalApplyResult.model_validate(
            {
                "proposal": applied.model_dump(mode="json"),
                "resulting_template_id": applied.source.template_id,
                "resulting_template_revision": applied.source.template_revision + 1,
                "resulting_binding_revision": applied.source.binding_revision + 1,
            }
        )

    async def apply_translation(
        self, project_id: str, proposal_id: str, actor: str
    ) -> PromptProposalApplyResult:
        self.apply_calls.append((project_id, proposal_id, None, actor))
        applied = self._patch(proposal_id, status="applied")
        return PromptProposalApplyResult.model_validate(
            {
                "proposal": applied.model_dump(mode="json"),
                "resulting_template_id": "ptpl_translated",
                "resulting_template_revision": 1,
                "resulting_binding_revision": applied.source.binding_revision + 1,
            }
        )

    def _patch(self, proposal_id: str, **updates: object) -> PromptProposal:
        key = ("project_a", proposal_id)
        if key not in self.proposals:
            raise PromptProposalNotFound()
        updated = self.proposals[key].model_copy(update=updates)
        self.proposals[key] = updated
        return updated


class RecordingGateway:
    """Models Temporal semantics: starting an already-started workflow is success."""

    def __init__(self) -> None:
        self.started: list[str] = []

    async def start(self, proposal_id: str) -> None:
        if proposal_id not in self.started:
            self.started.append(proposal_id)


class FailingGateway(RecordingGateway):
    async def start(self, proposal_id: str) -> None:
        raise RuntimeError("temporal unreachable")


def catalog() -> tuple[PromptProviderDefinition, ...]:
    return (
        PromptProviderDefinition.model_validate(PROVIDER),
        PromptProviderDefinition.model_validate(DISABLED_PROVIDER),
    )


async def seeded_service(
    service_fixture_override: dict | None = None,
) -> tuple[PromptProposalService, MemoryProposalRepository, RecordingGateway, str]:
    prompt_repo = MemoryPromptLabRepository()
    template = await prompt_repo.save_template(
        project_id="project_a",
        template_id="ptpl_seed",
        base_revision=None,
        stage_id="narrative_plan",
        language="id-ID",
        body="Write a hook\nContext",
    )
    await prompt_repo.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {
                "template_id": template.template_id,
                "template_revision": 1,
                "project_override": "Use Indonesian",
            }
        ),
    )
    proposal_repo = MemoryProposalRepository()
    gateway = RecordingGateway()
    service = PromptProposalService(
        prompt_repository=prompt_repo,
        proposal_repository=proposal_repo,
        catalog=catalog(),
        gateway=gateway,
    )
    return service, proposal_repo, gateway, template.template_id


def succeeded_with_changes(created: PromptProposal) -> PromptProposal:
    changes = build_prompt_changes("template", "Write a hook\nContext", "Improved hook\nContext")
    return created.model_copy(update={"status": "succeeded", "changes": changes})


def create_improvement(template_id: str) -> dict:
    return {
        "kind": "improve",
        "stage_id": "narrative_plan",
        "provider_id": "novita",
        "model_id": "deepseek/deepseek-v3.1",
        "target_layer": "template",
        "source_template_id": template_id,
        "source_template_revision": 1,
        "source_binding_revision": 1,
    }


def create_translate(template_id: str) -> dict:
    return {
        "kind": "translate",
        "stage_id": "narrative_plan",
        "provider_id": "novita",
        "model_id": "deepseek/deepseek-v3.1",
        "target_language": "en-US",
        "source_template_id": template_id,
        "source_template_revision": 1,
        "source_binding_revision": 1,
    }


@pytest.mark.asyncio
async def test_create_requires_saved_clean_source_and_starts_one_id_only_workflow() -> None:
    service, proposal_repo, gateway, template_id = await seeded_service()

    created = await service.create_proposal(
        "project_a",
        CreatePromptProposalRequest.model_validate(create_improvement(template_id)),
        ACTOR,
        "request-1",
    )

    assert created.status == "queued"
    assert len(gateway.started) == 1
    assert gateway.started == [created.proposal_id]
    assert len(proposal_repo.reserved) == 1
    reserved, key, payload_hash = proposal_repo.reserved[0]
    assert key == "request-1"
    assert (
        payload_hash
        == sha256(
            CreatePromptProposalRequest.model_validate(create_improvement(template_id))
            .model_dump_json()
            .encode()
        ).hexdigest()
    )
    assert reserved.source.template_body == "Write a hook\nContext"
    assert reserved.source.project_override == "Use Indonesian"


@pytest.mark.asyncio
async def test_create_supports_all_three_stages() -> None:
    for stage_id in ("narrative_plan", "visual_plan", "caption_copy"):
        prompt_repo = MemoryPromptLabRepository()
        template = await prompt_repo.save_template(
            project_id="project_a",
            template_id=f"ptpl_seed_{stage_id}",
            base_revision=None,
            stage_id=stage_id,
            language="id-ID",
            body="Stage text",
        )
        await prompt_repo.save_binding(
            project_id="project_a",
            stage_id=stage_id,
            request=SaveProjectPromptBindingRequest.model_validate(
                {
                    "template_id": template.template_id,
                    "template_revision": 1,
                    "project_override": None,
                }
            ),
        )
        service = PromptProposalService(
            prompt_repository=prompt_repo,
            proposal_repository=MemoryProposalRepository(),
            catalog=catalog(),
            gateway=RecordingGateway(),
        )
        request = CreatePromptProposalRequest.model_validate(
            {
                "kind": "improve",
                "stage_id": stage_id,
                "provider_id": "novita",
                "model_id": "deepseek/deepseek-v3.1",
                "target_layer": "template",
                "source_template_id": template.template_id,
                "source_template_revision": 1,
                "source_binding_revision": 1,
            }
        )
        created = await service.create_proposal("project_a", request, ACTOR, f"key-{stage_id}")
        assert created.stage_id == stage_id


@pytest.mark.asyncio
async def test_create_rejects_provider_or_model_not_in_enabled_catalog() -> None:
    service, _, gateway, template_id = await seeded_service()

    with pytest.raises(PromptModelNotInCatalog):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(
                {**create_improvement(template_id), "provider_id": "secret-provider"}
            ),
            ACTOR,
            "request-1",
        )
    with pytest.raises(PromptModelNotInCatalog):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(
                {**create_improvement(template_id), "model_id": "unknown/model"}
            ),
            ACTOR,
            "request-2",
        )
    assert gateway.started == []


@pytest.mark.asyncio
async def test_create_rejects_stale_source_revisions() -> None:
    service, _, _, template_id = await seeded_service()

    with pytest.raises(PromptProposalStale):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(
                {**create_improvement(template_id), "source_binding_revision": 9}
            ),
            ACTOR,
            "request-1",
        )


@pytest.mark.asyncio
async def test_create_rejects_locked_target_layer() -> None:
    prompt_repo = MemoryPromptLabRepository()
    template = await prompt_repo.save_template(
        project_id="project_a",
        template_id="ptpl_seed",
        base_revision=None,
        stage_id="narrative_plan",
        language="id-ID",
        body="Write a hook\nContext",
    )
    await prompt_repo.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {
                "template_id": template.template_id,
                "template_revision": 1,
                "project_override": "Use Indonesian",
            }
        ),
    )
    proposal_repo = MemoryProposalRepository(locked_layers={"template"})
    service = PromptProposalService(
        prompt_repository=prompt_repo,
        proposal_repository=proposal_repo,
        catalog=catalog(),
        gateway=RecordingGateway(),
    )

    with pytest.raises(PromptProposalLayerLocked):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(create_improvement(template.template_id)),
            ACTOR,
            "request-1",
        )


@pytest.mark.asyncio
async def test_create_rejects_empty_improve_override() -> None:
    prompt_repo = MemoryPromptLabRepository()
    template = await prompt_repo.save_template(
        project_id="project_a",
        template_id="ptpl_seed",
        base_revision=None,
        stage_id="narrative_plan",
        language="id-ID",
        body="Write a hook\nContext",
    )
    await prompt_repo.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {"template_id": template.template_id, "template_revision": 1, "project_override": None}
        ),
    )
    service = PromptProposalService(
        prompt_repository=prompt_repo,
        proposal_repository=MemoryProposalRepository(),
        catalog=catalog(),
        gateway=RecordingGateway(),
    )

    with pytest.raises(PromptProposalEmptyLayer):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(
                {**create_improvement(template.template_id), "target_layer": "project_override"}
            ),
            ACTOR,
            "request-1",
        )


@pytest.mark.asyncio
async def test_idempotency_replay_returns_original_proposal() -> None:
    service, proposal_repo, gateway, template_id = await seeded_service()
    request = CreatePromptProposalRequest.model_validate(create_improvement(template_id))

    first = await service.create_proposal("project_a", request, ACTOR, "request-1")
    replayed = await service.create_proposal("project_a", request, ACTOR, "request-1")

    assert replayed == first
    assert len(gateway.started) == 1
    assert len(proposal_repo.reserved) == 2


@pytest.mark.asyncio
async def test_idempotency_key_with_different_payload_conflicts() -> None:
    service, _, gateway, template_id = await seeded_service()
    request = CreatePromptProposalRequest.model_validate(create_improvement(template_id))
    await service.create_proposal("project_a", request, ACTOR, "request-1")

    proposal_repo = service._proposal_repository
    assert isinstance(proposal_repo, MemoryProposalRepository)
    proposal_repo.fail_reserve = PromptIdempotencyConflict("proposal_1")

    with pytest.raises(PromptIdempotencyConflict):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(
                {**create_improvement(template_id), "target_layer": "project_override"}
            ),
            ACTOR,
            "request-1",
        )
    assert len(gateway.started) == 1


@pytest.mark.asyncio
async def test_create_active_generation_conflict() -> None:
    service, proposal_repo, _, template_id = await seeded_service()
    request = CreatePromptProposalRequest.model_validate(create_improvement(template_id))
    await service.create_proposal("project_a", request, ACTOR, "request-1")
    proposal_repo.fail_reserve = PromptProposalActiveGeneration("proposal_1")

    with pytest.raises(PromptProposalActiveGeneration):
        await service.create_proposal("project_a", request, ACTOR, "request-2")


@pytest.mark.asyncio
async def test_create_workflow_failure_records_safe_failure_code() -> None:
    prompt_repo = MemoryPromptLabRepository()
    template = await prompt_repo.save_template(
        project_id="project_a",
        template_id="ptpl_seed",
        base_revision=None,
        stage_id="narrative_plan",
        language="id-ID",
        body="Write a hook\nContext",
    )
    await prompt_repo.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {"template_id": template.template_id, "template_revision": 1, "project_override": None}
        ),
    )
    proposal_repo = MemoryProposalRepository()
    service = PromptProposalService(
        prompt_repository=prompt_repo,
        proposal_repository=proposal_repo,
        catalog=catalog(),
        gateway=FailingGateway(),
    )

    with pytest.raises(PromptWorkflowUnavailable):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(create_improvement(template.template_id)),
            ACTOR,
            "request-1",
        )

    assert proposal_repo.failures == ["workflow_unavailable"]


@pytest.mark.asyncio
async def test_store_failure_maps_to_safe_unavailable() -> None:
    prompt_repo = MemoryPromptLabRepository()
    template = await prompt_repo.save_template(
        project_id="project_a",
        template_id="ptpl_seed",
        base_revision=None,
        stage_id="narrative_plan",
        language="id-ID",
        body="Write a hook\nContext",
    )
    await prompt_repo.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {"template_id": template.template_id, "template_revision": 1, "project_override": None}
        ),
    )
    proposal_repo = MemoryProposalRepository()
    proposal_repo.fail_reserve = PromptProposalStoreUnavailable()
    service = PromptProposalService(
        prompt_repository=prompt_repo,
        proposal_repository=proposal_repo,
        catalog=catalog(),
        gateway=RecordingGateway(),
    )

    with pytest.raises(PromptProposalStoreUnavailable):
        await service.create_proposal(
            "project_a",
            CreatePromptProposalRequest.model_validate(create_improvement(template.template_id)),
            ACTOR,
            "request-1",
        )


@pytest.mark.asyncio
async def test_apply_rejects_source_revision_drift_before_repository_write() -> None:
    service, proposal_repo, _, template_id = await seeded_service()
    created = await service.create_proposal(
        "project_a",
        CreatePromptProposalRequest.model_validate(create_improvement(template_id)),
        ACTOR,
        "request-1",
    )
    succeeded = created.model_copy(update={"status": "succeeded"})
    proposal_repo.proposals[("project_a", created.proposal_id)] = succeeded

    with pytest.raises(PromptProposalStale):
        await service.apply(
            "project_a",
            created.proposal_id,
            ApplyPromptProposalRequest.model_validate(
                {
                    "source_template_revision": 1,
                    "source_binding_revision": 7,
                    "change_ids": ["change_abc"],
                }
            ),
            actor=ACTOR,
        )

    assert proposal_repo.apply_calls == []


@pytest.mark.asyncio
async def test_apply_improvement_requires_selected_changes() -> None:
    service, proposal_repo, _, template_id = await seeded_service()
    created = await service.create_proposal(
        "project_a",
        CreatePromptProposalRequest.model_validate(create_improvement(template_id)),
        ACTOR,
        "request-1",
    )
    succeeded = created.model_copy(update={"status": "succeeded"})
    proposal_repo.proposals[("project_a", created.proposal_id)] = succeeded

    with pytest.raises(PromptProposalInvalidSelection):
        await service.apply(
            "project_a",
            created.proposal_id,
            ApplyPromptProposalRequest.model_validate(
                {
                    "source_template_revision": 1,
                    "source_binding_revision": 1,
                    "change_ids": [],
                }
            ),
            actor=ACTOR,
        )

    assert proposal_repo.apply_calls == []


@pytest.mark.asyncio
async def test_apply_improvement_passes_only_change_ids() -> None:
    service, proposal_repo, _, template_id = await seeded_service()
    created = await service.create_proposal(
        "project_a",
        CreatePromptProposalRequest.model_validate(create_improvement(template_id)),
        ACTOR,
        "request-1",
    )
    succeeded = succeeded_with_changes(created)
    proposal_repo.proposals[("project_a", created.proposal_id)] = succeeded
    stored_id = succeeded.changes[0].change_id

    await service.apply(
        "project_a",
        created.proposal_id,
        ApplyPromptProposalRequest.model_validate(
            {
                "source_template_revision": 1,
                "source_binding_revision": 1,
                "change_ids": [stored_id],
            }
        ),
        actor=ACTOR,
    )

    assert proposal_repo.apply_calls == [("project_a", created.proposal_id, [stored_id], ACTOR)]


@pytest.mark.asyncio
async def test_apply_translate_applies_whole_proposal() -> None:
    service, proposal_repo, _, template_id = await seeded_service()
    created = await service.create_proposal(
        "project_a",
        CreatePromptProposalRequest.model_validate(create_translate(template_id)),
        ACTOR,
        "request-1",
    )
    succeeded = created.model_copy(update={"status": "succeeded"})
    proposal_repo.proposals[("project_a", created.proposal_id)] = succeeded

    await service.apply(
        "project_a",
        created.proposal_id,
        ApplyPromptProposalRequest.model_validate(
            {"source_template_revision": 1, "source_binding_revision": 1}
        ),
        actor=ACTOR,
    )

    assert proposal_repo.apply_calls == [("project_a", created.proposal_id, None, ACTOR)]


@pytest.mark.asyncio
async def test_apply_locked_layer_fails_closed() -> None:
    prompt_repo = MemoryPromptLabRepository()
    template = await prompt_repo.save_template(
        project_id="project_a",
        template_id="ptpl_seed",
        base_revision=None,
        stage_id="narrative_plan",
        language="id-ID",
        body="Write a hook\nContext",
    )
    await prompt_repo.save_binding(
        project_id="project_a",
        stage_id="narrative_plan",
        request=SaveProjectPromptBindingRequest.model_validate(
            {
                "template_id": template.template_id,
                "template_revision": 1,
                "project_override": "Use Indonesian",
            }
        ),
    )
    proposal_repo = MemoryProposalRepository()
    service = PromptProposalService(
        prompt_repository=prompt_repo,
        proposal_repository=proposal_repo,
        catalog=catalog(),
        gateway=RecordingGateway(),
    )
    created = await service.create_proposal(
        "project_a",
        CreatePromptProposalRequest.model_validate(
            {**create_improvement(template.template_id), "target_layer": "project_override"}
        ),
        ACTOR,
        "request-1",
    )
    proposal_repo.locked_layers = {"project_override"}
    succeeded = created.model_copy(update={"status": "succeeded"})
    proposal_repo.proposals[("project_a", created.proposal_id)] = succeeded

    with pytest.raises(PromptProposalLayerLocked):
        await service.apply(
            "project_a",
            created.proposal_id,
            ApplyPromptProposalRequest.model_validate(
                {
                    "source_template_revision": 1,
                    "source_binding_revision": 1,
                    "change_ids": ["change_abc"],
                }
            ),
            actor=ACTOR,
        )

    assert proposal_repo.apply_calls == []


@pytest.mark.asyncio
async def test_reject_requires_a_known_proposal() -> None:
    service, proposal_repo, _, template_id = await seeded_service()
    created = await service.create_proposal(
        "project_a",
        CreatePromptProposalRequest.model_validate(create_improvement(template_id)),
        ACTOR,
        "request-1",
    )
    succeeded = created.model_copy(update={"status": "succeeded"})
    proposal_repo.proposals[("project_a", created.proposal_id)] = succeeded

    rejected = await service.reject("project_a", created.proposal_id, ACTOR)
    assert rejected.status == "rejected"

    with pytest.raises(PromptProposalNotFound):
        await service.reject("project_a", "proposal_missing", ACTOR)


@pytest.mark.asyncio
async def test_regenerate_is_a_new_explicit_proposal() -> None:
    service, _repo, gateway, template_id = await seeded_service()
    request = CreatePromptProposalRequest.model_validate(create_improvement(template_id))

    first = await service.create_proposal("project_a", request, ACTOR, "request-1")
    second = await service.create_proposal("project_a", request, ACTOR, "request-2")

    assert first.proposal_id != second.proposal_id
    assert gateway.started == [first.proposal_id, second.proposal_id]


@pytest.mark.asyncio
async def test_preference_and_lock_use_cases_validate_stage_and_catalog() -> None:
    service, _, _, _ = await seeded_service()

    saved = await service.save_preference(
        "project_a",
        "narrative_plan",
        SavePromptModelPreferenceRequest.model_validate(
            {"provider_id": "novita", "model_id": "deepseek/deepseek-v3.1"}
        ),
    )
    assert saved.provider_id == "novita"

    with pytest.raises(PromptModelNotInCatalog):
        await service.save_preference(
            "project_a",
            "narrative_plan",
            SavePromptModelPreferenceRequest.model_validate(
                {"provider_id": "unknown", "model_id": "unknown/model"}
            ),
        )

    locked = await service.save_lock(
        "project_a",
        "narrative_plan",
        "template",
        SavePromptLayerLockRequest.model_validate({"locked": True}),
    )
    assert locked.locked is True
