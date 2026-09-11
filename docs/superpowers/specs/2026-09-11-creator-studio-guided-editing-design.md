# Creator Studio Guided Editing Core Design

## 1. Purpose

Sub-project B turns the read-only Creator Studio preview into a durable, guided
editor for the existing `vertical_text_story` template. It adds a small typed
operation language, immutable autosaved revisions, optimistic concurrency,
local undo/redo, and a desktop-first Studio shell. It does not add Prompt Lab,
AI proposals, a timeline, media editing, or rendering.

## 2. User-visible outcome

An authenticated user can open an existing EditDocument in Studio, select a
scene, edit its heading, body, ownership, and duration through the Inspector,
and see the Remotion preview update immediately. Autosave creates a new
immutable revision. The UI reports Saving, Saved, Offline, Conflict, or Failed
without concealing the local draft. Undo and redo affect local edits, then are
autosaved like any other edit.

## 3. Scope

### Included

- A typed, closed set of document operations:
  `replace_text`, `set_ownership`, and `set_scene_duration`.
- Revision numbers greater than or equal to one for schema version one
  documents; prior imported revision-one records remain valid.
- A single deep Python application module that validates, applies, persists,
  and retrieves document operations through one repository seam.
- Atomic PostgreSQL compare-and-append revision persistence.
- One authenticated `PATCH` route using `base_revision` optimistic concurrency.
- Generated OpenAPI and TypeScript client contracts.
- A Studio shell with scene board, Inspector, current selection, local history,
  autosave state, and read-only Remotion preview.
- Keyboard-accessible Undo, Redo, scene selection, Save retry, and conflict
  recovery actions.

### Excluded

- Prompt templates, Improve, Translate, Regenerate, AI proposals, locks, or
  comments (Sub-project C).
- Tracks beyond the existing one visual track, a multi-track timeline, media
  clips, assets, transitions, or audio editing (Sub-project D).
- Renderer jobs, server-side Remotion rendering, output artifacts, deployment,
  secrets, Temporal commands, CLI editing, or live operation.

## 4. Domain contract

`EditDocument.schema_version` remains exactly `1`. `revision` changes from the
Sub-project A import-only restriction to a positive integer. The document still
has exactly one visual track and only text clips.

`EditDocumentOperation` is a strict tagged union. All operations carry a
unique client-generated `operation_id` for request diagnostics only; it is not
stored as creator content.

| Operation | Fields | Effect |
| --- | --- | --- |
| `replace_text` | `clip_id`, `field` (`heading` or `body`), `value` | Replaces one bounded text field and changes that clip ownership to `user_edited`. |
| `set_ownership` | `clip_id`, `ownership` | Changes only the selected clip ownership. |
| `set_scene_duration` | `scene_id`, positive `duration_in_frames` | Changes that scene and its sole clip duration, then reflows all later scene and clip starts contiguously and updates canvas duration. |

Operations are applied in request order to a copy. Any unknown ID, invalid
field, invalid result, duplicate operation ID, or out-of-range value rejects
the entire request. A client never supplies a document JSON, revision number,
server timestamp, filesystem path, URL, secret, or renderer code.

## 5. Persistence and concurrency

The existing `edit_document_revisions` table remains the only editor metadata
table. A save reads the latest row for the project/document inside a
transaction, compares its revision to `base_revision`, validates and applies
the operations, then inserts revision `base_revision + 1`. A mismatch raises a
safe conflict carrying the latest validated document, not database diagnostics.

The repository exposes one external seam:

```python
async def apply_operations(
    *, project_id: str, document_id: str, base_revision: int,
    operations: list[EditDocumentOperation],
) -> EditDocument
```

This deep module owns read, compare, operation application, validation, and
append. In-memory adapters used by tests implement the same seam. FastAPI does
not construct SQL, merge documents, or decide revision numbers.

## 6. API

`PATCH /api/v1/projects/{project_id}/edit-documents/{document_id}` accepts:

```json
{"base_revision": 1, "operations": [{"kind": "replace_text", "operation_id": "op_...", "clip_id": "clip_001", "field": "heading", "value": "Updated title"}]}
```

It returns the complete newly persisted EditDocument with HTTP 200. Missing
documents return 404; an editor store unavailable returns 503; a stale base
revision returns 409 with the latest validated document as its response body.
Authentication follows the existing control-plane bearer dependency. Existing
import, GET, workflow, and health routes remain unchanged.

## 7. Studio interface

The Studio desktop layout has three resizable logical regions without adding a
generic dashboard card grid:

- **Scene board:** ordered scene buttons with role, duration, ownership, and
  edited state. Keyboard selection is supported.
- **Canvas:** current draft rendered by the trusted Remotion composition.
- **Inspector:** heading, body, ownership, and duration controls for the
  selected scene. Controls are ordinary labelled inputs and buttons, not raw
  JSON or arbitrary CSS.

The top bar provides Back, Undo, Redo, and the persistent save state. Autosave
debounces local changes; a manual Retry is available after failed save. A
conflict leaves the local draft intact and offers Reload Latest or Keep Editing
Locally. It never overwrites local work silently.

## 8. Accessibility and security

All scene-board and Inspector actions work without drag-and-drop. Focus order
follows the visual flow. Save/conflict status uses an aria-live region without
moving focus. User input remains bounded typed data rendered as text; the UI
does not expose HTML, JavaScript, FFmpeg flags, paths, URLs, credentials, or
provider payloads.

## 9. Verification

- Python domain tests cover operation order, immutability, reflow, invalid
  operations, and revision validation.
- Repository tests cover atomic compare-and-append and conflict behavior.
- API tests cover authentication, 200, 404, 409, 503, and OpenAPI schema shape.
- Dashboard reducer tests cover undo/redo, state transitions, and conflict
  preservation; component tests cover keyboard-visible controls and safe error
  text.
- Full Python, OpenAPI generation, dashboard test/lint/build, and required
  `build_cuda.bat` gates run before the audit trail update.
