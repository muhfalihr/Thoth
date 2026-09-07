# Stage 1 Soak Parity Sampling

## Definition and authority

Parity means **Python versus legacy Scout for the same public, first-party TikTok post**.
It does not mean equality between two downloaded files' checksums. This definition already exists
in `docs/superpowers/specs/2026-08-31-python-tiktok-scout-rewrite-design.md`, under Contract parity,
and in the same-URL requirement of the Stage 1 cutover spec. No new retirement criterion is added.

The executable reference is
`python/tests/live/test_tiktok_acquisition_live.py::test_live_python_and_legacy_tiktok_contracts_match`.
Its `normalize_python_tiktok` and `normalize_legacy_tiktok` functions define the comparison. They
now live in `python/src/thoth_control_plane/operations/tiktok_parity.py`, which both that live test
and the offline comparison command import, so the contract has one implementation:

| Field | Required comparison |
| --- | --- |
| `canonical_url` | Same canonical post URL |
| `platform` | Same platform, TikTok |
| `post_id` | Same post identity |
| `owner_handle` | Equal after the existing normalizers |
| `caption` | Equal after the existing normalizers; no new fuzzy matching |
| `media_kind` | Both video |
| `media_index` | Both 1 |
| `local_media_present` | Both true, with independently validated local artifacts |
| `outcome` | Both resolved |

Use the established normalizers rather than adding case folding, caption tolerances, duration
tolerances, or new checksum-equality rules. Different encodings from headless and CDN acquisition
can produce different bytes for the same post. Recompute each artifact's checksum and compare it
to its own recorded checksum; this proves integrity, not cross-implementation contract parity.
Matching checksums alone do not prove metadata or source-identity parity.

## Release and evidence boundary

Keep the deployed THOTH digest and evaluated implementation commit frozen for the active window.
New documentation commits and newly published images do not require redeployment. Execute the
Python and Scout acquisition paths from the window's pinned image, preserving the deployed worker
mode. A separate Scout comparison is a reference run, not a rollback or an automatic fallback.

Keep a restricted pairing record outside Git alongside operational evidence. For each sample,
record the observation/workflow references, comparison reference, UTC timestamps, pinned digest,
evaluated commit, artifact references, per-field comparison booleans, integrity-check results, and
reviewer. Verify the same input URL privately; never copy it or normalized metadata into chat,
aggregate reports, or the change record. Keep raw reports in their existing restricted artifact
storage. The change record should reference the pairing evidence, not embed its contents.

The strict observation schema remains unchanged. Do not add digest, checksum, URL, caption, path,
or diagnostic fields to observation JSONL. The pairing record supplies provenance the evaluator
cannot check by itself.

## Collect one sample

1. Designate a fresh workflow as a parity sample before acquisition. Use an approved public post
   from its original creator: Scout may reject a repost or trace it to another source. That is a
   real mismatch for this fixture, not permission to substitute another URL silently.
2. Run the ordinary source-investigation workflow on the pinned deployment. Preserve its workflow
   identity, final report, actual attempt sequence, cleanup events, and timestamps. Python headless
   remains first and CDN second. A Python-native result resolved through CDN is still Python-native.
3. Run a separately identified Scout comparison for the same input using the pinned image and
   isolated output directory. Keep the normal worker in `python_tiktok_with_legacy_fallback`.
   Do not force a production Python failure to obtain the Scout reference. Stop on authentication
   walls or challenges; do not bypass them. Record reference failures rather than replacing them
   with a successful retry in the evidence.
4. Validate each report and local artifact independently: schema, expected artifact-root
   containment (including symlinks), MP4 signature, minimum size, byte count, and recorded checksum.
   An absent checksum or incomplete validation is not a pass. The Python live smoke contains the
   existing size/signature/byte-count/checksum checks; mere file existence in the parity normalizer
   does not replace those checks. Preserve cleanup/redaction validation separately.
5. Normalize the two reports with the established reference functions and compare all nine fields.
   Store comparison booleans and restricted evidence references, not raw differing values in logs.
   The Python report must belong to the actual soak workflow selected in step 1.
6. Update the single observation for that workflow only after evidence review. Set
   `artifact_validated=true` only after artifact validation succeeds; set `parity_passed=true`
   only when the paired comparison passes. With valid artifacts and a completed mismatching
   comparison, set `parity_passed=false`. A designated sample with invalid artifacts cannot express
   a parity boolean in schema v1: retain the real artifact failure, keep the pairing failure in
   restricted evidence, and block operator readiness. Never force artifact validation to true to
   satisfy the model. Pending evidence remains pending, not a fabricated success.

