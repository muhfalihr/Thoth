# Stage 1 Scout Runtime Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:subagent-driven-development` if the operator explicitly delegates implementation. Track steps with checkboxes.

**Goal:** Deliver a reproducible compatibility image with both required downloaders, reachable private CDP, and explicit provider configuration for references and fallback.

**Architecture:** Retain six production services and one THOTH image. A Bun runtime supervises Chromium and relays private CDP discovery/WebSockets; a worker-only provider Compose override shares configuration with one-off references. An isolated two-container test proves transport without contacting public services.

**Tech Stack:** Python 3.12, uv lock, Bun 1.3.14, Chromium from Scrapling, Docker Compose, pytest, Bun tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-06-stage1-scout-runtime-corrective-design.md`

## Global Constraints

- Scope approved for document preparation; implementation follows the operator's executor handoff.
- Baseline at drafting: `671a18060308e1ef84429d98bf3ae64f6e9f1cc9`. Capture actual execution HEAD and drift first.
- Preserve the pre-existing edit to `docs/operations/stage1-parity-sampling.md`; do not reset it or include it blindly in a checkpoint.
- Python TikTok remains Scrapling headless first, TikWM/CDN second; mode remains `python_tiktok_with_legacy_fallback`.
- Images use gallery-dl; existing video/probe paths use yt-dlp. No other platform migration or metadata-contract changes.
- Pin `gallery-dl==1.32.11` and `yt-dlp==2026.8.19` in extra `scout-runtime` and the lock.
- Sidecar relay `0.0.0.0:18800`, Chromium `127.0.0.1:18801`, advertised `http://legacy-cdp:18800`; no host ports.
- Keep UID/GID `10001:10001`, tini, persistent production browser profile, and sidecar-only seccomp relaxation.
- No reads of real `.env`, provider key files, fixture files, or observation datasets during implementation.
- Only isolated builds and offline test containers are authorized; no live/default launcher on the existing stack.
- No push, deployment, operational restart, observation edits, S3 upload, rollback drill, human approval entry, or Task 10.
- Use `rtk` per project instructions; if unavailable, report it once and use the underlying command. Run Linux checks in WSL without reusing a Windows venv.

## File map and dependency order

| Task | Files and responsibility |
| --- | --- |
| 1 | `python/pyproject.toml`, `python/uv.lock`, `Dockerfile`, `python/tests/deployment/test_container_contract.py`: locked downloader runtime |
| 2 | New `scout/runtime/cdp_relay.ts`, `scout/runtime/cdp_relay.test.ts`, `scout/runtime/legacy_cdp.ts`, `scout/runtime/legacy_cdp.test.ts`; modify `docker/start-legacy-cdp`: transport and lifecycle |
| 3 | New `compose.stage1.providers.yml`, `.env.stage1.providers.example`, `scout/runtime/provider_check.ts`, `scout/runtime/provider_check.test.ts`, `python/src/thoth_control_plane/operations/stage1_provider_preflight.py`, `python/tests/deployment/test_stage1_provider_preflight.py`; modify existing preflight/CLI, ignore rules and runbooks: provider boundary |
| 4 | New `compose.stage1.cdp-smoke.yml`, `scout/runtime/cdp_smoke.ts`, `docker/test-cdp-offline.sh`; modify workflow and deployment tests: real-image CI transport proof |
| 5 | Operations docs, both related local specs/plans, `BLUEPRINT.md`: reconciliation, release handoff, final verification |

Tasks 1 and 2 feed 4. Task 3 must pass before fallback-ready deployment can be documented. Task 5 reviews the complete candidate. Do not create worktrees that omit the operator's uncommitted runbook correction; either continue carefully on the requested branch or carry an explicitly scoped copy into isolation without modifying the source.

### Task 1: Install the actual compatibility downloaders

**Interfaces:** `GALLERY_DL=/opt/thoth/python/.venv/bin/gallery-dl` and `YTDLP=/opt/thoth/python/.venv/bin/yt-dlp` are executable under the final non-root user. Production callers and ordering stay unchanged.

- [ ] Step 1: Add a failing container contract test in `python/tests/deployment/test_container_contract.py` asserting the new extra is locked, both Docker sync invocations request it, and final-user version probes exist. Pair this source contract with actual image execution in step 4; a source-string assertion alone is not acceptance.

```python
import tomllib
from pathlib import Path

def test_scout_runtime_downloader_versions_are_exact():
    root = Path(__file__).resolve().parents[3]
    project = tomllib.loads((root / "python/pyproject.toml").read_text())
    assert project["project"]["optional-dependencies"]["scout-runtime"] == [
        "gallery-dl==1.32.11", "yt-dlp==2026.8.19"
    ]
```

