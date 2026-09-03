# Stage 1 Container Image and GitHub CI Design

**Date:** 2026-09-03  
**Status:** Corrective amendment pending written review
**Registry:** `ghcr.io/muhfalihr/thoth`  
**Target platform:** `linux/amd64`

## Context

TikTok Stage 1 cannot begin its operational soak until the exact implementation under evaluation
can be built as an immutable deployable artifact. Commit
`fe034622c34f41bb29ee45de7bb0ca55048c7112` is the verified acquisition baseline, but the
repository currently has no container image definition or GitHub Actions build pipeline. The
runtime also still requires the temporary legacy Scout adapter for fallback and rollback, so a
Python-only image would violate the Stage 1 gates.

This design adds one compatibility image and a GitHub-hosted CI pipeline. Publishing the image is
the deployment boundary for this scope; deploying it to AWS and configuring Temporal are separate
operational steps.

### Corrective review findings

The first implementation reached commit
`442f51c5dd36b94542e6632f3cd8523f396c2af9`, but independent review found that the image could
not yet satisfy its advertised legacy-fallback contract. Scout requires executable FFmpeg and
FFprobe paths and a reachable Chromium DevTools Protocol (CDP) endpoint. The image supplied neither
Linux media tools nor a managed CDP topology. Review also found missing build-context exclusions,
mutable GitHub Action references in a package-writing job, missing persistent-volume ownership
instructions, and a repository-required `BLUEPRINT.md` update.

This amendment keeps one immutable application image. The same image digest is used in three
separate process roles: worker, API, and (only while legacy fallback is enabled) a headless Chromium
CDP sidecar. No second project image or registry is introduced. Commit `442f51c...` remains a
reviewed checkpoint, not a release or soak candidate.

## Goals

- Build one immutable Linux AMD64 image that can run either the Python worker or FastAPI.
- Include Scrapling headless support as the primary TikTok acquisition route.
- Preserve TikWM/CDN behavior from the application and Bun/Scout legacy fallback from the same
  repository revision.
- Make the temporary Scout fallback operational on Linux by including FFmpeg/FFprobe and defining a
  private, health-checked CDP sidecar topology.
- Run all non-live Python and Scout acquisition regression gates before an image is published.
- Publish images to `ghcr.io/muhfalihr/thoth` with immutable commit tags and useful mutable tags.
- Record the canonical OCI digest in the GitHub Actions job summary for the operational change
  record.
- Prevent secrets, live evidence, local databases, and generated media from entering build context
  or image layers.

## Non-goals

- Deploying or restarting services on AWS.
- Provisioning Temporal, EC2, ECS, EBS, EFS, IAM roles, or a secret manager value.
- Uploading observation JSONL or aggregate reports to S3.
- Running live TikTok tests in GitHub Actions.
- Changing `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` or the Stage 1 cutover gates.
- Removing the Bun/Scout compatibility adapter.
- Building ARM64 or a multi-platform manifest.
- Building the Rust media pipeline or dashboard into this image.
- Exposing CDP to the public internet or using CDP to evade authentication, rate limits, bot
  challenges, or CAPTCHAs.

## Image Contract

### Identity

The image repository is exactly `ghcr.io/muhfalihr/thoth`. Every published build has:

- an immutable `sha-<full-40-character-git-sha>` tag;
- a normalized mutable branch tag for branch pushes;
- `latest` only for a push to `master`; and
- the matching Git tag for pushes of tags matching `v*`.

The canonical release identity is the registry digest (`sha256:...`), not `latest`, the branch tag,
or the Git tag. Deployments and soak change records must pin the image by digest.

OCI metadata includes at least the repository source URL, Git revision, created timestamp, image
title, and description. BuildKit emits provenance and an SBOM with the published image.

### Runtime contents

The root `Dockerfile` uses a multi-stage build with these runtime version lines:

- `python:3.12-slim-bookworm`, intentionally following the maintained CPython 3.12 security patch
  line while the published image digest preserves the exact resolved base;
- `uv` 0.10.8;
- Bun 1.3.14; and
- Python dependencies resolved only from `python/uv.lock`, including the `acquisition` extra.

The build copies only the Python project and the active `scout/` compatibility tree. It does not
copy the dashboard, Rust build output, Git history, local environment files, runtime artifacts, or
operational evidence into the runtime image.

