# Creator Studio Guided Editing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Mark each
> checkbox complete only after its evidence passes.

**Goal:** Turn the read-only Studio preview into a durable guided text editor
with atomic immutable revisions, optimistic autosave, and local undo/redo.

**Architecture:** A Python operation module validates and applies a closed
operation union without persistence side effects. The repository owns
transactional compare-and-append. React owns only local draft/history state and
calls the generated PATCH client after a debounce.

**Tech Stack:** Python 3.11–3.13, Pydantic v2, FastAPI, psycopg 3,
PostgreSQL, React 19, TypeScript 6, Bun, Remotion 4.0.523, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-09-11-creator-studio-guided-editing-design.md`

## Global Constraints

- Read project instructions, `BLUEPRINT.md`, parent design, focused spec, and
  this plan before editing; work only on `codex/stage1-container-ci`.
- Preserve `compose.stage1.controlled-fallback.yml` and the untracked research
  document. Prefix commands with `rtk`; Docker only, never Podman.
- Use TDD, concise one-line English commits, and no attribution trailers.
- Do not add state/ORM/migration/component/timeline libraries or new tables.
- Reject arbitrary document JSON, HTML, code, FFmpeg arguments, paths, URLs,
  secrets, and provider payloads. Do not push, deploy, or perform live work.
- Update `BLUEPRINT.md` only after all final gates pass.

## File Map

- `python/src/thoth_control_plane/domain/edit_document_operations.py`: strict
  operation models and pure immutable application/reflow.
- `python/src/thoth_control_plane/application/edit_documents.py`: save use case.
- `python/src/thoth_control_plane/application/ports.py` and
  `python/src/thoth_control_plane/infrastructure/editor_repository.py`:
  compare-and-append persistence seam and adapter.
- `python/src/thoth_control_plane/api/routes/edit_documents.py`: typed PATCH.
- `dashboard/src/features/studio/editor_state.ts`: local reducer/history.
- `dashboard/src/features/studio/{GuidedStudio,SceneBoard,Inspector}.tsx`:
  accessible guided editing surface.

### Task 1: Define operations and pure document application

**Files:** Create `python/src/thoth_control_plane/domain/edit_document_operations.py`;
modify `python/src/thoth_control_plane/domain/{edit_documents.py,__init__.py}`;
create `python/tests/domain/test_edit_document_operations.py`.

**Interfaces:** `ReplaceText`, `SetOwnership`, `SetSceneDuration`,
`EditDocumentOperation`, `EditDocumentPatch`, and
`apply_edit_operations(document, operations) -> EditDocument`. Change only
`EditDocument.revision` to `Annotated[int, Field(gt=0)]`; schema version remains one.

- [ ] **Step 1: Write failing tests.** Create a two-scene fixture. Assert
  `replace_text` updates one text value and sets ownership `user_edited`;
  `set_ownership` changes only ownership; `set_scene_duration` changes that
  clip/scene, reflows later starts, and recalculates canvas duration. Assert the
  input fixture is unchanged. Reject duplicate operation IDs, unknown IDs,
  invalid field, blank heading, non-positive duration, and invalid results.
- [ ] **Step 2: Verify RED.** From `python`, run
  `rtk uv run pytest tests/domain/test_edit_document_operations.py -q` and
  confirm import failure for the missing module.
- [ ] **Step 3: Implement minimally.** Use strict literal-tagged Pydantic
  models. Reject duplicate IDs in the patch validator. Deep-copy documents;
  resolve IDs per operation. Duration reflows later scenes/clips in document
  order, recalculates canvas duration, then validates the resulting document.
  Do not access a repository or choose a revision number.
- [ ] **Step 4: Verify GREEN.** Run focused operation and existing document
  tests, Ruff check, and Ruff format check.
- [ ] **Step 5: Commit.**
  `rtk git commit -m "feat: define edit document operations"`

### Task 2: Compare, apply, and append revisions atomically

**Files:** Modify `python/src/thoth_control_plane/application/ports.py` and
`python/src/thoth_control_plane/infrastructure/editor_repository.py`; extend
`python/tests/infrastructure/test_editor_repository.py`.

**Interfaces:** Extend `EditDocumentRepository` with
`apply_operations(project_id, document_id, base_revision, operations)` and add
`EditDocumentRevisionConflict(latest: EditDocument)`.

- [ ] **Step 1: Write failing tests.** Use a fake async connection/cursor to
  prove a transaction selects current row by project/document, compares the
  revision, applies operations, then parameterizes one JSONB insert with next
  revision. Assert stale saves carry latest validated document; invalid stored
  JSON and connection failures remain safe errors.
- [ ] **Step 2: Verify RED.** Run
  `rtk uv run pytest tests/infrastructure/test_editor_repository.py -q` and
  confirm the new seam is absent.
- [ ] **Step 3: Implement the deep repository module.** Execute
  `SELECT ... FOR UPDATE`, validate selected JSON, compare revision, call the
  pure operation module, and insert revision plus one in the same transaction.
  Do not interpolate values or expose SQL/parameters/database URL.
- [ ] **Step 4: Verify GREEN and commit.** Run repository/domain tests and
  Ruff, then `rtk git commit -m "feat: append edit document revisions atomically"`.

### Task 3: Add safe optimistic PATCH endpoint

**Files:** Modify `python/src/thoth_control_plane/application/edit_documents.py`
and `python/src/thoth_control_plane/api/routes/edit_documents.py`; extend
`python/tests/{application,api}/test_edit_documents.py`.

**Interfaces:** `EditDocumentService.apply_patch(project_id, document_id, patch)`
and `PATCH /api/v1/projects/{project_id}/edit-documents/{document_id}`.

- [ ] **Step 1: Write failing tests.** With an in-memory adapter, assert valid
  authenticated PATCH returns revision two. Assert 403 for bad auth, 422 for
  unknown fields, 404 for absent document, 503 unavailable store, and 409 with
  validated latest document for stale base revision. Assert POST import/GET and
  workflow routes stay green, and OpenAPI contains the single PATCH operation.
- [ ] **Step 2: Verify RED.** Run both focused application/API test files.
- [ ] **Step 3: Implement.** Delegate all comparison/application to repository.
  Map only safe not-found, conflict, and unavailable exceptions. The route must
  neither merge document JSON nor expose persistence diagnostics.
- [ ] **Step 4: Verify GREEN and commit.** Run API/workflow regressions and
  Ruff, then `rtk git commit -m "feat: save guided document edits"`.

### Task 4: Regenerate contracts and add PATCH client

**Files:** Modify `python/openapi.json`,
`dashboard/src/api/generated/control-plane.ts`,
`dashboard/src/api/control-plane.ts`, and its test.

**Interfaces:** `EditDocumentPatch`, `EditDocumentOperation`, and
`patchEditDocument(projectId, documentId, patch)` returning either
`{kind: "saved", document}` or `{kind: "conflict", latest}`.

- [ ] **Step 1: Write failing client test.** Mock fetch; assert encoded IDs,
  PATCH, bearer auth, JSON body, and preservation of a 409 latest-document body.
- [ ] **Step 2: Verify RED and generate.** Run focused Bun test, then export
  OpenAPI from `python` and run dashboard type generation.
- [ ] **Step 3: Implement.** Handle only 409 specially; preserve existing
  generic non-2xx behavior for every other response.
- [ ] **Step 4: Verify GREEN and commit.** Run test/build, regenerate twice,
  prove generated files have zero diff, then commit
  `feat: add guided edit client`.

### Task 5: Implement reducer-backed guided Studio

**Files:** Create `dashboard/src/features/studio/editor_state.ts` and tests,
`GuidedStudio.tsx`, `SceneBoard.tsx`, and `Inspector.tsx`; keep
`StudioPreview.tsx` as the canvas child.

**Interfaces:** `createEditorState(document)`, `editorReducer(state, action)`,
and `toEditDocumentPatch(state)`; GuidedStudio consumes typed GET/PATCH client
methods.

- [ ] **Step 1: Write failing reducer/component tests.** Assert selection and
  text/duration/ownership edits update draft, create typed pending operations,
  and undo/redo restore exact snapshots. Assert labelled Inspector controls,
  keyboard-visible Undo/Redo, `Saving`/`Saved`, safe retry error, and conflict
  actions Reload Latest/Keep Editing Locally. Raw server errors must not render.
- [ ] **Step 2: Verify RED.** Run focused Bun tests and confirm missing modules.
- [ ] **Step 3: Implement.** State holds base document, draft, selected scene,
  history, save status, and pending operations. Autosave is a 500ms debounce.
  A saved response resets base/history; a conflict preserves draft until an
  explicit reload; failure exposes Retry. Use labelled native controls/buttons,
  not drag/drop or a state package.
- [ ] **Step 4: Verify GREEN and commit.** Run focused tests, lint/build, then
  `rtk git commit -m "feat: add guided studio editing"`.

### Task 6: Route Content Set into guided Studio

**Files:** Modify `dashboard/src/App.tsx` and Content Set tests.

- [ ] **Step 1: Write failing navigation tests.** Assert successful import
  opens GuidedStudio, Back returns to Content Set, no project disables opening,
  and Send to render remains unchanged.
- [ ] **Step 2: Implement and verify.** Replace the App-level read-only preview
  mount with GuidedStudio, preserving the document pair and typed client. Run
  affected tests/lint/build and commit
  `rtk git commit -m "feat: open guided studio editor"`.

### Task 7: Full audit trail

**Files:** Modify `BLUEPRINT.md` only after every gate passes.

- [ ] **Step 1: Python gates.** Run full pytest, Ruff check/format, and lock
  check from `python`.
- [ ] **Step 2: Contract/dashboard gates.** Regenerate OpenAPI and types with
  zero diff; run full Bun test, lint, and build.
- [ ] **Step 3: CUDA gate.** From root run
  `rtk cmd.exe /c ".\build_cuda.bat build_log.txt 2>&1"`; require exit zero.
- [ ] **Step 4: Record and commit.** Verify protected untracked files remain
  untouched, append operations/revision/PATCH/autosave evidence and exclusions
  to BLUEPRINT, then commit `docs: record guided editing core`.

## Plan Self-Review

- Tasks 1–3 cover every domain, persistence, API, and conflict requirement.
- Tasks 4–6 cover generated contracts, accessible guided UI, history, autosave,
  and navigation. Task 7 covers all verification/audit obligations.
- No task implements Prompt Lab, AI proposals, timeline/media/audio, rendering,
  deployment, or live actions. The operation union is identical from domain to
  generated client to reducer, and 409 always carries `EditDocument`.
