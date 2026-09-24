# Creator Studio F2 Responsive Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Use RED→GREEN tests and checkbox tracking.

**Goal:** Deliver one adaptive Creator Studio workspace for desktop, tablet, and phone, including tablet caption-text editing and phone light-edit/render-monitor surfaces.

**Architecture:** Keep `GuidedStudio` and its existing editor reducer as the only document state owner. A small viewport policy and compact navigation select which existing mounted regions are visible; neither a second preview nor a second edit document is created. Add one typed caption-cue text operation through the existing revision-bound patch path, then expose it in a focused tablet editor.

**Tech Stack:** React 19.2.7, TypeScript, Bun/Testing Library, Python/FastAPI/Pydantic, existing PostgreSQL editor revisions, OpenAPI-generated dashboard types.

**Spec:** `docs/superpowers/specs/2026-09-24-creator-studio-responsive-review-design.md`. Complete this plan before `2026-09-24-creator-studio-f2-editorial-review.md`; the latter adds comments and approval to the responsive shell.

## Global Constraints

- Preserve `GuidedStudio`'s document/reducer, autosave, conflict handling, and one `StudioPreview` instance. Do not edit the unrelated existing `StudioPreview.tsx` worktree change during preflight.
- Breakpoints: phone `<768`, tablet `768–1023`, compact desktop `1024–1439`, full desktop `>=1440` CSS pixels. Viewport changes never write a document or stored editor mode.
- Tablet supports Simple scenes, copy, caption text, Prompt Lab, preview, and render status; phone supports saved prompt text, heading/body, preview, and read-only render monitoring. Multi-track actions require desktop.
- Review comments/approval are **not** faked in this plan. The Review pane may display existing issues; the editorial-review plan adds the mutation contract.
- No new dependency, mobile-specific document format, offline queue, renderer configuration, live request, deployment, push, or F1 golden promotion.
- Repository artifacts and commit subjects are English. Keep the active F2 `progress.md` current and append completed implementation history to `CHANGELOG.md` only after verified work.

## Review Focus

1. Resizing from desktop Advanced with a dirty draft must preserve the mode, pending operations, and selection (Task 2 test).
2. Switching compact panes after typing an unsaved prompt must not remount/erase Prompt Lab (Task 2 test).
3. Navigating away during preview playback must pause the single player; returning must not autoplay (Task 2 test).
4. A missing, locked, or out-of-range caption cue must reject the operation without changing the saved revision (Task 3 tests).
5. Phone render monitoring must never expose create/retry/cancel/cleanup controls, including after job refresh (Task 5 test).

---

### Task 1: Viewport policy and compact navigation

**Files:**
- Create: `dashboard/src/features/studio/studio_viewport.ts`
- Create: `dashboard/src/features/studio/studio_viewport.test.ts`
- Create: `dashboard/src/features/studio/CompactStudioNav.tsx`
- Create: `dashboard/src/features/studio/CompactStudioNav.test.tsx`

**Interfaces:** `useStudioViewport(): StudioViewport`; `CompactStudioNav({ panes, selected, onSelect })` receives labeled pane IDs and emits a selection. Task 2 owns the pane state and decides which panes are available.

```ts
type StudioPane = "scenes" | "preview" | "edit" | "prompts" | "review" | "renders";
type CompactStudioNavProps = {
  panes: readonly { id: StudioPane; label: string }[];
  selected: StudioPane;
  onSelect: (pane: StudioPane) => void;
};
```

- [ ] Write RED viewport tests for widths `375`, `768`, `1024`, and `1440`, resize subscription cleanup, and a stable server snapshot. Write RED nav tests for selected state, keyboard activation, and focus-visible labeled controls. For example:

```ts
expect(studioViewportAt(767)).toBe("phone");
expect(studioViewportAt(768)).toBe("tablet");
expect(studioViewportAt(1024)).toBe("compact_desktop");
expect(studioViewportAt(1440)).toBe("full_desktop");
```

- [ ] Run `bun --cwd=dashboard test src/features/studio/studio_viewport.test.ts src/features/studio/CompactStudioNav.test.tsx`; verify the expected missing-export/module RED.
- [ ] Implement the width policy and use React's documented `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)` for the browser resize subscription. `subscribe` returns a cleanup function; `getSnapshot` returns a primitive enum, and the server snapshot is deterministic. Use semantic buttons with `aria-current` or tabs with coherent tab/panel IDs, not clickable `div` elements.

```ts
export type StudioViewport = "phone" | "tablet" | "compact_desktop" | "full_desktop";
export function studioViewportAt(width: number): StudioViewport {
  return width < 768 ? "phone" : width < 1024 ? "tablet" : width < 1440 ? "compact_desktop" : "full_desktop";
}
```

- [ ] Run the focused tests again; verify GREEN. Commit only this task's files with `git commit -m "feat: add Studio viewport navigation"`.

