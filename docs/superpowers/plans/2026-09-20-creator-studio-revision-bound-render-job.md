# Creator Studio E1 Revision-Bound Render Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one durable, revision-bound Creator Studio render job at a time,
executed by a private Bun/Remotion renderer and controlled entirely through the
authenticated UI.

**Architecture:** The Python control plane owns the job state machine,
PostgreSQL records, canonical artifact paths, asset staging, final publication,
and public/private APIs. A single-slot Bun service receives only a job identity,
fetches a strict immutable bundle, renders the one allowlisted composition, and
reports monotonic events; it has neither database credentials nor a public host
port. The dashboard consumes only the public API and keeps render networking in
a reducer separate from the edit-document reducer.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, psycopg 3, PostgreSQL,
httpx, Bun 1.3.14, TypeScript 6, React 19, Remotion 4.0.523, Docker Compose,
FFmpeg/ffprobe.

**Spec:**
`docs/superpowers/specs/2026-09-20-creator-studio-revision-bound-render-job-design.md`

**Baseline:** `20e7aa14bad82cccfc6ef6b751b5c48e2c7c6461`

## Global Constraints

- Implement exactly one active render slot for the entire installation. A
  second creation returns `409 render_busy`; it is never persisted as waiting.
- Do not add Redis, RabbitMQ, Kafka, a Temporal render workflow, a broker,
  automatic retry, or a pending-job queue.
- Keep PostgreSQL ownership in the Python control plane. The renderer receives
  no database URL or creator API key.
- Reuse `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` as the only parent for every new E1
  file. Do not add `THOTH_OUTPUT_ROOT` or migrate legacy output paths.
- Keep the existing Rust/FFmpeg renderer byte-identical except for tests or
  documentation that prove it remains operational.
- Render only saved immutable `EditDocument` revisions with one composition and
  `standard_vertical_mp4_v1`; the browser cannot choose codec, bitrate, path,
  component, browser flag, or output name.
- Pin Remotion packages to `4.0.523`. Before implementing Remotion calls, use
  Context7: resolve `/remotion-dev/remotion`, then query `bundle`,
  `selectComposition`, `renderMedia`, progress, and cancellation separately.
- Use native `Bun.serve` and existing `httpx`; do not add Express, a Python web
  client, a job framework, or a second document schema.
- New repository artifacts are English. Operator reports are Indonesian.
- Every task is test-first and ends with one concise one-line commit without a
  body, trailer, `Co-Authored-By`, or AI attribution.
- Preserve operator-owned and unrelated files. Stop on overlapping product-code
  drift before editing it.
- No deployment, service startup outside synthetic offline tests, real assets,
  live requests, Stage 1 evidence mutation, Issue #5 mutation, parity,
  controlled fallback, acceptance, or soak work.

## Review Focus

1. A create replay arriving while another project owns the active slot must
   replay its own identical job, while a new key gets `render_busy` without
   leaking the other project ID (Task 3 repository concurrency tests).
2. A document may reference duplicate assets or an asset may change during
   copying; staging must deduplicate by asset ID and reject source mutation or
   checksum mismatch without publishing output (Task 5 staging tests).
3. Cancel can race with completion, timeout, or a duplicate terminal event;
   exactly one terminal state wins and no late callback can restore output
   (Tasks 1, 7, and 10 tests).
4. Artifact cleanup can encounter symlinks, reparse points, missing directories,
   or an uncertain active writer; it must fail closed or be idempotent without
   crossing the job root (Task 4 tests and Task 14 container smoke).
5. Polling can overlap a stage/document change, offline transition, or unmount;
   stale responses must be ignored and at most one request may be in flight
   (Tasks 11 and 12 tests).

---

## File and Interface Map

The implementation uses the following responsibility boundaries. Do not merge
the dashboard render reducer into `editor_state.ts`, expose private routes in
the public OpenAPI, or duplicate the trusted composition inside the renderer.

- `python/src/thoth_control_plane/domain/render_jobs.py`: strict public and
  internal models plus the pure state transition function.
- `python/src/thoth_control_plane/application/render_job_ports.py`: repository,
  artifact, renderer, and clock protocols plus safe persistence/transport
  exceptions.
- `python/src/thoth_control_plane/application/render_jobs.py`: orchestration for
  capability, create, history, cancel, retry, event ingestion, download, cleanup,
  and deadline reconciliation.
- `python/src/thoth_control_plane/infrastructure/render_job_repository.py`:
  PostgreSQL transactions, idempotency, singleton active slot, and keyset
  pagination.
- `python/src/thoth_control_plane/infrastructure/artifact_root.py`: the only
  Python E1 path constructor, stager, publisher, downloader resolver, and remover.
- `python/src/thoth_control_plane/infrastructure/renderer_gateway.py`: bounded
  private HTTP start/cancel adapter.
- `python/src/thoth_control_plane/api/routes/render_jobs.py`: authenticated
  project-scoped browser API.
- `python/src/thoth_control_plane/api/routes/internal_render_jobs.py`: internal
  credential-protected bundle/event API, excluded from public OpenAPI.
- `packages/remotion-composition/`: the one composition implementation shared by
  dashboard preview and renderer, importing the generated `EditDocumentV2` type
  rather than redefining it.
- `renderer/`: one-slot Bun service, strict bundle parser, artifact adapter,
  Remotion adapter, callback client, and tests.
- `dashboard/src/features/studio/render_job_state.ts`: pure render UI reducer and
  selectors.
- `dashboard/src/features/studio/RenderPanel.tsx`: capability/history/polling and
  render actions.
