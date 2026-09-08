# Stage 1 p4 Checkpoint and Offline Diagnosis Executor

Copy the following prompt into the Claude executor project. It authorizes one
sanitized p4 comment on Issue #5 and read-only diagnosis of the preserved p3/p4
evidence. It authorizes no live request, retry, fix, or deployment.

```text
Mode: IMPLEMENT_PLAN — publish one p4 checkpoint and diagnose p3/p4 offline

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci

Objectives:
1. Publish and byte-verify exactly one reviewed, sanitized p4 checkpoint comment on `muhfalihr/Thoth#5`.
2. Diagnose the isolated Scout reference failures in preserved samples p3 and p4 using only existing local evidence and repository source.
3. Report observed commonality, the strongest supportable safe root-cause category, uncertainty, and the smallest recommended corrective scope. Do not implement a fix or enter another gate.

Read completely, in order:
1. `CLAUDE.md`
2. `AGENTS.md` and its referenced instructions
3. `BLUEPRINT.md`
4. `docs/operations/stage1-parity-sampling.md`
5. `docs/agent-prompts/stage1-p4-isolated-parity-executor.md`
6. `docs/agent-prompts/stage1-p4-isolated-parity-reauthorization-executor.md`
7. `docs/superpowers/specs/2026-09-08-stage1-p3-evidence-amendment-design.md`
8. The p3 correction report and p4 execution report in this Claude project
9. Relevant Scout source only after evidence establishes the failing stage

Required process:
- Use `superpowers:systematic-debugging` for the offline diagnosis.
- Use `superpowers:verification-before-completion` before the final report.
- Keep repository and evidence inspection read-only. Do not delegate restricted evidence inspection.
- Chat and final report must be Indonesian. The fixed Issue body and diagnostic enum names remain English.
- Terminal output is restricted to booleans, counts, sample labels `p3`/`p4`, public release identity, safe enum values, and the created public comment URL.
- Never print or echo a fixture, filename, directory listing, filesystem path from evidence, workflow/reference/observation ID, post ID, owner, caption, URL, checksum, log line, provider response, HTTP body, exception, or secret.

Current checkpoint:
- Expected ancestor: `668d722c0a8a83e772f011e54257034e824046e3` (`docs: reauthorize p4 parity execution`). This executor-prompt commit or later operator-owned documentation commits may follow it. Inspect drift; do not reset or rewrite history.
- Repository was clean after p4 and no repository file was changed by the live gate.
- Deployed acquisition identity for p3 and p4:
  - image: `ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af`
  - implementation: `433f3938f8b0ca2468541972801a472a8cb9a256`
- Pairing evidence contains four legacy sample rows and one valid p3 classification amendment.
- P3 and p4 both effectively classify as `evidence_incomparable` and earn no parity credit.
- P4 has one sample row, `observation_id=null`, no Scout media reference, no nine-field results, valid Python artifacts, and incomplete Scout media integrity.
- P4 reference completed with a nonzero exit and clean isolated-browser teardown.
- During p4 evidence inventory, one restricted filename containing a post identifier was printed to the private executor terminal. It was not copied to Git or Issue #5 and was not repeated. Treat this as a real output-redaction process deviation.
- Independent review found zero Issue #5 comments mentioning p4 before this authorization.

Authorized external write:
- Exactly one new comment on GitHub Issue #5 using the fixed body below.
- A temporary mode-0600 body file under the existing restricted root, removed only after exact public verification.
- No other external or local state change.

Phase 1 — fail-closed preflight:
1. Capture branch, HEAD, upstream, and worktree state. Require `668d722` as an ancestor, a clean worktree, and no contract-changing drift.
2. Read Issue #5 and require zero existing comments containing both `p4` and `evidence_incomparable`.
3. Validate amendment-aware pairing evidence without printing it: exact modes 0700/0600, four legacy samples, one valid p3 amendment, one p4 sample, p3 effective `evidence_incomparable`, p4 recorded `evidence_incomparable`, and previous bytes preserved.
4. Snapshot private SHA-256 manifests for the pairing record and every regular file beneath p3 and p4 entirely in memory. Print only `evidence_snapshot_created=true` and file counts, never paths or hashes.
5. If public state, evidence shape, modes, or repository state differs, stop before posting and diagnose nothing.

