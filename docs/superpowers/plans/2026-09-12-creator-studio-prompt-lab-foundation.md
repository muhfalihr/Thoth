# Creator Studio Prompt Lab Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-scoped, durable Prompt Lab for authoring reusable prompt
template revisions, project overrides, and safe visible resolved previews without
calling an AI provider.

**Architecture:** The Python control plane owns the stage registry, strict prompt
models, PostgreSQL persistence, conflict rules, and resolved-preview composition.
React consumes generated OpenAPI types, keeps Prompt Lab state local to the mounted
Studio workspace, and uses existing controls and design tokens.

**Tech Stack:** Python 3.11–3.13, Pydantic v2, FastAPI, psycopg 3, PostgreSQL 16,
React 19.2.7, TypeScript 6, Bun, Tailwind CSS 4, existing generated OpenAPI client.

**Spec:**
`docs/superpowers/specs/2026-09-12-creator-studio-prompt-lab-foundation-design.md`

## Global Constraints

- Work only on `codex/stage1-container-ci`; inspect drift from baseline before edits.
- Preserve `compose.stage1.controlled-fallback.yml` and
  `docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md`.
- Prefix shell commands with `rtk`; use Docker only, never Podman.
- Use TDD. Every commit has one short English subject, no body, trailers, or
  `Co-Authored-By` line.
- Add no dependency, ORM, state library, provider SDK, or new service.
- C1 performs no provider/live request and defines no improve, translate,
  proposal, or apply-proposal endpoint.
- User prompt text is bounded plain data. Never render it as HTML or expose
  hidden policy, credentials, paths, URLs, SQL, or raw provider payloads.
- Do not push, publish, deploy, restart services, run a live gate, mutate Stage 1
  evidence, or open an acceptance window.
- Update `BLUEPRINT.md` only after every final verification gate passes.

---

## File Map

- `python/src/thoth_control_plane/domain/prompts.py`: strict prompt types, stage
  registry, and pure resolved-draft composition.
- `python/src/thoth_control_plane/application/prompt_lab.py`: application use
  cases and safe errors.
- `python/src/thoth_control_plane/application/ports.py`: prompt repository seam
  and conflict types.
- `python/src/thoth_control_plane/infrastructure/prompt_repository.py`: atomic,
  project-scoped PostgreSQL operations.
- `python/src/thoth_control_plane/api/routes/prompt_lab.py`: authenticated API.
- `python/migrations/editor/0002_prompt_lab_foundation.sql`: two C1 tables.
- `dashboard/src/features/studio/prompt_lab_state.ts`: pure Prompt Lab reducer.
- `dashboard/src/features/studio/PromptLab.tsx`: accessible authoring workspace.
- `dashboard/src/features/studio/GuidedStudio.tsx`: stable Scenes/Prompt Lab tabs.

### Task 1: Define prompt contracts and visible resolution

**Files:**
- Create: `python/src/thoth_control_plane/domain/prompts.py`
- Modify: `python/src/thoth_control_plane/domain/__init__.py`
- Create: `python/tests/domain/test_prompts.py`

**Interfaces:**
- Produces `PromptStageId`, `PromptStageDefinition`,
  `PromptTemplateRevision`, `SavePromptTemplateRequest`,
  `ProjectPromptBinding`, `SaveProjectPromptBindingRequest`,
  `ResolvedPromptSection`, `ResolvedPromptDraft`, `PROMPT_STAGES`, and
  `resolve_prompt_draft(template, binding)`.
- `SavePromptTemplateRequest.template_id` and `base_revision` are both absent for
  creation or both present for a revision.
- `SaveProjectPromptBindingRequest.base_revision` is absent only when creating
  the first binding.

- [ ] **Step 1: Write failing domain tests.** Assert exact ordered stage IDs and
  `draft_only` status; strict rejection of unknown fields/stages, blank or
  over-12,000-character bodies, invalid language tags, partial template revision
  identity, and negative revisions. Assert resolution rejects project/stage
  mismatches and returns exactly the labelled template section plus an optional
  project-override section.

