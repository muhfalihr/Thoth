# Stage 1 Parity Reference Browser Isolation

## Status and authority

Design and implementation handoff requested by the operator on 2026-09-07.
This document specifies option B: an ephemeral Chromium inside the reference
container. It does not claim implementation, deployment, parity, or soak acceptance.
The operator requested the spec, plan, and executor prompt together; implementation
is authorized only when the executor handoff is issued.

References:

- [Implementation plan](../plans/2026-09-07-stage1-parity-browser-isolation.md)
- [Executor prompt](../../agent-prompts/stage1-parity-browser-isolation-executor.md)
- [Parity contract and evidence procedure](../../operations/stage1-parity-sampling.md)
- [Local deployment and activation gates](../../operations/stage1-local-docker.md)
- [Previous runtime correction](2026-09-06-stage1-scout-runtime-corrective-design.md)

## Evidence and problem

The operator's p2 report says Python produced independently validated media, while
Scout rejected its candidate as commentary and produced no reference media. That
is `evidence_incomparable`, not a completed mismatch or a pass. Preserve p2 and
leave its parity verdict unset. Missing error markers do not prove provider
authentication, quota, or model availability.

That reference navigated the shared sidecar's only page to another platform.
CDP transport remained available, but the production healthcheck requires a
qualifying TikTok page and therefore failed. One incident proves an interference
mechanism, not that every reference will reproduce it. The operator reports the
sidecar was subsequently recovered by restarting the same container, with the
digest and healthcheck unchanged. No new acquisition accompanied that recovery.

The reported current deployment is commit
`7ab6e04b3f8814f5e8d590544ae833942b2ce0fc`, image
`ghcr.io/muhfalihr/thoth@sha256:3f5e8079be5ecae986cfb1ce4c5ec2fa84a4d576f1bc22e3083b901723dae661`.
This is historical context, not a substitute for an operator's next live identity
check. The new soak window has not started. GitHub issue #5 owns change records.

## Decision and alternatives

| Choice | Benefit | Cost / decision |
| --- | --- | --- |
| A: dedicated parity sidecar | Browser and reference are separate processes/containers | Could be ephemeral, not necessarily permanent; still requires two-container orchestration. Not selected. |
| B: browser inside reference container | No reference connection to production CDP; one disposable lifecycle | Requires browser/Scout supervision. Selected. |
| C: shared sidecar plus restoration | Small procedural change | Interference remains and restoration can fail. Rejected. |

Option B uses a **fresh anonymous profile by default**. It does not clone an active
production profile, share its cookie database, or promise authenticated session
equivalence. A read-only mount alone does not make a live SQLite profile snapshot
consistent. Profile seeding or login/session provisioning is excluded from this
round and requires separate design and operator approval if it becomes necessary.
An authentication wall or challenge is a recorded stop, not permission to import
cookies, switch fixtures, or bypass the wall.

## Architecture and interfaces

```text
Python workflow -> existing worker -> existing acquisition / production sidecar

one-off parity reference container
  start-parity-reference -> lifecycle supervisor
    Chromium: fresh tmpfs profile, about:blank, 127.0.0.1:18801
    Scout CLI: THOTH_CDP=http://127.0.0.1:18801
    output: restricted per-sample bind mount
  both processes stop -> container removed -> profile discarded
```

Production Compose, its six services, relay, healthcheck, persistent profile,
worker mode, and workflow routing are unchanged. Reference execution does not
reuse the `worker` service definition or attach to the production Compose network.

### Container entrypoint

Add `/opt/thoth/bin/start-parity-reference`, backed by
`scout/runtime/parity_reference.ts`. Accept only no arguments, `--check`, or
`--offline-smoke`; reject every other combination with exit 64.

- `--check`: resolve exactly one executable Chromium, readable supervisor and
  writable output/profile directories; never start a browser or read a fixture.
- Normal: validate `THOTH_PARITY_REFERENCE_ID` against
  `^[a-z][a-z0-9-]{0,63}$`; read the fixture only from `/run/parity/url` inside the
  container; require a credential-free HTTPS URL on an exact TikTok host supported
  by the current canonicalizer. Reject invalid input without echoing it.
- Output is fixed to
  `/opt/thoth/scout/output/legacy-scout/<reference-id>/source-report.json`.
  Create its parent before acquisition. Require the mounted output root; reject
  an existing reference directory to prevent accidental overwrite/retry.
- Profile is fixed to `/var/lib/thoth/parity-profile`, a fresh tmpfs per container.
  Do not mount `/var/lib/thoth/browser-profile` or any production storage.
- Set `THOTH_CDP=http://127.0.0.1:18801` in the Scout child explicitly. Reject a
  conflicting supplied `THOTH_CDP` before starting anything. Launch the ordinary
  `bun scout/cli.ts run <url> --out <path>`; do not change Scout's source policy,
  downloader selection, normalizers, or provider behavior.
- Production relay is not reused: its advertised hostname belongs to a different
  topology. Chromium's direct loopback DevTools endpoint serves this child.
- `--offline-smoke` runs a local deterministic CDP client instead of live Scout,
  reads no real fixture/provider, and uses the same browser startup/supervision.
  It is explicit test behavior, never a fallback from a failed normal run.

### Lifecycle and failure contract

