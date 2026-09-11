# Creator Studio Document Foundation and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Mark each
> checkbox complete only after its evidence passes.

**Goal:** Import a sanitized existing content-set into immutable EditDocument
revision 1, persist it in application PostgreSQL, expose it through the Python
control plane, and display it in a read-only Remotion Player.

**Architecture:** The Python control plane owns strict document contracts, a
pure importer, PostgreSQL revision persistence, and authenticated endpoints.
The React dashboard sends only an explicit text projection of the legacy
content-set, consumes generated OpenAPI types, and previews the retrieved
document through a trusted Remotion composition. Existing workflow,
Rust/FFmpeg, and legacy-console paths remain unchanged.

**Tech Stack:** Python 3.11-3.13, Pydantic v2, FastAPI, psycopg 3, PostgreSQL,
OpenAPI, React 19, TypeScript 6, Vite 8, Bun, Remotion 4.0.523, Tailwind CSS 4,
shadcn/Base UI.

**Spec:**
docs/superpowers/specs/2026-09-11-creator-studio-document-preview-design.md

## Global Constraints

- Read CLAUDE.md, AGENTS.md, BLUEPRINT.md, the focused spec, and its parent
  design before editing.
- Work only on codex/stage1-container-ci. Inspect drift before editing; never
  reset or discard existing work.
- Preserve the existing untracked compose.stage1.controlled-fallback.yml and
  docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md.
- Prefix shell commands with rtk. Never use Podman.
- Use TDD and observe each new test fail for the intended reason.
- Every commit is one concise subject line, with no body or attribution trailer.
- Pin remotion and @remotion/player to exactly 4.0.523. Do not add
  @remotion/media.
- Do not add a state library, timeline library, ORM, migration framework, or
  second component framework.
- Never execute user code, raw HTML, source paths, URLs, shell arguments, or
  FFmpeg filters through the editor contract.
- Do not perform live requests, evidence mutation, deployment, restart, push,
  publication, or acceptance-window work.
- Update BLUEPRINT.md only after every gate in Task 9 passes.

## File Map

Create:

- python/src/thoth_control_plane/domain/edit_documents.py
- python/src/thoth_control_plane/application/edit_documents.py
- python/src/thoth_control_plane/infrastructure/editor_repository.py
- python/src/thoth_control_plane/operations/editor_migrations.py
- python/migrations/editor/0001_edit_document_revisions.sql
- python/src/thoth_control_plane/api/routes/edit_documents.py
- python/tests/domain/test_edit_documents.py
- python/tests/application/test_edit_documents.py
- python/tests/infrastructure/test_editor_repository.py
- python/tests/api/test_edit_documents.py
- dashboard/src/features/studio/domain.ts
- dashboard/src/features/studio/domain.test.ts
- dashboard/src/features/studio/preview.ts
- dashboard/src/features/studio/preview.test.ts
- dashboard/src/features/studio/VerticalTextStory.tsx
- dashboard/src/features/studio/StudioPreview.tsx
- dashboard/src/features/studio/StudioPreview.test.tsx

Modify:

- python/pyproject.toml and python/uv.lock
- python/src/thoth_control_plane/config.py
- python/src/thoth_control_plane/application/ports.py
- relevant package __init__.py files
- python/src/thoth_control_plane/api/app.py
- python/src/thoth_control_plane/cli.py
- python/openapi.json
- dashboard/package.json and dashboard/bun.lock
- dashboard/src/api/generated/control-plane.ts
- dashboard/src/api/control-plane.ts and its test
- dashboard/src/components/ContentSet.tsx and its test
- dashboard/src/App.tsx
- BLUEPRINT.md

---

### Task 1: Define strict EditDocument version 1

**Files:**

- Create: python/src/thoth_control_plane/domain/edit_documents.py
- Modify: python/src/thoth_control_plane/domain/__init__.py
- Test: python/tests/domain/test_edit_documents.py

**Interfaces:**

- Produces Ownership, Canvas, TemplateRef, Scene, Track, TextClip, Clip, and
  EditDocument.
- EditDocument.model_validate() and model_validate_json() are the repository
  read boundary consumed by Task 3.
- All models inherit the existing StrictModel.

- [ ] **Step 1: Write failing model tests**