- [ ] Step 2: Run the focused test and record the missing-extra RED.

```bash
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

- [ ] Step 3: Add the extra, update the lock with `uv lock --project python`, and add `--extra scout-runtime` to both existing frozen Docker sync commands. Add the two absolute-path environment variables. Add the probes below to the post-USER build layer. Inspect lock changes; retain existing resolved acquisition packages unless the resolver demonstrates a conflict. Do not use `--upgrade`.

```dockerfile
ENV GALLERY_DL=/opt/thoth/python/.venv/bin/gallery-dl \
    YTDLP=/opt/thoth/python/.venv/bin/yt-dlp
RUN test -x "$GALLERY_DL" && test -x "$YTDLP" \
    && test "$("$GALLERY_DL" --version)" = "1.32.11" \
    && test "$("$YTDLP" --version)" = "2026.08.19"
```

The Python distribution version normalizes to `2026.8.19`; verify the CLI's actual padded version string while building. If it differs, match installed package metadata to the pinned distribution and separately assert successful `--version` output; do not change package versions to satisfy a string.

- [ ] Step 4: Run focused tests, existing acquisition policies, and a local image build. Use a unique task tag and no real env file.

```bash
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
rtk bun --cwd=scout run test:acquisition
rtk docker build --platform linux/amd64 -t thoth-stage1:runtime-corrective .
rtk docker run --rm --entrypoint /opt/thoth/python/.venv/bin/gallery-dl thoth-stage1:runtime-corrective --version
rtk docker run --rm --entrypoint /opt/thoth/python/.venv/bin/yt-dlp thoth-stage1:runtime-corrective --version
```

- [ ] Step 5: Review diff and commit only task-owned files as `build: pin Scout image and video downloaders`.

### Task 2: Relay CDP and supervise Chromium

**Interfaces:**

```typescript
// scout/runtime/cdp_relay.ts
export function rewriteDiscovery(value: unknown, advertisedBase: URL): unknown;
export function isAllowedDiscoveryPath(path: string): boolean;
export type RelayHandle = { port: number; stop(): Promise<void> };
export function startCdpRelay(options: {
  upstreamBase: URL;
  advertisedBase: URL;
  hostname: string;
  port: number;
}): RelayHandle;
```

`startCdpRelay` is injectable for loopback fake-server tests; production wrapper supplies only the fixed private endpoints from the spec. It tracks IDs from successful discovery and exposes only those WS routes. The module has no import-time listener or browser startup.

- [ ] Step 1: Write Bun unit tests for discovery and route rejection. Use an upstream fake HTTP/WS server for forwarding, buffer limits, timeouts, unexpected close, and error redaction; no public endpoints. Representative first RED:

```typescript
import { expect, test } from 'bun:test';
import { isAllowedDiscoveryPath, rewriteDiscovery } from './cdp_relay';

test('discovery advertises the sibling-reachable authority', () => {
  const target = { type: 'page', url: 'about:blank',
    webSocketDebuggerUrl: 'ws://127.0.0.1:18801/devtools/page/test-id' };
  expect(rewriteDiscovery([target], new URL('http://legacy-cdp:18800'))).toEqual([
    { ...target, webSocketDebuggerUrl: 'ws://legacy-cdp:18800/devtools/page/test-id' }
  ]);
});

test('relay is not an arbitrary proxy', () => {
  expect(isAllowedDiscoveryPath('/json/version')).toBe(true);
  expect(isAllowedDiscoveryPath('/json/list')).toBe(true);
  expect(isAllowedDiscoveryPath('/json')).toBe(true);
  expect(isAllowedDiscoveryPath('/json/new?https://example.invalid')).toBe(false);
  expect(isAllowedDiscoveryPath('http://example.invalid/json')).toBe(false);
});
```

- [ ] Step 2: Run `rtk bun test scout/runtime/cdp_relay.test.ts` and record unresolved-module RED.
- [ ] Step 3: Implement the relay with Bun HTTP/WebSocket APIs. Use fixed upstream Host, explicit JSON parsing/rewrite, known target-ID registry, safe error responses, and the exact limits from the spec. Queue downstream frames until upstream opens; do not drop the first CDP command. Ensure disconnect releases timers, queues, and both sockets. Never log browser URLs or payloads. Keep the existing Scout client unchanged.
- [ ] Step 4: Write `legacy_cdp.test.ts` against a harmless child-process stub: clean signal shutdown, browser exits first, relay bind failure, startup timeout, forced kill after grace period, and rejection of unknown startup arguments. Require nonzero exit on browser/relay failure. Run RED before implementing supervisor behavior.
- [ ] Step 5: Implement `legacy_cdp.ts` as the executable wrapper. It accepts only `--chromium <path> --profile <path>` and optional `--offline-smoke`. Use Bun subprocess arrays, never a shell string; browser stderr/stdout are suppressed, exit status becomes a safe code. Launch normal TikTok or `about:blank` solely according to this mode. Refactor launcher argument validation to permit `--check` or `--offline-smoke`, preserving executable discovery and writable-profile checks. After check mode, delegate:

```sh
if [ "$offline_smoke" = true ]; then
    exec bun /opt/thoth/scout/runtime/legacy_cdp.ts \
        --chromium "$chromium_path" --profile "$profile_dir" --offline-smoke
