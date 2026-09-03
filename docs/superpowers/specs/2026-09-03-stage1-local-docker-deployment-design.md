# Stage 1 Local Docker Deployment Design

**Date:** 2026-09-03
**Status:** Approved for implementation planning
**Environment:** operator-owned local Docker host
**Scope:** persistent Stage 1 staging and soak preparation

## Context

The Stage 1 compatibility image is published to `ghcr.io/muhfalihr/thoth`, but the operator has
no existing Temporal server or local deployment topology. A seven-day TikTok operational soak
cannot run against an ephemeral development server because workflow history, artifacts, browser
state, observations, and reports must survive container and host restarts.

The local environment therefore needs a persistent PostgreSQL-backed Temporal deployment plus the
three process roles already defined by the Stage 1 image contract: FastAPI, Python worker, and a
private legacy CDP sidecar. This design adds deployment orchestration only. It does not change the
TikTok acquisition order, authorize a live fixture, start the soak, perform rollback approval, or
change the default activity mode to Python-only.

The image published from commit `1c904a7448a086e5d143d5b196f6ceefef53be80` has OCI index digest
`sha256:4630917242bd9e3483c8f89ae4017438cadc23a1f699f5e516c2dc610beb18b1` and is the verified
design-time baseline. It is not automatically the final soak candidate. Any later implementation
commit pushed to the container workflow produces a new image identity; deployment and soak records
must use the digest built from the final approved implementation commit.

## Goals

- Run PostgreSQL, Temporal Server, Temporal UI, THOTH API, THOTH worker, and the legacy CDP sidecar
  on one local Docker host.
- Preserve Temporal state, application artifacts, browser profile, observations, and reports across
  Docker and host restarts.
- Use one immutable THOTH image digest for API, worker, and CDP roles.
- Keep PostgreSQL, Temporal gRPC, and CDP private to the Compose network.
- Bind the operator-facing API and Temporal UI only to loopback.
- Keep runtime secrets and real TikTok fixture data outside Git.
- Provide deterministic preflight, health, controlled-smoke, restart, evidence-export, and teardown
  instructions.
- Export approved evidence to the existing S3 bucket from the host rather than granting AWS
  credentials to application containers.

## Non-goals

- Production or shared-host deployment.
- High availability, replication, TLS termination, public ingress, or multi-host scheduling.
- Managing AWS IAM credentials or creating additional AWS resources.
- Automatically uploading evidence from the THOTH worker.
- Automatically starting a TikTok live smoke or the seven-day soak.
- Storing a real API key, database password, TikTok URL, cookie, browser profile, workflow ID, or
  observation payload in the repository.
- Task 10, TypeScript Scout retirement, or changing the default activity mode to `python`.

## Deployment Artifacts

Implementation creates these tracked files:

- `compose.stage1.local.yml` — the six-service local topology;
- `.env.stage1.local.example` — non-secret variable names and safe placeholders;
- `docs/operations/stage1-local-docker.md` — operator runbook;
- deployment contract tests under `python/tests/deployment/`; and
- `.gitignore` entries for `.env.stage1.local` and local Stage 1 evidence names.

The real `.env.stage1.local` remains untracked and is given restrictive host permissions. The
Compose file must fail interpolation when required values are absent; it must not silently fall
back to a mutable image tag, default password, or empty API key.

## Immutable Images

Infrastructure images are pinned by tag and OCI index digest:

```text
temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312
temporalio/ui:2.34.0@sha256:cb17ea423d76a8a19a269d0bcd81fc12eee1f6365acd2a56b590dafb35696a95
postgres:16.4-bookworm@sha256:e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412
```

Temporal UI 2.34.0 is the version paired with Temporal Server 1.29.1 by the official Temporal
Docker Compose configuration. The THOTH reference is supplied through required variable
`THOTH_IMAGE` and must have form `ghcr.io/muhfalihr/thoth@sha256:<64 lowercase hex characters>`.
Tags such as `latest`, `codex-stage1-container-ci`, and `sha-<git-sha>` are discovery references,
not deployment identities.

## Services and Network Boundaries

### PostgreSQL

PostgreSQL stores Temporal persistence data in `${THOTH_STAGE1_DATA_ROOT}/postgres`. It receives a
non-empty local password from `.env.stage1.local`, exposes no host port, and uses `pg_isready` for
health. Temporal cannot start until PostgreSQL is healthy.

### Temporal Server

