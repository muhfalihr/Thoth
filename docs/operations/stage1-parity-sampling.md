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
COMPOSE="docker compose --env-file .env.stage1.local   -f compose.stage1.local.yml -f compose.stage1.providers.yml"
```

The second `-f` is the provider override described in the deployment runbook and requires
`THOTH_STAGE1_PROVIDER_ENV_FILE` to be exported. A window that was deployed without the override
omits it here too: the `-f` set must match the one the deployment was created with, or a command
that touches the worker recreates it with different configuration.

None of these commands redeploy, recreate, or restart a service, and none of them change the
worker's activity mode. The deployed worker keeps running its Temporal workflows throughout.

### 1. Prepare one isolated sample directory

Keep the directory outside this repository and outside the deployed data root, one per sample. It
is restricted storage: the fixture URL, the reference process output, and both sides' artifacts all
land inside it and none of them may be pasted into chat, an issue, or the change record.

```bash
SAMPLE_DIR="$HOME/thoth-stage1-parity/<sample-id>"
IMAGE=$(docker inspect -f '{{.Image}}' "$($COMPOSE ps -q worker)")
mkdir -p "$SAMPLE_DIR/python/reports" "$SAMPLE_DIR/scout-output" "$SAMPLE_DIR/reference-input"
chmod 700 "$SAMPLE_DIR"
# Write the approved fixture URL into "$SAMPLE_DIR/url.txt" with an editor, then:
chmod 600 "$SAMPLE_DIR/url.txt"
cp "$SAMPLE_DIR/url.txt" "$SAMPLE_DIR/reference-input/url"
chmod 555 "$SAMPLE_DIR/reference-input"
chmod 444 "$SAMPLE_DIR/reference-input/url"
docker run --rm --network none --user 0:0 -v "$SAMPLE_DIR/scout-output:/w" "$IMAGE" \
  sh -c 'chown -R 10001:10001 /w && install -d -o 10001 -g 10001 -m 755 /w/legacy-scout/<reference-id>'
```

`url.txt` stays readable by the operator because the offline comparison reads it. The
`reference-input` copy exists only so the reference container can read the fixture without it being
typed into a command; it is readable by any identity *inside* that container, and protected on the
host by the `700` sample directory above it. The Scout output directory must be owned by
`10001:10001` because the container writes into it, and `<reference-id>` must exist before the run
because the Scout CLI does not create its `--out` parent — `LegacyScoutActivity` does that itself
before it spawns Bun. A one-shot root container from the pinned image performs both, so the
procedure needs no host root; use `sudo chown -R 10001:10001` instead where passwordless `sudo` is
available. Nothing here may be world-writable.

### 2. Capture the Scout reference on the pinned image

The reference runs `bun scout/cli.ts run <url> --out <path>`, the same fixed command the legacy
Scout activity builds, inside a throwaway container created from the window's pinned image on the
existing `stage1-private` network. `--no-deps` keeps Compose from starting or recreating any
service, and the already-running `legacy-cdp` sidecar is reached over that network. The Scout
output directory is fixed at `/opt/thoth/scout/output`, so the sample directory is bound onto that
path and Scout's media lands beside the reference report.

Three properties of this invocation are deliberate:

- The URL is read inside the container from the read-only mount, not interpolated on the host. The
  Scout CLI takes the URL positionally, so it necessarily reaches the argument vector of the `bun`
  process; what this avoids is the URL entering the operator's shell history, the `docker compose`
  argument vector, the Docker API request, and the container configuration that `docker inspect`
  reports. Treat the in-container argument as a real residual exposure on a shared host: anyone who
  can read the host process table during the run can see it, and `docker inspect` output must not
  be pasted anywhere regardless.
- `-T` disables the pseudo-TTY so stdout and stderr stay separate streams, and both are captured
  into restricted files instead of the terminal. Scout inherits its child processes' stdio and logs
  the URL, captions, and local paths; the Python legacy adapter pipes both streams and keeps them
  out of its diagnostics for exactly this reason, so an operator-run reference must not print them.
- `umask 077` makes those capture files readable only by the operator.

```bash
( umask 077 && $COMPOSE run --rm --no-deps -T \
    -v "$SAMPLE_DIR/scout-output:/opt/thoth/scout/output" \
    -v "$SAMPLE_DIR/reference-input:/run/parity:ro" \
    worker sh -c 'exec bun scout/cli.ts run "$(cat /run/parity/url)" --out "$0"' \
    /opt/thoth/scout/output/legacy-scout/<reference-id>/source-report.json \
    >"$SAMPLE_DIR/reference.stdout.log" 2>"$SAMPLE_DIR/reference.stderr.log" )
