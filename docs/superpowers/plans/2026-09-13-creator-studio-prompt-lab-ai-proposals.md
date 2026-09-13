# Creator Studio Prompt Lab AI Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Use
> `superpowers:test-driven-development` for every product-code task.

**Goal:** Add durable, review-before-Apply AI prompt proposals for all three
Prompt Lab stages, with UI-selected server-allowlisted providers/models,
starter templates, layer locks, and offline-safe asynchronous recovery.

**Architecture:** The authenticated Python control plane owns safe catalog,
preference, lock, proposal, and Apply APIs backed by editor PostgreSQL. A
proposal-specific Temporal workflow sends only a proposal ID to an existing
Python worker, which performs one server-owned OpenAI-compatible provider
request and persists a typed result. React polls the durable proposal resource
and keeps C1 authoring drafts isolated in the existing reducer.

**Tech Stack:** Python 3.12+, Pydantic v2, pydantic-settings, FastAPI, psycopg 3,
Temporal Python SDK 1.x, httpx 0.28, PostgreSQL 16, React 19, TypeScript, Bun,
Testing Library, Tailwind CSS.

**Spec:**
`docs/superpowers/specs/2026-09-13-creator-studio-prompt-lab-ai-proposals-design.md`

## Global constraints

- Support `narrative_plan`, `visual_plan`, and `caption_copy`; one selected
  stage per action.
- Require saved template/binding revisions before generation.
- Expose only server-allowlisted provider/model IDs to the browser.
- Keep provider credentials, private endpoints, hidden instructions, prompt
  text, and raw payloads out of Temporal history and ordinary logs.
- Perform one provider HTTP request per proposal. Use
  `RetryPolicy(maximum_attempts=1)`, a 120-second HTTP timeout, and a 135-second
  Temporal activity start-to-close timeout.
- Compute diff hunks on the server. Apply accepts stored change IDs, never
  client-authored replacement text.
- Preserve C1 draft and offline-recovery semantics.
- Use existing dependencies only. `httpx` and `difflib` cover C2; do not add an
  AI SDK, state-management package, diff package, queue, or service.
- Run every automated test with fake or mock provider transport. No live
  provider request is authorized by this plan.
- Do not push, deploy, inspect real provider secrets, mutate Stage 1 evidence,
  or run parity/controlled-fallback/acceptance operations.
- Prefix shell commands with `rtk`.
- Each commit uses a short one-line subject and no body or `Co-Authored-By`
  trailer.

## File structure

### Python domain and application

- Create `python/src/thoth_control_plane/domain/prompt_proposals.py`: strict C2
  contracts, status transitions, deterministic line hunks, and Apply helpers.
- Modify `python/src/thoth_control_plane/domain/prompts.py`: starter definitions
  and C2-ready stage status.
- Create `python/src/thoth_control_plane/application/prompt_proposal_ports.py`:
  repository, provider, and workflow gateway protocols plus typed errors.
- Create `python/src/thoth_control_plane/application/prompt_proposals.py`: C2
  orchestration, validation, lifecycle, and Apply use cases.

### Python infrastructure and runtime

- Create `python/migrations/editor/0003_prompt_lab_ai_proposals.sql`: preferences,
  locks, proposals, changes, idempotency, and application provenance.
- Create `python/src/thoth_control_plane/infrastructure/prompt_proposal_repository.py`:
  parameterized PostgreSQL persistence and atomic Apply.
- Create `python/src/thoth_control_plane/infrastructure/prompt_provider.py`:
  safe catalog projection and one-request OpenAI-compatible adapter.
- Create `python/src/thoth_control_plane/activities/prompt_proposal.py`: activity
  that loads a proposal by ID, calls the adapter once, and persists a terminal
  result.
- Create `python/src/thoth_control_plane/workflows/prompt_proposal.py`: ID-only
  deterministic workflow.
- Create `python/src/thoth_control_plane/infrastructure/prompt_proposal_gateway.py`:
  idempotent Temporal start boundary.
- Modify `python/src/thoth_control_plane/config.py`, `worker.py`, activity and
  workflow exports, API factory, and Compose runtime wiring.

### Python API

- Create `python/src/thoth_control_plane/api/routes/prompt_proposals.py`: catalog,
  starter, preference, lock, proposal, Apply, and Reject routes.
- Modify `python/src/thoth_control_plane/api/app.py`: inject repositories,
  gateway, and service; register the C2 router.
- Regenerate `python/openapi.json`.

### Dashboard

- Modify `dashboard/src/api/control-plane.ts` and regenerate
  `dashboard/src/api/generated/control-plane.ts`.
- Create `dashboard/src/features/studio/prompt_proposal_state.ts`: isolated pure
  proposal reducer.
- Create `dashboard/src/features/studio/PromptProposalPanel.tsx`: catalog,
  generation, polling, comparison, locks, history, and actions.
- Modify `dashboard/src/features/studio/PromptLab.tsx`: starter actions and panel
  integration without merging proposal state into C1 authoring state.

---

### Task 1: Define C2 contracts, starter templates, and deterministic changes

**Files:**

- Create: `python/src/thoth_control_plane/domain/prompt_proposals.py`
- Create: `python/tests/domain/test_prompt_proposals.py`
- Modify: `python/src/thoth_control_plane/domain/prompts.py:15-111`
- Modify: `python/src/thoth_control_plane/domain/__init__.py`

**Interfaces:**

- Produces `PromptProviderDefinition`, `ProjectPromptModelPreference`,
  `ProjectPromptLayerLock`, `PromptProposal`, `CreatePromptProposalRequest`,
  `ApplyPromptProposalRequest`, `ProviderPromptRequest`,
  `ProviderPromptResult`, `PromptProposalWorkflowInput`,
  `PromptProposalActivityResult`, and `PromptProposalWorkflowResult`.
- Produces `build_prompt_changes(layer, before, after)` and
  `apply_prompt_changes(before, changes, selected_ids)`.
- Produces `PROMPT_STARTERS` keyed by all `PromptStageId` values.

- [ ] **Step 1: Write failing contract and starter tests**

```python
def test_every_prompt_stage_has_one_non_blank_starter() -> None:
    assert set(PROMPT_STARTERS) == {"narrative_plan", "visual_plan", "caption_copy"}
    assert all(starter.body.strip() for starter in PROMPT_STARTERS.values())


def test_public_provider_contract_contains_only_safe_catalog_fields() -> None:
    public = PromptProviderDefinition(
        provider_id="novita",
        label="Novita",
        enabled=True,
        models=(MODEL,),
    )
    assert public.model_dump() == {
        "provider_id": "novita",
        "label": "Novita",
        "enabled": True,
        "models": [{
            "model_id": "deepseek/deepseek-v3.1",
            "label": "DeepSeek V3.1",
            "capabilities": ["improve", "translate"],
            "max_input_chars": 12000,
        }],
    }


def test_selected_line_changes_reconstruct_without_accepting_client_text() -> None:
    changes = build_prompt_changes("template", "Hook\nContext\nCTA", "Hook!\nContext\nCTA now")
    selected = {changes[0].change_id}
    result = apply_prompt_changes("Hook\nContext\nCTA", changes, selected)
    assert result == "Hook!\nContext\nCTA"
```

