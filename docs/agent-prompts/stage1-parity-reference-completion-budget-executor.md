# Stage 1 Parity Reference Completion and Budget Executor

Copy the fenced block into the Claude executor project. It authorizes offline
implementation, tests, one local candidate image, and synthetic container
smokes. It authorizes no live request or operational gate.

```text
Mode: IMPLEMENT_PLAN — Stage 1 parity reference completion and budget corrective

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci
- Required ancestor: a9fe4cf699a41e179534514dadc70a7fae50c455
- Runtime baseline: 92fa633163e88a352aeac74f2912c339bee44b03

Objective:
Implement the approved offline correction that makes isolated parity references
finish after source resolution instead of continuing into `build_footage`, and
make the supervisor deadline longer than the retained source-stage budget.

The implementation must preserve normal Scout runs, supervisor cleanup and
attempt-record semantics, safe diagnostics, and external parity validation.

Read completely, in order:
1. `CLAUDE.md`
2. `AGENTS.md` and every referenced instruction
3. `BLUEPRINT.md`
4. `docs/superpowers/specs/2026-09-09-stage1-parity-reference-completion-budget-design.md`
5. `docs/superpowers/plans/2026-09-09-stage1-parity-reference-completion-budget.md`
6. `docs/operations/stage1-parity-sampling.md`
7. `docs/superpowers/specs/2026-09-08-stage1-parity-diagnostic-preservation-design.md`
8. `docs/superpowers/specs/2026-09-09-stage1-p5-evidence-amendment-design.md`
9. `scout/pipeline/run_pipeline.ts`
10. `scout/runtime/parity_reference.ts`

Required process:
- Use `superpowers:executing-plans` task-by-task.
- Use `superpowers:test-driven-development` for every behavior change. Capture
  focused RED evidence before implementation, then GREEN evidence.
- Use `superpowers:verification-before-completion` before the final report.
- Prefix every shell command with `rtk`.
- Do not delegate restricted, operational, or environment work.
- Chat reports must be Indonesian. Repository artifacts, code, tests, comments,
  docs, and commit messages remain English.
- Each commit must use exactly one concise subject line, preferably at most 72
  characters. Use one `git commit -m "<subject>"`; no body, detailed
  description, blank-line continuation, trailer, `Co-Authored-By`, Claude, or
  Anthropic attribution.

Phase 1 — fail-closed repository preflight:
1. Capture branch, full HEAD, upstream, ahead/behind, and worktree state.
2. Require `a9fe4cf699a41e179534514dadc70a7fae50c455` to be an ancestor.
3. Before implementation, allow drift after that ancestor only in these three
   approved planning artifacts:
   - `docs/superpowers/specs/2026-09-09-stage1-parity-reference-completion-budget-design.md`
   - `docs/superpowers/plans/2026-09-09-stage1-parity-reference-completion-budget.md`
   - `docs/agent-prompts/stage1-parity-reference-completion-budget-executor.md`
4. Require a clean worktree and no unrelated commit or runtime drift.
5. Do not reset, clean, stash, rebase, checkout, restore, amend, or discard
   anything. Stop for operator review if the predicates fail.

Completion criterion:
The implementation begins from the exact approved planning checkpoint with no
unrelated state.

Phase 2 — execute the implementation plan:
Follow every task and checkbox in
`docs/superpowers/plans/2026-09-09-stage1-parity-reference-completion-budget.md`
in order. Do not combine RED and GREEN or skip focused tests.

The required implementation contract is:
1. Add internal Scout flag `--source-reference-only` and typed option
   `sourceReferenceOnly: boolean`.
2. Reject its combination with `--use-input-as-main` using fixed safe code
   `source_reference_only_conflicts_with_forced_main` before acquisition.
3. In source-reference mode execute only:
   - context creation;
   - fixture seed inspection;
   - seed report write;
   - required `trace_source` and main-source materialization;
   - existing summary;
   - normal return.
4. Do not invoke comments, dossier, `build_footage`, external-footage packaging,
   figures, or full-pipeline validation in that mode.
5. Preserve the complete existing pipeline when the flag is absent.
6. Create the dependency-free shared constants:
   - source-stage timeout: 30 minutes;
   - overhead reserve: 5 minutes;
   - supervisor deadline: their exact 35-minute sum.
7. Every real parity reference command must pass
   `--source-reference-only` exactly once. Synthetic offline-smoke mode must
   continue using its synthetic child and must not pass the flag.
8. Keep injected short deadlines available for deterministic unit tests.
9. Preserve exit 124, interruption, browser-death, cleanup precedence, child
   reaping, attempt reservation/finalization, and diagnostic behavior.
10. Keep external artifact validation and nine-field comparison authoritative.
    Exit zero alone never grants parity credit.

Do not add retry, resume, partial-artifact acceptance, authentication seeding,
provider fallback, or a new evidence field.

Phase 3 — verification:
Run every focused and full command in Task 4 of the plan and report actual exit
codes and counts.

Required source gates include:
- focused pipeline RED/GREEN;
- focused parity supervisor and budget RED/GREEN;
- `bun run test:runtime`;
- `bun run test:acquisition`;
- `bun run typecheck`;
- complete Python deployment test suite;
- Ruff check and format check;
- `git diff --check`;
- the repository-required `build_cuda.bat` build.

Windows/WSL environment guardrail:
- `python/.venv` must remain the Windows environment.
- Never run bare WSL `uv run --project python`.
- Every WSL uv command must set inline:
  `UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv"`
