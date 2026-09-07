# Stage 1 p3 Evidence Amendment Executor

Copy the following prompt into the Claude executor task. Issuing it is explicit
operator authorization for the single restricted append and single public
checkpoint described below. It authorizes no live acquisition or deployment.

```text
Mode: IMPLEMENT_PLAN — p3 append-only evidence correction and Issue #5 checkpoint only

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci

Objective:
Correct the effective classification of the existing activation parity sample p3 from the originally recorded `mismatch` interpretation to `evidence_incomparable` by appending exactly one cryptographically bound amendment to the restricted pairing JSONL, then publish and byte-verify exactly one sanitized checkpoint comment on muhfalihr/Thoth#5. Preserve the original p3 row byte-for-byte. Stop after independent-review handoff.

Operator authorization embodied by this prompt:
- If and only if every fail-closed precondition passes, append exactly one `classification_amendment` line to `/home/mfr/thoth-stage1-parity/pairing-record.jsonl`.
- Create the one mode-0600 byte-identical sibling backup required by the approved transaction.
- Create the mode-0600 temporary reviewed Issue body, publish exactly one comment to Issue #5, verify it exactly, and remove the temporary body only after verification.
- Perform the read-only checks required to prove those two writes.

This authorization is single-use for this execution. It does not authorize a second amendment, a second Issue comment, an automatic retry, or any later operational gate.

Read completely, in order:
1. `CLAUDE.md`
2. `AGENTS.md` and its referenced instructions
3. `BLUEPRINT.md`
4. `docs/superpowers/specs/2026-09-08-stage1-p3-evidence-amendment-design.md`
5. `docs/superpowers/plans/2026-09-08-stage1-p3-evidence-amendment.md`
6. `docs/operations/stage1-parity-sampling.md`, especially `Window completion`
7. `docs/operations/stage1-local-docker.md` only for release-identity boundaries

Required process:
- Use `superpowers:executing-plans` and execute the approved plan task-by-task.
- Use `superpowers:verification-before-completion` before any completion claim.
- Do not delegate the evidence read or mutation to another agent.
- Chat and the final report must be Indonesian. Commands, identifiers, and the reviewed Issue body remain English.
- Do not modify the approved spec, plan, prompt, runbooks, source code, tests, or any repository file.
- Do not create a repository commit. Commit-message rules still apply if reporting repository history: one concise subject line, no body, trailer, `Co-Authored-By`, or Claude/Anthropic attribution.

Current reviewed checkpoint:
- Planning baseline: `f2a8296` (`docs: plan p3 evidence amendment`). It must be an ancestor of the current HEAD; this executor-prompt commit or later operator-owned documentation commits may follow it.
- Expected remote checkpoint before these local planning commits: `78da6f56a284d1d4eb7a4b5ceccbdbb3d22ce301` on `origin/codex/stage1-container-ci`.
- CI run `34147987948` concluded success at that remote checkpoint.
- p3 acquisition release: `ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af`.
- p3 acquisition implementation commit: `433f3938f8b0ca2468541972801a472a8cb9a256`.
- The newer published digest `sha256:c53e5f622fa85c5def2506a6a44df21e1babf6b3e88949a754594e88b0d5e4a3` was not deployed for p3 and must not be attached to p3.
- The original restricted record has three sample rows, one p3 row, `observation_id=null`, `scout_media_ref=null`, and recorded `comparison_result="mismatch"` according to the reviewed executor report.
- Authoritative classification under the current runbook is `evidence_incomparable`: the isolated Scout reference exited nonzero, produced no reference media, and left Scout artifact-integrity checks incomplete.
- p3 is not a parity pass and counts toward no activation or in-window parity requirement.
- Issue #5 was reported to have no p3 correction checkpoint. Verify that read-only before mutating evidence.

Before mutation:
1. Capture branch, HEAD, upstream, and worktree status. Require a clean worktree. Do not reset, checkout, rebase, amend, merge, or clean anything.
2. Confirm `f2a8296` is an ancestor of HEAD and the approved spec and plan exist at HEAD.
3. Inspect every commit after `f2a8296` and any pre-existing worktree change. If drift changes the approved evidence contract, stop without mutation and report the conflict.
4. In one continuous WSL session, set `umask 077` and use only the approved restricted paths. Do not start or query Docker.
5. Verify `gh` can read Issue #5 and that no existing comment contains both p3 and `evidence_incomparable`. If such a comment exists, stop without mutation; do not edit, delete, or duplicate it.
6. Run the plan's safe read-only JSONL and lifecycle preflight. Require exact directory/file modes, three unique legacy sample rows, one p3 row, the original mismatch, absent observation and Scout media references, nonzero completed Scout reference, successful cleanup, incomplete Scout integrity, and no existing p3 amendment.
7. Print only the booleans and counts allowed by the plan. Never print any existing JSON row, fixture value or reference, workflow/reference identifier, URL, post metadata, caption, local path stored in evidence, checksum, attempt exit value, stdout/stderr, browser log, exception, provider detail, or secret.

Authorized execution:
1. Execute Task 2 as one Python-standard-library locked transaction exactly as specified. The backup is a mode-0600 sibling of the pairing file. The original bytes must become an immutable prefix of the amended file.
2. Bind the amendment to the exact raw p3 line digest, use the closed ordered schema, fixed reason-code order, deterministic amendment ID, and RFC 3339 UTC timestamp from the spec.
3. Append the serialized line through exactly one `os.write` on an `O_APPEND` descriptor while retaining the exclusive lock. A short write is a hard failure and must not be retried or repaired.
4. `fsync` the backup, amended file, and containing directory as required. Reopen and prove backup equality, prefix preservation, exactly one added line, exact mode 0600, one valid amendment, effective `evidence_incomparable`, and zero parity credit.
5. Only after every restricted verification passes, write the exact reviewed Issue body from Task 3 to the mode-0600 temporary file without echoing it.
6. Run the plan's deny-list and digest allow-list checks. The only `sha256:<64 hex>` in the body must be the p3 acquisition digest.
7. Re-query Issue #5 immediately before posting. Require zero existing p3 correction comments, then call `gh issue comment` exactly once with `--body-file`.
8. Never automatically retry an uncertain POST. Perform only the single read-only reconciliation query allowed by the plan. Require exactly one byte-equivalent comment; otherwise stop for operator review.
9. Read the created comment by ID, verify its body against the reviewed local body, then remove the temporary body file only after exact verification.
10. Run Task 4 containment checks and stop.

Idempotency and failure rules:
- If an exact valid amendment is already present at initial preflight, report `amendment_already_present=true` and stop. Do not create another backup and do not post to Issue #5; an Issue-only retry needs separate authorization.
- If any different or invalid amendment targets p3, stop without mutation.
- If the pairing file differs from the reviewed predicates, permissions are not exact, backup creation fails, or the source changes under lock, stop without append.
- If append succeeds but any later restricted verification or Issue action fails, preserve the append and backup. Do not truncate, rewrite, rollback, append again, edit a comment, or retry a POST. Report only the safe failing stage.
- The original p3 row must continue to record `mismatch`; only amendment-aware interpretation becomes `evidence_incomparable`.

Hard stops — not authorized:
- No retry of p3 and no creation of p4 or any replacement sample.
- No TikTok, CDN, provider, browser, Scout, or Python acquisition request.
- No workflow start, approval, cancellation, retry, query, or observation generation.
- No Docker command, image pull, deployment, restart, recreate, stop, health query, environment change, or use of the newer c53e5f digest.
- No fixture-file access, fixture replacement, cookie/profile seeding, authentication, or secret access. Reading the existing pairing row privately does not authorize dereferencing its fixture pointer.
- No controlled fallback, acceptance/soak-window activation, aggregate evaluation, rollback drill, S3 export, cutover, Python-only default, Scout removal, or Task 10.
- No observation, aggregate report, p3 artifact, source report, attempt record, fixture, environment file, or secret mutation.
- No rewriting, sorting, normalizing, compacting, or deleting any existing pairing-record byte.
- No repository edit, commit, push, image publication, Issue edit, or Issue deletion.
- Do not diagnose unrelated findings or broaden scope. Preserve and report them.

Required verification evidence, using only safe output:
- repository baseline and final HEAD are identical; worktree remains clean;
- Issue preflight accessible and p3 correction count was zero;
- pairing root mode 0700 and pairing file mode 0600;
- JSONL valid, three original sample rows, exactly one original p3 row;
- original p3 result remains `mismatch`, observation absent, reference media absent, reference failed, Scout integrity incomplete;
- backup created, mode 0600, and byte-identical without printing its path or digest;
- original prefix preserved, rows added exactly one, amendment count exactly one;
- effective p3 result `evidence_incomparable`, p3 parity credit false;
- Issue comment count exactly one, body exact, and public comment ID/URL;
- no unauthorized action occurred.

Required final report in Indonesian:
1. Baseline/final repository identity, branch/upstream, clean worktree.
2. Safe preflight booleans and original sample-row count.
3. Backup-created, exact-mode, and byte-identical booleans; omit path and digest.
4. Amendment count/validity, prefix preservation, rows added, and effective result; omit amendment ID and target hash.
5. Issue #5 comment ID/URL, count, and exact-body boolean.
6. Explicitly state that the immutable original p3 row still says `mismatch`, while amendment-aware effective classification is `evidence_incomparable`.
7. Explicitly state that p3 remains excluded from every parity count.
8. List all hard-stop actions not performed.
9. State any safe failure stage or environmental limitation without restricted data.
10. End exactly with: `p3 evidence correction recorded and ready for independent review; no parity retry, deployment, controlled fallback, or acceptance window was entered.`

Stop after this report. Do not continue to another parity sample or operational gate.
```
