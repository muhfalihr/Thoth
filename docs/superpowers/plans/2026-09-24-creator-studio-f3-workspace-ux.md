# Creator Studio F3 Workspace UX Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for native task-by-task execution, or `superpowers:subagent-driven-development` only if the operator selects that method. Mark the checkboxes as work completes.

**Goal:** Turn the existing Studio into the approved dark, preview-centered four-job workspace without changing its document, prompt, review, or render contracts.

**Architecture:** `GuidedStudio` keeps the existing editor reducer and the single `StudioPreview`. A presentation-only job selection organizes Edit, Prompt, Review, and Render; compact Edit panes remain a second, local navigation level. Scene and inspector components gain creator-facing labels, while scoped Studio CSS changes no other dashboard surface.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS, Bun tests, existing control-plane client and Remotion preview.

**Spec:** `docs/superpowers/specs/2026-09-24-creator-studio-f3-ux-first-migration-design.md`; visual reference: `docs/superpowers/specs/2026-09-24-creator-studio-f3-selected-direction.png`.

## Scope boundary

Simple scene reordering is deferred to the first-mode migration plan: the current editor offers selection but no persisted reorder operation. Plan A must not show a reorder control or claim the spec's scene-reorder acceptance criterion is met.

This is **Plan A of F3**. It delivers the workspace UX and honest presentation of capabilities already present. It does not change Content Set import, media registration, EditDocument schema, APIs, renderer, or legacy render behavior; those require a separate first-mode migration plan. Do not claim F3 migration complete from Plan A. Do not display the mockup's media, style, Add scene, or Preview changes controls unless they perform real existing operations.

## Global constraints

- Preflight on `codex/stage1-container-ci`: confirm `865741c` is an ancestor, inspect `HEAD`, upstream, staged/unstaged/untracked files, and stop on overlapping product-code drift.
- Read `AGENTS.md`, the active F3 checkpoint, the parent and F2 designs, the approved F3 design, and this plan in that order. Record preflight `HEAD` as the execution baseline before editing.
- Preserve the operator-owned `dashboard/src/features/studio/StudioPreview.tsx` exactly, including its pre-existing modified/empty-diff status. Do not stage, rewrite, reset, or normalize it.
- Keep one mounted `StudioPreview`, one EditDocument, existing autosave/conflict behavior, Prompt Lab drafts, saved-revision Review semantics, and saved-revision Render semantics.
- Preserve F2 viewport capabilities: desktop Simple/Advanced; tablet permitted Simple editing/review; phone preview, light text editing/review, read-only render monitoring.
- No new dependency, second player, fake UI control, provider request, live asset, deployment, push, F1 golden promotion, legacy cutover, or Python Scout migration.
- Repository artifacts and commits are English; operator report is Indonesian. Commit each task with one subject line, no body or attribution. Update the ignored F3 checkpoint and append the completed-work record to `CHANGELOG.md` at the final gate.

## Review focus

1. A pending heading or Prompt Lab draft survives Edit → Prompt → Review → Edit and viewport changes (Task 2 tests).
2. Review displays the saved revision while Edit returns to the local draft, without a second player mount (Task 2 tests).
3. An unavailable review/render client remains an explained destination; phone Render remains monitor-only (Task 2 tests).
4. Human-readable duration neither mutates untouched frames nor drifts when 151 frames at 30 fps is explicitly committed (Task 3 tests).
5. Keyboard focus, hidden panes, 200% zoom, and reduced motion remain usable across the dark desktop and compact layouts (Task 4 browser check).

## File responsibilities

- `studio_viewport.ts`: job/edit-pane types and existing viewport breakpoints; no document state.
- `StudioJobNav.tsx`: accessible four-job navigation only.
- `CompactStudioNav.tsx`: local Edit-pane navigation on compact screens only.
- `GuidedStudio.tsx`: compose existing editor, preview, Prompt Lab, Review, and Render under the selected job; retain document/reducer ownership.
- `studio_time.ts`: frame/second display conversion without editing the document.
- `SceneBoard.tsx`: selected scene sequence and creator-facing labels; no document mutation.
- `Inspector.tsx`: existing text, ownership, and duration callbacks with creator-facing duration input.
- `studio.css`: Studio-scoped visual tokens and layout; no global dashboard restyle.

---

### Task 1: Four-job navigation component

**Files:**
- Modify: `dashboard/src/features/studio/studio_viewport.ts`
- Create: `dashboard/src/features/studio/StudioJobNav.tsx`
- Create: `dashboard/src/features/studio/StudioJobNav.test.tsx`