`temporalio/auto-setup` connects to service name `postgresql` using the official `DB=postgres12`,
`DB_PORT=5432`, `POSTGRES_SEEDS=postgresql`, `POSTGRES_USER`, and `POSTGRES_PWD` contract. It creates
namespace `thoth-stage1` using `DEFAULT_NAMESPACE=thoth-stage1` and a retention period long enough
to cover the seven-day soak and review window. The service publishes no host port.

Temporal health uses the CLI already present in the image, querying `temporal:7233`. API and worker
startup depend on this health result, not only on container start order.

### Temporal UI

Temporal UI connects to `temporal:7233` and binds only to `127.0.0.1:8080`. It has no credentials,
public ingress, or non-loopback host binding. It is an operator inspection surface, not an
application dependency.

### THOTH API

The API uses the required `THOTH_IMAGE` digest and overrides the image command with:

```text
/opt/thoth/python/.venv/bin/uvicorn thoth_control_plane.api.app:create_app
--factory --host 0.0.0.0 --port 8000
```

It binds to `127.0.0.1:8000`, mounts the shared artifacts directory at
`/var/lib/thoth/artifacts`, and receives the API key, Temporal target `temporal:7233`, namespace
`thoth-stage1`, and artifact root at runtime. Health uses `/healthz`; readiness uses `/readyz`.

### THOTH Worker

The worker uses the same required `THOTH_IMAGE` digest and retains the image's default worker
command. It mounts the same artifacts directory and receives:

```text
THOTH_TEMPORAL_TARGET=temporal:7233
THOTH_TEMPORAL_NAMESPACE=thoth-stage1
THOTH_CONTROL_PLANE_ARTIFACT_ROOT=/var/lib/thoth/artifacts
THOTH_FFMPEG=/usr/bin/ffmpeg
THOTH_FFPROBE=/usr/bin/ffprobe
THOTH_CDP=http://legacy-cdp:18800
THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback
```

The worker publishes no host port. It starts only after Temporal and the CDP sidecar are healthy.
Compose restarts it unless explicitly stopped. In-flight workflows retain their durable input mode
when the worker restarts.

### Legacy CDP Sidecar

The sidecar uses the same `THOTH_IMAGE` digest with command
`/opt/thoth/bin/start-legacy-cdp`. It mounts the persistent browser profile at
`/var/lib/thoth/browser-profile`, exposes `18800` only inside the private Compose network, and has
no host `ports` entry.

Its health probe checks both `/json/version` and `/json`, requiring at least one page target whose
URL belongs to `tiktok.com`. An authentication challenge, CAPTCHA, or non-TikTok target is not
healthy and blocks controlled fallback smoke. No bypass behavior is permitted.

## Persistence and Ownership

`THOTH_STAGE1_DATA_ROOT` is a required absolute host path outside the repository. For the current
Windows/WSL Docker host, the recommended location is inside the operator's WSL home rather than
under `/mnt/c`, because Linux UID/GID ownership must be reliable. The directory layout is:

```text
${THOTH_STAGE1_DATA_ROOT}/
├── postgres/
├── artifacts/
├── browser-profile/
├── observations/
└── reports/
```

PostgreSQL owns its database directory with the identity expected by the pinned image. Application
artifacts and browser profile are writable by THOTH UID/GID `10001:10001`. The runbook provides an
explicit initialization command and verifies ownership before normal services start. Root is used
only for the bounded ownership initialization; API, worker, and browser processes remain non-root.
World-writable permissions are forbidden.

`docker compose restart` and `docker compose down` preserve these bind-mounted directories.
Operators must not delete the data root as part of ordinary restart or rollback. The runbook does
not recommend `down -v`, pruning, or recursive deletion.

The browser profile is sensitive session state. It is never copied to observations, reports, S3,
Git, support logs, or change records.

## Configuration and Secrets

`.env.stage1.local.example` contains only safe placeholders. The untracked `.env.stage1.local`
provides:

- `THOTH_IMAGE` — final approved immutable image reference;
- `THOTH_STAGE1_DATA_ROOT` — absolute external data root;
- `THOTH_CONTROL_PLANE_API_KEY` — non-empty local API credential;
- `THOTH_POSTGRES_PASSWORD` — non-empty local database credential; and
- `THOTH_LIVE_TIKTOK_URL` — an approved public fixture only when the controlled live gate is
  authorized.

No Compose command, health check, documentation example, or diagnostic output echoes those values.
The fixture URL is referred to by variable name only. An unset or placeholder fixture prevents the
live smoke; it does not silently select another URL.