- [ ] **Step 2: Run the new domain tests and confirm RED**

Run from `python/`:

```powershell
rtk uv run pytest tests/domain/test_prompt_proposals.py -q
```

Expected: collection fails because `domain.prompt_proposals` and
`PROMPT_STARTERS` do not exist.

- [ ] **Step 3: Implement strict contracts and deterministic hunk helpers**

Use `difflib.SequenceMatcher` over `splitlines(keepends=True)`. Ignore `equal`
opcodes, preserve ordered non-overlapping source spans, and derive each stable
change ID from SHA-256 of layer, source span, before text, and after text.

```python
def build_prompt_changes(layer: PromptLayer, before: str, after: str) -> tuple[PromptProposalChange, ...]:
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    matcher = SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
    return tuple(
        _change(layer, i1, i2, before_lines[i1:i2], after_lines[j1:j2])
        for opcode, i1, i2, j1, j2 in matcher.get_opcodes()
        if opcode != "equal"
    )
```

`apply_prompt_changes` must reject unknown/duplicate IDs, apply selected hunks
in source order, retain unselected source spans, and revalidate non-blank
12,000-character output.

Define the provider and history-safe workflow contracts explicitly:

```python
class ProviderPromptRequest(StrictModel):
    provider_id: SafeIdentifier
    model_id: SafeIdentifier
    kind: PromptProposalKind
    text_by_layer: dict[PromptLayer, str]
    target_language: PromptLanguage | None
    improvement_instructions: PromptInstructions | None
    hidden_instruction: NonEmptyText


class ProviderPromptResult(StrictModel):
    text_by_layer: dict[PromptLayer, str]


class PromptProposalWorkflowInput(StrictModel):
    proposal_id: OpaqueId


class PromptProposalActivityResult(StrictModel):
    proposal_id: OpaqueId
    status: Literal["succeeded", "failed"]
    failure_code: PromptProposalFailureCode | None


PromptProposalWorkflowResult: TypeAlias = PromptProposalActivityResult
```

The provider request/result never crosses the activity boundary. The two
workflow-facing classes contain no source text, result text, provider payload,
credential, endpoint, model ID, or hidden instruction.

- [ ] **Step 4: Add the three explicit starter definitions**

Keep starter bodies plain text, Indonesian by default, stage-specific, and
short enough to edit. Change `PromptStageDefinition.status` to accept
`proposal_ready` and mark all three C2 stages `proposal_ready`.

- [ ] **Step 5: Run focused domain tests and existing C1 domain tests**

```powershell
rtk uv run pytest tests/domain/test_prompt_proposals.py tests/domain/test_prompts.py -q
rtk uv run ruff check src/thoth_control_plane/domain tests/domain
rtk uv run ruff format --check src/thoth_control_plane/domain tests/domain
```

Expected: all pass with no Ruff output.

- [ ] **Step 6: Commit**

```powershell
rtk git add python/src/thoth_control_plane/domain python/tests/domain
rtk git commit -m "feat: define prompt proposal contracts"
```

### Task 2: Add the append-only C2 editor schema

**Files:**

- Create: `python/migrations/editor/0003_prompt_lab_ai_proposals.sql`
- Modify: `python/tests/operations/test_editor_migrations.py:15-50`

**Interfaces:**

- Produces six constrained tables consumed by Task 3.
- Keeps `0001` and `0002` byte-identical.

- [ ] **Step 1: Extend migration tests first**

```python
def test_editor_migrations_add_prompt_proposals_as_third_append_only_file() -> None:
    assert MIGRATION_FILES == [
        "0001_edit_document_revisions.sql",
        "0002_prompt_lab_foundation.sql",
        "0003_prompt_lab_ai_proposals.sql",
    ]


def test_prompt_proposal_schema_enforces_one_active_generation_per_stage() -> None:
    sql = migration("0003_prompt_lab_ai_proposals.sql")
    assert "CREATE UNIQUE INDEX prompt_proposals_one_active_generation" in sql
    assert "WHERE status IN ('queued', 'running')" in sql
```

- [ ] **Step 2: Run the migration test and confirm RED**

```powershell
rtk uv run pytest tests/operations/test_editor_migrations.py -q
```

Expected: fails because migration `0003` is absent.

- [ ] **Step 3: Create the exact schema**

Create:

```sql
CREATE TABLE prompt_provider_preferences (
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, stage_id)
);
CREATE TABLE prompt_layer_locks (
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    layer TEXT NOT NULL CHECK (layer IN ('template', 'project_override')),
    locked BOOLEAN NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, stage_id, layer)
);
CREATE TABLE prompt_proposals (
    proposal_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    kind TEXT NOT NULL CHECK (kind IN ('improve', 'translate')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'applied', 'rejected', 'superseded')),
    target_layers TEXT[] NOT NULL CHECK (
        cardinality(target_layers) BETWEEN 1 AND 2
        AND target_layers <@ ARRAY['template', 'project_override']::TEXT[]
    ),
    source_template_id TEXT NOT NULL,
    source_template_revision INTEGER NOT NULL CHECK (source_template_revision > 0),
    source_binding_revision INTEGER NOT NULL CHECK (source_binding_revision > 0),
    source_language TEXT NOT NULL CHECK (source_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    source_template_body TEXT NOT NULL CHECK (length(btrim(source_template_body)) BETWEEN 1 AND 12000),
    source_project_override TEXT CHECK (source_project_override IS NULL OR length(source_project_override) <= 12000),
    target_language TEXT CHECK (target_language IS NULL OR target_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    improvement_instructions TEXT CHECK (improvement_instructions IS NULL OR length(improvement_instructions) <= 2000),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    translated_template_body TEXT CHECK (translated_template_body IS NULL OR length(btrim(translated_template_body)) BETWEEN 1 AND 12000),
    translated_project_override TEXT CHECK (translated_project_override IS NULL OR length(translated_project_override) <= 12000),
    failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('provider_unavailable', 'provider_timeout', 'provider_rate_limited', 'invalid_provider_output', 'source_revision_changed', 'layer_locked', 'proposal_already_running', 'model_not_allowed', 'store_unavailable', 'workflow_unavailable')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    FOREIGN KEY (project_id, source_template_id, source_template_revision)
        REFERENCES prompt_template_revisions (project_id, template_id, revision),
    CHECK (
        (status IN ('queued', 'running') AND finished_at IS NULL)
        OR (status NOT IN ('queued', 'running') AND finished_at IS NOT NULL)
    )
);
CREATE TABLE prompt_proposal_changes (
    proposal_id TEXT NOT NULL REFERENCES prompt_proposals (proposal_id),
    change_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    layer TEXT NOT NULL CHECK (layer IN ('template', 'project_override')),
    before_text TEXT NOT NULL CHECK (length(before_text) <= 12000),
    after_text TEXT NOT NULL CHECK (length(after_text) <= 12000),
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line),
    PRIMARY KEY (proposal_id, change_id),
    UNIQUE (proposal_id, ordinal)
);
CREATE TABLE prompt_proposal_idempotency (
    project_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE REFERENCES prompt_proposals (proposal_id),
    PRIMARY KEY (project_id, idempotency_key)
);
CREATE TABLE prompt_proposal_applications (
    proposal_id TEXT PRIMARY KEY REFERENCES prompt_proposals (proposal_id),
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    accepted_change_ids TEXT[] NOT NULL,
    approving_actor TEXT NOT NULL,
    resulting_template_id TEXT NOT NULL,
    resulting_template_revision INTEGER NOT NULL CHECK (resulting_template_revision > 0),
    resulting_binding_revision INTEGER NOT NULL CHECK (resulting_binding_revision > 0),
    ownership TEXT NOT NULL CHECK (ownership = 'ai_assisted'),
    approval_mode TEXT NOT NULL CHECK (approval_mode = 'user_approved'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Use the same closed stage constraint as `0002`. Add closed checks for kind,
layer, status, positive revisions, language pattern, text bounds, and terminal
timestamps. Add project/stage indexes, newest-first history index, foreign keys
to exact template/binding source identities, and:

```sql
CREATE UNIQUE INDEX prompt_proposals_one_active_generation
ON prompt_proposals (project_id, stage_id)
WHERE status IN ('queued', 'running');
```

Do not alter earlier migrations and do not introduce a migration framework.

- [ ] **Step 4: Run migration tests and formatting checks**

```powershell
rtk uv run pytest tests/operations/test_editor_migrations.py -q
rtk git diff --check
```

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
rtk git add python/migrations/editor/0003_prompt_lab_ai_proposals.sql python/tests/operations/test_editor_migrations.py
rtk git commit -m "feat: add prompt proposal schema"
```

