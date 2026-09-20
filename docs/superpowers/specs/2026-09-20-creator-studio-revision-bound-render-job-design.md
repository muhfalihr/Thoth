# Creator Studio E1 Revision-Bound Render Job Design

**Date:** 2026-09-20

**Status:** Conversational design approved; written specification awaiting
operator review

**Parent:**
`docs/superpowers/specs/2026-09-11-ui-first-creator-studio-design.md`

**Predecessor:**
`docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md`

## 1. Purpose

Sub-project E1 adds the first revision-bound final-render workflow to Creator
Studio. An authenticated creator can render one saved and valid
`EditDocument` revision through a dedicated Remotion renderer, monitor truthful
progress, cancel it, retry it as a new job, download the completed MP4, and
clean up its files without using a CLI or learning a filesystem path.

E1 deliberately does not add a general queue. One installation accepts at most
one active render job. A second request receives `render_busy` rather than
waiting in a backlog. This keeps the first production-shaped render path small
while retaining durable status, isolation, cancellation, and auditability.

The existing Rust/FFmpeg rendering path remains operational and unchanged.

## 2. Approved decisions

1. Rendering is asynchronous and durable, but E1 adds no message broker,
   Temporal render task queue, Redis, RabbitMQ, Kafka, or pending-job backlog.
2. One dedicated Bun/TypeScript `remotion-renderer` service performs one job at
   a time. The Python API never launches Chromium, Bun, or Docker directly and
   never receives the Docker socket.
3. The Python control plane remains the sole owner of persistence. The renderer
   has no database credential and communicates through a private authenticated
   HTTP protocol carrying typed render-job data.
4. Every job points to one immutable saved document revision. Later edits do
   not affect it.
5. Retry creates a new job linked by `retry_of_job_id`; no terminal job is
   reopened or overwritten.
6. E1 stores artifacts on the local filesystem under the existing
   `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`. S3-compatible storage is deferred.
7. All new generated files live below that one canonical root. Migrating legacy
   Rust, Python, or Scout output paths is a separate sub-project.
8. The browser downloads through an authenticated API endpoint and never sees
   a local path, storage locator, service credential, or renderer URL.
9. E1 exposes one trusted output preset. Low-level Remotion and FFmpeg settings
   are server-owned.
10. Cancellation, a maximum deadline, safe partial-output cleanup, and retained
    diagnostic metadata are part of E1.

## 3. User-visible outcome

Creator Studio adds a **Render video** action and a bounded render-history
panel.

The action is enabled only when:

- the selected document revision is saved;
- the draft is not dirty, saving, conflicted, or offline;
- canonical document validation reports no blocking issue;
- the configured renderer is available; and
- no render job is active for the installation.

The UI always exposes an accessible reason while the action is disabled.

Before creation, a confirmation dialog shows the project, document revision,
template version, resolution, frame rate, and trusted output preset. After
creation, the panel shows the authoritative status, trustworthy progress when
available, elapsed time, revision, and the actions permitted by the current
state.

- Active jobs expose **Cancel**.
- Failed and cancelled jobs expose **Retry**.
- Completed jobs expose **Download** and **Cleanup**.
- Cleanup requires explicit confirmation and removes files, not the database
  audit record.
- A page reload resumes monitoring the same job and never creates another one.

## 4. Scope

### 4.1 Included

- A durable `RenderJob` domain model, append-only database migration,
  repository, application service, public API, and generated dashboard client.
- One-active-job concurrency enforcement and create idempotency.
- One trusted Remotion composition selected from an allowlisted template
  registry.
- A separate Bun/TypeScript renderer container with one active slot.
- A private authenticated control-plane-to-renderer protocol.
- Server-built immutable render bundles containing only validated document,
  template, preset, and staged-asset projections.
- Asset staging, checksums, per-job workspaces, temporary output, atomic final
  publication, and safe cleanup under the canonical artifact root.
- Progress, cancellation, deadline, safe failure codes, retry lineage,
  authenticated streaming download, and bounded newest-first history.
- Dashboard submission, monitoring, cancellation, retry, download, cleanup,
  offline behavior, reload recovery, and accessibility coverage.
- Offline unit, integration, container, codec, path-security, and regression
  verification.

### 4.2 Excluded

- A pending render queue or more than one concurrent render.
- Automatic retry, exponential backoff, or automatic recovery of a job after
  API or renderer restart.
- Redis, RabbitMQ, Kafka, a new Temporal workflow, or another broker.
- S3, object storage, signed cloud URLs, CDN delivery, or cloud autoscaling.
- Multiple templates, user-selected codecs, bitrate controls, arbitrary
  resolution, renderer flags, or user-authored executable code.