Build a valid two-scene fixture with this exact shape:

    {
      "schema_version": 1,
      "document_id": "edoc_abc123",
      "project_id": "project_001",
      "revision": 1,
      "template": {"template_id": "vertical_text_story", "version": 1},
      "canvas": {
        "width": 1080,
        "height": 1920,
        "fps": 30,
        "duration_in_frames": 300
      },
      "scenes": [
        {
          "scene_id": "scene_001",
          "role": "title",
          "start_frame": 0,
          "duration_in_frames": 150,
          "clip_ids": ["clip_001"]
        },
        {
          "scene_id": "scene_002",
          "role": "source",
          "start_frame": 150,
          "duration_in_frames": 150,
          "clip_ids": ["clip_002"]
        }
      ],
      "tracks": [{
        "track_id": "track_visual",
        "kind": "visual",
        "clip_ids": ["clip_001", "clip_002"]
      }],
      "clips": [
        {
          "kind": "text",
          "clip_id": "clip_001",
          "scene_id": "scene_001",
          "track_id": "track_visual",
          "start_frame": 0,
          "duration_in_frames": 150,
          "heading": "Title",
          "body": "Summary",
          "style_slot": "title",
          "ownership": "ai_managed"
        },
        {
          "kind": "text",
          "clip_id": "clip_002",
          "scene_id": "scene_002",
          "track_id": "track_visual",
          "start_frame": 150,
          "duration_in_frames": 150,
          "heading": "Source",
          "body": "tiktok",
          "style_slot": "source",
          "ownership": "ai_managed"
        }
      ]
    }

Assert valid JSON round-trips without coercion. Add failing cases for:

- schema_version or revision other than 1;
- unknown fields and unknown clip kind;
- duplicate scene, track, or clip IDs;
- unresolved or mismatched scene/track clip references;
- non-contiguous scenes or disagreement between scene and clip ranges;
- canvas duration not equal to the final scene end;
- non-positive duration;
- heading over 300 characters or body over 2,000 characters;
- over 100 scenes or over 200 clips.

- [ ] **Step 2: Run the tests and confirm RED**

    cd python
    rtk uv run pytest tests/domain/test_edit_documents.py -q

Expected: module import fails because edit_documents.py does not exist.

- [ ] **Step 3: Implement the models and one cross-reference validator**

Use strict Literal and bounded Annotated fields. Define Clip as the TextClip
alias in version 1; TextClip.kind is the literal discriminator used when a
later sub-project adds more clip variants.

The EditDocument validator must verify all ID uniqueness, bidirectional
scene/track/clip references, one text clip per scene, contiguous scene order,
matching scene/clip ranges, exact final canvas duration, template
vertical_text_story version 1, and the single track_visual visual track.

Export the public models from domain/__init__.py.

- [ ] **Step 4: Confirm GREEN and style**

    cd python
    rtk uv run pytest tests/domain/test_edit_documents.py -q
    rtk uv run ruff check src/thoth_control_plane/domain/edit_documents.py tests/domain/test_edit_documents.py
    rtk uv run ruff format --check src/thoth_control_plane/domain/edit_documents.py tests/domain/test_edit_documents.py

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

    rtk git add python/src/thoth_control_plane/domain python/tests/domain/test_edit_documents.py
    rtk git commit -m "feat: define edit document v1"

---

### Task 2: Add the sanitized content-set importer

**Files:**

- Create: python/src/thoth_control_plane/application/edit_documents.py
- Modify: python/src/thoth_control_plane/application/__init__.py
- Test: python/tests/application/test_edit_documents.py

**Interfaces:**

- Produces MainImport, FootageImport, ContentSetImportRequest, and
  build_edit_document(project_id, request, document_id).
- Task 4 extends this module with EditDocumentService.

- [ ] **Step 1: Write failing importer tests**

Use main title/description and five footage rows containing whitespace, blank
titles, platforms, URLs, thumbnails, Windows paths, and POSIX paths.

Assert:

- strings are trimmed and empty optional strings become None;
- missing title becomes Untitled video;
- one title scene is always first;
- only the first three non-empty footage titles become source scenes;
- every scene lasts 150 frames;
- IDs are deterministic scene_001/clip_001 pairs in document order;
- the visual track uses the same clip order;
- canvas duration is scene count multiplied by 150;
- every clip is ai_managed;
- request validation rejects url, image_path, comments, profile, references,
  and unknown fields;
