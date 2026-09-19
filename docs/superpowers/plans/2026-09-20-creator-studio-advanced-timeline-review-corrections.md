# Creator Studio Advanced Timeline Review Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task. Use
> `superpowers:test-driven-development` for every product behavior change and
> `superpowers:verification-before-completion` before reporting completion.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the independent D1 review findings without expanding the approved operation union or starting D2.

**Architecture:** Keep `EditDocument` and the existing reducer canonical. Add explicit upgrade lifecycle semantics, connect the existing PlayerRef hook to Studio, merge paginated asset metadata, render persisted typed fields faithfully, and clarify the current single-owner bearer-capability boundary. Reuse existing React, Remotion, FastAPI, and domain helpers; add no dependency, service, migration, or document model.

**Tech Stack:** Python 3.12, Pydantic v2, FastAPI/Starlette, React 19, TypeScript, Bun, Remotion Player 4.0.523, pytest, Testing Library, Ruff, Oxlint, Vite.

**Spec:** `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-review-corrections-design.md`

## Global constraints

- Baseline `a2cafa672dcb11a88d73e4546a698577021ee10f` must remain an ancestor; do not rewrite D1 history.
- Work directly on `codex/stage1-container-ci` after a fail-closed drift inspection.
- Preserve the approved `EditDocumentOperation` union and migrations `0001` through `0004` byte-for-byte.
- Add no dependency, state library, timeline package, service worker, service, queue, or process.
- Use installed Remotion APIs only; do not add `@remotion/media`.
- Repository artifacts, code, comments, tests, and commit subjects remain English.
- Each commit has one short subject, no body, and no `Co-Authored-By` trailer.
- Keep the active SDD checkpoint current; write completed audit history to `CHANGELOG.md`, not `BLUEPRINT.md`.
- All work and verification are offline. Stop before push, deployment, live media/provider access, operational mutation, or D2.

## Review focus

- A clean upgrade request followed by an edit before its response must not lose or overwrite the edit; Task 1 owns the test and prevents editing while upgrade is in flight.
- A save response arriving after upgrade start or editor unmount must be ignored; Task 1 owns generation tests.
- A version 2 text edit must survive Simple → Advanced → Prompt Lab → Simple; Task 2 owns the integration test.
- Loading a second asset page must not make first-page assets unusable; Task 3 owns the pagination/add test.
- Selecting clip B after clip A must immediately show B's numeric values, and Player listeners from document A must not update document B; Tasks 2 and 3 own these tests.

---

### Task 1: Make upgrade and autosave lifecycle lossless

**Files:**

- Modify: `dashboard/src/features/studio/editor_state.ts`
- Modify: `dashboard/src/features/studio/editor_state.test.ts`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.final-fix.test.tsx`

**Interfaces:**

- `EditorState` gains explicit upgrade lifecycle state.
- `upgrade_started`, `upgrade_succeeded`, `upgrade_conflicted`, and `upgrade_failed` never share autosave acknowledgement semantics.
- A document-generation ref guards autosave and upgrade callbacks.
- Existing edit actions are no-ops while upgrade is in flight.

- [ ] **Step 1: Write reducer tests that reproduce silent draft loss.**

Add tests equivalent to:

```ts
test("upgrade success never acknowledges pending autosave operations", () => {
  const dirty = editHeading(createEditorState(documentV1()), "Local draft");
  const result = editorReducer(dirty, {
    type: "upgrade_succeeded",
    document: documentV2(),
  });
  expect(result.draft).toEqual(dirty.draft);
  expect(result.pendingOperations).toEqual(dirty.pendingOperations);
});

test("document edits are blocked while upgrade is running", () => {
  const upgrading = editorReducer(createEditorState(documentV1()), {
    type: "upgrade_started",
  });
  expect(editorReducer(upgrading, replaceHeadingAction("late edit"))).toEqual(upgrading);
});
```

Name the actual helpers after existing fixtures; do not duplicate document builders.

- [ ] **Step 2: Run the reducer tests and verify RED.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/editor_state.test.ts
Pop-Location
```