- Media upload, discovery, acquisition, TikTok, provider, or Scout-live work.
- Migrating historical output directories into the canonical root.
- Replacing or modifying the Rust/FFmpeg production renderer.
- Preview/render parity rollout, golden-frame release gates, responsive review,
  template rollout, deployment, or production cutover; those belong to later
  phases.

## 5. Module architecture

```text
Dashboard
   | authenticated public API
   v
RenderJobs module -- Python control plane
   |-- domain state machine
   |-- application service and repository interface
   |-- PostgreSQL repository adapter
   |-- ArtifactRoot path interface and local adapter
   `-- RendererGateway interface
            | private authenticated HTTP
            v
      remotion-renderer -- Bun/TypeScript container
            |-- trusted composition registry
            |-- bundle validator
            |-- one active render process
            `-- progress/result reporter
```

`RenderJobs` is the public deep module. Browser callers learn only job
creation, status, cancel, retry, output download, and artifact cleanup. They do
not learn renderer endpoints, storage layout, process lifecycle, or Remotion
configuration.

`ArtifactRoot` is the only module allowed to create or resolve an E1 path. It
accepts typed identifiers and relative names, not arbitrary request paths.

`RendererGateway` hides private transport and maps transport failures to fixed
application error codes. The application service does not depend on HTTP
client details.

The renderer is an adapter at the rendering seam. It knows the immutable bundle
contract but not the database schema, API authentication model for creators,
or project persistence implementation.

## 6. Configuration and graceful degradation

E1 reuses `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`; it does not introduce a second
output-root setting.

New server-owned configuration is limited to:

- optional renderer internal base URL;
- renderer/control-plane shared internal credential as `SecretStr`;
- maximum render duration;
- renderer and preset version identifiers; and
- bounded dashboard polling intervals and history limit where those values are
  not already constants.

When the renderer URL or credential is absent, the control plane still starts
and all existing functionality remains available. Render capability reports
`available = false` with a safe reason, and the dashboard disables Render.

When renderer configuration is enabled, both URL and credential are required.
Invalid partial configuration fails settings validation without retaining or
printing the credential.

The renderer service has no published host port in Compose. It is reachable
only from the private application network and receives the internal credential
through its own environment.

## 7. RenderJob domain model

The persisted model contains at least:

```text
RenderJob
|-- render_job_id
|-- project_id
|-- document_id
|-- document_revision
|-- template_id
|-- template_version
|-- preset_id
|-- renderer_version
|-- status
|-- progress_percent?          # present only when trustworthy
|-- last_event_sequence
|-- retry_of_job_id?
|-- created_by
|-- created_at
|-- started_at?
|-- finished_at?
|-- cancel_requested_at?
|-- failure_code?
|-- output_relative_path?
|-- output_media_type?
|-- output_size_bytes?
|-- output_checksum?
|-- provenance                 # bounded typed JSON
`-- artifacts_cleaned_at?
```

IDs use existing opaque-identifier conventions. Timestamps are timezone-aware.
The provenance object contains bounded identifiers, versions, checksums, codec
facts, and timing; it never contains a secret, absolute path, raw exception,
provider payload, or unbounded process log.

E1 keeps the single output projection on the job row. A general artifact table
is not added for a feature that produces exactly one downloadable MP4.

## 8. State machine

```text
preparing -> rendering -> finalizing -> completed
    |            |            |
    +------------+------------+----> failed
    +------------------------------> cancelled
```

Active states are `preparing`, `rendering`, and `finalizing`. Terminal states
are `completed`, `failed`, and `cancelled`.

Rules:

- Transitions are allowlisted and terminal states are immutable.
- Progress is optional, bounded to `0..100`, and monotonic.
- Each internal event has a positive monotonically increasing sequence. A
  duplicate or older event is an idempotent no-op.
- `completed` requires a regular final file plus validated media facts,
  checksum, size, and provenance.
- `failed` and `cancelled` never expose a partial output as downloadable.
- Cancel is idempotent. `cancel_requested_at` prevents repeated transport calls
  while status remains active until the renderer confirms termination or the
  hard deadline closes the job.
- Timeout and dispatch failure use fixed safe codes.
- A late event for a terminal job is ignored and cannot resurrect it.
- Retry is allowed only from `failed` or `cancelled`, creates a new job with a
  new idempotency key, and preserves the original job unchanged.

## 9. Concurrency and idempotency

One installation may have only one active render job across all projects.

The database enforces this invariant with a transaction-safe singleton slot or
equivalent partial uniqueness constraint over active jobs. The repository also
serializes create and terminal transitions so concurrent requests cannot both
win.

If an active job exists, create returns `409 render_busy` and does not persist
a waiting job. The response may include the safe active job ID when the actor
can access its project, but never leaks another project's identity.

Create requires an idempotency key. Reusing a key with the same canonical
request returns the original job. Reusing it with a different request returns
`409 idempotency_conflict`.

Double-click protection is enforced server-side; UI disabling is only a user
experience aid.

## 10. Canonical filesystem layout

All E1 files are descendants of the configured and resolved
`THOTH_CONTROL_PLANE_ARTIFACT_ROOT`:

```text
<artifact-root>/
|-- renders/<render_job_id>/
|   |-- output.mp4            # completed jobs only
|   |-- metadata.json
|   `-- diagnostics.json
|-- work/<render_job_id>/
|   |-- bundle.json
|   `-- assets/
`-- temp/<render_job_id>/
```

