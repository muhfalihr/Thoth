# Stage 1 Parity Reference Completion and Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` task-by-task. Do not delegate evidence or
> operational work because neither is authorized in this plan.

**Goal:** Make isolated parity references exit after the source artifact boundary
and keep their outer supervisor deadline longer than every retained inner stage.

**Architecture:** Add an internal `--source-reference-only` mode to the existing
Scout run pipeline. It performs seed inspection, required source tracing, and the
existing summary, then returns before unrelated enrichment. A dependency-free
shared contract supplies the 30-minute source budget and 35-minute supervisor
deadline.

**Tech Stack:** Bun, TypeScript, Python deployment contract tests, Docker
Linux/amd64 offline smoke, Markdown.

**Spec:**
`docs/superpowers/specs/2026-09-09-stage1-parity-reference-completion-budget-design.md`

## Global constraints

- Preserve normal Scout `run` behavior when `--source-reference-only` is absent.
- Preserve supervisor exit, cleanup, diagnostic, and atomic attempt-record
  semantics.
- A source-only child exit zero still requires external artifact and comparison
  gates; it does not grant parity credit.
- Use Docker only for a named local candidate image and offline harnesses. Never
  address the deployed project, deployment Compose file, or GHCR publication.
- Do not read fixtures, secrets, `.env.stage1.local`, provider files, or restricted
  parity evidence.
- No live request, p5 retry, new sample, evidence/Issue mutation, deployment,
  controlled fallback, or acceptance-window activation.
- Repository artifacts, code, comments, docs, and commit messages remain English.
- Every commit uses exactly one concise subject line, no body, trailer,
  `Co-Authored-By`, Claude, or Anthropic attribution.

---

### Task 1: Lock the source-reference boundary with failing tests

**Files:**

- Modify: `scout/pipeline/run_pipeline_acquisition.test.ts`
- Modify: `scout/pipeline/run_pipeline.ts`

**Interfaces:**

- Consumes: existing `parseRunPipelineOptions`, `RunPipelineOptions`, and
  `runPipelineWithDeps` interfaces.
- Produces: `sourceReferenceOnly: boolean` and fixed parse failure
  `source_reference_only_conflicts_with_forced_main`.

- [ ] **Step 1: Add parser tests before production code**

Add assertions equivalent to:

```typescript
const ordinary = parseRunPipelineOptions(['https://example.invalid/post']);
assert.equal(ordinary.sourceReferenceOnly, false);

const reference = parseRunPipelineOptions([
  'https://example.invalid/post',
  '--source-reference-only',
]);
assert.equal(reference.sourceReferenceOnly, true);

assert.throws(
  () =>
    parseRunPipelineOptions([
      'https://example.invalid/post',
      '--source-reference-only',
      '--use-input-as-main',
    ]),
  /source_reference_only_conflicts_with_forced_main/,
);
```

Use only inert example URLs; the tests must not perform network access.

- [ ] **Step 2: Add a source-reference call-order test**

Invoke `runPipelineWithDeps` with `sourceReferenceOnly: true` and fakes that
append fixed labels to an array. Require exactly:

```typescript
[
  'create_context',
  'inspect_seed',
  'write_seed',
  'trace_source',
  'summarize',
]
```

Every later dependency must fail the test if called:

```typescript
collectComments: async () => assert.fail('source reference reached comments'),
topicDossier: async () => assert.fail('source reference reached dossier'),
buildFootage: async () => assert.fail('source reference reached footage'),
packageExternalFootage: async () => assert.fail('source reference packaged footage'),
extractFigures: async () => assert.fail('source reference reached figures'),
validate: async () => assert.fail('source reference reached full validation'),
```

- [ ] **Step 3: Prove RED**

Run:

```bash
cd scout && bun pipeline/run_pipeline_acquisition.test.ts
```

Expected: failure because `sourceReferenceOnly` and the early-return behavior do
not exist. Record only test names and counts in the executor report.

- [ ] **Step 4: Implement the minimal parser contract**

Add the field:

```typescript
export interface RunPipelineOptions {
  // existing fields
  sourceReferenceOnly: boolean;
}
```

In `parseRunPipelineOptions`, compute both boolean flags, reject their conflict
with the fixed coded error, and return the new field. Do not change parsing of
existing flags.

- [ ] **Step 5: Implement the early source completion boundary**

Immediately after successful required `trace_source` and before the comments
branch, add:

```typescript
if (options.sourceReferenceOnly) {
  await deps.summarize(file);
  return;
}
```

Do not skip seed inspection or `trace_source`. Do not run full validation in this
mode; the parity artifact validator remains the authority for the resulting
report and media.

- [ ] **Step 6: Update all typed test options**

Set `sourceReferenceOnly: false` explicitly in every existing hand-built
`RunPipelineOptions` fixture. Do not weaken types with casts or optional fields.

