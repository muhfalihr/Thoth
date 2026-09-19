# Creator Studio Advanced Timeline Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add a versioned, project-scoped multi-track editing foundation to Creator Studio while keeping `EditDocument` canonical, preserving version 1 history, and leaving rendering and live media acquisition out of scope.

**Architecture:** Python owns strict version 2 document, operation, asset, migration, persistence, and API contracts. React projects the same local draft into Simple and Advanced workspaces, while Remotion Player receives the draft through `inputProps` and shares one playhead through `PlayerRef`. PostgreSQL remains append-only for document revisions and stores only minimal asset metadata and upgrade idempotency; no new service, queue, global state library, or timeline dependency is introduced.

**Tech Stack:** Python 3.12, Pydantic v2, FastAPI/Starlette, psycopg 3, PostgreSQL 16, React 19, TypeScript, Bun, Tailwind CSS, Remotion Player 4.0.523, pytest, Ruff, Testing Library, Oxlint, Vite.

**Spec:** `docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md`

## Global Constraints

- Execute on `codex/stage1-container-ci`; preserve the five local commits through the spec commit `31ac40b` and do not rewrite history.
- Treat the commit containing this plan as the execution baseline. Record its exact SHA before edits and stop on overlapping uncommitted product-code drift.
- Read `AGENTS.md`, `CLAUDE.md`, `.superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md`, this plan, and the linked spec before changing code.
- Invoke the applicable Superpowers execution and TDD skills. Use Ponytail at `full` intensity and Context7 for current third-party APIs.
- Keep `EditDocument` canonical. The timeline, Scene Board, Inspector, and Remotion composition must not maintain a second creative model.
- Preserve version 1 documents and migrations byte-for-byte. Add only forward migration `0004`.
- Store timing as integer frames. Do not persist seconds, pixels-per-frame, scroll position, playhead, or preview capability in the document.
- Do not add a timeline/state dependency, websocket, event store, service, queue, user-authored code, arbitrary URL/path, or raw FFmpeg/renderer input.
- Serve editor preview media through the dashboard's same-origin `/api/v1`
  reverse proxy. This keeps the HttpOnly capability cookie usable without
  exposing it to JavaScript or weakening `SameSite`; do not fall back to a
  tokenized query string for cross-origin setups.
- Use strict generated OpenAPI types. Do not hand-edit `python/openapi.json` or `dashboard/src/api/generated/control-plane.ts`.
- Every pointer edit must have a labelled-control or keyboard equivalent.
- Commit each task with one concise subject line, no body and no `Co-Authored-By` trailer.
- Keep `.superpowers/sdd/.../progress.md` current but do not force-add it; it is intentionally gitignored.
- Append completed implementation and verification history to `CHANGELOG.md`; do not add history to `BLUEPRINT.md`.
- Do not push, publish, deploy, restart services, access real assets/secrets, perform live/provider/TikTok/Scout requests, run parity or controlled fallback, mutate evidence or Issue #5, or open an acceptance window.

## Review Focus

1. **Migration replay and drift:** the same idempotency key plus identical version 1 base returns the prior version 2 result, while a changed base revision or payload fails without appending another revision. Task 4 owns these tests.
2. **Timing edge conditions:** trim, split, move, and ripple reject zero-length, out-of-source, out-of-canvas, locked, incompatible-track, overlap, and ID-collision inputs atomically. Task 2 owns these tests.
3. **Asset isolation:** cross-project, unready, expired-capability, wrong-asset-capability, path-traversal, and missing-file requests return safe failures without exposing locators. Tasks 3, 5, and 6 own these tests.
4. **Async UI lifecycle:** player listeners, preview capability loads, asset loads, autosave callbacks, and document upgrade callbacks cannot update a switched or unmounted Studio. Tasks 9 and 11 own these tests.
5. **Draft integrity:** mode switches, offline/reconnect, failed preview, failed save, conflict resolution, and pointer cancellation preserve the one local draft and pending operations. Tasks 7, 10, and 11 own these tests.

---

## Execution preflight

- [ ] **Step 1: Read the task entrypoints in order.**

```powershell
rtk git status --short --branch
rtk git log --oneline --decorate -12
rtk git rev-parse HEAD
rtk git rev-parse --abbrev-ref --symbolic-full-name '@{u}'
```

Then read `AGENTS.md`, `CLAUDE.md`, the active progress checkpoint, the D1 spec, and this plan. Confirm `31ac40b` is an ancestor of `HEAD`.

- [ ] **Step 2: Inspect drift fail-closed.**

```powershell
rtk git diff --name-status 31ac40b..HEAD
rtk git status --short --untracked-files=all
```

Expected: only the approved plan/checkpoint documentation may follow `31ac40b`; no uncommitted product-code drift. Preserve the earlier local commits `fe47ee4`, `cc93bea`, `2b7a43a`, `cd6203e`, and spec commit `31ac40b` unchanged.

- [ ] **Step 3: Record the baseline in the active progress checkpoint.**

Record branch, exact `HEAD`, upstream, ahead/behind, clean/dirty state, and the approved implementation boundary. Do not stage the gitignored checkpoint.

---

### Task 1: Define version 2 edit-document contracts and deterministic upgrade

**Files:**

- Create: `python/src/thoth_control_plane/domain/edit_document_v2.py`
- Create: `python/src/thoth_control_plane/domain/edit_document_upgrade.py`
- Modify: `python/src/thoth_control_plane/domain/edit_documents.py`
- Modify: `python/src/thoth_control_plane/domain/__init__.py`
- Test: `python/tests/domain/test_edit_document_v2.py`
- Test: `python/tests/domain/test_edit_document_upgrade.py`
- Test: `python/tests/domain/test_edit_documents.py`

**Interfaces:**

- Produces `EditDocumentV1`, `EditDocumentV2`, and discriminated alias `EditDocument` keyed by `schema_version`.
- Produces strict `TimelineTrack`, `AssetRef`, and clip unions for `text`, `video`, `overlay`, `caption`, and `audio` data.
- Produces `upgrade_edit_document_v1(document: EditDocumentV1) -> EditDocumentV2` for Tasks 4 and 5.
- Preserves all existing version 1 validation and import behavior.

- [ ] **Step 1: Write failing version 2 contract tests.**

Add table-driven tests proving:

```python
def test_version_two_accepts_all_registered_track_and_clip_kinds() -> None:
    document = document_v2_fixture()
    assert document.schema_version == 2
    assert {track.kind for track in document.tracks} == {
        "main_video", "b_roll", "overlay", "caption", "narration", "music", "sfx"
    }


@pytest.mark.parametrize(
    "mutation, message",
    [
        (cross_project_asset, "asset reference project must match document"),
        (clip_on_wrong_track, "clip kind is incompatible with track"),
        (clip_past_canvas, "clip range exceeds canvas"),
        (duplicate_track_id, "duplicate track IDs are not allowed"),
    ],
)
def test_version_two_rejects_invalid_structure(mutation, message) -> None:
    with pytest.raises(ValidationError, match=message):
        EditDocumentV2.model_validate(mutation(document_v2_payload()))
```

