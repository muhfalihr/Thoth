"""Contract tests for authenticated Prompt Proposal endpoints (C2)."""

from __future__ import annotations

import httpx
import pytest

from tests.application.test_prompt_lab import MemoryPromptLabRepository
from tests.application.test_prompt_proposals import (
    MemoryProposalRepository,
    RecordingGateway,
)
from thoth_control_plane.api import create_app
from thoth_control_plane.application.prompt_proposal_ports import (
    PromptIdempotencyConflict,
    PromptProposalActiveGeneration,
    PromptProposalStale,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.prompt_proposals import PromptProposal, PromptProviderDefinition
from thoth_control_plane.domain.prompts import SaveProjectPromptBindingRequest

AUTH_HEADERS = {"Authorization": "Bearer test-key"}

PROVIDER_CATALOG = (
    PromptProviderDefinition.model_validate(
        {
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
    ),
)


async def seeded_app(
    proposal_repo: MemoryProposalRepository | None = None,
    gateway: RecordingGateway | None = None,
) -> tuple[httpx.AsyncClient, MemoryProposalRepository, str]:
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
    proposal_repository = proposal_repo or MemoryProposalRepository()
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"),
        None,
        prompt_repository=prompt_repo,
        prompt_proposal_repository=proposal_repository,
        prompt_proposal_gateway=gateway or RecordingGateway(),
        prompt_provider_catalog=PROVIDER_CATALOG,
    )
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")
    return client, proposal_repository, template.template_id


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


@pytest.mark.asyncio
async def test_prompt_providers_require_auth_and_return_enabled_only() -> None:
    client, _, _ = await seeded_app()
    async with client:
        forbidden = await client.get("/api/v1/prompt-providers")
        allowed = await client.get("/api/v1/prompt-providers", headers=AUTH_HEADERS)

    assert forbidden.status_code == 403
    assert allowed.status_code == 200
    assert [provider["provider_id"] for provider in allowed.json()] == ["novita"]
    assert "base_url" not in allowed.text
    assert "credential" not in allowed.text


@pytest.mark.asyncio
async def test_starter_route_returns_stage_body() -> None:
    client, _, _ = await seeded_app()
    async with client:
        starter = await client.get(
            "/api/v1/prompt-stages/narrative_plan/starter", headers=AUTH_HEADERS
        )
        unknown = await client.get(
            "/api/v1/prompt-stages/unknown_stage/starter", headers=AUTH_HEADERS
        )

    assert starter.status_code == 200
    assert starter.json()["body"].strip() != ""
    assert unknown.status_code in {404, 422}


@pytest.mark.asyncio
async def test_preference_routes_roundtrip_and_conflict() -> None:
    client, _, _ = await seeded_app()
    async with client:
        missing = await client.get(
            "/api/v1/projects/project_a/prompt-lab/preferences/narrative_plan",
            headers=AUTH_HEADERS,
        )
        saved = await client.put(
            "/api/v1/projects/project_a/prompt-lab/preferences/narrative_plan",
            headers=AUTH_HEADERS,
            json={"provider_id": "novita", "model_id": "deepseek/deepseek-v3.1"},
        )
        conflict = await client.put(
            "/api/v1/projects/project_a/prompt-lab/preferences/narrative_plan",
            headers=AUTH_HEADERS,
            json={
                "provider_id": "novita",
                "model_id": "deepseek/deepseek-v3.1",
                "base_revision": 99,
            },
        )

    assert missing.status_code == 404
    assert saved.status_code == 200
    assert saved.json()["revision"] == 1
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "preference_revision_conflict"


@pytest.mark.asyncio
async def test_lock_routes_roundtrip() -> None:
    client, _, _ = await seeded_app()
    async with client:
        locks = await client.get(
            "/api/v1/projects/project_a/prompt-lab/locks/narrative_plan", headers=AUTH_HEADERS
        )
        saved = await client.put(
            "/api/v1/projects/project_a/prompt-lab/locks/narrative_plan/template",
            headers=AUTH_HEADERS,
            json={"locked": True},
        )

    assert locks.status_code == 200
    assert [lock["layer"] for lock in locks.json()] == ["template", "project_override"]
    assert saved.status_code == 200
    assert saved.json()["locked"] is True


@pytest.mark.asyncio
async def test_create_returns_202_and_replays_idempotency_key() -> None:
    client, _, template_id = await seeded_app()
    async with client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )
        replayed = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )

    assert created.status_code == 202
    assert created.json()["status"] == "queued"
    assert created.json()["proposal_id"] == replayed.json()["proposal_id"]
    assert "base_url" not in created.text
    assert "credential" not in created.text