### Task 3: Implement PostgreSQL preference, lock, and proposal persistence

**Files:**

- Create: `python/src/thoth_control_plane/application/prompt_proposal_ports.py`
- Create: `python/src/thoth_control_plane/infrastructure/prompt_proposal_repository.py`
- Create: `python/tests/infrastructure/test_prompt_proposal_repository.py`

**Interfaces:**

- Produces `PromptProposalRepository` protocol and
  `PostgresPromptProposalRepository` implementation.
- Produces `PromptProposalProvider` and `PromptProposalWorkflowGateway`
  protocols plus typed, safe provider, storage, conflict, and workflow errors.
- Later tasks consume methods with these names:

```python
async def get_preference(project_id, stage_id) -> ProjectPromptModelPreference | None: ...
async def save_preference(project_id, stage_id, request) -> ProjectPromptModelPreference: ...
async def get_locks(project_id, stage_id) -> tuple[ProjectPromptLayerLock, ...]: ...
async def save_lock(project_id, stage_id, layer, request) -> ProjectPromptLayerLock: ...
async def reserve_proposal(proposal, idempotency_key, payload_hash) -> PromptProposal: ...
async def get_proposal(project_id, proposal_id) -> PromptProposal | None: ...
async def list_proposals(project_id, stage_id, cursor, limit) -> PromptProposalPage: ...
async def mark_running(proposal_id) -> PromptProposal: ...
async def record_success(proposal_id, result) -> PromptProposal: ...
async def record_failure(proposal_id, failure_code) -> PromptProposal: ...
async def reject_proposal(project_id, proposal_id) -> PromptProposal: ...
async def apply_improvement(project_id, proposal_id, change_ids, actor) -> PromptProposalApplyResult: ...
async def apply_translation(project_id, proposal_id, actor) -> PromptProposalApplyResult: ...
```

- [ ] **Step 1: Write failing repository contract tests**

Cover parameterized queries, project isolation, optimistic preference/lock
conflicts, idempotency replay, conflicting payload hash, active-generation
uniqueness, bounded cursor pagination, legal transitions, immutable terminal
result, stale source rollback, lock rollback, selected-change Apply, translation
variant creation, and approval provenance.

```python
async def test_idempotency_replay_returns_original_proposal_without_insert() -> None:
    repository, connection = repository_with_rows(existing_idempotency_row())
    result = await repository.reserve_proposal(PROPOSAL, "request-1", "same-hash")
    assert result.proposal_id == PROPOSAL.proposal_id
    assert connection.insert_count == 0
```

- [ ] **Step 2: Run repository tests and confirm RED**

```powershell
rtk uv run pytest tests/infrastructure/test_prompt_proposal_repository.py -q
```

Expected: collection fails because the repository module is absent.

- [ ] **Step 3: Define ports and safe typed errors**

Define specific errors for unavailable storage, revision conflict, idempotency
conflict, active generation, invalid transition, stale source, locked layer,
provider timeout/rate-limit/unavailable/invalid output, workflow unavailable,
and missing project-scoped proposal. Errors contain typed latest resources or
safe codes only; never retain SQL, endpoints, credentials, provider payloads,
or prompt text in messages. Define these exact external ports:

```python
class PromptProposalProvider(Protocol):
    async def propose(self, request: ProviderPromptRequest) -> ProviderPromptResult: ...


class PromptProposalWorkflowGateway(Protocol):
    async def start(self, proposal_id: str) -> None: ...
```

- [ ] **Step 4: Implement preference, lock, proposal, and history operations**

Use short-lived `psycopg.AsyncConnection`, parameterized `%s` values, explicit
row-key tuples, and `FOR UPDATE` for revisioned writes. Clamp history limit to
`1..50`, use an opaque `(created_at, proposal_id)` cursor, and order newest
first.

- [ ] **Step 5: Implement both Apply transactions**

Acquire `pg_advisory_xact_lock(hashtext(project_id), hashtext(stage_id))`, lock
the proposal and current binding rows, recheck proposal status/source/locks,
reconstruct only stored selected hunks, create template/binding revisions, add
one `prompt_proposal_applications` row, then mark the proposal `applied` in the
same transaction. Any failure must roll back all writes.

- [ ] **Step 6: Run repository and predecessor persistence suites**

```powershell
rtk uv run pytest tests/infrastructure/test_prompt_proposal_repository.py tests/infrastructure/test_prompt_repository.py -q
rtk uv run ruff check src/thoth_control_plane/application/prompt_proposal_ports.py src/thoth_control_plane/infrastructure tests/infrastructure
rtk uv run ruff format --check src/thoth_control_plane/application/prompt_proposal_ports.py src/thoth_control_plane/infrastructure tests/infrastructure
```

Expected: pass.

- [ ] **Step 7: Commit**