Keep the existing version 1 fixture valid and assert unknown schema versions fail discriminator validation.

- [ ] **Step 2: Run the new contract tests and verify RED.**

```powershell
rtk uv run --project python pytest python/tests/domain/test_edit_document_v2.py python/tests/domain/test_edit_documents.py -q
```

Expected: collection/import failure because version 2 contracts do not exist.

- [ ] **Step 3: Implement the minimal strict version 2 model.**

Use focused discriminated models rather than one optional-field clip object:

```python
TrackKind: TypeAlias = Literal[
    "main_video", "b_roll", "overlay", "caption", "narration", "music", "sfx"
]

class TimelineTrack(StrictModel):
    track_id: OpaqueId
    kind: TrackKind
    label: Annotated[str, Field(min_length=1, max_length=120)]
    order: Annotated[int, Field(ge=0)]
    hidden: bool = False
    muted: bool = False
    locked: bool = False
    clip_ids: Annotated[list[OpaqueId], Field(max_length=500)] = []

class TimelineClipBase(StrictModel):
    clip_id: OpaqueId
    track_id: OpaqueId
    scene_id: OpaqueId | None = None
    from_frame: FrameStart
    duration_in_frames: Frame
    ownership: Ownership
    hidden: bool = False
    locked: bool = False
```

Use `default_factory=list`, not a shared mutable list, in production code. Keep kind-specific fields closed and bounded. `AssetRef` exposes only safe metadata: immutable ID, media kind, duration, dimensions, FPS, audio presence, validation state, and checksum/provenance identifiers; it contains no artifact location or preview capability.

- [ ] **Step 4: Write failing deterministic upgrade tests.**

```python
def test_upgrade_preserves_v1_identity_text_and_timing() -> None:
    source = build_v1_document()
    upgraded = upgrade_edit_document_v1(source)
    assert upgraded.schema_version == 2
    assert upgraded.document_id == source.document_id
    assert upgraded.revision == source.revision
    assert [scene.scene_id for scene in upgraded.scenes] == [s.scene_id for s in source.scenes]
    assert [clip.clip_id for clip in upgraded.clips if clip.kind == "text"] == [
        clip.clip_id for clip in source.clips
    ]
    assert upgrade_edit_document_v1(source).model_dump() == upgraded.model_dump()
```

Also assert media tracks are empty, no asset is invented, and the input model dump remains unchanged.

- [ ] **Step 5: Implement the pure upgrade and run GREEN tests.**

The upgrade creates the seven typed track roles with deterministic IDs, maps the existing text clips to the overlay/text-compatible track, retains scenes/canvas/template/ownership, leaves `asset_refs` empty, and does not increment revision. Persistence increments it later.

```powershell
rtk uv run --project python pytest python/tests/domain/test_edit_document_v2.py python/tests/domain/test_edit_document_upgrade.py python/tests/domain/test_edit_documents.py -q
rtk uv run --project python ruff check python/src/thoth_control_plane/domain python/tests/domain
rtk uv run --project python ruff format --check python/src/thoth_control_plane/domain python/tests/domain
```

- [ ] **Step 6: Commit Task 1.**

```powershell
rtk git add python/src/thoth_control_plane/domain python/tests/domain
rtk git commit -m "feat: define advanced timeline documents"
```

---

### Task 2: Implement atomic timeline operations

**Files:**

- Create: `python/src/thoth_control_plane/domain/timeline_operations.py`
- Modify: `python/src/thoth_control_plane/domain/edit_document_operations.py`
- Modify: `python/src/thoth_control_plane/domain/__init__.py`
- Test: `python/tests/domain/test_timeline_operations.py`
- Test: `python/tests/domain/test_edit_document_operations.py`

**Interfaces:**

- Extends `EditDocumentOperation` with the exact operations approved by the spec.
- Preserves existing two-argument callers while widening the signature to
  `apply_edit_operations(document, operations, *, resolved_assets=None) -> EditDocument`.
  Only `add_clip_from_asset` consumes the project-scoped safe asset projection
  supplied by the repository; all other operations remain document-only.
- Produces pure helpers used by the dashboard reducer contract in Task 7.

- [ ] **Step 1: Write failing operation parsing and atomicity tests.**

Exercise each discriminated operation and assert unknown fields/kinds fail. Pin split identity and atomic rollback:

```python
def test_split_uses_supplied_unique_ids_and_preserves_source_range() -> None:
    result = apply_edit_operations(
        document_v2_fixture(),
        [SplitClip(
            kind="split_clip", operation_id="op_split", clip_id="clip_main",
            split_frame=90, left_clip_id="clip_left", right_clip_id="clip_right",
        )],
    )
    assert [(clip.clip_id, clip.from_frame, clip.duration_in_frames) for clip in result.clips] == [
        ("clip_left", 0, 90), ("clip_right", 90, 210)
    ]


def test_operation_batch_is_atomic_when_last_operation_is_invalid() -> None:
    original = document_v2_fixture()
    with pytest.raises(ValueError, match="locked"):
        apply_edit_operations(original, [valid_move(), move_locked_clip()])
    assert original == document_v2_fixture()
```

- [ ] **Step 2: Run the focused tests and verify RED.**

```powershell
rtk uv run --project python pytest python/tests/domain/test_timeline_operations.py python/tests/domain/test_edit_document_operations.py -q
```

- [ ] **Step 3: Define the strict operation union.**

Use exact payloads so the server never infers a different edit from UI state:

```python
class MoveClip(OperationBase):
    kind: Literal["move_clip"]
    clip_id: OpaqueId
    target_track_id: OpaqueId
    from_frame: FrameStart
    ripple: bool = False

class SplitClip(OperationBase):
    kind: Literal["split_clip"]
    clip_id: OpaqueId
    split_frame: FrameStart
    left_clip_id: OpaqueId
    right_clip_id: OpaqueId

class SetClipVolume(OperationBase):
    kind: Literal["set_clip_volume"]
    clip_id: OpaqueId
    volume: Annotated[float, Field(ge=0, le=2)]
```

Define similarly bounded add/remove/reorder, trim-start/end, visibility/mute, and lock operations. `add_clip_from_asset` references an existing `asset_id`; it never accepts URL/path/media metadata from the browser.

- [ ] **Step 4: Implement copy-then-validate application.**

