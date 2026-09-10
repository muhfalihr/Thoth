# Stage 1 Controlled Fallback Activation Design

**Date:** 2026-09-10
**Status:** Approved in-chat design; written specification awaiting operator review.
**Repository baseline:** `c61f5789c1ad702b11b025b6ce99a5ba7afef9ff` on
`codex/stage1-container-ci`.
**Deployed acquisition identity:**
`ghcr.io/muhfalihr/thoth@sha256:0bc3d00cace0244d5d91ef7caa66151ab1f59222bef29ad686d9b942d2400d6e`,
OCI revision `c61f5789c1ad702b11b025b6ce99a5ba7afef9ff`.

## Purpose

Define one deterministic, operator-approved activation gate for the deployed legacy fallback
supervisor. The gate proves that the production supervisor can use a temporary CDP page against a
real approved TikTok fixture, complete source-reference work, remove its leased target, and leave
the sidecar health page intact.

This gate closes the operational-procedure gap discovered after deployment: the Stage 1 runbook
requires a controlled fallback exercise but does not currently define an executable command,
fixture boundary, result schema, or pass/fail contract.

## Scope and claims

The exercise runs the deployed production `scout/runtime/legacy_fallback.ts` command in a one-shot
container made from the deployed digest. It joins only the existing private Stage 1 network and
uses the deployed `legacy-cdp` service. It does not reconfigure or replace the running worker.

A passing exercise proves:

1. the deployed supervisor can acquire a temporary target through the private CDP relay;
2. Scout is launched through the production source-reference-only command boundary;
3. the supervisor returns only after its Scout child is reaped;
4. the leased target is absent after completion;
5. the pre-existing sidecar health page remains present and healthy; and
6. no CDP port is published to the host.

It does not prove that a normal Python workflow will naturally enter fallback, that a Python
failure is eligible for fallback, or that Temporal routed a workflow through
`LegacyScoutActivity`. Those are end-to-end routing claims and remain separate. The exercise is not
a parity sample, soak observation, rollback drill, or acceptance-window run.

## Selected approach

Use a repository-owned host harness that orchestrates Docker Compose without adding a new runtime
endpoint or changing the deployed image. The harness starts one disposable container from the
exact deployed digest and invokes the production supervisor against one mounted fixture. It probes
CDP only through containers already attached to the private network and emits a fixed result
record.

This approach is selected because it exercises the corrected production supervisor deterministically
without changing worker mode or depending on Python acquisition routes failing in a particular
way.

### Rejected alternatives

- **Reuse p6:** rejected because p6 is retained failure evidence and another run would be a retry.
- **Temporarily deploy `legacy_scout` mode:** rejected because it is a rollback-mode deployment and
  changes worker configuration.
- **Wait for a Python workflow to fall back naturally:** rejected because it is nondeterministic; a
  successful Python route would not exercise the gate.
- **Add a live-gate endpoint or flag to the runtime image:** rejected because it would mint and
  require deployment of another acquisition digest solely to test the current one.

## Fixture contract

The fixture identity is `f1`. The operator supplies it at:

```text
/home/mfr/thoth-stage1-fallback/f1/url.txt
```

The parent directory must be mode `0700`; the fixture must be a regular, non-symlink file owned by
the operator and mode `0600`. It contains exactly one canonical HTTPS TikTok post URL with no
credentials or fragment. The preflight validates the value without printing it.

The deployed image runs as UID/GID `10001`, so it cannot read the operator-owned mode-`0600` file
directly. After preflight and attempt reservation, a no-network staging helper from the same pinned
image creates `f1/reference-input/url` as UID/GID `10001:10001`, mode `0400`, beneath a mode-`0500`
directory. The live one-shot container mounts only that staged file read-only. The helper receives
no provider environment, joins no Compose network, and is not privileged. Teardown removes the
staged copy on every terminal path while retaining the operator's original `url.txt`.

`f1` is independent of parity samples p1-p6. Its URL must be byte-distinct from every retained
parity fixture, checked without printing the value or any hash. Absence, reuse, unsafe permissions,
or an existing final `f1` attempt record stops before a live request.

The authorization is consumed when the one-shot fallback container starts. A preflight failure
does not start it and requires the operator to correct the input and authorize again. Once the
container starts, any outcome is the single final `f1` result; there is no automatic retry.

## Execution architecture

The implementation adds a host-side Docker harness and an offline contract test. The harness:

1. verifies repository drift is documentation or gate-harness-only relative to the deployed OCI
   revision;