### Task 2: One responsive workstation with retained drafts

**Files:**
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Create: `dashboard/src/features/studio/GuidedStudio.responsive.test.tsx`
- Test: `dashboard/src/features/studio/GuidedStudio.test.tsx`

**Interfaces:** Consumes Task 1's viewport policy/nav. Exposes the existing `GuidedStudio` props unchanged. Compact pane IDs are `scenes`, `preview`, `edit`, `prompts`, `review`, `renders`; Task B will populate the Review pane with editorial records.

- [ ] Write RED integration tests using the existing GuidedStudio fixture: desktop Advanced → dirty edit → phone → desktop retains mode/operation/selection; Prompt Lab text survives pane switching; only one mocked `StudioPreview` is mounted; switching away from Preview/Review invokes `player.pause()`; review preview receives `base`, not `draft`. Assert the policy at 375/768/1024/1440 and desktop width controls absent on compact surfaces. Check actual overflow in the Task 5 browser pass, not happy-dom.

```tsx
fireEvent.click(screen.getByRole("button", { name: "Prompt Lab" }));
fireEvent.change(screen.getByLabelText("Project override"), { target: { value: "Local draft" } });
fireEvent.click(screen.getByRole("button", { name: "Preview" }));
fireEvent.click(screen.getByRole("button", { name: "Prompt Lab" }));
expect(screen.getByLabelText("Project override")).toHaveValue("Local draft");
```