Expected: failures prove that upgrade currently reuses `save_succeeded` and does not own a mutation gate.

- [ ] **Step 3: Add component tests for dirty/offline/in-flight gating and stale callbacks.**

Cover all of the following:

- dirty, saving, conflict, and offline states disable upgrade with an accessible reason;
- clean double-click starts exactly one request;
- controls cannot dispatch a document edit while the request is pending;
- upgrade success adopts v2 only through `upgrade_succeeded`;
- a save response captured before upgrade start is ignored after generation changes;
- save and upgrade rejection after unmount dispatch nothing; and
- conflict/failure preserves the original local draft.

- [ ] **Step 4: Run component tests and verify RED for the new scenarios.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx
Pop-Location
```

- [ ] **Step 5: Implement the minimal dedicated lifecycle.**

Use a reducer-owned gate rather than conditionals scattered through controls:

```ts
type UpgradeStatus = "idle" | "running" | "failed";

type EditorAction =
  | { type: "upgrade_started" }
  | { type: "upgrade_succeeded"; document: EditDocumentV2 }
  | { type: "upgrade_conflicted"; latest: EditDocument }
  | { type: "upgrade_failed" }
  | ExistingEditorAction;
```

`upgrade_started` is accepted only from a saved, online, operation-free state.
While running, document mutation actions return the current state. Selection,
mode, playhead, and connectivity actions remain usable. `upgrade_succeeded`
adopts the returned document only when the lifecycle is still running.

Capture generation before each request:

```ts
const requestGeneration = generation.current;
void client.patchEditDocument(projectId, documentId, patch).then((result) => {
  if (requestGeneration !== generation.current) return;
  dispatch(toSaveAction(result, operationIds));
});
```

Increment generation immediately before starting upgrade and during unmount.
Apply the same comparison to `.catch()` and `.finally()` callbacks.

- [ ] **Step 6: Run GREEN and C1 save/conflict/offline regressions.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/editor_state.test.ts src/features/studio/editor_state.final-fix.test.ts src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx
Pop-Location
```

- [ ] **Step 7: Commit Task 1.**

```powershell
rtk git add dashboard/src/features/studio/editor_state.ts dashboard/src/features/studio/editor_state.test.ts dashboard/src/features/studio/GuidedStudio.tsx dashboard/src/features/studio/GuidedStudio.test.tsx dashboard/src/features/studio/GuidedStudio.final-fix.test.tsx
rtk git commit -m "fix: preserve drafts during timeline upgrade"
```

---

### Task 2: Connect Simple/Advanced mode and PlayerRef

**Files:**

- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`
- Modify: `dashboard/src/features/studio/SceneBoard.tsx`
- Modify: `dashboard/src/features/studio/Inspector.tsx`
- Modify: `dashboard/src/features/studio/Timeline.tsx`
- Modify: `dashboard/src/features/studio/Timeline.test.tsx`
- Modify: `dashboard/src/features/studio/TimelineToolbar.tsx`
- Modify: `dashboard/src/features/studio/StudioPreview.tsx`
- Modify: `dashboard/src/features/studio/StudioPreview.test.tsx`
- Modify: `dashboard/src/features/studio/usePlayerTimeline.ts`
- Modify: `dashboard/src/features/studio/usePlayerTimeline.test.tsx`
- Modify: `dashboard/src/features/studio/editor_state.ts`
- Modify: `dashboard/src/features/studio/editor_state.test.ts`

**Interfaces:**

- `SceneBoard` consumes the minimal scene/clip shape shared by both document versions.
- `Inspector` consumes a structural editable text clip shape shared by v1 and v2 text clips.
- `Timeline` receives `playing`, `onSeek`, `onPlay`, and `onPause`; it does not receive a Player instance.
- `usePlayerTimeline` remains the only module that calls PlayerRef methods or owns Player listeners.

- [ ] **Step 1: Write failing mode-projection tests.**

Prove that a version 2 document:

- exposes labelled Simple and Advanced controls;
- opens in Advanced after upgrade but may switch to Simple;
- renders Scene Board and the text Inspector in Simple;
- mutates the same reducer draft in both modes;
- preserves one unsaved text edit and one timeline edit across
  Simple → Advanced → Prompt Lab → Simple; and
- never writes a mode change to the server.

- [ ] **Step 2: Write failing integrated PlayerRef tests.**

Mount `GuidedStudio` with a fake PlayerRef and assert:

```ts
fakePlayer.emit("frameupdate", { detail: { frame: 42 } });
expect(screen.getByLabelText("Playhead")).toHaveValue("42");

