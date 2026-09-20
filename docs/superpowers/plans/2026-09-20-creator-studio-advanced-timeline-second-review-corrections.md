# Creator Studio Advanced Timeline Second Review Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven second-review gaps without widening D1 or changing its persisted contracts.

**Architecture:** Keep `EditDocument` and `editorReducer` canonical. Preserve session-only state when a saved revision is adopted, make upgrade busy state explicit in existing controls, deduplicate asset pages at their local boundary, select installed Remotion primitives from trusted asset metadata, and bind Player listeners to the committed instance.

**Tech Stack:** React 19, TypeScript, Bun, Remotion Player 4.0.523, Python 3.12, Pydantic v2, pytest, Testing Library, Ruff, Oxlint, Vite.

**Spec:** `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-second-review-corrections-design.md`

## Global Constraints

- Product baseline `c10507492fd2e57040500e91f99084bc2c91ecdf` remains an ancestor; do not rewrite existing D1 history.
- Work directly on `codex/stage1-container-ci` after fail-closed drift inspection.
- Preserve operator commit `9ed8fa9` and all current local commits.
- Keep `EditDocumentOperation`, migrations `0001` through `0004`, OpenAPI, and generated TypeScript byte-identical unless a genuine existing-contract mismatch is proven.
- Add no dependency, service, worker, queue, state library, media package, API route, operation kind, or D2 behavior.
- Use installed Remotion APIs only. Query current Remotion documentation through Context7 before changing Player or media primitives.
- Apply strict RED-to-GREEN TDD for every product change.
- Keep commits as one concise subject line with no body, trailer, or AI attribution.
- Keep repository artifacts in English and operator reports in Indonesian.
- Verification is offline only; all operational and live gates remain closed.

## Review Focus

- A save that acknowledges the final pending operation while Simple mode is active must not switch modes or erase loaded assets.
- An asset returned on both page one and page two must render once and remain addable after another asset saves.
- A version 1 upgrade request must visibly disable every document-mutating control until it settles.
- A valid image asset and valid normalized negative/positive offsets must render without relying on URL inference or invalid fixtures.
- A Player replaced during the React commit lifecycle must detach the old listeners before the new instance can emit events.

---

### Task 1: Preserve editor-session state across autosave

**Files:**
- Modify: `dashboard/src/features/studio/editor_state.ts`
- Modify: `dashboard/src/features/studio/editor_state.test.ts`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`

**Interfaces:**
- Consumes: `EditorState`, `save_succeeded`, `createEditorState(document, assets)`.
- Produces: save acknowledgement that adopts the returned revision while preserving valid session-only state and the asset cache.

- [ ] **Step 1: Write reducer tests that reproduce the reset.**

Add tests equivalent to:

```ts
test("save success preserves version 2 session state and loaded assets", () => {
  const asset = readyVideoAsset();
  let state = createEditorState(timelineDocument(), {[asset.asset_id]: asset});
  state = editorReducer(state, {type: "set_editor_mode", mode: "simple"});
  state = editorReducer(state, {type: "select_clip", clipId: "clip_music"});
  state = editorReducer(state, {type: "set_playhead", frame: 77});

  const saved = editorReducer(state, {
    type: "save_succeeded",
    document: {...timelineDocument(), revision: 5},
  });

  expect(saved.mode).toBe("simple");
  expect(saved.selectedClipId).toBe("clip_music");
  expect(saved.playheadFrame).toBe(77);
  expect(saved.assets).toEqual({[asset.asset_id]: asset});
});
```

Also cover invalid selections falling back safely when the returned document no
longer contains the selected identity.

- [ ] **Step 2: Run the focused reducer test and verify RED.**

```powershell
Push-Location dashboard
bun test src/features/studio/editor_state.test.ts
Pop-Location
```

Expected: the new test reports mode, selection/playhead, or assets reset.

- [ ] **Step 3: Implement the smallest save-state adoption.**

Keep the existing acknowledgement and remaining-operation rules. In the
zero-remaining branch, initialize the returned document with `state.assets`,
then copy only still-valid session fields from the previous state. Clamp the
playhead to the returned canvas and keep version 1 in Simple mode. Do not alter
history semantics in this correction.

- [ ] **Step 4: Add a Studio integration regression.**

Open a version 2 document, switch to Simple, edit text, complete autosave, and
assert that Simple mode remains selected. Load two ready assets, complete one
asset edit/save, then assert another still-rendered asset produces an
`add_clip_from_asset` patch rather than a silent no-op.

- [ ] **Step 5: Run focused GREEN tests.**

```powershell
Push-Location dashboard
bun test src/features/studio/editor_state.test.ts src/features/studio/GuidedStudio.test.tsx
Pop-Location
```

- [ ] **Step 6: Commit Task 1.**

```powershell
git add dashboard/src/features/studio/editor_state.ts dashboard/src/features/studio/editor_state.test.ts dashboard/src/features/studio/GuidedStudio.test.tsx
git commit -m "fix: preserve timeline session after save"
```

---

### Task 2: Expose a truthful upgrade busy state

**Files:**
- Modify: `dashboard/src/features/studio/editor_state.ts`
- Modify: `dashboard/src/features/studio/editor_state.test.ts`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.final-fix.test.tsx`
- Modify: `dashboard/src/features/studio/Inspector.tsx`