fi
exec bun /opt/thoth/scout/runtime/legacy_cdp.ts \
    --chromium "$chromium_path" --profile "$profile_dir"
```

Initialize `offline_smoke=false` before argument parsing; only the exact single argument `--offline-smoke` sets it. Check mode returns before invoking Bun or Chromium. Runtime validates fixed network endpoints, creates relay only when Chromium discovery is ready, and bounds startup to 30 seconds. Retain the browser's sandbox flags; do not add `--no-sandbox`.

- [ ] Step 6: Run both new Bun test files and the existing launcher/CDP-health deployment tests. Adjust tests that intentionally described the former direct-Chromium exec contract; preserve their substantive non-root, profile, quiet-check, and fail-closed guarantees.

```bash
rtk bun test scout/runtime/cdp_relay.test.ts scout/runtime/legacy_cdp.test.ts
rtk uv run --project python pytest python/tests/deployment -q
```

- [ ] Step 7: Review and commit task files as `fix: relay private CDP discovery and websocket sessions`. Actual Chromium cross-container proof is required in Task 4 before final GO.

### Task 3: Give reference and fallback worker the same provider input

**Interfaces:**

```python
# operations/stage1_provider_preflight.py
def check_stage1_provider_file(path: Path, *, repository_root: Path) -> None:
    """Raise Stage1PreflightError with safe diagnostics for invalid provider input."""
```

Extend `stage1-local-preflight` with optional `--provider-env-file PATH`. Its omission preserves existing non-live behavior; fallback-ready runbook always supplies it. Do not return or print parsed key values.

```typescript
// scout/runtime/provider_check.ts; import providerFor/providerReady from ../lib/env.ts
export function checkReferenceProviders(env: Record<string, string | undefined>): {
  chat: boolean; vision: boolean; embed: boolean; ocrModel: boolean;
};
```

- [ ] Step 1: Add Python tests using temporary files for valid two-variable input, missing/empty/placeholder key, duplicates, unknown names, relative/in-repo paths, symlink into repo, unreadable file, and Linux group/world permissions. Each failure must mention only safe variable/check names. Add CLI test proving a synthetic secret never appears in stdout/stderr. Run focused RED.

```python
def test_provider_file_rejects_extra_environment(tmp_path):
    import pytest
    from thoth_control_plane.operations.stage1_local_preflight import Stage1PreflightError
    from thoth_control_plane.operations.stage1_provider_preflight import check_stage1_provider_file
    candidate = tmp_path / 'provider.env'
    candidate.write_text('THOTH_NOVITA_API_KEY=synthetic-canary-only\n'
                         'THOTH_SUBTITLE_OCR_MODEL=deepseek/deepseek-ocr\n'
                         'AWS_SECRET_ACCESS_KEY=do-not-print-this\n')
    candidate.chmod(0o600)
    with pytest.raises(Stage1PreflightError):
        check_stage1_provider_file(candidate, repository_root=tmp_path / 'repo')
```

- [ ] Step 2: Implement the validator and CLI option. Reuse existing env parser only if it detects duplicates before dictionary insertion; otherwise implement strict parsing in the new module. Admit exactly the two names in spec, require both, reject embedded newlines/NULs and placeholder values, and require an OCR model shaped as a nonempty provider model identifier without whitespace. Resolve paths and verify outside repo; Linux checks require owner-only 0600 permissions. Test platform-specific checks on Linux rather than presenting a Windows skip as proof.
- [ ] Step 3: Add the worker-only override and safe example:

```yaml
services:
  worker:
    env_file:
      - path: ${THOTH_STAGE1_PROVIDER_ENV_FILE:?set restricted provider env file}
        required: true
    environment:
      THOTH_SCOUT_PROVIDER: novita
      THOTH_SCOUT_CHAT_PROVIDER: novita
      THOTH_SCOUT_VISION_PROVIDER: novita
      THOTH_SCOUT_EMBED_PROVIDER: novita