No E1 code constructs those paths outside the `ArtifactRoot` adapter.

Path rules:

- Job and asset identifiers are validated before path composition.
- Absolute paths, drive prefixes, traversal, alternate separators, URI forms,
  symlinks, junctions, and reparse points are rejected.
- Every resolved target is checked to remain below its expected root before
  reading, writing, moving, streaming, or deleting.
- E1 copies approved assets into the per-job workspace. It does not use
  hard-links, because a mutable source inode would weaken revision
  reproducibility.
- Copies are regular files with a size bound and checksum verified against the
  stored asset record.
- Temporary output is created below `temp/<job_id>` and moved atomically to the
  final directory only after validation.
- A job never reuses or overwrites another job's directory.
- Failed or cancelled partial output is not moved into `renders`.
- Cleanup accepts a job ID, resolves all targets itself, verifies the terminal
  state and canonical ancestry, then deletes only that job's files.
- Cleanup retains the database row, safe diagnostics, checksums, and
  `artifacts_cleaned_at`.

Legacy path migration remains outside E1. All new features after E1 must use
the same canonical root rather than inventing another parent.

## 11. Immutable render bundle

The control plane builds and persists a strict versioned bundle after loading
the exact saved revision and re-running canonical validation.

The bundle includes only:

- bundle schema version;
- render job, project, document, and revision identifiers;
- validated `EditDocument` value;
- trusted template and preset identifiers and versions;
- renderer version;
- relative staged-asset names, media facts, and checksums;
- expected canvas dimensions, frame rate, and duration; and
- a bounded callback identity derived server-side.

The bundle excludes:

- database URLs, creator API keys, internal service credentials, filesystem
  roots, absolute paths, source locators, provider payloads, raw logs, and user
  code;
- arbitrary React component names, imports, executable expressions, or
  renderer command-line flags; and
- mutable project or latest-revision references.

The renderer validates the complete bundle again before starting. Unknown
fields, unsupported versions, unknown templates, asset checksum mismatches, or
out-of-bounds document values fail closed.

## 12. Trusted renderer and output preset

E1 has one allowlisted template/composition and one server-owned preset,
`standard_vertical_mp4_v1`.

The preset produces:

- MP4 with H.264 video;
- document canvas dimensions and frame rate;
- AAC audio when the composition contains audio; and
- deterministic server-owned codec, quality, and audio settings.

The browser cannot choose a composition ID, codec, bitrate, browser flag,
output name, or local path.

The renderer implementation follows the current Remotion 4 server-rendering
sequence: build or select the pinned trusted bundle, select the allowlisted
composition with validated input props, and render media to the temporary
output location. Progress and cancellation use the supported renderer
interfaces behind a local adapter so application contracts do not expose
Remotion-specific callback shapes.

The container pins Bun/Node compatibility, Remotion packages, Chromium,
FFmpeg, fonts, and the trusted composition source. The persisted renderer
version identifies that pinned build and is included in output provenance.

## 13. Public API

Public routes are project-scoped and require the existing creator
authentication:

```text
GET    /projects/{project_id}/render-capability
POST   /projects/{project_id}/render-jobs
GET    /projects/{project_id}/render-jobs
GET    /projects/{project_id}/render-jobs/{render_job_id}
POST   /projects/{project_id}/render-jobs/{render_job_id}/cancel
POST   /projects/{project_id}/render-jobs/{render_job_id}/retry
GET    /projects/{project_id}/render-jobs/{render_job_id}/output
DELETE /projects/{project_id}/render-jobs/{render_job_id}/artifacts
```

Create accepts only:

- document ID;
- positive saved revision; and
- the required `Idempotency-Key` header.

Template, preset, renderer version, artifact root, asset paths, and output name
are server-owned.