**Interfaces:**
- Consumes: `canStartUpgrade(state)`, `upgradeStatus`.
- Produces: version-1-only upgrade eligibility and `Inspector` mutation controls with a `disabled` contract.

- [ ] **Step 1: Write failing reducer eligibility tests.**

Assert that `canStartUpgrade()` is false for a version 2 draft and for a state
with `preview` present, while retaining all existing dirty/offline/conflict and
in-flight cases.

- [ ] **Step 2: Write a failing accessibility integration test.**

Start a deferred upgrade request and assert:

```ts
expect(screen.getByLabelText("Heading")).toBeDisabled();
expect(screen.getByRole("button", {name: "Undo"})).toBeDisabled();
```

Resolve or reject the request and assert that the mutation controls become
enabled again when the version 1 editor remains active.

- [ ] **Step 3: Run the tests and verify RED.**

```powershell
Push-Location dashboard
bun test src/features/studio/editor_state.test.ts src/features/studio/GuidedStudio.final-fix.test.tsx
Pop-Location
```

- [ ] **Step 4: Implement the minimal busy-state propagation.**

Require a version 1 draft and no active preview in `canStartUpgrade`. Add one
`disabled?: boolean` prop to `Inspector` and apply it to its document-mutating
input, textarea, select, and duration input. In `GuidedStudio`, pass
`state.upgradeStatus === "running"` and include that condition in undo/redo
disabled expressions. Keep Scene Board selection and workspace navigation
usable.

- [ ] **Step 5: Run focused GREEN and v1 regression tests.**

```powershell
Push-Location dashboard
bun test src/features/studio/editor_state.test.ts src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx
Pop-Location
```

- [ ] **Step 6: Commit Task 2.**

```powershell
git add dashboard/src/features/studio/editor_state.ts dashboard/src/features/studio/editor_state.test.ts dashboard/src/features/studio/GuidedStudio.tsx dashboard/src/features/studio/GuidedStudio.final-fix.test.tsx dashboard/src/features/studio/Inspector.tsx
git commit -m "fix: expose timeline upgrade busy state"
```

---

### Task 3: Deduplicate assets and preview images correctly

**Files:**
- Modify: `dashboard/src/features/studio/AssetLibrary.tsx`
- Modify: `dashboard/src/features/studio/AssetLibrary.test.tsx`
- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.tsx`
- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx`
- Modify: `dashboard/src/features/studio/timeline-test-fixtures.ts`

**Interfaces:**
- Consumes: `EditorAssetPage`, `EditDocumentV2.asset_refs`, transient `PreviewSources`.
- Produces: one visible asset row per `asset_id` and trusted `Img`/`Video` selection from asset metadata.

- [ ] **Step 1: Write a failing overlapping-page test.**

Return assets A and B on page one, then B and C on page two. Assert the visible
rows are exactly A, B, C in that order, B appears once, and each Add action
emits the corresponding asset once.

- [ ] **Step 2: Run the Asset Library test and verify RED.**

```powershell
Push-Location dashboard
bun test src/features/studio/AssetLibrary.test.tsx
Pop-Location
```

- [ ] **Step 3: Implement keyed continuation merging.**

For a first page, replace local rows. For continuation pages, merge by
`asset_id`, preserve first-seen order, and replace an existing entry with the
new safe projection. Reuse `Map`; do not add a pagination abstraction.

- [ ] **Step 4: Write failing image-versus-video composition tests.**

Add one valid `asset_ref.kind = "image"` visual clip and one
`asset_ref.kind = "video"` visual clip. With safe preview sources, assert the
image source renders through Remotion `Img`, the video source through `Video`,
and a missing/mismatched reference renders `preview-unavailable`.

- [ ] **Step 5: Run composition tests and verify RED.**

```powershell
Push-Location dashboard
bun test src/features/studio/AdvancedTimelineComposition.test.tsx
Pop-Location
```

