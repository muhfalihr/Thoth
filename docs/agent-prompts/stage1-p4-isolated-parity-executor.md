# Stage 1 p4 Isolated Parity Executor

Copy the following prompt into the Claude executor task. Issuing it is explicit
operator authorization for one new live activation parity sample named p4. It
does not authorize deployment, a retry, Issue mutation, controlled fallback,
or acceptance-window activation.

```text
Mode: IMPLEMENT_PLAN — execute exactly one isolated activation parity sample p4

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci

Objective:
Execute one newly designated activation parity sample `p4` against the currently deployed immutable release. Run exactly one ordinary Python source-investigation workflow and, only when the Python side reaches a valid completed artifact state, exactly one isolated legacy Scout reference for the same operator-approved fixture. Validate both sides, compare the authoritative nine fields offline when evidence is comparable, append exactly one p4 sample record to the restricted pairing JSONL, clean up the disposable parity project, report the first result, and stop for independent review.

This is a new sample, not a retry or rewrite of p3. p1–p3 and the p3 classification amendment remain immutable.

Operator authorization embodied by this prompt:
- Access the operator-provided fixture only from `/home/mfr/thoth-stage1-parity/p4/url.txt`, without printing or copying its value into commands, chat, logs, Git, or GitHub.
- Make the live TikTok/CDN/provider requests inherent in one ordinary Python acquisition and one isolated Scout reference.
- Start exactly one new source-investigation workflow on the existing deployed worker.
- Start and remove exactly one disposable `compose.stage1.parity.yml` reference project.
- Read deployment identity/health, workflow state, typed events, p4 artifacts, and existing restricted pairing evidence as required for validation.
- Create the restricted p4 directories and files required by the runbook.
- Append exactly one new p4 sample row to `/home/mfr/thoth-stage1-parity/pairing-record.jsonl`, with a mode-0600 byte-identical sibling backup and prefix-preservation verification.

This authorization is single-use. Any ambiguous submission, timeout, terminal failure, authentication wall, challenge, incomplete artifact, mismatch, or cleanup failure is the first result. Preserve it and stop; do not retry or substitute another fixture.

Read completely, in order:
1. `CLAUDE.md`
2. `AGENTS.md` and its referenced instructions
3. `BLUEPRINT.md`
4. `docs/operations/stage1-local-docker.md`
5. `docs/operations/stage1-parity-sampling.md`
6. `docs/superpowers/specs/2026-09-07-stage1-parity-browser-isolation-design.md`
7. `docs/superpowers/specs/2026-09-06-stage1-scout-runtime-corrective-design.md`
8. `docs/superpowers/specs/2026-09-07-stage1-accelerated-acceptance-design.md`
9. `docs/superpowers/specs/2026-09-08-stage1-p3-evidence-amendment-design.md` only for amendment-aware JSONL preservation
10. `python/src/thoth_control_plane/operations/tiktok_parity.py`
11. The actual workflow/API/Temporal entrypoints needed to submit and reconcile one source-investigation workflow

Required process:
- Use `superpowers:executing-plans` with `docs/operations/stage1-parity-sampling.md` as the approved operational plan.
- Use `superpowers:verification-before-completion` before any completion claim.
- Use `superpowers:systematic-debugging` only for read-only diagnosis of an unexpected preflight or tooling failure; do not fix code, configuration, deployment, evidence, or the live result.
- Do not delegate fixture access, live execution, or evidence mutation to another agent.
- Chat and final report must be Indonesian. Code identifiers and safe reason codes remain English.
- Keep terminal output to safe identifiers, booleans, counts, method names, and public release identity. Never print raw restricted values.
- Do not modify any repository file, create a commit, or push.

Current reviewed checkpoint:
- Expected repository planning checkpoint at prompt issuance: `c1786b3c47c61e5a8fc06e04b5a808147484ff25`; this prompt commit or later operator-owned documentation commits may follow it. Confirm `c1786b3` remains an ancestor and inspect drift instead of resetting.
- CI run `34147987948` succeeded at remote commit `78da6f56a284d1d4eb7a4b5ceccbdbb3d22ce301`.
- Deployed p3 release identity, which must still be the p4 release identity unless preflight stops:
  - image: `ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af`
  - acquisition implementation: `433f3938f8b0ca2468541972801a472a8cb9a256`
  - activity mode: `python_tiktok_with_legacy_fallback`
- The newer published digest `sha256:c53e5f622fa85c5def2506a6a44df21e1babf6b3e88949a754594e88b0d5e4a3` is not deployed and is not authorized for p4.
- Restricted pairing evidence currently contains three immutable sample rows plus one valid p3 classification amendment. The original p3 row remains `mismatch`; its effective result is `evidence_incomparable`; p3 earns no parity credit.
- The p3 correction checkpoint is public at GitHub Issue #5 comment `5574619838`.
- The activation parity gate remains unpassed. The acceptance window has not opened.

Fixture precondition:
- The operator must have created `/home/mfr/thoth-stage1-parity/p4/url.txt` before execution, owned by the operator, exact mode 0600, under a p4 directory with exact mode 0700.
- Read it privately and validate it as a canonical HTTPS TikTok post URL accepted by the existing preflight.
- Compare its normalized bytes privately with the preserved p3 fixture. Require `fixture_distinct_from_p3=true`; never print either fixture, a hash, a post ID, owner, caption, or path stored inside evidence.
- Treat the operator-provided p4 file plus this prompt as approval for that one fixture. If the file is absent, invalid, symlinked, outside the restricted root, not mode 0600, or equal to p3, stop before every live request. Do not create, edit, replace, or normalize the URL file.

Phase 1 — fail-closed preflight:
1. Capture branch, HEAD, upstream, worktree status, and commits after `c1786b3`. Require a clean worktree and no contract-changing drift.
2. Verify the p4 sample directory is outside Git and outside `THOTH_STAGE1_DATA_ROOT`, contains no prior reference attempt or acquisition output, and has no symlink at any level.
3. Verify the pairing JSONL and its directory retain exact modes 0600/0700, parse amendment-aware, contain exactly three legacy samples and one valid p3 amendment, and contain no p4 sample or amendment.
4. Verify the deployed `api`, `worker`, and `legacy-cdp` containers all use the exact `9187c97f...1276af` digest and OCI revision `433f3938...9a256`. Require the worker mode `python_tiktok_with_legacy_fallback`.
5. Record safe pre-run container IDs, health states, and restart counts without printing environment values. Require the deployed stack is in its approved healthy/running state.
6. Verify the provider override used by the deployment is present without printing it. Run only the offline role-readiness check; require chat, vision, embed, and OCR roles ready. This check must contact no provider.
7. Run `stage1_parity_preflight` against p4, the exact deployed digest, repository root, data root, and provider file. Require every safe predicate true.
8. Verify the pinned image contains the exact required `yt-dlp` and `gallery-dl` executables and the parity-isolation entrypoint. Do not pull or build an image.
9. Confirm no disposable parity container/network/volume currently exists.

Completion criterion for Phase 1: all safe predicates pass before any TikTok/CDN/provider request or new workflow exists. Otherwise report the failed safe predicate and stop.

Phase 2 — one Python acquisition:
1. Designate p4 before submission and generate one new private workflow identity. Do not reuse any p1–p3 workflow or artifact.
2. Submit exactly one ordinary source-investigation workflow through the existing supported control-plane entrypoint, reading the URL from the restricted file inside the submitting process so it never appears in the host command line.
3. If submission is uncertain, reconcile read-only by the generated workflow identity. Never submit a second workflow.
4. Wait for the one workflow to reach a terminal state within the existing operational deadline. Preserve its actual attempt sequence, route, timestamps, typed source events, cleanup events, and artifact references.
5. If the workflow does not complete successfully, its report is missing, Python artifact validation fails, cleanup evidence is incomplete, or the terminal state cannot be reconciled, preserve the designated p4 failure. Do not run the Scout reference, do not append a fabricated parity result, and stop for operator review with a safe failure classification.
6. On success, copy only that workflow's report tree from the running worker into the restricted p4 Python evidence directory using the runbook method. Validate workflow binding, schema, containment including symlinks, MP4 signature, minimum size, byte count, checksum, absence of `.part`, and cleanup booleans.

Completion criterion for Phase 2: exactly one Python workflow exists for p4 and its terminal result is preserved. Phase 3 is permitted only when Python completed and its own artifacts and cleanup are valid.

Phase 3 — one isolated Scout reference:
1. Create the container-readable fixture copy and required ownership exactly as the runbook specifies. Keep the operator-owned `p4/url.txt` unchanged.
2. Set a new p4 reference identifier and use the exact deployed digest with `compose.stage1.parity.yml`; never merge it with the deployment Compose files.
3. Run the offline provider readiness check in the reference container. If it fails, stop before the reference request and preserve the Python result; do not retry.
4. Capture the deployed sidecar identity, health, and restart count immediately before the reference.
5. Start exactly one disposable reference run. The reference must own fresh anonymous Chromium, use only its internal loopback CDP, redirect browser/Scout streams into restricted files, and never attach to the deployed sidecar.
6. Capture the first exit and lifecycle result. Stop on login wall, captcha, age gate, authentication failure, provider failure, timeout, browser failure, cleanup failure, or missing media. Do not seed cookies/profile, change provider settings, or retry.
7. Always run the parity project's documented teardown once, remove its containers/network/volumes, return evidence ownership to the operator, and remove only the container-readable fixture copy. Keep `p4/url.txt`.
8. Verify the deployed sidecar ID, health, and restart count are unchanged, worker mode is unchanged, and no disposable parity resource survives.

Completion criterion for Phase 3: exactly one reference attempt is finalized and cleanup/isolation are proven. A nonzero or incomplete reference is preserved as `evidence_incomparable`, never `mismatch` or `pass`.

Phase 4 — validate, compare, and classify:
1. Validate the offline parity helper's focused unit suite before pointing it at p4 evidence.
2. Validate Scout report/media integrity independently. Capture checksums and byte count privately; never compare media files for byte equality.
3. If either side lacks valid required evidence, classify p4 as `evidence_incomparable` and do not invent nine-field results.
4. Only when both sides are independently valid, run `tiktok-stage1-parity-compare` once against the p4 reports and the same restricted URL file.
5. Preserve all nine authoritative field booleans:
   - all nine true with both artifact sets valid: `pass`;
   - both artifact sets valid and one or more fields false: `mismatch`;
   - comparison cannot complete or either artifact set is invalid/incomplete: `evidence_incomparable`.
6. Do not introduce fuzzy normalization, cross-provider checksum equality, manual field overrides, or a second comparison against changed evidence.

Completion criterion for Phase 4: one truthful p4 classification exists from the first designated evidence, with no retry or substituted fixture.

Phase 5 — append restricted p4 evidence:
1. Build one legacy sample-shaped p4 row using the exact established sample field order. Do not add `record_type` to a sample row. Use `observation_id=null` because this is a pre-window activation pair.
2. Bind the row to the exact deployed digest/implementation, private workflow/reference identities, fixture reference, timestamps, report/media references, per-side integrity booleans, nine field booleans only when comparison completed, truthful `comparison_result`, reviewer, and review timestamp.
3. Preserve p1–p3 and the p3 amendment byte-for-byte. Readers must still resolve p3 through its amendment after the p4 row is appended.
4. In one locked Python-standard-library transaction, create one mode-0600 byte-identical sibling backup, recheck the source under lock, append the compact UTF-8 p4 row with exactly one `os.write` on an `O_APPEND` descriptor, `fsync` the file and directory, and verify the previous file is an exact prefix.
5. A short write or post-append verification failure is preserved without truncation, rewrite, or second append. Stop and report the safe failure stage.
6. Verify exactly four legacy sample rows and one p3 amendment exist, exactly one p4 sample exists, p3 still resolves to `evidence_incomparable`, and p4 resolves to the classification produced in Phase 4.

Completion criterion for Phase 5: exactly one p4 sample row is durably appended, every previous byte is preserved, and no observation or public record is mutated.

Hard stops — not authorized:
- No second Python workflow, second reference, repeated comparison against changed evidence, retry, replacement fixture, or p5.
- No deployment, pull, build, restart, recreate, or stop of any deployed service; no configuration change, image publication, or use of the c53e5f digest. Teardown of the disposable p4 parity project is required.
- No attachment to or navigation of the deployed legacy-cdp sidecar by the parity reference.
- No cookie/profile/login seeding, captcha bypass, authentication workaround, secret change, provider rotation, or environment edit.
- No mutation of p1–p3, the p3 amendment, existing artifacts, attempt records, observations, aggregate reports, or soak datasets.
- No creation or update of an observation for p4. It is a pre-window activation pair, not an acceptance observation.
- No Issue #5 comment, edit, or deletion. Public checkpoint requires a separate reviewed prompt after this result.
- No controlled fallback exercise, acceptance-window activation, soak collection, aggregate evaluation, S3 export, rollback drill, cutover, Python-only default, Scout removal, or Task 10.
- No repository edit, commit, push, or unrelated fix.

Safe final report in Indonesian:
1. Repository baseline/final HEAD, branch/upstream, and clean status.
2. Deployed digest/revision/mode equality and safe pre/post service health/restart booleans.
3. Fixture preflight booleans, including `fixture_distinct_from_p3=true`; never reveal the fixture or its hash.
4. Python terminal status, route attempt method names/statuses/timings, cleanup booleans, and artifact-validation booleans without workflow ID, URL, metadata, paths, or checksums.
5. Scout terminal status, safe reason code, browser isolation and cleanup booleans, artifact-validation booleans without reference ID, raw logs, provider response, path, or checksum.
6. Nine field names and booleans only if the comparison completed.
7. Final p4 classification and the exact rule that selected it.
8. Pairing backup/prefix/append/mode/count booleans without backup path, record hash, amendment ID, or restricted values.
9. Confirmation p1–p3 and the p3 amendment remain byte-identical and p3 still effectively resolves to `evidence_incomparable`.
10. Explicit list of every hard-stop action not performed.
11. State that Issue #5 was not changed and awaits separate authorization.
12. Use exactly one truthful ending:
    - Pass: `p4 completed with parity pass; the activation parity result is ready for independent review and separate Issue #5 checkpoint approval.`
    - Comparable mismatch: `p4 first result was preserved as mismatch; no retry or later operational gate was entered.`
    - Incomparable evidence: `p4 first result was preserved as evidence_incomparable; no retry or later operational gate was entered.`
    - Stopped before live execution: `p4 was not executed; preflight stopped safely before any live request.`
    - Python-only terminal failure before reference: `p4 Python result was preserved; no Scout reference, retry, or later operational gate was entered.`
    - Append failure after live evidence: `p4 live evidence was preserved; pairing append is incomplete and requires separate operator review.`

Stop after the report. A p4 pass does not authorize controlled fallback or opening the accelerated acceptance window.
```