The Python project remains installed in editable layout under `/opt/thoth/python` so
`LegacyScoutActivity` resolves its repository root to `/opt/thoth`. The Scout CLI is therefore
available at `/opt/thoth/scout/cli.ts`, exactly where the adapter's fixed
`bun scout/cli.ts ...` invocation expects it.

The build runs `scrapling install` and fails if browser support cannot be installed. Browser assets
are placed under the runtime user's home or another image-owned shared path and remain readable and
executable after dropping root privileges. The image build also fails unless it can import the
control-plane package, import Scrapling, execute Bun, find `scout/cli.ts`, execute FFmpeg and
FFprobe, and resolve the installed Chromium executable.

The runtime installs Debian Bookworm's `ffmpeg` package without recommended packages. The image
sets these exact compatibility paths:

```text
THOTH_FFMPEG=/usr/bin/ffmpeg
THOTH_FFPROBE=/usr/bin/ffprobe
```

The image contains `/opt/thoth/bin/start-legacy-cdp`, a non-root launcher for the Chromium installed
by `scrapling install`. The launcher has a non-starting `--check` mode used during the build and a
normal mode that replaces itself with Chromium using all of these invariants:

- headless mode (`--headless=new`);
- CDP bound to `0.0.0.0:18800` inside the private container network;
- persistent profile path `/var/lib/thoth/browser-profile`;
- one initial `https://www.tiktok.com/` page target so Scout's `requireMatch` probes can attach;
- no privileged container requirement and no browser `--no-sandbox` flag; and
- no printing of cookies, profile contents, signed URLs, or CDP target payloads.

The launcher fails closed if Chromium cannot be resolved, the profile directory is not writable,
or the requested CDP port is not exactly `18800`.

### Filesystem and process model

The final image runs as the non-root user `thoth`. Its fixed paths are:

- application root: `/opt/thoth`;
- Python project: `/opt/thoth/python`;
- compatibility executables: `/opt/thoth/bin`;
- persistent artifact root: `/var/lib/thoth/artifacts`;
- persistent legacy browser profile: `/var/lib/thoth/browser-profile`; and
- runtime home/cache: `/home/thoth`.

Both persistent directories are created and owned by the fixed runtime identity UID/GID
`10001:10001`. A deployment must provision or initialize mounted storage with that ownership. A
Kubernetes-style deployment may instead use an equivalent `fsGroup: 10001` or an init container
that performs the ownership change before the non-root process starts. The deployment must never
solve permissions by running the application or browser as root or by making the volumes
world-writable.

A deployment mounts durable application storage at `/var/lib/thoth/artifacts` and sets
`THOTH_CONTROL_PLANE_ARTIFACT_ROOT=/var/lib/thoth/artifacts` for both API and worker. The CDP sidecar
alone mounts a separate persistent profile volume at `/var/lib/thoth/browser-profile`. Temporary
browser files may use `/tmp`, but durable reports and media may not. The profile volume may contain
session state and is sensitive operational data: it must not enter Git, the image, application
logs, soak evidence, or the S3 evidence prefixes.

The default image command is:

```text
/opt/thoth/python/.venv/bin/python -m thoth_control_plane.worker
```

The API uses the same image and digest with this command override:

```text
/opt/thoth/python/.venv/bin/uvicorn thoth_control_plane.api.app:create_app \
  --factory --host 0.0.0.0 --port 8000
```

While `python_tiktok_with_legacy_fallback` is active, a third container uses the exact same image
digest with this command override:

```text
/opt/thoth/bin/start-legacy-cdp
```

The sidecar is named `legacy-cdp` on a private deployment network and publishes port `18800` only
to that network. It has no public load balancer, host-port mapping, ingress route, or internet-facing
security-group rule. Network policy permits the worker to connect to the sidecar and denies CDP
access from unrelated workloads. CDP is an unauthenticated remote-control interface, so a public or
shared endpoint is a release blocker.

Sidecar readiness requires both `GET http://legacy-cdp:18800/json/version` to return 2xx and
`GET http://legacy-cdp:18800/json` to contain at least one page target whose URL belongs to
`tiktok.com`. The deployment restarts an unhealthy sidecar. The worker must not receive a
legacy-fallback activity until this readiness contract passes. If a controlled fallback smoke sees
an authentication or challenge page, the release stops for operator review; the system does not
attempt bypass behavior.