- `docker/test-renderer-offline.sh`: synthetic MP4, cancel, timeout, path, and
  private-network smoke.

### Task 1: Define the RenderJob domain and transition contract

**Files:**
- Create: `python/src/thoth_control_plane/domain/render_jobs.py`
- Create: `python/tests/domain/test_render_jobs.py`

**Interfaces:**
- Consumes: `StrictModel`, `OpaqueId`, `ProjectId`, and the existing timezone-aware
  Pydantic conventions.
- Produces:
  - `RenderStatus = Literal["preparing", "rendering", "finalizing", "completed", "failed", "cancelled"]`
  - `RenderOutputFacts(media_type, size_bytes, checksum, codec, width, height, fps, duration_seconds, has_audio)`
  - `RenderProvenance(document_revision, template_id, template_version, preset_id, renderer_version, asset_checksums, output)`
  - `RenderJob`, `RenderJobEvent`, `RenderJobPage`, `RenderCapability`
  - `apply_render_event(job: RenderJob, event: RenderJobEvent, now: datetime) -> RenderJob`
  - `mark_cancel_requested(job: RenderJob, now: datetime) -> RenderJob`
  - typed `InvalidRenderTransition`, `InvalidRenderEvent`

- [ ] **Step 1: Write failing pure-domain tests**

  Cover every allowed edge, every forbidden edge, terminal immutability,
  positive monotonic sequence, duplicate/older event no-op, optional monotonic
  progress in `0..100`, completed-output requirements, fixed bounded failure
  codes, retry lineage fields, and the cancel/completion race.

  ```python
  def test_late_completion_cannot_resurrect_cancelled_job() -> None:
      cancelled = fixture_job(status="cancelled", last_event_sequence=8)
      late = fixture_event(sequence=9, status="completed", output=fixture_output())
      assert apply_render_event(cancelled, late, NOW) == cancelled
  ```

- [ ] **Step 2: Run the domain test and prove RED**

  Run:
  `uv run --project python pytest python/tests/domain/test_render_jobs.py -q`

  Expected: collection fails because `thoth_control_plane.domain.render_jobs`
  does not exist.

- [ ] **Step 3: Implement the smallest closed state machine**

  Use frozen/strict Pydantic models and a single explicit transition map:

  ```python
  ALLOWED_TRANSITIONS: dict[RenderStatus, frozenset[RenderStatus]] = {
      "preparing": frozenset({"rendering", "failed", "cancelled"}),
      "rendering": frozenset({"finalizing", "failed", "cancelled"}),
      "finalizing": frozenset({"completed", "failed", "cancelled"}),
      "completed": frozenset(),
      "failed": frozenset(),
      "cancelled": frozenset(),
  }
  ```

  Keep provenance bounded and typed; do not use `dict[str, object]` for data that
  crosses a trust boundary.

- [ ] **Step 4: Run focused domain tests GREEN**

  Run the Step 2 command. Expected: all tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git add python/src/thoth_control_plane/domain/render_jobs.py python/tests/domain/test_render_jobs.py
  git commit -m "feat: define revision-bound render jobs"
  ```

### Task 2: Add the append-only render-job schema

**Files:**
- Create: `python/migrations/editor/0005_revision_bound_render_jobs.sql`
- Modify: `python/tests/operations/test_editor_migrations.py`

**Interfaces:**
- Consumes: Task 1 field names and the existing
  `edit_document_revisions(document_id, revision)` key.
- Produces: `render_jobs` and `render_job_idempotency` tables, a partial unique
  active-slot index, project/history index, and immutable source-revision FK.

- [ ] **Step 1: Write RED migration contract tests**

  Extend the explicit migration list and assert:

  ```python
  assert "CREATE UNIQUE INDEX render_jobs_one_active_slot" in sql
  assert "WHERE status IN ('preparing', 'rendering', 'finalizing')" in sql
  assert "PRIMARY KEY (project_id, idempotency_key)" in sql
  assert "REFERENCES edit_document_revisions (document_id, revision)" in sql
  assert "retry_of_job_id TEXT REFERENCES render_jobs (render_job_id)" in sql
  ```

  Also assert status/failure/path/provenance bounds, positive event sequence,
  progress range, terminal timestamps, and no secret/base URL/absolute-path
  columns.

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/operations/test_editor_migrations.py -q`

  Expected: the migration list and render schema assertions fail.

- [ ] **Step 3: Add forward-only SQL**

  Create only new tables and indexes. Store the single output projection on the
  job row; do not create a generic artifact table. Use JSONB only for bounded
  typed provenance serialized by Task 1.

- [ ] **Step 4: Run migration tests GREEN and byte-identity checks**

  Run the Step 2 command and verify migrations `0001` through `0004` have no
  diff from baseline:

  `git diff 20e7aa1 -- python/migrations/editor/0001_edit_document_revisions.sql python/migrations/editor/0002_prompt_lab_foundation.sql python/migrations/editor/0003_prompt_lab_ai_proposals.sql python/migrations/editor/0004_advanced_timeline_foundation.sql`

- [ ] **Step 5: Commit**

  ```bash
  git add python/migrations/editor/0005_revision_bound_render_jobs.sql python/tests/operations/test_editor_migrations.py
  git commit -m "feat: add render job schema"
  ```

### Task 3: Persist jobs with singleton concurrency and idempotency

**Files:**
- Create: `python/src/thoth_control_plane/application/render_job_ports.py`
- Create: `python/src/thoth_control_plane/infrastructure/render_job_repository.py`
- Create: `python/tests/infrastructure/test_render_job_repository.py`