```powershell
rtk git add python/src/thoth_control_plane/application/prompt_proposal_ports.py python/src/thoth_control_plane/infrastructure/prompt_proposal_repository.py python/tests/infrastructure/test_prompt_proposal_repository.py
rtk git commit -m "feat: persist prompt proposals"
```

### Task 4: Implement Prompt Proposal application use cases

**Files:**

- Create: `python/src/thoth_control_plane/application/prompt_proposals.py`
- Create: `python/tests/application/test_prompt_proposals.py`
- Modify: `python/src/thoth_control_plane/application/__init__.py`

**Interfaces:**

- Consumes `PromptLabRepository`, `PromptProposalRepository`, safe provider
  catalog, and `PromptProposalWorkflowGateway`.
- Produces `PromptProposalService` methods matching the routes in Task 7.

- [ ] **Step 1: Write failing use-case tests**

```python
async def test_create_requires_saved_clean_source_and_starts_one_id_only_workflow() -> None:
    service, proposal_repo, gateway = service_fixture()
    created = await service.create_proposal(
        "project_a", CREATE_IMPROVE, actor=ACTOR, idempotency_key="request-1"
    )
    assert created.status == "queued"
    assert gateway.started == [created.proposal_id]


async def test_apply_rejects_source_revision_drift_before_repository_write() -> None:
    service, proposal_repo, _ = service_fixture(stale=True)
    with pytest.raises(PromptProposalStale):
        await service.apply("project_a", "prop_1", APPLY_ONE_CHANGE, actor=ACTOR)
    assert proposal_repo.apply_calls == []
```

Also test all stages, model capability, empty Improve target, locked layer,
Translate target-language rules, same-key replay, running conflict, safe
workflow-start failure, Reject, Regenerate-by-new-request, and store failures.

- [ ] **Step 2: Run application tests and confirm RED**

```powershell
rtk uv run pytest tests/application/test_prompt_proposals.py -q
```

Expected: collection fails because `PromptProposalService` is absent.

- [ ] **Step 3: Implement validation and creation**

Create an immutable source snapshot from exact template/binding revisions.
Hash the canonical strict request for idempotency. Reserve first, then start a
workflow with only `proposal_id`. If workflow start fails, record
`workflow_unavailable` and raise a safe unavailable error.

- [ ] **Step 4: Implement read, preference, lock, Apply, and Reject methods**

Keep stage registration, catalog capability, source revision, and lock checks
in the application service, then rely on repository revalidation inside Apply.
Return project-scoped not-found for cross-project IDs.

- [ ] **Step 5: Run focused application tests and Ruff**

```powershell
rtk uv run pytest tests/application/test_prompt_proposals.py tests/application/test_prompt_lab.py -q
rtk uv run ruff check src/thoth_control_plane/application tests/application
rtk uv run ruff format --check src/thoth_control_plane/application tests/application
```

Expected: pass.

- [ ] **Step 6: Commit**

```powershell
rtk git add python/src/thoth_control_plane/application python/tests/application/test_prompt_proposals.py
rtk git commit -m "feat: orchestrate prompt proposals"
```

### Task 5: Add the runtime provider catalog and one-request adapter

**Files:**

- Modify: `python/src/thoth_control_plane/config.py`
- Create: `python/src/thoth_control_plane/infrastructure/prompt_provider.py`
- Create: `python/tests/infrastructure/test_prompt_provider.py`
- Modify: `python/tests/test_config.py`

**Interfaces:**

- Consumes `PromptProviderDefinition`, `ProviderPromptRequest`,
  `ProviderPromptResult`, `PromptProposalProvider`, and safe provider errors
  from Tasks 1 and 3.
- Produces `PromptProviderRuntimeDefinition`,
  `Settings.prompt_provider_catalog`, `Settings.prompt_provider_secrets`,
  `public_prompt_provider_catalog(settings)`, and
  `OpenAICompatiblePromptProvider` for Tasks 6 and 7.
- `THOTH_PROMPT_PROVIDER_CATALOG` is a JSON array of runtime definitions;
  `THOTH_PROMPT_PROVIDER_SECRETS` is a worker-only JSON object whose values
  are `SecretStr`. Both default empty so existing environments remain safely
  disabled.

- [ ] **Step 1: Write failing configuration and adapter tests**

```python
def test_catalog_public_projection_omits_endpoint_and_credential_reference() -> None:
    settings = Settings(
        THOTH_CONTROL_PLANE_API_KEY="test-key",
        THOTH_PROMPT_PROVIDER_CATALOG=[RUNTIME_PROVIDER],
    )
    public = public_prompt_provider_catalog(settings)
    assert public[0].provider_id == "novita"
    assert "base_url" not in public[0].model_dump()
    assert "credential_id" not in public[0].model_dump()


async def test_adapter_makes_exactly_one_openai_compatible_request() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"template":"Improved text"}'}}]},
            request=request,
        )

    provider = OpenAICompatiblePromptProvider(
        runtime_catalog=(RUNTIME_PROVIDER,),
        secrets={"novita-main": SecretStr("secret")},
        transport=httpx.MockTransport(handler),
    )
    result = await provider.propose(PROVIDER_REQUEST)
    assert result.text_by_layer == {"template": "Improved text"}
    assert len(calls) == 1
```

Also assert strict JSON parsing, duplicate provider/model rejection, disabled
catalog filtering, unknown credential ID failure, input length/capability
checks, `120.0`-second timeout, redirects disabled, no transport retry, and
safe mapping of timeout, `429`, unavailable, malformed, blank, and oversized
responses. Use `httpx.MockTransport`; no test may contact a network.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run from `python/`:

```powershell
rtk uv run pytest tests/infrastructure/test_prompt_provider.py tests/test_config.py -q
```

Expected: collection fails because `prompt_provider` and the new settings do
not exist.

- [ ] **Step 3: Add strict nested settings and the safe projection**

```python
class PromptProviderRuntimeDefinition(StrictModel):
    provider_id: SafeIdentifier
    label: NonEmptyText
    protocol: Literal["openai_compatible"]
    base_url: AnyHttpUrl
    credential_id: SafeIdentifier
    models: tuple[PromptModelDefinition, ...]
    enabled: bool = True


THOTH_PROMPT_PROVIDER_CATALOG: tuple[PromptProviderRuntimeDefinition, ...] = ()
THOTH_PROMPT_PROVIDER_SECRETS: dict[SafeIdentifier, SecretStr] = Field(default_factory=dict)
```

Validate unique provider IDs and model IDs without interpolating rejected
values into exceptions. The public projection returns only provider/model IDs,
labels, capabilities, input limits, and enabled state. Do not return the
protocol, base URL, credential ID, or secret map.

- [ ] **Step 4: Implement the minimal OpenAI-compatible adapter**

