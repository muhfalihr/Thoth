# Stage 1 Legacy Fallback Target Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavioral change and `superpowers:verification-before-completion` before each commit and final report.

**Goal:** Make each production legacy Scout fallback use and remove its own CDP page target while leaving the sidecar health page unchanged and stopping Scout at the source-reference boundary.

**Architecture:** A runtime target lease uses the relay's already-allowed browser WebSocket to create one `about:blank` page. A supervisor passes that exact target ID to the Scout child, runs the source-only command, reaps the child, and closes the leased page before returning. The Python activity invokes only this supervisor and retains outer timeout, redaction, and process-group ownership.

**Tech Stack:** Bun/TypeScript, Chrome DevTools Protocol, Python 3.12/asyncio, pytest, Docker Engine/Compose, Bash, Ruff.

**Spec:** `docs/superpowers/specs/2026-09-09-stage1-legacy-fallback-target-isolation-design.md`

## Global constraints

- Run every shell command through `rtk`; WSL commands use outer `rtk wsl ...`.
- Use Docker only. Do not invoke Podman.
- Keep the production sidecar healthcheck, relay host exposure, worker mode, provider wiring, and `seccomp:unconfined` placement unchanged.
- Preserve `LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES = 1`, the five-minute Python/Temporal fallback timeout, and all existing process-tree termination behavior.
- Emit only fixed error codes. Never print a fixture URL, target ID, WebSocket URL, page title, credential, provider response, raw protocol frame, or raw child output.
- Do not add retries, restore a navigated health page, or launch Chromium inside the worker.
- Do not inspect or change the deployed stack, real fixture, provider secret, restricted evidence, observation data, S3, or Issue #5.
- Do not push, publish, deploy, retry p6, run controlled fallback, or open an acceptance window.
- Commit messages are one concise subject line with no body or attribution trailer.

---

### Task 1: Centralize CDP target validation and exact target selection

**Files:**

- Create: `scout/lib/cdp_target.ts`
- Create: `scout/lib/cdp.test.ts`
- Modify: `scout/lib/cdp.ts`
- Modify: `scout/runtime/cdp_relay.ts`
- Modify: `scout/runtime/cdp_relay.test.ts`

**Interfaces:**

- Produces `isCdpTargetId(value: unknown): value is string` and `parseDevtoolsTargetPath(path: string): { kind: 'page' | 'browser'; targetId: string } | null`.
- Produces `selectCdpTarget(targets: readonly CdpTarget[], options: ConnectOpts, ownedTargetId?: string): CdpTarget`.
- `connect()` consumes optional `process.env.THOTH_CDP_TARGET_ID`; absence preserves current matching behavior.
- The relay consumes the shared path parser instead of maintaining a second target-ID grammar.

- [ ] **Step 1: Write target grammar tests**

Create table-driven tests in `scout/lib/cdp.test.ts` with literal valid IDs (`page-1`, `A_b.9`) and invalid values (empty, slash, query, whitespace, 129 characters). Assert the path parser accepts only `/devtools/page/<id>` and `/devtools/browser/<id>` and returns the literal kind and ID.

- [ ] **Step 2: Write exact-selection regression tests**

Use literal target arrays containing a health page first and a leased page second. Assert:

```ts
expect(selectCdpTarget(targets, { match: 'tiktok.com' }, 'leased-2').id).toBe('leased-2');
expect(() => selectCdpTarget(targets, {}, 'missing')).toThrow('owned_cdp_target_unavailable');
expect(() => selectCdpTarget(targets, {}, '../bad')).toThrow('owned_cdp_target_invalid');
```