- [ ] **Step 7: Prove GREEN and normal-mode preservation**

Run:

```bash
cd scout && bun pipeline/run_pipeline_acquisition.test.ts
```

Expected: all tests pass, including existing full-pipeline order and diagnostic
tests.

- [ ] **Step 8: Commit Task 1**

```bash
git add scout/pipeline/run_pipeline.ts scout/pipeline/run_pipeline_acquisition.test.ts
git commit -m "fix: add Scout source reference mode"
```

Completion criterion: source-reference mode has a tested early boundary and
ordinary pipeline behavior remains covered.

---

### Task 2: Share and enforce the budget contract

**Files:**

- Create: `scout/lib/parity_reference_contract.ts`
- Create: `scout/runtime/parity_reference_contract.test.ts`
- Modify: `scout/pipeline/run_pipeline.ts`
- Modify: `scout/runtime/parity_reference.ts`
- Modify: `scout/runtime/parity_reference.test.ts`

**Interfaces:**

- Produces:
  - `SOURCE_REFERENCE_TRACE_TIMEOUT_MS`
  - `SOURCE_REFERENCE_OVERHEAD_RESERVE_MS`
  - `SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS`
- Consumes: the new source-reference flag from Task 1.

- [ ] **Step 1: Write the failing budget-contract test**

Create a Bun test that imports the three proposed constants and requires:

```typescript
expect(SOURCE_REFERENCE_TRACE_TIMEOUT_MS).toBe(30 * 60_000);
expect(SOURCE_REFERENCE_OVERHEAD_RESERVE_MS).toBe(5 * 60_000);
expect(SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS).toBe(35 * 60_000);
expect(SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS).toBe(
  SOURCE_REFERENCE_TRACE_TIMEOUT_MS + SOURCE_REFERENCE_OVERHEAD_RESERVE_MS,
);
```

Also add a production-command test in `parity_reference.test.ts` requiring a real
reference command to contain `--source-reference-only` exactly once and an
offline-smoke command not to contain it.

- [ ] **Step 2: Prove RED**

Run:

```bash
cd scout && bun test runtime/parity_reference_contract.test.ts runtime/parity_reference.test.ts
```

Expected: failure because the shared module and command builder do not exist.

- [ ] **Step 3: Add the dependency-free shared module**

Create exactly:

```typescript
export const SOURCE_REFERENCE_TRACE_TIMEOUT_MS = 30 * 60_000;
export const SOURCE_REFERENCE_OVERHEAD_RESERVE_MS = 5 * 60_000;
export const SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS =
  SOURCE_REFERENCE_TRACE_TIMEOUT_MS + SOURCE_REFERENCE_OVERHEAD_RESERVE_MS;
```

No environment lookup, I/O, timers, or mutable export belongs in this module.

- [ ] **Step 4: Wire the retained source-stage budget**

Replace the local 30-minute trace constant in `run_pipeline.ts` with
`SOURCE_REFERENCE_TRACE_TIMEOUT_MS`. Preserve the normal pipeline's existing
30-minute behavior.

- [ ] **Step 5: Extract and test reference command construction**

Add a pure exported helper with an exact tuple/array return type, for example:

```typescript
export function referenceCommand(
  offlineSmoke: boolean,
  fixtureUrl: string,
  reportPath: string,
): string[] {
  return offlineSmoke
    ? ['bun', 'scout/runtime/parity_reference_smoke.ts']
    : [
        'bun',
        'scout/cli.ts',
        'run',
        fixtureUrl,
        '--out',
        reportPath,
        '--source-reference-only',
      ];
}
```

Use this helper in `productionDeps`; do not duplicate the array at the call site.
Tests must not print the fixture argument.

- [ ] **Step 6: Replace the supervisor default deadline**

Use `SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS` as the default in
`runReference`. Keep injected `deadlineMs` support unchanged so the existing
fast deadline tests remain deterministic.

- [ ] **Step 7: Prove GREEN and preserve lifecycle behavior**

Run:

```bash
cd scout && bun test runtime/parity_reference_contract.test.ts runtime/parity_reference.test.ts
```