- serialized request and document contain no source URL, path, token, or secret
  fixture value.

- [ ] **Step 2: Confirm RED**

    cd python
    rtk uv run pytest tests/application/test_edit_documents.py -q

Expected: missing application module.

- [ ] **Step 3: Implement strict request models and the pure importer**

Use these bounds:

    MainImport.title: optional string, max 300
    MainImport.description: optional string, max 2000
    FootageImport.title: optional string, max 300
    FootageImport.platform: optional safe code, max 64
    ContentSetImportRequest.footage: maximum 100 rows

Keep these template-owned constants:

    TEMPLATE_ID = "vertical_text_story"
    TEMPLATE_VERSION = 1
    SCENE_DURATION_FRAMES = 150

The importer must not read files, call HTTP, start workflows, or touch a
repository.

- [ ] **Step 4: Confirm GREEN**

    cd python
    rtk uv run pytest tests/application/test_edit_documents.py tests/domain/test_edit_documents.py -q
    rtk uv run ruff check src/thoth_control_plane/application/edit_documents.py tests/application/test_edit_documents.py
    rtk uv run ruff format --check src/thoth_control_plane/application/edit_documents.py tests/application/test_edit_documents.py

- [ ] **Step 5: Commit**

    rtk git add python/src/thoth_control_plane/application python/tests/application/test_edit_documents.py
    rtk git commit -m "feat: import content sets into edit documents"

---

### Task 3: Persist immutable revisions in PostgreSQL

**Files:**

- Modify: python/pyproject.toml
- Modify: python/uv.lock
- Modify: python/src/thoth_control_plane/config.py
- Modify: python/src/thoth_control_plane/application/ports.py
- Create: python/migrations/editor/0001_edit_document_revisions.sql
- Create: python/src/thoth_control_plane/infrastructure/editor_repository.py
- Create: python/src/thoth_control_plane/operations/editor_migrations.py
- Modify: relevant infrastructure/operations __init__.py files
- Modify: python/src/thoth_control_plane/cli.py
- Test: python/tests/infrastructure/test_editor_repository.py

**Interfaces:**

- Produces EditDocumentRepository.insert_revision(document) and
  get_latest(project_id, document_id).
- Produces PostgresEditDocumentRepository(database_url).
- Produces apply_editor_migrations(database_url, migrations_root).
- Adds optional Settings.THOTH_EDITOR_DATABASE_URL as SecretStr.

- [ ] **Step 1: Write failing repository tests**

Add this protocol:

    class EditDocumentRepository(Protocol):
        async def insert_revision(self, document: EditDocument) -> None: ...

        async def get_latest(
            self, *, project_id: str, document_id: str
        ) -> EditDocument | None: ...

Using a fake async connection/cursor, assert:

- insert uses parameterized INSERT and Jsonb;
- duplicate insert maps UniqueViolation to
  EditDocumentConflict("edit document revision already exists");
- get_latest filters by both IDs, orders revision descending, and limits one;
- stored JSON is revalidated through EditDocument.model_validate();
- invalid stored JSON and connection failure map to
  EditDocumentPersistenceError("edit document persistence unavailable");
- exception messages never include SQL, parameters, or database URL.

Add one optional integration test that runs only when
THOTH_EDITOR_TEST_DATABASE_URL exists. It applies migration 0001 to that
dedicated database, inserts and reads one document, then proves duplicate
revision insertion fails. It must never fall back to THOTH_EDITOR_DATABASE_URL.

- [ ] **Step 2: Confirm RED**

    cd python
    rtk uv run pytest tests/infrastructure/test_editor_repository.py -q

Expected: missing psycopg and repository module.

- [ ] **Step 3: Add and lock psycopg**

Add:

    "psycopg[binary]>=3.2,<4",

Run:

    cd python
    rtk uv lock
    rtk uv sync --all-extras

- [ ] **Step 4: Add settings and migration**

Add:

    THOTH_EDITOR_DATABASE_URL: SecretStr | None = None

Migration 0001 must contain:

    CREATE TABLE IF NOT EXISTS edit_document_revisions (
        project_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        document_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (document_id, revision)
    );

    CREATE INDEX IF NOT EXISTS edit_document_revisions_project_document_idx
        ON edit_document_revisions (project_id, document_id);

