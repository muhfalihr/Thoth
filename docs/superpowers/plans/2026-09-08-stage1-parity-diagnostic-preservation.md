# Stage 1 Parity Diagnostic Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve safe structured Scout failure signals across the reference-process boundary and provide a no-enumeration offline attempt summary before p5.

**Architecture:** Scout emits strict allowlisted diagnostic frames into its existing restricted stderr stream. The parity supervisor validates those frames into the atomic attempt record, and a Python operator helper summarizes only the known record with safe booleans and enums.

**Tech Stack:** Bun/TypeScript, Python 3.12, pytest, Ruff, Docker, existing Stage 1 container image; no new package dependencies.

**Spec:** [Stage 1 parity diagnostic preservation design](../specs/2026-09-08-stage1-parity-diagnostic-preservation-design.md)

## Global constraints

- Work from the actual branch without reset. Require `c1db5dd6f48db4aefe14d3b1e9b79513f63c15d5` as an ancestor and inspect all drift after it.
- Keep existing p1-p4 evidence byte-untouched. Implementation and tests use synthetic temporary directories only.
- Preserve discovery return behavior, process exit semantics, cleanup, browser topology, provider selection, and artifact/parity rules.
- Diagnostic frames contain only compile-time enum values. No free-form exception, URL, ID, path, model, provider, response, caption, or secret crosses into structured evidence.
- Use TDD. Every commit is one concise subject line with exactly one `git commit -m`, no body, trailer, or attribution.
- Offline implementation may build a local candidate image and run internal-network smoke tests. It may not push, publish, deploy, access a real fixture/secret, contact TikTok/CDN/provider, mutate Issue #5, or open an acceptance window.

## File ownership map

| File | Responsibility |
| --- | --- |
| `scout/lib/safe_runtime_diagnostic.ts` | Strict diagnostic types, formatter, and parser. |
| `scout/lib/safe_runtime_diagnostic.test.ts` | Wire grammar, limits, allowlist, and canary rejection. |
| `scout/pipeline/trace_source.ts` | Emit distinct profile-discovery signals without changing candidate behavior. |
| `scout/pipeline/trace_source_diagnostic.test.ts` | Injected discovery and terminal-stage diagnostic tests. |
| `scout/pipeline/run_pipeline.ts` | Emit one terminal safe frame when required `trace_source` fails. |
| `scout/runtime/parity_reference.ts` | Parse restricted stderr and atomically include validated events in the attempt record. |
| `scout/runtime/parity_reference.test.ts` | Attempt integration, legacy behavior, malformed frame, size, and canary tests. |
| `python/src/thoth_control_plane/operations/stage1_parity_attempt_summary.py` | Known-path, no-enumeration attempt summary CLI. |
| `python/tests/deployment/test_stage1_parity_attempt_summary.py` | Safe output, legacy, pending, invalid, and sibling-canary tests. |
| `python/tests/deployment/test_container_contract.py` | Runbook contract for the safe summary and p5 authorization boundary. |
| `docs/operations/stage1-parity-sampling.md` | Routine safe-inspection procedure and manual-investigation boundary. |
| `BLUEPRINT.md` | Truthful corrective status and verification evidence. |

---

### Task 1: Strict diagnostic wire contract (AC1)

**Files:**
- Create: `scout/lib/safe_runtime_diagnostic.ts`
- Create: `scout/lib/safe_runtime_diagnostic.test.ts`

**Interfaces:**
- Produces: `SafeRuntimeDiagnostic`, `SAFE_DIAGNOSTIC_PREFIX`, `formatSafeRuntimeDiagnostic()`, and `parseSafeRuntimeDiagnostics()` exactly as specified in the design.
- Consumes: Bun standard library only.

- [ ] **Step 1: Write failing formatter/parser tests**

