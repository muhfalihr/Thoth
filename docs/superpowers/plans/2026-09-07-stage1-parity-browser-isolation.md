# Stage 1 Parity Browser Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> task-by-task. Use superpowers:subagent-driven-development only when explicitly
> delegated. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Scout parity references with an owned ephemeral browser, without
mutating production CDP state.

**Architecture:** A new one-shot reference entrypoint supervises local Chromium
and Scout within one disposable container. Standalone Compose supplies only
per-sample evidence, fixture, and provider inputs; isolated offline image tests
prove lifecycle and absence of production interference.

**Tech Stack:** Existing Bun/TypeScript, Python/pytest, Docker Compose, Chromium,
GitHub Actions; no new package dependencies.

**Spec:** [Parity browser isolation design](../specs/2026-09-07-stage1-parity-browser-isolation-design.md)

## Global constraints

- Implementation is offline only. Preserve current deployment and every old
  observation/reference, including p2 `evidence_incomparable`.
- Capture actual HEAD, branch, upstream, dirty files. Expected reviewed runtime
  baseline is `7ab6e04b3f8814f5e8d590544ae833942b2ce0fc`; inspect drift, never reset.
- Read project instructions and BLUEPRINT. Preserve unrelated changes. Local
  task-owned commits are allowed; push/publication/deployment are separate gates.
- Use Docker, RTK, and equality-form `bun --cwd=scout`. Run Linux tests/builds in
  WSL without replacing the Windows virtualenv. Record exit codes and skips.
- Fresh tmpfs profile only; no production profile/cookie copies or real secrets.
- Same-image requirement remains for eventual Python/reference pairs. A newly
  built reference image cannot be paired with an unchanged old worker image.
- Loopback reference CDP `http://127.0.0.1:18801`, UID/GID `10001:10001`, sandbox
  retained, no ports, restart `no`. Production healthcheck/relay remain unchanged.
- Read the complete spec for deadline, cleanup, path, logging, and authorization
  contracts. Do not replace these with looser behavior for test convenience.

## File ownership map

| File | Responsibility |
| --- | --- |
| `scout/runtime/parity_reference.ts` | Validated reference inputs and browser/Scout lifecycle; no import-time execution. |
| `scout/runtime/parity_reference.test.ts` | Pure boundaries and injected lifecycle tests. |
| `scout/runtime/parity_reference_smoke.ts` | Local-only real Scout CDP client navigation probe. |
| `docker/start-parity-reference` | Fixed launcher argument validation and executable discovery. |
| `Dockerfile` | Install/check the added entrypoint; existing runtime stays intact. |
| `compose.stage1.parity.yml` | Standalone one-shot reference service. |
| `python/src/thoth_control_plane/operations/stage1_parity_preflight.py` | Host input/path/provider validation; no acquisition or writes. |
| `python/tests/deployment/test_stage1_parity_isolation.py` | Compose, image, path, and redaction contracts. |
| `compose.stage1.parity-smoke.yml` | Internal-network offline override and synthetic sentinel. |
| `docker/test-parity-offline.sh` | Disposable real-image lifecycle/isolation evidence. |
| `.github/workflows/container-image.yml` | Add candidate/published-digest parity smoke. |
| `docs/operations/stage1-parity-sampling.md`, `docs/operations/stage1-local-docker.md`, `BLUEPRINT.md` | Operator handoff and truthful implementation status. |

## Task 1: Input boundary and owned runtime lifecycle (AC1, AC3, AC4)

**Files:** Create the two `parity_reference` TypeScript files, smoke client, and
launcher; modify Dockerfile. Keep `legacy_cdp.ts` behavior unchanged.

**Interfaces:** Export `validateReferenceId(value: string): string`,
`referenceOutputPath(id: string): string`, and
`runReference(options: ReferenceOptions, deps: ReferenceDeps): Promise<number>`.
Define the types in that same module:

```typescript
export interface ReferenceOptions {
  chromium: string;
  referenceId: string;
  offlineSmoke: boolean;
  shutdown: AbortSignal;
}
export interface OwnedChild {
  exited: Promise<number>;
  kill(signal?: string): void;
}
export interface ReferenceDeps {
  startBrowser(options: ReferenceOptions): OwnedChild;
  waitReady(signal: AbortSignal): Promise<boolean>;
  startReference(options: ReferenceOptions): OwnedChild;
  writeResult(result: {
    referenceExit: number | null;
    browserExit: number | null;
    cleanupPassed: boolean;
    timedOut: boolean;
    interrupted: boolean;
  }): Promise<void>;
}
```

