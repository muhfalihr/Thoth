# Stage 1 Parity Deadline Contract Review Corrections Executor

Copy the fenced block below directly into the Claude executor project.

```text
Mode: IMPLEMENT_PLAN — Stage 1 parity deadline contract review corrections

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci
- Required implementation ancestor: 22ac41aabcb2e2ed1bceeec611e2c14118fa8803
- Runtime/upstream baseline: 92fa633163e88a352aeac74f2912c339bee44b03

Objective:
Correct three independent-review findings without changing runtime behavior: narrow the documented
35-minute deadline to the supervised acquisition/child-run phase, restore direct typing in the new
source-boundary test, and append the missing 2026-09-09 Blueprint audit entry.

Read completely, in order:
1. `CLAUDE.md`
2. `AGENTS.md` and its referenced instructions
3. `BLUEPRINT.md`
4. `docs/superpowers/specs/2026-09-09-stage1-parity-deadline-contract-review-corrections-design.md`
5. `docs/superpowers/plans/2026-09-09-stage1-parity-deadline-contract-review-corrections.md`
6. `docs/superpowers/specs/2026-09-09-stage1-parity-reference-completion-budget-design.md`
7. `docs/operations/stage1-parity-sampling.md`
8. `scout/lib/parity_reference_contract.ts`
9. `scout/runtime/parity_reference.ts`
10. `scout/pipeline/run_pipeline_acquisition.test.ts`

Required process:
- Use `superpowers:executing-plans` and execute the implementation plan task-by-task.
- Use `superpowers:verification-before-completion` before the final report.
- Prefix every shell command with `rtk`.
- Before editing, report branch, full HEAD, upstream, ahead/behind, worktree status, and every commit
  and changed path after `22ac41a`. Stop if that commit is not an ancestor or if unexplained drift
  overlaps the authorized files.
- Follow the plan's focused RED/GREEN sequence. The direct-typing correction has no fabricated RED;
  use the existing green typecheck as its baseline.

Authorized deliverables:
1. Amend the original completion-budget design, parity runbook, shared-contract comments,
   supervisor comments, and contract-test wording so they consistently state:
   - 30 minutes remains the `trace_source` stage timeout;
   - 5 minutes remains pre-outcome headroom;
   - 35 minutes remains the supervised acquisition deadline from browser startup through the
     browser/reference outcome;
   - teardown and attempt finalization continue after that outcome and remain mandatory before the
     supervisor returns.
2. Add the narrow Python documentation-contract assertions specified by the plan.
3. Replace only the newly introduced `as unknown as RunPipelineDeps` source-boundary fixture cast
   with a directly typed `RunPipelineDeps` variable. Keep all existing dependency bodies, ordering
   assertions, and forbidden-stage assertions.
4. Clarify the existing 2026-09-09 Blueprint checkpoint and append the missing final chronological
   `Update: 2026-09-09` entry using actual verified results.
5. Create the three local commits named by the plan. Each commit must use exactly one
   `git commit -m "<subject>"`, one concise subject line, no body, no trailer, and no
   `Co-Authored-By` or Claude/Anthropic attribution.

Runtime preservation contract:
- Do not move or remove `clearTimeout(timer)`.
- Do not change any 30/5/35-minute value or constant name.
- Do not add a timer or change an executable statement in production TypeScript.
- Do not change command construction, the source-only flag, pipeline ordering, exit codes,
  interruption/deadline classification, cleanup precedence, child reaping, diagnostics, workspace
  reservation, or atomic attempt finalization.
- Keep external artifact validation and the nine-field comparison authoritative. Exit zero alone
  grants no parity credit, and p5 remains `evidence_incomparable`.
- If an executable production change appears necessary, stop and report the conflict for operator
  review. Do not expand scope.

Required verification:
- Run every command in Task 4 of
  `docs/superpowers/plans/2026-09-09-stage1-parity-deadline-contract-review-corrections.md`.
- Report actual exit codes and pass/skip/fail counts; do not reuse earlier output.
- Run the repository-required `build_cuda.bat` and require exit zero.
- No Docker image build or container harness is required because executable behavior is unchanged.
- Verify the final diff contains only authorized documentation, comment, and test-typing changes.
- Require `git diff --check` clean, a clean worktree, and empty commit bodies.

Protected operational state:
- Do not read or dereference p1-p5 fixtures, provider files, secrets, pairing evidence, raw logs,
  reports, media, observations, aggregates, backups, or S3 evidence.
- Do not make TikTok, CDN, provider, browser-live, Scout-live, Python-acquisition, Temporal,
  control-plane, or any other live request.
- Do not retry p5, create p6, run a parity comparison, or mutate any evidence or observation.
- Do not query, comment on, edit, or delete GitHub Issue #5.
- Do not build, pull, tag, publish, or push an image; do not log in to a registry.
- Do not deploy, restart services, run controlled fallback, rollback, cut over, change the default
  activity mode, open or backdate an acceptance window, or begin Task 10.
- Do not push commits, open a pull request, create a tag, or publish a release.
- Do not reset, clean, restore, amend, or rewrite pre-existing commits or operator changes.

Failure handling:
- Stop on the first failed hard precondition.
- An expected focused RED is allowed only for the new documentation-contract assertion before its
  wording correction. Any unexpected failure after GREEN requires offline diagnosis within the
  authorized files.
- Do not weaken, delete, skip, or cast around a test to obtain GREEN.
- Do not claim completion from previous logs.

Required final report in Indonesian:
1. Baseline and final branch, full HEAD, upstream, ahead/behind, drift, and clean-worktree status.
2. Files changed with one sentence of responsibility each.
3. Focused RED evidence for the corrected runbook contract.
4. Exact before/after wording of the 35-minute child-run boundary and mandatory post-outcome work.
5. Confirmation that the 30/5/35 values and every executable production statement are unchanged.
6. The removed cast location and proof the replacement fixture is directly typed.
7. The final Blueprint update date and a statement that p5 remains `evidence_incomparable`.
8. Actual focused and full test counts, typecheck, Ruff, CUDA build, and `git diff --check` results.
9. Exact local commits and proof each has one subject line, empty body, and no prohibited attribution.
10. Explicit confirmation that no Docker/image operation, push, deployment, live request, retry,
    evidence mutation, Issue #5 mutation, controlled fallback, or acceptance-window action occurred.
11. Any remaining limitation or review question.
12. End exactly:
`parity deadline contract review corrections completed offline; ready for independent review; no runtime behavior, push, deployment, live request, retry, evidence mutation, controlled fallback, or acceptance window changed.`
```