**Interfaces:**
- Consumes: `RenderJob`, `RenderJobEvent`, and `RenderJobPage` from Task 1.
- Produces `RenderJobRepository` with:

  ```python
  class RenderJobRepository(Protocol):
      async def reserve(self, job: RenderJob, *, idempotency_key: str, payload_hash: str) -> RenderJob: ...
      async def get(self, *, project_id: str, render_job_id: str) -> RenderJob | None: ...
      async def get_internal(self, *, render_job_id: str) -> RenderJob | None: ...
      async def list(self, *, project_id: str, limit: int, cursor: str | None) -> RenderJobPage: ...
      async def apply_event(self, *, render_job_id: str, event: RenderJobEvent, now: datetime) -> RenderJob: ...
      async def mark_cancel_requested(self, *, project_id: str, render_job_id: str, now: datetime) -> tuple[RenderJob, bool]: ...
      async def mark_cleaned(self, *, project_id: str, render_job_id: str, now: datetime) -> RenderJob: ...
      async def list_expired_active(self, *, deadline: datetime, limit: int) -> tuple[RenderJob, ...]: ...
  ```

  Safe exceptions: `RenderBusy`, `RenderIdempotencyConflict`,
  `RenderPersistenceError`.

- [ ] **Step 1: Write RED repository tests with the existing fake async DB style**

  Exercise parameterized SQL, payload replay/conflict, advisory serialization,
  database partial uniqueness mapping, active-slot behavior across projects,
  hidden foreign-project identity, keyset cursor bounds, `FOR UPDATE` on event
  transitions, rollback, and terminal-event races.

  The key ordering assertion is:

  ```python
  replay = await repository.reserve(same_job, idempotency_key="rk_1", payload_hash=HASH)
  assert replay.render_job_id == original.render_job_id
  with pytest.raises(RenderBusy):
      await repository.reserve(other_job, idempotency_key="rk_2", payload_hash=OTHER_HASH)
  ```

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/infrastructure/test_render_job_repository.py -q`

  Expected: collection fails because the port and adapter do not exist.

- [ ] **Step 3: Implement one transaction per mutation**

  Acquire `pg_advisory_xact_lock(hashtext('render-jobs'), 1)` before checking
  idempotency and the active slot. Check the idempotency record first so an
  identical replay wins even while another active row exists. Use the Task 1
  pure transition function after locking the job row.

- [ ] **Step 4: Run repository and migration suites GREEN**

  Run:
  `uv run --project python pytest python/tests/infrastructure/test_render_job_repository.py python/tests/operations/test_editor_migrations.py -q`

- [ ] **Step 5: Commit**

  ```bash
  git add python/src/thoth_control_plane/application/render_job_ports.py python/src/thoth_control_plane/infrastructure/render_job_repository.py python/tests/infrastructure/test_render_job_repository.py
  git commit -m "feat: persist revision-bound render jobs"
  ```

### Task 4: Centralize every E1 path in ArtifactRoot

**Files:**
- Create: `python/src/thoth_control_plane/infrastructure/artifact_root.py`
- Create: `python/tests/infrastructure/test_artifact_root.py`

**Interfaces:**
- Produces `LocalArtifactRoot(root: Path)` methods:

  ```python
  def prepare(self, render_job_id: str) -> JobWorkspace: ...
  def stage_asset(self, workspace: JobWorkspace, *, asset_id: str, source: Path, expected_checksum: str, max_bytes: int) -> StagedAsset: ...
  def write_bundle(self, workspace: JobWorkspace, bundle_json: bytes) -> str: ...
  def verify_temporary_output(self, render_job_id: str, expected: RenderOutputFacts) -> Path: ...
  def publish(self, render_job_id: str, output: RenderOutputFacts, metadata_json: bytes, diagnostics_json: bytes) -> PublishedArtifact: ...
  def resolve_download(self, render_job_id: str, relative_path: str) -> Path: ...
  def cleanup(self, render_job_id: str) -> None: ...
  ```

  `JobWorkspace` exposes only relative names to callers. No caller joins an E1
  path itself.

- [ ] **Step 1: Write RED path and filesystem tests**

  Parameterize opaque-ID attacks (`../`, absolute POSIX/Windows paths, drive
  prefixes, backslashes, URI forms, alternate separators), symlinks, junction/
  reparse-point detection on Windows, cross-job paths, non-regular sources,
  oversized files, source mutation, checksum mismatch, atomic publication,
  missing cleanup, and cleanup containment.

  ```python
  @pytest.mark.parametrize("unsafe", ["../job", "/tmp/job", r"C:\\job", "file:x"])
  def test_job_identity_never_escapes_root(tmp_path: Path, unsafe: str) -> None:
      with pytest.raises(ArtifactPathInvalid):
          LocalArtifactRoot(tmp_path).prepare(unsafe)
  ```

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/infrastructure/test_artifact_root.py -q`

- [ ] **Step 3: Implement with stdlib Path, shutil, hashlib, and os.replace**

  Resolve and verify ancestry immediately before every read/write/move/delete.
  Copy bytes; never hard-link. Refuse symlink/reparse traversal. Publish only a
  verified regular `temp/<job>/output.mp4` with `os.replace`; retain bounded
  metadata/diagnostics after file cleanup as required by the spec.

- [ ] **Step 4: Run GREEN on Windows and WSL/Linux where available**

  Run the Step 2 command natively, then:

  `wsl.exe bash -lc 'cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER && uv run --project python pytest python/tests/infrastructure/test_artifact_root.py -q'`