2. verifies `.env.stage1.local` resolves the exact authorized digest and the provider override is
   present without reading or printing provider values;
3. verifies API, worker, Temporal, PostgreSQL, and `legacy-cdp` are running, with required health
   checks green and restart counts captured;
4. verifies API, worker, and `legacy-cdp` all use the authorized digest and OCI revision;
5. verifies worker mode is `python_tiktok_with_legacy_fallback`, UID is `10001`, provider roles are
   ready through the offline provider check, and CDP has zero host bindings;
6. captures a value-free baseline describing the health-page target and page-target count;
7. starts one disposable Compose container from the authorized digest with:
   - the staged fixture copy mounted read-only;
   - a restricted `f1` output directory mounted writable;
   - the provider environment file attached only through the existing Compose override;
   - the existing private network;
   - no host port, privileged mode, Docker socket, or deployment volume;
8. reads the fixture inside the container and invokes the production supervisor with
   `--url`, an absolute `--out` path, and no shell interpolation on the host;
9. captures container stdout and stderr in restricted mode-`0600` files instead of the terminal;
10. observes, without recording target identifiers or URLs, that a temporary page existed while
    the supervisor was running when timing permits;
11. waits once for the supervisor's terminal status, then removes the one-shot container;
12. verifies the original health page still qualifies, the final page-target count equals the
    baseline, API/CDP health remains green, restart counts did not increase, and no gate-owned
    container, network, or volume remains; and
13. writes one atomic final attempt record and appends one immutable index row.

The implementation must not use Podman. It must not call `docker compose down`, recreate a
deployed service, publish a port, or mount the Docker socket.

## Evidence layout

All gate evidence stays outside the repository and outside `THOTH_STAGE1_DATA_ROOT`:

```text
/home/mfr/thoth-stage1-fallback/
  controlled-fallback-record.jsonl
  f1/
    url.txt
    reference-input/
      url                 # temporary UID/GID 10001:10001 copy, removed by teardown
    output/
      source-report.json
    supervisor.stdout.log
    supervisor.stderr.log
    artifact-integrity.private.json
    controlled-fallback-attempt.json
```

The root and `f1` directory are mode `0700`; every regular evidence file is mode `0600`. The
operator fixture is never copied into the index record. The temporary container-readable copy is
mode `0400` and its parent is mode `0500`; both are removed after the attempt. Raw logs remain restricted and are never attached
to GitHub, chat, an aggregate report, or the soak dataset.

The final attempt file is reserved atomically as `status: pending` before the one-shot container
starts and finalized by write-to-temporary-file plus rename. A stale pending record blocks another
run until independently diagnosed; it is not overwritten.

`artifact-integrity.private.json` contains the independently measured report checksum, media
checksum, and media byte count needed to reproduce integrity validation. It is restricted evidence,
not safe result output, and must never be printed, attached to Issue #5, or copied into the attempt
or index row.

The append-only index receives exactly one sample row for `f1`. Corrections use a separate
amendment row targeting that sample; existing bytes are never rewritten.

## Safe result schema

`controlled-fallback-attempt.json` contains only these fields:

```json
{
  "schema_version": 1,
  "gate_id": "f1",
  "status": "completed",
  "occurred_at": "RFC3339 UTC timestamp",
  "acquisition_digest": "sha256:<64 lowercase hex>",
  "acquisition_revision": "40 lowercase hex",
  "harness_revision": "40 lowercase hex",
  "supervisor_exit_code": 0,
  "artifact_present": true,
  "artifact_validated": true,
  "temporary_target_observed": true,
  "health_target_preserved": true,
  "target_count_restored": true,
  "cdp_healthy_after": true,
  "api_healthy_after": true,
  "restart_counts_unchanged": true,
  "cleanup_passed": true,
  "teardown_leaves_nothing": true,
  "verdict": "passed"
}
```

Allowed verdicts are `passed`, `failed`, and `inconclusive`:

- `passed` requires supervisor exit `0`, artifact validation success, health target preservation,
  restored target count, healthy API/CDP, unchanged restart counts, successful cleanup, and empty
  teardown.
- `failed` covers a terminal nonzero supervisor status, artifact validation failure, health-target
  damage, restart drift, or cleanup/teardown failure.
- `inconclusive` is limited to orchestration loss after authorization consumption where a terminal
  supervisor result cannot be recovered. It never grants activation credit.

`temporary_target_observed=false` alone does not fail a fast successful run because polling may
miss a short-lived target. The stronger postconditions—production supervisor exit, validated
artifact, preserved health target, restored target count, and cleanup—remain mandatory. The field
is retained as supporting evidence rather than a success requirement.