fireEvent.change(screen.getByLabelText("Playhead"), { target: { value: "75" } });
expect(fakePlayer.seekTo).toHaveBeenCalledWith(75);

fireEvent.click(screen.getByRole("button", { name: "Play preview" }));
expect(fakePlayer.play).toHaveBeenCalledTimes(1);
```

Also prove pause state, listener removal on unmount/ref replacement, no duplicate
listeners after rerender, and no callback from the previous document.

- [ ] **Step 3: Run focused tests and verify RED.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/GuidedStudio.test.tsx src/features/studio/Timeline.test.tsx src/features/studio/StudioPreview.test.tsx src/features/studio/usePlayerTimeline.test.tsx
Pop-Location
```

- [ ] **Step 4: Widen the existing Simple projection without copying documents.**

Use structural types for scenes and editable text clips. In `GuidedStudio`,
select the scene's text clip from `state.draft` regardless of schema version.
Render Scene Board/Inspector when `state.mode === "simple"`; render
AssetLibrary/Timeline/TimelineInspector when it is `"advanced"`.

Keep the same callbacks (`edit_text`, `set_ownership`, `edit_duration`) so v2
Simple edits use the existing operation union.

- [ ] **Step 5: Wire one PlayerRef through the existing hook.**

Follow the current Remotion Player guidance already embodied in
`usePlayerTimeline`: attach listeners through `addEventListener`, read
`getCurrentFrame`, control with `seekTo`/`play`/`pause`, and remove each listener
with the same function reference.

Add only transient state:

```ts
const playerRef = useRef<PlayerTimelineRef | null>(null);
const player = usePlayerTimeline(
  playerRef,
  (frame) => dispatch({ type: "set_playhead", frame }),
  (playing) => dispatch({ type: "set_playing", playing }),
);
```

Pass `playerRef` to `StudioPreview`; pass callbacks, not the ref, to `Timeline`.
The playhead `onChange` dispatches locally and calls `player.seekTo(frame)`.

- [ ] **Step 6: Run GREEN plus Prompt Lab and preview regressions.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx src/features/studio/Timeline.test.tsx src/features/studio/StudioPreview.test.tsx src/features/studio/usePlayerTimeline.test.tsx src/features/studio/PromptLab.test.tsx src/features/studio/PromptProposalPanel.test.tsx
Pop-Location
```

Keep Scene Board assertions in `GuidedStudio.test.tsx`; do not create a one-use
test file solely for this correction.

- [ ] **Step 7: Commit Task 2.**

```powershell
rtk git add dashboard/src/features/studio
rtk git commit -m "fix: synchronize timeline editor projections"
```

---

### Task 3: Preserve asset pages and Inspector selection

**Files:**

- Modify: `dashboard/src/features/studio/AssetLibrary.tsx`
- Modify: `dashboard/src/features/studio/AssetLibrary.test.tsx`
- Modify: `dashboard/src/features/studio/editor_state.ts`
- Modify: `dashboard/src/features/studio/editor_state.test.ts`
- Modify: `dashboard/src/features/studio/timeline_domain.ts`
- Modify: `dashboard/src/features/studio/timeline_domain.test.ts`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`
- Modify: `dashboard/src/features/studio/TimelineInspector.tsx`
- Modify: `dashboard/src/features/studio/TimelineInspector.test.tsx`

