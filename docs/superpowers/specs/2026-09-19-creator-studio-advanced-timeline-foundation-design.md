# Creator Studio Advanced Timeline Foundation Design

**Date:** 2026-09-19
**Status:** Approved in brainstorming; implementation requires a separate plan
**Parent:** `docs/superpowers/specs/2026-09-11-ui-first-creator-studio-design.md`
**Predecessors:**

- `docs/superpowers/specs/2026-09-11-creator-studio-document-preview-design.md`
- `docs/superpowers/specs/2026-09-11-creator-studio-guided-editing-design.md`
- `docs/superpowers/specs/2026-09-12-creator-studio-prompt-lab-foundation-design.md`
- `docs/superpowers/specs/2026-09-13-creator-studio-prompt-lab-ai-proposals-design.md`

## 1. Purpose

Sub-project D1 adds the first advanced multi-track timeline to Creator Studio.
It extends the current text-only, single-visual-track editor into a typed video
editing document that can represent main video, B-roll, trusted overlays,
captions, narration, music, and sound effects. A creator can select, move, trim,
split, and snap clips while the existing Remotion Player previews the same local
draft that will be saved.

D1 is a document and editing foundation, not a rendering rollout. It does not
add media upload or acquisition, a render queue, final server-side rendering,
or any live provider operation.

## 2. User-visible outcome

An authenticated creator can explicitly upgrade an existing version 1 Studio
document to version 2, switch between Simple and Advanced editing without
forking the document, and edit approved project assets on a synchronized
multi-track timeline. Pointer interactions have equivalent labelled controls or
keyboard actions. Autosave creates immutable document revisions, and failures
never silently discard the local draft.

The current Scene Board remains the Simple projection. Advanced mode adds a
desktop-only timeline beneath the same preview and Inspector.

## 3. Design principles

1. `EditDocument`, not the timeline component or Remotion, is the canonical
   model.
2. Simple mode, Advanced mode, the Inspector, and preview are projections of
   one draft.
3. Browser mutations are a closed union of typed operations, never replacement
   document JSON or executable renderer input.
4. Frame numbers are the canonical time unit. Seconds and timecode are display
   projections.
5. The server validates every persisted result. Client validation exists only
   for immediate feedback.
6. D1 reuses the existing reducer, optimistic revision, autosave, conflict, and
   OpenAPI boundaries. It adds no global state library, event store, timeline
   dependency, or service.
7. Existing version 1 revisions and the current production rendering path stay
   valid.

## 4. Scope

### 4.1 Included

- `EditDocument` schema version 2 with typed tracks, clips, and immutable asset
  references.
- Explicit, idempotent migration from a version 1 revision to a new version 2
  revision.
- Track kinds for main video, B-roll, overlay, caption, narration, music, and
  sound effects.
- A minimal project-scoped editor asset catalog for already approved pipeline
  or content-set artifacts.
- Timeline selection, playhead, zoom, snapping, move, trim, split, explicit
  ripple mode, track ordering, visibility or mute, and locks.
- Local preview during a gesture and one persisted operation when the gesture
  or keyboard action completes.
- Keyboard and labelled-control alternatives for pointer interactions.
- Existing immutable revision, autosave, offline, reconnect, undo/redo, and
  conflict semantics extended to timeline operations.
- Persistent validation issues that focus the affected track, clip, or field.
- Offline domain, persistence, API, generated-contract, dashboard, Remotion
  preview, accessibility, and regression verification.

### 4.2 Excluded

- Uploading, downloading, discovering, or acquiring new media.
- TikTok, provider, Scout-live, or other external requests.
- Server-side Remotion rendering, render jobs, export, output artifacts, or
  deployment.
- Filmstrip generation, waveform generation, multi-selection, keyframes,
  volume envelopes, arbitrary track effects, or user-authored components.
- Remotion Editor Starter, a commercial timeline component, or another
  timeline/state dependency.
- Replacing the Rust/FFmpeg production renderer or changing Stage 1 operations.

## 5. EditDocument version 2

Version 2 preserves the existing project, canvas, template, scene, revision,
and validation concepts while widening the document's timeline model.

```text
EditDocument v2
|-- canvas
|-- scenes[]
|-- tracks[]
|   |-- main_video
|   |-- b_roll
|   |-- overlay
|   |-- caption
|   |-- narration
|   |-- music
|   `-- sfx
|-- clips[]
|-- asset_refs[]
|-- revision
`-- validation metadata
```

### 5.1 Tracks