Archive the original observation dataset before an evidence-backed correction, and evaluate only
the corrected authoritative dataset. Do not append a second observation for the same workflow,
change its actual route, or erase failed samples. A Scout reference is not an extra production
workflow observation and does not count as a legacy fallback. If a reference is submitted as an
actual in-scope Temporal workflow, it must be reconciled according to the existing window rules;
do not silently omit it from the denominator.

## Commands

Run every command from the WSL shell that owns `THOTH_STAGE1_DATA_ROOT`, started in this
repository checkout, exactly as [Stage 1 Local Docker Operations](stage1-local-docker.md)
requires. `COMPOSE` below stands for the runbook's invocation:

```bash
COMPOSE="docker compose --env-file .env.stage1.local -f compose.stage1.local.yml -f compose.stage1.providers.yml"
```

The second `-f` is the provider override described in the deployment runbook and requires
`THOTH_STAGE1_PROVIDER_ENV_FILE` to be exported. A window that was deployed without the override
omits it here too: the `-f` set must match the one the deployment was created with, or a command
that touches the worker recreates it with different configuration.

The reference itself no longer uses that file set. It runs from `compose.stage1.parity.yml`, a
standalone file with its own project name, described in step 2. `$COMPOSE` below is used only to
read the deployment's state and to copy the Python side's evidence out of it.

None of these commands redeploy, recreate, or restart a service, and none of them change the
worker's activity mode. The deployed worker keeps running its Temporal workflows throughout.

## Anonymous profile and the authentication stop

The reference container starts Chromium on a fresh, anonymous tmpfs profile and discards it when the
container exits. That is the property that keeps a reference from disturbing the deployment, and it
is also a hard limit: the reference is signed out. A fixture behind a login wall, a captcha, or an
age gate will stop the reference, and that stop is the recorded result.

Seeding the profile is out of scope for this procedure and needs its own operator approval. Copying
a live browser profile, exporting cookies from one, or provisioning a login into the reference
container are all separate decisions, and none of them is authorised by this document. Each of the
following is its own gate, and none of them follows automatically from a stopped reference:

- **Cookie or profile provisioning** — a separate approval, not a workaround for this stop.
- **Fixture replacement** — swapping in an easier URL changes what the window measured.
- **Reference retry** — re-running until it succeeds discards the failure that was the result.
- **Production fallback recovery** — the deployed worker's own path is untouched by this document.
- **New window activation** — a stopped reference is not a reason to open or close a window.

This isolation applies to parity references only. The deployed worker's real legacy fallback still
drives the shared `legacy-cdp` sidecar exactly as before; nothing here changes that path, its
profile, or its acquisition policy.

### 1. Prepare one isolated sample directory

Keep the directory outside this repository and outside the deployed data root, one per sample. It
is restricted storage: the fixture URL, the reference process output, and both sides' artifacts all
land inside it and none of them may be pasted into chat, an issue, or the change record.

The reference identifier must be new. The reference container creates its evidence directory
non-recursively and opens every log with an exclusive create, so a repeated identifier aborts the
run instead of overwriting an earlier attempt; the host preflight rejects a sample that already
holds a `reference-attempt.json` for the same reason.

```bash
SAMPLE_DIR="$HOME/thoth-stage1-parity/<sample-id>"
export THOTH_PARITY_SAMPLE_DIR="$SAMPLE_DIR"
export THOTH_PARITY_REFERENCE_ID=<reference-id>
export THOTH_PARITY_IMAGE=ghcr.io/muhfalihr/thoth@sha256:<the window's pinned digest>
mkdir -p "$SAMPLE_DIR/python/reports" "$SAMPLE_DIR/scout-output" "$SAMPLE_DIR/reference-input"
chmod 700 "$SAMPLE_DIR"
# Write the approved fixture URL into "$SAMPLE_DIR/url.txt" with an editor, then:
chmod 600 "$SAMPLE_DIR/url.txt"
cp "$SAMPLE_DIR/url.txt" "$SAMPLE_DIR/reference-input/url"
docker run --rm --network none --user 0:0 -v "$SAMPLE_DIR/scout-output:/w" -v "$SAMPLE_DIR/reference-input:/f" "$THOTH_PARITY_IMAGE" sh -c 'chown -R 10001:10001 /w && chgrp 10001 /f/url && chmod 640 /f/url'
```