**Interfaces:**

- `assets_loaded({ assets, replace })` replaces only on a first-page reload and otherwise merges by `asset_id`.
- `createAddClipFromAssetOperation(document, asset, playhead, ids)` owns compatibility and duration defaults.
- Inspector inputs are controlled by the current selection.

- [ ] **Step 1: Write a failing two-page asset integration test.**

Return asset A on page one and asset B on page two. Load both pages, then click
Add for asset A. Assert one `add_clip_from_asset` pending operation names asset A
and a compatible track. This test must fail against the current reducer
replacement behavior.

- [ ] **Step 2: Write failing helper tests before moving operation construction.**

Test the pure helper with video, image, and audio assets; no compatible track;
locked tracks; explicit playhead; asset duration present; and image duration
fallback to one canvas second. Supply deterministic IDs:

```ts
const operation = createAddClipFromAssetOperation(document, asset, 45, {
  operationId: "op_asset",
  clipId: "clip_asset",
});
expect(operation).toMatchObject({
  kind: "add_clip_from_asset",
  asset_id: asset.asset_id,
  from_frame: 45,
});
```

- [ ] **Step 3: Write failing selection-change tests for Inspector.**

Render clip A, rerender with clip B without unmounting, and assert start, end,
volume, and all read-only typed fields display B. Change one editable value and
assert the emitted operation names B, not A.

- [ ] **Step 4: Run the focused tests and verify RED.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/AssetLibrary.test.tsx src/features/studio/editor_state.test.ts src/features/studio/timeline_domain.test.ts src/features/studio/TimelineInspector.test.tsx src/features/studio/GuidedStudio.test.tsx
Pop-Location
```

- [ ] **Step 5: Implement merge semantics and the domain helper.**

Merge without another collection abstraction:

```ts
const merged = replace
  ? Object.fromEntries(assets.map((asset) => [asset.asset_id, asset]))
  : { ...state.assets, ...Object.fromEntries(assets.map((asset) => [asset.asset_id, asset])) };
```

`AssetLibrary` sends `replace: !from`. Its visible list and reducer receive the
same deduplicated cumulative values. Move only operation construction into
`timeline_domain.ts`; keep dispatch and UUID generation at the UI boundary.

- [ ] **Step 6: Make Inspector values selection-correct and typed fields explicit.**

Replace selection-derived `defaultValue` props with controlled values. Display
fit/crop/position, overlay preset/parameters, caption style/cues, and fade values
using plain text or disabled labelled native controls. Emit no unapproved
operation kind.

- [ ] **Step 7: Run GREEN and all timeline-domain/component tests.**

```powershell
Push-Location dashboard
rtk bun test src/features/studio/AssetLibrary.test.tsx src/features/studio/editor_state.test.ts src/features/studio/timeline_domain.test.ts src/features/studio/TimelineInspector.test.tsx src/features/studio/Timeline.test.tsx src/features/studio/GuidedStudio.test.tsx
Pop-Location
```

- [ ] **Step 8: Commit Task 3.**

```powershell
rtk git add dashboard/src/features/studio
rtk git commit -m "fix: retain timeline assets and inspector state"
```

---

### Task 4: Align preview semantics and capability truth

**Files:**

- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.tsx`
- Modify: `dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx`
- Modify: `python/src/thoth_control_plane/infrastructure/editor_preview.py`
- Modify: `python/src/thoth_control_plane/api/routes/editor_assets.py`
- Modify: `python/tests/infrastructure/test_editor_preview.py`
- Modify: `python/tests/api/test_editor_assets.py`
- Modify only if generated contract changes: `python/openapi.json`
- Modify only if generated contract changes: `dashboard/src/api/generated/control-plane.ts`

**Interfaces:**

- Composition renders existing typed fields without introducing mutation APIs.
- Preview cookie remains the sole media-request bearer capability.
- Signer verifies signature, expiry, project, and asset; it carries no unused actor claim.

- [ ] **Step 1: Write failing composition fidelity tests.**