Browser starts on `about:blank`, with Chromium sandbox enabled. Await bounded
HTTP discovery (30 seconds, each request at most 2 seconds) before starting Scout.
Use subprocess argument arrays, not shell interpolation. Forward TERM/INT and
reap both children. Race browser exit, Scout exit, shutdown, and a 15-minute
overall deadline; startup time is included. Give each child 5 seconds to stop,
then kill/reap it. No unbounded startup, socket, or teardown wait is allowed.

Preserve Scout's nonzero exit after successful cleanup. Return 70 for unexpected
browser exit/readiness failure or cleanup failure, 124 for deadline, and 130/143
for operator INT/TERM. A reference is successful only if Scout exits zero and
cleanup succeeds; lifecycle success alone is not artifact validity or parity.
Resolve simultaneous events deterministically: observed unexpected browser death
or cleanup failure defeats a nominal Scout success. Normal browser shutdown after
Scout exits must not be misclassified as an unexpected failure.

Capture Scout stdout and stderr separately as `reference.stdout.log` and
`reference.stderr.log` under the sample output root, mode 0600. Capture browser
diagnostics only to a separate restricted file; emit fixed codes/booleans on the
console. Do not print raw errors, model values, URLs, captions, report contents,
or credentials. Persist an attempt result with timestamps, child exit codes,
timeout/interruption flags, and process-cleanup result; do not edit observation
JSONL or assign a parity verdict. Profile disposal is verified by the host after
container removal, not claimed by the process while its tmpfs still exists.

The URL remains in Scout's in-container argv because that is its existing CLI
contract. Reading from the mount removes host-shell/Docker-command exposure, not
process-table exposure. Document that residual risk explicitly.

### Standalone Compose boundary

Add `compose.stage1.parity.yml` with one service `reference`, not an overlay of
production files. Require `THOTH_PARITY_IMAGE` as the same immutable OCI index as
the Python worker for a later live pair; a source-mounted new wrapper against the
old image is not a same-release proof. Require absolute external sample and
restricted two-variable provider-file paths. Reuse the provider validator.

Use UID/GID `10001:10001`, image tini, `restart: "no"`, `init` behavior consistent
with the image, no host ports, no host networking, no Docker socket, no external
production networks, no production artifacts/profile mounts. Mount only the
container-readable fixture file read-only and the fresh sample output read-write;
use tmpfs for profile. The browser-containing reference container alone may use
`seccomp:unconfined`, for the same Chromium sandbox reason as the existing sidecar;
no `--no-sandbox`, privileged mode, or added capabilities.

Operator live execution uses its own disposable project network with outbound
access. Tests use a separate test Compose overlay with `internal: true`, synthetic
inputs, and no real provider file. Make the host preflight reject mutable live
image refs, unsafe paths, a conflicting CDP endpoint, symlink escapes, existing
attempt evidence, and unsafe provider permissions before container creation.
Docker `env_file` interpolation/rendering must not expose values: use
`config --quiet`, or capture resolved JSON privately and emit assertion booleans.

### Evidence and operational gates

Keep the nine-field parity contract and all six per-side integrity checks. A
fresh-profile authentication failure, commentary rejection, missing media, or
incomplete cleanup is evidence, not grounds for a successful retry. Record
browser isolation mode `fresh_ephemeral` in the restricted pairing record, not
in the strict observation schema. Record reference container removal separately.

The future runbook replaces the old shared-worker reference command with the
standalone one-shot container command. Check worker/sidecar identity and health
before/after; if production is degraded, stop and report rather than repairing it
inside a parity run. Retain old commands only as clearly labeled historical
procedures, not a runnable alternative for new samples.

This wrapper enters a new image. Future deployment must follow publication/CI,
same-digest checks for Python and reference, change recording, and activation
approval. Keep the currently deployed digest unchanged during implementation.
Even a passing isolated live pair does not open the new soak window: the separately
approved controlled fallback exercise remains required. It is a production legacy
path and is not isolated by this reference-only change. The risk of cross-platform
navigation during a real fallback remains a separately recorded follow-up, not
something this spec claims to fix or a reason to weaken its live gate.

## Acceptance criteria

| ID | Required evidence |
| --- | --- |
| AC1 | New reference launches Chromium locally and the real Scout CDP client reaches it, with no production endpoint available. |
| AC2 | Standalone topology: no production mounts/network, no published ports, non-root, fresh tmpfs, correct provider allowlist. |
| AC3 | Startup/deadline/signal/browser-exit/Scout-exit paths terminate and reap owned children; cleanup failure is nonzero. |
| AC4 | Separate restricted logs and attempt record; secret/URL canaries absent from console and Docker configuration/argv (except documented Scout child argv). |
| AC5 | Non-TikTok local navigation in the reference leaves a synthetic production-like sentinel unchanged; second invocation has a fresh profile. |
| AC6 | Failure and cancellation remove only test-owned containers/networks/profile; reports/logs remain; no generic prune/down against production. |
| AC7 | Existing runtime, acquisition, deployment, parity-contract tests remain green; candidate-image offline smoke executes in PR and published-digest CI. |
| AC8 | Runbook and prompt distinguish offline completion, live parity, fallback, deployment, and soak; old failures remain evidence. |

## Non-goals

No live execution, fixture selection, login/cookie import, provider request, push,
publication, deployment, rollback, S3 transfer, issue mutation, observation edit,
new window start, default-mode change, or Task 10 during implementation. No
permanent service is added. Python remains Scrapling headless first, CDN second;
gallery-dl handles images/gallery and yt-dlp remains for existing video consumers.
