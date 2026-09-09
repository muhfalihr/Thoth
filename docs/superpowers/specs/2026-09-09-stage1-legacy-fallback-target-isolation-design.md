# Stage 1 Legacy Fallback Target Isolation Design

**Date:** 2026-09-09

**Status:** Approved for implementation planning by the operator.

**Baseline:** `44d657145245d9d294a4a258f56ada35ae8ab37d` on `codex/stage1-container-ci`.

**Scope:** Offline corrective work only. Publication, deployment, live verification, and evidence mutation remain separate operator gates.

## Purpose

Keep the deployed `legacy-cdp` health page intact when the Python worker invokes the temporary legacy Scout fallback. The fallback must perform only source-reference work, use a page target it owns, and remove that target on every terminal path.

This corrective addresses the confirmed shared-target lifecycle defect exposed by p6. It does not claim to resolve the still-unidentified external or source-resolution failure that made the p6 legacy invocation return nonzero.

## Evidence and diagnosis

The p6 workflow exhausted the Python headless and CDN routes, then naturally invoked the legacy fallback. The workflow ended with `legacy_scout_failed`, no source artifact, and clean Python cleanup. Afterward `legacy-cdp` remained running with zero restarts but became unhealthy.

The source inspection establishes:

1. `LegacyScoutActivity._argv()` launches the general `scout/cli.ts run` command and omits the implemented `--source-reference-only` boundary.
2. `scout/lib/cdp.ts::connect()` selects an existing page target by hostname and `close()` closes only the WebSocket session.
3. The production sidecar starts with the same TikTok page that its healthcheck grades. Scout can therefore navigate that shared page away from the qualifying health URL without terminating Chromium or the relay.
4. Docker's `restart: unless-stopped` reacts to process exit, not to an unhealthy-but-running container. The sidecar can remain unavailable to future fallbacks until an operator intervenes.
5. The relay already exposes the discovered browser-level WebSocket. That session can create and close an isolated page target without adding a mutable HTTP endpoint or broadening host exposure.
6. p6 retained no safe detail sufficient to identify why Scout failed before recording `main.source_local`. Target isolation prevents health corruption; it is not evidence that the same source will later resolve.

### Ranked hypotheses

| Rank | Hypothesis | Verdict | Basis |
| --- | --- | --- | --- |
| 1 | Scout navigation of the shared health page caused the persistent unhealthy state. | Confirmed design defect | Target selection and healthcheck grade the same page; WebSocket close does not restore it. |
| 2 | Running the full Scout pipeline expands fallback work beyond the source boundary. | Confirmed contract defect | Production adapter omits `--source-reference-only`. |
| 3 | The p6 source failure was caused by CDP or browser behavior during the run. | Not determinable | The retained result has only a generic nonzero failure. |
| 4 | Source-only mode alone would make p6 succeed. | Contradicted as a sufficient fix | p6 failed before a source-local artifact existed; source-only mode only removes later stages. |

## Alternatives

### A. Owned target lease inside the shared sidecar — selected

A small Scout runtime supervisor creates a fresh `about:blank` page through the relay's browser-level WebSocket, passes its exact target ID to the Scout child, and closes it after the child is reaped. The existing health page is never selected or navigated.

This keeps the established sidecar security boundary, persistent browser profile, provider configuration, single-image topology, and worker concurrency contract.

### B. Restore the health page after Scout exits — rejected

Restoration is compensating cleanup after interference. Process death, CDP failure, cancellation, or a challenge can prevent restoration and recreate the same unhealthy-but-running failure.

### C. Launch Chromium inside the worker — rejected

This would duplicate browser supervision and extend Chromium's sandbox exception beyond the one approved sidecar container.

### D. Add mutable `/json/new` and `/json/close` relay routes — rejected

The existing browser WebSocket already supports target lifecycle. Expanding the HTTP surface adds another authorization and ownership protocol without providing a stronger boundary.

## Architecture