Use trusted fixtures to prove:

- `fit`, crop, scale, and position alter video/image presentation;
- overlay text/accent parameters reach only the registered preset;
- caption style selects a trusted local style and cue timing stays relative;
- fade-in and fade-out produce bounded volume values at start, middle, and end;
- track mute forces zero volume; and
- raw style strings, URLs, or executable content are never accepted.

Use installed `remotion` primitives and a `volume(frame)` callback. Do not add a
package to make these tests pass.

- [ ] **Step 2: Write failing capability-contract tests.**

Prove that:

- minting still requires `current_actor`;
- the token payload no longer stores an unenforced actor field;
- preview accepts only a valid exact project/asset cookie;
- wrong project, wrong asset, tampering, expiry, missing cookie, and path
  traversal fail with safe errors;
- capability values never appear in JSON, URLs, error bodies, or captured logs;
  and
- cookie flags remain HttpOnly, SameSite=Strict, and exact-path scoped.

- [ ] **Step 3: Run focused tests and verify RED.**

```powershell
rtk uv run --project python pytest python/tests/infrastructure/test_editor_preview.py python/tests/api/test_editor_assets.py -q
Push-Location dashboard
rtk bun test src/features/studio/AdvancedTimelineComposition.test.tsx src/features/studio/StudioPreview.test.tsx src/features/studio/preview.test.ts
Pop-Location
```

- [ ] **Step 4: Implement the smallest faithful projection.**

Use CSS properties for object fit, crop wrapper geometry, transform/position,
and trusted caption/overlay registries. Compose audio fade with stored volume:

```ts
const volumeAt = (frame: number) =>
  muted ? 0 : clip.volume * fadeMultiplier(frame, clip.duration_in_frames,
    clip.fade_in_frames, clip.fade_out_frames);
```

Clamp the multiplier to `[0, 1]` and cover zero-length fades. Keep preview
sources separate from the persisted document.

- [ ] **Step 5: Remove the misleading actor claim, not the security boundary.**

Keep capability issuance behind `current_actor`, but sign only version, project,
asset, issued-at, and expiry. Remove the optional `actor_id` verification branch
and update route calls/tests. Do not expose the global API key to `<Video>` or
`<Audio>`, create a second cookie, add a service worker, or put a token in a URL.

- [ ] **Step 6: Run GREEN and regenerate contracts only if the public schema changed.**

```powershell
rtk uv run --project python pytest python/tests/infrastructure/test_editor_preview.py python/tests/api/test_editor_assets.py python/tests/api/test_openapi_contract.py -q
Push-Location dashboard
rtk bun test src/features/studio/AdvancedTimelineComposition.test.tsx src/features/studio/StudioPreview.test.tsx src/features/studio/preview.test.ts
Pop-Location
```

If OpenAPI changed:

```powershell
rtk uv run --project python python python/scripts/export_openapi.py
Push-Location dashboard
rtk bun run generate:control-plane-types
Pop-Location
rtk git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts
```

The second generation run must be byte-identical.

- [ ] **Step 7: Commit Task 4.**

```powershell
rtk git add dashboard/src/features/studio/AdvancedTimelineComposition.tsx dashboard/src/features/studio/AdvancedTimelineComposition.test.tsx python/src/thoth_control_plane/infrastructure/editor_preview.py python/src/thoth_control_plane/api/routes/editor_assets.py python/tests/infrastructure/test_editor_preview.py python/tests/api/test_editor_assets.py python/openapi.json dashboard/src/api/generated/control-plane.ts
rtk git commit -m "fix: align timeline preview contracts"
```

Do not stage generated files when they are unchanged.

---

### Task 5: Run full offline verification and record the corrective audit

**Files:**

- Modify: `CHANGELOG.md`
- Modify (gitignored): `.superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md`

**Interfaces:**

- Produces fresh evidence after the final product edit.
- Records the original review rejection and corrective truth without rewriting history.

- [ ] **Step 1: Run Python dependency, non-live, formatting, and deployment gates.**

