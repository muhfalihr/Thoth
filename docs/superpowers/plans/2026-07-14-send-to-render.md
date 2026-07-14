# Plan — Sub-project D: One-click "Send to render" hand-off

- **Date:** 2026-07-14
- **Design:** `docs/superpowers/specs/2026-07-14-send-to-render-design.md` (approved)
- **Initiative:** Operator Console (sub-project D; A✅/B✅/C✅ shipped)
- **Branch:** `feature/send-to-render` (off `master` @ 9369537)
- **Scope:** `dashboard/` only — no Rust, no `api.ts` type change, no new endpoint.

## Architecture recap

A "Send to render →" button in the Content-Set view footer hands the curated
content-set path to the existing `RunForm` (Runs view) and switches views. App
owns a one-shot `pendingContentSet` string; `RunForm` remounts on each Runs-view
entry and reads it once at mount, opens its options panel, then clears it via
`onConsumed`. If the content-set is dirty, `save()` (putContentSet → validate)
runs first and the hand-off aborts on save failure. The backend contract already
exists (`JobSpec.content_set`, `createJob`) — reused unchanged.

**Tech stack:** React 18 + TypeScript, Vite, Bun. No test runner in `dashboard/`
(a non-goal per the design); verification is `tsc -b` typecheck + `oxlint` +
a manual-integration doc — identical to sub-project C's TS side.

**Task order is compile-safe:** Task 1 adds only *optional* props to `RunForm`
(tree still typechecks without callers). Task 2 makes `ContentSet`'s new prop
*required* AND wires `App` in the same commit, so every commit typechecks.

---

## Task 1 — RunForm: one-shot prefill props + mount effect

**Files:**
- Modify: `dashboard/src/components/RunForm.tsx`

**Interfaces (new, both optional — non-breaking):**
```ts
type RunFormProps = {
  onCreated: (jobId: string) => void;   // existing
  initialContentSet?: string;           // new
  onConsumed?: () => void;              // new
};
```

**Steps:**
1. Ensure `useEffect` is imported from `react` (add to the existing
   `import { useState } from "react"` line if absent).
2. Change the signature at `RunForm.tsx:16` from
   ```ts
   export function RunForm({ onCreated }: { onCreated: (jobId: string) => void }) {
   ```
   to
   ```ts
   export function RunForm({
     onCreated,
     initialContentSet,
     onConsumed,
   }: {
     onCreated: (jobId: string) => void;
     initialContentSet?: string;
     onConsumed?: () => void;
   }) {
   ```
3. Immediately **before** the `return (` at `RunForm.tsx:115`, add a one-shot
   mount effect (state hooks `contentSet`/`showOpts` already exist at L19–20):
   ```ts
   // One-shot prefill from a "Send to render" hand-off (sub-project D). RunForm
   // remounts on each entry to the Runs view, so mount is the right moment to
   // consume the pending path; the empty dep array captures it exactly once.
   useEffect(() => {
     if (initialContentSet) {
       setContentSet(initialContentSet);
       setShowOpts(true); // reveal params so provider can be set before Run
       onConsumed?.();
     }
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);
   ```

**Verification:**
- `cd dashboard && bun run build` → EXIT 0 (tsc typecheck passes; App still
  compiles because the new props are optional).
- `bun run lint` → clean (the `exhaustive-deps` disable comment is intentional
  and scoped to that line).

---

## Task 2 — ContentSet button + `save()` boolean + App wiring (one commit)

**Files:**
- Modify: `dashboard/src/components/ContentSet.tsx`
- Modify: `dashboard/src/App.tsx`

**Interfaces:**
```ts
// ContentSet.tsx
type ContentSetProps = { onSendToRender: (path: string) => void };
async function save(): Promise<boolean>;   // was Promise<void>
async function sendToRender(): Promise<void>;  // internal

// App.tsx
const [pendingContentSet, setPendingContentSet] = useState<string | null>(null);
function handleSendToRender(path: string): void;
```

**Steps — `ContentSet.tsx`:**
1. Signature at `ContentSet.tsx:23`:
   ```ts
   export function ContentSet({ onSendToRender }: { onSendToRender: (path: string) => void }) {
   ```