```python
def test_resolve_prompt_draft_labels_only_visible_sections() -> None:
    template = PromptTemplateRevision(
        project_id="project_a", template_id="ptpl_001", revision=1,
        stage_id="narrative_plan", language="id-ID", body="Write a hook",
    )
    binding = ProjectPromptBinding(
        project_id="project_a", stage_id="narrative_plan",
        template_id="ptpl_001", template_revision=1,
        project_override="Use Indonesian", revision=1,
    )

    resolved = resolve_prompt_draft(template, binding)

    assert [section.kind for section in resolved.sections] == ["template", "project_override"]
    assert resolved.visible_text == "Template\nWrite a hook\n\nProject override\nUse Indonesian"
```

- [ ] **Step 2: Verify RED.** From `python`, run:

```powershell
rtk uv run pytest tests/domain/test_prompts.py -q
```

Expected: collection fails because `thoth_control_plane.domain.prompts` does not
exist.

- [ ] **Step 3: Implement the minimal strict models and pure resolver.** Use the
existing `StrictModel`, `OpaqueId`, and `ProjectId`. Keep the registry as a tuple
of the three literal-backed definitions and compose visible text without
templates, HTML, or variable interpolation.

```python
PromptStageId: TypeAlias = Literal["narrative_plan", "visual_plan", "caption_copy"]
PROMPT_STAGES = (
    PromptStageDefinition(stage_id="narrative_plan", label="Narrative plan", status="draft_only"),
    PromptStageDefinition(stage_id="visual_plan", label="Visual plan", status="draft_only"),
    PromptStageDefinition(stage_id="caption_copy", label="Caption and copy", status="draft_only"),
)

def resolve_prompt_draft(
    template: PromptTemplateRevision, binding: ProjectPromptBinding
) -> ResolvedPromptDraft:
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
```

- [ ] **Step 4: Verify GREEN and quality.** Run the focused test, existing domain
  tests, Ruff check, and Ruff format check.

```powershell
rtk uv run pytest tests/domain/test_prompts.py tests/domain/test_edit_documents.py -q
rtk uv run ruff check src/thoth_control_plane/domain tests/domain/test_prompts.py
rtk uv run ruff format --check src/thoth_control_plane/domain tests/domain/test_prompts.py
```

- [ ] **Step 5: Commit.**

```powershell
rtk git add python/src/thoth_control_plane/domain python/tests/domain/test_prompts.py
rtk git commit -m "define prompt lab contracts"
```

### Task 2: Add the editor migration and atomic prompt repository

**Files:**
- Create: `python/migrations/editor/0002_prompt_lab_foundation.sql`
- Create: `python/src/thoth_control_plane/infrastructure/prompt_repository.py`
- Modify: `python/src/thoth_control_plane/application/ports.py`
- Create: `python/tests/infrastructure/test_prompt_repository.py`
- Create: `python/tests/operations/test_editor_migrations.py`

**Interfaces:**
- Produces `PromptLabRepository` with `list_template_heads`,
  `get_template_revision`, `save_template`, `get_binding`, and `save_binding`.
- Produces `PromptTemplateRevisionConflict(latest)` and
  `PromptBindingRevisionConflict(latest)`.
- Every repository method requires `project_id`; a cross-project template lookup
  behaves exactly like a missing template.

- [ ] **Step 1: Write failing migration and repository tests.** Use the existing
  fake async connection/cursor pattern from `test_editor_repository.py`. Assert
  parameterized SQL, project ID in every lookup, one head per template, append as
  revision one for creation, compare-and-append for revision, atomic binding
  upsert, `FOR UPDATE`/advisory locking, safe conflicts carrying latest validated
  models, missing references, invalid stored rows, and safe persistence errors.

```python
async def test_save_template_scopes_revision_lookup_to_project(monkeypatch) -> None:
    existing = PromptTemplateRevision(
        project_id="project_a", template_id="ptpl_001", revision=1,
        stage_id="narrative_plan", language="id-ID", body="Original prompt",
    )
    cursor = Cursor(rows=[(existing.model_dump(mode="json"),)])
    async def connect(_: str) -> Connection:
        return Connection(cursor)
    monkeypatch.setattr(
        "thoth_control_plane.infrastructure.prompt_repository.AsyncConnection.connect",
        connect,
    )
    repository = PostgresPromptLabRepository("postgresql://restricted")
    saved = await repository.save_template(
        project_id="project_a",
        template_id="ptpl_001",
        base_revision=1,
        stage_id="narrative_plan",
        language="id-ID",
        body="Updated prompt",
    )
    query, parameters = cursor.calls[1]
    assert "project_id = %s" in query
    assert parameters[:2] == ("project_a", "ptpl_001")
    assert saved.revision == 2
```

