"""Application-service tests for the Prompt Lab use cases."""

from __future__ import annotations

import pytest

from thoth_control_plane.application.ports import (
    PromptBindingNotFound,
    PromptBindingRevisionConflict,
    PromptLabRepository,
    PromptTemplateNotFound,
    PromptTemplateRevisionConflict,
)
from thoth_control_plane.application.prompt_lab import (
    PromptLabService,
    PromptLabStoreUnavailable,
    PromptStageMismatch,
    PromptStageNotRegistered,
)
from thoth_control_plane.domain.prompts import (
    ProjectPromptBinding,
    PromptTemplateRevision,
    SaveProjectPromptBindingRequest,
    SavePromptTemplateRequest,
)
from thoth_control_plane.infrastructure.prompt_repository import PromptLabPersistenceError


class MemoryPromptLabRepository:
    """In-memory Prompt Lab repository seam matching the PostgreSQL semantics."""

    def __init__(self) -> None:
        self.templates: dict[tuple[str, str, int], PromptTemplateRevision] = {}
        self.bindings: dict[tuple[str, str], ProjectPromptBinding] = {}
        self.calls: list[str] = []

    async def list_template_heads(
        self, *, project_id: str, stage_id: str
    ) -> list[PromptTemplateRevision]:
        self.calls.append("list_template_heads")
        heads: dict[str, PromptTemplateRevision] = {}
        for (project, template_id, revision), template in self.templates.items():
            if (
                project == project_id
                and template.stage_id == stage_id
                and (template_id not in heads or revision > heads[template_id].revision)
            ):
                heads[template_id] = template
        return [heads[template_id] for template_id in sorted(heads)]

    async def get_template_revision(
        self, *, project_id: str, template_id: str, revision: int
    ) -> PromptTemplateRevision | None:
        self.calls.append("get_template_revision")
        return self.templates.get((project_id, template_id, revision))

    async def save_template(
        self,
        *,
        project_id: str,
        template_id: str,
        base_revision: int | None,
        stage_id: str,
        language: str,
        body: str,
    ) -> PromptTemplateRevision:
        self.calls.append("save_template")
        latest = None
        for (project, candidate_id, revision), template in self.templates.items():
            if (
                project == project_id
                and candidate_id == template_id
                and (latest is None or revision > latest.revision)
            ):
                latest = template
        if base_revision is None:
            if latest is not None:
                raise PromptTemplateRevisionConflict(latest)
            next_revision = 1
        else:
            if latest is None:
                raise PromptTemplateNotFound()
            if latest.revision != base_revision:
                raise PromptTemplateRevisionConflict(latest)
            next_revision = latest.revision + 1
        saved = PromptTemplateRevision.model_validate(
            {
                "project_id": project_id,
                "template_id": template_id,
                "revision": next_revision,
                "stage_id": stage_id,
                "language": language,
                "body": body,
            }
        )
        self.templates[(project_id, template_id, next_revision)] = saved
        return saved

    async def get_binding(self, *, project_id: str, stage_id: str) -> ProjectPromptBinding | None:
        self.calls.append("get_binding")
        return self.bindings.get((project_id, stage_id))

    async def save_binding(
        self, *, project_id: str, stage_id: str, request: SaveProjectPromptBindingRequest
    ) -> ProjectPromptBinding:
        self.calls.append("save_binding")
        latest = self.bindings.get((project_id, stage_id))
        if request.base_revision is None:
            if latest is not None:
                raise PromptBindingRevisionConflict(latest)
            next_revision = 1
        else:
            if latest is None:
                raise PromptBindingNotFound()
            if latest.revision != request.base_revision:
                raise PromptBindingRevisionConflict(latest)
            next_revision = latest.revision + 1
        saved = ProjectPromptBinding.model_validate(
            {
                "project_id": project_id,
                "stage_id": stage_id,
                "template_id": request.template_id,
                "template_revision": request.template_revision,
                "project_override": request.project_override,
                "revision": next_revision,
            }
        )
        self.bindings[(project_id, stage_id)] = saved
        return saved


def template_request(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "stage_id": "narrative_plan",
        "language": "id-ID",
        "body": "Write a hook",
    }
    values.update(overrides)
    return values


def binding_request(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "template_id": "ptpl_001",
        "template_revision": 1,
        "project_override": "Use Indonesian",
    }
    values.update(overrides)
    return values


@pytest.mark.asyncio
async def test_list_stages_returns_the_ordered_draft_only_registry() -> None:
    service = PromptLabService(MemoryPromptLabRepository())

    stages = service.list_stages()

    assert [(stage.stage_id, stage.status) for stage in stages] == [
        ("narrative_plan", "draft_only"),
        ("visual_plan", "draft_only"),
        ("caption_copy", "draft_only"),
    ]


@pytest.mark.asyncio
async def test_save_template_creates_revision_one_with_generated_id() -> None:
    service = PromptLabService(MemoryPromptLabRepository())

    saved = await service.save_template(
        "project_a",
        SavePromptTemplateRequest.model_validate(template_request()),
    )

    assert saved.template_id.startswith("ptpl_")
    assert saved.revision == 1
    assert saved.project_id == "project_a"