A track has a stable identifier, typed kind, user-visible label, order,
visibility or mute state as appropriate, and lock state. Multiple tracks may
share a kind where layering requires it. Track order determines visual stacking
for visual kinds and lane order for audio kinds; it does not grant permission to
place an incompatible clip kind on the track.

Removing a track is valid only when it is empty. Moving clips and removing them
are separate explicit operations.

### 5.2 Clips

Every clip has:

- a stable clip ID;
- a track ID and optional scene association;
- `from_frame` and positive `duration_in_frames`;
- ownership of `ai_managed`, `user_edited`, or `locked`;
- hidden or lock state where applicable; and
- a discriminated, strictly validated clip kind.

Kind-specific data is limited to:

- **video or B-roll:** immutable `asset_id`, source trim, crop, position, and
  supported fit mode;
- **overlay:** a trusted component or preset ID and bounded parameters;
- **caption:** cue or word timing, text, and trusted style reference;
- **narration, music, or SFX:** immutable `asset_id`, source trim, volume, and
  bounded fade values.

Documents contain no local path, storage locator, arbitrary URL, JSX,
JavaScript, CSS, shell argument, or FFmpeg expression.

### 5.3 Timeline invariants

- All timing is expressed as integer frames at the document canvas FPS.
- A clip remains within the canvas and, where backed by media, within the source
  duration after trim.
- An empty main-video track is permitted for migrated text-only documents. Once
  populated, main-video clips cannot overlap; explicit ripple mode maintains a
  contiguous main sequence.
- B-roll, overlay, caption, and audio clips may overlap when their track-kind
  constraints permit it.
- Locked tracks and clips reject mutations.
- Caption cues, audio, and scene associations cannot extend beyond their clip
  or canvas boundaries.

## 6. Version 1 upgrade

Opening a version 1 document remains read-only compatible and causes no write.
The creator must choose **Enable advanced timeline**. The server then runs a
pure, deterministic migration against the stated base revision and appends a
new version 2 revision in one transaction.

The migration preserves scene IDs, text clip IDs where their type remains
compatible, text content, durations, ownership, template identity, and canvas
settings. It creates the required typed track structure and leaves media tracks
empty when the source document has no approved media identity. It never guesses
a file, URL, or asset.

The upgrade accepts an idempotency key. An identical replay returns the same
result; a changed base revision returns a conflict. Version 1 remains in
immutable history. After upgrade, Simple and Advanced modes both edit the same
version 2 draft.

## 7. Typed editing operations

D1 extends the existing `EditDocumentOperation` union with:

- `add_track`;
- `remove_empty_track`;
- `reorder_track`;
- `add_clip_from_asset`;
- `remove_clip`;
- `move_clip`;
- `trim_clip_start`;
- `trim_clip_end`;
- `split_clip`;
- `set_clip_hidden`;
- `set_clip_locked`;
- `set_track_visibility` or `set_track_muted`, as appropriate;
- `set_track_locked`; and
- `set_clip_volume`.

Existing text, ownership, and scene-duration operations remain valid when their
targets and resulting version 2 document satisfy the new invariants.

Every operation has a unique client-generated `operation_id`. A split operation
also supplies two new opaque clip IDs so replay produces the same identity; the
server rejects collisions or reuse. Operations are applied in request order to
a copy of the current base revision. Any invalid operation rejects the complete
patch and persists nothing.

Ripple is an explicit operation mode. Snapping is a client-side authoring aid
against frame boundaries, clip edges, scene boundaries, and the playhead; the
server validates only the submitted integer-frame result and never trusts the
client calculation.

## 8. Local editing and save flow

```text
Pointer, keyboard, or Inspector action
  -> reducer applies an operation to the local draft
  -> Remotion Player receives the draft as input props
  -> autosave sends base_revision plus pending operations
  -> server validates and compare-and-appends a revision
  -> client adopts the stored revision as its new base
```

Dragging and trimming may update the local preview continuously, but only one
final operation is queued when the interaction completes. Scrubbing and
playhead movement are transient UI state and never persist.

Undo and redo create inverse local operations and save like any other edit.
There is no new event store or server-side undo service. A revision conflict
returns the latest validated document while preserving the local draft and
pending operations. The creator explicitly chooses `Reload latest` or
`Keep editing locally`; D1 performs no automatic merge.

## 9. Studio interaction design

The existing Guided Studio remains one workspace:

```text
+------------------------------------------------------------------+
| Project | Save | Undo/Redo | Simple/Advanced | Preview controls |
+--------------+-------------------------------+-------------------+
| Scenes /     |                               | Inspector         |
| Assets /     |       Remotion Player         |                   |
| Prompt Lab   |                               |                   |
+--------------+-------------------------------+-------------------+
| Timeline toolbar | playhead | zoom | snapping | split | ripple  |
+--------------+---------------------------------------------------+
| Track header | clip lanes                                        |
+--------------+---------------------------------------------------+
```

- Simple mode retains the Scene Board.
- Advanced mode shows the multi-track workspace beneath the same canvas.
- D1 permits one selected clip or track at a time.
- The Inspector renders typed controls for the current selection.
- Track headers expose label, visibility or mute, and lock state.
- Timeline controls expose play/pause, current frame or timecode, zoom,
  snapping, split, ripple mode, and adding a clip from an approved asset.
- Keyboard actions cover selection navigation, one-frame and larger-step
  movement, start/end trim, split at playhead, and equivalent track actions.
- Blocks use safe labels and duration in D1. Filmstrips and waveforms wait for
  separately validated derivatives.
- Advanced mode requires a desktop viewport. Tablet and phone continue to use
  Simple or review surfaces.

## 10. Remotion Player synchronization

One `PlayerRef` bridges preview and timeline state:

- `frameupdate` updates the playhead;
- `seeked`, `play`, and `pause` update controls;
- timeline scrubbing calls `seekTo(frame)`;
- the current draft is passed through Player `inputProps`; and
- every listener is removed on unmount, document switch, or ref replacement.

The timeline never mirrors the creative document into a second model. Preview
errors update persistent UI state but do not mutate the draft or saved revision.

## 11. Editor asset boundary

D1 introduces a minimal project-scoped editor asset catalog for media already
known to the system. It does not expose upload or acquisition.

An asset record contains an immutable ID, project ownership, media kind,
duration, dimensions, frame rate, audio presence, validation state, provenance,
and a server-only artifact locator. `EditDocument` stores only the immutable
asset ID.

The browser receives safe metadata and an opaque, short-lived preview
capability scoped to the authenticated user, project, and asset. The preview
route supports the CORS and byte-range behavior required for efficient seeking,
but never reveals the backing path or storage credential. Capability values are
excluded from documents, persistence, logs, error bodies, and render inputs and
expire independently of document revisions.

## 12. API contract

All paths use the existing authenticated `/api/v1` boundary.

| Method | Path | Outcome |
| --- | --- | --- |
| `POST` | `/projects/{project_id}/edit-documents/{document_id}/upgrade-timeline` | Idempotently append a version 2 revision from the stated version 1 base. |
| `PATCH` | `/projects/{project_id}/edit-documents/{document_id}` | Apply the widened typed operation union through existing optimistic concurrency. |
| `GET` | `/projects/{project_id}/editor-assets` | Return a bounded safe catalog of approved project assets. |
| `POST` | `/projects/{project_id}/editor-assets/{asset_id}/preview-capability` | Return a short-lived opaque preview capability. |
| `GET` | `/projects/{project_id}/editor-assets/{asset_id}/preview` | Serve authorized preview media with controlled content type and range behavior. |

Asset listing is paginated or server-bounded. The preview endpoint accepts only
an asset ID and server-issued capability, never a URL or path. OpenAPI remains
the source for generated dashboard types and client methods.

## 13. Persistence

The existing editor revision store remains append-only and stores complete,
validated version 2 documents. A forward-only editor migration adds only the
minimal asset metadata and timeline-upgrade idempotency records that cannot live
inside immutable revision JSON.

Metadata and artifact location are separate: the latter never crosses the
repository or API boundary as browser data. Version upgrade and operation
patches use the existing transaction-level compare-and-append behavior.
Parameterized writes, project ownership predicates, and rollback on any failed
precondition remain mandatory.

No event log, second document store, websocket, queue, or timeline database is
introduced.

## 14. Validation and failures

The browser validates interactions for immediate feedback. The server rechecks:

- project and document ownership;
- track and clip identity;
- track/clip kind compatibility;
- asset existence, ownership, readiness, and compatibility;
- source trim, canvas bounds, timing, overlap, gap, caption, and audio rules;
- lock state;
- operation ID uniqueness and split-ID uniqueness; and
- base revision and complete resulting document validity.

The Studio exposes a persistent Issues panel. Selecting an issue focuses its
track, clip, scene, or field. Safe public failure codes include:

- `document_revision_conflict`;
- `timeline_operation_invalid`;
- `timeline_constraint_violation`;
- `asset_not_found`;
- `asset_not_ready`;
- `asset_incompatible`;
- `clip_locked`;
- `track_locked`;
- `editor_store_unavailable`; and
- `preview_unavailable`.