@pytest.mark.asyncio
async def test_create_without_saved_binding_is_not_found() -> None:
    client, _, template_id = await seeded_app()
    async with client:
        response = await client.post(
            "/api/v1/projects/project_b/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_create_rejects_an_unregistered_stage_id_at_the_schema() -> None:
    client, _, template_id = await seeded_app()
    async with client:
        response = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json={**create_improvement(template_id), "stage_id": "not_a_real_stage"},
        )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_active_generation_conflict_returns_409() -> None:
    proposal_repo = MemoryProposalRepository()
    proposal_repo.fail_reserve = PromptProposalActiveGeneration("proposal_1")
    client, _, template_id = await seeded_app(proposal_repo=proposal_repo)
    async with client:
        response = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_create_idempotency_payload_conflict_returns_409() -> None:
    proposal_repo = MemoryProposalRepository()
    proposal_repo.fail_reserve = PromptIdempotencyConflict("proposal_1")
    client, _, template_id = await seeded_app(proposal_repo=proposal_repo)
    async with client:
        response = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_create_workflow_unavailable_returns_503_and_marks_failed() -> None:
    class FailingGateway(RecordingGateway):
        async def start(self, proposal_id: str) -> None:
            raise RuntimeError("temporal unreachable")

    client, _repo, template_id = await seeded_app(gateway=FailingGateway())
    proposal_repo = client._transport.app.state.prompt_proposal_service._proposal_repository
    async with client:
        response = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )

    assert response.status_code == 503
    stored = next(iter(proposal_repo.proposals.values()))
    assert stored.status == "failed"


@pytest.mark.asyncio
async def test_proposal_detail_is_project_scoped() -> None:
    client, _repo, template_id = await seeded_app()
    async with client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )
        proposal_id = created.json()["proposal_id"]
        found = await client.get(
            f"/api/v1/projects/project_a/prompt-lab/proposals/{proposal_id}",
            headers=AUTH_HEADERS,
        )
        missing = await client.get(
            f"/api/v1/projects/project_b/prompt-lab/proposals/{proposal_id}",
            headers=AUTH_HEADERS,
        )

    assert found.status_code == 200
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_history_route_requires_stage_and_returns_page() -> None:
    client, _, template_id = await seeded_app()
    async with client:
        await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )
        page = await client.get(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            params={"stage_id": "narrative_plan", "limit": 5},
            headers=AUTH_HEADERS,
        )

    assert page.status_code == 200
    assert len(page.json()["proposals"]) == 1


@pytest.mark.asyncio
async def test_apply_reject_and_stale_paths() -> None:
    client, proposal_repo, template_id = await seeded_app()
    async with client:
        created = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(template_id),
        )
        proposal_id = created.json()["proposal_id"]

        stale = await client.post(
            f"/api/v1/projects/project_a/prompt-lab/proposals/{proposal_id}/apply",
            headers=AUTH_HEADERS,
            json={
                "source_template_revision": 1,
                "source_binding_revision": 9,
                "change_ids": ["change_abc"],
            },
        )
        assert stale.status_code == 409
        assert isinstance(PromptProposalStale, type)  # keep import meaningful

        proposal_repo.proposals[("project_a", proposal_id)] = PromptProposal.model_validate(
            {
                **created.json(),
                "status": "succeeded",
                "changes": [
                    {
                        "change_id": "change_abc",
                        "layer": "template",
                        "before_text": "before",
                        "after_text": "after",
                        "start_line": 0,
                        "end_line": 1,
                    }
                ],
            }
        )
        applied = await client.post(
            f"/api/v1/projects/project_a/prompt-lab/proposals/{proposal_id}/apply",
            headers=AUTH_HEADERS,
            json={
                "source_template_revision": 1,
                "source_binding_revision": 1,
                "change_ids": ["change_abc"],
            },
        )
        assert applied.status_code == 200

        rejected = await client.post(
            f"/api/v1/projects/project_a/prompt-lab/proposals/{proposal_id}/reject",
            headers=AUTH_HEADERS,
        )
        assert rejected.status_code == 200