Completion criterion: public and restricted state match the reviewed checkpoint and no state has changed.

Phase 2 — publish one fixed p4 checkpoint:
1. Create a mode-0600 temporary body file using this exact UTF-8 body:

```markdown
Stage 1 activation parity p4 — evidence incomparable

Release: `ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af`
Implementation: `433f3938f8b0ca2468541972801a472a8cb9a256`

The first authorization stopped during preflight before any live request because the fixture was absent. After explicit reauthorization and operator fixture provisioning, p4 was executed once with a fixture distinct from p3.

The Python side completed through the Python-native path after internal CDN recovery and its own artifacts passed validation. The isolated Scout reference exited nonzero, produced no reference media, and did not satisfy Scout media-integrity checks. The nine-field comparison was therefore not run.

P4 is classified as `evidence_incomparable`, is not a parity pass, and earns no activation or in-window parity credit. One append-only p4 sample row was added to restricted evidence with no acceptance observation attached; p1–p3 and the valid p3 amendment remain unchanged.

Containment note: during private p4 evidence inventory, one restricted filename containing a post identifier was printed to the executor terminal. The value was not copied into Git or this Issue, was not repeated, and subsequent inspection used count-only filters. This is an output-redaction process deviation that must be addressed before another parity sample.

No live retry, replacement fixture, deployment, controlled fallback, acceptance-window activation, observation mutation, or later gate was performed.
```