- [ ] **Step 5: Commit**

  ```bash
  git add python/src/thoth_control_plane/infrastructure/artifact_root.py python/tests/infrastructure/test_artifact_root.py
  git commit -m "feat: centralize render artifact paths"
  ```

### Task 5: Build immutable bundles and stage exact revision assets

**Files:**
- Modify: `python/src/thoth_control_plane/application/ports.py`
- Modify: `python/src/thoth_control_plane/infrastructure/editor_repository.py`
- Modify: `python/src/thoth_control_plane/application/editor_asset_ports.py`
- Modify: `python/src/thoth_control_plane/infrastructure/editor_asset_repository.py`
- Create: `python/src/thoth_control_plane/application/render_bundles.py`
- Create: `python/tests/application/test_render_bundles.py`
- Modify: `python/tests/infrastructure/test_editor_repository.py`
- Modify: `python/tests/infrastructure/test_editor_asset_repository.py`

**Interfaces:**
- Adds exact reads:

  ```python
  EditDocumentRepository.get_revision(*, project_id: str, document_id: str, revision: int) -> EditDocument | None
  EditorAssetRepository.get_ready_records(*, project_id: str, asset_ids: tuple[str, ...]) -> tuple[EditorAssetRecord, ...]
  ```

- Produces strict `RenderBundleV1` and:

  ```python
  async def build_render_bundle(request: BuildRenderBundleRequest, *, documents: EditDocumentRepository, assets: EditorAssetRepository, artifacts: ArtifactRoot, settings: RenderPresetSettings) -> RenderBundleV1: ...
  ```

- [ ] **Step 1: Write RED exact-revision and bundle tests**

  Prove the builder uses the requested saved revision rather than latest,
  reruns canonical document validation, rejects v1/invalid/unsupported template,
  deduplicates asset IDs, requires every referenced asset ready, stages copies,
  records checksums, and emits no absolute path, locator, secret, latest alias,
  arbitrary component, or renderer flag.

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/application/test_render_bundles.py python/tests/infrastructure/test_editor_repository.py python/tests/infrastructure/test_editor_asset_repository.py -q`

- [ ] **Step 3: Implement exact reads and one strict bundle schema**

  Reuse `validate_edit_document` and the trusted template constants already used
  by D1. Serialize with `model_dump_json()` using sorted stable content for the
  request hash. The bundle contains relative staged names only.

- [ ] **Step 4: Run focused suites GREEN**

  Run the Step 2 command.

- [ ] **Step 5: Commit**

  ```bash
  git add python/src/thoth_control_plane/application/ports.py python/src/thoth_control_plane/infrastructure/editor_repository.py python/src/thoth_control_plane/application/editor_asset_ports.py python/src/thoth_control_plane/infrastructure/editor_asset_repository.py python/src/thoth_control_plane/application/render_bundles.py python/tests/application/test_render_bundles.py python/tests/infrastructure/test_editor_repository.py python/tests/infrastructure/test_editor_asset_repository.py
  git commit -m "feat: build immutable render bundles"
  ```

### Task 6: Add graceful renderer configuration and private gateway

**Files:**
- Modify: `python/src/thoth_control_plane/config.py`
- Create: `python/src/thoth_control_plane/infrastructure/renderer_gateway.py`
- Modify: `python/tests/test_config.py`
- Create: `python/tests/infrastructure/test_renderer_gateway.py`

**Interfaces:**
- Adds settings:
  `THOTH_RENDERER_INTERNAL_URL: AnyHttpUrl | None`,
  `THOTH_RENDERER_INTERNAL_CREDENTIAL: SecretStr | None`,
  `THOTH_RENDER_MAX_SECONDS: int = 900`,
  `THOTH_RENDERER_VERSION: str = "remotion-4.0.523"`, and
  `THOTH_RENDER_PRESET_ID: Literal["standard_vertical_mp4_v1"]`.
- Produces `HttpRendererGateway.start(render_job_id, dispatch_id)` and
  `.cancel(render_job_id)`, plus `UnavailableRendererGateway`.

- [ ] **Step 1: Write RED config and gateway tests**

  Prove both URL and credential are required together, missing configuration
  degrades without preventing startup, secret values never appear in repr/error,
  requests carry only job/dispatch identity, redirects are off, timeout is
  bounded, start/cancel map network and non-2xx outcomes to fixed safe codes,
  and neither call retries.

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/test_config.py python/tests/infrastructure/test_renderer_gateway.py -q`

- [ ] **Step 3: Implement with one existing httpx request per action**

  Use `follow_redirects=False`, a fixed `httpx.Timeout`, bearer internal auth,
  and no exception-string propagation.

- [ ] **Step 4: Run focused suites GREEN**

  Run the Step 2 command.

- [ ] **Step 5: Commit**

  ```bash
  git add python/src/thoth_control_plane/config.py python/src/thoth_control_plane/infrastructure/renderer_gateway.py python/tests/test_config.py python/tests/infrastructure/test_renderer_gateway.py
  git commit -m "feat: connect the private render service"
  ```

### Task 7: Orchestrate job lifecycle, deadline, retry, and cleanup

**Files:**
- Create: `python/src/thoth_control_plane/application/render_jobs.py`
- Create: `python/tests/application/test_render_jobs.py`