Require the new contract tests and all existing success, nonzero, deadline,
interruption, browser-death, leaked-child, reservation, atomic-finalization, and
diagnostic tests to pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add scout/lib/parity_reference_contract.ts scout/pipeline/run_pipeline.ts scout/runtime/parity_reference.ts scout/runtime/parity_reference.test.ts scout/runtime/parity_reference_contract.test.ts
git commit -m "fix: align parity reference budgets"
```

Completion criterion: one shared arithmetic contract makes the outer deadline
35 minutes and every real reference invokes source-only mode.

---

### Task 3: Lock the image and operator contract

**Files:**

- Modify: `python/tests/deployment/test_container_contract.py`
- Modify: `docs/operations/stage1-parity-sampling.md`
- Modify: `BLUEPRINT.md`

**Interfaces:**

- Consumes: source-only flag and shared constants from Tasks 1–2.
- Produces: static deployment guardrails and operator documentation.

- [ ] **Step 1: Add a failing static contract test**

Add assertions that inspect repository source without executing Scout and prove:

- the real parity reference command includes `--source-reference-only`;
- the pipeline recognizes the exact flag;
- the shared source budget is 30 minutes;
- the overhead reserve is 5 minutes;
- the supervisor deadline is derived from their sum;
- the old literal `15 * 60_000` is not the production default.

Keep this test structural and narrow. Do not duplicate TypeScript behavior tests
or inspect any operational environment.

- [ ] **Step 2: Prove RED**

Run from Windows:

```powershell
uv run --project python python -m pytest -q python/tests/deployment/test_container_contract.py
```

Expected: the new assertions fail before the final documentation/contract wiring.

- [ ] **Step 3: Update the parity runbook**

Document:

- the isolated reference uses the internal source-reference-only mode;
- successful reference completion ends after seed, required `trace_source`, and
  summary;
- later comments, dossier, footage, figures, and full validation are outside the
  parity reference;
- source-stage budget is 30 minutes and supervisor deadline is 35 minutes;
- exit zero and clean teardown remain necessary but not sufficient—external
  artifact validation and nine-field comparison still decide parity;
- no retry follows timeout without separate operator authorization.

Do not add a fixture, digest, secret, private identifier, or evidence value.

- [ ] **Step 4: Update BLUEPRINT**

Add one dated Stage 1 checkpoint describing the offline corrective behavior and
its non-goals. Do not mark p5 passing, the parity gate complete, or an acceptance
window open.

- [ ] **Step 5: Prove GREEN**

Run:

```powershell
uv run --project python python -m pytest -q python/tests/deployment/test_container_contract.py
```

- [ ] **Step 6: Commit Task 3**

```bash
git add python/tests/deployment/test_container_contract.py docs/operations/stage1-parity-sampling.md BLUEPRINT.md
git commit -m "docs: define parity completion contract"
```

Completion criterion: source, image, and operator documentation agree on the
same completion and budget boundary.

---

### Task 4: Run offline verification on source and candidate image

**Files:**

- Verify only: all files changed by Tasks 1–3
- Local image tag: `thoth-stage1:parity-completion-corrective`

**Interfaces:**

- Consumes: completed implementation commits.
- Produces: offline verification evidence and independent-review handoff.

- [ ] **Step 1: Run focused and full Scout gates**

```bash
cd scout
bun pipeline/run_pipeline_acquisition.test.ts
bun test runtime/parity_reference_contract.test.ts runtime/parity_reference.test.ts
bun run test:runtime
bun run test:acquisition
bun run typecheck
```

Report actual pass/fail counts. Do not suppress failures.

- [ ] **Step 2: Run Python quality and deployment gates**

From Windows:

```powershell
uv run --project python python -m pytest -q python/tests/deployment
uv run --project python ruff check python
uv run --project python ruff format --check python
```

If WSL verification is needed, every command must use:

```bash
UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv" \
uv run --project /mnt/c/Users/mfr/Documents/MyTools/CLIPPER/python --frozen ...
```

Never run bare WSL `uv run --project python` and never modify `python/.venv`.

- [ ] **Step 3: Run the required repository build**

Run the project-prescribed CUDA build from PowerShell. Keep any build log outside
Git or remove only a log created by this task after reading its exit status:

```powershell
cmd /c ".\build_cuda.bat build_log.txt 2>&1"
```

Require exit zero before claiming the implementation complete.

- [ ] **Step 4: Build one local candidate image**

From the WSL repository path:

```bash
docker build --platform linux/amd64 --tag thoth-stage1:parity-completion-corrective .
```

No registry tag, login, push, or publication. Do not use deployment environment
files or Compose projects.

- [ ] **Step 5: Run only offline container harnesses**

```bash
docker/test-cdp-offline.sh thoth-stage1:parity-completion-corrective
docker/test-parity-offline.sh thoth-stage1:parity-completion-corrective
```

Require all documented harness booleans true and no leftover harness container,
network, or volume. These harnesses must use local/synthetic pages only and must
not contact TikTok or a provider.

- [ ] **Step 6: Verify repository integrity**

```bash
git diff --check
git status --short --branch
git log -4 --format='%h %s'
```

Require a clean worktree. Verify every new commit has one subject line, no body,
and no prohibited attribution. Do not rewrite prior commits.

- [ ] **Step 7: Stop at independent review**

Report the candidate image ID, test counts, exact commits, limitations, and hard
stops honored. Do not push, deploy, run a live pair, mutate evidence, or enter the
next gate.

Completion criterion: offline source and candidate-image gates pass, the
worktree is clean, and the result is ready for independent review only.