The image has no HTTP health check because its default worker process has no HTTP endpoint. The
deployment layer must use the API's `/healthz` and `/readyz` endpoints for the API service and
process/Temporal health for the worker.

### Runtime configuration and secrets

The image contains no runtime secret and defines no secret-valued build argument. Deployments inject
configuration at runtime, including:

- `THOTH_CONTROL_PLANE_API_KEY`;
- `THOTH_TEMPORAL_TARGET`;
- `THOTH_TEMPORAL_NAMESPACE`;
- `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`;
- `THOTH_FFMPEG=/usr/bin/ffmpeg`;
- `THOTH_FFPROBE=/usr/bin/ffprobe`;
- `THOTH_CDP=http://legacy-cdp:18800` while legacy fallback is enabled;
- `THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE=python_tiktok_with_legacy_fallback` during soak; and
- `THOTH_LIVE_TIKTOK_URL` only for an explicitly approved live gate.

The real TikTok URL must come from a secret manager and must never appear in the Dockerfile,
workflow YAML, build arguments, image metadata, logs, summaries, or test commands.

## Build Context Policy

The root `.dockerignore` excludes at least:

- `.git`, local worktrees, agent state, editor state, and dependency caches;
- every `.env` variant and known local key file;
- `node_modules`, Python virtual environments, bytecode, and test caches;
- Rust `target`, generated output, databases, logs, downloaded media, and model caches;
- `.thoth-artifacts`, Scout output, operational observation JSONL, aggregate reports, and `.part`
  files; and
- unrelated product trees not copied by the Dockerfile.

The denylist explicitly includes `data/cookies.txt`, `**/*.key`, `**/*.png`, and global
`**/*.part` patterns. The `.part` rule is not limited to an evidence filename or one output
directory. Contract tests enumerate these exact protections, and no negated allowlist rule may
re-include them.

The Dockerfile uses explicit `COPY` instructions rather than `COPY . .`. Dependency manifests are
copied before source to keep cache reuse deterministic without broadening the context boundary.

## GitHub Actions Contract

### Events and concurrency

`.github/workflows/container-image.yml` runs for:

- every pull request;
- every branch push; and
- Git tags matching `v*`.

Concurrency is grouped by workflow and ref. A newer run cancels an older in-progress run for the
same ref, but never cancels a different branch or tag build.

Every third-party `uses:` reference in the workflow is pinned to a full 40-character commit SHA.
Each pin retains a trailing comment with the human-readable upstream major/version (for example,
`# v4`). Mutable `@vN`, branch, or tag references are forbidden, including in read-only jobs,
because the same workflow also contains a `packages: write` publication job. Dependency-update
automation may propose pin changes, but review must verify the upstream repository and release
before a SHA changes.

### Quality job

The quality job has read-only repository permission. It installs the pinned Python and Bun tooling,
then runs from locked manifests:

```text
uv sync --project python --frozen --all-groups --extra acquisition
uv run --project python pytest -m "not live" -q
uv run --project python ruff check python/src python/tests
uv run --project python ruff format --check python/src python/tests
bun --cwd=scout install --frozen-lockfile
bun --cwd=scout run test:acquisition
```

The exact equals form `--cwd=scout` is required. The whitespace form previously produced a false
passing command and must not be used.

No live provider, browser session, TikTok URL, Temporal server, AWS credential, or legacy network
call is used by the quality job.

### Pull-request image validation job

The pull-request image validation job depends on the quality job and runs only for
`pull_request`. It builds `linux/amd64` with Docker Buildx and GitHub Actions cache, never
authenticates to GHCR, never requests package-write permission, and never publishes an image.

### Publishing job

The publishing job depends on the quality job and runs only for branch or `v*` tag pushes. It
builds `linux/amd64` with Docker Buildx and the same GitHub Actions cache.

- Branch and `v*` tag pushes authenticate to GHCR with the run-scoped `GITHUB_TOKEN` and publish
  only after all quality gates pass.
- Workflow permissions default to `contents: read`; the publishing job alone receives
  `packages: write` while the pull-request validation job remains read-only.
- No personal access token or long-lived registry credential is required.
- Registry credentials are not exposed to Docker build steps or persisted in image layers.