Also assert an absent owned ID retains the existing hostname match, `requireMatch`, and fallback-page behavior.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
rtk bun test scout/lib/cdp.test.ts scout/runtime/cdp_relay.test.ts
```

Expected: the new test file fails because the shared helpers and exact-target selector do not exist.

- [ ] **Step 4: Implement the shared grammar and selector**

Use a closed grammar equivalent to the existing relay constraint:

```ts
const CDP_TARGET_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isCdpTargetId(value: unknown): value is string {
  return typeof value === 'string' && CDP_TARGET_ID.test(value);
}
```

`selectCdpTarget()` must validate and select the owned ID before applying any hostname matching. It must require `type === 'page'` and a string `webSocketDebuggerUrl`. It must throw fixed relay errors without embedding rejected values.

Read `THOTH_CDP_TARGET_ID` inside `connect()`, not at module import time, so tests and subprocess scoping remain deterministic.

Replace the relay's private `DEVTOOLS_PATH` parsing with `parseDevtoolsTargetPath()` while preserving route, kind, current-discovery, and session-limit rules.

- [ ] **Step 5: Run focused and runtime tests and verify GREEN**

Run:

```powershell
rtk bun test scout/lib/cdp.test.ts scout/runtime/cdp_relay.test.ts
rtk bun run --cwd scout test:runtime
rtk bun run --cwd scout typecheck
```

Expected: all commands exit zero with no new warnings.

- [ ] **Step 6: Commit Task 1**

```powershell
rtk git add scout/lib/cdp_target.ts scout/lib/cdp.ts scout/lib/cdp.test.ts scout/runtime/cdp_relay.ts scout/runtime/cdp_relay.test.ts
rtk git diff --cached --check
rtk git commit -m "fix: select leased CDP targets"
```

---

### Task 2: Add an owned CDP page-target lease

**Files:**

- Create: `scout/runtime/cdp_target_lease.ts`
- Create: `scout/runtime/cdp_target_lease.test.ts`

**Interfaces:**

- Produces:

```ts
export interface CdpTargetLease {
  readonly targetId: string;
  close(): Promise<void>;
}