**Interfaces:** `StudioJob = "edit" | "prompt" | "review" | "render"`; `StudioJobNav({ selected, onSelect })` emits one selected job and owns no document or network state.

- [ ] **Step 1: Write the failing navigation test.** Assert four named buttons, one `aria-current="page"`, keyboard-operable native buttons, and a Render click calling `onSelect("render")`.

```tsx
const onSelect = mock((_job: StudioJob) => {});
render(<StudioJobNav selected="edit" onSelect={onSelect} />);
const nav = screen.getByRole("navigation", { name: "Studio jobs" });
expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
  "Edit", "Prompt", "Review", "Render",
]);
fireEvent.click(within(nav).getByRole("button", { name: "Render" }));
expect(onSelect).toHaveBeenCalledWith("render");
```

- [ ] **Step 2: Run RED.** `bun --cwd=dashboard test src/features/studio/StudioJobNav.test.tsx`; expected module/type missing, not an unrelated harness error.
- [ ] **Step 3: Add the minimal component and types.** Use native buttons, `min-h-11`, visible focus, and `aria-current`; do not implement document or routing logic here.

```tsx
// studio_viewport.ts
export type StudioJob = "edit" | "prompt" | "review" | "render";
export type StudioEditPane = "scenes" | "preview" | "controls";

// StudioJobNav.tsx: import StudioJob from studio_viewport.ts
const jobs: readonly { id: StudioJob; label: string }[] = [
  { id: "edit", label: "Edit" },
  { id: "prompt", label: "Prompt" },
  { id: "review", label: "Review" },
  { id: "render", label: "Render" },
];

export function StudioJobNav({ selected, onSelect }: {
  selected: StudioJob;
  onSelect: (job: StudioJob) => void;
}) {
  return <nav aria-label="Studio jobs">{jobs.map(({ id, label }) =>
    <button key={id} type="button" className="min-h-11 rounded-md px-3 focus-visible:ring-2 focus-visible:ring-ring"
      aria-current={selected === id ? "page" : undefined}
      onClick={() => onSelect(id)}>{label}</button>)}</nav>;
}
```

- [ ] **Step 4: Run GREEN** for the new test and `studio_viewport.test.ts`; verify no viewport boundary changed.
- [ ] **Step 5: Commit** only these three files: `git commit -m "feat: add Studio job navigation"`.

### Task 2: Compose the four destinations without losing state