@pytest.mark.asyncio
async def test_save_template_revises_with_supplied_identity() -> None:
    service = PromptLabService(MemoryPromptLabRepository())
    created = await service.save_template(
        "project_a", SavePromptTemplateRequest.model_validate(template_request())
    )

    revised = await service.save_template(
        "project_a",
        SavePromptTemplateRequest.model_validate(
            template_request(template_id=created.template_id, base_revision=1, body="Sharper hook")
        ),
    )

    assert revised.template_id == created.template_id
    assert revised.revision == 2
    assert revised.body == "Sharper hook"


@pytest.mark.asyncio
async def test_list_templates_scopes_heads_to_project_and_stage() -> None:
    repository = MemoryPromptLabRepository()
    service = PromptLabService(repository)
    request = SavePromptTemplateRequest.model_validate(template_request())
    await service.save_template("project_a", request)
    await service.save_template("project_b", request)
    await service.save_template(
        "project_a",
        SavePromptTemplateRequest.model_validate(template_request(stage_id="visual_plan")),
    )

    heads = await service.list_templates("project_a", "narrative_plan")

    assert len(heads) == 1
    assert heads[0].project_id == "project_a"
    assert heads[0].stage_id == "narrative_plan"


@pytest.mark.asyncio
async def test_save_binding_creates_then_updates_the_project_stage_binding() -> None:
    service = PromptLabService(MemoryPromptLabRepository())
    created = await service.save_template(
        "project_a", SavePromptTemplateRequest.model_validate(template_request())
    )

    bound = await service.save_binding(
        "project_a",
        "narrative_plan",
        SaveProjectPromptBindingRequest.model_validate(
            binding_request(template_id=created.template_id)
        ),
    )
    updated = await service.save_binding(
        "project_a",
        "narrative_plan",
        SaveProjectPromptBindingRequest.model_validate(
            binding_request(
                template_id=created.template_id,
                project_override="Use conversational Indonesian",
                base_revision=1,
            )
        ),
    )

    assert bound.revision == 1
    assert updated.revision == 2
    assert updated.project_override == "Use conversational Indonesian"


@pytest.mark.asyncio
async def test_get_binding_returns_none_when_missing() -> None:
    service = PromptLabService(MemoryPromptLabRepository())

    assert await service.get_binding("project_a", "narrative_plan") is None


@pytest.mark.asyncio
async def test_resolved_prompt_composes_only_visible_sections() -> None:
    service = PromptLabService(MemoryPromptLabRepository())
    created = await service.save_template(
        "project_a", SavePromptTemplateRequest.model_validate(template_request())
    )
    await service.save_binding(
        "project_a",
        "narrative_plan",
        SaveProjectPromptBindingRequest.model_validate(
            binding_request(template_id=created.template_id)
        ),
    )

    resolved = await service.get_resolved_prompt("project_a", "narrative_plan")

    assert resolved.visible_text == "Template\nWrite a hook\n\nProject override\nUse Indonesian"
    assert [section.kind for section in resolved.sections] == ["template", "project_override"]


@pytest.mark.asyncio
async def test_resolved_prompt_requires_a_binding() -> None:
    service = PromptLabService(MemoryPromptLabRepository())

    with pytest.raises(PromptBindingNotFound):
        await service.get_resolved_prompt("project_a", "narrative_plan")


@pytest.mark.asyncio
async def test_cross_project_template_reference_behaves_as_missing() -> None:
    repository = MemoryPromptLabRepository()
    service = PromptLabService(repository)
    created = await service.save_template(
        "project_a", SavePromptTemplateRequest.model_validate(template_request())
    )

    with pytest.raises(PromptTemplateNotFound):
        await service.save_binding(
            "project_b",
            "narrative_plan",
            SaveProjectPromptBindingRequest.model_validate(
                binding_request(template_id=created.template_id, template_revision=1)
            ),
        )


@pytest.mark.asyncio
async def test_binding_stage_mismatch_is_rejected_without_a_write() -> None:
    repository = MemoryPromptLabRepository()
    service = PromptLabService(repository)
    created = await service.save_template(
        "project_a", SavePromptTemplateRequest.model_validate(template_request())
    )

    with pytest.raises(PromptStageMismatch):
        await service.save_binding(
            "project_a",
            "caption_copy",
            SaveProjectPromptBindingRequest.model_validate(
                binding_request(template_id=created.template_id)
            ),
        )

    assert await repository.get_binding(project_id="project_a", stage_id="caption_copy") is None


@pytest.mark.asyncio
async def test_unregistered_stage_is_rejected_before_repository_access() -> None:
    repository = MemoryPromptLabRepository()
    service = PromptLabService(repository)

    with pytest.raises(PromptStageNotRegistered):
        await service.list_templates("project_a", "improve_prompt")

    assert repository.calls == []


@pytest.mark.asyncio
async def test_unavailable_repository_maps_to_a_safe_error() -> None:
    class BrokenRepository:
        async def list_template_heads(self, **_: object) -> list[PromptTemplateRevision]:
            raise PromptLabPersistenceError()

    with pytest.raises(PromptLabStoreUnavailable):
        await PromptLabService(BrokenRepository()).list_templates("project_a", "narrative_plan")

    with pytest.raises(PromptLabStoreUnavailable):
        await PromptLabService(None).list_templates("project_a", "narrative_plan")


def test_service_satisfies_the_repository_seam_contract() -> None:
    repository: PromptLabRepository = MemoryPromptLabRepository()
    assert callable(repository.save_template)
    assert callable(repository.save_binding)