List is bounded, newest-first, and cursor-paginated. E1 dashboard fetches only
the first bounded page.

Output streams the authenticated file with fixed MP4 media type, safe
`Content-Disposition`, size, and checksum headers. It never redirects to a
filesystem or internal renderer URL.

Cleanup is idempotent for an already-cleaned terminal job. It refuses active
jobs and jobs outside the caller's project.

Every public error is a fixed code and safe message. Raw exception text,
process output, command arguments, and local paths never enter an error body.

## 14. Private renderer protocol

Private routes are excluded from the public OpenAPI document and generated
browser client. The renderer hosts only dispatch control:

```text
POST /internal/render-jobs/{render_job_id}/start
POST /internal/render-jobs/{render_job_id}/cancel
```

The control plane hosts bundle retrieval and event ingestion:

```text
GET  /internal/render-jobs/{render_job_id}/bundle
POST /internal/render-jobs/{render_job_id}/events
```

The shared internal credential is required for every route and compared using
a constant-time primitive where applicable. The renderer service is not
host-published.

Start and Cancel are idempotent. Start carries only the job ID and a bounded
dispatch identity. The renderer fetches the bundle from the control plane; it
does not accept a browser-supplied document or path.

Events contain only:

- job ID;
- sequence;
- allowlisted status or trustworthy progress;
- output facts and checksums for finalization; or
- a fixed renderer failure code.

The control plane authenticates, validates, and persists every event before it
affects public state.

## 15. Dispatch, restart, timeout, and cancellation

Creation flow:

1. Authenticate the actor and verify project ownership.
2. Load the exact saved revision and reject a dirty/latest alias.
3. Re-run document validation and resolve the allowlisted template/preset.
4. Acquire the one-active-job lock and idempotency reservation.
5. Persist `preparing`.
6. Create the canonical workspace, copy assets, verify checksums, and write the
   bundle atomically.
7. Dispatch the job ID through `RendererGateway`.
8. Return the persisted job; the dashboard polls authoritative status.

A staging or dispatch failure closes the job as `failed` with a safe code and
does not retry automatically.

The renderer owns one active execution and refuses another start. It aborts the
supported render operation on Cancel or deadline, waits for owned child
processes, removes partial output, and reports the terminal result.

The control plane owns a maximum deadline and a bounded reconciliation task.
On control-plane startup, any previously active job is cancelled through the
renderer when reachable and closed safely; it is never restarted. If the
renderer exits or stops reporting, the deadline closes the job as failed. Late
events cannot reopen it.

Cleanup of an uncertain active writer is deferred until the renderer confirms
termination or the hard deadline and process-ownership checks make deletion
safe.

## 16. Dashboard interaction design

Render state lives in a dedicated reducer/module rather than expanding the
editor document reducer with network lifecycle state.

The module owns:

- capability and bounded history loading;
- one create mutation guarded by an idempotency key;
- bounded polling with one request in flight, offline pause, stage/document
  generation guards, and unmount cleanup;
- Cancel, Retry, Download, and Cleanup actions;
- safe code-to-copy mapping; and
- authoritative refresh after every mutation.

The editor supplies only current project, document, revision, save/conflict/
offline state, and validation summary. Render state cannot mutate the draft.

The confirmation dialog displays immutable facts. Progress is shown only when
present; otherwise the UI shows the current stage without inventing a
percentage. Download uses the authenticated control-plane route. No local path
or internal endpoint reaches the DOM, browser log, or persisted editor state.

## 17. Security and privacy

- Only trusted repository compositions execute. User content remains bounded
  typed data rendered as text or validated media.
- The renderer has the minimum private-network access required for the internal
  control-plane protocol and no control-plane database credential.
- The API has no Docker socket and does not spawn renderer processes.
- Internal and creator credentials are distinct and secret-valued.
- The workspace contains only the exact staged assets named in the immutable
  bundle.
- Asset checksums are verified before render and recorded in provenance.
- Diagnostic records use enums, bounded numbers, versions, and checksums; they
  never store raw process streams or arbitrary exceptions.
- Output download is project-authorized and streams a server-resolved regular
  file below the expected job root.
- Cleanup is recoverable only from backups; the UI describes it as destructive
  and requires explicit confirmation.

## 18. Verification strategy

### 18.1 Domain and persistence

- Every allowed and forbidden state transition.
- Terminal immutability, monotonic event sequence, and progress bounds.
- Create replay versus idempotency conflict.
- Exactly one active job under concurrent requests.
- Retry lineage and immutable source job.
- Atomic create/finalize behavior and transaction rollback.

### 18.2 Path and artifact security