Build one `POST {base_url}/chat/completions` request using the catalog model,
one server-owned system instruction, and plain-text source layers. Require the
assistant content to be a JSON object whose keys exactly match the requested
target layers, then parse it with `json.loads` and the strict domain model.
Construct
an `httpx.AsyncClient(timeout=120.0, follow_redirects=False, transport=...)`
inside the adapter call, set `Authorization: Bearer ...`, and make exactly one
`client.post(url, headers=headers, json=payload)` call. Normalize only
`choices[0].message.content`; discard
the raw response after strict validation. Never log request bodies, response
bodies, endpoints, headers, secrets, or prompt text.

- [ ] **Step 5: Run focused tests and Ruff**

```powershell
rtk uv run pytest tests/infrastructure/test_prompt_provider.py tests/test_config.py -q
rtk uv run ruff check src/thoth_control_plane/config.py src/thoth_control_plane/infrastructure/prompt_provider.py tests/infrastructure/test_prompt_provider.py tests/test_config.py
rtk uv run ruff format --check src/thoth_control_plane/config.py src/thoth_control_plane/infrastructure/prompt_provider.py tests/infrastructure/test_prompt_provider.py tests/test_config.py
```

Expected: pass with no live requests.

- [ ] **Step 6: Commit**

```powershell
rtk git add python/src/thoth_control_plane/config.py python/src/thoth_control_plane/infrastructure/prompt_provider.py python/tests/infrastructure/test_prompt_provider.py python/tests/test_config.py
rtk git commit -m "feat: configure prompt proposal providers"
```

### Task 6: Run proposal generation through an ID-only Temporal workflow

**Files:**

- Create: `python/src/thoth_control_plane/activities/prompt_proposal.py`
- Modify: `python/src/thoth_control_plane/activities/__init__.py`
- Create: `python/src/thoth_control_plane/workflows/prompt_proposal.py`
- Modify: `python/src/thoth_control_plane/workflows/__init__.py`
- Create: `python/src/thoth_control_plane/infrastructure/prompt_proposal_gateway.py`
- Modify: `python/src/thoth_control_plane/worker.py`
- Create: `python/tests/activities/test_prompt_proposal.py`
- Create: `python/tests/workflows/test_prompt_proposal.py`
- Create: `python/tests/infrastructure/test_prompt_proposal_gateway.py`
- Modify: `python/tests/test_worker.py`

**Interfaces:**

- Consumes the Task 3 repository, Task 5 provider, and
  `PromptProposalWorkflowGateway` protocol from Task 3.
- Produces `PROMPT_PROPOSAL_TASK_QUEUE = "thoth-prompt-proposals"`,
  `PromptProposalActivity.run(proposal_id: str) -> PromptProposalActivityResult`,
  `PromptProposalWorkflow.run(input: PromptProposalWorkflowInput) -> PromptProposalWorkflowResult`,
  `TemporalPromptProposalGateway.start(proposal_id: str) -> None`, and
  `build_prompt_proposal_worker(client, settings) -> Worker`.
- Every history-facing input/result contains only proposal ID, safe status, and
  safe failure code.

- [ ] **Step 1: Write failing workflow, activity, gateway, and worker tests**

```python
async def test_activity_calls_provider_once_and_persists_success() -> None:
    activity, repository, provider = activity_fixture()
    result = await activity.run("proposal_1")
    assert result == PromptProposalActivityResult(
        proposal_id="proposal_1", status="succeeded", failure_code=None
    )
    assert provider.calls == 1
    assert repository.transitions == ["running", "succeeded"]


async def test_gateway_starts_id_only_workflow_without_retrying_start() -> None:
    client = RecordingTemporalClient()
    gateway = TemporalPromptProposalGateway(client)
    await gateway.start("proposal_1")
    assert client.input == PromptProposalWorkflowInput(proposal_id="proposal_1")
    assert client.task_queue == PROMPT_PROPOSAL_TASK_QUEUE
```

Assert success, normalized provider failures, repository failure before and
after the provider call, exactly one provider invocation, deterministic hunk
construction, translation layer preservation, no prompt text in activity
result/workflow input/workflow result, `RetryPolicy(maximum_attempts=1)`, a
135-second activity start-to-close timeout, idempotent workflow ID, separate
queue registration, and worker startup failure when an enabled catalog lacks
database access or its worker-only credential.

- [ ] **Step 2: Run the new tests and confirm RED**

```powershell
rtk uv run pytest tests/activities/test_prompt_proposal.py tests/workflows/test_prompt_proposal.py tests/infrastructure/test_prompt_proposal_gateway.py tests/test_worker.py -q
```

Expected: collection fails because the proposal activity, workflow, and
gateway modules are absent.

- [ ] **Step 3: Implement the activity boundary**

The activity loads the proposal by ID, marks it running, builds the typed
provider request from the persisted source snapshot, calls
`provider.propose(...)` once, computes deterministic changes for Improve or
complete layer values for Translate, and persists one terminal result. Catch
only typed provider failures and store their safe codes. Let cancellation and
unexpected persistence failures propagate without a second provider call.

- [ ] **Step 4: Implement the deterministic workflow and gateway**

```python
@workflow.run
async def run(self, input: PromptProposalWorkflowInput) -> PromptProposalWorkflowResult:
    return await workflow.execute_activity(
        PromptProposalActivity.run,
        input.proposal_id,
        start_to_close_timeout=timedelta(seconds=135),
        retry_policy=RetryPolicy(maximum_attempts=1),
    )
```

The gateway uses workflow ID `prompt-proposal/{proposal_id}`, the dedicated
queue, and treats Temporal's already-started outcome as idempotent success.
Do not add memo, search attributes, query payloads, signals, or logs containing
prompt content.

- [ ] **Step 5: Register the dedicated worker in the existing process**

Construct `PostgresPromptProposalRepository` from the restricted editor URL
and `OpenAICompatiblePromptProvider` from the validated catalog/secrets. Run
the source, legacy adapter, and proposal `Worker` instances concurrently with
the existing cancellation behavior. Keep proposal activity concurrency at
one initially; do not introduce a process or service.

- [ ] **Step 6: Run focused tests and Ruff**

```powershell
rtk uv run pytest tests/activities/test_prompt_proposal.py tests/workflows/test_prompt_proposal.py tests/infrastructure/test_prompt_proposal_gateway.py tests/test_worker.py -q
rtk uv run ruff check src/thoth_control_plane/activities src/thoth_control_plane/workflows src/thoth_control_plane/infrastructure/prompt_proposal_gateway.py src/thoth_control_plane/worker.py tests/activities/test_prompt_proposal.py tests/workflows/test_prompt_proposal.py tests/infrastructure/test_prompt_proposal_gateway.py tests/test_worker.py
rtk uv run ruff format --check src/thoth_control_plane/activities src/thoth_control_plane/workflows src/thoth_control_plane/infrastructure/prompt_proposal_gateway.py src/thoth_control_plane/worker.py tests/activities/test_prompt_proposal.py tests/workflows/test_prompt_proposal.py tests/infrastructure/test_prompt_proposal_gateway.py tests/test_worker.py
```

