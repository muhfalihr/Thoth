# Creator Studio F2 Editorial Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Use RED→GREEN tests and checkbox tracking.

**Goal:** Add saved-revision comments and editorial approval/request-changes to the responsive Creator Studio without reusing workflow or operator approval.

**Architecture:** One append-only, project-scoped review event store owns comments and decisions. The server authenticates and binds every write to the latest saved document revision under the same document advisory lock used by editor saves. A dedicated review panel consumes public, safe API projections and the existing single saved-revision preview in `GuidedStudio`.

**Tech Stack:** Python/FastAPI/Pydantic, PostgreSQL/Psycopg, OpenAPI, React 19.2.7, TypeScript, Bun/Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-24-creator-studio-responsive-review-design.md`. Start after `2026-09-24-creator-studio-f2-responsive-workspace.md` passes its offline checks; do not redo its responsive shell. The full product review occurs after this plan, not between plans.

## Global Constraints

- A Studio decision is editorial metadata on one saved revision. It is not workflow approval, Stage 1 evidence, render/publish authorization, or deployment permission.
- Comments are immutable, plain text, flat, document- or frame-anchored, and bound to an exact saved revision. Decisions are append-only `approved` or `changes_requested`; a new document revision leaves prior records historical.
- Current `current_actor` authenticates an owner actor; do not invent independent-reviewer roles. The server, not button visibility, enforces project/document isolation and revision/validation gates.
- Mutations use one caller idempotency key, no automatic retries, and atomic latest-revision checks. Lists are bounded and paginated. No raw provider payload, secret, artifact path, or client-supplied actor enters records/responses.
- Preserve the single `StudioPreview` from the responsive-workspace plan. The Review pane previews `base` (saved), not `draft`; unsent input survives pane/viewport changes.
- No live provider/TikTok request, deployment, push, F1 golden promotion, F3 migration, real-time collaboration, offline queue, new role system, or acceptance-window activation.

## Review Focus

1. Concurrent document save and review write must serialize; a stale review write returns 409 rather than attaching to a superseded revision (Task 2 test).
2. Replaying the same idempotency key/body returns one record; reusing the key with another body or event kind conflicts (Task 2 test).
3. A frame at the saved canvas end, negative frame, blank/oversized text, or wrong project/document must reject without insert (Tasks 1–3 tests).
4. A newer saved revision must make an old approval historical without deleting it; the UI must not display it as current (Tasks 2 and 4 tests).
5. Offline, dirty, conflict, pending, and blocking-issue states must retain typed input and prevent submit; stale 409 requires explicit resubmission, and a late response from a former document cannot appear in the new one (Task 4 test).

---

### Task 1: Review events, eligibility, and additive schema

**Files:**
- Create: `python/src/thoth_control_plane/domain/studio_review.py`
- Create: `python/tests/domain/test_studio_review.py`
- Create: `python/migrations/editor/0006_studio_review_events.sql`
- Test: `python/tests/operations/test_editor_migrations.py`

**Interfaces:** `ReviewComment`, `ReviewDecision`, `CreateComment`, `CreateDecision`, `ReviewCommentPage`, `ReviewDecisionPage`, `ReviewRevisionConflictBody`, and `review_blocking_issues(document: EditDocument) -> tuple[str, ...]`. Both event types expose only public IDs, actor snapshot, saved revision, safe text/decision, frame, and timestamps. Task 2 persists them; Task 3 uses eligibility.

- [ ] Write RED domain tests for bounded plain text, valid opaque IDs, nonnegative optional frame, allowed decisions, and review eligibility on the existing four timeline issue classes plus invalid text. The saved canvas upper bound is checked in Task 2. Add migration RED assertions for one append-only table, unique idempotency scope, project-scoped revision FK, indexes, and no change to migrations 0001–0005.

```python
assert CreateComment(base_revision=3, operation_id="op_review_1", text="Check title", frame=29).frame == 29
assert "main_track_gap" in review_blocking_issues(gapped_saved_document)
with pytest.raises(ValidationError):
    CreateComment(base_revision=3, operation_id="op_review_2", text=" ", frame=None)
```

- [ ] Run `uv run --project python pytest python/tests/domain/test_studio_review.py python/tests/operations/test_editor_migrations.py -q` and record the expected RED.
- [ ] Implement strict Pydantic input/output models and server-side issue checks that match the existing `timelineIssues` codes (`main_track_gap`, `clip_overlap`, `clip_exceeds_canvas`, `track_empty`) plus saved text validity; compare shared document fixtures rather than trusting browser flags. Create `studio_review_events` with event ID, project/document/revision, operation ID, request hash, event kind, actor snapshot, text/frame/decision/reason, and timestamp. Use CHECK constraints for kind-specific columns, a new unique index on `(project_id, document_id, revision)` of immutable revisions and a three-column FK to it, unique `(project_id, document_id, operation_id)`, and listing indexes.

```sql
UNIQUE (project_id, document_id, operation_id),
FOREIGN KEY (project_id, document_id, revision)
    REFERENCES edit_document_revisions (project_id, document_id, revision)