- [ ] **Step 6: Implement trusted primitive selection.**

Import `Img` from the already-installed `remotion` package. Resolve media kind
only from `document.asset_refs`; never inspect a URL suffix or MIME guess. Share
the current safe layout style between `Img` and `Video`, and keep
`source_from_frame` video-only.

- [ ] **Step 7: Run focused GREEN tests.**

```powershell
Push-Location dashboard
bun test src/features/studio/AssetLibrary.test.tsx src/features/studio/AdvancedTimelineComposition.test.tsx src/features/studio/GuidedStudio.test.tsx
Pop-Location
```

- [ ] **Step 8: Commit Task 3.**

```powershell
git add dashboard/src/features/studio/AssetLibrary.tsx dashboard/src/features/studio/AssetLibrary.test.tsx dashboard/src/features/studio/AdvancedTimelineComposition.tsx dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx dashboard/src/features/studio/timeline-test-fixtures.ts
git commit -m "fix: align timeline asset previews"
```

---

### Task 4: Project valid normalized positions

**Files:**
- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.tsx`
- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx`
- Modify: `dashboard/src/features/studio/timeline-test-fixtures.ts`

**Interfaces:**
- Consumes: domain-valid `Position {x: number; y: number; scale: number}`.
- Produces: percentage translation where `x/y` are signed canvas fractions.

- [ ] **Step 1: Replace the invalid fixture and make the expected semantics RED.**

Use a valid fixture such as:

```ts
position: {x: 0.25, y: -0.5, scale: 1.5}
```

Assert the visual frame uses:

```ts
expect(frame.style.transform).toBe("translate(25%, -50%) scale(1.5)");
```

Also cover zero and boundary values `-1` and `1` without introducing invalid
runtime-only TypeScript fixtures.

- [ ] **Step 2: Run the test and verify RED against pixel translation.**

```powershell
Push-Location dashboard
bun test src/features/studio/AdvancedTimelineComposition.test.tsx
Pop-Location
```

- [ ] **Step 3: Implement percentage projection.**

Convert each normalized offset to a bounded percentage string and retain the
validated scale. Do not duplicate Python validation in the composition; inputs
already cross the validated document boundary.

- [ ] **Step 4: Run focused GREEN and Python model tests.**

```powershell
Push-Location dashboard
bun test src/features/studio/AdvancedTimelineComposition.test.tsx
Pop-Location
uv run --project python pytest python/tests/domain/test_edit_document_v2.py -q
```

- [ ] **Step 5: Commit Task 4.**

```powershell
git add dashboard/src/features/studio/AdvancedTimelineComposition.tsx dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx dashboard/src/features/studio/timeline-test-fixtures.ts
git commit -m "fix: project normalized timeline positions"
```

---

### Task 5: Bind timeline listeners to the committed Player

**Files:**
- Modify: `dashboard/src/features/studio/usePlayerTimeline.ts`
- Modify: `dashboard/src/features/studio/usePlayerTimeline.test.tsx`
- Modify: `dashboard/src/features/studio/StudioPreview.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`

**Interfaces:**
- Consumes: committed `PlayerTimelineRef | null`, current frame/playing callbacks.
- Produces: callback-ref or state-backed attachment whose effect depends on the actual Player instance; commands target that same current instance.

- [ ] **Step 1: Confirm the installed Remotion PlayerRef contract.**

Use Context7 for Remotion 4 PlayerRef event/listener lifecycle and inspect the
installed `@remotion/player` types for `frameupdate`, `seeked`, `play`, and
`pause`. Record no library text or dependency in the repository.

- [ ] **Step 2: Write a commit-lifecycle replacement test.**

Render a child that assigns its fake Player through a callback ref during
commit. Replace child A with child B, then assert:

- A received one listener per event and all were removed;
- B received one listener per event;
- events from A no longer update frame/playback;
- events from B do update them; and
- unmount removes B's listeners.

Do not assign `.current` from the test component render body.

- [ ] **Step 3: Run the hook test and verify RED.**

```powershell
Push-Location dashboard
bun test src/features/studio/usePlayerTimeline.test.tsx
Pop-Location
```

- [ ] **Step 4: Implement committed-instance ownership.**

Prefer the minimal React-native seam: keep the committed Player instance in
state through a callback ref, pass the instance into `usePlayerTimeline`, and
make the effect depend on that instance. Preserve latest callbacks through the
existing handler ref. Ensure seek/play/pause call the committed instance and
become no-ops when absent.

- [ ] **Step 5: Run focused GREEN integration tests.**

