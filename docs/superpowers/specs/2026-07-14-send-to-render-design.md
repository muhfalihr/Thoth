# Design — Sub-project D: One-click "Send to render" hand-off

- **Date:** 2026-07-14
- **Initiative:** Operator Console (sub-project D of A✅ / B✅ / C✅ shipped)
- **Status:** Design — awaiting approval before implementation
- **Author:** Claude (Opus 4.8) + muhfalihr
- **Predecessor specs:** `2026-07-11-dashboard-architecture-design.md` (A),
  `2026-07-14-scout-orchestration-design.md` (B),
  `2026-07-14-content-set-editor-design.md` (C)

## 1. Context & Problem

The Operator Console now supports the full flow in the browser **except the last
click**: a user runs Discovery (B), curates the resulting content-set (C), then
must **manually copy the content-set path** into the Runs-view `RunForm` (A) and
type it by hand to start a render. Sub-project D closes that gap.

Both predecessor specs already fixed D's *mechanism*:
- content-set spec §159: *"One-click Discovery → render hand-off **(pre-filling
  `RunForm`)** — sub-project D."*
- scout-orchestration spec §168–169: *"One-click 'send to render' that
  **pre-fills sub-project A's `RunForm`** is explicitly out of scope [of B] —
  that is sub-project D."*

So D is a **"Send to render" button in the Content-Set view that pre-fills the
existing `RunForm`** with the curated content-set path and switches to the Runs
view. It reuses A's job-enqueue + streaming wholesale — the backend contract
already exists (`JobSpec.content_set?: string`, `createJob()`), so **D touches
`dashboard/` only. No Rust change, no `api.ts` type change, no new endpoint.**

## 2. Goals / Non-goals

**Goals**
- A "Send to render →" button in the Content-Set view footer (next to Save).
- Clicking it hands the current content-set path to `RunForm` and lands the user
  on the Runs view with that path pre-filled, ready to confirm params and Run.
- If the content-set has unsaved edits, save + validate them first so the render
  uses exactly what is on screen.

**Non-goals (explicitly out of scope for D)**
- Auto-submitting the job. The user still clicks **Run** in `RunForm` after
  reviewing params. (Rationale in §3, Decision 2.)
- Any change to job params, the render pipeline, or `thoth-core`.
- Non-video `image_path` render path (separate content-set-contract follow-up).
- A content-set path *picker* / arbitrary-file curation (separate C follow-up).
- Adding a dashboard test runner (vitest/testing-library). Verification stays
  build-typecheck + lint + manual doc, consistent with C's TS side (§7).

## 3. Locked Decisions

1. **Entry point: Content-Set view footer only.** A content-set only exists after
   curation; the Discovery view deals in topic URLs, not content-sets, so a
   Discovery→render shortcut would be an indirect mapping. One button, one home.
2. **Submit model: pre-fill + wait (the specs' intent), not auto-enqueue.**
   Switch to Runs with the path populated in `RunForm`; the user reviews params
   (provider/profile) and clicks **Run**. This preserves param control, which is
   correctness-critical: per the "Narration Provider Gotcha", the default
   `--provider groq` (12k TPM) silently 429s and falls back to clip-mode, ruining
   narration — a param-less one-click would hide that choice.
3. **Dirty state: auto-save + validate first, then hand off.** Render must use the
   curated version. Reuse C's existing `save()` (putContentSet → validate →
   reload). If the save fails, abort the hand-off and surface the error; do not
   navigate.

## 4. Architecture & Data Flow

All state coordination lives in `App.tsx`, which already owns `view` and
`selectedJobId`. `RunForm` is rendered **only** in the Runs (default) branch of
App's view ternary, so it **unmounts on view-switch and remounts fresh** when the
user returns to Runs. That makes a one-shot prefill clean: App holds the pending
path; `RunForm` reads it as an initial value on mount, then signals consumption.

```
Content-Set view (ContentSet.tsx)
  footer: [Save]  [Send to render →]
                         │  onClick:
                         │   1. if dirty → await save()  (putContentSet+validate); abort on failure
                         │   2. onSendToRender(data.path)
                         ▼
App.tsx  handleSendToRender(path):
    setPendingContentSet(path)      // string | null, lifted state
    setView("runs")
                         ▼  view flips → Runs branch mounts RunForm fresh
Runs view (RunForm.tsx)
    props: initialContentSet={pendingContentSet}, onConsumed={() => setPendingContentSet(null)}
    mount effect (once): if initialContentSet →
        setContentSet(initialContentSet)   // fills the existing content-set field
        setShowOpts(true)                  // reveal params so provider is visible
        onConsumed()                       // App clears pending → one-shot, no re-prefill on later visits
    user reviews provider/profile → clicks [Run] → existing createJob() + onCreated(jobId) → stream
```