Dispatch version 1 operations through existing behavior and version 2 operations through focused helpers. `add_clip_from_asset` must find its ID in the supplied `resolved_assets` mapping, copy the safe asset projection into `document.asset_refs` only when first used, and reject a missing or cross-project mapping. Rebuild `EditDocumentV2` from `model_dump()` only after the full ordered batch, so all structural invariants run once and any error persists nothing.

- [ ] **Step 5: Add edge-case tests from Review Focus item 2.**

Cover zero-length trim/split, split at either edge, duplicate new IDs, source bounds, canvas bounds, wrong track kind, locked clip/track, non-main overlap, main overlap/gap, explicit ripple, remove-nonempty-track, order collisions, and a non-finite volume rejected by strict validation.

- [ ] **Step 6: Run GREEN and regression tests.**

```powershell
rtk uv run --project python pytest python/tests/domain/test_timeline_operations.py python/tests/domain/test_edit_document_operations.py python/tests/domain/test_edit_document_v2.py -q
rtk uv run --project python ruff check python/src/thoth_control_plane/domain python/tests/domain
rtk uv run --project python ruff format --check python/src/thoth_control_plane/domain python/tests/domain
```

- [ ] **Step 7: Commit Task 2.**

```powershell
rtk git add python/src/thoth_control_plane/domain python/tests/domain
rtk git commit -m "feat: apply advanced timeline operations"
```

---

### Task 3: Add editor asset and upgrade persistence

**Files:**

- Create: `python/migrations/editor/0004_advanced_timeline_foundation.sql`
- Create: `python/src/thoth_control_plane/domain/editor_assets.py`
- Create: `python/src/thoth_control_plane/application/editor_asset_ports.py`
- Create: `python/src/thoth_control_plane/infrastructure/editor_asset_repository.py`
- Modify: `python/src/thoth_control_plane/infrastructure/editor_repository.py`
- Modify: `python/src/thoth_control_plane/application/ports.py`
- Test: `python/tests/operations/test_editor_migrations.py`
- Create: `python/tests/infrastructure/test_editor_asset_repository.py`
- Modify: `python/tests/infrastructure/test_editor_repository.py`

**Interfaces:**

- Produces `EditorAsset`, `EditorAssetPage`, `EditorAssetRepository`, and PostgreSQL implementation.
- Extends `EditDocumentRepository.upgrade_to_timeline(...)` with transaction-level version check and idempotency.
- Keeps server-only `artifact_location` out of public document and API models.

- [ ] **Step 1: Write failing migration contract tests.**

Update the exact migration list to include `0004_advanced_timeline_foundation.sql`. Assert it creates:

```sql
CREATE TABLE editor_assets (...);
CREATE TABLE edit_document_upgrade_idempotency (...);
```

Require project-scoped asset primary/unique keys, validation-state checks, positive media bounds, safe-length locator/checksum/provenance columns, an index for bounded newest-first listing, and a foreign key/result revision relation where PostgreSQL can enforce it. Preserve `0001` through `0003` byte-identically.

- [ ] **Step 2: Verify migration tests fail.**

```powershell
rtk uv run --project python pytest python/tests/operations/test_editor_migrations.py -q
```

- [ ] **Step 3: Add the forward-only migration and strict public/server models.**

Keep the public asset projection separate from its locator:

```python
class EditorAsset(StrictModel):
    asset_id: OpaqueId
    project_id: ProjectId
    kind: Literal["video", "image", "audio"]
    media_type: SafeMediaType
    duration_in_frames: Frame | None = None
    width: PositiveInt | None = None
    height: PositiveInt | None = None
    fps: Annotated[float, Field(gt=0, le=240)] | None = None
    has_audio: bool
    validation_state: Literal["ready", "rejected", "pending"]
    checksum: Checksum | None = None
```

The repository's private record may include a validated relative `artifact_location`; public `EditorAsset` may not.

- [ ] **Step 4: Write failing repository tests.**

Using the existing fake cursor/connection pattern, assert:

- all SQL values are parameters;
- project ownership appears in every lookup/list predicate;
- list uses a fixed maximum page size and opaque cursor;
- `ready` filtering is explicit;
- a cross-project asset returns no row;
- `apply_operations` resolves every `add_clip_from_asset` ID under the same
  project inside the transaction and passes only safe asset projections to the
  pure operation engine;
- upgrade locks latest document revision, checks schema/base revision, appends exactly one version 2 revision, and records idempotency in the same transaction;
- identical replay returns the recorded result;
- same key/different payload or changed base conflicts without insert.

- [ ] **Step 5: Implement repositories and run GREEN tests.**

Use the existing short-lived `AsyncConnection` pattern and `FOR UPDATE` for upgrade. Hash the canonical upgrade request fields (`project_id`, `document_id`, `base_revision`) rather than retaining a raw request.

```powershell
rtk uv run --project python pytest python/tests/operations/test_editor_migrations.py python/tests/infrastructure/test_editor_repository.py python/tests/infrastructure/test_editor_asset_repository.py -q
rtk uv run --project python ruff check python/src/thoth_control_plane/infrastructure python/src/thoth_control_plane/application/editor_asset_ports.py python/tests/infrastructure python/tests/operations
rtk uv run --project python ruff format --check python/src/thoth_control_plane/infrastructure python/src/thoth_control_plane/application/editor_asset_ports.py python/tests/infrastructure python/tests/operations
```

- [ ] **Step 6: Commit Task 3.**

```powershell
rtk git add python/migrations/editor/0004_advanced_timeline_foundation.sql python/src/thoth_control_plane/domain/editor_assets.py python/src/thoth_control_plane/application/editor_asset_ports.py python/src/thoth_control_plane/application/ports.py python/src/thoth_control_plane/infrastructure python/tests/operations/test_editor_migrations.py python/tests/infrastructure
rtk git commit -m "feat: persist timeline assets and upgrades"
```

---

### Task 4: Orchestrate timeline upgrade and editor assets

**Files:**

- Modify: `python/src/thoth_control_plane/application/edit_documents.py`
- Create: `python/src/thoth_control_plane/application/editor_assets.py`
- Modify: `python/src/thoth_control_plane/application/__init__.py`
- Modify: `python/tests/application/test_edit_documents.py`
- Create: `python/tests/application/test_editor_assets.py`

**Interfaces:**

- Produces `UpgradeTimelineRequest(base_revision)` and `EditDocumentService.upgrade_to_timeline(...)`.
- Produces `EditorAssetService.list_ready(...)` and `get_ready_record(...)` for API/preview Tasks 5 and 6.
- Maps infrastructure errors to safe application exceptions without retaining locator/connection details.

- [ ] **Step 1: Write failing upgrade service tests.**