@pytest.mark.asyncio
async def test_settings_catalog_is_projected_when_no_catalog_injected() -> None:
    """Production create_app with no injected catalog must expose the configured catalog."""
    from tests.infrastructure.test_prompt_provider import RUNTIME_PROVIDER
    from thoth_control_plane.api import create_app as factory

    prompt_repo = MemoryPromptLabRepository()
    app = factory(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_PROMPT_PROVIDER_CATALOG=[RUNTIME_PROVIDER],
        ),
        None,
        prompt_repository=prompt_repo,
        prompt_proposal_repository=MemoryProposalRepository(),
        prompt_proposal_gateway=RecordingGateway(),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        catalog = await client.get("/api/v1/prompt-providers", headers=AUTH_HEADERS)

    assert catalog.status_code == 200
    assert [item["provider_id"] for item in catalog.json()] == ["novita"]
    assert "base_url" not in catalog.text
    assert "credential_id" not in catalog.text
    assert "protocol" not in catalog.text
    assert "api.novita.example" not in catalog.text


@pytest.mark.asyncio
async def test_injected_catalog_overrides_settings_catalog() -> None:
    from tests.infrastructure.test_prompt_provider import RUNTIME_PROVIDER
    from thoth_control_plane.api import create_app as factory

    app = factory(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_PROMPT_PROVIDER_CATALOG=[RUNTIME_PROVIDER],
        ),
        None,
        prompt_repository=MemoryPromptLabRepository(),
        prompt_proposal_repository=MemoryProposalRepository(),
        prompt_proposal_gateway=RecordingGateway(),
        prompt_provider_catalog=(),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        catalog = await client.get("/api/v1/prompt-providers", headers=AUTH_HEADERS)

    assert catalog.status_code == 200
    assert catalog.json() == []


@pytest.mark.asyncio
async def test_settings_catalog_survives_lifespan() -> None:
    """The effective catalog computed at factory time must not be discarded at startup."""
    from tests.infrastructure.test_prompt_provider import RUNTIME_PROVIDER
    from thoth_control_plane.api import create_app as factory

    class FakeWorkflowGateway:
        async def check_connection(self) -> bool:
            return True

    app = factory(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="test-key",
            THOTH_PROMPT_PROVIDER_CATALOG=[RUNTIME_PROVIDER],
        ),
        FakeWorkflowGateway(),
        prompt_repository=MemoryPromptLabRepository(),
        prompt_proposal_repository=MemoryProposalRepository(),
        prompt_proposal_gateway=RecordingGateway(),
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            catalog = await client.get("/api/v1/prompt-providers", headers=AUTH_HEADERS)

    assert catalog.status_code == 200
    assert [item["provider_id"] for item in catalog.json()] == ["novita"]
    assert "base_url" not in catalog.text
    assert "credential_id" not in catalog.text
    assert "protocol" not in catalog.text


@pytest.mark.asyncio
async def test_missing_resources_and_invalid_lock_layer_return_safe_codes(monkeypatch) -> None:
    import thoth_control_plane.application.prompt_proposals as service_module

    monkeypatch.setattr(service_module, "PROMPT_STARTERS", {})
    client, _, template_id = await seeded_app()
    async with client:
        missing_starter = await client.get(
            "/api/v1/prompt-stages/narrative_plan/starter", headers=AUTH_HEADERS
        )
        missing_preference = await client.get(
            "/api/v1/projects/project_a/prompt-lab/preferences/narrative_plan",
            headers=AUTH_HEADERS,
        )
        invalid_layer = await client.put(
            "/api/v1/projects/project_a/prompt-lab/locks/narrative_plan/bogus_layer",
            headers=AUTH_HEADERS,
            json={"locked": True},
        )
        blank_key = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "   "},
            json=create_improvement(template_id),
        )
        missing_key = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers=AUTH_HEADERS,
            json=create_improvement(template_id),
        )

    assert missing_starter.status_code == 404
    assert missing_starter.json()["detail"]["code"] == "starter_not_found"
    assert missing_preference.status_code == 404
    assert missing_preference.json()["detail"]["code"] == "preference_not_found"
    assert invalid_layer.status_code == 404
    assert invalid_layer.json()["detail"]["code"] == "invalid_lock_layer"
    assert blank_key.status_code == 422
    assert blank_key.json()["detail"]["code"] == "missing_idempotency_key"
    assert missing_key.status_code == 422
    assert missing_key.json()["detail"]["code"] == "missing_idempotency_key"