**Files:**
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/CompactStudioNav.tsx`
- Modify: `dashboard/src/features/studio/CompactStudioNav.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.responsive.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.test.tsx`

**Interfaces:** Consume `StudioJobNav` and `StudioJob` from Task 1. `job` selects a destination; `editPane` selects Scenes, Preview, or Controls only inside compact Edit. Existing editor state and API clients remain authoritative.

- [ ] **Step 1: Add RED integration tests.** Scope job clicks to `navigation[name="Studio jobs"]`. Cover all four destinations at 375 and 1440 px, draft heading surviving a Review round trip, Prompt Lab override surviving a job/viewport round trip, one preview mount, saved-revision Review, missing review/render capability explanation, and phone Render without mutation controls. Adapt existing F2 pane tests to the new two-level navigation without deleting their behavioral assertions.

```tsx
const jobs = within(screen.getByRole("navigation", { name: "Studio jobs" }));
fireEvent.click(jobs.getByRole("button", { name: "Review" }));
expect(screen.getByLabelText("Draft preview").textContent).toBe("Original heading");
fireEvent.click(jobs.getByRole("button", { name: "Edit" }));
expect(screen.getByLabelText("Draft preview").textContent).toBe("Draft heading");
expect(previewMounts).toBe(1);
```

- [ ] **Step 2: Run RED.** `bun --cwd=dashboard test src/features/studio/GuidedStudio.responsive.test.tsx src/features/studio/CompactStudioNav.test.tsx`; failures must identify the absent job navigation/incorrect destination behavior.
- [ ] **Step 3: Replace the single six-way pane choice with two presentation choices.** Keep the existing save reducer, `base`, `state.draft`, `promptLabVisited`, and client slices; move existing components rather than copying them. Keep the same `StudioPreview` instance mounted, passing `base` only during Review. Hidden destinations must not expose focusable descendants.

```tsx
const [job, setJob] = useState<StudioJob>("edit");
const [editPane, setEditPane] = useState<StudioEditPane>("preview");
const reviewing = job === "review";
const previewDocument = reviewing ? base : state.draft;
const previewVisible = reviewing || (job === "edit" && (!compact || editPane === "preview"));
```

On job change, pause an active player when its pane becomes hidden; do not auto-play on return. Render `StudioJobNav` at every width. Inside compact Edit, `CompactStudioNav` exposes only Scenes, Preview, Controls. Keep the current Prompt Lab visited-mount rule and keep existing Review/Render panels mounted; hide inactive destinations with `hidden` so unsent text survives without focusable hidden controls. If a client slice is absent, show a concise `role="status"` explanation instead of hiding the destination. Reuse `StudioReviewPanel` and `RenderPanel`; Render still receives `base.revision`, `base.template`, and `monitorOnly={viewport === "phone"}`.

- [ ] **Step 4: Run GREEN** on focused Studio tests, then `bun --cwd=dashboard test src/features/studio/PromptLab.test.tsx src/features/studio/StudioReviewPanel.test.tsx src/features/studio/RenderPanel.test.tsx`.
- [ ] **Step 5: Commit** only Task 2 files: `git commit -m "feat: organize Studio around creator jobs"`.

### Task 3: Make scene selection and duration understandable

**Files:**
- Create: `dashboard/src/features/studio/studio_time.ts`
- Create: `dashboard/src/features/studio/studio_time.test.ts`
- Modify: `dashboard/src/features/studio/SceneBoard.tsx`
- Create: `dashboard/src/features/studio/SceneBoard.test.tsx`
- Modify: `dashboard/src/features/studio/Inspector.tsx`
- Create: `dashboard/src/features/studio/Inspector.test.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx` (pass canvas fps and position scene strip)

**Interfaces:** `formatSceneSeconds(frames, fps): string`; `parseSceneSeconds(value, fps): number | null`. The inspector keeps the existing `onDurationChange(sceneId, frames)` operation boundary.

- [ ] **Step 1: Write RED tests** for a 150-frame scene at 30 fps displaying `5` seconds, a 151-frame scene displaying `5.033`, untouched input causing zero operations, explicit `5.033` committing 151 frames on blur, and invalid/zero input causing zero operations plus an inline error. A scene card identifies its heading when a text clip exists; otherwise it uses its numbered scene label. Selection stays a native button.

```ts
expect(formatSceneSeconds(150, 30)).toBe("5");
expect(formatSceneSeconds(151, 30)).toBe("5.033");
expect(parseSceneSeconds("5.033", 30)).toBe(151);
expect(parseSceneSeconds("", 30)).toBeNull();
expect(parseSceneSeconds("0", 30)).toBeNull();
```

- [ ] **Step 2: Run RED.** `bun --cwd=dashboard test src/features/studio/studio_time.test.ts src/features/studio/SceneBoard.test.tsx src/features/studio/Inspector.test.tsx`.
- [ ] **Step 3: Add the pure conversion and adapt controls.** Convert only on an explicit duration commit, not on mount, selection, save echo, or every keystroke. Reject non-finite, non-positive, or sub-frame input. The existing reducer/server remains the final duration validator.

```ts
export function formatSceneSeconds(frames: number, fps: number): string {
  return Number((frames / fps).toFixed(3)).toString();
}