```

```dotenv
THOTH_NOVITA_API_KEY=replace-with-local-secret
THOTH_SUBTITLE_OCR_MODEL=deepseek/deepseek-ocr
```

Document that the example is not a usable provider file. Retain `.dockerignore`'s `.env*` exclusion,
add `/stage1.providers.env` to `.gitignore` and `.dockerignore` as defense in depth, and use an
absolute external path for real files. No real provider key is read or created by this task.

- [ ] Step 4: Add Bun tests for provider-check behavior using explicit synthetic env maps and the existing registry. The executable prints role readiness booleans/model names only and returns nonzero if a selected role is not Novita or a required input is missing. It never invokes `chatCompletion`. Ensure importing tests cannot trigger execution.
- [ ] Step 5: Validate Compose merging with a synthetic 0600 file and synthetic base environment, using only `config --quiet`. A one-off container with command overridden to the provider check must receive the inputs from the override. The same base plus override command must be used for worker deployment and reference `run`; the old reference-only key injection is superseded for the new window. Run negative tests showing the base API/CDP do not receive the canary and console output contains none of it. Do not print rendered Compose JSON to prove this: capture it in-process and emit assertion results only.
- [ ] Step 6: Update runbook examples to include `-f compose.stage1.providers.yml` for fallback-ready activation and references, plus preflight `--provider-env-file`. Explain service env_file resolution and the safe config variants from spec. Preserve the operator's existing directory creation, restricted log capture, and residual argv-exposure corrections.
- [ ] Step 7: Run checks and commit as `feat: validate shared Scout provider configuration`.

```bash
rtk uv run --project python pytest python/tests/deployment/test_stage1_provider_preflight.py python/tests/deployment/test_stage1_local_preflight.py -q
rtk bun test scout/runtime/provider_check.test.ts
```

### Task 4: Prove real HTTP and WebSocket connectivity in CI

**Interfaces:** `docker/test-cdp-offline.sh IMAGE` builds no image and starts only an isolated project
using that image. Local `IMAGE` may be the candidate task tag; push CI must supply the published
digest. `scout/runtime/cdp_smoke.ts` uses the real Scout client and exits 0 only for all transport checks.

- [ ] Step 1: Create the probe before wiring the corrected launcher. It requires discovery from
`http://legacy-cdp:18800/json/version` and `/json`, non-loopback WS authorities with port 18800,
browser `Browser.getVersion`, and page `Runtime.evaluate` returning 42. Call the real client:

```typescript
import { connect } from '../lib/cdp';
const client = await connect({ match: 'about:blank', requireMatch: true });
try {
  if (await client.evaluate('6 * 7') !== 42) throw new Error('page_cdp_check_failed');
} finally {
  client.close();
}
```

Inspect current `connect` export and return semantics first and preserve its public interface.
Browser-level WS probe must correlate response ID, bound waits to 10 seconds, close on completion,
and print only `http_pass`, `browser_ws_pass`, and `scout_page_ws_pass`. Test the probe against a
loopback-only or HTTP-only fake endpoint and require nonzero exit, not a skip.

- [ ] Step 2: Write an isolated Compose file with `browser` and `probe`, image `${THOTH_TEST_IMAGE:?set candidate image}`. Browser alias is `legacy-cdp`, command `/opt/thoth/bin/start-legacy-cdp --offline-smoke`, user `10001:10001`, seccomp relaxation only there. Use tmpfs `/var/lib/thoth/browser-profile` with UID/GID 10001 and mode 0700. Probe overrides command to `bun /opt/thoth/scout/runtime/cdp_smoke.ts` and sets only `THOTH_CDP=http://legacy-cdp:18800`. Set network `internal: true`, no `ports`, no production bind mounts, no Temporal services, and no provider input. Health checks inspect only the local blank page in this test file.
- [ ] Step 3: Implement the shell harness with `set -euo pipefail`, a unique project name, isolated Compose file, and EXIT trap. Set a 120-second readiness bound. On failure print only service state and safe probe codes, not raw logs or environment. Delete only the disposable project/volumes owned by this harness; never use production Compose files. Required operations:

```bash
docker compose -p "$test_project" -f compose.stage1.cdp-smoke.yml up -d --wait --wait-timeout 120 browser
docker compose -p "$test_project" -f compose.stage1.cdp-smoke.yml run --rm --no-deps -T probe
```

