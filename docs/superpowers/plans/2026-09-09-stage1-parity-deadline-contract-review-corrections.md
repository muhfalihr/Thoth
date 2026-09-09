# Stage 1 Parity Deadline Contract Review Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the documented parity-reference deadline with the existing fail-closed lifecycle, restore direct test typing, and complete the Blueprint audit trail without changing runtime behavior.

**Architecture:** Keep the 30/5/35-minute constants and all executable supervisor behavior unchanged. Clarify that 35 minutes bounds browser readiness through the reference-child outcome, while teardown and attempt finalization remain mandatory post-outcome work. Replace the new weakening test cast with a directly typed dependency fixture and append the missing Blueprint audit entry.

**Tech Stack:** Bun, TypeScript, Python deployment contract tests, Markdown, Rust/CUDA repository build.

**Spec:** `docs/superpowers/specs/2026-09-09-stage1-parity-deadline-contract-review-corrections-design.md`

## Global constraints

- Work from `codex/stage1-container-ci`; `22ac41aabcb2e2ed1bceeec611e2c14118fa8803` must remain an ancestor.
- Inspect all drift after `22ac41a` before editing. Preserve unrelated operator changes.
- Keep every executable statement and the 30/5/35-minute values unchanged.
- Preserve supervisor cleanup, child reaping, exit precedence, diagnostics, and atomic attempt finalization.
- Keep p5 as `evidence_incomparable`; grant no parity credit.
- Use offline repository files and synthetic tests only. Respect every hard stop in the spec.
- Prefix every shell command with `rtk`.
- Each commit uses exactly one concise subject line and no body or attribution trailer.

---

### Task 1: Correct the deadline contract wording

**Files:**

- Modify: `docs/superpowers/specs/2026-09-09-stage1-parity-reference-completion-budget-design.md`
- Modify: `docs/operations/stage1-parity-sampling.md`
- Modify: `scout/lib/parity_reference_contract.ts`
- Modify: `scout/runtime/parity_reference.ts`
- Modify: `scout/runtime/parity_reference_contract.test.ts`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: existing 30-minute source-stage timeout, 5-minute reserve, and derived 35-minute supervisor deadline.
- Produces: one consistent contract distinguishing supervised child-run time from mandatory post-outcome cleanup and finalization.

- [ ] **Step 1: Add a failing documentation-contract assertion**

Extend `test_the_parity_runbook_states_the_completion_boundary_and_its_budgets` so normalized runbook prose must state both boundaries:

```python
assert "supervised acquisition deadline" in prose
assert "cleanup and attempt finalization continue after that outcome" in prose
```

Use these exact phrases in the runbook. Do not inspect runtime source text for prose and do not add a network or Docker test.

- [ ] **Step 2: Run the focused test and prove RED**

Run from the repository root:

```powershell
rtk uv run --project python python -m pytest -q python/tests/deployment/test_container_contract.py::test_the_parity_runbook_states_the_completion_boundary_and_its_budgets
```

Expected: failure because the current runbook still describes an overall deadline whose reserve includes teardown and finalization.

- [ ] **Step 3: Correct the authoritative wording**

Update the original design and runbook to state:

```text
The 35-minute supervised acquisition deadline starts before browser readiness and ends when the
browser/reference race selects an outcome. Cleanup and attempt finalization continue after that
outcome and remain mandatory before the supervisor returns.
```

Explain that the five-minute reserve provides pre-outcome headroom for browser readiness, seed work,
summary, and scheduling variance. Remove the claim that it bounds or includes teardown and attempt
finalization. Keep the values, exit codes, and no-retry rule unchanged.

- [ ] **Step 4: Align source comments and test names**

In `parity_reference_contract.ts`, describe the reserve as pre-outcome headroom. In
`parity_reference.ts`, call the timer the supervised acquisition deadline and state that cleanup and
finalization intentionally follow outside it. Rename the contract test from wording that claims the
reserve covers teardown to wording such as:

```typescript
test('the reserve provides pre-outcome acquisition headroom', () => {
  expect(SOURCE_REFERENCE_OVERHEAD_RESERVE_MS).toBe(5 * 60_000);
});
```

Do not move `clearTimeout(timer)`, change a constant, add a timer, or alter an executable statement.

- [ ] **Step 5: Prove GREEN**

Run:

```powershell
rtk uv run --project python python -m pytest -q python/tests/deployment/test_container_contract.py::test_the_parity_runbook_states_the_completion_boundary_and_its_budgets
```

Then run from `scout/`:

```bash
rtk bun test runtime/parity_reference_contract.test.ts runtime/parity_reference.test.ts
```

Expected: all tests pass with unchanged lifecycle outcomes.

- [ ] **Step 6: Commit Task 1**

```bash
rtk git add docs/superpowers/specs/2026-09-09-stage1-parity-reference-completion-budget-design.md docs/operations/stage1-parity-sampling.md scout/lib/parity_reference_contract.ts scout/runtime/parity_reference.ts scout/runtime/parity_reference_contract.test.ts python/tests/deployment/test_container_contract.py
rtk git commit -m "docs: clarify parity deadline scope"
```

Completion criterion: all six files describe the same child-run boundary and no executable behavior changes.

---

### Task 2: Restore direct dependency typing

**Files:**

- Modify: `scout/pipeline/run_pipeline_acquisition.test.ts`

**Interfaces:**

- Consumes: `RunPipelineDeps` and the existing source-reference call-order fixture.
- Produces: a fixture whose required dependency surface is compiler-checked without casts.

- [ ] **Step 1: Capture the current typecheck baseline**

From `scout/`, run:

```bash
rtk bun run typecheck
```