@pytest.mark.asyncio
async def test_preference_and_lock_conflicts_preserve_the_latest_resource() -> None:
    client, _, _ = await seeded_app()
    async with client:
        saved = await client.put(
            "/api/v1/projects/project_a/prompt-lab/preferences/narrative_plan",
            headers=AUTH_HEADERS,
            json={"provider_id": "novita", "model_id": "deepseek/deepseek-v3.1"},
        )
        preference_conflict = await client.put(
            "/api/v1/projects/project_a/prompt-lab/preferences/narrative_plan",
            headers=AUTH_HEADERS,
            json={
                "provider_id": "novita",
                "model_id": "deepseek/deepseek-v3.1",
                "base_revision": 99,
            },
        )
        locked = await client.put(
            "/api/v1/projects/project_a/prompt-lab/locks/narrative_plan/template",
            headers=AUTH_HEADERS,
            json={"locked": True},
        )
        lock_conflict = await client.put(
            "/api/v1/projects/project_a/prompt-lab/locks/narrative_plan/template",
            headers=AUTH_HEADERS,
            json={"locked": False, "base_revision": 99},
        )

    assert saved.status_code == 200
    assert preference_conflict.status_code == 409
    assert preference_conflict.json()["code"] == "preference_revision_conflict"
    assert preference_conflict.json()["latest"]["revision"] == saved.json()["revision"]
    assert preference_conflict.json()["latest"]["model_id"] == saved.json()["model_id"]
    assert locked.status_code == 200
    assert lock_conflict.status_code == 409
    assert lock_conflict.json()["code"] == "lock_revision_conflict"
    assert lock_conflict.json()["latest"]["revision"] == locked.json()["revision"]
    assert lock_conflict.json()["latest"]["locked"] == locked.json()["locked"]


@pytest.mark.asyncio
async def test_known_failures_return_typed_safe_detail_codes() -> None:
    client, _, _template_id = await seeded_app()
    async with client:
        missing = await client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals/proposal_x/apply",
            headers=AUTH_HEADERS,
            json={
                "source_template_revision": 1,
                "source_binding_revision": 1,
                "change_ids": ["change_abc"],
            },
        )
        stale_repo = MemoryProposalRepository()
        stale_client, _, stale_template = await seeded_app(proposal_repo=stale_repo)
        created = await stale_client.post(
            "/api/v1/projects/project_a/prompt-lab/proposals",
            headers={**AUTH_HEADERS, "Idempotency-Key": "request-1"},
            json=create_improvement(stale_template),
        )
        stale_repo.proposals[("project_a", created.json()["proposal_id"])] = stale_repo.proposals[
            ("project_a", created.json()["proposal_id"])
        ].model_copy(update={"status": "succeeded"})
        stale = await stale_client.post(
            f"/api/v1/projects/project_a/prompt-lab/proposals/{created.json()['proposal_id']}/apply",
            headers=AUTH_HEADERS,
            json={
                "source_template_revision": 1,
                "source_binding_revision": 9,
                "change_ids": ["change_abc"],
            },
        )

    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "proposal_not_found"
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "source_revision_changed"
    for response in (missing, stale):
        for forbidden in ("postgresql", "http", "traceback", "Exception"):
            assert forbidden.lower() not in response.text.lower()


@pytest.mark.asyncio
async def test_openapi_exposes_only_the_documented_c2_routes() -> None:
    client, _repo, _ = await seeded_app()
    async with client:
        app = client._transport.app  # type: ignore[attr-defined]
    paths = app.openapi()["paths"]
    c2_paths = [path for path in paths if "prompt" in path]
    assert "/api/v1/prompt-providers" in paths
    assert "/api/v1/prompt-stages/{stage_id}/starter" in paths
    joined = " ".join(c2_paths).lower()
    assert "improve" not in joined
    assert "translate" not in joined


@pytest.mark.asyncio
async def test_openapi_requires_idempotency_key_for_proposal_creation() -> None:
    client, _repo, _ = await seeded_app()
    async with client:
        app = client._transport.app  # type: ignore[attr-defined]
    operation = app.openapi()["paths"]["/api/v1/projects/{project_id}/prompt-lab/proposals"]["post"]
    header_params = [
        parameter
        for parameter in operation["parameters"]
        if parameter["in"] == "header" and parameter["name"] == "Idempotency-Key"
    ]
    assert len(header_params) == 1
    assert header_params[0]["required"] is True