`url.txt` stays owned by the operator because the offline comparison reads it. The
`reference-input` copy exists only so the reference container can read the fixture without it being
typed into a command. Docker honours host permissions on a bind mount, so that copy must be
readable by the container's group: `640` with group `10001` is the narrowest mode that works, and
the `700` sample directory above it is what keeps it private on the host. The Scout output
directory must be owned by `10001:10001` because the container writes into it. The reference
container creates its own `legacy-scout/<reference-id>` directory, so nothing pre-creates it. A
one-shot root container from the pinned image performs both ownership changes, so the procedure
needs no host root; use `sudo` directly where passwordless `sudo` is available. Nothing here may be
world-readable or world-writable.

Then check the inputs before creating anything. The gate is fail-closed and prints booleans and
contract descriptions only — never a rejected value:

```bash
uv run --project python -m thoth_control_plane.operations.stage1_parity_preflight --image "$THOTH_PARITY_IMAGE" --sample "$SAMPLE_DIR" --provider "$THOTH_STAGE1_PROVIDER_ENV_FILE" --repository-root "$PWD" --data-root "$THOTH_STAGE1_DATA_ROOT"
```

It refuses a mutable image tag, a sample inside this checkout or inside the deployed data root, a
symlink anywhere in the sample, a fixture that is not a canonical TikTok post URL, a sample that
already holds an attempt record, and a `THOTH_CDP` inherited from the operator's shell. That last
one is not a nuisance check: a reference that can be pointed at the deployment's sidecar is the
failure this container exists to prevent.

The pinned image must be the same release the deployed worker runs. A reference captured on a
different image is not evidence about this window:

```bash
test "$THOTH_PARITY_IMAGE" = "$(docker inspect -f '{{index .RepoDigests 0}}' "$(docker inspect -f '{{.Image}}' "$($COMPOSE ps -q worker)")")" && echo digest_equal=true
```

### 2. Capture the Scout reference in its own container

The reference runs from `compose.stage1.parity.yml`, a standalone file that composes exactly one
disposable service. It is never merged with the deployment file and never overrides the `worker`
service. The container starts its own Chromium on a fresh tmpfs profile, exposes DevTools on its own
loopback address only, supervises Scout against it, and exits when Scout exits.

```bash
PARITY="docker compose -f compose.stage1.parity.yml"
```

That separation exists because of an observed incident, not a theoretical risk. A reference driven
against the shared `legacy-cdp` sidecar navigates that sidecar's only page wherever the source trail
leads. The sidecar's healthcheck asserts a live non-login `tiktok.com` page, so the sidecar went
unhealthy while CDP itself stayed reachable and its restart count stayed at zero. One incident
establishes the risk; it does not establish that every reference degrades the sidecar.

Three properties of this invocation are deliberate:

- The URL is read inside the container from the read-only mount, and it never reaches an argument
  vector the host can see. The supervisor reads `/run/parity/url`, validates it, and passes it to
  Scout inside the container. `docker inspect` on the reference reports the mount, not the URL.
- The supervisor redirects Scout's stdout, Scout's stderr, and the browser's output into three
  restricted files inside the sample directory. Scout logs the URL, captions, and local paths, so
  none of that reaches the terminal.
- `THOTH_CDP` is set to the container's own loopback endpoint by the Compose file, and the
  supervisor refuses to start if it is anything else. The reference cannot attach to the deployment
  sidecar even if the operator's shell says otherwise.

Record the deployment's identity and health before the run, so the after-check has something to
compare against:

```bash
$COMPOSE ps --format '{{.Service}} {{.Status}}'
docker inspect -f '{{.Id}} {{.State.Health.Status}} {{.RestartCount}}' "$($COMPOSE ps -q legacy-cdp)"
```

Then run the reference and tear down the sample's own project:

```bash
( umask 077 && $PARITY up --abort-on-container-exit --exit-code-from reference >"$SAMPLE_DIR/reference.console.log" 2>&1 )
echo "reference exit: $?"
$PARITY down --volumes --remove-orphans
```

Preconditions: the provider file exists and carries a key for whatever
`THOTH_SCOUT_VISION_PROVIDER` selects. Scout's `trace_source` step calls a vision model, so a
reference launched without one aborts with `OCR analysis failed (missing_api_key)` and writes a
report with no media. The Stage 1 deployment deliberately carries no model provider secret, which is
why the parity file takes a restricted `env_file` of its own. Verify readiness before spending a
fixture with