### Component changes (all in `dashboard/src/`)

- **`App.tsx`**
  - New state: `const [pendingContentSet, setPendingContentSet] = useState<string | null>(null)`.
  - New handler `handleSendToRender(path: string)` → sets pending + `setView("runs")`.
  - Pass `onSendToRender={handleSendToRender}` to `<ContentSet />`.
  - Pass `initialContentSet={pendingContentSet}` and
    `onConsumed={() => setPendingContentSet(null)}` to `<RunForm />`.

- **`components/ContentSet.tsx`**
  - New prop: `onSendToRender: (path: string) => void`.
  - Footer button "Send to render →" beside Save.
  - Handler `sendToRender()`:
    - Guard: no-op if no `data.path`, no valid `content`, or `running`.
    - If `dirty`: `const ok = await save()`; return early if it failed (surface
      the existing notice). `save()` must return a success boolean (small refactor
      — today it returns `void`).
    - Call `onSendToRender(data.path)`.
  - Disabled state mirrors Save: `disabled={saving || running || !data?.path || !content}`.

- **`components/RunForm.tsx`**
  - New props: `initialContentSet?: string`, `onConsumed?: () => void`
    (added to the existing `{ onCreated }` props object).
  - One mount `useEffect(() => { if (initialContentSet) { setContentSet(initialContentSet); setShowOpts(true); onConsumed?.(); } }, [])`.
    Empty dep array is correct: RunForm remounts per Runs-view entry, so mount is
    the right (one-shot) moment; the value is captured at mount.
  - No change to its `command`/`params`/`createJob` logic.

## 5. Interfaces (exact TS signatures)

```ts
// App.tsx
const [pendingContentSet, setPendingContentSet] = useState<string | null>(null);
function handleSendToRender(path: string): void { setPendingContentSet(path); setView("runs"); }

// ContentSet.tsx
type ContentSetProps = { onSendToRender: (path: string) => void };
async function sendToRender(): Promise<void>;   // internal
async function save(): Promise<boolean>;         // refactor: was Promise<void>

// RunForm.tsx
type RunFormProps = {
  onCreated: (jobId: string) => void;   // existing
  initialContentSet?: string;           // new
  onConsumed?: () => void;              // new
};
```

No `api.ts` change. `JobSpec.content_set` and `createJob()` are used unchanged.

## 6. Edge Cases

- **Empty / missing / malformed content-set** → button disabled (no path/content).
- **Scout command running** (`running === true`) → button disabled (a running
  scout could rewrite the file; save-first would be unsafe). Mirrors Save's gate.
- **Save/validate failure on a dirty set** → abort hand-off, keep the user in view
  C with the existing failure notice; do not navigate.
- **User navigates Runs → elsewhere → Runs again** → no re-prefill, because
  `onConsumed` cleared `pendingContentSet` at first mount (one-shot).
- **Fresh RunForm losing an in-progress manual entry**: not a regression — the
  user explicitly chose "Send to render", and RunForm is unmounted while in view C.

## 7. Verification

Consistent with C's TS side (the dashboard has no test runner; adding one is a
non-goal, §2):
1. `cd dashboard && bun run build` (`tsc -b` typecheck + `vite build`) → EXIT 0.
2. `bun run lint` (oxlint) → clean.
3. **Manual-integration doc** `docs/superpowers/plans/2026-07-14-send-to-render-manual-test.md`
   covering: dirty→save→handoff, clean→handoff, disabled states (empty/running),
   one-shot (no re-prefill), and a full curate→render→stream smoke run.

No Rust build/test needed — D touches no Rust. (The `build_cuda.bat` gate in
CLAUDE.md applies to Rust feature changes; this is frontend-only.)

## 8. Risks & Mitigations

- **`save()` refactor to return a boolean** touches C's tested-by-hand path.
  Mitigation: keep `save()`'s side effects identical; only add a return value; the
  existing footer Save button ignores it (no behavior change there).
- **Mount-effect prefill relies on RunForm remounting per Runs entry.** If a future
  refactor keeps RunForm always-mounted, the one-shot prefill would need to move to
  a prop-change effect. Documented here so that coupling is explicit.
- **No automated test coverage** for the interaction (frontend, no runner). The
  manual doc is the safety net; the logic is small and typed.

## 9. Open Questions

None blocking. Proceed to `writing-plans` on approval.