```python
@pytest.mark.asyncio
async def test_upgrade_is_explicit_idempotent_and_appends_one_revision() -> None:
    service, repository = service_with_v1_document()
    first = await service.upgrade_to_timeline(
        project_id="project_001", document_id="edoc_001", base_revision=1,
        idempotency_key="upgrade_001",
    )
    replay = await service.upgrade_to_timeline(
        project_id="project_001", document_id="edoc_001", base_revision=1,
        idempotency_key="upgrade_001",
    )
    assert first == replay
    assert first.schema_version == 2
    assert first.revision == 2
    assert repository.insert_count == 1
```

Also cover already-v2 refusal, missing document, blank/oversized idempotency key, stale base, same-key/different-payload, and repository failure.

- [ ] **Step 2: Run tests and verify RED.**

```powershell
rtk uv run --project python pytest python/tests/application/test_edit_documents.py python/tests/application/test_editor_assets.py -q
```

- [ ] **Step 3: Implement the minimal application services.**

Do not read artifact files in these services. Validate request/ownership, delegate transactionality to repositories, and return public models only.

- [ ] **Step 4: Add asset isolation and bounded-page tests.**

Pin empty page, ready-only projection, cursor replay, invalid limit, unknown asset, cross-project asset, pending/rejected asset, and repository unavailable behavior.

- [ ] **Step 5: Run GREEN and lint.**

```powershell
rtk uv run --project python pytest python/tests/application/test_edit_documents.py python/tests/application/test_editor_assets.py -q
rtk uv run --project python ruff check python/src/thoth_control_plane/application python/tests/application
rtk uv run --project python ruff format --check python/src/thoth_control_plane/application python/tests/application
```

- [ ] **Step 6: Commit Task 4.**

```powershell
rtk git add python/src/thoth_control_plane/application python/tests/application
rtk git commit -m "feat: orchestrate timeline upgrades and assets"
```

---

### Task 5: Expose version 2 upgrade and asset catalog APIs

**Files:**

- Modify: `python/src/thoth_control_plane/api/routes/edit_documents.py`
- Create: `python/src/thoth_control_plane/api/routes/editor_assets.py`
- Modify: `python/src/thoth_control_plane/api/app.py`
- Modify: `python/tests/api/test_edit_documents.py`
- Create: `python/tests/api/test_editor_assets.py`
- Create: `python/tests/api/test_openapi_contract.py`

**Interfaces:**

- Adds authenticated upgrade and bounded asset-list routes from the spec.
- Introduces typed safe conflict/error envelopes, including `DocumentRevisionConflictBody`.
- Wires application services without exposing locator or preview capability in list responses.

- [ ] **Step 1: Write failing route tests.**

Cover:

```python
upgrade = await client.post(
    "/api/v1/projects/project_001/edit-documents/edoc_001/upgrade-timeline",
    headers={**AUTH_HEADERS, "Idempotency-Key": "upgrade_001"},
    json={"base_revision": 1},
)
assert upgrade.status_code == 200
assert upgrade.json()["schema_version"] == 2

assets = await client.get(
    "/api/v1/projects/project_001/editor-assets?limit=20", headers=AUTH_HEADERS
)
assert assets.status_code == 200
assert "artifact_location" not in assets.text
```

Assert unauthenticated, missing idempotency key, unknown fields, missing document, stale revision, replay conflict, invalid cursor/limit, cross-project, unavailable store, and safe error shapes.

- [ ] **Step 2: Run focused API tests and verify RED.**

```powershell
rtk uv run --project python pytest python/tests/api/test_edit_documents.py python/tests/api/test_editor_assets.py python/tests/api/test_openapi_contract.py -q
```

- [ ] **Step 3: Implement routes and dependency wiring.**

Use `Header(alias="Idempotency-Key")` with required/length validation. Update PATCH conflict from the old bare document to:

```json
{"code":"document_revision_conflict","latest":{}}
```

Keep other validation failures on FastAPI's standard contract unless the response could leak sensitive input. Add the asset router under `/api/v1` and initialize the service from the same editor database setting.

- [ ] **Step 4: Run GREEN and inspect OpenAPI in memory.**

```powershell
rtk uv run --project python pytest python/tests/api/test_edit_documents.py python/tests/api/test_editor_assets.py python/tests/api/test_openapi_contract.py -q
rtk uv run --project python ruff check python/src/thoth_control_plane/api python/tests/api
rtk uv run --project python ruff format --check python/src/thoth_control_plane/api python/tests/api
```

- [ ] **Step 5: Commit Task 5.**

```powershell
rtk git add python/src/thoth_control_plane/api python/tests/api
rtk git commit -m "feat: expose advanced timeline APIs"
```

---

### Task 6: Issue and serve safe preview capabilities

**Files:**

- Create: `python/src/thoth_control_plane/infrastructure/editor_preview.py`
- Modify: `python/src/thoth_control_plane/api/routes/editor_assets.py`
- Modify: `python/src/thoth_control_plane/api/app.py`
- Modify: `python/src/thoth_control_plane/config.py`
- Create: `python/tests/infrastructure/test_editor_preview.py`
- Modify: `python/tests/api/test_editor_assets.py`
- Create: `python/tests/test_config.py`

**Interfaces:**

- Produces `EditorPreviewSigner.issue(...)` and `verify(...)` using stdlib HMAC-SHA256.
- Produces short-lived capability response `{preview_url, expires_at}` while
  carrying the opaque signed value only in an HttpOnly asset-scoped cookie; the
  capability is absent from URLs and JSON bodies.
- Serves only a repository-resolved file under `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` with controlled media type and byte-range support.

- [ ] **Step 1: Write failing signer tests.**

```python
def test_preview_capability_is_scoped_and_expires() -> None:
    token = signer.issue(actor_id="owner", project_id="project_001", asset_id="asset_001", now=NOW)
    assert signer.verify(token, actor_id="owner", project_id="project_001", asset_id="asset_001", now=NOW)
    with pytest.raises(PreviewCapabilityInvalid):
        signer.verify(token, actor_id="owner", project_id="project_001", asset_id="asset_002", now=NOW)
    with pytest.raises(PreviewCapabilityExpired):
        signer.verify(token, actor_id="owner", project_id="project_001", asset_id="asset_001", now=NOW + TTL)
```

Also test signature tampering, alternate project/actor, malformed base64/JSON, future-issued token beyond skew, and token text absence from exception messages/repr.

- [ ] **Step 2: Verify signer tests fail.**

```powershell
rtk uv run --project python pytest python/tests/infrastructure/test_editor_preview.py -q
```

- [ ] **Step 3: Implement the stdlib signer and safe path resolver.**