export interface BrowserTargetSession {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface CdpTargetLeaseDeps {
  discoverBrowser(): Promise<{ webSocketDebuggerUrl: string }>;
  discoverPages(): Promise<readonly CdpTarget[]>;
  openBrowserSession(url: string): Promise<BrowserTargetSession>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export async function acquireCdpTargetLease(
  deps?: CdpTargetLeaseDeps,
): Promise<CdpTargetLease>;
```

- The production dependency uses `THOTH_CDP`, `/json/version`, `/json`, and the browser WebSocket. It never derives authority from browser output.
- Later tasks consume only `targetId` and idempotent `close()`.

- [ ] **Step 1: Write lease creation and readiness tests**

Use a fake browser session with recorded methods and literal responses. Prove `Target.createTarget` receives exactly `{ url: 'about:blank' }`, a valid returned ID is required, and discovery is polled until the exact page appears.

- [ ] **Step 2: Write cleanup and bounded-failure tests**

Prove:

- two `close()` calls issue `Target.closeTarget` once;
- `{ success: false }`, malformed response, timeout, and thrown command reject with `cdp_target_cleanup_failed`;
- readiness exhaustion attempts `Target.closeTarget` before rejecting with `cdp_target_unavailable`;
- browser-session `close()` runs after both successful cleanup and acquisition failure;
- no thrown message contains a fake URL, target ID, or upstream exception canary.

- [ ] **Step 3: Run the lease tests and verify RED**

```powershell
rtk bun test scout/runtime/cdp_target_lease.test.ts
```

Expected: failure because `acquireCdpTargetLease` is missing.

- [ ] **Step 4: Implement the minimal lease**

Implement one browser command session with monotonically increasing message IDs, a fixed command timeout, and listener cleanup. Validate `/json/version` as an object containing a browser WebSocket whose pathname passes the shared browser target parser. Rewrite only the authority to the configured relay authority, matching existing relay discovery semantics.

After `Target.createTarget`, poll `/json` on a fixed short interval until the new page is visible. On every post-allocation failure, attempt close before throwing the fixed primary code. Make `close()` idempotent by retaining its first promise rather than a boolean that could race.

- [ ] **Step 5: Rerun the TypeScript tests and verify GREEN**

```powershell
rtk bun test scout/runtime/cdp_target_lease.test.ts scout/lib/cdp.test.ts scout/runtime/cdp_relay.test.ts
rtk bun run --cwd scout test:runtime
rtk bun run --cwd scout typecheck
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit Task 2**

```powershell
rtk git add scout/runtime/cdp_target_lease.ts scout/runtime/cdp_target_lease.test.ts
rtk git diff --cached --check
rtk git commit -m "feat: add CDP target leases"
```

---

### Task 3: Supervise the legacy fallback child and target as one lifecycle

**Files:**

- Create: `scout/runtime/legacy_fallback.ts`
- Create: `scout/runtime/legacy_fallback.test.ts`
- Create: `scout/runtime/legacy_fallback_smoke.ts`

**Interfaces:**

- Produces `parseLegacyFallbackArgs(argv: string[]): LegacyFallbackArgs`.
- Produces `legacyFallbackCommand(args: LegacyFallbackArgs): string[]`.
- Produces `runLegacyFallback(options: LegacyFallbackOptions, deps: LegacyFallbackDeps): Promise<number>`.
- Production status contract: invalid arguments `64`, target/cleanup failure `70`, `SIGINT` `130`, `SIGTERM` `143`, otherwise the Scout child status.
- Production child environment contains the inherited environment plus only the acquired `THOTH_CDP_TARGET_ID` override.

- [ ] **Step 1: Write parser and command tests**

Prove the production form accepts only:

```text
--url <canonical-url> --out <absolute-report-path>
```

and the two test-only forms accept only `--offline-smoke` and `--offline-smoke-failure`. Reject duplicates, missing values, extra flags, and mixed live/offline arguments with `invalid_arguments` without echoing a rejected value.

Assert the production child command is exactly:

```ts
[
  'bun',
  'scout/cli.ts',
  'run',
  canonicalUrl,
  '--out',
  reportPath,
  '--source-reference-only',
]
```

- [ ] **Step 2: Write lifecycle and exit-precedence tests**

Use a real deferred promise for the fake child and a lease whose `close()` records ordering. Prove:

- the lease is acquired before spawn;
- child environment contains the exact leased ID;
- child zero is returned only after lease close;
- child nonzero is propagated after lease close;
- spawn failure still closes the lease and returns `70`;
- cleanup failure returns `70` over child zero or nonzero;
- `SIGINT`/`SIGTERM` forward to the child, reap it, close the lease, and return `130`/`143`;
- forced kill follows the existing bounded grace when the child ignores termination;
- fixed stderr codes contain none of the synthetic URL, ID, provider, or exception canaries.

- [ ] **Step 3: Run supervisor tests and verify RED**

```powershell
rtk bun test scout/runtime/legacy_fallback.test.ts
```

Expected: failure because the supervisor module does not exist.

- [ ] **Step 4: Implement the supervisor**

Model the child as:

```ts
interface OwnedChild {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}
```

Use an `AbortSignal` for handled process signals. Acquire the lease, spawn once, race child exit against shutdown, terminate/reap if shutdown wins, then await lease cleanup. Keep one cleanup `finally` path. Do not add an acquisition deadline: the Python activity remains the outer five-minute owner.

The smoke child must connect through normal `scout/lib/cdp.ts`, require its exact leased target from the environment, navigate only to `about:blank#legacy-fallback-smoke`, evaluate a literal expression, and exit with either zero or the fixed injected failure code. It must not read a fixture or provider environment.

- [ ] **Step 5: Run supervisor and regression suites and verify GREEN**

```powershell
rtk bun test scout/runtime/legacy_fallback.test.ts scout/runtime/cdp_target_lease.test.ts scout/lib/cdp.test.ts
rtk bun run --cwd scout test:runtime
rtk bun run --cwd scout test:acquisition
rtk bun run --cwd scout typecheck
```

Expected: all commands exit zero.

- [ ] **Step 6: Commit Task 3**

```powershell
rtk git add scout/runtime/legacy_fallback.ts scout/runtime/legacy_fallback.test.ts scout/runtime/legacy_fallback_smoke.ts
rtk git diff --cached --check
rtk git commit -m "fix: isolate legacy fallback targets"
```

---

### Task 4: Route the Python adapter through the supervisor

**Files:**

- Modify: `python/src/thoth_control_plane/activities/legacy_scout.py`
- Modify: `python/tests/activities/test_legacy_scout.py`

**Interfaces:**

- `_argv()` produces `bun scout/runtime/legacy_fallback.ts --url <url> --out <path>`.
- The Bun supervisor, not Python, appends `--source-reference-only` and owns the CDP target.
- `inspect()` retains its current report, timeout, cancellation, process-group, heartbeat, checksum, and redaction behavior.

- [ ] **Step 1: Change the command-contract test only**

Update the existing registered-command test to expect:

```python
(
    "bun",
    "scout/runtime/legacy_fallback.ts",
    "--url",
    "https://example.test/source/123",
    "--out",
    str(tmp_path / "legacy-scout/wf_legacy_scout_001/source-report.json"),
)
```

Retain its real report materialization assertions.

- [ ] **Step 2: Run the focused Python test and verify RED**

```powershell
rtk uv run --project python pytest python/tests/activities/test_legacy_scout.py -q
```

Expected: only the command-contract assertion fails because `_argv()` still points at `scout/cli.ts`.

- [ ] **Step 3: Implement the minimal `_argv()` change**

Replace only the fixed command tuple. Do not change `inspect()`, timeout values, result models, or diagnostic redaction.

- [ ] **Step 4: Run focused, workflow, and lint checks and verify GREEN**

```powershell
rtk uv run --project python pytest python/tests/activities/test_legacy_scout.py python/tests/workflows/test_source_investigation.py -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit Task 4**

```powershell
rtk git add python/src/thoth_control_plane/activities/legacy_scout.py python/tests/activities/test_legacy_scout.py
rtk git diff --cached --check
rtk git commit -m "fix: route fallback through target supervisor"
```

---

### Task 5: Prove target preservation in the real Docker topology

**Files:**

- Create: `scout/runtime/legacy_fallback_harness.ts`
- Create: `scout/runtime/legacy_fallback_harness.test.ts`
- Modify: `docker/test-cdp-offline.sh`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- `legacy_fallback_harness.ts` snapshots page targets privately, spawns the production supervisor in each offline mode, then reports only fixed boolean names.
- `docker/test-cdp-offline.sh IMAGE` invokes the harness from a sibling container on the existing internal test network.
- Output adds no IDs or URLs and preserves existing fixed harness lines.

- [ ] **Step 1: Write harness behavior tests**

Inject literal before/during/after target snapshots and a fake supervisor child. Prove the harness rejects:

- the original page missing or changed after a run;
- no distinct page appearing while the child is active;
- a temporary page remaining after child zero;
- a temporary page remaining after injected child failure;
- a child status different from the expected zero/fixed failure status.

Assert successful results contain only:

```json
{
  "initial_target_preserved": true,
  "temporary_target_observed": true,
  "success_target_removed": true,
  "failure_target_removed": true
}
```

- [ ] **Step 2: Run the harness tests and verify RED**

```powershell
rtk bun test scout/runtime/legacy_fallback_harness.test.ts
```

Expected: failure because the harness module is missing.

- [ ] **Step 3: Implement the offline harness and Docker invocation**

Keep target IDs and URLs only in process memory. Start the production supervisor as a subprocess twice: once with `--offline-smoke`, once with `--offline-smoke-failure`. Poll `/json` only long enough to observe the leased page. Compare literal fields in memory and emit the four fixed booleans after both children finish.

Extend `docker/test-cdp-offline.sh` after its existing HTTP and WebSocket checks. Reuse the already-started browser and internal network. Assert every fixed boolean is true, then run the existing cleanup trap. Do not display service logs on success or failure.

Add container contract assertions by executing or parsing the real shipped harness interface, not by checking for an arbitrary source string.

- [ ] **Step 4: Run source-level tests and verify GREEN**

```powershell
rtk bun test scout/runtime/legacy_fallback_harness.test.ts scout/runtime/legacy_fallback.test.ts scout/runtime/cdp_target_lease.test.ts
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
rtk bun run --cwd scout test:runtime
rtk bun run --cwd scout typecheck
```

Expected: all commands exit zero.

- [ ] **Step 5: Run all non-live repository gates**

```powershell
rtk bun run --cwd scout test:runtime
rtk bun run --cwd scout test:acquisition
rtk bun run --cwd scout typecheck
rtk uv run --project python pytest -m "not live" -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
```

Expected: all commands exit zero before any image build begins.

- [ ] **Step 6: Build a local Linux/amd64 candidate image**

Run from WSL so Docker uses the established Linux build path:

```powershell
rtk wsl -e bash -lc 'cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER && docker build --platform linux/amd64 --tag thoth-stage1:legacy-target-corrective .'
```

Expected: exit zero. This local tag is not a release identity and must not be pushed or deployed.

- [ ] **Step 7: Run the real-image offline harnesses**

```powershell
rtk wsl -e bash -lc 'cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER && bash docker/test-cdp-offline.sh thoth-stage1:legacy-target-corrective'
rtk wsl -e bash -lc 'cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER && bash docker/test-parity-offline.sh thoth-stage1:legacy-target-corrective'
```

Expected: both scripts exit zero; all fixed booleans are true; no test-owned container, network, volume, or profile remains.

- [ ] **Step 8: Commit Task 5**

```powershell
rtk git add scout/runtime/legacy_fallback_harness.ts scout/runtime/legacy_fallback_harness.test.ts docker/test-cdp-offline.sh python/tests/deployment/test_container_contract.py
rtk git diff --cached --check
rtk git commit -m "test: verify fallback target isolation"
```

---

### Task 6: Document the corrected contract and close the offline audit trail

**Files:**

- Modify: `docs/operations/stage1-local-docker.md`
- Modify: `BLUEPRINT.md`

**Interfaces:**

- The runbook describes owned page targets, source-only execution, cleanup failure, and the offline proof without claiming live success.
- `BLUEPRINT.md` records actual verified commit/test/image evidence and retains deployment/live gates as pending.

- [ ] **Step 1: Update the runbook**

Document that the health page belongs only to the sidecar health contract. Each worker fallback creates an isolated page through the private relay browser session, selects it by exact ID, stops after source reference, and removes it before returning. State that cleanup failure is nonzero and that unhealthy-sidecar auto-restart behavior is not used as the recovery mechanism.

- [ ] **Step 2: Update `BLUEPRINT.md` from fresh evidence**

Record only commands actually run and their exact results. State explicitly that:

- verification was offline;
- the local candidate tag is not a published digest;
- p6 remains failed and unmodified;
- no deployment, controlled fallback, or acceptance window occurred;
- a future published digest and separately approved live gate remain required.

- [ ] **Step 3: Refresh the code graph**

```powershell
rtk graphify update .
```

Expected: exit zero with the new runtime modules represented in `graphify-out` if that directory is tracked by the repository's existing policy.

- [ ] **Step 4: Run final verification from a clean test state**

```powershell
rtk bun run --cwd scout test:runtime
rtk bun run --cwd scout test:acquisition
rtk bun run --cwd scout typecheck
rtk uv run --project python pytest -m "not live" -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
rtk powershell.exe -NoProfile -Command ".\build_cuda.bat"
rtk git diff --check
```

Expected: every command exits zero. `build_cuda.bat` is mandatory project verification even though this corrective changes no Rust source.

- [ ] **Step 5: Re-run the local image proof if any image input changed after Task 5**

Image inputs include `Dockerfile`, `docker/`, `scout/`, `python/`, Compose smoke files, and files copied by the Docker build. If any changed after the Task 5 image build, rebuild the same local tag and rerun both offline harnesses before committing.

- [ ] **Step 6: Review the final diff against every acceptance criterion**

Check AC1–AC8 in the spec one by one. Confirm no deployed-state, evidence, observation, S3, Issue #5, real fixture, or provider file was touched. Confirm every commit has a one-line subject and no attribution trailer.

- [ ] **Step 7: Commit Task 6**

```powershell
rtk git add docs/operations/stage1-local-docker.md BLUEPRINT.md
rtk git diff --cached --check
rtk git commit -m "docs: record fallback target isolation"
```

- [ ] **Step 8: Produce the operator checkpoint**

Report in Indonesian:

1. baseline, final HEAD, branch, upstream drift, and worktree state;
2. root cause and exact behavioral correction;
3. RED then GREEN evidence for every task;
4. complete final gate counts and exit codes;
5. local image ID/platform and both Docker harness results;
6. security review: health page, relay, ports, sandbox, redaction, cleanup;
7. unchanged p6/evidence/deployment state;
8. limitations, especially that no live fallback success has been demonstrated;
9. next gate: independent review, then separate operator authorization to push and check CI.

Stop after the report. Do not push or proceed to any operational gate.