No field may contain the fixture URL, post identity, target ID, page title, WebSocket URL, provider
name or response, model name, credential, checksum, filesystem path, container ID, raw exception,
or raw log text.

## Artifact validation

The report is validated using the existing source-report and artifact helpers already used by the
parity workflow. Validation must establish, without printing values:

- report schema validity;
- exactly one designated source media artifact;
- regular-file and symlink-safe containment beneath the `f1/output` root;
- MP4 signature and minimum size;
- recorded byte count and checksum agreement;
- no partial file; and
- no artifact path outside the gate directory.

Artifact validation does not compare Python and Scout output and cannot set `parity_passed`.

## Failure and cleanup precedence

Result precedence is:

1. failure to remove the leased target or gate-owned container;
2. health-page loss, health failure, restart drift, or final target-count mismatch;
3. artifact validation failure;
4. supervisor child status;
5. observation-only fields such as whether polling saw the temporary target.

Cleanup and containment failures cannot be reported as success even when the supervisor exits
zero. Operator cancellation after container start is recorded as a consumed failed or
inconclusive attempt after bounded teardown; it is not silently discarded.

## Security and privacy

- Docker is the only supported runtime.
- The CDP relay remains private and Chromium remains inside the existing sidecar.
- The health check, relay allowlist, sandbox settings, and worker concurrency are unchanged.
- The URL is absent from host shell interpolation, Compose arguments, Docker create requests, and
  container configuration. It necessarily appears in the Scout process argv inside the one-shot
  container while running; the runbook documents this residual exposure.
- Provider values are supplied through the existing restricted provider environment file and are
  never rendered or logged.
- The harness emits fixed booleans and status codes only. Diagnostic details remain in restricted
  logs and cannot drive an automatic retry.

## Offline implementation verification

Before any live authorization, tests must prove:

1. fail-closed fixture, permission, symlink, digest, revision, health, mode, provider, and prior
   attempt checks;
2. the generated Compose invocation uses the exact digest, private network, read-only fixture,
   restricted output, provider override, and production supervisor command;
3. secrets and fixture values do not appear in command rendering, result JSON, stdout, or stderr;
4. attempt reservation and finalization are atomic and append-only;
5. every failure branch runs bounded teardown and cleanup failure outranks child success;
6. result classification follows the fixed precedence;
7. artifact validation reuses the existing containment and integrity contract; and
8. a synthetic Docker-only harness exercises the orchestration without TikTok, CDN, or provider
   access and leaves no resource behind.

Run the existing Scout runtime/acquisition, Python deployment, typecheck, Ruff, Compose contract,
and Docker offline harness gates after the focused tests. No live fixture or provider file is read
during implementation verification.

## Operational hard stops

Writing and implementing this specification does not authorize:

- starting `f1` or any other live request;
- reusing or retrying p1-p6;
- modifying the deployed digest, worker mode, service topology, or persistent volumes;
- mutating parity evidence, soak observations, aggregate reports, S3, or Issue #5;
- running controlled fallback before offline implementation and independent review pass;
- opening the accelerated acceptance window, performing rollback, cutting over, disabling Scout,
  or entering Task 10.

After offline verification, the result returns to the operator for independent review. Starting
the one-shot `f1` container requires a new explicit single-use authorization.

## Acceptance criteria

| ID | Requirement | Proof |
| --- | --- | --- |
| CF1 | Preflight fails before network activity on unsafe or reused input. | Focused preflight tests with synthetic canaries. |
| CF2 | The one-shot command uses the deployed digest, private CDP, provider override, and production supervisor. | Command-contract test and safe Compose render. |
| CF3 | URL and secrets cannot enter host command/configuration or safe result output. | Redaction and argument-boundary tests. |
| CF4 | Attempt reservation/finalization and index updates are atomic and append-only. | Filesystem tests on Windows and WSL ext4. |
| CF5 | Cleanup, health preservation, and restart stability outrank child success. | Verdict-precedence tests. |
| CF6 | Artifacts satisfy the existing schema, containment, signature, size, byte-count, checksum, and partial-file contract. | Existing helper reuse plus focused tests. |
| CF7 | Offline Docker orchestration leaves no container, network, volume, or fixture copy. | Synthetic Docker harness with every fixed boolean true. |
| CF8 | A future live pass proves only supervisor activation and target isolation, not Python routing, parity, soak readiness, or cutover. | Result schema and runbook wording review. |