Add `THOTH_EDITOR_PREVIEW_SIGNING_KEY: SecretStr | None = None` and a bounded TTL setting. Canonically encode only version, actor ID, project ID, asset ID, issued-at, and expiry. Resolve the repository's safe relative locator against the configured artifact root, then require the resolved file to remain under that root.

The authenticated capability-creation response sets a fixed-name `HttpOnly`
cookie with bounded `Max-Age`, an exact asset preview-route `Path`, and
`SameSite=Strict`; the same cookie name may coexist for different exact paths.
Set `Secure` when the request scheme is HTTPS. Its JSON body contains only the
same-origin relative preview URL and expiry. The media GET is authorized by
that cookie and does not require JavaScript-readable bearer material.

- [ ] **Step 4: Write failing API streaming tests.**

Use a temporary artifact root and seeded ready asset. Assert:

- capability issuance requires bearer auth and ready same-project asset;
- the JSON/URL omit the signed capability while `Set-Cookie` is HttpOnly,
  route-scoped, short-lived, and scheme-appropriate;
- a configured cross-origin preview URL is refused instead of downgrading to a
  capability in the URL;
- full GET returns controlled content type;
- `Range: bytes=0-3` returns `206`, correct `Content-Range`, and four bytes;
- wrong/expired capability returns safe `403`;
- missing file returns safe `404` or `asset_not_ready` without path;
- pending/rejected/cross-project assets fail;
- `..`, absolute, drive-letter, query-bearing, and URL-like locators never reach file serving;
- capability and signing key do not appear in logs, response errors, or OpenAPI document models.

- [ ] **Step 5: Implement routes with Starlette `FileResponse`.**

Use current Starlette `FileResponse` byte-range behavior rather than custom streaming. Pass the validated media type, do not supply an unsafe download filename, and set restrictive cache/referrer headers. Verify behavior with the range test instead of assuming framework support. Read the signed asset-scoped cookie with a bounded alias and clear it on failed verification; never place it in a route path, query string, log message, or response body.

- [ ] **Step 6: Run GREEN and security-focused checks.**

```powershell
rtk uv run --project python pytest python/tests/infrastructure/test_editor_preview.py python/tests/api/test_editor_assets.py python/tests/test_config.py -q
rtk uv run --project python ruff check python/src/thoth_control_plane/config.py python/src/thoth_control_plane/infrastructure/editor_preview.py python/src/thoth_control_plane/api/routes/editor_assets.py python/tests/infrastructure/test_editor_preview.py python/tests/api/test_editor_assets.py python/tests/test_config.py
rtk uv run --project python ruff format --check python/src/thoth_control_plane/config.py python/src/thoth_control_plane/infrastructure/editor_preview.py python/src/thoth_control_plane/api/routes/editor_assets.py python/tests/infrastructure/test_editor_preview.py python/tests/api/test_editor_assets.py python/tests/test_config.py
```

- [ ] **Step 7: Commit Task 6.**

```powershell
rtk git add python/src/thoth_control_plane/config.py python/src/thoth_control_plane/infrastructure/editor_preview.py python/src/thoth_control_plane/api/routes/editor_assets.py python/src/thoth_control_plane/api/app.py python/tests
rtk git commit -m "feat: secure editor asset previews"
```

---

### Task 7: Regenerate contracts and extend the control-plane client

**Files:**

- Modify (generated): `python/openapi.json`
- Modify (generated): `dashboard/src/api/generated/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.ts`
- Modify: `dashboard/src/api/control-plane.test.ts`

**Interfaces:**

- Exposes generated `EditDocumentV1 | EditDocumentV2`, timeline operations, asset page, preview capability, and typed conflict envelopes.
- Extends `ControlPlaneClient` with `upgradeEditDocument`, `listEditorAssets`, and `createEditorPreviewCapability`.
- Updates `patchEditDocument` to unwrap `DocumentRevisionConflictBody.latest`.

- [ ] **Step 1: Write failing thin-client tests.**

Assert exact method/path/header/body behavior, URL encoding, one request per call, bounded asset query parameters, typed conflict unwrapping, and no capability added to a document payload.

```ts
expect(calls[0]).toMatchObject({
  url: "/api/v1/projects/project_001/edit-documents/edoc_001/upgrade-timeline",
  init: {method: "POST"},
});
expect(new Headers(calls[0].init?.headers).get("Idempotency-Key")).toBe("upgrade_001");
```

- [ ] **Step 2: Export OpenAPI and generate TypeScript.**

From the repository root:

```powershell
rtk uv run --project python python python/scripts/export_openapi.py
Push-Location dashboard
rtk bun run generate:control-plane-types
Pop-Location
```

Expected: generated files change; client tests still fail because methods are absent.

- [ ] **Step 3: Implement the minimal client methods and typed aliases.**

Use the injected `doFetch` consistently; fix the existing direct global `fetch` use in `patchEditDocument` while touching that method so tests can isolate all editor requests. Do not add a generic API abstraction.

- [ ] **Step 4: Run client tests and verify generated stability.**

```powershell
Push-Location dashboard
rtk bun test src/api/control-plane.test.ts
Pop-Location
rtk git add python/openapi.json dashboard/src/api/generated/control-plane.ts
rtk uv run --project python python python/scripts/export_openapi.py
Push-Location dashboard
rtk bun run generate:control-plane-types
Pop-Location
rtk git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts
```

Expected: tests pass; the second generation introduces no new diff beyond the already staged/generated change.

- [ ] **Step 5: Commit Task 7.**

```powershell
rtk git add python/openapi.json dashboard/src/api/generated/control-plane.ts dashboard/src/api/control-plane.ts dashboard/src/api/control-plane.test.ts
rtk git commit -m "feat: add advanced timeline client contracts"
```

---

### Task 8: Extend the Studio reducer for one canonical timeline draft

**Files:**

- Create: `dashboard/src/features/studio/timeline_domain.ts`
- Create: `dashboard/src/features/studio/timeline_domain.test.ts`
- Modify: `dashboard/src/features/studio/editor_state.ts`
- Modify: `dashboard/src/features/studio/editor_state.test.ts`
- Modify: `dashboard/src/features/studio/editor_state.final-fix.test.ts`

**Interfaces:**

- Produces pure frame/track/clip selectors and local operation application shared by timeline, Inspector, and preview.
- Extends `EditorState` with selected track/clip, mode, playhead, zoom, snapping, ripple, and persistent issue selection without duplicating `draft`.
- Keeps `toEditDocumentPatch()` as the only autosave payload builder.

- [ ] **Step 1: Write failing pure timeline-domain tests.**

Pin frame-to-pixel conversion, clamped zoom, deterministic snap candidate precedence, compatible track selection, visible ordered lanes, and issue-to-selection mapping.

