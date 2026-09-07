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

Once the soak window has started, the deployed digest is frozen until the window closes.
Recreating any service onto a different digest restarts the soak window and discards every
observation collected before it. The observation record carries no digest field, so the
evaluator cannot tell two releases apart; the digest-to-window mapping exists only in the
operator change record.

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

## Configure the shared provider input

Legacy Scout aborts its first pipeline step without a model provider key, so the digest alone is not
fallback-ready: the worker and every one-off reference need the same provider input. Keep that input
in a file outside the repository and give Compose only its absolute path.

`.env.stage1.providers.example` shows the shape and is not a usable provider file. Create the real
file on restricted storage, then export its path:

```bash
install -m 600 /dev/null "$HOME/secrets/stage1.providers.env"
$EDITOR "$HOME/secrets/stage1.providers.env"
export THOTH_STAGE1_PROVIDER_ENV_FILE="$HOME/secrets/stage1.providers.env"
```

The file holds exactly `THOTH_NOVITA_API_KEY` and `THOTH_SUBTITLE_OCR_MODEL`. A wider file is
usually an accidental copy of the repository `.env`, and a service-level `env_file` injects every
line of the file it names into that container, so the extra variables would become container
environment. The preflight rejects a third variable, a placeholder key, a relative or
in-repository path, and, on Linux, a group- or world-readable mode.

`compose.stage1.providers.yml` attaches that file to the worker and to nothing else. The API, the
browser sidecar, and the infrastructure preflight keep starting with no provider input at all.

The same path is read by `compose.stage1.parity.yml`, the standalone one-shot file a parity
reference runs from. That file is never merged with the deployment: it names the provider input
independently so a reference and the worker receive the same configuration without the reference
inheriting anything else the deployment holds.

Providing credentials changes runtime configuration only. It does not change the image, its digest,
or anything already recorded for a deployment that is already running, and a present key is not
evidence of authentication, quota, or model availability.

## Preflight, render, and pull

Validate the operator-supplied values before pulling anything. Compose interpolation only rejects an
empty variable, so the preflight is what actually enforces the immutable digest, an absolute data
root outside the repository, an approved activity mode, and non-placeholder credentials. It names
variables and never prints their values.

```bash
uv run --project python thoth-control operations stage1-local-preflight --env-file .env.stage1.local --provider-env-file "$THOTH_STAGE1_PROVIDER_ENV_FILE"
```

Omitting `--provider-env-file` preserves the earlier non-live behaviour and validates the base
environment only. Fallback-ready activation always supplies it.

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

