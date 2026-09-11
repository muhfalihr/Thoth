# Creator Studio Document Foundation and Preview Design

**Date:** 2026-09-11  
**Status:** Proposed sub-project design  
**Parent design:**
docs/superpowers/specs/2026-09-11-ui-first-creator-studio-design.md

## 1. Objective

Prove the Creator Studio architecture through the smallest durable vertical
slice:

1. transform a sanitized projection of the existing content-set into a typed
   EditDocument version 1;
2. persist its first immutable revision in application PostgreSQL;
3. expose it through the Python control-plane OpenAPI contract;
4. render that exact document in a read-only Remotion Player inside the current
   React dashboard.

This slice establishes the document, API, persistence, and preview boundaries.
It intentionally does not implement editing breadth.

## 2. User-visible outcome

From the existing Content Set view, an operator with a selected project can
choose Open in Studio. The dashboard sends a sanitized, text-only projection to
the Python control plane. The control plane creates revision 1 of an
EditDocument and returns its identifiers. The dashboard opens a new Studio
Preview view and displays the stored revision through Remotion Player.

Reloading the document from the API produces the same preview. No CLI is needed
for this creative flow once the services are running.

## 3. Scope

### Included

- Strict EditDocument version 1 contracts for canvas, scenes, tracks, and text
  clips.
- A pure legacy content-set projection and importer.
- Immutable revision-1 PostgreSQL persistence.
- Explicit database schema migration.
- Authenticated create-from-content-set and get-document endpoints.
- Generated TypeScript types from FastAPI OpenAPI.
- One trusted 9:16 text-story Remotion composition.
- A read-only Studio Preview view using Remotion Player.
- Navigation from the current Content Set view.
- Offline unit, API, frontend, and contract verification.

### Excluded

- Draft mutation, autosave, undo/redo, optimistic save conflicts, or revision 2.
- Media upload, AssetCatalog persistence, or playback of imported source media.
- Prompt Lab, AI proposals, translation, ownership transitions, or locks.
- Advanced timeline, drag/drop, trim, split, keyframes, or audio.
- Server-side Remotion rendering and render jobs.
- Changes to existing Rust/FFmpeg rendering.
- Deployment, live provider requests, evidence mutation, or Stage 1 operations.

## 4. Sanitized content-set boundary

The existing dashboard content-set is intentionally opaque and may contain
absolute paths, source URLs, thumbnails, profile data, and forward-compatible
fields. The Python editor API must not receive that raw object.

The dashboard creates an explicit ContentSetImportRequest containing only:

- main.title;
- main.description;
- up to three footage entries, each with title and platform.

Empty strings are normalized to absence. URLs, image paths, thumbnails,
comments, profiles, references, unknown fields, and any other content-set data
are not copied into the request.

The request contract rejects unknown fields. This makes the browser-to-control-
plane boundary inspectable and prevents legacy paths or URLs from becoming
canonical editor data.

## 5. EditDocument version 1

Revision 1 uses a deliberately narrow discriminated model that can be extended
with additional clip variants later without changing existing text clips.

### 5.1 Identity

- schema_version is exactly 1.
- document_id is an opaque server-generated identifier with the edoc_ prefix.
- project_id is the selected existing project identifier.
- revision is exactly 1 for this sub-project.
- template is vertical_text_story at version 1.

### 5.2 Canvas

- width: 1080;
- height: 1920;
- fps: 30;
- duration_in_frames: the end frame of the final clip.

Frame numbers are non-negative integers. Durations are positive integers.

### 5.3 Scenes

Each scene contains:

- a stable scene_id;
- role: title or source;
- start_frame;
- duration_in_frames;
- ordered clip_ids.

Scenes are contiguous, ordered, and non-overlapping in revision 1.

### 5.4 Tracks

Revision 1 contains one visual track:

- track_id: track_visual;
- kind: visual;
- ordered clip_ids matching scene order.

### 5.5 Text clips

Each text clip contains:

- clip_id, scene_id, and track_id;
- kind: text;
- start_frame and duration_in_frames;
- heading;
- optional body;
- style_slot: title or source;
- ownership: ai_managed.

Unknown clip kinds and unknown fields are rejected. Text length and list limits
are bounded in the API models.

## 6. Import mapping

The importer is a pure function.

1. It always creates one title scene.
2. The title scene uses main.title or Untitled video when the title is absent.
3. The title scene body uses main.description when present.
4. It creates one source scene for each of the first three non-empty footage
   titles.
5. A source scene body contains only the normalized platform label when
   present.
6. Every scene lasts 150 frames.
7. Scene and clip identifiers are deterministic within the generated document
   order.
8. All imported clips begin as ai_managed.

The importer never reads files, downloads assets, resolves URLs, calls a
provider, or starts a workflow.

## 7. Persistence

Editor metadata uses application PostgreSQL and does not use Temporal's
internal database tables.

The first migration creates edit_document_revisions with:

- project_id text, not null;
- document_id text, not null;
- revision integer, not null;
- document_json jsonb, not null;
- created_at timestamptz, not null;
- primary key on document_id and revision;
- index on project_id and document_id.

Creation inserts one row in a transaction. A conflicting document/revision
fails instead of overwriting. The read path requires both project_id and
document_id and returns the latest revision for that project.

