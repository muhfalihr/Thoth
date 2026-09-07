# Stage 1 Accelerated Acceptance Corrective Executor

```text
Mode: IMPLEMENT_PLAN — offline policy correction only

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL path reference only: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci

Objective:
Implement the approved Stage 1 accelerated acceptance policy: a 24-hour valid-completed window, 12 valid completed runs, and 2 in-window evidence-backed parity samples. Preserve every existing rate, cleanup, release-identity, fallback, rollback, and human-approval gate.

Read completely, in this order:

1. CLAUDE.md
2. AGENTS.md and every referenced instruction
3. BLUEPRINT.md
4. docs/superpowers/specs/2026-09-07-stage1-accelerated-acceptance-design.md
5. docs/superpowers/plans/2026-09-07-stage1-accelerated-acceptance.md
6. docs/superpowers/specs/2026-09-02-python-tiktok-stage1-cutover-design.md
7. docs/operations/stage1-local-docker.md
8. docs/operations/stage1-parity-sampling.md
9. docs/python-control-plane.md
10. docs/python-scout-migration-roadmap.md

Use:

- superpowers:executing-plans
- superpowers:test-driven-development for the evaluator default change
- superpowers:verification-before-completion before every completion claim
- superpowers:systematic-debugging if a test fails unexpectedly

Current checkpoint:

- Planning baseline commit: 7d0d1e6 (`docs: define accelerated stage1 acceptance`).
- The branch may contain later operator-owned commits. Inspect drift rather than resetting or checking out the baseline.
- The published acquisition release currently deployed is:
  ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af
- Its acquisition implementation revision is:
  433f3938f8b0ca2468541972801a472a8cb9a256
- The deployment is not the target of this task.
- The accelerated acceptance window has not been opened.
- One isolated activation parity pair is separately authorized operational work, not part of this implementation prompt.
- Controlled fallback, acceptance-window activation, evidence collection, and cutover remain separately gated.

Before editing:

1. Capture branch, HEAD, upstream, and worktree status.
2. Confirm the planning baseline is an ancestor of HEAD and both new design/plan files exist.
3. Inspect every change after 7d0d1e6 and every pre-existing worktree change.
4. Preserve operator-owned changes and keep them out of your commits.
5. If the approved spec or plan has materially changed, or repository drift conflicts with it, stop and report the exact conflict.

Authorized deliverables:

1. Update `python/tests/operations/test_tiktok_soak.py` first so the fixed-policy tests require:
   - `minimum_window_days == 1`;
   - `minimum_valid_completed_runs == 12`;
   - `minimum_parity_samples == 2`;
   - insufficient-window boundary at 23:59:59;
   - passing-window boundary at 24:00:00;
   - insufficient-run boundary at 11;
   - passing-run boundary at 12;
   - insufficient-parity boundary at 1;
   - passing-parity boundary at 2.
2. Run the focused test and capture genuine RED evidence caused only by the old `7 / 50 / 5` implementation defaults.
3. Change only the three `TikTokSoakPolicy` defaults in `python/src/thoth_control_plane/operations/tiktok_soak.py` to `1 / 12 / 2`.
4. Run the focused test again and capture GREEN evidence.
5. Preserve these policy values unchanged:
   - minimum Python-native success rate: 0.95;
   - maximum legacy-fallback rate: 0.05;
   - maximum terminal-failure rate: 0.02.
6. Keep observation and report schema version 1. Add no fields, profile selectors, CLI overrides, or migrations.
7. Update active documentation exactly as Task 3 of the plan requires:
   - docs/python-control-plane.md
   - docs/operations/stage1-local-docker.md
   - docs/operations/stage1-parity-sampling.md
   - docs/python-scout-migration-roadmap.md
8. Keep historical specs unchanged. Link the superseding design rather than rewriting history.
9. State consistently that:
   - the activation parity pair is pre-window evidence and cannot count toward the two in-window parity samples;
   - the two in-window samples use distinct approved first-party TikTok posts;
   - archived datasets retain their original embedded policy and cannot be reclassified;
   - evaluator `ready` is necessary but not sufficient for cutover;
   - controlled fallback, restart recovery, rollback drill, and human approval remain required external gates;
   - Python-default approval does not remove or disable TypeScript Scout.

TDD and verification requirements:

Run the commands from the approved plan. At minimum provide fresh evidence for:

```powershell
uv run --project python python -m pytest python/tests/operations/test_tiktok_soak.py -q
uv run --project python python -m pytest python/tests -q
uv run --project python ruff check python
uv run --project python ruff format --check python
git diff --check
```

Also scan the four active documents for stale operational claims containing the old 168-hour, seven-day, 50-run, or five-parity thresholds. Historical/superseded descriptions are allowed only when explicitly labelled as historical.

Do not wake WSL merely to duplicate pure-Python verification. CI will provide the later Linux gate after an independently authorized push. Do not contact Docker or the deployed services during this task.

Commit discipline:

- Make task-scoped commits only.
- Use one concise subject line, preferably at most 72 characters.
- Use exactly `git commit -m "<subject>"`.
- Do not add a body, detailed description, blank-line continuation, trailer, `Co-Authored-By`, or Claude/Anthropic attribution.
- Suggested subjects:
  - `feat: accelerate stage1 acceptance thresholds`
  - `docs: document accelerated stage1 acceptance`
- Do not amend or rewrite operator-owned commits.

Hard stops:

- Do not push or publish an image.
- Do not deploy, restart, recreate, stop, or inspect the live Docker stack.
- Do not run TikTok acquisition, parity, controlled fallback, rollback, or provider requests.
- Do not open an acceptance/soak window.
- Do not create or mutate observations, pairing records, aggregate reports, S3 evidence, fixtures, environment files, secrets, or GitHub Issue #5.
- Do not change success/fallback/failure rates, cleanup semantics, blocker ordering, route definitions, parity meaning, or redaction behavior.
- Do not enable Python-only mode, disable fallback, delete Scout, or begin Task 10.
- Do not fix unrelated test failures. Diagnose, preserve evidence, and report them.

Required final report in Indonesian:

1. Baseline commit, final commit, branch, upstream, and final worktree state.
2. Commits created with their exact one-line subjects and file lists.
3. RED command, failing assertions, and confirmation that failure was expected.
4. GREEN focused-test result.
5. Full Python suite and Ruff results with exact pass/fail/skip counts.
6. Final executable policy values.
7. Confirmation that rate, schema, cleanup, redaction, uniqueness, and blocker behavior were not changed.
8. Documentation consistency scan result.
9. Any pre-existing changes or environmental limitations preserved.
10. Explicit list of operational actions not performed.
11. Final handoff: `Ready for independent review before push; no live gate was entered.`

Stop after the report. Do not push and do not continue into the already approved isolated parity operation.
```