```powershell
rtk uv sync --project python --frozen --all-groups --extra acquisition
rtk uv run --project python pytest -m "not live" -q
rtk uv run --project python pytest python/tests/deployment -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
```

- [ ] **Step 2: Prove generated contracts stable.**

```powershell
rtk uv run --project python python python/scripts/export_openapi.py
Push-Location dashboard
rtk bun run generate:control-plane-types
Pop-Location
rtk git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts
```

- [ ] **Step 3: Run the dashboard suite three consecutive times, then static gates.**

```powershell
Push-Location dashboard
rtk bun test
rtk bun test
rtk bun test
rtk bun run lint
rtk bun run build
Pop-Location
```

Report every warning and whether it predates the corrective baseline.

- [ ] **Step 4: Run Rust, Scout, Compose, and repository checks.**

```powershell
cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
Write-Output "EXIT=$LASTEXITCODE"
Push-Location scout
rtk bun install --frozen-lockfile
rtk bun run test:acquisition
rtk bun run test:runtime
Pop-Location
docker compose -f compose.stage1.local.yml --env-file .env.stage1.local.example config --quiet
rtk git diff --check
```

Inspect `build_log.txt`, require exit `0`, record warnings, then remove only that
task-created file. If native Docker is unavailable, use WSL only for the
read-only Compose config command and report the substitution.

- [ ] **Step 5: Inspect security and scope.**

```powershell
rtk rg -n "artifact_location|preview_capability|signing_key|THOTH_EDITOR_PREVIEW_SIGNING_KEY" python/openapi.json dashboard/src/api/generated/control-plane.ts dashboard/src
rtk rg -n "dangerouslySetInnerHTML|eval\(|new Function|file://|\.\./" dashboard/src/features/studio python/src/thoth_control_plane/api/routes/editor_assets.py python/src/thoth_control_plane/infrastructure/editor_preview.py
rtk git diff --name-status a2cafa6...HEAD
rtk git log --format=fuller a2cafa6..HEAD
```

Require no new dependency, migration, service, operation kind, executable input,
locator exposure, secret exposure, body/trailer commit, or rewritten D1 commit.

- [ ] **Step 6: Update indexes and the audit trail.**

```powershell
rtk graphify update .
```

Keep `graphify-out/`, `.serena/`, and generated codegraph data ignored and
unstaged. Update the checkpoint and `CHANGELOG.md` with:

- baseline/final SHAs and corrective commits;
- every review finding and its closing RED-to-GREEN test;
- fresh gate counts and warnings;
- the narrowed single-owner capability contract;
- the historical Task 8/Task 9 deviations; and
- all remaining operational hard stops.

- [ ] **Step 7: Commit documentation and stop.**

```powershell
rtk git add CHANGELOG.md
rtk git commit -m "docs: record timeline review corrections"
rtk git status --short --branch
rtk git diff --check
```

Expected: tracked worktree clean; the gitignored checkpoint may be modified.
Do not push.

## Plan self-review

### Spec coverage

- AC1–AC3 are owned by Task 1.
- AC4–AC5 are owned by Task 2.
- AC6–AC7 are owned by Task 3.
- AC8–AC9 are owned by Task 4.
- AC10–AC12 and historical audit accuracy are owned by Task 5.
- No task adds the operation kinds that the parent plan accidentally assumed.

### Placeholder scan

The plan defines every implementation step and helper it references. Optional
generated-file edits are conditioned on an observable schema diff.

### Type consistency

- The canonical model remains generated `EditDocument`.
- `EditDocumentOperation` remains unchanged.
- PlayerRef stays behind `usePlayerTimeline`.
- Asset merge state remains `Record<string, EditorAsset>`.
- Simple mode consumes structural v1/v2-compatible scene and text clip shapes.

### Scope check

The five tasks independently produce reviewable behavior. The correction adds
no D2 feature, new infrastructure, or live proof. Final execution stops at
independent Codex re-review before any push decision.