Failure responses contain no path, locator, stack trace, probe payload, secret,
or preview capability.

Autosave failure preserves the draft and pending operations. Offline mode keeps
loaded data and local edits but blocks server mutations. Reconnection checks
the base revision before saving. A monotonic document generation guard causes
late async responses from an old document or unmounted editor to be discarded.
There is no unbounded network retry.

## 15. Security and reproducibility

- User input remains strictly validated data, never executable code.
- Only trusted compositions and overlay/component presets execute in Remotion.
- Assets are project-scoped immutable identities whose media passed server
  validation.
- Preview capabilities are short-lived, least-scope, redacted, and unusable for
  a different project or asset.
- Renderer configuration, storage credentials, provider credentials, paths,
  hidden prompt policy, and raw payloads never enter browser contracts.
- A saved revision remains reproducible from its asset IDs, template version,
  document schema version, and existing provenance, independent of preview
  capability expiry.

## 16. Verification strategy

### 16.1 Domain and persistence

- Deterministic, idempotent version 1 to version 2 migration with no mutation of
  the source revision.
- Strict track/clip unions and every timeline invariant.
- Move, trim, split, explicit ripple, track ordering, visibility or mute, lock,
  volume, add, and remove operations.
- Atomic rollback when any operation fails.
- Optimistic conflict, operation/split identity replay, and project isolation.
- Parameterized asset and revision persistence.
- Missing, unready, incompatible, or cross-project asset rejection.

### 16.2 API and generated contracts

- Authentication and ownership for every new route.
- Safe error envelopes and bounded asset listing.
- Preview capability scope, expiry, range handling, and log redaction.
- Version 1 read compatibility and version 2 mutation.
- OpenAPI export and generated TypeScript regeneration repeated until stable.
- Explicit schema inspection proving paths, secrets, locators, and capabilities
  do not appear in persisted document contracts.

### 16.3 Dashboard and preview

- Simple and Advanced modes preserve one draft and selection-valid state.
- PlayerRef playhead, seek, play/pause synchronization and listener cleanup.
- Pointer and keyboard/button variants for move, trim, and split.
- Snapping and explicit ripple behavior.
- Track/clip locks and typed Inspector controls.
- Autosave, undo/redo, offline, reconnect, conflict, and failed preview.
- Document-switch and unmount stale-response rejection.
- Issues-panel focus behavior and desktop viewport gating.
- Prompt Lab C1/C2, Scene Board, and existing editor regression suites.
- Full dashboard test, lint, typecheck, and production build gates.

### 16.4 Repository gates

The implementation plan must enumerate affected Python, dashboard, migration,
generated-contract, Compose-contract, Rust, and Scout gates based on the actual
diff. No live request is part of D1 verification.

## 17. Acceptance criteria

| ID | Requirement |
| --- | --- |
| AC1 | A version 1 document is upgraded only by an explicit idempotent action that appends a version 2 revision and preserves prior history. |
| AC2 | Version 2 represents main video, B-roll, overlay, caption, narration, music, and SFX tracks with strict compatible clip kinds. |
| AC3 | A creator can select, move, trim, split, and snap a clip and can use explicit ripple mode. |
| AC4 | Timeline edits update the same local draft shown by Remotion Player and persist as immutable revisions. |
| AC5 | Simple and Advanced modes never fork or flatten the document. |
| AC6 | Every pointer editing action has a keyboard or labelled-control alternative. |
| AC7 | Only approved project assets can be referenced; documents and browser contracts reveal no storage path or credential. |
| AC8 | Offline, conflict, preview failure, and invalid assets preserve the local draft and report persistent actionable state. |
| AC9 | Late async work from a previous document or unmounted editor cannot alter current state or invoke current callbacks. |
| AC10 | Version 1 compatibility and all existing Prompt Lab and guided-editor behavior remain covered by regression tests. |
| AC11 | Offline domain, persistence, API, generated-contract, dashboard, accessibility, lint, typecheck, and build gates pass. |

## 18. Delivery boundaries

Delivery remains separated into operator-approved gates:

1. offline implementation and verification;
2. independent Codex review and any corrective rounds;
3. push and CI or image publication;
4. deployment or restart;
5. any media/provider/live request;
6. later render-queue and production rollout work.

Operator approval after reviewing this written specification authorizes only
creation and review of an implementation plan. It does not authorize
product-code implementation, push, publication, deployment, real asset or
secret access, live requests, render jobs, Stage 1 operations, parity,
controlled fallback, evidence mutation, Issue #5 mutation, or an acceptance
window.