- Use absolute project path
  `/mnt/c/Users/mfr/Documents/MyTools/CLIPPER/python` and `--frozen`.
- Capture `python/.venv/pyvenv.cfg` content equality before and after without
  printing its contents.

Authorized Docker scope:
- Build exactly one named local Linux/amd64 candidate:
  `thoth-stage1:parity-completion-corrective`.
- Run only `docker/test-cdp-offline.sh` and
  `docker/test-parity-offline.sh` against that candidate.
- Harness pages and inputs must remain local/synthetic.
- Verify no harness container, network, or volume remains.

Docker hard boundary:
- Do not use `.env.stage1.local`, `compose.stage1.local.yml`, or the deployed
  Compose project.
- Do not inspect, pull, tag, stop, restart, recreate, or otherwise interact with
  deployed services or digest-qualified release images.
- Do not log in to a registry, push, publish, or create a GHCR digest.

Protected operational state:
- Do not read or dereference any p1–p5 fixture.
- Do not read provider environment files, secrets, pairing evidence, raw logs,
  reports, media, observations, aggregates, backups, or S3 evidence.
- Do not make TikTok, CDN, provider, browser, Scout-live, Python-acquisition,
  Temporal, control-plane, or other live request.
- Do not retry p5, create p6, or run any parity comparison.
- Do not append, amend, rewrite, back up, chmod, or delete evidence.
- Do not query, comment on, edit, or delete GitHub Issue #5.
- Do not run controlled fallback.
- Do not open or backdate an acceptance/soak window.
- Do not deploy, rollback, cut over, change the default activity mode, remove
  Scout, or begin Task 10.

Commit boundary:
- Local implementation commits described by the plan are authorized.
- Do not rewrite commits that existed before this task.
- Do not push, publish, deploy, open a PR, or tag a release.

Failure handling:
- Stop on the first failed hard precondition.
- During TDD, a focused expected RED is allowed only before its corresponding
  implementation. Any unexpected failure after GREEN stops the task for
  diagnosis.
- Do not weaken or delete a test to obtain GREEN.
- A local image build or offline smoke failure may be diagnosed only offline and
  within changed code. Do not access deployed or live state.
- Do not claim completion from previous test output.

Required final report in Indonesian:
1. Baseline and final branch, full HEAD, upstream, ahead/behind, drift, and clean
   worktree status.
2. Files changed and one-sentence responsibility for each.
3. RED evidence for parser/source-boundary tests and budget/command tests.
4. GREEN evidence with actual focused and full test counts and exit codes.
5. Exact source-reference call order and explicit list of stages proved absent.
6. Budget values and invariant: 30-minute source, 5-minute reserve, 35-minute
   supervisor.
7. Confirmation that normal Scout `run` behavior remains covered.
8. Supervisor lifecycle, cleanup, attempt-record, and diagnostic preservation
   evidence.
9. Windows venv before/after equality and WSL external-environment usage.
10. Local candidate image tag/ID, platform, and both offline harness results.
11. Local commits, proving every message is one subject line with no body or
    prohibited attribution.
12. Explicit statement that p5 remains effectively `evidence_incomparable`, no
    parity credit was granted, and no operational state was touched.
13. Exact list of hard-stop actions not performed.
14. Remaining limitation: this offline round does not prove a new live reference
    completes or that the activation parity gate passes.
15. End exactly:
    `parity reference completion and budget corrective implemented offline; ready for independent review; no push, deployment, live request, retry, evidence mutation, controlled fallback, or acceptance window entered.`
```