Keep fixture read, provider env, log handles, and actual subprocesses in the
production dependency constructor, not in test data or console diagnostics.

- [ ] Step 1: Add boundary tests before implementation:

```typescript
import { expect, test } from 'bun:test';
import { referenceOutputPath, validateReferenceId, runReference } from './parity_reference';
test('reference output is contained and independently named', () => {
  expect(referenceOutputPath('ref-p3')).toBe(
    '/opt/thoth/scout/output/legacy-scout/ref-p3/source-report.json');
  for (const id of ['../p3', '/p3', 'a/b', 'A', '']) {
    expect(() => validateReferenceId(id)).toThrow();
  }
});
```

- [ ] Step 2: Run `rtk bun test scout/runtime/parity_reference.test.ts`; record
  missing-export/module RED, not a fixture/network failure.
- [ ] Step 3: Implement validators and fixed path construction:

```typescript
export function validateReferenceId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error('invalid_reference_id');
  return value;
}
export function referenceOutputPath(id: string): string {
  return `/opt/thoth/scout/output/legacy-scout/${validateReferenceId(id)}/source-report.json`;
}
```

- [ ] Step 4: Add injected-child tests for readiness failure (no Scout spawn),
  Scout success/failure, unexpected browser zero/nonzero exit, simultaneous
  browser death and Scout success, TERM/INT during startup/run, deadline, hung
  child escalated to kill, and result-write/cleanup failure. Use deferred promises
  rather than live Chromium; assert child-stop calls and returned codes from the
  spec. A ready/zero-exit representative should use:

```typescript
test('Scout success stops and reaps the owned browser', async () => {
  let finishBrowser!: (code: number) => void;
  const calls: string[] = [];
  const browser = {
    exited: new Promise<number>((resolve) => { finishBrowser = resolve; }),
    kill: (signal = 'SIGTERM') => {
      calls.push(`browser:${signal}`);
      finishBrowser(0);
    },
  };
  const code = await runReference({ chromium: '/test/chrome', referenceId: 'ref-p3',
    offlineSmoke: true, shutdown: new AbortController().signal }, {
    startBrowser: () => browser,
    waitReady: async () => true,
    startReference: () => ({ exited: Promise.resolve(0), kill: () => {} }),
    writeResult: async (result) => { expect(result.cleanupPassed).toBe(true); },
  });
  expect(code).toBe(0);
  expect(calls).toContain('browser:SIGTERM');
});
```

- [ ] Step 5: Implement lifecycle with one deadline abort controller and a
  `finally` teardown. Reuse the existing `chromiumArguments` pure builder with
  `offlineSmoke: true` and the new fixed profile path, not the production
  supervisor/relay. Bind child CDP env explicitly before importing/launching Scout.
  Race tagged outcomes; stop timers and reap children before writing the final
  result and returning. Normal Scout completion owns subsequent browser shutdown.
  Persist raw streams via opened 0600 files, not inherited stdio. All log/result
  open failures stop before acquisition; create output parent exclusively.
- [ ] Step 6: Implement the launcher with existing Chromium glob discovery and
  strict `--check`/`--offline-smoke` parsing. The normal command becomes:

```sh
exec bun /opt/thoth/scout/runtime/parity_reference.ts --chromium "$chromium_path"
```

  `--offline-smoke` appends only that fixed flag. Validate writable profile and
  output directories; the host topology preflight verifies the tmpfs declaration,
  while the image build check uses temporary directories. Fixture/id validation
  occurs only in normal mode. Add the
  entrypoint to Dockerfile with `--chmod=0755 --chown=thoth:thoth` and a non-live
  `--check` build probe using temporary directories, not a live browser.
- [ ] Step 7: Run the new tests, `rtk bun --cwd=scout run test:runtime`,
  `rtk bun --cwd=scout run typecheck`, and targeted Biome checks. Commit only this
  task's files as `feat: isolate parity reference browser lifecycle`.

## Task 2: Standalone topology and preflight (AC2, AC4)

**Files:** Create standalone Compose, Python preflight, deployment test file.
**Interface:** `check_parity_inputs(image: str, sample: Path, provider: Path, *,
repository_root: Path, data_root: Path) -> None`; safe exceptions only. Provide a
module CLI taking the corresponding path arguments, suitable for `python -m`.
It validates inputs and emits booleans, never acquires or provisions credentials.