**Interfaces:**
- Consumes Tasks 1, 3, 4, 5, and 6.
- Produces `RenderJobService` methods:

  ```python
  async def capability(self, project_id: str) -> RenderCapability: ...
  async def create(self, project_id: str, actor_id: str, request: CreateRenderJobRequest, idempotency_key: str) -> RenderJob: ...
  async def get(self, project_id: str, render_job_id: str) -> RenderJob: ...
  async def list(self, project_id: str, request: ListRenderJobsRequest) -> RenderJobPage: ...
  async def cancel(self, project_id: str, render_job_id: str) -> RenderJob: ...
  async def retry(self, project_id: str, actor_id: str, render_job_id: str, idempotency_key: str) -> RenderJob: ...
  async def ingest_event(self, render_job_id: str, event: RenderJobEvent) -> RenderJob: ...
  async def output_path(self, project_id: str, render_job_id: str) -> DownloadableRender: ...
  async def cleanup(self, project_id: str, render_job_id: str) -> RenderJob: ...
  async def reconcile_expired(self, now: datetime) -> int: ...
  ```

- [ ] **Step 1: Write RED application tests**

  Cover unavailable capability, exact saved revision, create replay/conflict,
  `render_busy`, staging/dispatch failure closure without retry, project scope,
  bounded history, idempotent cancel, cancel/completion race, retry only from
  failed/cancelled with immutable source, event finalization, output gating,
  terminal-only cleanup, active-writer refusal, and deadline failure with a
  best-effort single cancel.

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/application/test_render_jobs.py -q`

- [ ] **Step 3: Implement orchestration without a background queue**

  Creation performs the spec's eight steps synchronously through dispatch and
  then returns. Reconciliation is a bounded periodic scan of already-active
  rows, never a waiting-job consumer. Use fixed codes such as
  `render_dispatch_failed`, `render_deadline_exceeded`, and
  `render_output_invalid`.

- [ ] **Step 4: Run application/domain/infrastructure suites GREEN**

  Run:
  `uv run --project python pytest python/tests/domain/test_render_jobs.py python/tests/application/test_render_jobs.py python/tests/infrastructure/test_render_job_repository.py python/tests/infrastructure/test_artifact_root.py -q`

- [ ] **Step 5: Commit**

  ```bash
  git add python/src/thoth_control_plane/application/render_jobs.py python/tests/application/test_render_jobs.py
  git commit -m "feat: orchestrate render job lifecycle"
  ```

### Task 8: Expose public and private APIs without leaking the private contract

**Files:**
- Create: `python/src/thoth_control_plane/api/routes/render_jobs.py`
- Create: `python/src/thoth_control_plane/api/routes/internal_render_jobs.py`
- Modify: `python/src/thoth_control_plane/api/app.py`
- Modify: `python/src/thoth_control_plane/api/dependencies.py`
- Create: `python/tests/api/test_render_jobs.py`
- Create: `python/tests/api/test_internal_render_jobs.py`
- Modify: `python/tests/api/test_openapi_contract.py`
- Modify: `python/openapi.json`

**Interfaces:**
- Public routes are exactly the eight `/projects/{project_id}/...` routes from
  spec section 13.
- Private routes are exactly bundle GET and event POST under
  `/internal/render-jobs/...`, each `include_in_schema=False`.
- Public create accepts only `document_id`, positive `document_revision`, and
  `Idempotency-Key`.

- [ ] **Step 1: Write RED API tests**

  Test auth/project scoping, missing/invalid idempotency key, replay/conflict,
  busy response without foreign identity, cursor/limit bounds, safe status
  mapping, authenticated MP4 streaming headers, cleanup, internal constant-time
  bearer auth, strict bundle/event bodies, and fixed safe errors. Assert public
  OpenAPI contains no `/internal/`, internal credential, renderer URL,
  filesystem path, locator, codec knob, or process diagnostic field.

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/api/test_render_jobs.py python/tests/api/test_internal_render_jobs.py python/tests/api/test_openapi_contract.py -q`

- [ ] **Step 3: Implement routes and lifespan wiring**

  Build repository/artifact/gateway/service from settings in `create_app`, close
  owned HTTP clients in lifespan, and run one bounded reconciliation pass on
  startup plus a cancellable periodic task. Existing app startup remains healthy
  when renderer configuration is absent.

- [ ] **Step 4: Regenerate public OpenAPI twice**

  Run the repository's existing export command discovered with:
  `rg -n "export_openapi" python dashboard .github`

  Execute it twice, copy the first checksum, and require identical second
  output. Then run Step 2 again.

- [ ] **Step 5: Commit**

  ```bash
  git add python/src/thoth_control_plane/api/routes/render_jobs.py python/src/thoth_control_plane/api/routes/internal_render_jobs.py python/src/thoth_control_plane/api/app.py python/src/thoth_control_plane/api/dependencies.py python/tests/api/test_render_jobs.py python/tests/api/test_internal_render_jobs.py python/tests/api/test_openapi_contract.py python/openapi.json
  git commit -m "feat: expose revision-bound render APIs"
  ```

### Task 9: Share one trusted composition between preview and renderer