2. Before posting, require:
   - exactly one `sha256:<64 hex>` token, equal to the approved acquisition digest;
   - the implementation commit, `p4`, and `evidence_incomparable` are present;
   - none of these case-insensitive tokens appear: `http://`, `https://`, `tiktok.com`, `/home/`, `/mnt/`, `C:\`, `\\wsl`, `workflow_id`, `reference_id`, `observation_id`, `api_key`, `authorization:`, `stderr`, `stdout`, `browser.log`;
   - no additional URL, filesystem path, filename, evidence hash, provider name, raw status, or identifier is present.
3. Query Issue #5 again immediately before posting and require zero p4/evidence-incomparable comments.
4. Post exactly once with `gh issue comment --body-file`. WSL `gh` is unavailable, so Windows `gh` may read the same mode-0600 WSL body through its UNC path. Do not copy the body to Windows or print the UNC path.
5. Never automatically retry an uncertain POST. Reconcile once with a read-only Issue query:
   - exactly one byte-equivalent body means success;
   - zero or multiple matches means stop for operator review.
6. Read the created comment by ID, compare the body byte-for-byte allowing only one terminal-LF normalization, and print only comment count, exact-body boolean, ID, and public URL.
7. Delete the temporary body only after exact verification. Do not edit or delete the public comment.

Completion criterion: exactly one byte-verified sanitized p4 comment exists and no restricted value appears in it.

Phase 3 — offline read-only p3/p4 diagnosis:
1. Use a Python standard-library reader with known paths resolved privately from the pairing rows. Do not use `find`, `tree`, an unfiltered `ls`, or any command that emits filenames.
2. Parse each sample's pairing row, `reference-attempt.json`, Scout source report, and restricted stdout/stderr/browser logs in memory. Read files without changing atime where practical; never rewrite, chmod, rename, normalize, or delete evidence.
3. For log inspection, count marker categories in memory and print only zero/nonzero booleans or counts. Never print the matching line, surrounding context, filename, raw error, HTTP response, model name, provider name, or post metadata.
4. Determine the earliest failing pipeline stage independently for p3 and p4. Emit only a safe stage enum already present in Scout source, or `unknown_stage` if no unambiguous stage exists.
5. Classify each reference using exactly one primary category:
   - `authentication_wall`
   - `provider_authentication`
   - `provider_quota_or_rate_limit`
   - `provider_model_compatibility`
   - `media_candidate_discovery`
   - `download_dependency`
   - `cdp_transport`
   - `artifact_materialization`
   - `cleanup_or_lifecycle`
   - `unknown`
6. Record supporting safe predicates for each sample:
   - reference terminal failure;
   - cleanup passed;
   - report written/schema readable;
   - reference media absent;
   - captcha/login/age-gate markers present or absent;
   - missing-key, authentication, quota/rate-limit, model-compatibility, downloader, CDP, candidate-rejection, and artifact-write marker categories present or absent;
   - exact failing stage agreed between structured report and logs.
7. Read relevant Scout implementation only after the observed stage is known. Map the structured failure to the code branch without executing it. Distinguish:
   - observation directly present in both samples;
   - observation present in one sample only;
   - inference from source control flow;
   - unsupported hypothesis.
8. Compare p3 and p4, which used distinct fixtures on the same release. Report:
   - `same_failure_stage=true|false|unknown`;
   - `same_primary_category=true|false|unknown`;
   - `cross_fixture_recurrence=true` only when the same supported failure recurs;
   - `root_cause_status=confirmed|probable|undetermined`;
   - `confidence=high|medium|low`;
   - one safe root-cause category, never a raw message.
9. Do not infer authentication or provider failure only from broad keyword counts. Structured report, lifecycle evidence, and source branch must agree for `confirmed`; otherwise use `probable` or `undetermined`.
10. Diagnose the terminal filename disclosure separately as `output_redaction_process_deviation=true`. Identify the command class that emitted names only when it is available from the executor report; do not reconstruct or display the filename.
11. Recommend the smallest next corrective scope, but do not edit code or docs. Separate recommendations into:
    - required before any p5/live sample;
    - optional hardening;
    - evidence still missing.

Completion criterion: the report explains what both preserved samples prove, what they do not prove, and the narrowest justified next action without accessing the network or changing evidence.

Phase 4 — containment verification:
1. Recompute the in-memory evidence manifests from Phase 1. Require pairing record, p3 tree, and p4 tree all byte-identical with identical file counts.
2. Require repository HEAD unchanged and worktree clean.
3. Require no temporary diagnostic file or Issue body remains.
4. Query Issue #5 read-only and require exactly one p4 checkpoint with the reviewed exact body.
5. Print only safe booleans and the public comment URL.

Hard stops — not authorized:
- No TikTok, CDN, provider, browser, Scout, Python acquisition, HTTP probe, or other live acquisition/network request. The required read-only Issue queries and single GitHub Issue comment are the only authorized network operations.
- No workflow or Temporal query/start/retry/cancel/approval.
- No Docker command, deployment inspection, image pull/build, restart, recreate, stop, health probe, or disposable parity project.
- No retry of p3 or p4, replacement fixture, p5, cookie/profile seeding, authentication workaround, or provider change.
- No mutation of pairing JSONL, backups, p3/p4 evidence, fixtures, observations, reports, environment files, secrets, or S3 evidence.
- No Issue comment beyond the one fixed p4 checkpoint; no Issue edit/deletion and no posting of diagnostic conclusions.
- No source, test, runbook, spec, plan, prompt, or BLUEPRINT edit; no commit, push, publication, or unrelated fix.
- No controlled fallback, acceptance-window activation, soak collection/evaluation, rollback, cutover, Python-only default, Scout removal, or Task 10.

Required final report in Indonesian:
1. Repository baseline/final identity and clean status.
2. Preflight evidence-shape/mode booleans and file counts without paths or hashes.
3. Issue #5 comment ID/URL, exact-body boolean, and p4-comment count.
4. A p3/p4 diagnostic matrix containing only safe stage/category enums and booleans.
5. Shared-signature result, root-cause status, confidence, and explicit observation-versus-inference boundary.
6. `output_redaction_process_deviation=true` and the narrow preventive control required before another sample.
7. Evidence before/after equality booleans and confirmation no restricted value was printed during this task.
8. Exact list of actions not performed.
9. Smallest recommended corrective scope, without implementation.
10. End with one truthful statement:
   - Complete diagnosis: `p4 checkpoint recorded; offline p3/p4 diagnosis is ready for independent review; no live request, retry, deployment, or later gate was entered.`
   - Inconclusive diagnosis: `p4 checkpoint recorded; offline diagnosis remains undetermined and no live request, retry, deployment, or later gate was entered.`
   - Issue post failed before diagnosis: `p4 checkpoint is incomplete; no offline diagnosis or later gate was entered.`
   - Issue post succeeded but diagnosis failed: `p4 checkpoint recorded; preserved evidence was not changed and offline diagnosis requires separate review.`

Stop after the report. Do not implement the recommendation or prepare p5.
```