```ts
test("snap chooses the nearest candidate then stable lower frame", () => {
  expect(snapFrame(101, [100, 102], 2)).toBe(100);
  expect(snapFrame(104, [100], 2)).toBe(104);
});
```

- [ ] **Step 2: Run tests and verify RED.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/timeline_domain.test.ts
Pop-Location
```

- [ ] **Step 3: Implement pure helpers with no React dependency.**

Use simple arrays and arithmetic. Do not add interval trees, command buses, or memoization infrastructure; D1 document bounds make a linear scan sufficient.

- [ ] **Step 4: Write failing reducer tests for every timeline action.**

Test selection, mode switch, playhead (transient, no pending operation), move, trim, split, track settings, volume, undo/redo, offline, save success with newer local operations, conflict, keep-local rebase, and pointer cancellation. Assert all edits change `state.draft` and append typed pending operations; no parallel track model exists.

- [ ] **Step 5: Implement reducer actions through shared pure operation application.**

Keep gesture preview separate from committed history:

```ts
type EditorAction =
  | {type: "preview_timeline_operation"; operation: EditDocumentOperation}
  | {type: "commit_timeline_operation"; operation: EditDocumentOperation}
  | {type: "cancel_timeline_preview"}
  | {type: "set_playhead"; frame: number}
  | {type: "select_clip"; clipId: string}
  | {type: "set_editor_mode"; mode: "simple" | "advanced"}
  | ExistingEditorAction;
```

Store the pre-gesture snapshot only while previewing; commit exactly one history entry and one pending operation.

- [ ] **Step 6: Run GREEN and regression tests.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/timeline_domain.test.ts src/features/studio/editor_state.test.ts src/features/studio/editor_state.final-fix.test.ts
Pop-Location
```

- [ ] **Step 7: Commit Task 8.**

```powershell
rtk git add dashboard/src/features/studio/timeline_domain.ts dashboard/src/features/studio/timeline_domain.test.ts dashboard/src/features/studio/editor_state.ts dashboard/src/features/studio/editor_state.test.ts dashboard/src/features/studio/editor_state.final-fix.test.ts
rtk git commit -m "feat: model advanced timeline state"
```

---

### Task 9: Render version 2 tracks and synchronize the Player

**Files:**

- Create: `dashboard/src/features/studio/AdvancedTimelineComposition.tsx`
- Create: `dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx`
- Create: `dashboard/src/features/studio/usePlayerTimeline.ts`
- Create: `dashboard/src/features/studio/usePlayerTimeline.test.tsx`
- Modify: `dashboard/src/features/studio/StudioPreview.tsx`
- Modify: `dashboard/src/features/studio/preview.ts`
- Modify: `dashboard/src/features/studio/preview.test.ts`
- Test: `dashboard/src/features/studio/StudioPreview.test.tsx`

**Interfaces:**

- `AdvancedTimelineComposition({document, previewSources})` renders trusted version 2 clip kinds.
- `usePlayerTimeline(playerRef, onFrameChange)` owns listener setup/cleanup and seek/play/pause calls.
- `StudioPreview` accepts controlled `playerRef`, preview source mapping, and persistent error callback while retaining version 1 behavior.

- [ ] **Step 1: Write failing composition tests.**

Assert track ordering/layering, hidden/muted/locked display semantics, clip `Sequence` frame ranges, text escaping, safe trusted overlay registry, video/audio source lookup by asset ID, and missing source placeholders that report `preview_unavailable` without throwing the whole composition.

- [ ] **Step 2: Verify composition tests fail.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/AdvancedTimelineComposition.test.tsx src/features/studio/preview.test.ts
Pop-Location
```

- [ ] **Step 3: Implement the composition with installed Remotion APIs only.**

Use `AbsoluteFill`, `Sequence`, and the media primitives already available in Remotion 4.0.523. Do not add `@remotion/media` or another package. Pass same-origin relative sources separately from the persisted document so preview capabilities cannot be serialized into revisions. Media elements use credentialed same-origin requests; no bearer token or capability is readable by the composition.

- [ ] **Step 4: Write failing PlayerRef lifecycle tests.**

Use a fake PlayerRef event target. Assert `frameupdate`, `seeked`, `play`, and `pause`; `seekTo(frame)`; cleanup on ref/document switch and unmount; no callback after cleanup; and repeated render does not duplicate listeners.

- [ ] **Step 5: Implement `usePlayerTimeline` and controlled preview.**

Follow current Remotion Player guidance: use `addEventListener`, `getCurrentFrame`, `seekTo`, and explicit cleanup. Keep PlayerRef mechanics out of the reducer and composition.

- [ ] **Step 6: Run GREEN and existing preview tests.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/AdvancedTimelineComposition.test.tsx src/features/studio/usePlayerTimeline.test.tsx src/features/studio/StudioPreview.test.tsx src/features/studio/preview.test.ts
Pop-Location
```

- [ ] **Step 7: Commit Task 9.**

```powershell
rtk git add dashboard/src/features/studio/AdvancedTimelineComposition.tsx dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx dashboard/src/features/studio/usePlayerTimeline.ts dashboard/src/features/studio/usePlayerTimeline.test.tsx dashboard/src/features/studio/StudioPreview.tsx dashboard/src/features/studio/StudioPreview.test.tsx dashboard/src/features/studio/preview.ts dashboard/src/features/studio/preview.test.ts
rtk git commit -m "feat: preview advanced timeline tracks"
```

---

### Task 10: Build accessible timeline and issue components

**Files:**

- Create: `dashboard/src/features/studio/Timeline.tsx`
- Create: `dashboard/src/features/studio/Timeline.test.tsx`
- Create: `dashboard/src/features/studio/TimelineToolbar.tsx`
- Create: `dashboard/src/features/studio/TimelineTrack.tsx`
- Create: `dashboard/src/features/studio/TimelineClip.tsx`
- Create: `dashboard/src/features/studio/IssuesPanel.tsx`
- Create: `dashboard/src/features/studio/IssuesPanel.test.tsx`

**Interfaces:**

- `Timeline` consumes only `EditorState` selectors and callbacks; it never owns a document copy.
- Emits preview/commit/cancel operations, selection, playhead, zoom, snapping, and ripple actions.
- `IssuesPanel` consumes validation issues and selects/focuses their typed target.

- [ ] **Step 1: Write failing structural and accessibility tests.**

Assert ordered labelled tracks, selected clip state, time ruler/playhead, zoom/snapping/ripple controls, lock/mute/visibility labels, desktop-only message, and no filmstrip/waveform placeholders that imply unsupported behavior.

- [ ] **Step 2: Write failing pointer plus equivalent-control tests.**