Expected: pass; all provider calls are fakes.

- [ ] **Step 7: Commit**

```powershell
rtk git add python/src/thoth_control_plane/activities python/src/thoth_control_plane/workflows python/src/thoth_control_plane/infrastructure/prompt_proposal_gateway.py python/src/thoth_control_plane/worker.py python/tests/activities/test_prompt_proposal.py python/tests/workflows/test_prompt_proposal.py python/tests/infrastructure/test_prompt_proposal_gateway.py python/tests/test_worker.py
rtk git commit -m "feat: run prompt proposal workflows"
```

### Task 7: Expose authenticated Prompt Proposal APIs

**Files:**

- Create: `python/src/thoth_control_plane/api/routes/prompt_proposals.py`
- Modify: `python/src/thoth_control_plane/api/app.py`
- Create: `python/tests/api/test_prompt_proposals.py`

**Interfaces:**

- Consumes `PromptProposalService`, `PostgresPromptProposalRepository`,
  `TemporalPromptProposalGateway`, and the safe catalog projection.
- Produces exactly the authenticated `/api/v1` routes listed in design
  section 9, with project-scoped reads and safe `202`, `404`, `409`, `422`,
  and `503` responses.
- Extends `create_app(...)` with optional injected proposal repository,
  proposal workflow gateway, and provider catalog for isolated tests.

The router must expose exactly:

```text
GET  /prompt-providers
GET  /prompt-stages/{stage_id}/starter
GET  /projects/{project_id}/prompt-lab/preferences/{stage_id}
PUT  /projects/{project_id}/prompt-lab/preferences/{stage_id}
GET  /projects/{project_id}/prompt-lab/locks/{stage_id}
PUT  /projects/{project_id}/prompt-lab/locks/{stage_id}/{layer}
POST /projects/{project_id}/prompt-lab/proposals
GET  /projects/{project_id}/prompt-lab/proposals?stage_id={stage_id}&cursor={cursor}&limit={limit}
GET  /projects/{project_id}/prompt-lab/proposals/{proposal_id}
POST /projects/{project_id}/prompt-lab/proposals/{proposal_id}/apply
POST /projects/{project_id}/prompt-lab/proposals/{proposal_id}/reject
```

- [ ] **Step 1: Write failing API contract tests**

```python
async def test_create_returns_202_and_never_serializes_runtime_provider_fields() -> None:
    app = proposal_app()
    response = await request(
        app,
        "POST",
        "/api/v1/projects/project_a/prompt-lab/proposals",
        json=CREATE_IMPROVEMENT,
    )
    assert response.status_code == 202
    assert response.json()["proposal_id"] == "proposal_1"
    assert "base_url" not in response.text
    assert "credential" not in response.text


async def test_cross_project_proposal_lookup_is_not_found() -> None:
    response = await request(
        proposal_app(),
        "GET",
        "/api/v1/projects/project_b/prompt-lab/proposals/proposal_1",
    )
    assert response.status_code == 404
```

Cover all catalog, starter, preference, lock, create, bounded history, detail,
Apply, and Reject routes; authentication; stage/layer validation; pagination;
idempotency replay; revision and active-generation conflicts; stale/locked
Apply; store/workflow unavailability; and secret/prompt-safe errors.

- [ ] **Step 2: Run the API tests and confirm RED**

```powershell
rtk uv run pytest tests/api/test_prompt_proposals.py -q
```

Expected: collection or routing fails because the new router is absent.

- [ ] **Step 3: Implement request models, handlers, and safe error mapping**

Use strict Pydantic request bodies and the existing authentication dependency.
Return `202` only for proposal creation, `200` for reads/writes, and typed
`detail.code` values for known errors. Apply accepts only `change_ids` and
expected source revisions; it never accepts replacement text. The list route
requires `stage_id`, clamps `limit` to `1..50`, and accepts only the opaque
cursor emitted by the repository.

- [ ] **Step 4: Wire the application factory**

When no test doubles are supplied, build the repository from
`THOTH_EDITOR_DATABASE_URL`, connect the Temporal gateway with the existing
lifespan client, and expose the safe catalog even when it is empty. Missing
editor storage or Temporal connectivity must yield safe `503` behavior rather
than startup-time secret disclosure. Include the router once under `/api/v1`.

- [ ] **Step 5: Run API regression tests and Ruff**

```powershell
rtk uv run pytest tests/api/test_prompt_proposals.py tests/api/test_prompt_lab.py tests/api/test_workflows.py -q
rtk uv run ruff check src/thoth_control_plane/api tests/api
rtk uv run ruff format --check src/thoth_control_plane/api tests/api
```

Expected: pass.

- [ ] **Step 6: Commit**

```powershell
rtk git add python/src/thoth_control_plane/api python/tests/api/test_prompt_proposals.py
rtk git commit -m "feat: expose prompt proposal APIs"
```

### Task 8: Regenerate OpenAPI types and extend the dashboard client

**Files:**

- Modify: `python/openapi.json`
- Modify: `dashboard/src/api/generated/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.test.ts`

**Interfaces:**

- Consumes Task 7's OpenAPI operations.
- Produces typed client methods `listPromptProviders`, `getPromptStarter`,
  `getPromptPreference`, `savePromptPreference`, `getPromptLocks`,
  `savePromptLock`, `createPromptProposal`, `listPromptProposals`,
  `getPromptProposal`, `applyPromptProposal`, and `rejectPromptProposal`.
- Reuses the existing API base URL, `X-API-Key` handling, abort behavior, and
  safe error normalization.

- [ ] **Step 1: Write failing client tests against the intended methods**

```typescript
test("createPromptProposal sends one authenticated idempotent request", async () => {
  const fetch = recordingFetch(202, PROPOSAL);
  const client = createControlPlaneClient({ baseUrl: "http://api", apiKey: "key", fetch });
  await client.createPromptProposal("project_a", CREATE_IMPROVEMENT);
  expect(fetch.calls).toHaveLength(1);
  expect(fetch.calls[0]?.headers).toMatchObject({ "X-API-Key": "key" });
  expect(fetch.calls[0]?.body).not.toContain("base_url");
});
```

Also cover URL encoding, `stage_id`/cursor query parameters, `202` parsing,
empty catalog, all write methods, `409` typed errors, and abort propagation.

- [ ] **Step 2: Run the client tests and confirm RED**

Run from `dashboard/`:

```powershell
rtk bun test src/api/control-plane.test.ts
```

Expected: TypeScript/runtime failures because the proposal client methods are
absent.

- [ ] **Step 3: Export the deterministic OpenAPI document and generated types**

```powershell
rtk uv run --project ../python python ../python/scripts/export_openapi.py
rtk bun run generate:control-plane-types
```

Inspect the diff and confirm that only the new C2 operations/schemas changed;
do not hand-edit `dashboard/src/api/generated/control-plane.ts`.

- [ ] **Step 4: Add the thin typed control-plane methods**