- [ ] **Step 2: Verify RED.** Run:

```powershell
rtk uv run pytest tests/infrastructure/test_prompt_repository.py tests/operations/test_editor_migrations.py -q
```

Expected: imports or migration-count assertions fail before the repository and
second migration exist.

- [ ] **Step 3: Add the exact schema.** Use check constraints matching domain
  bounds and project-scoped keys. Do not add a migration framework or tracking
  table.

```sql
CREATE TABLE IF NOT EXISTS prompt_template_revisions (
    project_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 12000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, template_id, revision)
);

CREATE TABLE IF NOT EXISTS project_prompt_bindings (
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    template_id TEXT NOT NULL,
    template_revision INTEGER NOT NULL CHECK (template_revision > 0),
    project_override TEXT CHECK (project_override IS NULL OR length(project_override) <= 12000),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, stage_id),
    FOREIGN KEY (project_id, template_id, template_revision)
        REFERENCES prompt_template_revisions (project_id, template_id, revision)
);
```

- [ ] **Step 4: Implement the deep repository.** Generate no IDs here. Lock on
  project/template or project/stage, validate selected rows into domain models,
  compare `base_revision`, and perform one append/update in the same connection
  context. Catch driver errors only at the outer boundary and raise
  `PromptLabPersistenceError` without diagnostics.

```python
class PostgresPromptLabRepository:
    async def save_template(
        self, *, project_id: str, template_id: str, base_revision: int | None,
        stage_id: PromptStageId, language: str, body: str,
    ) -> PromptTemplateRevision: ...

    async def save_binding(
        self, *, project_id: str, stage_id: PromptStageId,
        request: SaveProjectPromptBindingRequest,
    ) -> ProjectPromptBinding: ...
```

- [ ] **Step 5: Verify GREEN and commit.**

```powershell
rtk uv run pytest tests/infrastructure/test_prompt_repository.py tests/operations/test_editor_migrations.py -q
rtk uv run ruff check src/thoth_control_plane/infrastructure src/thoth_control_plane/application/ports.py tests/infrastructure/test_prompt_repository.py
rtk uv run ruff format --check src/thoth_control_plane/infrastructure src/thoth_control_plane/application/ports.py tests/infrastructure/test_prompt_repository.py
rtk git add python/migrations/editor/0002_prompt_lab_foundation.sql python/src/thoth_control_plane/application/ports.py python/src/thoth_control_plane/infrastructure/prompt_repository.py python/tests/infrastructure/test_prompt_repository.py python/tests/operations/test_editor_migrations.py
rtk git commit -m "persist prompt lab revisions"
```

### Task 3: Add Prompt Lab application service and authenticated API

**Files:**
- Create: `python/src/thoth_control_plane/application/prompt_lab.py`
- Create: `python/src/thoth_control_plane/api/routes/prompt_lab.py`
- Modify: `python/src/thoth_control_plane/api/app.py`
- Create: `python/tests/application/test_prompt_lab.py`
- Create: `python/tests/api/test_prompt_lab.py`

**Interfaces:**
- Produces `PromptLabService` methods matching the six spec routes.
- Adds the global authenticated `GET /api/v1/prompt-stages` route and five
  project-scoped route families under `/api/v1/projects/{project_id}/prompt-lab`.
- Template save conflicts return `409` with the latest
  `PromptTemplateRevision`; binding conflicts return `409` with the latest
  `ProjectPromptBinding`.

- [ ] **Step 1: Write failing service/API tests.** Extend an in-memory repository
  with the Task 2 seam. Assert bearer auth, stage order/status, create and revise
  template, list heads, create/update/read binding, resolved preview, cross-project
  `404`, unsupported stage/extra field `422`, both conflict bodies, and unavailable
  `503`. Assert no route path contains `improve`, `translate`, or `proposal`.

```python
async def test_resolved_preview_contains_only_visible_prompt_sections(client, auth) -> None:
    response = await client.get(
        "/api/v1/projects/project_a/prompt-lab/resolved/narrative_plan", headers=auth
    )
    assert response.status_code == 200
    assert response.json()["visible_text"] == (
        "Template\nWrite a hook\n\nProject override\nUse Indonesian"
    )
    assert "policy" not in response.text.lower()
```

- [ ] **Step 2: Verify RED.** Run:

```powershell
rtk uv run pytest tests/application/test_prompt_lab.py tests/api/test_prompt_lab.py -q
```

Expected: service/route imports fail.

- [ ] **Step 3: Implement the service.** Generate a `ptpl_<uuid hex>` ID only
  for a create request; pass existing ID/base revision unchanged for revisions.
  Validate stage registry membership before repository access and compose resolved
  output through `resolve_prompt_draft`.

```python
class PromptLabService:
    async def save_template(
        self, project_id: ProjectId, request: SavePromptTemplateRequest
    ) -> PromptTemplateRevision:
        template_id = request.template_id or f"ptpl_{uuid4().hex}"
        return await self._repository.save_template(
            project_id=project_id,
            template_id=template_id,
            base_revision=request.base_revision,
            stage_id=request.stage_id,
            language=request.language,
            body=request.body,
        )
```

- [ ] **Step 4: Implement routes and application wiring.** Construct one
  `PostgresPromptLabRepository` from the same optional editor database URL in
  `create_app`; keep workflow readiness independent. Map only typed not-found,
  conflict, and unavailable errors. Add `PUT` to the existing CORS method list.

```python
app.state.prompt_lab_service = PromptLabService(prompt_repository)
allow_methods=["GET", "PATCH", "POST", "PUT", "OPTIONS"]
app.include_router(prompt_lab_router, prefix="/api/v1")
```

- [ ] **Step 5: Verify GREEN and commit.**

```powershell
rtk uv run pytest tests/application/test_prompt_lab.py tests/api/test_prompt_lab.py tests/api/test_edit_documents.py -q
rtk uv run ruff check src tests/application/test_prompt_lab.py tests/api/test_prompt_lab.py
rtk uv run ruff format --check src tests/application/test_prompt_lab.py tests/api/test_prompt_lab.py
rtk git add python/src/thoth_control_plane/application/prompt_lab.py python/src/thoth_control_plane/api/routes/prompt_lab.py python/src/thoth_control_plane/api/app.py python/tests/application/test_prompt_lab.py python/tests/api/test_prompt_lab.py
rtk git commit -m "add prompt lab api"
```

### Task 4: Regenerate contracts and add the typed dashboard client

**Files:**
- Modify: `python/openapi.json`
- Modify: `dashboard/src/api/generated/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.test.ts`

**Interfaces:**
- Exports generated prompt types from `control-plane.ts`.
- Adds `listPromptStages`, `listPromptTemplates`, `savePromptTemplate`,
  `getPromptBinding`, `savePromptBinding`, and `getResolvedPrompt`.
- Template and binding save methods return discriminated `saved`/`conflict`
  results, matching existing edit-document PATCH handling.

- [ ] **Step 1: Write failing client tests.** Mock `fetch` and assert encoded
  project/stage/template IDs, bearer auth, methods, JSON bodies, `404` binding as
  `null`, and preserved typed `409` bodies. Assert no AI action method exists.

```typescript
const result = await client.savePromptBinding("project/a", "narrative_plan", request);
expect(fetch).toHaveBeenCalledWith(
  "http://control/api/v1/projects/project%2Fa/prompt-lab/bindings/narrative_plan",
  expect.objectContaining({ method: "PUT" }),
);
expect(result).toEqual({ kind: "conflict", latest });
```

- [ ] **Step 2: Verify RED, then generate contracts.** Run the focused test first;
  export OpenAPI with the existing project command and regenerate TypeScript.

```powershell
rtk bun test src/api/control-plane.test.ts
cd ..\python
rtk uv run python scripts/export_openapi.py
cd ..\dashboard
rtk bun run generate:control-plane-types
```

Expected RED: prompt client methods are absent. After generation, implement only
the six required calls.

- [ ] **Step 3: Implement the smallest client additions.** Reuse the existing
  `request` helper and one local save helper for the two `409` response types.
  Do not generalize the entire control-plane client.

```typescript
async function saveWithConflict<T>(path: string, method: "POST" | "PUT", body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (response.status === 409) return { kind: "conflict" as const, latest: await response.json() as T };
  if (!response.ok) throw new Error(`Control plane request failed (${response.status})`);
  return { kind: "saved" as const, value: await response.json() as T };
}
```

- [ ] **Step 4: Verify deterministic generation and commit.**