```typescript
import { expect, test } from 'bun:test';
import {
  formatSafeRuntimeDiagnostic,
  parseSafeRuntimeDiagnostics,
  type SafeRuntimeDiagnostic,
} from './safe_runtime_diagnostic.ts';

const empty: SafeRuntimeDiagnostic = {
  schema_version: 1,
  kind: 'signal',
  stage: 'trace_source',
  category: 'media_candidate_discovery',
  code: 'profile_discovery_empty',
};

test('round trips one allowlisted diagnostic frame', () => {
  const parsed = parseSafeRuntimeDiagnostics(formatSafeRuntimeDiagnostic(empty));
  expect(parsed).toEqual({ events: [empty], valid: true });
});

test('rejects unknown fields and values without returning their text', () => {
  const input = 'THOTH_DIAGNOSTIC {"schema_version":1,"kind":"signal",' +
    '"stage":"trace_source","category":"media_candidate_discovery",' +
    '"code":"private-token","path":"private-path"}\n';
  const parsed = parseSafeRuntimeDiagnostics(input);
  expect(parsed).toEqual({ events: [], valid: false });
  expect(JSON.stringify(parsed)).not.toContain('private-token');
  expect(JSON.stringify(parsed)).not.toContain('private-path');
});
```

- [ ] **Step 2: Run RED**

Run: `rtk bun test scout/lib/safe_runtime_diagnostic.test.ts`

Expected: FAIL because the module or exports do not exist.

- [ ] **Step 3: Implement the exact five-key allowlist**

Implement the type and combination table from the spec. Split input by line, ignore
ordinary lines, parse only exact-prefix frames, and validate own keys with
`Reflect.ownKeys()` so symbol keys are seen and rejected, requiring exactly five keys
— `schema_version`, `kind`, `stage`, `category`, and `code`. Read each value from its
own data-property descriptor, reject accessor descriptors without invoking them, treat
any reflection failure as a rejection, reject duplicates, cap input at 1 MiB and frames
at 32, and return no rejected value.

- [ ] **Step 4: Add boundary tests**

Cover malformed JSON, extra/missing keys, all invalid kind/category/code
combinations, duplicate events, 33 frames, input over 1 MiB, CRLF, ordinary log
text, and URL/path/secret canaries.

- [ ] **Step 5: Run GREEN**

Run: `rtk bun test scout/lib/safe_runtime_diagnostic.test.ts`

Expected: all tests pass with zero network access.

- [ ] **Step 6: Commit**

```bash
git add scout/lib/safe_runtime_diagnostic.ts scout/lib/safe_runtime_diagnostic.test.ts
git commit -m "feat: add safe Scout diagnostic frames"
```

Completion criterion: AC1 is fully covered and the module has no free-form field.

### Task 2: Preserve discovery signals and terminal stage (AC2, AC3)

**Files:**
- Modify: `scout/pipeline/trace_source.ts`
- Modify: `scout/pipeline/run_pipeline.ts`
- Create: `scout/pipeline/trace_source_diagnostic.test.ts`
- Modify: `scout/pipeline/run_pipeline_acquisition.test.ts`

**Interfaces:**
- Consumes: `SafeRuntimeDiagnostic` and `formatSafeRuntimeDiagnostic()` from Task 1.
- Produces: exported `findOriginalTiktokCandidates(username, context, emitDiagnostic?)` with unchanged `Promise<MainCandidate[]>` return type.

- [ ] **Step 1: Write RED discovery tests**

Create injected tests that call `findOriginalTiktokCandidates` with a service whose
`discover()` throws, returns `{ items: [] }`, or returns one synthetic `PostRecord`.
Assert exact signal enums for the first two cases, no signal for the third, and
unchanged returned candidate lists.

- [ ] **Step 2: Run RED**

Run: `rtk bun test scout/pipeline/trace_source_diagnostic.test.ts`

Expected: FAIL because the helper is not exported and has no diagnostic sink.

- [ ] **Step 3: Implement discovery signal emission**

Use this injectable boundary:

```typescript
type DiagnosticSink = (event: SafeRuntimeDiagnostic) => void;

const defaultDiagnosticSink: DiagnosticSink = (event) => {
  console.error(formatSafeRuntimeDiagnostic(event));
};
```

Emit `profile_discovery_exception` inside the existing catch and
`profile_discovery_empty` in the existing empty-items branch. Preserve both
`return []` statements and never pass the caught value to the sink.

- [ ] **Step 4: Write RED required-stage test**

Extend the injected pipeline test so a failing `traceSource` dependency records
exactly one terminal event with `category: 'unknown'` and
`code: 'required_stage_failed'`, then still rejects with the existing failure.