Follow the existing `request<T>` implementation. Each method constructs only
the documented route/body and returns the generated response type. Keep all
polling, proposal state, and retries outside this client; one method call must
mean one HTTP request.

- [ ] **Step 5: Run client tests, generation stability, and typecheck**

```powershell
rtk bun test src/api/control-plane.test.ts
rtk uv run --project ../python python ../python/scripts/export_openapi.py
rtk bun run generate:control-plane-types
rtk git diff --check -- ../python/openapi.json src/api/generated/control-plane.ts src/api/control-plane.ts src/api/control-plane.test.ts
rtk bun run build
```

Expected: tests and build pass; the second generation leaves no additional
diff.

- [ ] **Step 6: Commit**

```powershell
rtk git add ../python/openapi.json src/api/generated/control-plane.ts src/api/control-plane.ts src/api/control-plane.test.ts
rtk git commit -m "feat: add prompt proposal client"
```

### Task 9: Add a pure dashboard proposal state machine

**Files:**

- Create: `dashboard/src/features/studio/prompt_proposal_state.ts`
- Create: `dashboard/src/features/studio/prompt_proposal_state.test.ts`

**Interfaces:**

- Consumes generated provider, preference, lock, proposal, and page types.
- Produces `PromptProposalState`, `PromptProposalAction`,
  `createPromptProposalState(stageId)`, `promptProposalReducer`,
  `canGenerateProposal`, and `canApplyProposal`.
- Does not import or mutate `PromptLabState`; PromptLab passes only current
  stage, saved revisions, dirty/offline facts, and API resources.

- [ ] **Step 1: Write failing reducer and selector tests**

```typescript
test("stage changes discard view state but not server-owned resources", () => {
  const next = promptProposalReducer(READY_STATE, {
    type: "stage_selected",
    stageId: "visual_plan",
  });
  expect(next.stageId).toBe("visual_plan");
  expect(next.selectedChangeIds).toEqual([]);
  expect(next.activeProposal).toBeNull();
});

test("offline and dirty authoring state fail closed", () => {
  expect(canGenerateProposal(READY_STATE, { online: false, formDirty: false })).toBe(false);
  expect(canGenerateProposal(READY_STATE, { online: true, formDirty: true })).toBe(false);
});
```

Cover initial/loading/ready/offline/error states, catalog and preference
selection, optimistic revision conflicts, both locks, one active generation,
poll lifecycle, terminal status, history append/reload, stale-source display,
Improve hunk toggling, Translate whole-only Apply, Reject, and safe recovery
without authoring draft data.

- [ ] **Step 2: Run reducer tests and confirm RED**

```powershell
rtk bun test src/features/studio/prompt_proposal_state.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the closed action union and pure reducer**

Keep server resources as immutable values. Reset selection on proposal or
stage change. Automatically select no Improve hunks; the user must choose at
least one. Translate never exposes hunk selection. Store only safe error codes
and poll attempt counters, not timers, Promises, credentials, endpoints, or
raw provider payloads.

- [ ] **Step 4: Implement explicit enablement selectors**

`canGenerateProposal` requires online, clean saved target revisions, enabled
provider/model capability, unlocked target layers, and no queued/running
proposal. `canApplyProposal` additionally requires `succeeded`, unchanged
source revisions, unlocked target layers, and either selected Improve changes
or a whole Translate proposal. Return a separate visible disabled-reason key
for each failed predicate.

- [ ] **Step 5: Run reducer tests and lint**

```powershell
rtk bun test src/features/studio/prompt_proposal_state.test.ts
rtk bun run lint
```

Expected: reducer tests pass; no new lint errors.

- [ ] **Step 6: Commit**

```powershell
rtk git add src/features/studio/prompt_proposal_state.ts src/features/studio/prompt_proposal_state.test.ts
rtk git commit -m "feat: model prompt proposal state"
```

### Task 10: Integrate starters, locks, generation, review, and recovery in Prompt Lab

**Files:**

- Create: `dashboard/src/features/studio/PromptProposalPanel.tsx`
- Create: `dashboard/src/features/studio/PromptProposalPanel.test.tsx`
- Modify: `dashboard/src/features/studio/PromptLab.tsx`
- Modify: `dashboard/src/features/studio/PromptLab.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`

**Interfaces:**

- Consumes the Task 8 client, Task 9 reducer, and current C1 Prompt Lab saved
  source/draft state.
- Produces one stage-scoped `PromptProposalPanel` and starter/scratch controls
  without changing C1 save or offline-recovery ownership.

- [ ] **Step 1: Write failing component integration tests**

```tsx
test("Use starter copies text locally and does not call a write API", async () => {
  const api = proposalClient();
  render(<PromptLab client={api} projectId="project_a" />);
  await user.click(await screen.findByRole("button", { name: "Use starter" }));
  expect(screen.getByLabelText("Template body")).toHaveValue(STARTER.body);
  expect(api.saveTemplate).not.toHaveBeenCalled();
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
});