```powershell
Push-Location dashboard
bun test src/features/studio/usePlayerTimeline.test.tsx src/features/studio/StudioPreview.test.tsx src/features/studio/GuidedStudio.test.tsx
Pop-Location
```

- [ ] **Step 6: Commit Task 5.**

```powershell
git add dashboard/src/features/studio/usePlayerTimeline.ts dashboard/src/features/studio/usePlayerTimeline.test.tsx dashboard/src/features/studio/StudioPreview.tsx dashboard/src/features/studio/GuidedStudio.tsx dashboard/src/features/studio/GuidedStudio.test.tsx
git commit -m "fix: rebind timeline player listeners"
```

---

### Task 6: Run full offline verification and record the correction

**Files:**
- Modify: `CHANGELOG.md`
- Modify (gitignored): `.superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md`

**Interfaces:**
- Produces: fresh evidence after the final product edit and a truthful append-only audit record.

- [ ] **Step 1: Run Python dependency and non-live gates.**

```powershell
uv sync --project python --frozen --all-groups --extra acquisition
uv run --project python pytest -m "not live" -q
uv run --project python pytest python/tests/deployment -q
uv run --project python ruff check python/src python/tests
uv run --project python ruff format --check python/src python/tests
```

- [ ] **Step 2: Regenerate contracts twice and prove byte stability.**

```powershell
uv run --project python python python/scripts/export_openapi.py
Push-Location dashboard
bun run generate:control-plane-types
Pop-Location
git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts
```

Repeat export and generation once more and require the same zero diff. Any
generated change is a hard stop because this correction authorizes no public
contract change.

- [ ] **Step 3: Run dashboard gates three consecutive times.**

```powershell
Push-Location dashboard
bun test
bun test
bun test
bun run lint
bun run build
Pop-Location
```

Report every warning and whether it predates the product baseline.

- [ ] **Step 4: Run the mandatory CUDA build and Rust tests.**

```powershell
cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
Write-Output "EXIT=$LASTEXITCODE"
cargo test --bin thoth
```

Inspect the fresh log, require exit 0 and no critical warning, then remove only
the task-created `build_log.txt`.

- [ ] **Step 5: Run Scout and Compose offline gates.**

```powershell
Push-Location scout
bun install --frozen-lockfile
bun run test:acquisition
bun run test:runtime
Pop-Location
docker compose -f compose.stage1.local.yml --env-file .env.stage1.local.example config --quiet
```

Use WSL only for the read-only Compose config command if native Docker is
unavailable. Do not start services.

- [ ] **Step 6: Inspect contract and scope drift.**

```powershell
git diff --name-status c10507492fd2e57040500e91f99084bc2c91ecdf..HEAD
git diff --check
git diff --exit-code c10507492fd2e57040500e91f99084bc2c91ecdf..HEAD -- python/src/thoth_control_plane/domain python/src/thoth_control_plane/migrations python/openapi.json dashboard/src/api/generated/control-plane.ts Cargo.toml Cargo.lock scout/package.json scout/bun.lock
```

Confirm no dependency, migration, operation union, public contract, Rust, or
Scout product file changed. Account separately for the operator-owned
`9ed8fa9` documentation commit already in history.

- [ ] **Step 7: Refresh code intelligence and audit records.**

```powershell
graphify update .
```

Keep generated indexes ignored. Update the active `progress.md` and append a
`CHANGELOG.md` entry with the product baseline, task commits, RED-to-GREEN
evidence, actual gate counts, the invalid-position-fixture correction, known
limitations, and hard stops.

- [ ] **Step 8: Commit the audit record.**

```powershell
git add CHANGELOG.md
git commit -m "docs: record timeline second review corrections"
git status --short --branch
```

Expected: tracked worktree clean; ignored checkpoint updated; no operator-owned
file staged.

- [ ] **Step 9: Stop and report.**

The final report must include baseline/final SHA, branch/upstream/ahead-behind,
per-task commits, RED-to-GREEN evidence, exact gate results, diff/security
inspection, limitations, preserved operator state, and confirmation that no
push, deployment, live request, evidence mutation, or D2 work occurred. Return
to Codex for independent review before any push.

## Plan self-review

- **Spec coverage:** Tasks 1-5 map one-to-one to AC13-AC20; Task 6 owns AC21.
- **Placeholder scan:** No deferred implementation, undefined helper, or later-task placeholder remains.
- **Type consistency:** Player attachment uses one committed `PlayerTimelineRef`; asset identity remains `asset_id`; document and operation unions remain generated contracts.
- **Review focus:** Each of the five listed failure classes has an explicit RED test in its owning task.