- [ ] Step 1: Add parametrized tests for image digest/mutable tags, relative or
  repository/data-root-contained sample, symlink escape, unsafe file permissions,
  absent fixture, existing `reference-attempt.json`, provider extras, and conflicting
  CDP. Use `tmp_path` and synthetic keys only. Include this negative test:

```python
def test_mutable_reference_image_is_rejected(tmp_path):
    import pytest
    from thoth_control_plane.operations.stage1_parity_preflight import check_parity_inputs
    with pytest.raises(ValueError):
        check_parity_inputs('ghcr.io/muhfalihr/thoth:latest', tmp_path / 'sample',
                            tmp_path / 'provider.env', repository_root=tmp_path / 'repo',
                            data_root=tmp_path / 'data')
```

- [ ] Step 2: Run the new pytest file and record RED. Implement the preflight
  using `check_stage1_provider_file` and resolved-path containment. Require sample
  0700, provider 0600, fixture 0600 on the host; prepare the container-readable
  fixture copy only in the future approved operator run, under the 0700 parent.
  Distinguish fixture-file permissions from its container-readable copy.
- [ ] Step 3: Write standalone Compose. Required shape:

```yaml
services:
  reference:
    image: ${THOTH_PARITY_IMAGE:?set digest-qualified reference image}
    user: "10001:10001"
    command: ["/opt/thoth/bin/start-parity-reference"]
    restart: "no"
    security_opt: ["seccomp:unconfined"]
    environment:
      THOTH_CDP: http://127.0.0.1:18801
      THOTH_PARITY_REFERENCE_ID: ${THOTH_PARITY_REFERENCE_ID:?set fresh reference id}
      THOTH_SCOUT_PROVIDER: novita
      THOTH_SCOUT_CHAT_PROVIDER: novita
      THOTH_SCOUT_VISION_PROVIDER: novita
      THOTH_SCOUT_EMBED_PROVIDER: novita
    env_file:
      - path: ${THOTH_STAGE1_PROVIDER_ENV_FILE:?set restricted provider file}
        required: true
    tmpfs:
      - /var/lib/thoth/parity-profile:uid=10001,gid=10001,mode=0700
    volumes:
      - type: bind
        source: ${THOTH_PARITY_SAMPLE_DIR:?set external sample directory}/reference-input/url
        target: /run/parity/url
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${THOTH_PARITY_SAMPLE_DIR:?set external sample directory}/scout-output
        target: /opt/thoth/scout/output
        bind:
          create_host_path: false
```

  Keep the implicit project-local network; add no production external network or
  ports. Image tini remains PID 1. Output directory must be non-root-writable,
  initialized by a bounded offline ownership step on only the sample root.
- [ ] Step 4: Capture `docker compose config --format json` in the test process
  with synthetic env, never print it. Assert only `reference` exists; no production
  mounts, ports, host networking, privileged setting, Docker socket, or extra
  provider keys; tmpfs and command match the spec. Assert canaries absent from
  preflight stdout/stderr. Run pytest and commit `feat: define standalone parity container inputs`.

## Task 3: Actual image isolation and CI proof (AC1, AC3, AC5, AC6, AC7)

**Files:** Create smoke client, internal-network smoke overlay, shell harness;
modify workflow and extend deployment tests. Smoke client may be introduced as an
inert module in Task 1; its actual implementation is owned here.
**Interface:** `bash docker/test-parity-offline.sh IMAGE` returns zero only if
transport, isolation, lifecycle, fresh profile, and teardown checks all pass.
Local candidate tags are permitted only for this offline harness.

- [ ] Step 1: Add smoke-contract tests before wiring the new harness into CI.
  Assert PR candidate and published-digest jobs each invoke it, and its test
  network is internal. Record failing tests against the absent harness/workflow.
- [ ] Step 2: Implement local HTTP page + real Scout CDP client probe. A local
  Bun HTTP server uses an ephemeral loopback port and a fixed body. Use:

```typescript
import { connect } from '../lib/cdp';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch: () => new Response('<title>parity-local</title>') });
const client = await connect({ match: 'about:blank', requireMatch: true });
try {
  await client.navigate(`http://127.0.0.1:${server.port}/reference`);
  if (await client.evaluate('6 * 7') !== 42) throw new Error('local_cdp_failed');
} finally { client.close(); await server.stop(true); }
```

  Bound the probe to 10 seconds and emit booleans only. It deliberately leaves
  the reference page on a non-TikTok local URL before teardown. Write a marker in
  the disposable profile; a second invocation must start without that marker.
- [ ] Step 3: Implement the internal test network and a synthetic sentinel
  service, never an actual production container. Record sentinel identity, a
  fixed health marker, and request count; reference must never contact it. Assert
  all remain unchanged after navigation. Preflight tests separately forbid
  production network membership/mounts. No real provider request runs in smoke.
- [ ] Step 4: Implement harness using a unique `stage1-parity-smoke-` project,
  fresh synthetic sample dir, EXIT/INT/TERM traps, and explicit project-owned
  teardown (like `docker/test-cdp-offline.sh`). Retain restricted failure artifacts
  and print their location only. Exercise normal smoke and forced browser death
  in separate disposable runs; signal only Chromium's parent process, excluding
  `--type=` children. Assert nonzero supervisor exit and no surviving owned
  containers/networks. A forced cancellation run must also clean up. Never use
  `docker system prune` or production Compose files.
- [ ] Step 5: Build and execute on Linux, recording real outputs and image ID:

```bash
rtk docker build --platform linux/amd64 -t thoth-stage1:parity-isolation .
rtk bash docker/test-parity-offline.sh thoth-stage1:parity-isolation
rtk bash docker/test-cdp-offline.sh thoth-stage1:parity-isolation
```

- [ ] Step 6: Wire harness into PR `validate-image` using its loaded candidate
  tag and push `stack-smoke` using the published digest. Keep existing CDP and
  infrastructure tests. Do not push to execute CI in this task. Run contract tests
  and commit `test: prove ephemeral parity browser isolation in image CI`.

## Task 4: Operator handoff and final verification (AC8)

**Files:** Update both runbooks and BLUEPRINT; preserve historical evidence.

- [ ] Step 1: Rewrite the new-sample reference procedure to use only standalone
  parity Compose, not a `worker` override. Include digest equality check,
  anonymous-profile limitation, current provider preflight, output ownership,
  no repeated reference ID, and private fixture copy. Show an operator-only
  sequence starting with preflight and ending with sample-owned teardown.
- [ ] Step 2: Document lifecycle-result/log locations, host confirmation of
  profile disposal, and before/after production identity/health checks. Retain
  six integrity checks and nine-field comparison without changing helper/schema.
  Reference exit zero is not a parity pass. A failed comparison remains evidence.
- [ ] Step 3: Add the fresh-profile authentication stop and explicitly separate
  cookie provisioning, fixture replacement, reference retry, production fallback,
  and new window activation. Record that real fallback can still navigate the
  production sidecar: this plan isolates references only. Update BLUEPRINT as
  implemented offline only after actual Task 3 evidence exists.
- [ ] Step 4: Run and record exit codes:

```bash
rtk bun --cwd=scout run test:runtime
rtk bun --cwd=scout run test:acquisition
rtk bun --cwd=scout run typecheck
rtk uv run --project python pytest python/tests -m 'not live' -q
rtk uv run --project python ruff check python
rtk uv run --project python ruff format --check python
rtk git diff --check
```

  Apply applicable project build requirements; if CUDA/host gates cannot run,
  report that explicitly rather than marking them passed. Linux-specific symlink
  and permission checks must execute on Linux, not be counted from Windows skips.
- [ ] Step 5: Review every AC against actual evidence; resolve blocking findings,
  rerun affected tests, commit task-owned docs as
  `docs: hand off isolated parity reference activation`. Report baseline/final
  commits, file diff, skipped gates, lifecycle/isolation proof, limitations, and
  operator boundaries. Stop before push, deployment, or any live gate.

## Self-review and handoff checklist

- [ ] AC1/3/4 map to Tasks 1 and 3; AC2 to Task 2; AC5/6/7 to Task 3; AC8 to Task 4.
- [ ] New interfaces retain the names defined above; snippets are design anchors,
  not evidence that unimplemented functions already exist.
- [ ] Current deployed digest is not changed or presented as containing this work.
- [ ] Profile seeding and production fallback recovery are not silently added.
- [ ] Operator receives the independent offline verdict and the next approval gate.
