# Stage 1 Scout Runtime Corrective Design

**Date:** 2026-09-06
**Status:** Ready for implementation review; documentation scope requested by the operator.
**Baseline:** `671a18060308e1ef84429d98bf3ae64f6e9f1cc9` on `codex/stage1-container-ci`.
**Purpose:** Make the compatibility image capable of running a private Scout parity reference and
the existing worker fallback, without changing the Python TikTok acquisition contract.

## Evidence and scope

The operator's preflight reports missing `yt-dlp`, inaccessible CDP from sibling containers,
and missing model credentials in the deployed worker. These are runtime observations, not new
observations collected by this design session. The current branch has an uncommitted operator edit
to `docs/operations/stage1-parity-sampling.md`; preserve it during execution.

The audit establishes actual downloader consumers:

| Consumer | Contract / consequence |
| --- | --- |
| `scout/acquisition/policy.ts` | Images: `gallery-dl`, then direct HTTP, then DOM; video: direct HTTP, then `yt-dlp`. Preserve these orders. |
| `scout/acquisition/config.ts`, `materialize.ts` | Resolve `GALLERY_DL` and `YTDLP`; execute the corresponding materializer. |
| `scout/lib/main_candidate_runtime.ts::probeMainCandidateVideo` | TikTok candidates call `postShape`, implemented with `yt-dlp` in `scout/lib/verify.ts`. Probe failure can be best-effort, so missing `yt-dlp` does not prove every TikTok run must fail. |
| `scout/lib/media_resolution.ts` | Video resolution has an executable `yt-dlp` path; direct CDN branches can bypass it. |
| `scout/lib/cdp.ts::connect` | Opens the advertised `webSocketDebuggerUrl` directly; exposing HTTP alone is insufficient. |
| `scout/lib/env.ts`, `subtitle_vision.ts` | Role selector, then global selector, then Novita; OCR uses the selected vision key. |

Acquisition remains TikTok-only in Python: Scrapling headless first, TikWM/CDN second. Adding
compatibility binaries does not authorize new platforms, image acquisition in Python, or changes
to source selection, OCR validation, parity normalization, or retirement thresholds.

## Alternatives and decision

1. **Recommended: an application relay inside the existing CDP sidecar.** Chromium listens on
   loopback; Bun serves HTTP and WebSocket on the private interface. Discovery URLs are rewritten
   explicitly. This retains six production services and the existing Scout client contract.
2. **TCP forwarding plus client changes.** Smaller transport but leaves Chromium Host checks and
   loopback/inner-port discovery addresses to every client. Not selected because the current client
   trusts discovery URLs and multiple consumers would need coordinated rewrites.
3. **Share the worker network namespace with Chromium.** Avoids the relay but couples roles and
   changes restart/isolation semantics. Not selected.

## Locked compatibility tools

Add an optional Python extra named `scout-runtime`:

```toml
scout-runtime = ["gallery-dl==1.32.11", "yt-dlp==2026.8.19"]
```

These versions were verified against PyPI metadata during drafting: gallery-dl requires Python
>=3.8 and yt-dlp >=3.10, both compatible with the Python 3.12 image. Sources:
`https://pypi.org/pypi/gallery-dl/1.32.11/json` and
`https://pypi.org/pypi/yt-dlp/2026.8.19/json`; upstream image downloader is
`https://github.com/mikf/gallery-dl`.

Resolve the extra into `python/uv.lock`. Both existing Docker uv sync stages install `acquisition`
and `scout-runtime` using the frozen lock. Use the venv executables, with `GALLERY_DL` and `YTDLP`
set to their absolute paths. Verify executable versions after `USER thoth`. Never download an
unpinned binary during startup or invoke a downloader against a public URL in image validation.

## Private CDP relay and process ownership

Keep the production service name `legacy-cdp`, advertised endpoint `http://legacy-cdp:18800`, UID/GID
`10001:10001`, persistent browser profile, and existing sandbox policy. No host mapping is added.

