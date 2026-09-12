"""Contract tests for authenticated Prompt Lab endpoints."""

from __future__ import annotations

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.application.ports import (
    PromptBindingNotFound,
    PromptBindingRevisionConflict,
    PromptTemplateNotFound,
    PromptTemplateRevisionConflict,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.prompts import (
    ProjectPromptBinding,
    PromptTemplateRevision,
    SaveProjectPromptBindingRequest,
)

AUTH_HEADERS = {"Authorization": "Bearer test-key"}


class MemoryPromptLabRepository:
    def __init__(self) -> None:
        self.templates: dict[tuple[str, str, int], PromptTemplateRevision] = {}
        self.bindings: dict[tuple[str, str], ProjectPromptBinding] = {}

    async def list_template_heads(
        self, *, project_id: str, stage_id: str
    ) -> list[PromptTemplateRevision]:
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
        return self.bindings.get((project_id, stage_id))

    async def save_binding(
        self, *, project_id: str, stage_id: str, request: SaveProjectPromptBindingRequest
    ) -> ProjectPromptBinding:
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


TEMPLATE_PAYLOAD = {
    "stage_id": "narrative_plan",
    "language": "id-ID",
    "body": "Write a hook",
}


def app_with_prompt_repository(repository: MemoryPromptLabRepository | None) -> object:
    return create_app(Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"), None, None, repository)


@pytest.mark.asyncio
async def test_prompt_stages_require_auth_and_return_the_ordered_registry() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        forbidden = await client.get("/api/v1/prompt-stages")
        allowed = await client.get("/api/v1/prompt-stages", headers=AUTH_HEADERS)

    assert forbidden.status_code == 403
    assert allowed.status_code == 200
    assert [stage["stage_id"] for stage in allowed.json()] == [
        "narrative_plan",
        "visual_plan",
        "caption_copy",
    ]
    assert all(stage["status"] == "draft_only" for stage in allowed.json())


@pytest.mark.asyncio
async def test_create_then_list_project_scoped_template_heads() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json=TEMPLATE_PAYLOAD,
        )
        heads = await client.get(
            "/api/v1/projects/project_a/prompt-lab/templates",
            params={"stage_id": "narrative_plan"},
            headers=AUTH_HEADERS,
        )
        other_project = await client.get(
            "/api/v1/projects/project_b/prompt-lab/templates",
            params={"stage_id": "narrative_plan"},
            headers=AUTH_HEADERS,
        )

    assert created.status_code == 201
    assert created.json()["revision"] == 1
    assert created.json()["template_id"].startswith("ptpl_")
    assert [head["template_id"] for head in heads.json()] == [created.json()["template_id"]]
    assert other_project.json() == []


@pytest.mark.asyncio
async def test_template_conflict_returns_the_latest_revision() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json=TEMPLATE_PAYLOAD,
        )
        revised = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json={
                **TEMPLATE_PAYLOAD,
                "template_id": created.json()["template_id"],
                "base_revision": 1,
            },
        )
        stale = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json={
                **TEMPLATE_PAYLOAD,
                "template_id": created.json()["template_id"],
                "base_revision": 1,
            },
        )

    assert revised.status_code == 201
    assert revised.json()["revision"] == 2
    assert stale.status_code == 409
    assert stale.json()["revision"] == 2
    assert stale.json()["body"] == "Write a hook"


@pytest.mark.asyncio
async def test_binding_lifecycle_reads_updates_and_conflicts() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json=TEMPLATE_PAYLOAD,
        )
        template_id = created.json()["template_id"]
        missing = await client.get(
            "/api/v1/projects/project_a/prompt-lab/bindings/narrative_plan", headers=AUTH_HEADERS
        )
        bound = await client.put(
            "/api/v1/projects/project_a/prompt-lab/bindings/narrative_plan",
            headers=AUTH_HEADERS,
            json={
                "template_id": template_id,
                "template_revision": 1,
                "project_override": "Use Indonesian",
            },
        )
        updated = await client.put(
            "/api/v1/projects/project_a/prompt-lab/bindings/narrative_plan",
            headers=AUTH_HEADERS,
            json={
                "template_id": template_id,
                "template_revision": 1,
                "project_override": "Use conversational Indonesian",
                "base_revision": 1,
            },
        )
        stale = await client.put(
            "/api/v1/projects/project_a/prompt-lab/bindings/narrative_plan",
            headers=AUTH_HEADERS,
            json={
                "template_id": template_id,
                "template_revision": 1,
                "project_override": "Overwrite silently",
                "base_revision": 1,
            },
        )

    assert missing.status_code == 404
    assert bound.status_code == 200
    assert bound.json()["revision"] == 1
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    assert updated.json()["project_override"] == "Use conversational Indonesian"
    assert stale.status_code == 409
    assert stale.json()["revision"] == 2
    assert stale.json()["project_override"] == "Use conversational Indonesian"


