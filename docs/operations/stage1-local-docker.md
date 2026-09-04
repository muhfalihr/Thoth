# Stage 1 Local Docker Operations

This runbook covers the local Docker deployment of the Stage 1 control plane defined by
`compose.stage1.local.yml`. Every live action below is an explicit operator decision. Nothing in
this document is executed automatically by CI or by repository tests.

## Execution environment

Run every command below from one shell inside the WSL distribution that owns
`THOTH_STAGE1_DATA_ROOT`, started in this repository checkout. `docker`, `docker compose`, and `uv`
must all resolve in that shell. Driving Compose from a Windows shell while the data root lives in
the WSL filesystem splits ownership across two views of the same paths and makes the Linux UID/GID
checks below unreliable.

## Release identity

Record the final implementation commit and the OCI index digest from the successful GitHub Actions
summary. Set `THOTH_IMAGE` in the untracked `.env.stage1.local` to the digest-qualified reference.
Never deploy a branch, `latest`, or `sha-*` tag.

The digest must be built from the exact implementation commit that will be evaluated. Replacing
`THOTH_IMAGE` with a different digest creates a new deployment identity, and observations collected
under different digests cannot be merged into one evaluated dataset.

## Prepare persistent storage

Create `postgres`, `artifacts`, `browser-profile`, `observations`, and `reports` below the absolute
`THOTH_STAGE1_DATA_ROOT` outside this repository. Initialize `artifacts` and `browser-profile` as
UID/GID `10001:10001`; keep the browser profile out of evidence and support output.

Place the data root inside the WSL filesystem rather than under `/mnt/c`, because Linux UID/GID
ownership is not reliable on the Windows drive mount.

```bash
mkdir -p "$THOTH_STAGE1_DATA_ROOT"/{postgres,artifacts,browser-profile,observations,reports}
sudo chown -R 10001:10001 "$THOTH_STAGE1_DATA_ROOT"/artifacts "$THOTH_STAGE1_DATA_ROOT"/browser-profile
sudo chmod 750 "$THOTH_STAGE1_DATA_ROOT"/artifacts "$THOTH_STAGE1_DATA_ROOT"/browser-profile
```

Root is used only for this bounded ownership initialization. API, worker, and browser processes stay
non-root. World-writable permissions are forbidden. PostgreSQL owns `postgres/` with the identity
expected by the pinned image; do not change its ownership manually.

## Configure the local environment

Copy `.env.stage1.local.example` to `.env.stage1.local` and fill the values locally. The file is
ignored by Git and must never be committed, pasted into a shared terminal, or attached to a change
record. The variables Compose requires are `THOTH_IMAGE`, `THOTH_STAGE1_DATA_ROOT`,
`THOTH_CONTROL_PLANE_API_KEY`, and `THOTH_POSTGRES_PASSWORD`. Missing required variables make
`docker compose config` fail before any pull or startup.

`THOTH_STAGE1_ACTIVITY_MODE` selects the worker activity mode. It defaults to
`python_tiktok_with_legacy_fallback` and may only be changed to `legacy_scout` during the approved
rollback drill.

`THOTH_LIVE_TIKTOK_URL` is a host-side pytest variable and is never injected into a container. It is
read only by `python/tests/live`, which is not part of the image. The fixture is referred to by
variable name only. An unset or placeholder fixture prevents the live smoke; it never causes another
URL to be selected silently.

## Preflight, render, and pull

Validate the operator-supplied values before pulling anything. Compose interpolation only rejects an
empty variable, so the preflight is what actually enforces the immutable digest, an absolute data
root outside the repository, an approved activity mode, and non-placeholder credentials. It names
variables and never prints their values.

```bash
uv run --project python thoth-control operations stage1-local-preflight --env-file .env.stage1.local
```