export function parseSceneSeconds(value: string, fps: number): number | null {
  if (!value.trim()) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const frames = Math.round(seconds * fps);
  return frames > 0 ? frames : null;
}
```

`SceneBoard` becomes a horizontally scrollable, ordered scene strip below the desktop preview and retains a compact readable presentation. Display a real text heading when present, not a fabricated media thumbnail; display seconds using document fps. `Inspector` changes “Duration (frames)” to “Duration (seconds)” and commits through its existing callback on blur/Enter. Keep Heading, Body, and Ownership operations unchanged; do not add mockup controls for unsupported creative fields.

Keep the uncommitted field text inside a small `DurationField` in `Inspector.tsx`, keyed by scene identity. Its commit path is:

```tsx
const frames = parseSceneSeconds(input, fps);
if (frames === null) {
  setDurationError("Enter a duration greater than zero seconds.");
} else {
  setDurationError(null);
  if (frames !== scene.duration_in_frames) onDurationChange(scene.scene_id, frames);
}
```

Associate the error text with the input using `aria-describedby`; do not overwrite an invalid input with the previous value while it remains selected. Simple mode uses the scene strip; Advanced continues to use its timeline in the lower workspace.

- [ ] **Step 4: Run GREEN** on new tests plus `editor_state.test.ts`, `GuidedStudio.test.tsx`, and `GuidedStudio.responsive.test.tsx`.
- [ ] **Step 5: Commit** Task 3 files: `git commit -m "feat: make Studio scenes easier to edit"`.

### Task 4: Apply the scoped dark canvas and accessibility pass

**Files:**
- Create: `dashboard/src/features/studio/studio.css`
- Modify: `dashboard/src/features/studio/GuidedStudio.tsx`
- Modify: `dashboard/src/features/studio/SceneBoard.tsx`
- Modify: `dashboard/src/features/studio/Inspector.tsx`
- Modify: `dashboard/src/features/studio/GuidedStudio.responsive.test.tsx`

**Interfaces:** CSS custom properties apply only below `.studio-shell`; no global `:root` or other dashboard view is restyled.

- [ ] **Step 1: Add RED structural/accessibility tests.** Assert a Studio-only root class, visible job selection, no duplicate player or hidden-pane tab stop, and a meaningful status when a destination has no capability. Keep existing responsive assertions for 375, 820, 1024, and 1440 px.
- [ ] **Step 2: Run RED** on `GuidedStudio.responsive.test.tsx`; failure should be absent scoped shell or the named accessibility behavior.
- [ ] **Step 3: Add scoped tokens and layout.** Use the selected mockup for hierarchy, not literal assets or decorative controls. Keep body text at least 4.5:1 against its surface, visible focus, and reduced-motion-safe transitions. Style desktop with central preview, contextual side dock, scene strip below; compact widths show one primary pane without horizontal overflow.

```css
.studio-shell {
  --background: #18191b;
  --foreground: #f5f3ee;
  --card: #242628;
  --card-foreground: #f5f3ee;
  --primary: #d49a79;
  --primary-foreground: #1b1918;
  --secondary: #303234;
  --secondary-foreground: #f5f3ee;
  --muted: #2b2d2f;
  --muted-foreground: #c5c6c7;
  --accent: #3b3532;
  --accent-foreground: #f5f3ee;
  --border: #47494a;
  --input: #47494a;
  --ring: #efb28e;
}

@media (prefers-reduced-motion: reduce) {
  .studio-shell *, .studio-shell *::before, .studio-shell *::after {
    scroll-behavior: auto;
    transition-duration: 0.01ms;
    animation-duration: 0.01ms;
  }
}
```

Import this stylesheet from `GuidedStudio.tsx`; do not edit `index.css` or `StudioPreview.tsx`. Check that the Inspector and Prompt/Review/Render surfaces inherit legible scoped colors.
- [ ] **Step 4: Run GREEN** on focused tests. In an offline fake-client browser harness, inspect 1440, 1024, 820, and 375 px; 200% zoom; keyboard-only navigation; reduced motion; Edit/Prompt/Review/Render; and one preview. Block non-local requests. Record screenshots/observations in the ignored F3 checkpoint; if a browser check cannot run, report it as an unverified gate rather than claiming visual completion.
- [ ] **Step 5: Commit** Task 4 files: `git commit -m "style: focus Creator Studio workspace"`.

### Task 5: Full offline verification and handoff

**Files:**
- Modify: `CHANGELOG.md`
- Modify locally (ignored): `.superpowers/sdd/2026-09-24-creator-studio-f3-ux-first-migration/progress.md`

- [ ] **Step 1: Verify scope.** Compare `HEAD` to the execution baseline recorded at preflight: only Plan A Studio/dashboard files and `CHANGELOG.md` may appear; `StudioPreview.tsx` must have no Plan A diff. No API, schema, Python, renderer, Rust, Scout, Compose, or dependency file may change.
- [ ] **Step 2: Run the dashboard gate from `dashboard/`.** Record exact pass/fail counts and warnings.

```powershell
Push-Location dashboard
bun test
bun run lint
bun run build
Pop-Location
```

- [ ] **Step 3: Run the repository-required CUDA build from the repository root.** Confirm `EXIT=0`, no errors or critical warnings, and record the fresh `build_log.txt` timestamp. Rust unit tests are not a substitute for this build; if no Rust source changed, record why no Rust module test was applicable.

```powershell
cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
"EXIT=$LASTEXITCODE"
```

- [ ] **Step 4: Check the actual diff and browser evidence.** `git diff --check`; inspect status, staged files, and the preserved operator file. Record which viewport/keyboard/zoom checks ran and which did not. Do not claim first-mode import or full F3 migration complete.
- [ ] **Step 5: Append one concise completed-work entry** to `CHANGELOG.md`, update the ignored F3 checkpoint with commits/tests/remaining migration plan, and commit only the changelog: `git commit -m "docs: record F3 workspace UX gate"`.

## Handoff

Stop after offline verification and report HEAD, upstream ahead/behind, worktree, task commits, RED→GREEN evidence, browser observations, exact gate results, and limitations. Return to Codex/operator for one end-of-slice review. No push, deployment, live request, default cutover, F1 golden promotion, or Plan B implementation is authorized by this plan.