After a successful push, the workflow writes only safe release metadata to the GitHub Actions job
summary: image repository, generated tags, source Git SHA, target platform, and canonical digest.
It never writes runtime configuration or evidence paths.

## Failure Behavior

- Any test, lint, dependency-lock, browser-install, or image-build failure prevents publication.
- A missing/non-executable FFmpeg, FFprobe, or Chromium launcher check prevents publication.
- A deployment with public CDP exposure, a non-ready TikTok page target, or an unwritable
  UID/GID-owned persistent volume cannot become the soak candidate.
- Pull requests from forks remain build-only and never receive package write permission.
- A failed publish does not move `latest`, branch, or version tags.
- A published digest is immutable; a retry may update mutable tags only if it produces and reports a
  successful image.
- The pipeline never falls back to an unlocked dependency install or silently omits Scrapling,
  browser support, Bun, or Scout.

## Documentation

Operational documentation must include:

- how to pull by digest and inspect the image revision;
- the worker default command and FastAPI override command;
- required runtime environment variables without example secret values;
- the persistent artifact-volume requirement;
- UID/GID `10001:10001` (or equivalent `fsGroup`/init ownership) for both persistent mounts;
- the same-digest CDP sidecar command, private network boundary, readiness probes, profile-volume
  sensitivity, and `THOTH_CDP=http://legacy-cdp:18800`;
- the fixed Linux `THOTH_FFMPEG` and `THOTH_FFPROBE` paths;
- where to find the digest in GitHub Actions; and
- the boundary that publishing is not AWS deployment.

Because this repository treats `BLUEPRINT.md` as implementation/status knowledge, the corrective
implementation must update its Python control-plane or migration status entry. The entry records
the one-digest worker/API/CDP topology, Linux FFmpeg compatibility, and the fact that image
publication still does not constitute deployment or a completed soak.

## Stage 1 Evidence Implication

The container and workflow changes create a commit later than `fe03462`. Therefore:

- `fe03462` remains the acquisition-code baseline;
- the new container/CI implementation commit becomes the candidate source revision;
- the deployed `ghcr.io/muhfalihr/thoth@sha256:...` digest must be built from that exact revision;
- the soak window starts only after that digest is deployed in the approved environment; and
- `implementation_commit == evaluated_commit` must use the new full Git SHA, not `fe03462`.

No part of this work authorizes Task 10, changes the default mode to `python`, starts a soak window,
or records human approval.

## Acceptance Criteria

- A clean checkout can build the root Dockerfile for `linux/amd64` without local secrets.
- The final container runs as non-root and contains the locked Python acquisition runtime,
  installed Scrapling browser support, Bun 1.3.14, Linux FFmpeg/FFprobe, the CDP launcher, and the
  active Scout CLI.
- `THOTH_FFMPEG` and `THOTH_FFPROBE` resolve to executable Linux binaries and the build exercises
  both version commands.
- The same immutable image digest can start a private, non-root headless CDP sidecar; readiness
  proves a TikTok page target before a legacy fallback is eligible to run.
- The worker reaches the sidecar only through `THOTH_CDP=http://legacy-cdp:18800`; CDP has no public
  ingress, host port, or shared-network exposure.
- The default command starts the Python worker entry point and the documented override addresses
  the FastAPI factory.
- The artifact root is writable by the runtime user and is not embedded with generated artifacts.
- Artifact and browser-profile mounts are provisioned as `10001:10001` or with an explicitly
  equivalent ownership mechanism; the profile is excluded from source, build context, logs, and
  evidence storage.
- Pull requests run all offline gates and build without pushing.
- Every successful branch push publishes a full-SHA tag and normalized branch tag.
- A successful `master` push also publishes `latest`; a successful `v*` tag push publishes the
  matching version tag.
- Failed gates publish no image or mutable tag update.
- A successful publishing run exposes its canonical digest in the GitHub Actions summary.
- No committed file contains a real secret, live TikTok URL, workflow-level evidence, or AWS
  credential.
- `.dockerignore` explicitly excludes `data/cookies.txt`, `**/*.key`, `**/*.png`, and global
  `**/*.part` files.
- Every GitHub Action is pinned to a full commit SHA with a readable version comment; no mutable
  action reference remains.
- `BLUEPRINT.md` reflects the corrected runtime topology and current pre-publication status.
- Existing Stage 1 fallback/rollback modes and acquisition behavior remain unchanged.