The connection string comes from optional THOTH_EDITOR_DATABASE_URL. The value
is secret and must never appear in diagnostics. When it is absent or the editor
repository is unavailable, only editor endpoints return 503; existing workflow,
health, and readiness behavior remains unchanged.

Database schema changes run through an explicit editor migration command. The
FastAPI process does not create or alter tables at startup.

## 8. API

Both endpoints use the existing bearer authentication and actor derivation.

### POST /api/v1/projects/{project_id}/edit-documents/import-content-set

- Request: ContentSetImportRequest.
- Response: EditDocument with HTTP 201.
- Rejects invalid project IDs or request fields with 422.
- Returns 503 when editor persistence is not configured or available.
- Never accepts document_id, revision, actor identity, paths, or URLs from the
  request.

### GET /api/v1/projects/{project_id}/edit-documents/{document_id}

- Response: latest EditDocument with HTTP 200.
- Returns 404 when the project/document pair does not exist.
- Returns 503 when editor persistence is not configured or available.

The generated OpenAPI document is committed, and the dashboard TypeScript
client is regenerated from it. The API keeps the existing contract-version
header because these endpoints are additive.

## 9. Remotion preview

The dashboard pins matching versions of remotion and @remotion/player. The
first composition is a trusted React component owned by the repository.

The composition:

- accepts only the generated EditDocument contract;
- uses Sequence to display each text clip at its stored frame range;
- uses the document canvas and fps without independent defaults;
- renders a restrained Thoth dark background, gold accent, heading, and body;
- contains no network fetch, user HTML, dynamic import, or executable string;
- uses only repository-pinned fonts and styles.

Remotion Player receives the stored document as input props. Its
durationInFrames, compositionWidth, compositionHeight, and fps come directly
from that document. Playback controls and keyboard play/pause are enabled.

This template is a contract proof, not the production visual template and not a
claim of media editing completeness.

## 10. Dashboard integration

The current stack and existing views remain operational.

- Add studio to the App view union.
- Keep the selected project in the existing ProjectSwitcher.
- ContentSet receives the selected project ID.
- Open in Studio is disabled when no project or no content-set is available.
- Clicking it builds the sanitized request, calls the import endpoint, and
  switches to Studio Preview using the returned document ID.
- Studio Preview loads the document through the generated control-plane client.
- Loading, unavailable, not-found, and malformed-document states are persistent
  inline states, not transient toasts.
- A Back to Content Set action returns without mutating either record.

No current Run, Workflow, Profile, Discovery, or Content Set behavior is
removed in this sub-project.

## 11. File boundaries

Python:

- domain/edit_documents.py owns strict models and invariants;
- application/edit_documents.py owns importer and use cases;
- application/ports.py owns the repository protocol;
- infrastructure/editor_repository.py owns PostgreSQL persistence;
- api/routes/edit_documents.py owns HTTP translation only;
- operations/editor_migrations.py owns explicit schema migration.

Dashboard:

- api/control-plane.ts owns typed HTTP calls;
- features/studio/domain.ts owns frontend-only conversion helpers;
- features/studio/VerticalTextStory.tsx owns the Remotion composition;
- features/studio/StudioPreview.tsx owns loading and Player integration;
- ContentSet.tsx triggers the sanitized import;
- App.tsx owns navigation state only.

Files remain focused; the plan must not move unrelated existing code.

## 12. Error and security behavior

- Strict models reject implicit coercion and unknown fields.
- Text fields and collection sizes are bounded.
- Persistence errors map to stable safe API messages.
- SQL uses parameters; document_json is serialized from a validated model.
- Database URLs, SQL exception text, paths, raw content-set JSON, and source
  URLs are not returned or logged.
- The dashboard does not send content fields excluded by Section 4.
- The composition renders text as React text nodes and does not use
  dangerouslySetInnerHTML.

## 13. Verification

The sub-project requires:

- domain tests for invalid frame ranges, duration mismatch, unknown fields, and
  valid round trips;
- importer tests for deterministic mapping, truncation to three footage items,
  empty normalization, and exclusion of URL/path data;
- repository tests for insert-once and project-scoped reads;
- API tests for auth, 201, 404, 422, 503, and safe OpenAPI schemas;
- frontend tests for sanitized projection and Studio navigation;
- composition tests for document-derived Player configuration and scene
  sequences;
- dashboard typecheck, test, lint, and build;
- Python pytest and Ruff checks;
- OpenAPI regeneration drift check.

No live URL, provider, browser acquisition, Docker deployment, Stage 1
evidence, or production database is used for verification.

## 14. Acceptance criteria

The sub-project is complete when:

1. a sanitized existing content-set projection creates a valid stored
   EditDocument revision 1;
2. the raw content-set's URL/path fields cannot enter the request or stored
   document;
3. the document can be retrieved only through its project/document pair;
4. the same retrieved document configures and renders the read-only Remotion
   preview;
5. reload preserves the preview contract;
6. existing dashboard and workflow functionality remains available;
7. all verification in Section 13 passes;
8. no deployment or live operation is performed.

The next sub-project may add editable drafts only after this document and
preview contract is independently reviewed.