- Chromium listens on `127.0.0.1:18801`; Bun listens on `0.0.0.0:18800` inside the sidecar.
- `/json`, `/json/list`, and `/json/version` proxy to fixed loopback upstream with a valid upstream
  Host. Rewrite `webSocketDebuggerUrl` only, to `ws://legacy-cdp:18800` plus the original DevTools
  path. Do not derive the advertised authority or upstream from incoming Host/query values.
- Accept WebSocket upgrades only for discovered `/devtools/page/<id>` or `/devtools/browser/<id>`
  paths. Forward frames in both directions, including frames arriving during upstream connection
  setup, subject to bounded buffering. Close both peers on errors, timeout, or disconnect.
- Bound HTTP discovery to 5 seconds and 1 MiB, upgrade establishment to 5 seconds, individual WS
  messages to 16 MiB and buffered traffic per connection to 32 MiB. Exceeding a limit closes the
  request/connection with a safe code; never dump payloads. Allow at most 32 concurrent sessions.
- Relay upstream is not a general HTTP proxy. Reject absolute-form targets, other paths, traversal,
  unknown target IDs, and non-GET HTTP methods. Origin handling must support the existing Bun client
  without adding Chromium's unrestricted `--remote-allow-origins=*` flag.
- The Bun runtime supervises Chromium. Either process failing ends the container nonzero. On TERM
  or INT, stop accepting sessions, close peers, terminate Chromium, and force-kill after 5 seconds
  if necessary. `tini` remains PID 1 and reaps descendants. Browser output is not copied to logs;
  expose fixed diagnostic codes and exit status only.

### Refinement, 2026-09-07

Two clauses above were satisfied only in part by the first implementation and are tightened here.

- *"Only discovered target IDs"* now means **currently** discovered. Each discovery route replaces
  the target set for its own scope: `/json` and `/json/list` speak for `page` targets, `/json/version`
  speaks for the `browser` target, and neither retires the other's. A target that has left discovery
  is refused for new upgrades instead of remaining admissible for the life of the container.
- *"Either process failing ends the container nonzero"* now covers a relay that stops serving after a
  successful bind, not only one that fails to bind. Bun.serve raises no event for this, so the relay
  carries a liveness watch that probes its own socket on a bounded timeout and exposes a promise the
  supervisor races alongside browser exit; a requested `stop()` cancels the watch rather than
  resolving it. Relay failure terminates Chromium and exits `70`. The container healthcheck cannot
  substitute: Docker acts on container exit, not on an unhealthy status.

Known and deliberately unclosed: the 32-session limit is checked before the upgrade and recorded at
socket open, so concurrent upgrades may overshoot it by the number in flight. Scout drives a single
client, so the ceiling is not reachable in this deployment. Tracked in code, not filed externally.

Keep `start-legacy-cdp --check` a silent, non-launching capability check. Add exactly one explicit
test mode, `--offline-smoke`, opening `about:blank` with a disposable profile supplied by the test
stack. No arbitrary startup URL option is introduced. Default production startup still opens
TikTok and therefore remains a live operator action. Do not weaken the production target health
rules to accept `about:blank`; the offline Compose file has its own probe.

## Provider configuration

Support Novita in this corrective deployment, matching the operator's existing selection; do not
build a second generic provider registry. Use the existing Scout registry in an offline check to
assert chat/vision/embed resolve to Novita, key presence, and effective model configuration. Presence
does not attest authentication, balance, or model availability. No provider request occurs in CI.

Add a Compose override `compose.stage1.providers.yml` applying a required service-level `env_file`
to `worker` only, sourced from `THOTH_STAGE1_PROVIDER_ENV_FILE` (absolute, outside Git). Both the
deployed fallback worker and one-off reference use this same override and credential source.
Base non-live infrastructure Compose remains usable without model secrets. API, CDP, Temporal,
PostgreSQL, and UI do not receive model keys.

The restricted provider file admits exactly `THOTH_NOVITA_API_KEY` and
`THOTH_SUBTITLE_OCR_MODEL`; selectors are explicitly fixed to Novita in the override. Reject empty
or placeholder keys, unknown variable names, duplicate assignments, invalid file permissions on
Linux, and malformed model values using safe variable-name diagnostics. Use `deepseek/deepseek-ocr`
as the example OCR model. Other model roles retain the defaults implemented by the pinned Scout
code; report their names, and verify availability later in the approved live reference.