```bash
$PARITY run --rm reference bun /opt/thoth/scout/runtime/provider_check.ts
```

which prints role readiness only and contacts no provider. Offline provider readiness is not
evidence of authentication, quota, or model health.

Two further preconditions are properties of the image itself, so no env-file can fix them, and both
block a reference on the *required* `trace_source` and `build_footage` steps. They were observed on
the digest deployed for the window that opened on 2026-09-04, and that observation stands as
recorded evidence for that window:

- `yt-dlp` was not installed in that image — no binary on `PATH`, no `yt_dlp` module in the bundled
  virtualenv — and Scout shells out to it from those steps.
- The DevTools port of the `legacy-cdp` sidecar was bound to loopback inside that container even
  though its launcher passed `--remote-debugging-address=0.0.0.0`, so `THOTH_CDP` resolved by DNS
  but refused TCP from every other container. The service's own healthcheck passed because it probes
  `127.0.0.1` from inside.

Both are addressed by
[the Scout runtime corrective design](../superpowers/specs/2026-09-06-stage1-scout-runtime-corrective-design.md):
the image now pins `yt-dlp` and `gallery-dl` as executables owned by the image's non-root user, and
the sidecar runs a private in-container relay that accepts sibling connections while Chromium itself
stays on loopback. That correction lives in an unpublished image, it changes nothing for a window
already in flight, and it is proven only offline. A frozen window keeps its own digest.

Verify both against the digest actually deployed before spending a fixture on a reference run; the
same two gaps would also break the deployed worker's legacy fallback if it ever fired.

Confirm afterwards that the deployment was not touched, that no reference container survived, and
that the disposable profile went with it:

```bash
docker inspect -f '{{.Id}} {{.State.Health.Status}} {{.RestartCount}}' "$($COMPOSE ps -q legacy-cdp)"
$COMPOSE exec worker printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
docker ps --all --filter 'label=com.docker.compose.project=thoth-stage1-parity' --format '{{.Names}} {{.Status}}'
```

The sidecar's container id, health, and restart count must be unchanged, the worker's activity mode
must be unchanged, and the last command must print nothing. The profile lives only in the
container's tmpfs, so an empty listing is the confirmation that it was discarded; there is no host
path to inspect and nothing to clean up by hand.

Remove the container-readable fixture copy once the reference has run, and hand the evidence back to
the operator identity — the container writes it as `10001` with owner-only modes, so it is otherwise
unreadable on the host:

```bash
docker run --rm --network none --user 0:0 -v "$SAMPLE_DIR/scout-output:/w" "$THOTH_PARITY_IMAGE" sh -c "chown -R $(id -u):$(id -g) /w"
chmod 700 "$SAMPLE_DIR/reference-input" && rm -rf "$SAMPLE_DIR/reference-input"
```

The run leaves four files under `$SAMPLE_DIR/scout-output/legacy-scout/<reference-id>/`:
`reference-attempt.json` with the supervisor's own lifecycle result, and `reference.stdout.log`,
`reference.stderr.log`, and `browser.log`. The attempt record is reserved as
`{"status": "pending"}` before the browser starts and replaced in one step when the supervisor
finishes, so a record still reading `pending` means the container died without a verdict and its
evidence is incomplete. A finished record carries the reference exit code, the browser's exit
signal, and `browser_isolation: fresh_ephemeral`. All four are restricted evidence:
diagnose a failed reference from them privately and record only the exit status and a short
non-quoting summary in the pairing record.

**A reference exit of zero is not a parity pass.** It says the reference ran to completion in its
own container; the comparison in step 4 is the only thing that speaks to parity. Stop on an
authentication wall, a captcha, or a challenge; record the reference failure rather than retrying
until it succeeds. A failed reference is evidence, not a discard.

Then record the reference artifacts' integrity. Read `main.source_local` privately from the
reference report and rebase its `/opt/thoth/scout/output` prefix onto `$SAMPLE_DIR/scout-output`:

```bash
sha256sum "$SAMPLE_DIR/scout-output/legacy-scout/<reference-id>/source-report.json"
sha256sum "$SAMPLE_DIR/scout-output/acquisition-media/<recorded-file>"
stat -c %s "$SAMPLE_DIR/scout-output/acquisition-media/<recorded-file>"
```

Scout records no checksum or byte count of its own, so these capture-time values become part of the
restricted pairing record. Re-verifying them at comparison time proves the reference artifact has
not changed since capture; it does not attest the download itself.