- [ ] **Step 5: Implement terminal emission**

Add an optional diagnostic sink to the pipeline dependency boundary. Wrap only the
required `trace_source` invocation: on failure emit the terminal event, then rethrow
the original failure. Do not classify an earlier discovery signal as terminal
cause.

- [ ] **Step 6: Run focused and acquisition GREEN**

Run:

```bash
rtk bun test scout/pipeline/trace_source_diagnostic.test.ts scout/pipeline/run_pipeline_acquisition.test.ts
rtk bun run test:acquisition
```

Expected: all tests pass; no browser or network request occurs.

- [ ] **Step 7: Commit**

```bash
git add scout/pipeline/trace_source.ts scout/pipeline/run_pipeline.ts scout/pipeline/trace_source_diagnostic.test.ts scout/pipeline/run_pipeline_acquisition.test.ts
git commit -m "fix: preserve Scout discovery diagnostics"
```

Completion criterion: discovery exception, genuine empty discovery, and terminal
stage are distinguishable without changing candidate or failure behavior.

### Task 3: Bind diagnostics into atomic attempt evidence (AC4)

**Files:**
- Modify: `scout/runtime/parity_reference.ts`
- Modify: `scout/runtime/parity_reference.test.ts`

**Interfaces:**
- Consumes: `parseSafeRuntimeDiagnostics()` from Task 1.
- Produces: complete attempt fields `diagnostics_valid: boolean` and
  `diagnostic_events: SafeRuntimeDiagnostic[]`; pending record remains unchanged.

- [ ] **Step 1: Write RED finalization tests**

Use synthetic workspaces and restricted stderr files to prove:

```typescript
expect(finalized).toMatchObject({
  status: 'complete',
  diagnostics_valid: true,
  diagnostic_events: [event],
});
```

Add cases for no frames, malformed prefixed frame, oversized input, read failure,
ordinary free-form errors, duplicate frames, and private canaries. Assert invalid
cases store only `diagnostics_valid: false` and `diagnostic_events: []`.

- [ ] **Step 2: Run RED**

Run: `rtk bun test scout/runtime/parity_reference.test.ts`

Expected: new attempt-field assertions fail.

- [ ] **Step 3: Implement bounded parsing in finalization**

Add `stderrPath` to `ReferenceWorkspace`. Read at most 1 MiB from that exact path
after the Scout child is reaped and before the atomic temporary-write/rename.
Merge only parser output into the complete record. Map any read error to invalid
diagnostics without copying the exception.

- [ ] **Step 4: Prove lifecycle independence**

Keep every existing exit-code and cleanup test unchanged. Add one assertion that
malformed diagnostics cannot alter the reference exit or `cleanupPassed`.

- [ ] **Step 5: Run runtime GREEN**

Run:

```bash
rtk bun test scout/runtime/parity_reference.test.ts
rtk bun run test:runtime
```

Expected: all tests pass, including existing 70/124/130/143 precedence cases.

- [ ] **Step 6: Commit**

```bash
git add scout/runtime/parity_reference.ts scout/runtime/parity_reference.test.ts
git commit -m "feat: record safe parity diagnostics"
```

Completion criterion: current attempts preserve validated frames atomically and
legacy attempts require no rewrite.

### Task 4: No-enumeration offline summary (AC5)

**Files:**
- Create: `python/src/thoth_control_plane/operations/stage1_parity_attempt_summary.py`
- Create: `python/tests/deployment/test_stage1_parity_attempt_summary.py`

**Interfaces:**
- Consumes: one known attempt record and the same reference-ID regex.
- Produces: `_summarize_attempt(sample: Path, reference_id: str) -> dict[str, object]`
  and a CLI emitting exactly one compact JSON line.

- [ ] **Step 1: Write RED helper tests**

Use `tmp_path` to cover missing, pending, legacy-complete, current-valid,
current-invalid, nonzero-exit, cleanup-failure, invalid reference ID, symlinked
attempt path, and unreadable JSON. Put URL, path, post-ID, credential, filename,
and raw-error canaries in sibling files and extra JSON fields. Capture both streams
and assert every canary is absent.

- [ ] **Step 2: Run RED**

Run:

```bash
rtk uv run --project python python -m pytest python/tests/deployment/test_stage1_parity_attempt_summary.py -q
```