For move, trim-start, trim-end, and split, assert:

- pointer move dispatches preview only;
- pointer up dispatches one committed operation;
- Escape/pointer cancellation restores the draft and queues nothing;
- keyboard/labelled buttons produce the same operation payload;
- locked clips/tracks expose a visible reason and emit nothing;
- snapping uses the pure helper and can be disabled;
- no edit occurs on playhead scrubbing.

- [ ] **Step 3: Run tests and verify RED.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/Timeline.test.tsx src/features/studio/IssuesPanel.test.tsx
Pop-Location
```

- [ ] **Step 4: Implement the smallest native timeline.**

Use semantic buttons, CSS grid/absolute positioning, pointer events, and existing UI primitives. Use no canvas library, drag library, virtualization, waveform, or filmstrip. Linear scans and a bounded document are sufficient for D1.

- [ ] **Step 5: Implement persistent issues navigation.**

An issue button selects the target track/clip/scene, opens Advanced mode when needed, and focuses the relevant element using stable DOM IDs. Do not move focus for background validation changes.

- [ ] **Step 6: Run GREEN, lint, and component build checks.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/Timeline.test.tsx src/features/studio/IssuesPanel.test.tsx
rtk bun run lint
rtk bun run build
Pop-Location
```

- [ ] **Step 7: Commit Task 10.**

```powershell
rtk git add dashboard/src/features/studio/Timeline.tsx dashboard/src/features/studio/Timeline.test.tsx dashboard/src/features/studio/TimelineToolbar.tsx dashboard/src/features/studio/TimelineTrack.tsx dashboard/src/features/studio/TimelineClip.tsx dashboard/src/features/studio/IssuesPanel.tsx dashboard/src/features/studio/IssuesPanel.test.tsx
rtk git commit -m "feat: add accessible advanced timeline"
```

---

### Task 11: Integrate upgrade, assets, timeline, and Inspector into Studio

**Files:**

- Create: `dashboard/src/features/studio/AssetLibrary.tsx`
- Create: `dashboard/src/features/studio/AssetLibrary.test.tsx`
- Create: `dashboard/src/features/studio/TimelineInspector.tsx`
- Create: `dashboard/src/features/studio/TimelineInspector.test.tsx`
- Modify: `dashboard/src/features/studio/Inspector.tsx`
- Modify: `dashboard/src/features/studio/SceneBoard.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.final-fix.test.tsx`
- Modify: `dashboard/src/features/studio/prompt-proposal-test-fixtures.ts`

**Interfaces:**

- Presents explicit `Enable advanced timeline` for version 1 and never upgrades on open.
- Loads bounded ready assets and preview capabilities only for visible/needed assets.
- Keeps Prompt Lab, Simple Scene Board, Advanced Timeline, Inspector, and preview on the same reducer draft.
- Uses one monotonic document generation guard for every document-owned async callback.

- [ ] **Step 1: Write failing explicit-upgrade integration tests.**

Assert version 1 opens without a write, the action explains that history is preserved, double-click causes one in-flight call, success swaps to version 2 and Advanced mode, 409 shows conflict with latest, and failure keeps version 1 usable.

- [ ] **Step 2: Write failing asset-library tests.**

Assert bounded load, pagination, ready-only display, add-to-compatible-track action, unavailable/offline state, no raw locator, preview capability fetched only on demand, and stale/unmounted capability response discarded.

- [ ] **Step 3: Write failing draft-integrity and mode tests.**

Cover Simple → Advanced → Prompt Lab → Simple transitions with unsaved text and timeline edits, autosave success/failure, offline/reconnect, conflict resolution, failed preview, document switch, unmount, and desktop viewport gating. Assert Prompt Lab C1/C2 drafts still survive the same transitions.

- [ ] **Step 4: Run focused tests and verify RED.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/AssetLibrary.test.tsx src/features/studio/TimelineInspector.test.tsx src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx
Pop-Location
```

- [ ] **Step 5: Implement Studio integration.**

Split `GuidedStudio.tsx` only where new responsibilities create a clear seam: `AssetLibrary`, `Timeline`, `TimelineInspector`, and `IssuesPanel`. Keep save orchestration in GuidedStudio because it coordinates one reducer. Do not introduce context/global stores solely to reduce prop passing.

Use a single incrementing generation ref for document loads, asset loads, preview-capability loads, upgrade, save, and cleanup. A callback must compare its captured generation before dispatching or invoking an external callback.

- [ ] **Step 6: Extend Inspector without weakening text editing.**

Render the existing text/scene controls for compatible selections and typed controls for track, media trim/crop/fit, overlay preset parameters, caption fields, and audio volume/fades. Every control dispatches the same typed operation used by timeline actions.

- [ ] **Step 7: Run focused GREEN and C1/C2 regressions.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/AssetLibrary.test.tsx src/features/studio/TimelineInspector.test.tsx src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx src/features/studio/PromptLab.test.tsx src/features/studio/PromptProposalPanel.test.tsx src/features/studio/prompt_lab_state.test.ts src/features/studio/prompt_proposal_state.test.ts
Pop-Location
```

- [ ] **Step 8: Commit Task 11.**

```powershell
rtk git add dashboard/src/features/studio
rtk git commit -m "feat: integrate advanced timeline studio"
```

---

### Task 12: Wire offline runtime configuration and deployment contracts

**Files:**

- Modify: `compose.stage1.local.yml`
- Modify: `.env.stage1.local.example`
- Modify: `python/tests/deployment/test_local_stage1_compose_contract.py`
- Modify: `python/tests/deployment/test_container_contract.py`
- Modify: `python/tests/deployment/test_stage1_local_preflight.py`
- Modify: `python/tests/deployment/test_stage1_provider_preflight.py`

**Interfaces:**

- Provides `THOTH_EDITOR_PREVIEW_SIGNING_KEY` only to the API service.
- Keeps the existing artifact root mounted read-only or least-write as required by current API behavior; does not expose the signing key to dashboard, worker, or legacy CDP.
- Leaves all services and live gates otherwise unchanged.

- [ ] **Step 1: Write failing deployment contract tests.**

Assert:

```python
assert "THOTH_EDITOR_PREVIEW_SIGNING_KEY:" in api_environment
assert "THOTH_EDITOR_PREVIEW_SIGNING_KEY" not in worker_environment
assert "THOTH_EDITOR_PREVIEW_SIGNING_KEY" not in dashboard_environment
```

Also require a nonblank local example placeholder, existing artifact-root mount, no new public port/service, and unchanged provider-secret placement.