```powershell
rtk bun test src/api/control-plane.test.ts
rtk bun run build
rtk git add src/api/generated/control-plane.ts
rtk bun run generate:control-plane-types
rtk git diff --exit-code -- src/api/generated/control-plane.ts
rtk git add ../python/openapi.json src/api/generated/control-plane.ts src/api/control-plane.ts src/api/control-plane.test.ts
rtk git commit -m "add prompt lab client"
```

### Task 5: Implement reducer-backed Prompt Lab UI

**Files:**
- Create: `dashboard/src/features/studio/prompt_lab_state.ts`
- Create: `dashboard/src/features/studio/prompt_lab_state.test.ts`
- Create: `dashboard/src/features/studio/PromptLab.tsx`
- Create: `dashboard/src/features/studio/PromptLab.test.tsx`

**Interfaces:**
- Produces `createPromptLabState`, `promptLabReducer`, and `PromptLab`.
- `PromptLab` consumes only the six Task 4 client methods plus `projectId`.
- State holds loaded registry/templates/binding/resolved data, selected stage,
  form drafts, base revisions, and explicit load/save/conflict/offline status.

- [ ] **Step 1: Write failing reducer tests.** Prove stage selection, template and
  override drafts, successful save rebasing, failure preserving draft text,
  conflict preserving draft until `reload_latest`, and stage switch preserving
  per-stage form state.

```typescript
const dirty = promptLabReducer(ready, {
  type: "edit_project_override",
  value: "Use conversational Indonesian",
});
const failed = promptLabReducer(dirty, { type: "binding_save_failed" });
expect(failed.projectOverrideDraft).toBe("Use conversational Indonesian");
expect(failed.saveStatus).toBe("failed");
```

- [ ] **Step 2: Verify reducer RED, implement, and verify GREEN.** Keep one pure
  reducer; do not add Context, Zustand, Redux, or a generic form abstraction.

```typescript
export function promptLabReducer(state: PromptLabState, action: PromptLabAction): PromptLabState {
  switch (action.type) {
    case "edit_project_override":
      return { ...state, projectOverrideDraft: action.value, saveStatus: "dirty" };
    case "binding_save_failed":
      return { ...state, saveStatus: "failed" };
    default:
      return state;
  }
}
```

```powershell
rtk bun test src/features/studio/prompt_lab_state.test.ts
```

- [ ] **Step 3: Write failing component tests.** Use role/label queries. Assert
  stage tabs, template list, language/body/override controls, escaped resolved
  preview, retry and conflict recovery, persistent status, and disabled
  Improve/Translate buttons. Assert clicking either disabled button causes zero
  client calls.

```typescript
expect((screen.getByRole("button", { name: "Improve" }) as HTMLButtonElement).disabled).toBe(true);
expect(screen.getByText("Provider-backed proposals are not available yet.")).not.toBeNull();
expect(screen.getByLabelText("Resolved prompt preview").textContent).toContain("<b>plain text</b>");
expect(document.querySelector("b")).toBeNull();
```

- [ ] **Step 4: Implement `PromptLab`.** Use existing design tokens and native
  controls. Make stage selection a labelled button list; keep form labels and
  visible focus; render preview as text with `whitespace-pre-wrap`; connect save
  states to an `aria-live="polite"` region. Use no modal or HTML injection.

```tsx
<section aria-label="Prompt Lab">
  <nav aria-label="Prompt stages">
    {state.stages.map((stage) => (
      <button key={stage.stage_id} type="button" onClick={() => selectStage(stage.stage_id)}>
        {stage.label}
      </button>
    ))}
  </nav>
  <label htmlFor={bodyId}>Template body</label>
  <textarea id={bodyId} maxLength={12_000} value={state.templateBodyDraft} onChange={editBody} />
  <pre aria-label="Resolved prompt preview" className="whitespace-pre-wrap">{state.resolved.visible_text}</pre>
</section>
```

- [ ] **Step 5: Verify GREEN and commit.**

```powershell
rtk bun test src/features/studio/prompt_lab_state.test.ts src/features/studio/PromptLab.test.tsx
rtk bun run lint
rtk bun run build
rtk git add src/features/studio/prompt_lab_state.ts src/features/studio/prompt_lab_state.test.ts src/features/studio/PromptLab.tsx src/features/studio/PromptLab.test.tsx
rtk git commit -m "add prompt lab workspace"
```