For a fallback-ready deployment, validate the merged pair as well. `--no-interpolate` alone stops
being a safe diagnostic here: interpolation and service `env_file` resolution are separate steps, so
an un-interpolated render still resolves the provider file into the worker's `environment:`. Use
`--quiet`, `--images`, or the combination below. The current host reports Docker Compose v5.5.0;
on another host, verify `docker compose config --help` includes `--no-env-resolution` first.
If unsupported, use `--quiet` or `--images`; do not remove just the no-env-resolution flag.

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml config --quiet
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml config --no-interpolate --no-env-resolution
```

`config --quiet` exits `0` and prints nothing when the merge is valid; a missing or unset
`THOTH_STAGE1_PROVIDER_ENV_FILE` fails there, before any container is created.

Once the override is in use, every later Compose command for this project repeats both `-f` flags. A
command that omits the override and recreates the worker silently rebuilds it without the provider
input, which is the same failure the override exists to prevent.

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

## Scout runtime contents

The legacy Scout fallback needs two things the earlier image did not provide, both corrected by
[the Scout runtime corrective design](../superpowers/specs/2026-09-06-stage1-scout-runtime-corrective-design.md).
Verify them against the digest actually deployed rather than assuming any image has them.

| Requirement | State in a corrected image | How Scout uses it |
| --- | --- | --- |
| `yt-dlp` | pinned `2026.8.19`, which reports itself as `2026.08.19`, installed as `/opt/thoth/python/.venv/bin/yt-dlp` | video acquisition and thumbnail resolution in `trace_source` and `build_footage` |
| `gallery-dl` | pinned `1.32.11`, installed as `/opt/thoth/python/.venv/bin/gallery-dl` | image-post acquisition where no video stream exists |
| Sibling-reachable CDP | supervisor relay on `18800`, Chromium itself still on loopback | `THOTH_CDP` from the worker container |

Scout resolves each downloader from `YTDLP` and `GALLERY_DL`, falling back to `PATH`; the image
sets both to the absolute paths above and both also resolve on `PATH` for its non-root user. The
build itself gates their presence and exact versions after switching to that user, so an image that
builds cannot be missing them. The Python TikTok path stays headless-first with its CDN fallback
and does not use either downloader, so their absence does not fail every direct-CDN branch; it
fails the legacy Scout steps that shell out to them.

The sidecar's healthcheck probes `127.0.0.1` from inside the container, so a `healthy` sidecar is
not evidence that any other container can reach it. Chromium binds DevTools to loopback whatever
address it is given; sibling reachability comes from the relay in front of it. The two-container
smoke is what proves that transport:

```bash
bash docker/test-cdp-offline.sh <image-ref>
```

It starts the browser on a throwaway internal network with no published ports, then, from a second
container, proves HTTP discovery, a browser-level WebSocket session, and a page session opened by
Scout's own CDP client. It also proves the supervisor dies with Chromium and that it leaves nothing
behind. CI runs the same script on the pull-request candidate and on the published digest. It
targets `about:blank` and reaches no external site, so it is an offline transport proof and says
nothing about live acquisition, parity, or provider acceptance.

A second offline harness proves the other half: that a parity reference owns its browser instead of
borrowing the deployment's.

```bash
bash docker/test-parity-offline.sh <image-ref>
```

It runs the one-shot reference container on a throwaway internal network next to a synthetic
sentinel that takes the `legacy-cdp` alias and counts every request made to it. A pass requires the
reference to start its own Chromium, drive it with Scout's own CDP client to a page the probe serves
itself on loopback, find its profile empty, leave the sentinel's request count at zero, fail when
its browser is killed, stop when cancelled, and leave no container or network behind. CI runs it on
the pull-request candidate and on the published digest. Like the transport smoke, it contacts no
site and no provider, so it says nothing about live acquisition, parity, or provider acceptance.

## Controlled live gate

The approved mode is `python_tiktok_with_legacy_fallback`. Starting the CDP sidecar opens TikTok and
requires explicit operator approval plus the locally supplied fixture. Stop on authentication wall,
challenge, unexpected routing, redaction failure, or cleanup failure.

The CDP health check requires a responding `/json/version` endpoint and a page target served over
HTTPS from an exact TikTok host whose path carries no authentication or challenge marker. A login
wall, a captcha, or a look-alike host is unhealthy by design. A CDP failure blocks worker startup
while legacy fallback mode is selected; that must not be worked around by relaxing the health check
or publishing port `18800`.

The sidecar runs with `seccomp:unconfined` because Chromium's own sandbox needs syscalls the
default Docker profile blocks. The relaxation is deliberate, it is scoped to the single container
that browses TikTok, and no other service may relax its sandbox. Replace it with a pinned Chromium
seccomp profile once one is available. It is never a substitute for the health probe, which stays
fail-closed.

Once the sidecar and worker are approved and running, verify their identity and isolation:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml exec worker id -u
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml exec legacy-cdp id -u
docker inspect -f '{{json .NetworkSettings.Ports}}' "$(docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml ps -q legacy-cdp)"
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml exec worker printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml run --rm --no-deps -T worker bun /opt/thoth/scout/runtime/provider_check.ts
```

- Both identity commands must print `10001`.
- The provider check prints one line per reference role and must report `chat_ready=true`,
  `vision_ready=true`, `embed_ready=true`, and `ocr_model_ready=true`. It contacts no provider, so
  it proves the configuration arrived, not that the account can serve a request.