```text
Python LegacyScoutActivity
  -> bun scout/runtime/legacy_fallback.ts
       -> relay browser WebSocket
            Target.createTarget(about:blank) -> leased target id
       -> bun scout/cli.ts run <fixture> --out <report>
            --source-reference-only
            THOTH_CDP_TARGET_ID=<leased target id>
            connect() attaches only to that target
       -> reap Scout child
       -> Target.closeTarget(leased target id)
       -> return child/cleanup status

legacy-cdp health page
  -> never selected, navigated, or closed by the fallback
```

`LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES` remains `1`. The target ID nevertheless makes ownership explicit so correctness does not depend on discovery order.

## Runtime interfaces

### Target lease module

Add a focused module under `scout/runtime/` that:

- fetches `/json/version` from the configured `THOTH_CDP` authority;
- opens only the advertised browser WebSocket already accepted by the relay;
- calls `Target.createTarget` with `about:blank`;
- validates the returned target ID against the relay's existing target-ID grammar;
- refreshes `/json` discovery until the new page is relay-addressable within a bounded readiness budget;
- exposes the immutable target ID and an idempotent asynchronous `close()` operation;
- calls `Target.closeTarget` and treats a false, malformed, timed-out, or missing response as cleanup failure;
- never logs a URL, target ID, protocol frame, provider value, or exception text.

Creation failure must close any target already allocated before returning failure.

### Exact-target CDP selection

Extend `scout/lib/cdp.ts` with a private runtime input named `THOTH_CDP_TARGET_ID`:

- absent means current behavior is unchanged;
- present must satisfy the fixed target-ID grammar;
- discovery must find exactly that page target with a WebSocket URL;
- `connect()` must select it regardless of page-list order and must never fall back to another page;
- a missing or malformed leased target is a fixed relay error;
- `CdpClient.close()` continues to close only its WebSocket. The supervisor owns page destruction.

The target ID is supplied only to the supervised Scout child. It is not added to Compose, the long-running worker environment, operator configuration, or evidence.

### Legacy fallback supervisor

Add `scout/runtime/legacy_fallback.ts` as the only production launcher used by `LegacyScoutActivity`.

It accepts a fixed typed argument set for the canonical source URL and report output. It must:

1. validate arguments without printing rejected values;
2. acquire one target lease before starting Scout;
3. spawn `bun scout/cli.ts run <url> --out <path> --source-reference-only` with the lease target ID in the child environment;
4. forward `SIGTERM` and `SIGINT`, then reap the child within a bounded grace period;
5. close the lease after every child outcome, including launch failure, nonzero exit, timeout-driven outer termination, and operator cancellation;
6. return the Scout status only after successful cleanup;
7. return `70` when the target cannot be proven closed, even if Scout returned zero;
8. emit only fixed diagnostic codes on its inherited stderr.

The Python activity remains the outer timeout and process-group owner. The supervisor must not add retries or extend `LegacyScoutInput.timeout`.
Invalid arguments return `64`; handled `SIGINT` and `SIGTERM` return `130` and `143`; otherwise the supervisor propagates the Scout child status after cleanup.

### Python adapter

Change `_argv()` to invoke the supervisor rather than `scout/cli.ts` directly. Preserve:

- shell-free `create_subprocess_exec`;
- captured stdout and stderr;
- process-group cancellation and timeout behavior;
- existing report location and checksum contract;
- generic safe Temporal failure behavior;
- single-concurrency task queue.

Raw Scout output remains excluded from Temporal history and operator console output. This round does not introduce a new evidence record or reinterpret p6.

## Lifecycle and exit precedence

The supervisor applies this precedence after the Scout child is reaped:

1. target cleanup failure;
2. child launch or supervision failure;
3. signal-derived interruption;
4. Scout child status.

An exit status cannot report success while the leased target is unclosed. Requested shutdown still attempts graceful child termination and target cleanup before returning. Killing the outer process group remains the final defense if the supervisor itself cannot complete.

## Security and privacy

- Keep the relay private to `stage1-private`; add no host port.
- Keep Chromium on sidecar loopback and retain the relay's discovery and WebSocket allowlists.
- Keep `seccomp:unconfined` limited to `legacy-cdp`.
- Do not weaken the production TikTok healthcheck.
- Do not expose target creation as a general operator command or Compose option.
- Do not print fixture URLs, target IDs, WebSocket URLs, page titles, credentials, provider responses, raw stdout/stderr, or exception text.
- Preserve the provider file and Docker-only topology; Podman is outside the project contract.