The explicit command thoth-control editor migrate loads sorted editor SQL
files, applies them in one transaction, and prints only the count. FastAPI must
not create or alter tables at startup.

- [ ] **Step 5: Implement the psycopg repository**

Use psycopg.AsyncConnection.connect() per operation, parameterized SQL, and:

    Jsonb(document.model_dump(mode="json"))

Define only safe EditDocumentConflict and EditDocumentPersistenceError
exceptions. Do not log SQL, parameters, database URLs, or stored JSON.

- [ ] **Step 6: Confirm GREEN**

    cd python
    rtk uv run pytest tests/infrastructure/test_editor_repository.py -q
    rtk uv run ruff check src/thoth_control_plane/infrastructure/editor_repository.py src/thoth_control_plane/operations/editor_migrations.py tests/infrastructure/test_editor_repository.py
    rtk uv run ruff format --check src/thoth_control_plane/infrastructure/editor_repository.py src/thoth_control_plane/operations/editor_migrations.py tests/infrastructure/test_editor_repository.py
    rtk uv lock --check

Expected: required tests pass. The isolated integration test either passes or
is one explicit skip.

- [ ] **Step 7: Commit**

    rtk git add python/pyproject.toml python/uv.lock python/migrations/editor python/src/thoth_control_plane/config.py python/src/thoth_control_plane/application/ports.py python/src/thoth_control_plane/infrastructure python/src/thoth_control_plane/operations python/src/thoth_control_plane/cli.py python/tests/infrastructure/test_editor_repository.py
    rtk git commit -m "feat: persist immutable edit document revisions"

---

### Task 4: Expose authenticated editor endpoints

**Files:**

- Modify: python/src/thoth_control_plane/application/edit_documents.py
- Create: python/src/thoth_control_plane/api/routes/edit_documents.py
- Modify: python/src/thoth_control_plane/api/routes/__init__.py
- Modify: python/src/thoth_control_plane/api/app.py
- Test: python/tests/api/test_edit_documents.py

**Interfaces:**

- POST /api/v1/projects/{project_id}/edit-documents/import-content-set returns
  EditDocument with 201.
- GET /api/v1/projects/{project_id}/edit-documents/{document_id} returns the
  latest EditDocument.
- create_app() gains optional editor_repository injection.

- [ ] **Step 1: Write failing application/API tests**

Use a MemoryEditDocumentRepository inside the test module. Assert:

- authenticated valid POST returns 201 and revision 1;
- unknown fields and caller-supplied document_id/revision/actor_id/url/path
  return 422;
- missing or wrong bearer key returns 403;
- GET returns the stored project/document pair;
- a wrong project or missing document returns 404;
- unavailable repository returns 503 with only editor persistence unavailable;
- existing workflow endpoints still work without editor persistence;
- OpenAPI exposes only the two exact editor method/path pairs and named
  ContentSetImportRequest and EditDocument schemas.

- [ ] **Step 2: Confirm RED**

    cd python
    rtk uv run pytest tests/api/test_edit_documents.py -q

- [ ] **Step 3: Implement EditDocumentService**

Implement:

    import_content_set(project_id, request) -> EditDocument
    get_latest(project_id, document_id) -> EditDocument

Generate document_id as edoc_ plus uuid4().hex. Insert revision 1 once. Map a
missing repository value to EditDocumentNotFound. Map only safe repository
availability failures to EditorUnavailable.

- [ ] **Step 4: Add route and app wiring**

Reuse the existing actor/auth dependency. Extract it to api/dependencies.py only
if importing one route from another would create coupling; preserve its
behavior byte-for-byte and keep workflow auth tests green.

create_app() accepts:

    editor_repository: EditDocumentRepository | None = None

Use the injected repository in tests. Otherwise configure
PostgresEditDocumentRepository only when THOTH_EDITOR_DATABASE_URL exists.
Bind an unavailable implementation when absent. Do not make /readyz fail for
this additive absence.

- [ ] **Step 5: Confirm GREEN and regressions**

    cd python
    rtk uv run pytest tests/api/test_edit_documents.py tests/api/test_workflows.py -q
    rtk uv run ruff check src/thoth_control_plane/api src/thoth_control_plane/application/edit_documents.py tests/api/test_edit_documents.py
    rtk uv run ruff format --check src/thoth_control_plane/api src/thoth_control_plane/application/edit_documents.py tests/api/test_edit_documents.py