Then render with `--quiet` and inspect the topology through views that never resolve secrets. A bare
`docker compose config` prints every resolved `environment:` block, including the database password
and API key, into the terminal and the shell history. `--no-interpolate` shows the full six-service
topology with every `${VAR:?...}` left unresolved, which is the safe way to check `ports:`, `user:`,
and mount targets.

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config --quiet
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config --images
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config --no-interpolate
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml pull
```

Reject the rendered configuration if any image reference is mutable or missing a digest, if a host
binding appears for PostgreSQL, Temporal, or the CDP sidecar, or if any application service resolves
to a user other than `10001:10001`.

## Non-live infrastructure preflight

Start only PostgreSQL, Temporal, Temporal UI, and API.
Do not run `docker compose up` for `legacy-cdp` or `worker` without explicit live approval.

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml up -d postgresql temporal temporal-ui api
```

Verify `http://127.0.0.1:8000/healthz`, `http://127.0.0.1:8000/readyz`, and namespace state with:

```bash
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS http://127.0.0.1:8000/readyz
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec temporal temporal operator namespace describe --namespace thoth-stage1 --address temporal:7233
```

Then run the deterministic runtime checks. Each command states the result that passes:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec api id -u
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec api id -g
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec api test -w /var/lib/thoth/artifacts
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml ps --format '{{.Service}} {{.Ports}}'
```

- `id -u` and `id -g` must both print `10001`.
- The artifact writability test must exit `0`.
- The port listing must show a binding only for `127.0.0.1:8000` on `api` and `127.0.0.1:8080` on
  `temporal-ui`; PostgreSQL and Temporal must show no host binding.

Confirm PostgreSQL-backed Temporal history survives a restart before continuing. The namespace must
still be described after the restart:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml restart postgresql temporal
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec temporal temporal operator namespace describe --namespace thoth-stage1 --address temporal:7233
```

Then run the non-live control-plane smoke before any live gate is considered.

## Controlled live gate

The approved mode is `python_tiktok_with_legacy_fallback`. Starting the CDP sidecar opens TikTok and
requires explicit operator approval plus the locally supplied fixture. Stop on authentication wall,
challenge, unexpected routing, redaction failure, or cleanup failure.

The CDP health check requires a responding `/json/version` endpoint and a page target served over
HTTPS from an exact TikTok host whose path carries no authentication or challenge marker. A login
wall, a captcha, or a look-alike host is unhealthy by design. A CDP failure blocks worker startup
while legacy fallback mode is selected; that must not be worked around by relaxing the health check
or publishing port `18800`.

Once the sidecar and worker are approved and running, verify their identity and isolation:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec worker id -u
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec legacy-cdp id -u
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml port legacy-cdp 18800
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec worker printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
```

- Both identity commands must print `10001`.
- The `port` command must print nothing and exit non-zero; a printed host binding means the sidecar
  is reachable outside the private network and the gate stops here.
- The worker mode must print `python_tiktok_with_legacy_fallback`.

Perform exactly one controlled fallback smoke on first activation. Establish the soak start
timestamp only after that smoke passes.

## Evidence export

Use host AWS authentication to sync observation JSONL and aggregate reports separately to:

- `s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/observations/`
- `s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/reports/`

Never upload browser-profile data. Upload is a separate operator action and is not performed by
Compose. AWS credentials are not mounted into PostgreSQL, Temporal, API, worker, UI, or CDP
containers. Export commands name directories and object prefixes only; they never print observation
contents, fixture URLs, or workflow identifiers.

Only the aggregate `tiktok-stage1-soak-report.json` may be attached to the change record. Raw JSONL
stays restricted operational evidence and must not enter Git, chat, issue comments, or code review.

## Restart and rollback preparation

An ordinary restart keeps the same digest and the same environment:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml restart worker
```

The rollback mode is `legacy_scout` and may be applied only during the approved rollback drill. Set
`THOTH_STAGE1_ACTIVITY_MODE` to that value in `.env.stage1.local`, then recreate only the worker.
Restarting the container reuses the environment it was created with, so a restart alone would
silently keep the previous mode:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml up -d --no-deps --force-recreate worker
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec worker printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
```

The mode command must print the mode that was just selected; if it prints the previous mode, the
rollback has not taken effect and the drill stops. Recreating only the worker preserves Temporal
history and artifacts for audit.

Do not run `docker compose down -v` and do not delete `THOTH_STAGE1_DATA_ROOT` during restart or
rollback. The rollback drill is not performed until the soak report is ready, and it remains subject
to explicit human approval.