Expected: exit zero before the edit. This is a type-safety correction, so there is no honest behavioral RED.

- [ ] **Step 2: Replace the weakening cast**

Extract the object currently ending in `as unknown as RunPipelineDeps` into a typed variable:

```typescript
const referenceDeps: RunPipelineDeps = {
  createContext: async () => {
    referenceStages.push('create_context');
    return context;
  },
  inspectSeed: async () => {
    referenceStages.push('inspect_seed');
    return { title: 'caption', description: 'caption', platform: 'tiktok', is_video: true };
  },
  writeSeed: async () => {
    referenceStages.push('write_seed');
  },
  traceSource: async () => {
    referenceStages.push('trace_source');
  },
  collectComments: async () => assert.fail('source reference must not collect comments'),
  topicDossier: async () => assert.fail('source reference must not enrich the topic dossier'),
  buildFootage: async () => assert.fail('source reference must not build footage'),
  packageExternalFootage: async () =>
    assert.fail('source reference must not package external footage'),
  extractFigures: async () => assert.fail('source reference must not extract figures'),
  validate: async () => assert.fail('source reference must not run full-pipeline validation'),
  summarize: async () => {
    referenceStages.push('summarize');
  },
};

await runPipelineWithDeps(
  {
    url: 'https://example.invalid/post',
    out: 'set.json',
    noComments: false,
    useInputAsMain: false,
    sourceReferenceOnly: true,
    mainCoverageTarget: 0.60,
  },
  referenceDeps,
);
```

Preserve the existing concrete option object and every dependency body. Do not use `as unknown`,
`as any`, `satisfies` followed by a cast, an index signature, or optional interface fields.

- [ ] **Step 3: Verify the focused test and typecheck**

From `scout/`, run:

```bash
rtk bun pipeline/run_pipeline_acquisition.test.ts
rtk bun run typecheck
```

Expected: the existing exact call-order assertion and every forbidden-stage hard failure remain green; typecheck exits zero.

- [ ] **Step 4: Commit Task 2**

```bash
rtk git add scout/pipeline/run_pipeline_acquisition.test.ts
rtk git commit -m "test: restore parity dependency typing"
```

Completion criterion: the source-boundary fixture is directly typed as `RunPipelineDeps` and contains no weakening cast.

---

### Task 3: Complete the Blueprint audit trail

**Files:**

- Modify: `BLUEPRINT.md`

**Interfaces:**

- Consumes: verified outcomes from Tasks 1 and 2.
- Produces: a truthful final 2026-09-09 chronological checkpoint.

- [ ] **Step 1: Correct the top checkpoint wording**

In the existing “Stage 1 parity reference completion and budget” checkpoint, clarify that 35 minutes
ends at the child outcome and cleanup/finalization continue afterward. Keep all existing statements
that p5 is incomparable and the work is offline and unpublished.

- [ ] **Step 2: Append the final chronological update**

Append a final `*Update: 2026-09-09 — ...*` entry describing:

- the source-only completion implementation;
- the clarified supervised acquisition deadline;
- mandatory post-outcome teardown and attempt finalization;
- the restored typed test fixture;
- actual offline verification results from this round; and
- the unchanged operational state and p5 classification.

Do not copy private evidence, fixture values, digest values, or unverified test counts. Do not claim
publication, deployment, a live pass, parity credit, or an open acceptance window.

- [ ] **Step 3: Commit Task 3**

```bash
rtk git add BLUEPRINT.md
rtk git commit -m "docs: update parity corrective audit trail"
```

Completion criterion: the last chronological Blueprint entry is dated 2026-09-09 and matches the verified implementation state.

---

### Task 4: Run the complete offline verification

**Files:**

- Verify only: all files changed by Tasks 1-3.

**Interfaces:**

- Consumes: the three corrective commits.
- Produces: an independent-review handoff with actual command results.

- [ ] **Step 1: Run Scout gates**

From `scout/`:

```bash
rtk bun pipeline/run_pipeline_acquisition.test.ts
rtk bun test runtime/parity_reference_contract.test.ts runtime/parity_reference.test.ts
rtk bun run test:runtime
rtk bun run test:acquisition
rtk bun run typecheck
```

- [ ] **Step 2: Run Python gates**

From the Windows repository root:

```powershell
rtk uv run --project python python -m pytest -q python/tests/deployment
rtk uv run --project python ruff check python
rtk uv run --project python ruff format --check python
```

Do not run a bare WSL `uv run --project python`. If WSL Python verification becomes necessary, use
the external parity environment and absolute project path prescribed by the original plan.

- [ ] **Step 3: Run the required repository build**

From PowerShell:

```powershell
rtk run 'cmd /c ".\build_cuda.bat build_log.txt 2>&1"'
```

Read the exit status. Remove only a `build_log.txt` created by this task after inspecting it. Require
exit zero before claiming completion.

- [ ] **Step 4: Verify scope and repository integrity**

Run:

```bash
rtk git diff 22ac41aabcb2e2ed1bceeec611e2c14118fa8803...HEAD
rtk git diff --check
rtk git status --short --branch
rtk git log 22ac41aabcb2e2ed1bceeec611e2c14118fa8803..HEAD --format='%h %s%n%b'
```

Confirm there is no executable-statement change, every commit has one subject line with an empty
body, the worktree is clean, and no prohibited attribution exists.

- [ ] **Step 5: Stop for independent review**

Do not build or publish an image, run a container harness, push, deploy, make a live request, access
evidence, mutate Issue #5, retry p5, run controlled fallback, or open an acceptance window.

Completion criterion: every offline gate passes, the worktree is clean, and the result is ready for independent review only.