- [ ] **Step 6: Commit**

    rtk git add python/src/thoth_control_plane/application/edit_documents.py python/src/thoth_control_plane/api python/tests/api/test_edit_documents.py
    rtk git commit -m "feat: expose edit document endpoints"

---

### Task 5: Regenerate OpenAPI and add the dashboard client

**Files:**

- Modify: python/openapi.json
- Modify: dashboard/src/api/generated/control-plane.ts
- Modify: dashboard/src/api/control-plane.ts
- Modify: dashboard/src/api/control-plane.test.ts

**Interfaces:**

- Produces generated ContentSetImportRequest and EditDocument aliases.
- Produces importContentSet(projectId, request) and
  getEditDocument(projectId, documentId).

- [ ] **Step 1: Write failing client tests**

Mock fetch and assert import uses encoded project ID, POST, JSON content type,
and the exact sanitized body. Assert get uses both encoded IDs and GET.
Preserve the existing status-only non-2xx error behavior.

    cd dashboard
    rtk bun test src/api/control-plane.test.ts

Expected: compile/test failure because methods do not exist.

- [ ] **Step 2: Regenerate contracts**

    cd python
    rtk uv run python scripts/export_openapi.py
    cd ..\dashboard
    rtk bun run generate:control-plane-types

- [ ] **Step 3: Implement aliases and client methods**

Add generated aliases from components["schemas"]. Extend ControlPlaneClient
with both methods. Use encodeURIComponent for every identifier and the existing
request() helper for auth and status handling.

- [ ] **Step 4: Confirm GREEN and stable generation**

    cd dashboard
    rtk bun test src/api/control-plane.test.ts
    rtk bun run build
    cd ..\python
    rtk uv run python scripts/export_openapi.py
    cd ..\dashboard
    rtk bun run generate:control-plane-types

Confirm the second generation completes without rewriting either file beyond
the already-intended Task 5 changes. The repository-wide zero-diff regeneration
check runs after this task is committed in Task 9.

- [ ] **Step 5: Commit**

    rtk git add python/openapi.json dashboard/src/api/generated/control-plane.ts dashboard/src/api/control-plane.ts dashboard/src/api/control-plane.test.ts
    rtk git commit -m "feat: add edit document API client"

---

### Task 6: Sanitize the legacy content-set in React

**Files:**

- Create: dashboard/src/features/studio/domain.ts
- Create: dashboard/src/features/studio/domain.test.ts

**Interfaces:**

- Produces buildContentSetImportRequest(content: unknown):
  ContentSetImportRequest.

- [ ] **Step 1: Write failing projection tests**

Use a raw content-set containing title, description, four footage rows, URLs,
absolute Windows/POSIX paths, thumbnails, comments, profile, references, and a
secret marker.

Assert the exact output:

    {
      main: { title: "Main", description: "Summary" },
      footage: [
        { title: "One", platform: "tiktok" },
        { title: "Two", platform: "youtube" },
        { title: "Three", platform: "instagram" }
      ]
    }

Malformed input returns {main: {}, footage: []}. Non-string and empty values are
omitted. The serialized result contains none of http, C:\\, /home/, token,
comments, profile, or references.

- [ ] **Step 2: Confirm RED**

    cd dashboard
    rtk bun test src/features/studio/domain.test.ts

- [ ] **Step 3: Implement the explicit projection**

Use only local isRecord() and optionalString() helpers. Read only the five
approved fields. Never clone, spread, or serialize the raw object. Stop after
three valid footage titles. Return the generated request type; do not add a
frontend schema dependency.

- [ ] **Step 4: Confirm GREEN**

    cd dashboard
    rtk bun test src/features/studio/domain.test.ts
    rtk bun run build

- [ ] **Step 5: Commit**

    rtk git add dashboard/src/features/studio/domain.ts dashboard/src/features/studio/domain.test.ts
    rtk git commit -m "feat: sanitize content sets for Studio"

---

### Task 7: Add the trusted Remotion preview

**Files:**

- Modify: dashboard/package.json and dashboard/bun.lock
- Create: dashboard/src/features/studio/preview.ts
- Create: dashboard/src/features/studio/preview.test.ts
- Create: dashboard/src/features/studio/VerticalTextStory.tsx
- Create: dashboard/src/features/studio/StudioPreview.tsx
- Create: dashboard/src/features/studio/StudioPreview.test.tsx