### 3. Stage the Python evidence

Copy the actual soak workflow's report tree out of the running worker. `docker cp` reads the
container filesystem without executing anything inside it, which also avoids needing root to read
the `750` artifact root on the host.

```bash
docker cp "$($COMPOSE ps -q worker)":/var/lib/thoth/artifacts/reports/<workflow-id> \
  "$SAMPLE_DIR/python/reports/"
```

The Python report's own checksum is not recomputed here: take it from the `source_report` artifact
reference in that workflow's typed events, which is what the comparison validates the copied bytes
against.

### 4. Compare offline

`thoth-control operations tiktok-stage1-parity-compare` reads the two reports, validates each
side's artifacts independently, and compares the nine normalized fields. It contacts nothing,
writes nothing, and labels no observation. Its output is field names and booleans only, so it is
safe to run in a shared terminal.

```bash
uv run --project python thoth-control operations tiktok-stage1-parity-compare \
  --python-report "$SAMPLE_DIR/python/reports/<workflow-id>/source-report.json" \
  --python-artifact-root "$SAMPLE_DIR/python" \
  --python-report-checksum "sha256:<from the workflow source_report artifact ref>" \
  --scout-report "$SAMPLE_DIR/scout-output/legacy-scout/<reference-id>/source-report.json" \
  --scout-artifact-root "$SAMPLE_DIR/scout-output" \
  --scout-report-checksum "sha256:<recorded at capture>" \
  --scout-media-checksum "sha256:<recorded at capture>" \
  --scout-media-bytes <recorded at capture> \
  --input-url-file "$SAMPLE_DIR/url.txt"
```

`--scout-recorded-root` defaults to `/opt/thoth/scout/output` and is only needed when the reference
was captured under a different Scout root. `--input-url-file` supplies the canonical URL that a
content-set does not always carry in `main.source_url`; the file is read, never echoed.

The command exits `0` only when every artifact check passes and all nine fields match. It exits `1`
both for a completed mismatching comparison, which prints `field <name>: mismatch`, and for evidence
that cannot be compared at all, which prints one fixed message and no comparison lines. Those two
outcomes mean different things for the observation, so record which one occurred.

Validate the helper offline before pointing it at restricted evidence:

```bash
cd python && uv run python -m pytest tests/operations/test_tiktok_parity.py -q
```

### 5. Bind the evidence in the restricted pairing record

Append one entry per sample to the pairing record kept outside Git with the operational evidence. It
is the only place that binds a comparison to a release and a workflow, because the observation
schema carries none of it:

| Field | Source |
| --- | --- |
| `sample_id` | Assigned before acquisition, in step 1 of *Collect one sample* |
| `workflow_id` | The designated soak workflow |
| `observation_id` | The single observation for that workflow |
| `reference_id` | The separately identified Scout reference |
| `fixture_reference` | A private pointer to the fixture, never the URL itself |
| `python_run_at`, `reference_run_at` | UTC timestamps of both runs |
| `image_digest` | The window's pinned digest, unchanged for the whole window |
| `implementation_commit` | The evaluated commit that digest was built from |
| `python_report_ref`, `python_media_ref` | Restricted artifact locations with checksums and byte counts |
| `scout_report_ref`, `scout_media_ref` | Restricted artifact locations with capture-time checksums and byte counts |
| `artifact_checks` | The six per-side integrity booleans the comparison printed |
| `field_results` | The nine per-field booleans |
| `comparison_result` | `pass`, `mismatch`, or `evidence_incomparable` |
| `reviewer`, `reviewed_at` | Who verified the evidence, in UTC |

Store the record where the raw reports already live. Reference it from the change record; never
embed its contents, the fixture URL, or normalized metadata there.

### 6. Update the one existing observation

Only after the pairing record is complete and reviewed. Archive the authoritative dataset first,
edit the single observation for that workflow, and evaluate only the corrected file:

```bash
cp "$THOTH_STAGE1_DATA_ROOT/observations/<dataset>.jsonl" \
   "$THOTH_STAGE1_DATA_ROOT/observations/<dataset>.jsonl.<utc-timestamp>.bak"
```

`artifact_validated` and `parity_passed` answer different questions, and conflating them corrupts
the dataset. `artifact_validated` is about the Python workflow's own artifacts, which is why schema
v1 requires it to be true on every `python_native` and `legacy_fallback` observation: an observation
whose own report or media failed validation is not a valid completed run at all. `parity_passed`
is about the comparison against the reference. Set them from the six Python-side artifact booleans
and the comparison outcome respectively:

- Six Python-side artifact booleans true: `artifact_validated=true`. Any of them false: the run is
  not a valid completed observation; record it as a failure, not as a `python_native` row.
- Comparison ran and all nine fields matched: `parity_passed=true`.
- Comparison ran and at least one field mismatched: `parity_passed=false`. The mismatch stays; it
  is a real result.
- Comparison could not run — a reference failure, missing reference media, or any false Scout-side
  artifact boolean: leave `parity_passed` unset. The sample counts as zero parity samples, the
  failure stays in both the pairing record and the change record, and operator readiness stays
  blocked. Schema v1 has no way to express "compared partially", and inventing a verdict to fill
  the field is falsifying evidence.

Do not append a second observation for the same workflow, do not change its recorded route, and do
not count the Scout reference as a production run or as a legacy fallback. Then re-evaluate:

```bash
uv run --project python thoth-control operations tiktok-stage1-soak \
  --observations "$THOTH_STAGE1_DATA_ROOT/observations/<dataset>.jsonl" \
  --output-directory "$THOTH_STAGE1_DATA_ROOT/reports"
```

## What the existing live test proves

The existing pytest test is useful for a controlled implementation comparison. It launches Python
and Scout directly, uses fixed test workflow IDs, and writes into temporary directories. Running it
repeatedly does **not** create durable soak observations. Its success must not be attached to
an unrelated workflow, an earlier report, or a different image release. Tests are absent from the
runtime image, so running the latest host checkout can also evaluate a different implementation.

For soak evidence, use the actual workflow report plus its paired Scout reference as described
above. Any new host-side comparison helper must consume existing reports, preserve the reference
normalization contract, emit only safe results, and leave acquisition and observation writes explicit.
Validate that helper offline before using it on restricted evidence.
`thoth-control operations tiktok-stage1-parity-compare` is that helper: it reads two reports that
already exist, never acquires, never writes an observation, and prints field names and booleans
only. Its passing offline tests say the comparison is correct, not that any parity sample passed.

## Window completion

Collect at least two separately identified, evidence-backed parity samples inside the window. Each
sample needs a fresh actual run and its own paired evidence; copying one result twice is invalid.
The two samples must use distinct approved, public, first-party TikTok posts, so a single fixture
cannot supply both. Keep every failed designated sample visible.

The isolated activation parity pair is collected before the window opens. It is not an observation
and never counts toward these two in-window samples. That gate must pass before a window opens. An
activation pair whose reference fails, produces no Scout media, or leaves any Scout-side
artifact-integrity check false is `evidence_incomparable`: preserved failure evidence, never a
parity pass, and never usable to satisfy the gate or an acceptance dataset. Failed activation
evidence stays in restricted evidence and is recorded in the operator change record; a retry,
replacement sample, or evidence correction requires separate approval. Read the current gate state
from that change record rather than from this runbook.

The evaluator measures 24 hours from the earliest to latest included valid-completed observation,
not from container startup or an operator's planned start time. It also requires at least twelve
valid-completed runs and the existing success/fallback/failure and zero-tolerance gates. The two
parity samples may be part of those twelve runs; they do not replace them. At twelve runs a single
legacy fallback is 8.33 percent and breaches the unchanged 5 percent ceiling, so schedule accordingly.
Run-per-day estimates are scheduling guidance, not permission to fabricate timestamps or observations.
These thresholds come from
`docs/superpowers/specs/2026-09-07-stage1-accelerated-acceptance-design.md`, which supersedes only
the window, run-count, and parity numbers. Every report embeds the policy it was evaluated with, so
archived datasets retain their original thresholds and are never reclassified under the accelerated
defaults.

A laptop resume or restart on the same digest does not automatically invalidate the window, but
failed or interrupted workflows must be reconciled and preserved. Capture evidence promptly;
in-memory API events can disappear after restart. Recover missing events from retained Temporal
history when available; absence of cleanup evidence is never cleanup success. Extend collection if
the run count or time span is insufficient. Readiness still requires the existing operator review,
the controlled fallback exercise, restart recovery, the rollback drill, and the human decision;
parity completion alone does not authorize Task 10. An evaluator verdict of `ready: true` is
necessary but not sufficient, and approving Python as the default neither removes nor disables the
TypeScript Scout path.