@pytest.mark.asyncio
async def test_resolved_preview_contains_only_visible_prompt_sections() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json=TEMPLATE_PAYLOAD,
        )
        await client.put(
            "/api/v1/projects/project_a/prompt-lab/bindings/narrative_plan",
            headers=AUTH_HEADERS,
            json={
                "template_id": created.json()["template_id"],
                "template_revision": 1,
                "project_override": "Use Indonesian",
            },
        )
        resolved = await client.get(
            "/api/v1/projects/project_a/prompt-lab/resolved/narrative_plan", headers=AUTH_HEADERS
        )

    assert resolved.status_code == 200
    assert resolved.json()["visible_text"] == (
        "Template\nWrite a hook\n\nProject override\nUse Indonesian"
    )
    assert "policy" not in resolved.text.lower()


@pytest.mark.asyncio
async def test_unknown_stage_unsupported_stage_and_extra_field_fail_closed() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        unknown_stage_list = await client.get(
            "/api/v1/projects/project_a/prompt-lab/templates",
            params={"stage_id": "improve_prompt"},
            headers=AUTH_HEADERS,
        )
        unknown_stage_resolved = await client.get(
            "/api/v1/projects/project_a/prompt-lab/resolved/improve_prompt", headers=AUTH_HEADERS
        )
        extra_field = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json={**TEMPLATE_PAYLOAD, "provider": "unavailable"},
        )
        blank_body = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json={**TEMPLATE_PAYLOAD, "body": "   "},
        )

    assert unknown_stage_list.status_code == 422
    assert unknown_stage_resolved.status_code == 422
    assert extra_field.status_code == 422
    assert blank_body.status_code == 422


@pytest.mark.asyncio
async def test_cross_project_binding_reference_behaves_as_missing() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json=TEMPLATE_PAYLOAD,
        )
        cross_project = await client.put(
            "/api/v1/projects/project_b/prompt-lab/bindings/narrative_plan",
            headers=AUTH_HEADERS,
            json={
                "template_id": created.json()["template_id"],
                "template_revision": 1,
                "project_override": "Use Indonesian",
            },
        )

    assert cross_project.status_code == 404


@pytest.mark.asyncio
async def test_prompt_lab_reports_unavailable_persistence_without_details() -> None:
    app = app_with_prompt_repository(None)
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        unavailable = await client.post(
            "/api/v1/projects/project_a/prompt-lab/templates",
            headers=AUTH_HEADERS,
            json=TEMPLATE_PAYLOAD,
        )

    assert unavailable.status_code == 503
    assert "postgres" not in unavailable.text.lower()
    assert "sql" not in unavailable.text.lower()
    assert "connection" not in unavailable.text.lower()


@pytest.mark.asyncio
async def test_openapi_exposes_no_provider_action_routes() -> None:
    app = app_with_prompt_repository(MemoryPromptLabRepository())

    paths = app.openapi()["paths"]  # type: ignore[attr-defined]
    prompt_paths = [path for path in paths if "prompt" in path]

    assert "/api/v1/prompt-stages" in paths
    assert list(paths["/api/v1/projects/{project_id}/prompt-lab/bindings/{stage_id}"]) == [
        "get",
        "put",
    ]
    joined = " ".join(prompt_paths).lower()
    assert "improve" not in joined
    assert "translate" not in joined
    assert "proposal" not in joined