**Interfaces:**

- Produces getPlayerConfig(), getOrderedTextClips(), VerticalTextStory, and
  StudioPreview.
- StudioPreview consumes Pick<ControlPlaneClient, "getEditDocument">.

- [ ] **Step 1: Pin dependencies**

    cd dashboard
    rtk bun add --exact remotion@4.0.523 @remotion/player@4.0.523

Confirm package.json contains exact versions and @remotion/media is absent.

- [ ] **Step 2: Write failing pure adapter tests**

For the 300-frame fixture, assert:

    getPlayerConfig(document) === {
      durationInFrames: 300,
      fps: 30,
      compositionWidth: 1080,
      compositionHeight: 1920
    }

Assert text clips sort by start_frame without input mutation. Invalid,
non-finite, or non-positive player values throw Invalid edit document.

- [ ] **Step 3: Confirm RED, then implement preview.ts**

    cd dashboard
    rtk bun test src/features/studio/preview.test.ts

Keep preview.ts free of React, DOM, fetch, and Remotion imports.

- [ ] **Step 4: Implement VerticalTextStory**

Use AbsoluteFill and Sequence from remotion. Each clip is rendered at its stored
from/duration range. Render heading and body only as React text nodes. Select
styles only from trusted style_slot values. Use dark neutral surfaces, Thoth
gold, Geist, and safe padding. Do not use dangerouslySetInnerHTML, eval, dynamic
imports, network fetch, or document-provided CSS.

- [ ] **Step 5: Write StudioPreview tests**

Mock @remotion/player and expose received props as data attributes. Assert:

- pending request shows Loading Studio preview;
- success passes document-derived dimensions, fps, duration, and inputProps;
- rejection shows persistent Could not load Studio preview;
- Retry performs one new request;
- Back to Content Set calls onBack;
- raw API exception text and document ID are not rendered as diagnostics.

- [ ] **Step 6: Implement StudioPreview**

Load on each projectId/documentId pair with effect cleanup. Render:

    <Player
      component={VerticalTextStory}
      inputProps={{document}}
      controls
      spaceKeyToPlayOrPause
      {...getPlayerConfig(document)}
    />

Fit the 9:16 stage to available space. Add only loading, retry, back, and player
controls; no editing controls.

- [ ] **Step 7: Confirm GREEN**

    cd dashboard
    rtk bun test src/features/studio/preview.test.ts src/features/studio/StudioPreview.test.tsx
    rtk bun run lint
    rtk bun run build

- [ ] **Step 8: Commit**

    rtk git add dashboard/package.json dashboard/bun.lock dashboard/src/features/studio
    rtk git commit -m "feat: preview edit documents with Remotion"

---

### Task 8: Open Content Set in Studio Preview

**Files:**

- Modify: dashboard/src/components/ContentSet.tsx
- Create or modify: dashboard/src/components/ContentSet.test.tsx
- Modify: dashboard/src/App.tsx
- Test: dashboard/src/App.test.tsx only if App navigation is not covered through
  the component tests.

**Interfaces:**

- ContentSet accepts projectId and onOpenInStudio(request).
- App stores the active project/document pair and mounts StudioPreview.

- [ ] **Step 1: Write failing interaction tests**

Assert Open in Studio is disabled without a project. With a project it calls
onOpenInStudio once with the sanitized request, never the raw content object.
Rejected import retains the Content Set view and shows a persistent safe error.
Keep existing Save and Send to render tests green.

- [ ] **Step 2: Confirm RED**

    cd dashboard
    rtk bun test src/components/ContentSet.test.tsx

- [ ] **Step 3: Add the ContentSet action**

Accept:

    projectId: string | null
    onOpenInStudio:
      (request: ContentSetImportRequest) => Promise<void>

Build the request only through buildContentSetImportRequest(). Disable while
importing, while Scout is busy, without a project, or without content. Reuse the
persistent footer for safe pending/success/failure status.

- [ ] **Step 4: Wire App**

Add studio to the view union and:

    const [studioDocument, setStudioDocument] = useState<{
      projectId: string;
      documentId: string;
    } | null>(null);