- Absolute, traversal, alternate-separator, URI, symlink, junction, reparse
  point, cross-job, and cross-root attempts.
- Source mutation or checksum mismatch during staging.
- Atomic temporary-to-final publication.
- Active-job cleanup refusal and idempotent terminal cleanup.
- Output and every generated E1 file proven below the configured artifact root.

### 18.3 API and private protocol

- Project authorization, idempotency header, busy response, cursor bounds, and
  safe errors.
- Private credential, start/cancel idempotency, event ordering, late callbacks,
  and absence from public OpenAPI/browser client.
- No path, locator, credential, raw exception, or process output in public
  responses.

### 18.4 Renderer

- Strict bundle validation and allowlisted template/preset selection.
- Synthetic local assets only.
- Progress ordering, cancel, timeout, owned-child teardown, partial cleanup,
  final checksum, and safe failure mapping.
- One container integration renders a short fixture and verifies with
  `ffprobe`: MP4/H.264, dimensions, frame rate, duration, expected audio
  presence, size, and checksum.

### 18.5 Dashboard

- Every render-button gating reason and accessible disabled state.
- Confirmation facts, create double-click protection, polling bounds, offline
  pause, reload recovery, stale-response rejection, and unmount cleanup.
- Cancel, Retry creating a new ID, Download, Cleanup confirmation, and bounded
  newest-first history.
- No path, renderer endpoint, or unsafe diagnostic rendered to the DOM.

### 18.6 Repository gates

- Frozen Python dependency sync, non-live tests, deployment tests, Ruff check,
  and Ruff format check.
- Public OpenAPI and generated TypeScript regeneration twice with stable output;
  private routes absent from both.
- Complete dashboard tests on three consecutive runs, lint, and production
  build.
- Renderer frozen install, typecheck, tests, image build, cancellation smoke,
  codec verification, and non-live Compose smoke.
- Mandatory CUDA build and relevant Rust regression tests even though the
  production renderer remains unchanged.
- Scout frozen install, acquisition/runtime tests, Compose config, contract
  drift inspection, `git diff --check`, and refreshed ignored code indexes.

No real asset, provider, TikTok, CDN, browser automation, live Scout, production
render, deployment, or Stage 1 evidence is part of E1 verification.

## 19. Acceptance criteria

| ID | Requirement | Required proof |
| --- | --- | --- |
| AC1 | A saved valid revision creates exactly one durable job | Domain, repository, and API tests |
| AC2 | Dirty, saving, conflicted, offline, invalid, or unavailable states cannot render | Service and dashboard gating tests |
| AC3 | A second active request is rejected as `render_busy` and is not queued | Concurrent repository/API test |
| AC4 | Retry creates a new linked job and leaves the source immutable | Domain and API tests |
| AC5 | Renderer has no database credential and browser has no renderer access | Compose and contract inspection |
| AC6 | Every E1 file remains under `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` | Path-security and container tests |
| AC7 | The exact saved revision, template, preset, renderer, and asset checksums appear in provenance | Bundle and output tests |
| AC8 | One trusted fixture renders to validated MP4/H.264 with expected media facts | Offline container integration test |
| AC9 | Cancel and timeout stop owned rendering, remove partial output, and preserve safe diagnostics | Renderer and integration tests |
| AC10 | Completed output downloads only through authenticated API and reveals no path | API and dashboard tests |
| AC11 | Cleanup removes only terminal job files and keeps the audit record | Repository, path, and API tests |
| AC12 | Progress/events are monotonic and stale callbacks cannot reopen terminal jobs | Domain and protocol tests |
| AC13 | Renderer absence degrades gracefully without breaking existing Studio behavior | Config, readiness, and dashboard tests |
| AC14 | Existing Rust/FFmpeg, Stage 1, Scout, and editor behavior remain operational | Full offline regression and scope-drift gates |
| AC15 | No broker, backlog, S3, user code, arbitrary renderer settings, or legacy path migration enters E1 | Diff and dependency inspection |

## 20. Delivery boundaries

This written specification is a design artifact only.

Separate operator approvals are required for:

1. the implementation plan;
2. offline implementation and local commits;
3. push, CI, and image publication;
4. deployment or renderer service startup;
5. any render using a real project revision or asset;
6. artifact cleanup outside synthetic tests; and
7. later queue, S3, multi-template, parity, rollout, or legacy-output migration
   work.

Approval of this specification does not authorize product-code changes, image
build/publish, deployment, service mutation, database migration against a
running database, real secret or asset access, live requests, Stage 1 evidence
mutation, Issue #5 mutation, parity, controlled fallback, or acceptance/soak
activation.