- [ ] Run `bun --cwd=dashboard test src/features/studio/GuidedStudio.responsive.test.tsx` and record the behavioral RED, not only an import error.
- [ ] Add compact pane state in `GuidedStudio`, keep already visited Prompt Lab mounted while hidden, and use one preview region whose document is `base` in Review and `draft` otherwise. Pause the player when the preview region becomes hidden. Preserve the existing top-level Scenes/Prompt Lab desktop navigation. Use breakpoint-consistent CSS (`min-[1440px]` rather than Tailwind's different default `2xl`) and ensure hidden panels are not keyboard-focusable. At tablet width, derive an effective Simple presentation without dispatching `set_editor_mode`.

```ts
const previewDocument = selectedPane === "review" ? base : state.draft;
const effectiveMode = viewport === "phone" || viewport === "tablet" ? "simple" : state.mode;
```

- [ ] Run the new tests and existing GuidedStudio tests; verify GREEN and no regression. Commit this task with `git commit -m "feat: adapt Studio workstation to narrow screens"`.

### Task 3: Revision-bound caption-cue text operation

**Files:**
- Modify: `python/src/thoth_control_plane/domain/timeline_operations.py`
- Modify: `python/src/thoth_control_plane/domain/__init__.py` if its public operation exports require it
- Modify: `dashboard/src/features/studio/timeline_domain.ts`
- Test: `python/tests/domain/test_timeline_operations.py`
- Test: `python/tests/api/test_edit_documents.py`
- Test: `dashboard/src/features/studio/timeline_domain.test.ts`
- Generated: `python/openapi.json`, `dashboard/src/api/generated/control-plane.ts`

**Interfaces:** Add `set_caption_cue_text` with `operation_id`, `clip_id`, `cue_index >= 0`, and validated `text`. It remains part of existing `TimelineOperation`/`EditDocumentPatch`; no new API route or persistence table.

- [ ] Write RED domain/API/client tests: valid text changes only selected cue; wrong clip kind, missing clip, locked clip/track, negative or out-of-range index, blank/oversized text, and stale base revision fail without a new revision. Verify generated browser union accepts the new operation only after OpenAPI regeneration.

```python
operation = SetCaptionCueText(
    kind="set_caption_cue_text", operation_id="op_caption_1",
    clip_id="clip_caption_1", cue_index=0, text="Corrected caption",
)
assert result.clips[caption_index].cues[0].text == "Corrected caption"
```

- [ ] Run `uv run --project python pytest python/tests/domain/test_timeline_operations.py python/tests/api/test_edit_documents.py -q` and `bun --cwd=dashboard test src/features/studio/timeline_domain.test.ts`; record the expected RED.
- [ ] Implement `SetCaptionCueText` using the existing unlocked-clip/track gate and `CaptionCue` validation. Update the pure dashboard operation projection with the same input shape. Let the existing repository patch transaction enforce base revision and atomicity; do not add another save path.

```python
case SetCaptionCueText():
    clip = _unlocked_clip(document, operation.clip_id)
    if not isinstance(clip, TimelineCaptionClip) or operation.cue_index >= len(clip.cues):
        raise ValueError("caption cue unavailable")
    clip.cues[operation.cue_index].text = operation.text
```

- [ ] Export OpenAPI with `uv run --project python python/scripts/export_openapi.py`, then run `bun --cwd=dashboard generate:control-plane-types` twice and verify the second generation has no diff. Run focused Python/dashboard tests GREEN. Commit only operation, tests, and generated contracts with `git commit -m "feat: edit caption cue text through document patches"`.

### Task 4: Tablet caption editor and light phone edits

**Files:**
- Create: `dashboard/src/features/studio/CaptionTextInspector.tsx`
- Create: `dashboard/src/features/studio/CaptionTextInspector.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/PromptLab.tsx`
- Test: `dashboard/src/features/studio/GuidedStudio.responsive.test.tsx`
- Test: `dashboard/src/features/studio/PromptLab.test.tsx`

**Interfaces:** `CaptionTextInspector({ document, selectedSceneId, onOperation, disabled })` emits Task 3's `set_caption_cue_text` operation; Prompt Lab receives `compactTextOnly?: boolean` (default `false`).

```ts
type CaptionTextInspectorProps = {
  document: EditDocumentV2;
  selectedSceneId: string;
  onOperation: (operation: EditDocumentOperation) => void;
  disabled: boolean;
};
```

- [ ] Write RED tests: tablet lists caption clips overlapping the selected scene with clear clip/time labels; editing one cue emits its ID/index and does not change timing/style; locked cues are read-only with reason; phone exposes heading/body and saved prompt text but no caption edit, proposal Apply, lock admin, or provider controls. Test viewport switch after an unsaved prompt edit.

```tsx
fireEvent.change(screen.getByLabelText("Caption cue 1 text"), {
  target: { value: "New subtitle" },
});
expect(onOperation).toHaveBeenCalledWith(expect.objectContaining({
  kind: "set_caption_cue_text", clip_id: "clip_caption_1", cue_index: 0,
}));
```

- [ ] Run `bun --cwd=dashboard test src/features/studio/CaptionTextInspector.test.tsx src/features/studio/GuidedStudio.responsive.test.tsx src/features/studio/PromptLab.test.tsx`; record RED.
- [ ] Implement the caption inspector as a thin projection over the selected scene's frame interval and existing clip list. Dispatch through `commit_timeline_operation`; do not add local caption persistence. Add `compactTextOnly` presentation to Prompt Lab without changing its reducer or saved text API. Hide unsupported phone controls while keeping their draft-owning component mounted.
- [ ] Run focused tests GREEN. Commit with `git commit -m "feat: expose tablet captions and phone text edits"`.

### Task 5: Read-only phone render monitoring and integrated quality gate

**Files:**
- Modify: `dashboard/src/features/studio/RenderPanel.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Test: `dashboard/src/features/studio/RenderPanel.test.tsx`
- Test: `dashboard/src/features/studio/GuidedStudio.responsive.test.tsx`
- Modify: `CHANGELOG.md` after verification
- Modify: `.superpowers/sdd/2026-09-24-creator-studio-f2-responsive-review/progress.md` (ignored checkpoint)

**Interfaces:** Add `RenderPanel` prop `monitorOnly?: boolean` (default `false`). Existing render-state/polling and safe download methods remain shared; phone mode cannot invoke create/retry/cancel/cleanup.

- [ ] Write RED tests for pending/completed/failed jobs in phone mode. Assert status/progress/failure/download remain visible; no create, retry, cancel, or cleanup button can be found or invoked even after polling refresh. Test offline/capability-unavailable explanation and preview focus/keyboard behavior.

```tsx
expect(screen.queryByRole("button", { name: /start render|retry render|cancel render|cleanup/i })).toBeNull();
expect(screen.getByText("Rendering")).toBeDefined();
```

- [ ] Run focused RenderPanel/GuidedStudio tests and record RED. Implement `monitorOnly` as a presentation gate around existing mutations, not a second render client/state machine. Run focused tests GREEN.
- [ ] Run dashboard full tests, lint, build; Python non-live tests, Ruff check/format, OpenAPI regeneration stability, and `build_cuda.bat` via the mandatory Windows command. Inspect UI at 375 px, tablet portrait/landscape, 1024 px, 1440 px, keyboard-only, 200% zoom, and reduced-motion; record observed failures and fix them before claiming completion. Do not substitute unit tests for visual inspection.

```powershell
bun --cwd=dashboard test
bun --cwd=dashboard run lint
bun --cwd=dashboard run build
uv run --project python pytest -m "not live" -q
uv run --project python ruff check python/src python/tests
uv run --project python ruff format --check python/src python/tests
cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"
```

- [ ] Record exact gate results and remaining editorial-review dependency in the ignored F2 checkpoint and `CHANGELOG.md`. Commit task files plus `CHANGELOG.md` with one subject line, e.g. `git commit -m "feat: finish responsive Studio workspace"`. If the offline gates pass and no material blocker appears, continue directly to the editorial-review plan; defer the full product review until both plans are complete.