The handler calls controlPlaneClient.importContentSet() for the selected project,
stores returned identifiers, and selects Studio. Mount StudioPreview only when
the pair exists. Back selects contentset without deleting data. Do not remove
or rename existing views.

- [ ] **Step 5: Run dashboard regressions**

    cd dashboard
    rtk bun test
    rtk bun run lint
    rtk bun run build

- [ ] **Step 6: Commit**

Stage only files that exist:

    rtk git add dashboard/src/components/ContentSet.tsx dashboard/src/components/ContentSet.test.tsx dashboard/src/App.tsx
    rtk git commit -m "feat: open content sets in Studio preview"

Include App.test.tsx in git add only if the test was required and created.

---

### Task 9: Full verification and audit trail

**Files:**

- Modify: BLUEPRINT.md

- [ ] **Step 1: Run the complete Python gate**

    cd python
    rtk uv run pytest -q
    rtk uv run ruff check .
    rtk uv run ruff format --check .
    rtk uv lock --check

Expected: all required tests pass. Only existing documented platform skips and
the optional isolated PostgreSQL integration skip are allowed.

- [ ] **Step 2: Prove generated contracts are stable**

    cd python
    rtk uv run python scripts/export_openapi.py
    cd ..\dashboard
    rtk bun run generate:control-plane-types
    cd ..
    rtk git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts

Expected: no diff.

- [ ] **Step 3: Run the complete dashboard gate**

    cd dashboard
    rtk bun test
    rtk bun run lint
    rtk bun run build

- [ ] **Step 4: Run the repository-required CUDA build**

From repository root in PowerShell:

    cmd /c ".\build_cuda.bat build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"

Expected: EXIT=0. Do not claim completion from cargo check alone.

- [ ] **Step 5: Check repository hygiene**

    rtk git diff --check
    rtk git status --short
    rtk git log --oneline --decorate -12

Confirm no secret, database URL, fixture, evidence, media, dist, or node_modules
file is staged. Confirm the two pre-existing untracked files remain untouched
and every new commit is one subject line without attribution trailers.

- [ ] **Step 6: Update BLUEPRINT.md**

Append a dated Creator Studio Document Foundation section recording:

- EditDocument v1 and sanitized import boundary;
- immutable PostgreSQL revision persistence and migration command;
- additive authenticated endpoints and generated client;
- Remotion 4.0.523 read-only vertical preview;
- Content Set to Studio navigation;
- exact Python, dashboard, OpenAPI, and CUDA evidence;
- explicit exclusions: no editable draft, Prompt Lab, timeline, server render,
  deployment, or live operation.

Do not mark later Creator Studio sub-projects implemented.

- [ ] **Step 7: Commit the audit trail**

    rtk git add BLUEPRINT.md
    rtk git commit -m "docs: record Creator Studio foundation"

- [ ] **Step 8: Report and stop**

Report in Indonesian:

1. baseline/final HEAD, branch, upstream drift, and worktree state;
2. commit list;
3. contracts and files created;
4. RED-to-GREEN evidence per task;
5. Python, OpenAPI, dashboard, and CUDA results;
6. dependency and migration changes;
7. proof that raw paths/URLs cannot cross the import boundary;
8. preserved untracked files and allowed skips;
9. confirmation that no push, deployment, live request, evidence mutation, or
   acceptance-window action occurred;
10. next checkpoint: independent review before push or Sub-project B.

Stop. Do not infer permission to push or begin Sub-project B.

## Plan Self-Review

### Spec coverage

- EditDocument and invariants: Task 1.
- Sanitized deterministic import: Tasks 2 and 6.
- PostgreSQL revision and migration: Task 3.
- Authenticated API: Task 4.
- OpenAPI client: Task 5.
- Trusted Remotion preview: Task 7.
- Content Set navigation: Task 8.
- Offline gates and audit trail: Task 9.

Excluded editing, Prompt Lab, timeline, server rendering, and live behavior do
not appear as implementation tasks.

### Type consistency

ContentSetImportRequest is generated from Python and consumed by both the
frontend projector and API client. EditDocument is the repository value, API
response, generated TypeScript type, Player configuration input, and composition
input. All preview timing and dimensions come from EditDocument.canvas.

### Scope check

The plan implements only Sub-project A and leaves current product paths
operational. The optional database integration test is isolated by a dedicated
test-only environment variable; all repository decisions also have required
deterministic unit coverage.