## Offline verification

Implementation follows strict RED/GREEN TDD.

### TypeScript unit tests

Tests must prove:

- an owned target is selected even when the health page appears first;
- a missing or malformed owned target fails closed without selecting the health page;
- target creation waits for relay discovery and has a bounded failure;
- the lease closes on child zero, child nonzero, launch failure, signal, and forced termination paths;
- cleanup failure outranks a zero child status;
- the child command contains `--source-reference-only` exactly once;
- normal callers without `THOTH_CDP_TARGET_ID` retain current matching behavior;
- no test asserts raw secret, URL, target ID, or protocol-frame output.

### Python tests

Tests must prove:

- `_argv()` invokes only the fixed supervisor contract;
- report materialization, cancellation, timeout, redaction, and process-tree termination remain intact;
- a nonzero supervisor result stays `legacy_scout_failed` unless it is an existing launch or timeout branch;
- no raw subprocess stream crosses the activity boundary.

### Real-image offline harness

Extend or add a Docker-only harness using a local page and the existing private relay topology. It must record only booleans and fixed counts while proving:

- the initial sidecar page target remains present with the same local URL;
- the fallback child uses a different temporary page;
- the temporary page is absent after success and injected failure;
- the original page remains reachable over HTTP and WebSocket;
- no host port, TikTok, CDN, provider, fixture, or secret is used;
- no test-owned container, network, volume, or profile survives teardown.

## Documentation impact

Expected files:

- create `scout/runtime/cdp_target_lease.ts` and tests;
- create `scout/runtime/legacy_fallback.ts` and tests;
- modify `scout/lib/cdp.ts` and add focused tests;
- modify `python/src/thoth_control_plane/activities/legacy_scout.py` and its tests;
- modify the Docker offline CDP harness and container contract tests as required;
- update `docs/operations/stage1-local-docker.md`;
- update `BLUEPRINT.md` after executable implementation is verified.

The implementation plan may adjust filenames to fit existing module boundaries, but it may not weaken ownership, cleanup, source-only, or privacy requirements.

## Acceptance criteria

| ID | Requirement | Required proof |
| --- | --- | --- |
| AC1 | Production legacy fallback never attaches to the sidecar health page. | Exact-target selection tests and real-image offline target-preservation harness. |
| AC2 | Every fallback owns and removes one temporary target. | Success, failure, cancellation, and cleanup-failure lifecycle tests. |
| AC3 | Production fallback stops after the source-reference boundary. | Exact child-command and pipeline regression tests. |
| AC4 | Existing non-fallback CDP consumers retain current behavior. | Existing Scout acquisition/runtime suites plus new absent-target-ID regression. |
| AC5 | Cleanup failure cannot be reported as success. | Exit-precedence tests. |
| AC6 | Healthcheck, relay exposure, sandbox, worker mode, and persistent infrastructure contracts remain unchanged. | Compose/container contract tests and diff review. |
| AC7 | Offline image exercises the real relay, browser WebSocket, leased page, Scout CDP client, and teardown without public network access. | Docker harness exits zero and reports every fixed boolean true. |
| AC8 | No sensitive or uncontrolled diagnostic data crosses the runtime boundary. | Redaction tests and output review using synthetic canaries. |

## Hard stops

This corrective round must not:

- read a real fixture or provider secret;
- contact TikTok, a CDN, or a model provider;
- retry p6 or create another workflow/sample;
- mutate restricted evidence, observations, aggregate reports, S3, or Issue #5;
- inspect, restart, recreate, or otherwise change the deployed stack;
- build or pull a deployment image before the offline code gates pass;
- push, publish, deploy, run controlled fallback, or open an acceptance window;
- relax the healthcheck, relay allowlist, network boundary, or sandbox policy;
- claim that the unidentified p6 source failure is resolved.

After offline verification, the result returns to the operator for independent review and a separate push decision.