- The bindings command must print a map whose every value is `null`. A `HostPort` entry means
  the sidecar is reachable outside the private network and the gate stops here. `docker compose
  port` is not a substitute: it reports an exposed port as `invalid IP:0` and exits `0` whether
  or not that port is published, so it cannot distinguish the two.
- The worker mode must print `python_tiktok_with_legacy_fallback`.

Perform exactly one controlled fallback smoke on first activation. Establish the soak start
timestamp only after that smoke passes.

## Soak parity samples

A reference is captured in its own disposable container from `compose.stage1.parity.yml`, with its
own Chromium on a fresh anonymous profile. It never attaches to the deployment's `legacy-cdp`
sidecar, and it never overrides the `worker` service. That profile is anonymous by design, so a
fixture behind a login wall stops the reference; seeding a profile or provisioning cookies is a
separate approval. The deployed worker's real legacy fallback is unchanged and still drives the
shared sidecar.

Follow [Stage 1 Soak Parity Sampling](stage1-parity-sampling.md) for the five required same-URL
Python/Scout comparisons, artifact integrity checks, workflow-to-reference evidence, and rules for
recording `parity_passed`. Cross-provider checksum equality is not the parity criterion.

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

## Activating a corrected image on a new window

This sequence has not been executed. It is the recorded procedure for the operator who later deploys
a corrected image, and every step below is an operator action that requires its own approval. A
soak window in flight is frozen: do not apply any of this to it.

1. Archive the existing window intact. Keep the old observations, references, capture logs, and
   pairing records exactly as recorded; do not re-label, re-run, or delete them. Record the closure
   of the old window with its digest, its start timestamp, and the reason it is closing.
2. Publish the corrected image and wait for every gate on that push to pass, including the
   published-digest infrastructure smoke and `docker/test-cdp-offline.sh`. A build that is green
   locally is not a published artefact. Every push mints a new digest, so a digest read from an
   earlier run is the wrong artefact.
3. Record the exact implementation commit, the digest from that commit's Actions summary, and the
   revision of the provider configuration being deployed. These three are the identity of the new
   window. Adding or rotating the provider file changes runtime configuration, not the digest, so
   both must be recorded separately.
4. Validate the operator inputs against that digest with `stage1-local-preflight --provider-env-file`
   before pulling, then render the merged Compose pair with `config --quiet`.
5. Deploy every THOTH role — API, worker, and the CDP sidecar — on that one digest. A mixed
   deployment invalidates the window before it starts.
6. Keep the existing persistent state: the artifact root, the browser profile, and the PostgreSQL
   volume carry forward. Do not recreate them for a version change.
7. Reconcile in-flight workflows before accruing anything new. Let them finish, cancel them
   explicitly, or record them as carried over; a workflow that spans two digests belongs to neither
   window.
8. Verify identity, isolation, provider readiness, and worker mode as in the controlled live gate
   above, then run one explicitly approved parity pair and one controlled fallback exercise. Both
   need their own approval; neither is implied by this document.
9. Only after those pass, start a separate new dataset with a new start timestamp. Do not merge it
   with the archived window's observations, and do not carry the old window's parity results forward.

Every retry at any step is explicit and recorded. A failure is evidence and is recorded as such: a
failed reference, a failed fallback exercise, or a failed smoke is a result, not something to retry
until it succeeds.

## Restart and rollback preparation

An ordinary restart keeps the same digest and the same environment:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml restart worker
```

The rollback mode is `legacy_scout` and may be applied only during the approved rollback drill. Set
`THOTH_STAGE1_ACTIVITY_MODE` to that value in `.env.stage1.local`, then recreate only the worker.
Restarting the container reuses the environment it was created with, so a restart alone would
silently keep the previous mode:

```bash
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml up -d --no-deps --force-recreate worker
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml exec worker printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
```

The mode command must print the mode that was just selected; if it prints the previous mode, the
rollback has not taken effect and the drill stops. Recreating only the worker preserves Temporal
history and artifacts for audit.

Do not run `docker compose down -v` and do not delete `THOTH_STAGE1_DATA_ROOT` during restart or
rollback. The rollback drill is not performed until the soak report is ready, and it remains subject
to explicit human approval.