2. Refactor `save` (`ContentSet.tsx:100–131`) to return a boolean reflecting the
   **putContentSet** result (validate is best-effort and does not gate the
   hand-off). Change the three exits only; keep every side effect identical:
   - `const save = async (): Promise<boolean> => {`
   - `if (!content) return;` → `if (!content) return false;`
   - inside `if (!res.ok) { … return; }` → `return false;`
   - add `return true;` as the final statement before the closing `};`.
   (The `ack.ok === false` branch keeps only its `setNotice`; it does **not**
   return false — a saved-but-validate-busy file is still safe to render.)
3. Add `sendToRender` next to `save`:
   ```ts
   const sendToRender = async () => {
     if (!data?.path || !content || running) return;
     if (dirty) {
       const ok = await save(); // save + validate the on-screen edits first
       if (!ok) return;         // save failed → stay put; notice already shown
     }
     onSendToRender(data.path);
   };
   ```
4. Footer: after the Save `<Button>` at `ContentSet.tsx:279–281`, add:
   ```tsx
   <Button
     onClick={sendToRender}
     disabled={saving || running || !data?.path || !content}
   >
     Send to render →
   </Button>
   ```
   (Match the existing Save `<Button>` styling; a `variant` is cosmetic — only add
   one if the `Button` component already exposes it in this file's usage.)

**Steps — `App.tsx`:**
5. Add state beside the existing `view` / `selectedJobId` hooks:
   ```ts
   const [pendingContentSet, setPendingContentSet] = useState<string | null>(null);
   ```
6. Add the handler:
   ```ts
   const handleSendToRender = (path: string) => {
     setPendingContentSet(path);
     setView("runs");
   };
   ```
7. Pass the prop to `ContentSet` in the `view === "contentset"` branch:
   ```tsx
   <ContentSet onSendToRender={handleSendToRender} />
   ```
8. Extend the `RunForm` render (Runs/default branch) from
   `<RunForm onCreated={setSelectedJobId} />` to:
   ```tsx
   <RunForm
     onCreated={setSelectedJobId}
     initialContentSet={pendingContentSet ?? undefined}
     onConsumed={() => setPendingContentSet(null)}
   />
   ```

**Verification:**
- `cd dashboard && bun run build` → EXIT 0 (whole tree typechecks; `ContentSet`'s
  required prop is now supplied by `App`).
- `bun run lint` → clean.
- The existing footer Save button still calls `save` and ignores its return value
  — no behavior change there.

---

## Task 3 — Manual-integration doc + BLUEPRINT update

**Files:**
- Create: `docs/superpowers/plans/2026-07-14-send-to-render-manual-test.md`
  (gitignored dir → `git add -f`).
- Modify: `BLUEPRINT.md` (prepend a dated sub-project-D entry; bump the
  "Last updated" line).

**Manual-integration doc must cover:**
1. Curate a content-set in view C, leave it **clean**, click Send-to-render →
   lands on Runs view, content-set path prefilled, Options panel open, no job
   started until Run is clicked.
2. Make an edit (dirty), click Send-to-render → save+validate runs first
   (footer shows "Saved. Validating…"), then hand-off; the prefilled path is the
   just-saved file.
3. Disabled states: empty/missing content-set → button disabled; a scout command
   running → button disabled.
4. One-shot: after landing on Runs, switch to another view and back to Runs →
   `RunForm` is **not** re-prefilled (pending cleared by `onConsumed`).
5. Full smoke: Send-to-render → set provider (e.g. novita, per the groq
   clip-mode gotcha) → Run → job streams to completion in the Runs monitor.

**Verification:**
- `cd dashboard && bun run build` → EXIT 0; `bun run lint` → clean (final state).
- No Rust build/test (D touches no Rust).

---

## Self-review

- **No placeholders / TODOs** in any task; every edit has exact anchor + code.
- **Compile-safe ordering**: T1 optional props → T2 required prop + caller wiring
  in one commit → T3 docs. Each commit typechecks.
- **Design fidelity**: footer-only entry ✅; pre-fill + wait (no auto-submit) ✅;
  auto-save+validate on dirty, abort on save failure ✅; one-shot prefill ✅.
- **Confinement**: `dashboard/` only; no Rust, no `api.ts` types, no endpoint,
  no `JobSpec`/`JobRecord`/`JobStatus`/`JobEvent` change.
- **Verification honesty**: no test runner exists (approved non-goal); gates are
  tsc typecheck + oxlint + manual doc, matching sub-project C's TS side.
- **Risk noted**: the one-shot prefill relies on `RunForm` remounting per Runs
  entry (true today — it lives in the default ternary branch). Documented in the
  design's Risks §8 so a future always-mounted refactor knows to move the effect.
```