Expected: collection/import failure because the helper does not exist.

- [ ] **Step 3: Implement strict known-path reading**

Validate the identifier before path construction. Resolve and contain the expected
attempt path beneath the supplied sample. Reject symlinks. Open only the expected
attempt record, validate required field types and diagnostic enums, and construct
the exact output object from the spec. Catch filesystem/JSON errors and emit fixed
safe states only.

- [ ] **Step 4: Run GREEN and Ruff**

Run:

```bash
rtk uv run --project python python -m pytest python/tests/deployment/test_stage1_parity_attempt_summary.py -q
rtk uv run --project python ruff check python/src/thoth_control_plane/operations/stage1_parity_attempt_summary.py python/tests/deployment/test_stage1_parity_attempt_summary.py
rtk uv run --project python ruff format --check python/src/thoth_control_plane/operations/stage1_parity_attempt_summary.py python/tests/deployment/test_stage1_parity_attempt_summary.py
```

Expected: all tests and checks pass without reading sibling evidence.

- [ ] **Step 5: Commit**

```bash
git add python/src/thoth_control_plane/operations/stage1_parity_attempt_summary.py python/tests/deployment/test_stage1_parity_attempt_summary.py
git commit -m "feat: add safe parity attempt summary"
```

Completion criterion: routine inspection needs no directory listing or raw log.

### Task 5: Operator contract and full offline verification (AC6, AC7)

**Files:**
- Modify: `docs/operations/stage1-parity-sampling.md`
- Modify: `BLUEPRINT.md`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**
- Consumes: Task 1-4 behavior.
- Produces: one documented routine summary command and an explicit p5 hard stop.

- [ ] **Step 1: Write documentation contract assertions first**

Extend the existing deployment contract test that owns the parity runbook. Assert
the summary module name, `diagnostic_contract`, `terminal_stage`, and the rule that
routine inspection uses the summary rather than enumeration or raw-log display.

- [ ] **Step 2: Run documentation RED**

Run the exact modified pytest node and verify it fails on the absent documentation.

- [ ] **Step 3: Update the runbook and BLUEPRINT**

Document current versus legacy attempts, the safe enum contract, the exact summary
invocation, the observation/inference boundary, the p3/p4 immutability rule, and
the operator authorization still required for p5. Mark implementation complete
only after every gate below passes.

- [ ] **Step 4: Run all non-container gates**

```bash
rtk bun test scout/lib/safe_runtime_diagnostic.test.ts scout/pipeline/trace_source_diagnostic.test.ts scout/pipeline/run_pipeline_acquisition.test.ts scout/runtime/parity_reference.test.ts
rtk bun run test:runtime
rtk bun run test:acquisition
rtk bun run typecheck
rtk uv run --project python python -m pytest python/tests/deployment -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
```

- [ ] **Step 5: Run the required CUDA build**

From Windows PowerShell:

```powershell
rtk proxy cmd /c build_cuda.bat
```

Expected: exit 0 with no critical warnings.

- [ ] **Step 6: Build and verify a non-live candidate image**

From WSL with Docker:

```bash
rtk docker build --platform linux/amd64 --tag thoth-stage1:diagnostic-corrective .
rtk docker run --rm --network none --entrypoint /opt/thoth/python/.venv/bin/python thoth-stage1:diagnostic-corrective -m thoth_control_plane.operations.stage1_parity_attempt_summary --help
rtk bash docker/test-parity-offline.sh thoth-stage1:diagnostic-corrective
```

Expected: image build succeeds, helper is present, and the offline smoke reports all
existing booleans true without a live request.

- [ ] **Step 7: Run final hygiene checks**

```bash
rtk git diff --check
rtk git status --short
```

Review every changed file against AC1-AC7 and confirm no evidence, fixture, secret,
Issue, deployment, or live gate was touched.

- [ ] **Step 8: Commit documentation**

```bash
git add docs/operations/stage1-parity-sampling.md BLUEPRINT.md python/tests/deployment/test_container_contract.py
git commit -m "docs: document safe parity diagnostics"
```

Completion criterion: every offline gate passes on current HEAD, local commits are
concise, worktree is clean, and the executor stops for independent review without
push or deployment.