- [ ] **Step 2: Run deployment tests and verify RED.**

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py python/tests/deployment/test_container_contract.py python/tests/deployment/test_stage1_local_preflight.py python/tests/deployment/test_stage1_provider_preflight.py -q
```

- [ ] **Step 3: Add minimal configuration wiring.**

Add one API-only environment variable using the existing required-variable Compose style. Do not generate or access a real secret. Preserve all current service digests, ports, volumes, commands, and live behavior.

- [ ] **Step 4: Run GREEN and static Compose validation.**

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py python/tests/deployment/test_container_contract.py python/tests/deployment/test_stage1_local_preflight.py python/tests/deployment/test_stage1_provider_preflight.py -q
docker compose -f compose.stage1.local.yml --env-file .env.stage1.local.example config --quiet
```

If native Docker is unavailable, use WSL only for the read-only `docker compose ... config --quiet` command and report that substitution. Do not start services.

- [ ] **Step 5: Commit Task 12.**

```powershell
rtk git add compose.stage1.local.yml .env.stage1.local.example python/tests/deployment
rtk git commit -m "chore: configure editor preview signing"
```

---

### Task 13: Run full offline gates and record the audit trail

**Files:**

- Modify: `CHANGELOG.md`
- Modify (gitignored): `.superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md`

**Interfaces:**

- Produces fresh repository-wide evidence after the final code edit.
- Records actual commands/results, limitations, commits, and remaining operator gates without claiming live behavior.

- [ ] **Step 1: Run Python dependency and full non-live gates.**

```powershell
rtk uv sync --project python --frozen --all-groups --extra acquisition
rtk uv run --project python pytest -m "not live" -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
```

- [ ] **Step 2: Regenerate contracts twice and prove stability.**

```powershell
rtk uv run --project python python python/scripts/export_openapi.py
Push-Location dashboard
rtk bun run generate:control-plane-types
Pop-Location
rtk git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts
```

If final regeneration changes either generated file, commit the legitimate change with the owning task before continuing, rerun generation, and require the second run to be byte-identical.

- [ ] **Step 3: Run full dashboard gates and stability repetitions.**

```powershell
Push-Location dashboard
rtk bun test
rtk bun test
rtk bun test
rtk bun run lint
rtk bun run build
Pop-Location
```

Report every warning and whether it predates D1. Do not label a failure flaky without reproducing and root-causing it.

- [ ] **Step 4: Run the required Rust CUDA build.**

```powershell
cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
Write-Output "EXIT=$LASTEXITCODE"
```

Inspect `build_log.txt`, require exit `0`, and report warnings. Remove only the task-created log after evidence is captured; do not delete operator files.

- [ ] **Step 5: Run Scout and Compose contract gates.**

```powershell
Push-Location scout
rtk bun install --frozen-lockfile
rtk bun run test:acquisition
rtk bun run test:runtime
Pop-Location
docker compose -f compose.stage1.local.yml --env-file .env.stage1.local.example config --quiet
```

These remain offline/non-live. Do not execute a browser acquisition or provider request.

- [ ] **Step 6: Inspect security-sensitive generated and runtime surfaces.**

```powershell
rtk rg -n "artifact_location|preview_capability|signing_key|THOTH_EDITOR_PREVIEW_SIGNING_KEY" python/openapi.json dashboard/src/api/generated/control-plane.ts dashboard/src
rtk rg -n "dangerouslySetInnerHTML|eval\(|new Function|file://|\.\./" dashboard/src/features/studio python/src/thoth_control_plane/api/routes/editor_assets.py python/src/thoth_control_plane/infrastructure/editor_preview.py
rtk git diff --check
```

Expected: no locator/signing key in public generated document models, no executable content path, and no unsafe traversal. A preview capability type is allowed only in its dedicated transient API response/client path, never `EditDocument` or persisted state.

- [ ] **Step 7: Update code indexes after code changes.**

```powershell
rtk graphify update .
```

Confirm `graphify-out/` and `.codegraph/` generated indexes remain ignored and unstaged.

- [ ] **Step 8: Update the active progress checkpoint and `CHANGELOG.md`.**

Record baseline/final SHA, task commits, RED-to-GREEN evidence, full gate counts, security inspection, limitations, and hard stops. State explicitly that no upload, live asset/provider request, server render, deployment, push, or operational mutation occurred.

- [ ] **Step 9: Run final repository checks and commit documentation.**

```powershell
rtk git status --short --branch
rtk git diff --check
rtk git add CHANGELOG.md
rtk git commit -m "docs: record advanced timeline foundation"
rtk git status --short --branch
```

Expected: tracked worktree clean; the gitignored progress checkpoint may be modified but must not be staged. No unrelated operator-owned file is changed or committed.

- [ ] **Step 10: Stop and report.**

The final report must include:

1. baseline, branch, final HEAD, upstream, ahead/behind, and worktree state;
2. per-task commit table with one-line subjects;
3. exact version 2, migration, operation, asset, preview, API, and UI behavior delivered;
4. RED-to-GREEN evidence per task;
5. full verification table with actual pass/skip/fail counts and warnings;
6. proof version 1 and prior migrations remain compatible;
7. security inspection for paths, preview capabilities, signing keys, executable input, and project isolation;
8. known limitations: no upload/acquisition, waveform/filmstrip, multi-select, keyframes, server render, or live proof;
9. confirmation no push, deployment, real secret/asset access, provider/TikTok request, Stage 1 mutation, parity, controlled fallback, evidence/Issue #5 mutation, or acceptance activation occurred; and
10. next checkpoint: independent Codex review before any push or later D2/render work.

Stop. Do not infer permission to push, deploy, access live media, begin render-queue work, or start another sub-project.

## Plan self-review

### Spec coverage

- Version 2 document, migration, all approved track/clip kinds, operations, asset boundary, API, persistence, timeline UI, Remotion synchronization, error behavior, security, and verification each have an owning task.
- Upload/acquisition, final rendering, filmstrips/waveforms, multi-select, keyframes, and deployment remain explicitly excluded.
- Simple/Advanced one-document semantics and Prompt Lab regression coverage are owned by Tasks 8 and 11.

### Type consistency

- `EditDocument` remains the generated discriminator union consumed by Python repositories and dashboard code.
- `EditDocumentOperation` remains the single patch union; reducer and server use the same generated payload shape.
- `EditorAsset` excludes server-only `artifact_location`; preview capability is a separate transient API response.
- Upgrade increments revision only inside repository persistence, not in the pure migration function.

### Scope check

D1 is a large but coherent vertical subsystem: each task produces a testable layer required by the same user outcome. Render queue/export and media ingestion remain separate future specifications. No independent renderer or acquisition subsystem is smuggled into this plan.

### Review-focus coverage

All five Review Focus lines name owning tasks and concrete tests. No placeholder, deferred implementation instruction, or undefined later-task interface remains.