### Task 6: Integrate Prompt Lab without resetting Studio state

**Files:**
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.final-fix.test.tsx`

**Interfaces:**
- Extends `GuidedStudio` client requirements with Task 4 prompt methods.
- Adds `Scenes` and `Prompt Lab` tabs while keeping the existing `Editor`
  reducer mounted at one stable React position.
- Both panels remain mounted and use the native `hidden` attribute so switching
  cannot discard local EditDocument or Prompt Lab drafts.

- [ ] **Step 1: Write failing integration tests.** Dirty an EditDocument field,
  switch to Prompt Lab and back, and assert the edit remains. Dirty a prompt
  override, switch to Scenes and back, and assert it remains. Assert tab roles,
  `aria-selected`, keyboard activation, and that Back/Undo/Redo/autosave behavior
  remains unchanged.

```typescript
await user.type(screen.getByLabelText("Project override"), "Keep it concise");
await user.click(screen.getByRole("tab", { name: "Scenes" }));
await user.click(screen.getByRole("tab", { name: "Prompt Lab" }));
expect((screen.getByLabelText("Project override") as HTMLTextAreaElement).value).toBe("Keep it concise");
```

- [ ] **Step 2: Verify RED.** Run:

```powershell
rtk bun test src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx
```

- [ ] **Step 3: Implement stable tab panels.** Keep `Editor` itself mounted.
  Render both workspace panels at stable positions and toggle `hidden`; do not
  assign changing keys. This follows React 19 state identity semantics and avoids
  copying prompt draft state into `App.tsx`.

```tsx
<div role="tablist" aria-label="Studio workspace">
  <button role="tab" aria-selected={workspace === "scenes"}>Scenes</button>
  <button role="tab" aria-selected={workspace === "prompts"}>Prompt Lab</button>
</div>
<div role="tabpanel" hidden={workspace !== "scenes"}>{sceneWorkspace}</div>
<div role="tabpanel" hidden={workspace !== "prompts"}>
  <PromptLab client={client} projectId={projectId} />
</div>
```

- [ ] **Step 4: Verify GREEN and commit.**

```powershell
rtk bun test src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx src/features/studio/PromptLab.test.tsx
rtk bun run lint
rtk bun run build
rtk git add src/features/studio/GuidedStudio.tsx src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx
rtk git commit -m "integrate prompt lab in studio"
```

### Task 7: Full verification and audit trail

**Files:**
- Modify: `BLUEPRINT.md` only after every command below passes.

- [ ] **Step 1: Run all Python gates.**

```powershell
cd python
rtk uv sync --locked --all-groups
rtk uv run pytest -q
rtk uv run ruff check .
rtk uv run ruff format --check .
```

- [ ] **Step 2: Prove generated contracts are deterministic and run all
  dashboard gates.**

```powershell
cd ..\dashboard
rtk bun run generate:control-plane-types
rtk git diff --exit-code -- src/api/generated/control-plane.ts
rtk bun test
rtk bun run lint
rtk bun run build
```

- [ ] **Step 3: Run the existing CUDA release gate and repository checks.**

```powershell
cd ..
rtk cmd.exe /c ".\build_cuda.bat build_log.txt 2>&1"
rtk git diff --check
rtk git status --short
```

Require exit zero. Confirm the two protected untracked files remain unmodified
and no secret, URL, provider output, database content, or build artifact was
staged.

- [ ] **Step 4: Record the final audit trail and commit.** Add a concise C1 entry
to `BLUEPRINT.md` containing the final commit range, exact test counts, migration
identity, exclusions, and statement that provider actions remain unavailable.

```powershell
rtk git add BLUEPRINT.md
rtk git commit -m "record prompt lab foundation"
rtk git status --short --branch
```

Stop with the branch ahead locally. Do not push or deploy.

## Plan Self-Review

- Tasks 1–3 cover every domain, persistence, project-isolation, conflict, API,
  migration, and safe-error requirement.
- Task 4 covers OpenAPI and the authenticated generated client boundary.
- Tasks 5–6 cover accessible Prompt Lab behavior and React state preservation.
- Task 7 covers deterministic contracts, full regressions, CUDA, audit trail,
  protected untracked files, and the local-only hard stop.
- Type and method names are consistent across tasks. C1 includes no provider
  execution, proposal endpoint, video/scene binding, variable interpolation,
  timeline, render queue, deployment, or live gate.