Extend the existing preflight with an explicit provider-file option for the fallback-ready path.
Do not read the operator's root `.env` during implementation or load real credentials for tests.
Use synthetic canary credentials; never bake `.env`, provider files, reference logs, or fixture URLs
into the image. Document that service env credentials remain inspectable by Docker administrators.
`config --no-interpolate` alone is not safe with a service env_file, because env-file resolution is
separate: use `config --quiet`, `config --images`, or, if supported, the combination
`config --no-interpolate --no-env-resolution`. Never emit rendered credential environments.

## Verification layers

**Repository tests:** executable policy, relay discovery rewrite, forwarding/lifecycle/error cases,
strict provider configuration, secret-free outputs, and existing acquisition/health/parity tests.
Test behavior rather than just checking that a literal exists in YAML.

**Isolated Linux image test:** a new Compose file contains only `browser` (alias `legacy-cdp`) and
`probe`, both using the candidate image on an `internal: true` network, without host ports. The
browser uses `--offline-smoke`, a disposable profile and sidecar-only seccomp relaxation. Probe
uses the real `scout/lib/cdp.ts::connect` to find `about:blank`, evaluate `6 * 7`, and require `42`.
Separately verify browser-level discovery/WebSocket `Browser.getVersion`. Both advertised URLs
must be reachable from probe; a loopback-only false positive must fail. Stop Chromium deliberately
in this disposable stack and verify the supervisor exits and sessions close. No production project,
Temporal worker, model API, or TikTok page is started.

**CI:** PRs build/load a local candidate and execute the isolated probe before review approval.
Pushes retain the published-digest infrastructure smoke and add the same CDP check against that
exact digest. No mutable tag may substitute for the digest. A published image is not release-ready
until every smoke succeeds. Clean up only the CI-owned project/volumes and avoid raw service logs.

**Operator activation:** archive the old dataset and pairing failures without deletion. Record a new
implementation commit, image digest, runtime configuration revision, and non-secret provider/model
identity. Credential injection does not alter an OCI digest, but it changes runtime configuration.
Deploying this corrective image starts a new evaluation window; retain persistent Temporal and
artifact data, separate datasets, and preserve outstanding workflows for reconciliation.
After explicit live approval, verify one new Python/Scout pair and fallback operation. Do not mix
diagnostic reference attempts with workflow success/fallback denominators or hide failed samples.
Runtime configuration/key rotation during a window requires recorded operator assessment; do not
claim the evaluator detects configuration changes, because its schema does not include them.

## Acceptance criteria and implementation boundary

| ID | Requirement | Proof |
| --- | --- | --- |
| AC1 | gallery-dl for images and yt-dlp for existing video/probe consumers, exact pins | Lock + post-USER version probes + existing Scout policy tests |
| AC2 | Private HTTP and browser/page WebSocket reachable from another container | Isolated real-image probe, including real Scout client |
| AC3 | No loopback addresses leaked as usable external WS targets; no open proxy | Rewrite and rejection tests |
| AC4 | Supervisor shutdown/failure bounded, no browser left behind | Disposable-process lifecycle tests |
| AC5 | Worker/reference provider configuration equivalent, other roles secret-free | Synthetic Compose/runtime tests + operator verification later |
| AC6 | Secret material absent from output and image | Canary negative tests + build-context contracts |
| AC7 | Normal health fail-closed and Python acquisition order unchanged | Existing regression suites |
| AC8 | PR and published-digest CI exercise real CDP transport without live network | Both CI jobs pass |
| AC9 | Old evidence archived; new release/window explicitly identified | Runbook now; actual activation evidence later |

The executor implements and verifies local code, tests, container build, and the isolated offline
stack. It does not push, deploy, recreate current services, read real keys, acquire live references,
write observations, upload S3, perform rollback, approve cutover, or execute Task 10. An offline GO
is not a declaration that provider authentication, operational fallback, or parity live gates passed.