**Files:**
- Create: `packages/remotion-composition/package.json`
- Create: `packages/remotion-composition/tsconfig.json`
- Create: `packages/remotion-composition/src/AdvancedTimelineComposition.tsx`
- Create: `packages/remotion-composition/src/timeline.ts`
- Create: `packages/remotion-composition/src/media.ts`
- Create: `packages/remotion-composition/src/index.ts`
- Create: `packages/remotion-composition/src/register.tsx`
- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.tsx`
- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx`
- Modify: `dashboard/src/features/studio/timeline_domain.ts`
- Modify: `dashboard/src/features/studio/timeline_domain.test.ts`
- Modify: `dashboard/src/features/studio/preview.ts`
- Modify: `dashboard/src/features/studio/preview.test.ts`
- Modify: `dashboard/tsconfig.app.json`
- Modify: `dashboard/vite.config.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- `@thoth/remotion-composition` exports the existing
  `AdvancedTimelineComposition`, `PreviewSources`, and trusted composition ID
  `advanced_timeline_v1`.
- The package imports `EditDocumentV2` from the generated control-plane type as
  a type-only dependency; it does not handwrite a second document schema.
- The narrow `visibleLanes` and `safePreviewSource` helpers move with the
  composition; their dashboard modules re-export them so editing callers keep
  one implementation and stable imports.
- Dashboard keeps a one-line compatibility re-export so existing imports do not
  churn.

- [ ] **Step 1: Move the existing tests to RED against the shared import**

  Add assertions that browser preview and server registration reference the
  same component and ID, while unknown overlays/styles remain fail-closed.
  Before implementation the package import must fail.

- [ ] **Step 2: Run and prove RED**

  Run:
  `bun --cwd=dashboard test src/features/studio/AdvancedTimelineComposition.test.tsx`

- [ ] **Step 3: Extract without changing rendered behavior**

  Move, do not fork, the component and its two render-only helpers. Replace Tailwind-only composition styling
  with equivalent inline style objects inside the shared package so Remotion's
  server bundle and dashboard player render the same visual tree without
  depending on dashboard CSS compilation. Add Bun workspaces only for
  `dashboard`, `renderer`, and `packages/*`; do not reorganize unrelated root
  dependencies.

- [ ] **Step 4: Run preview and dashboard build GREEN**

  Run:
  `bun --cwd=dashboard test src/features/studio/AdvancedTimelineComposition.test.tsx src/features/studio/StudioPreview.test.tsx && bun --cwd=dashboard run build`

- [ ] **Step 5: Commit**

  ```bash
  git add package.json bun.lock packages/remotion-composition dashboard/src/features/studio/AdvancedTimelineComposition.tsx dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx dashboard/src/features/studio/timeline_domain.ts dashboard/src/features/studio/timeline_domain.test.ts dashboard/src/features/studio/preview.ts dashboard/src/features/studio/preview.test.ts dashboard/tsconfig.app.json dashboard/vite.config.ts
  git commit -m "refactor: share the trusted render composition"
  ```

### Task 10: Implement the isolated single-slot Remotion renderer

**Files:**
- Create: `renderer/package.json`
- Create: `renderer/tsconfig.json`
- Create: `renderer/src/config.ts`
- Create: `renderer/src/contracts.ts`
- Create: `renderer/src/artifact-root.ts`
- Create: `renderer/src/control-plane-client.ts`
- Create: `renderer/src/remotion-adapter.ts`
- Create: `renderer/src/server.ts`
- Create: `renderer/src/*.test.ts`
- Create: `Dockerfile.renderer`
- Modify: `bun.lock`

**Interfaces:**
- `POST /internal/render-jobs/:id/start` body:
  `{ "dispatch_id": "..." }`; `POST .../cancel` has no body.
- `RendererExecution.start(jobId, dispatchId)`, `.cancel(jobId)`, and `.status()`
  enforce one active slot and idempotent identities.
- Control-plane callbacks send Task 1 event JSON only.

- [ ] **Step 1: Query current Remotion docs through Context7**

  Resolve `/remotion-dev/remotion`; query separately for server bundle creation,
  `selectComposition`, `renderMedia`, `onProgress`, `cancelSignal`, codec/audio
  options, Chromium requirements, and cleanup. Record exact current signatures
  in code comments only where a non-obvious adapter decision needs them.

- [ ] **Step 2: Write RED Bun tests**

  Test strict unknown-field rejection, bundle/version/template/preset bounds,
  internal auth with constant-time comparison, one-slot `409 render_busy`,
  idempotent repeated start/cancel, checksum validation, progress sequence,
  fixed failure mapping, no raw exception/log callback, cancellation and timeout
  abort, owned-child completion, and partial-output removal.

- [ ] **Step 3: Run and prove RED**

  Run: `bun --cwd=renderer install --frozen-lockfile && bun --cwd=renderer test`

  Expected before implementation: missing modules/tests fail.

- [ ] **Step 4: Implement with Bun.serve and one execution object**

  Use no Express and no queue. The server accepts only the internal network
  credential, fetches the bundle, validates it fully, reads staged files only
  through its local `ArtifactRoot`, selects `advanced_timeline_v1`, renders
  `standard_vertical_mp4_v1` to `temp/<job>/output.mp4`, and posts sequenced
  events. The adapter pins MP4/H.264 and AAC when the composition has audio.

- [ ] **Step 5: Add the non-root renderer image**

  `Dockerfile.renderer` pins Bun, Chromium/Remotion system dependencies,
  FFmpeg/ffprobe, fonts, package lock, and the shared composition. Run as UID/GID
  `10001:10001`; create no host-published port and no database tooling.

- [ ] **Step 6: Run renderer unit/type/image checks GREEN**

  Run:

  ```bash
  bun --cwd=renderer install --frozen-lockfile
  bun --cwd=renderer test
  bun --cwd=renderer x tsc -p tsconfig.json --noEmit
  docker build -f Dockerfile.renderer -t thoth-remotion-renderer:e1-local .
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add renderer Dockerfile.renderer bun.lock
  git commit -m "feat: add the isolated Remotion renderer"
  ```

### Task 11: Generate the browser client and model render UI state

**Files:**
- Modify: `dashboard/src/api/generated/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.test.ts`
- Create: `dashboard/src/features/studio/render_job_state.ts`
- Create: `dashboard/src/features/studio/render_job_state.test.ts`

**Interfaces:**
- The client exposes capability, create, list, get, cancel, retry, download, and
  cleanup with generated request/response types.
- `RenderJobState` owns capability, bounded history, selected job, mutation,
  poll generation, offline flag, and safe display error; it contains no editor
  draft.
- Selectors: `renderGate(editorFacts, state)`, `canCancel(job)`,
  `canRetry(job)`, `canDownload(job)`, and `canCleanup(job)`.

- [ ] **Step 1: Write RED client and reducer tests**

  Cover every gate reason (dirty, saving, conflicted, offline, invalid,
  unavailable, busy), one idempotency key per create/retry attempt, safe conflict
  envelopes, newest-first history, monotonic status refresh, stale generation
  rejection, offline pause, and no private/path fields in client types.

- [ ] **Step 2: Regenerate types and prove focused RED**

  Run:

  ```bash
  bun --cwd=dashboard run generate:control-plane-types
  bun --cwd=dashboard test src/api/control-plane.test.ts src/features/studio/render_job_state.test.ts
  ```

- [ ] **Step 3: Implement thin client methods and pure reducer**

  Reuse the existing `request`/error-envelope helpers. Download may return a
  browser `Blob`; it must never return a server pathname or renderer URL.

- [ ] **Step 4: Regenerate twice and run GREEN**

  Regenerate twice with no second diff, then run Step 2 again.

- [ ] **Step 5: Commit**

  ```bash
  git add dashboard/src/api/generated/control-plane.ts dashboard/src/api/control-plane.ts dashboard/src/api/control-plane.test.ts dashboard/src/features/studio/render_job_state.ts dashboard/src/features/studio/render_job_state.test.ts
  git commit -m "feat: model Creator Studio render jobs"
  ```

### Task 12: Add the Creator Studio render panel and bounded polling

**Files:**
- Create: `dashboard/src/features/studio/RenderPanel.tsx`
- Create: `dashboard/src/features/studio/RenderPanel.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`

**Interfaces:**
- `RenderPanel` consumes only `projectId`, saved `documentId/revision`, editor
  facts, validation summary, and Task 11 client methods.
- It owns confirmation, one create mutation, one-request-at-a-time polling,
  Cancel/Retry/Download/Cleanup, and authoritative refresh.

- [ ] **Step 1: Write RED component tests**

  Cover accessible disabled reason, immutable confirmation facts, double-click
  protection, one in-flight poll, offline pause/resume, reload recovery from
  history, stage/document generation guards, timer/listener cleanup on unmount,
  progress absent versus present, safe code copy, retry new ID, Blob download,
  destructive cleanup confirmation, and absence of path/internal URL/raw
  diagnostic text in the DOM.

- [ ] **Step 2: Run and prove RED**

  Run:
  `bun --cwd=dashboard test src/features/studio/RenderPanel.test.tsx src/features/studio/GuidedStudio.test.tsx`

- [ ] **Step 3: Implement the minimal panel**

  Schedule the next timeout only after the current request settles. Use one
  generation ref for all load/mutation callbacks. Refresh capability and first
  history page after every mutation. Do not mutate or reseed editor draft state.

- [ ] **Step 4: Run focused tests three consecutive times**

  Run the Step 2 command three times and require identical pass counts.

- [ ] **Step 5: Commit**

  ```bash
  git add dashboard/src/features/studio/RenderPanel.tsx dashboard/src/features/studio/RenderPanel.test.tsx dashboard/src/features/studio/GuidedStudio.tsx dashboard/src/features/studio/GuidedStudio.test.tsx
  git commit -m "feat: add Creator Studio render controls"
  ```

### Task 13: Wire the renderer into Compose and CI contracts

**Files:**
- Modify: `compose.stage1.local.yml`
- Modify: `.env.stage1.local.example`
- Modify: `python/tests/deployment/test_local_stage1_compose_contract.py`
- Modify: `python/tests/deployment/test_container_contract.py`
- Create: `docker/test-renderer-offline.sh`
- Modify: `.github/workflows/container-image.yml`

**Interfaces:**
- Adds `THOTH_RENDERER_IMAGE`, `THOTH_RENDERER_INTERNAL_CREDENTIAL`, and optional
  control-plane renderer settings.
- Compose `remotion-renderer` shares only the artifact volume and private
  network, exposes no host port, has no DB/provider/TikTok/creator key, runs as
  UID/GID 10001, and has one-slot health/readiness behavior.

- [ ] **Step 1: Write RED static deployment contracts**

  Assert service isolation, exact env allowlist, no published port, shared
  canonical artifact mount, no Docker socket, no database URL, no broker, and
  graceful API startup when renderer variables are absent.

- [ ] **Step 2: Run and prove RED**

  Run:
  `uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py python/tests/deployment/test_container_contract.py -q`

- [ ] **Step 3: Add Compose and workflow wiring**

  Publish/build the renderer as a separate immutable image. Keep the existing
  API/worker image path unchanged. The CI smoke uses generated throwaway
  internal credentials and synthetic files only.

- [ ] **Step 4: Implement the synthetic offline smoke**

  `docker/test-renderer-offline.sh` must:

  1. create a `mktemp -d` artifact root with safe permissions;
  2. start PostgreSQL, API, and renderer on a private network;
  3. apply migrations and seed one synthetic saved document and generated media;
  4. render a short MP4 and verify via `ffprobe` H.264, width, height, FPS,
     duration tolerance, audio presence, nonzero size, and SHA-256;
  5. prove cancellation and a deliberately short deadline terminate owned work
     and leave no partial published output;
  6. prove a second active create returns `render_busy` and creates no waiting
     row;
  7. prove all files remain under the temporary artifact root; and
  8. stop containers and remove the temporary directory in `trap` cleanup.

- [ ] **Step 5: Run deployment and Compose checks GREEN**

  ```bash
  uv run --project python pytest python/tests/deployment -q
  docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
  bash docker/test-renderer-offline.sh thoth-stage1:e1-local thoth-remotion-renderer:e1-local
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add compose.stage1.local.yml .env.stage1.local.example python/tests/deployment/test_local_stage1_compose_contract.py python/tests/deployment/test_container_contract.py docker/test-renderer-offline.sh .github/workflows/container-image.yml
  git commit -m "test: gate the isolated render stack"
  ```

### Task 14: Verify the complete offline feature and record the audit trail

**Files:**
- Modify: `CHANGELOG.md`
- Modify but do not stage: `.superpowers/sdd/2026-09-20-creator-studio-revision-bound-render-job/progress.md`

**Interfaces:**
- Consumes every prior task.
- Produces fresh verification evidence and an honest completion checkpoint; no
  product contract changes belong in this task.

- [ ] **Step 1: Inspect scope and security drift before full gates**

  Run targeted searches proving no queue/broker/S3/new output root, no private
  route in public OpenAPI/client, no DB credential in renderer, no renderer URL
  or path in dashboard, no arbitrary composition/codec input, and no modified
  Rust/legacy renderer behavior. Review `git diff 20e7aa1...HEAD` file by file.

- [ ] **Step 2: Run all Python gates**

  ```bash
  uv sync --project python --frozen --all-groups --extra acquisition
  uv run --project python pytest -m "not live" -q
  uv run --project python pytest python/tests/deployment -q
  uv run --project python ruff check python/src python/tests
  uv run --project python ruff format --check python/src python/tests
  ```

- [ ] **Step 3: Prove generated contracts stable**

  Export public OpenAPI and run
  `bun --cwd=dashboard run generate:control-plane-types` twice. Require the
  second run to be byte-identical and grep both outputs for absence of private
  paths/credentials/storage fields.

- [ ] **Step 4: Run dashboard and renderer gates**

  ```bash
  bun --cwd=dashboard test
  bun --cwd=dashboard test
  bun --cwd=dashboard test
  bun --cwd=dashboard run lint
  bun --cwd=dashboard run build
  bun --cwd=renderer install --frozen-lockfile
  bun --cwd=renderer test
  bun --cwd=renderer x tsc -p tsconfig.json --noEmit
  docker build -f Dockerfile.renderer -t thoth-remotion-renderer:e1-local .
  bash docker/test-renderer-offline.sh thoth-stage1:e1-local thoth-remotion-renderer:e1-local
  ```

- [ ] **Step 5: Run mandatory repository regressions**

  ```powershell
  cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
  if ($LASTEXITCODE -ne 0) { Get-Content build_log.txt | Select-Object -Last 200; exit $LASTEXITCODE }
  cargo test --bin thoth
  ```

  ```bash
  bun --cwd=scout install --frozen-lockfile
  bun --cwd=scout run test:acquisition
  bun --cwd=scout run test:runtime
  docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
  git diff --check
  graphify update .
  ```

- [ ] **Step 6: Update English audit records**

  Append to `CHANGELOG.md`: commits, exact pass/fail/skip/warning counts, image
  IDs, synthetic smoke facts, known limitations, and explicit non-live scope.
  Update the ignored SDD checkpoint with the same current state and next gate.
  Do not add chronological history back to `BLUEPRINT.md`.

- [ ] **Step 7: Commit only tracked audit documentation**

  ```bash
  git add CHANGELOG.md
  git commit -m "docs: record revision-bound render verification"
  ```

- [ ] **Step 8: Produce the executor final report and stop**

  Report baseline/final HEAD, branch/upstream/ahead-behind, every commit, RED→GREEN
  evidence by task, exact verification counts, renderer image ID, codec/path/
  cancellation/security proofs, operator-owned preservation, limitations, and
  the next operator gate. Do not push, deploy, start a non-synthetic service,
  use a real asset, or begin a later render phase.

## Plan Self-Review

- **Spec coverage:** Tasks 1–14 cover every acceptance criterion AC1–AC15,
  public/private protocols, graceful degradation, restart/deadline closure,
  trusted composition reuse, artifact lifecycle, UI, and all repository gates.
- **No placeholders:** The plan contains no deferred implementation markers;
  exact files, interfaces, RED/GREEN commands, security boundaries, commits, and
  synthetic verification are specified.
- **Type consistency:** `RenderJob`, `RenderJobEvent`, `RenderOutputFacts`,
  `RenderJobRepository`, `ArtifactRoot`, `RendererGateway`, and
  `RenderJobService` are defined once and consumed under the same names.
- **Review focus coverage:** Concurrent replay (Task 3), mutable/duplicate assets
  (Task 5), terminal races (Tasks 1/7/10), hostile filesystem nodes (Task 4/13),
  and polling races (Tasks 11/12) each have an owning RED test.
- **YAGNI:** One output row, one composition, one preset, one active execution,
  native HTTP servers/clients, local filesystem, and no queue or generic artifact
  framework are deliberate E1 limits.
