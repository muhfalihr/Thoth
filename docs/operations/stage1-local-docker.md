# Stage 1 Local Docker Operations

This runbook covers the local Docker deployment of the Stage 1 control plane defined by
`compose.stage1.local.yml`. Every live action below is an explicit operator decision. Nothing in
this document is executed automatically by CI or by repository tests.

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

On a Windows host running Docker through WSL, place the data root inside the WSL filesystem rather
than under `/mnt/c`, because Linux UID/GID ownership is not reliable on the Windows drive mount.

```bash
mkdir -p "$THOTH_STAGE1_DATA_ROOT"/{postgres,artifacts,browser-profile,observations,reports}
sudo chown -R 10001:10001 "$THOTH_STAGE1_DATA_ROOT"/artifacts "$THOTH_STAGE1_DATA_ROOT"/browser-profile
chmod 750 "$THOTH_STAGE1_DATA_ROOT"/artifacts "$THOTH_STAGE1_DATA_ROOT"/browser-profile
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

`THOTH_LIVE_TIKTOK_URL` is a host-side pytest variable and is never injected into a container. It is
read only by `python/tests/live`, which is not part of the image. The fixture is referred to by
variable name only. An unset or placeholder fixture prevents the live smoke; it never causes another
URL to be selected silently.

## Render and pull

Render with `--quiet` and inspect the resolved topology through filtered views. A bare
`docker compose config` prints every resolved `environment:` block, including the database password
and API key, into the terminal and the shell history.

```powershell
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config --quiet
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config --images
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config --format json | jq 'del(.services[].environment)'
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml pull
```

Reject the rendered configuration if any image reference is mutable or missing a digest, if a host
binding appears for PostgreSQL, Temporal, or the CDP sidecar, or if any application service resolves
to a user other than `10001:10001`.

## Non-live infrastructure preflight

Start only PostgreSQL, Temporal, Temporal UI, and API.
Do not run `docker compose up` for `legacy-cdp` or `worker` without explicit live approval.

```powershell
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml up -d postgresql temporal temporal-ui api
```

Verify `http://127.0.0.1:8000/healthz`, `http://127.0.0.1:8000/readyz`, and namespace state with:

```powershell
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec temporal temporal operator namespace describe --namespace thoth-stage1 --address temporal:7233
```

Also confirm, before considering the preflight complete:

- API and worker report a non-root identity (`id -u` returns `10001`).
- `/var/lib/thoth/artifacts` is writable from the API container.
- Temporal UI answers only on `127.0.0.1:8080` and the API only on `127.0.0.1:8000`.
- No host binding exists for port `18800`; the sidecar is reachable only inside `stage1-private`.
- PostgreSQL-backed Temporal history survives `docker compose restart`.

Then run the non-live control-plane smoke before any live gate is considered.

## Controlled live gate

The approved mode is `python_tiktok_with_legacy_fallback`. Starting the CDP sidecar opens TikTok and
requires explicit operator approval plus the locally supplied fixture. Stop on authentication wall,
challenge, unexpected routing, redaction failure, or cleanup failure.

The CDP health check requires both a responding `/json/version` endpoint and a live TikTok page
target. A CDP failure blocks worker startup while legacy fallback mode is selected; that is intended
and must not be worked around by relaxing the health check or publishing port `18800`.

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

Use `docker compose restart` with the same digest. The rollback mode is `legacy_scout` and may be
applied only during the approved rollback drill. Do not run `docker compose down -v` and do not
delete `THOTH_STAGE1_DATA_ROOT` during restart or rollback.

A rollback restarts only the worker with the changed activity mode and preserves Temporal history
and artifacts for audit. The rollback drill is not performed until the soak report is ready, and it
remains subject to explicit human approval.