echo "reference exit: $?"
```

Preconditions: `legacy-cdp` is already healthy under the controlled live gate, and the deployed
worker stays in `python_tiktok_with_legacy_fallback`. One more precondition is easy to miss and
fails the reference late: Scout's `trace_source` step calls a vision model, so the reference
container needs a provider key — `THOTH_NOVITA_API_KEY` for the default provider, or the key
variable belonging to whatever `THOTH_SCOUT_VISION_PROVIDER` selects. The Stage 1 deployment
deliberately carries no model provider secret, so a reference launched with the worker service's
environment alone aborts with `OCR analysis failed (missing_api_key)` and writes a report with no
media. For a window deployed with `compose.stage1.providers.yml`, that input is already part of the
worker service definition, and `run` creates its container from that definition — so the reference
and the deployed worker receive identical provider configuration with no separate injection step.
Verify it before spending a fixture with
`$COMPOSE run --rm --no-deps -T worker bun /opt/thoth/scout/runtime/provider_check.ts`, which prints
role readiness only and contacts no provider.

The reference-only alternative is `docker compose run --env-from-file` (Compose 5.5 and newer)
pointing at a `600` file on restricted storage that holds the provider variables and nothing else.
It remains valid for a window whose deployment is frozen without the override, and it is superseded
by the shared override for any new window. The global `docker compose --env-file` is not an
alternative: it only feeds interpolation and injects nothing into the container. Never add the
override or the key to a deployment that is frozen for an in-flight window; that changes the
deployment under evaluation.

Two further preconditions are properties of the image itself, so they cannot be fixed by an
env-file, and both block a reference on the *required* `trace_source` and `build_footage` steps:

- `yt-dlp` is not installed in the image — no binary on `PATH`, no `yt_dlp` module in the bundled
  virtualenv — and Scout shells out to it from those steps.
- The DevTools port of the `legacy-cdp` sidecar is bound to loopback inside that container even
  though its launcher passes `--remote-debugging-address=0.0.0.0`, so `THOTH_CDP` resolves by DNS
  but refuses TCP from every other container. The service's own healthcheck passes because it probes
  `127.0.0.1` from inside.

Verify both before spending a fixture on a reference run; the same two gaps would also break the
deployed worker's legacy fallback if it ever fired. Confirm afterwards that nothing was recreated
and that no reference container is left behind:

```bash
$COMPOSE ps --format '{{.Service}} {{.Status}}'
$COMPOSE exec worker printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE
```

Remove the container-readable fixture copy once the reference has run, and keep the two capture
logs with the sample as restricted evidence:

```bash
chmod 700 "$SAMPLE_DIR/reference-input" && rm -rf "$SAMPLE_DIR/reference-input"
```

Diagnose a failed reference from those logs privately. Record only the exit status and a short
non-quoting summary in the pairing record. Stop on an authentication wall, a captcha, or a
challenge; record the reference failure rather than retrying until it succeeds. A failed reference
is evidence, not a discard.

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
five times does **not** create five durable soak observations. Its success must not be attached to
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

Collect at least five separately identified, evidence-backed parity samples. Reusing a single
approved fixture is not prohibited by the current policy, but each sample needs a fresh actual run
and its own paired evidence; copying one result five times is invalid. Fixture diversity is useful,
not an additional gate imposed by this document. Keep every failed designated sample visible.

The evaluator measures seven days from the earliest to latest included valid-completed observation,
not from container startup or an operator's planned start time. It also requires at least fifty
valid-completed runs and the existing success/fallback/failure and zero-tolerance gates. Five parity
samples may be part of those fifty runs; they do not replace them. An estimate of eight runs per day
is scheduling guidance, not permission to fabricate timestamps or observations.

A laptop resume or restart on the same digest does not automatically invalidate the window, but
failed or interrupted workflows must be reconciled and preserved. Capture evidence promptly;
in-memory API events can disappear after restart. Recover missing events from retained Temporal
history when available; absence of cleanup evidence is never cleanup success. Extend collection if
the run count or time span is insufficient. Readiness still requires the existing operator review,
rollback drill, and human decision; parity completion alone does not authorize Task 10.