## Operator Flow

1. Verify the successful GitHub Actions run and record its full Git commit and OCI index digest.
2. Create the external data-root directories and apply required ownership.
3. Copy `.env.stage1.local.example` to `.env.stage1.local`; fill secrets locally without printing
   them into a shared terminal or transcript.
4. Run `docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config` and reject
   mutable or missing image references.
5. Pull every pinned image, start PostgreSQL and Temporal, then start UI, CDP, API, and worker through
   health dependencies.
6. Verify API liveness/readiness, Temporal namespace, non-root THOTH identities, persistent mount
   writability, and absence of a host binding for port 18800.
7. Run the non-live control-plane smoke.
8. Only with explicit approval, inject the public TikTok fixture and perform one controlled fallback
   smoke. Stop on login wall, challenge page, unexpected legacy count, redaction failure, or cleanup
   failure.
9. After the smoke passes, establish the soak start timestamp and begin collecting observations.

## Evidence and S3 Export

Observation JSONL and aggregate reports remain separate:

```text
${THOTH_STAGE1_DATA_ROOT}/observations/
${THOTH_STAGE1_DATA_ROOT}/reports/
```

The approved S3 destinations are:

```text
s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/observations/
s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/reports/
```

AWS CLI runs on the host using the operator's existing AWS authentication. AWS credentials are not
mounted or injected into PostgreSQL, Temporal, API, worker, UI, or CDP containers. Export commands
name directories and object prefixes but never print observation contents, fixture URLs, workflow
identifiers, or browser-profile data.

Only the aggregate `tiktok-stage1-soak-report.json` may be attached to the change record. Raw JSONL
remains restricted operational evidence in the approved storage channel and must not enter Git,
chat, issue comments, or code review.

## Failure and Recovery Behavior

- Missing required variables make `docker compose config` fail before pull or startup.
- PostgreSQL failure blocks Temporal; Temporal failure blocks API and worker startup.
- CDP failure blocks worker startup while legacy fallback mode is selected.
- API readiness failure, unwritable mounts, root application processes, public CDP binding, or a
  non-TikTok CDP target blocks the live smoke.
- Container restart uses the same immutable digest and persistent data root.
- Rollback changes the approved activity mode to `legacy_scout`, restarts only the worker as
  documented, and preserves Temporal and artifacts for audit.
- A rollback drill is not performed until the soak report is ready and remains subject to explicit
  human approval.
- Replacing `THOTH_IMAGE` with a different digest creates a new deployment identity. Observations
  from different implementation commits cannot be merged into one evaluated dataset.

## Verification Strategy

Automated repository contracts verify:

- all four images use digest-qualified references;
- API and UI host bindings are loopback-only;
- PostgreSQL, Temporal, and CDP have no host port mapping;
- API, worker, and CDP interpolate the same required `THOTH_IMAGE` value;
- worker mode remains `python_tiktok_with_legacy_fallback`;
- worker CDP target is `http://legacy-cdp:18800`;
- artifact and browser-profile mounts use separate paths;
- `.env.stage1.local` and Stage 1 evidence names are ignored by Git; and
- the runbook never contains a real fixture, API key, password, or mutable deployment tag.

Local non-live verification runs:

```text
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml pull
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml up -d
```

It then verifies service health, API `/healthz` and `/readyz`, Temporal namespace visibility,
non-root THOTH identities, mount persistence across restart, and absence of a published CDP port.
No automated repository test contacts TikTok or uploads evidence to S3.

## Acceptance Criteria

- A clean checkout plus an untracked local env file can render the Compose configuration without
  unresolved variables.
- PostgreSQL-backed Temporal state survives container and host restarts.
- Namespace `thoth-stage1` exists and API/worker connect to `temporal:7233`.
- API, worker, and CDP run the same immutable THOTH digest as non-root UID/GID `10001:10001`.
- API is reachable only at `127.0.0.1:8000`; Temporal UI only at `127.0.0.1:8080`.
- Port 18800 is reachable by the worker network but has no host binding.
- Artifact and browser-profile directories are persistent, writable by THOTH, and isolated from
  each other.
- Compose restarts recover without losing workflow history, artifacts, or browser profile.
- No committed file contains runtime credentials or a real TikTok URL.
- Controlled live smoke and soak remain hard-gated operator actions.
- Evidence export targets only the approved S3 observation and report prefixes.
- The final soak dataset uses one implementation commit and the digest built from that exact commit.
