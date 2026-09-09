# Stage 1 p5 Evidence Amendment Executor

Copy the fenced block into the Claude executor task. Issuing it authorizes one restricted append-only amendment and one sanitized Issue #5 comment. It authorizes no live request or later operational gate.

```text
Mode: IMPLEMENT_PLAN — p5 append-only evidence correction and Issue #5 checkpoint only

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci

Objective:
Correct activation parity sample p5 from recorded `pass` to effective `evidence_incomparable` by appending exactly one cryptographically bound amendment. Preserve the original p5 row byte-for-byte. After restricted verification, publish and byte-verify exactly one sanitized correction checkpoint on `muhfalihr/Thoth#5`, then stop.

Operator authorization:
- Append at most one `classification_amendment` to `/home/mfr/thoth-stage1-parity/pairing-record.jsonl`.
- Create one required mode-0600 byte-identical sibling backup.
- Create one mode-0600 temporary reviewed Issue body, post exactly one Issue #5 comment, verify it exactly, and remove the temporary body only after verification.
- Perform read-only checks required to prove these writes.
- This authorization is single-use. It does not authorize another amendment, comment, automatic retry, or operational gate.

Read completely, in order:
1. `CLAUDE.md`
2. `AGENTS.md` and referenced instructions
3. `BLUEPRINT.md`
4. `docs/superpowers/specs/2026-09-09-stage1-p5-evidence-amendment-design.md`
5. `docs/superpowers/plans/2026-09-09-stage1-p5-evidence-amendment.md`
6. `docs/operations/stage1-parity-sampling.md`
7. `docs/agent-prompts/stage1-p4-isolated-parity-executor.md`
8. `docs/superpowers/specs/2026-09-08-stage1-p3-evidence-amendment-design.md` only for the established amendment model

Process:
- Use `superpowers:executing-plans` task-by-task.
- Use `superpowers:verification-before-completion` before success claims.
- Do not delegate restricted evidence access, mutation, or publication.
- Report in Indonesian; keep identifiers and repository artifacts in English.
- Every WSL `uv` command sets `UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv"` inline, uses the absolute project path, and includes `--frozen`.
- Capture and recheck the Windows `python/.venv/pyvenv.cfg` checksum privately. Never let WSL synchronize the repository venv.

Current checkpoint:
- Image: `ghcr.io/muhfalihr/thoth@sha256:4cb1d7c51c3a112359f3ebfbb43e70b07f39937d7ce2bded904a1645c1f2d45c`.
- Implementation: `92fa633163e88a352aeac74f2912c339bee44b03`.
- CI run `34268139439` succeeded.
- Pairing evidence contains five immutable sample rows p1–p5 and one valid p3 amendment.
- P3 and p4 effectively resolve to `evidence_incomparable`.
- Original p5 has `observation_id=null` and `comparison_result="pass"`.
- Python and Scout artifacts validated and all nine p5 field results are true.
- Scout's first result was exit 124, nonzero and timed out; its attempt finalized and cleanup passed.
- A timed-out/nonzero activation reference cannot pass. Effective p5 must be `evidence_incomparable`.
- Issue #5 has no p5 correction checkpoint according to the latest executor report. Verify this.
- The activation gate remains unpassed and the acceptance window has not started.

Baseline gate:
1. Capture branch, HEAD, upstream, ahead/behind, and worktree status.
2. Require `92fa633163e88a352aeac74f2912c339bee44b03` as an ancestor.
3. Require later drift to consist only of the approved spec, plan, and executor-prompt documentation.
4. Require a clean worktree. Do not reset, clean, stash, rebase, checkout, or discard anything.
5. Stop before evidence access on runtime drift or unrelated changes.

Execution:
1. Follow every task and completion criterion in `docs/superpowers/plans/2026-09-09-stage1-p5-evidence-amendment.md` exactly.
2. In one WSL session with `umask 077`, validate Issue idempotency, record permissions, five sample rows, the p3 amendment, original p5 `pass`, all artifact/field booleans, and no p5 amendment.
3. Resolve the p5 reference identifier privately and verify its known attempt record reports finalized, nonzero exit 124, timeout true, and cleanup true. Use the safe summary command; do not open raw logs.
4. Do not access or dereference any fixture.
5. Under one exclusive lock, create one mode-0600 byte-identical backup and append exactly one closed-schema deterministic p5 amendment with fixed reason order:
   - `reference_timed_out`
   - `reference_exit_nonzero`
   - `activation_reference_gate_failed`
6. Use exactly one `os.write` on an `O_APPEND` descriptor. Do not retry a short write.
7. `fsync` backup, record, and directory. Prove prefix preservation, five sample rows, two valid amendments, original p5 `pass`, and effective p5 `evidence_incomparable`.
8. Only after restricted verification, create the exact reviewed Issue body from Task 3 of the plan, validate its allow-list and deny-list, and post it once with `gh issue comment --body-file`.
9. Never automatically retry an uncertain POST. Reconcile read-only once and require exactly one byte-equivalent body.
10. Remove the temporary body only after exact public verification.
11. Re-run containment checks and stop.

Idempotency and failure handling:
- An exact valid p5 amendment already present causes `amendment_already_present=true` and a stop before any write or post.
- A different or invalid p5 amendment causes a fail-closed stop.
- An existing p5 correction checkpoint prevents duplicate publication.
- Unexpected permissions, record shape, source digest, lifecycle evidence, or venv state stop before mutation.
- If append succeeds but verification or Issue publication fails, preserve append and backup. Never truncate, rewrite, append again, or retry the POST.
- Original p5 always retains recorded `pass`; only amendment-aware interpretation becomes `evidence_incomparable`.

Security:
- Terminal output is limited to safe booleans, counts, enums, and public release identity.
- Never print a pairing row, fixture pointer/value/hash, post metadata, private identifiers, paths stored inside evidence, evidence hashes, checksums, byte counts, provider data, raw diagnostics, logs, or exceptions.
- Reading the pairing record and known attempt record does not authorize reports, media, fixtures, environment files, or secrets.

Hard stops:
- No p5 retry, replacement fixture, new sample, or comparison rerun.
- No TikTok, CDN, provider, browser, Scout, Python acquisition, Temporal, or control-plane request.
- No Docker command, image pull/build, deployment, service inspection/start/stop/restart/recreate, or environment change.
- No fixture, artifact, raw log, provider, secret, observation, aggregate, or soak-dataset mutation.
- No controlled fallback, acceptance-window activation, S3 export, rollback, cutover, Python-only default, Scout removal, or Task 10.
- No rewrite, deletion, sorting, normalization, or compaction of existing pairing bytes.
- No repository edit, commit, push, tag, Issue edit, or Issue deletion during execution.
- Do not broaden into timeout diagnosis.

Required final report in Indonesian:
1. Repository baseline/final identity, documentation-only drift, and clean status.
2. Safe preflight booleans and counts.
3. P5 lifecycle predicates without private IDs.
4. Backup mode/equality, prefix preservation, rows added, sample/amendment counts.
5. Explicitly state original p5 remains `pass` while effective p5 is `evidence_incomparable` and earns no parity credit.
6. Confirm p3 and p4 remain effectively incomparable.
7. Issue comment ID/URL, exact-body boolean, and duplicate count.
8. Windows venv checksum equality and confirmation every WSL `uv` command used the external environment.
9. Explicit list of protected state and later gates not touched.
10. End exactly:
`p5 evidence correction recorded; effective result is evidence_incomparable; activation parity remains unpassed; no retry, deployment, controlled fallback, or acceptance window entered.`

Stop after the report.
```