test("refresh-shaped remount resumes one persisted running proposal", async () => {
  const api = proposalClient({ proposals: [RUNNING_PROPOSAL, SUCCEEDED_PROPOSAL] });
  const first = render(<PromptLab client={api} projectId="project_a" />);
  first.unmount();
  render(<PromptLab client={api} projectId="project_a" />);
  expect(await screen.findByText("Proposal ready for review")).toBeInTheDocument();
  expect(api.createPromptProposal).not.toHaveBeenCalled();
});
```

Also cover Create scratch, all three stages, server allowlisted provider/model
selectors, preference save/conflict, both lock controls, Save-before-Generate,
Improve instructions, Translate language, one create request per click,
queued/running status accessibility, terminal polling stop, offline polling
pause/reconnect resume, stale source, selectable Improve hunks, whole-only
Translate Apply, Reject, Regenerate, history, safe errors, keyboard access,
listener/timer cleanup, and preservation of unsaved C1 drafts.

- [ ] **Step 2: Run component tests and confirm RED**

```powershell
rtk bun test src/features/studio/PromptProposalPanel.test.tsx src/features/studio/PromptLab.test.tsx src/features/studio/GuidedStudio.test.tsx
```

Expected: missing component/actions and assertion failures.

- [ ] **Step 3: Add local starter and scratch entry points**

Render `Use starter` and `Create scratch` only when the selected stage has no
binding. Starter fetch is read-only; both actions dispatch through the existing
C1 form actions and leave `formDirty=true`. Never auto-select, auto-save, or
write a starter during project/stage load.

- [ ] **Step 4: Implement the proposal panel**

Use native form controls and existing Studio styles. Render safe provider and
model `<select>` elements, explicit preference Save, template/override lock
buttons, optional Improve instructions, Translate language input, status,
history, plain-text comparison, Apply, Reject, and Regenerate. Improve renders
checkboxes keyed by stable `change_id`; Translate renders complete template
and override blocks with one Apply action. Never use `dangerouslySetInnerHTML`.

- [ ] **Step 5: Implement bounded polling with cleanup**

Use one `useEffect` that schedules the next `getPromptProposal` only after the
previous request settles. Guard completion with a local `active` boolean and
clear the timeout in cleanup. Poll only `queued`/`running`, stop on terminal
state, pause when `navigator.onLine` is false, and reload active/history state
before resuming on the browser `online` event. Do not add polling to the API
client or retry create/apply requests.

- [ ] **Step 6: Integrate without merging reducers**

`PromptLab` remains owner of C1 form and save state. Pass the selected stage,
saved template/binding revisions, saved layer texts, `formDirty`, and online
state into `PromptProposalPanel`. After successful Apply, reload stage data
through the existing C1 path; do not directly overwrite its drafts from C2.
`GuidedStudio` supplies the existing control-plane client unchanged.

- [ ] **Step 7: Run focused dashboard tests, lint, and build**

```powershell
rtk bun test src/features/studio/prompt_proposal_state.test.ts src/features/studio/PromptProposalPanel.test.tsx src/features/studio/PromptLab.test.tsx src/features/studio/GuidedStudio.test.tsx src/api/control-plane.test.ts
rtk bun run lint
rtk bun run build
```

Expected: all focused tests and build pass; only pre-existing lint warnings
remain.

- [ ] **Step 8: Commit**

```powershell
rtk git add src/features/studio/PromptProposalPanel.tsx src/features/studio/PromptProposalPanel.test.tsx src/features/studio/PromptLab.tsx src/features/studio/PromptLab.test.tsx src/features/studio/GuidedStudio.tsx src/features/studio/GuidedStudio.test.tsx
rtk git commit -m "feat: add prompt proposal studio"
```

### Task 11: Wire disabled-by-default Stage 1 runtime configuration

**Files:**

- Modify: `compose.stage1.local.yml`
- Modify: `.env.stage1.local.example`
- Modify: `python/tests/deployment/test_local_stage1_compose_contract.py`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes Task 5 settings and Task 6 worker registration.
- Produces disabled-by-default Compose wiring: the API receives the provider
  catalog only; the worker receives the same catalog, worker-only secret map,
  and restricted editor database URL.
- Does not enable a provider, use a real credential, deploy, pull, build, or
  contact any provider.

- [ ] **Step 1: Extend deployment contract tests first**

```python
def test_prompt_provider_secrets_are_worker_only() -> None:
    compose = load_stage1_compose()
    assert "THOTH_PROMPT_PROVIDER_CATALOG" in compose["services"]["api"]["environment"]
    assert "THOTH_PROMPT_PROVIDER_SECRETS" not in compose["services"]["api"]["environment"]
    assert "THOTH_PROMPT_PROVIDER_SECRETS" in compose["services"]["worker"]["environment"]
    assert "THOTH_EDITOR_DATABASE_URL" in compose["services"]["worker"]["environment"]
```

Also assert the example catalog is `[]`, the example secret map is `{}`, no
credential value appears in the image or API service, and the existing
digest-pinning, network, volume, health, and CDP contracts remain unchanged.

- [ ] **Step 2: Run deployment tests and confirm RED**

Run from `python/`:

```powershell
rtk uv run pytest tests/deployment/test_local_stage1_compose_contract.py tests/deployment/test_container_contract.py -q
```

Expected: assertions fail because the new environment wiring is absent.

- [ ] **Step 3: Add the minimal Compose and example environment entries**

Add `THOTH_PROMPT_PROVIDER_CATALOG` to API and worker, and add
`THOTH_PROMPT_PROVIDER_SECRETS` plus the existing editor PostgreSQL URL to the
worker only. Keep example values empty JSON. Do not put a key, endpoint,
provider, model, or enabled catalog into the example. Do not change service
images, ports, networks, mounts, restart policy, or healthchecks.

- [ ] **Step 4: Validate configuration and regression contracts**

Run from repository root:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py python/tests/deployment/test_container_contract.py -q
rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
rtk git diff --check
```

Expected: pass without starting containers.

- [ ] **Step 5: Commit**

```powershell
rtk git add compose.stage1.local.yml .env.stage1.local.example python/tests/deployment/test_local_stage1_compose_contract.py python/tests/deployment/test_container_contract.py
rtk git commit -m "chore: wire prompt proposal runtime"
```

### Task 12: Run the complete offline gate and record the handoff

**Files:**

- Modify: `CHANGELOG.md`
- Modify locally only: `.superpowers/sdd/2026-09-13-creator-studio-prompt-lab-ai-proposals/progress.md`

**Interfaces:**

- Consumes all Tasks 1–11.
- Produces a reproducible offline verification record and returns control to
  Codex review. It does not authorize push, publication, deployment, provider
  smoke, or any Stage 1 mutation.

- [ ] **Step 1: Run the complete Python offline gate**

Run from repository root:

```powershell
rtk uv sync --project python --frozen --all-groups --extra acquisition
rtk uv run --project python pytest -m "not live" -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
```

Expected: all non-live tests pass and Ruff emits no errors.

- [ ] **Step 2: Verify generated contracts and the complete dashboard**

```powershell
rtk uv run --project python python python/scripts/export_openapi.py
rtk bun --cwd dashboard run generate:control-plane-types
rtk bun --cwd dashboard test
rtk bun --cwd dashboard run lint
rtk bun --cwd dashboard run build
```

Expected: generation is stable, tests/build pass, and no new lint warning is
introduced.

- [ ] **Step 3: Run unchanged Scout and Compose gates**

```powershell
rtk bun --cwd scout install --frozen-lockfile
rtk bun --cwd scout run test:acquisition
rtk bun --cwd scout run test:runtime
rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
rtk git diff --check
```

Expected: all gates pass without a live request or container startup.

- [ ] **Step 4: Update durable and local progress records**

Add one concise C2 completed-work entry to `CHANGELOG.md` naming the proposal
workflow, safe provider catalog, durable review/Apply, UI recovery, and offline
gate results. Update the ignored SDD `progress.md` with each task commit, exact
test counts, warnings, and remaining operator gates. Do not use `BLUEPRINT.md`
as the progress log or edit the two untracked operator files.

- [ ] **Step 5: Inspect the final scope and commit documentation**

```powershell
rtk git status --short
rtk git diff --stat HEAD~11..HEAD
rtk git diff --check
rtk git diff -- CHANGELOG.md
rtk git add CHANGELOG.md
rtk git commit -m "docs: record prompt proposal delivery"
```

Expected: the tracked worktree is clean after the commit; only the two known
untracked operator files remain. Do not push.

- [ ] **Step 6: Return the offline handoff**

Report baseline/final commit IDs, ordered task commits, files changed, RED and
GREEN evidence per task, complete gate output with test counts, generated-file
stability, known warnings, security assertions, and remaining boundaries.
Finish with: `Offline C2 implementation complete; Codex review required before push.`