```

- [ ] Run the focused tests GREEN. Commit only this task with `git commit -m "feat: define Studio review events"`.

### Task 2: Atomic review repository and pagination

**Files:**
- Create: `python/src/thoth_control_plane/application/studio_review_ports.py`
- Create: `python/src/thoth_control_plane/infrastructure/studio_review_repository.py`
- Create: `python/tests/infrastructure/test_studio_review_repository.py`

**Interfaces:** `StudioReviewRepository.create_comment(...) -> ReviewComment`, `create_decision(...) -> ReviewDecision`, `list_comments(...) -> ReviewCommentPage`, and `list_decisions(...) -> ReviewDecisionPage`. Create methods take authenticated actor and expected revision, never caller actor. Task 3 consumes this port.

- [ ] Write RED integration tests with the repository's existing PostgreSQL test pattern: duplicate replay, changed-body/kind conflict, concurrent `apply_operations` versus comment/decision, wrong project, frame bound, append-only historical approval, pagination order/tiebreak, invalid cursor/limit, and rollback after insert failure.

```python
first = await repo.create_comment(project_id="project_001", document_id="document_001", request=req, actor=actor)
replayed = await repo.create_comment(project_id="project_001", document_id="document_001", request=req, actor=actor)
assert replayed.comment_id == first.comment_id
assert await count_review_events() == 1
```

- [ ] Run `uv run --project python pytest python/tests/infrastructure/test_studio_review_repository.py -q` and record RED.
- [ ] In one transaction, acquire `pg_advisory_xact_lock(hashtext(project_id), hashtext(document_id))` **before** reading the latest revision, matching editor saves; look up the operation ID; compare a canonical hash of event kind and complete request; replay or conflict; check project-scoped latest revision; validate frame; insert once. Use parameterized SQL. List comments oldest-first and decisions newest-first by `(created_at, event_id)` with opaque cursors, limit `1..50`, and project/document predicates. Never allow pagination to reveal another document's records.

```sql
SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s));
SELECT revision, document_json FROM edit_document_revisions
WHERE project_id = %s AND document_id = %s
ORDER BY revision DESC LIMIT 1 FOR UPDATE;
```

- [ ] Run repository tests GREEN and the existing editor repository tests. Commit with `git commit -m "feat: persist revision-bound Studio reviews"`.

### Task 3: Application, public API, and generated client

**Files:**
- Create: `python/src/thoth_control_plane/application/studio_review.py`
- Create: `python/src/thoth_control_plane/api/routes/studio_review.py`
- Modify: `python/src/thoth_control_plane/api/app.py`
- Test: `python/tests/application/test_studio_review.py`
- Test: `python/tests/api/test_studio_review.py`
- Test: `python/tests/api/test_openapi_contract.py`
- Modify: `dashboard/src/api/control-plane.ts`
- Test: `dashboard/src/api/control-plane.test.ts`
- Generated: `python/openapi.json`, `dashboard/src/api/generated/control-plane.ts`

**Interfaces:** Four public client methods: `listStudioReviewComments`, `createStudioReviewComment`, `listStudioReviewDecisions`, `createStudioReviewDecision`. GETs take bounded `limit/cursor`; POSTs take an operation ID, saved base revision, and typed comment/decision body. All responses are public projections only. Define these public types from the generated OpenAPI schemas, not parallel handwritten response shapes.

```ts
type ReviewListQuery = { limit?: number; cursor?: string };
listStudioReviewComments(projectId: string, documentId: string, query?: ReviewListQuery): Promise<ReviewCommentPage>;
createStudioReviewComment(projectId: string, documentId: string, request: CreateComment): Promise<ReviewComment>;
listStudioReviewDecisions(projectId: string, documentId: string, query?: ReviewListQuery): Promise<ReviewDecisionPage>;
createStudioReviewDecision(projectId: string, documentId: string, request: CreateDecision): Promise<ReviewDecision>;
```

- [ ] Write RED service/API tests for authenticated actor and project scope, stale 409 with safe latest-revision facts, invalid frame/text, decision rejection on blocking saved issues, replay/conflict, bounded list, and no internal path/credential. Write RED client tests for exact project/document URLs, one request per mutation, caller's unchanged operation ID, typed 409, and safe error collapse.

```python
response = await client.post(
    "/api/v1/projects/project_001/edit-documents/document_001/review-decisions",
    json={"base_revision": 3, "operation_id": "op_review_3", "decision": "approved"},
    headers=auth_headers,
)
assert response.status_code == 201
assert response.json()["revision"] == 3
```

- [ ] Run focused Python and dashboard API tests; capture behavioral RED.
- [ ] Add service validation, public GET/POST routes, DI in `create_app`, and precise 400/404/409/503 safe errors. The server obtains actor from `current_actor`; no actor field in request schema. Export OpenAPI and regenerate TypeScript; implement thin dashboard methods using existing request/error helpers, not a second HTTP stack.

```powershell
uv run --project python python/scripts/export_openapi.py
bun --cwd=dashboard generate:control-plane-types
```

- [ ] Run focused tests GREEN and a second generation with no diff. Commit API, tests, and generated contracts with `git commit -m "feat: expose Studio review API"`.

### Task 4: Review pane, saved preview, and fail-closed mutations

**Files:**
- Create: `dashboard/src/features/studio/StudioReviewPanel.tsx`
- Create: `dashboard/src/features/studio/StudioReviewPanel.test.tsx`
- Create: `dashboard/src/features/studio/studio_review_state.ts`
- Create: `dashboard/src/features/studio/studio_review_state.test.ts`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Test: `dashboard/src/features/studio/GuidedStudio.responsive.test.tsx`

**Interfaces:** `StudioReviewPanel({ client, projectId, documentId, savedDocument, saveStatus, isOffline, blockingIssues, currentFrame })` reads only review methods from Task 3. It never owns another edit document or preview. `GuidedStudio` supplies `base`, and its Review pane uses the same single `StudioPreview` in saved-revision mode from Plan A.

- [ ] Write RED reducer/component tests: comment at current frame/document level; historical revision label; latest decision only current when revision matches; dirty/offline/conflict/pending/blocked approval gates; typed input retained after 409/network failure/pane switch; explicit resubmit with new operation ID only after user reviews latest revision; no automatic retry; one preview mounted; and a late list/mutation response after project/document change or unmount is ignored. Test focus/labels/status for keyboard use.

```tsx
fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Adjust opening" } });
fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
expect(createStudioReviewComment).toHaveBeenCalledWith(
  "project_001", "document_001", expect.objectContaining({ base_revision: 3, text: "Adjust opening" }),
);
```

- [ ] Run `bun --cwd=dashboard test src/features/studio/studio_review_state.test.ts src/features/studio/StudioReviewPanel.test.tsx src/features/studio/GuidedStudio.responsive.test.tsx` and record RED.
- [ ] Implement one review state owner for loaded pages, unsent comment/reason, pending operation, and safe errors. Keep the panel mounted when compact panes switch; use a generation guard keyed by project/document to discard late responses. Render plain text only; no raw HTML. On 409, show safe latest revision, retain input, and require explicit resubmission. Approval and Request changes are separate labeled controls. Derive each disabled reason from saved document and editor state; never submit a `draft` revision. In desktop mode, place Review adjacent to the shared preview without adding another player.

```ts
const canDecide = !isOffline && saveStatus === "saved" && blockingIssues === 0 && !pending;
const canComment = !isOffline && saveStatus === "saved" && !pending;
```

- [ ] Run focused tests GREEN and existing GuidedStudio/PromptLab/RenderPanel tests. Commit with `git commit -m "feat: add revision-bound Studio review pane"`.

### Task 5: End-to-end offline gate and handoff

**Files:**
- Test: `python/tests/api/test_studio_review.py`
- Test: `dashboard/src/features/studio/GuidedStudio.responsive.test.tsx`
- Modify: `CHANGELOG.md` after verification
- Modify: `.superpowers/sdd/2026-09-24-creator-studio-f2-responsive-review/progress.md` (ignored checkpoint)

**Interfaces:** No new public interface. This task proves the F2 product behavior at the full review/response boundary and records actual evidence.

- [ ] Add an end-to-end regression for a comment/approval on revision N followed by a saved revision N+1: old records remain retrievable, current approval disappears, and a stale submit yields 409 with retained UI text. Add a test that phone Review shows saved preview while a separate dirty draft exists and blocks mutation. These checks may already pass after Tasks 2–4; if so, record them as integration verification rather than inventing a false RED claim.

```python
assert prior_decision.revision == 3
assert current_decision_for_revision_4 is None
assert stale_response.status_code == 409
```

- [ ] Run those focused tests and implement only integration fixes if they expose a defect; use RED→GREEN for each such fix. Execute full non-live Python tests, Ruff, dashboard full tests/lint/build, OpenAPI regeneration twice (second pass stable), and the mandatory `build_cuda.bat` command. Inspect 375 px, tablet portrait/landscape, 1024 px, 1440 px, keyboard flow, 200% zoom, and reduced-motion in a real browser. If a required gate cannot run, report it as unverified, not passed.

```powershell
uv run --project python pytest -m "not live" -q
uv run --project python ruff check python/src python/tests
uv run --project python ruff format --check python/src python/tests
bun --cwd=dashboard test
bun --cwd=dashboard run lint
bun --cwd=dashboard run build
uv run --project python python/scripts/export_openapi.py
bun --cwd=dashboard generate:control-plane-types
cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"
```

- [ ] Record actual checks, reviewer-visible limitations, and F1 deferred gate in the F2 checkpoint and `CHANGELOG.md`. Commit only task-owned tests/fixes and `CHANGELOG.md` with `git commit -m "test: verify responsive Studio editorial review"`. Stop before push, deploy, F1 promotion, or any live request. Return the branch to Codex for one proportional end-of-feature review.