Assign `THOTH_TEST_IMAGE` from the required first positional argument and export it. Validate project
name matches the harness-owned prefix before teardown. Verify no 18800/18801 host mapping. In a
second disposable lifecycle phase, kill the Chromium child identified inside the test runtime,
require supervisor/container failure within the bounded grace interval, and ensure no processes or
sessions survive teardown. Do not locate or signal a browser on the user's host.

- [ ] Step 4: Build the candidate and run the probe on Linux. Record actual HTTP, browser WS, and
Scout page WS results and lifecycle evidence. A mocked unit test cannot replace this gate.

```bash
rtk docker build --platform linux/amd64 -t thoth-stage1:runtime-corrective .
rtk bash docker/test-cdp-offline.sh thoth-stage1:runtime-corrective
```

- [ ] Step 5: Modify PR `validate-image` to use `load: true`, a task-local tag, and run the harness.
Modify push `stack-smoke` to invoke it with
`ghcr.io/muhfalihr/thoth@${{ needs.publish-image.outputs.digest }}`. Keep existing PostgreSQL/API smoke
and pinned Actions. Add runtime Bun tests to quality; include the new extra in locked CI dependency
sync where needed. Preserve the existing equality-form Bun command syntax.
- [ ] Step 6: Add workflow contract tests for both event paths and run the local harness again only
if the harness or image changed. Commit as `ci: verify private CDP through real Scout transport`.

### Task 5: Reconcile docs and finish the offline checkpoint

- [ ] Step 1: Update `docs/operations/stage1-local-docker.md`,
`docs/operations/stage1-parity-sampling.md`, and `BLUEPRINT.md` with actual implementation status.
Include the verified downloader matrix, two-container smoke, provider override, read-only secret
verification, and the distinction between offline presence and live provider acceptance. Clarify
that health inside a sidecar is not proof of sibling reachability. Link the new corrective spec.
- [ ] Step 2: Add supersession notes to the original local Docker spec/plan where direct Chromium
binding or reference-only key injection conflicts with this corrective design. Do not silently
rewrite old recorded test evidence or mark live gates complete. Use precise links to the new spec.
- [ ] Step 3: Document the later operator sequence: archive old observations/references intact;
record old window closure; publish and wait for all smoke gates; record the exact new implementation
commit/digest and provider configuration revision; validate inputs; deploy all THOTH roles on that
digest; keep existing persistent state; reconcile in-flight workflows; run one explicitly approved
pair and a controlled fallback exercise; only then accrue a separate new dataset. Retries remain
explicit and failures remain evidence. Do not execute this sequence in implementation.
- [ ] Step 4: Run final verification with captured exit codes. Use a separate Linux venv/project
copy for WSL if the checkout's Python venv is Windows; never overwrite that venv. Do not repeat full
suites after they pass unless code changes or a concrete concern warrants it.

```bash
rtk uv run --project python pytest python/tests -m 'not live' -q
rtk uv run --project python ruff check python
rtk uv run --project python ruff format --check python
rtk bun --cwd=scout run test:acquisition
rtk bun test scout/runtime/cdp_relay.test.ts scout/runtime/legacy_cdp.test.ts scout/runtime/provider_check.test.ts
rtk git diff --check
```

Also record the completed Linux build and actual Task 4 smoke. The controlled production health
regressions and parity helper tests must remain green. Clearly distinguish Windows skips from
Linux tests actually run.
- [ ] Step 5: Review fixed-point diff for AC1 through AC9. Obtain independent spec/standards review
if using the repository code-review skill; correct concrete blockers and rerun affected checks.
Commit task-owned docs as `docs: hand off corrected Scout runtime activation`. Preserve unrelated
changes. Report local commits, tests, missing runtime proof, and the operator actions not executed.

## Coverage and completion

| Spec acceptance | Plan proof |
| --- | --- |
| AC1 | Task 1 policy audit, lock, non-root executable versions |
| AC2, AC3 | Task 2 relay unit tests + Task 4 actual browser/page WS from sibling |
| AC4 | Task 2 supervisor tests + Task 4 disposable failure/teardown |
| AC5, AC6 | Task 3 provider registry reuse, validator, Compose canary tests |
| AC7 | Existing health/acquisition/parity regressions in Tasks 2 and 5 |
| AC8 | Task 4 PR candidate and push digest smoke |
| AC9 | Task 5 documented handoff; activation evidence remains operator-owned |

Finish at an **offline implementation checkpoint**. Do not call the new image a soak candidate
until publication, all CI checks, operator configuration verification, and the required live gates
have actually completed. The seven-day/50-run/5-parity policy remains unchanged.
