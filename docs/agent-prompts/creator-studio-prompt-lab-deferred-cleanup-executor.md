# Creator Studio Prompt Lab Deferred Cleanup Executor

Copy the fenced block directly into the implementation executor. It authorizes
one offline cleanup round for the items deliberately deferred across the five C2
review rounds, plus local commits only. It does not authorize push, publication,
deployment, provider requests, secrets, or Stage 1 operational mutation.

This round is cleanup, not correction. No finding here blocks the C2 feature;
the C2 review gate already cleared at `092344f`.

```text
Mode: IMPLEMENT_PLAN — Prompt Lab deferred cleanup

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- Expected branch: codex/stage1-container-ci
- Required baseline HEAD: 5e71cab (docs: add prompt proposal round 5 corrective)
- Last C2 fix commit, already review-cleared: 092344f
- Upstream observed at review: origin/codex/stage1-container-ci at 70cfbbc;
  do not fetch, pull, merge, rebase, or push.
- Operator-owned working-tree items that must stay untouched and uncommitted:
  the unstaged `.gitignore` modification, `compose.stage1.controlled-fallback.yml`,
  `docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md`,
  and `docs/sessions/`.

Objective:
Close the four items that five review rounds recorded as deferred. Task 1 is the
only one that protects anything load-bearing: an intermittently failing test
silently weakens every verification gate this feature was signed off against.
Tasks 2 and 3 are small real gaps. Task 4 is a judgment call you are expected to
argue, not automatically perform.

Read completely, in this order:
1. CLAUDE.md
2. AGENTS.md and C:\Users\mfr\.codex\RTK.md
3. .superpowers/sdd/2026-09-13-creator-studio-prompt-lab-ai-proposals/progress.md
4. CHANGELOG.md, rounds 2 through 5
5. docs/agent-prompts/creator-studio-prompt-lab-ai-proposals-round5-corrective-executor.md
6. The files named in each task below, before editing them.

Entrypoint and process:
- Invoke superpowers:systematic-debugging for task 1. It is a debugging task, not
  an editing task: find the actual cause before touching a line.
- superpowers:test-driven-development for tasks 2 and 3.
- Ponytail at full intensity, and it bites hardest here. This is cleanup work,
  which is exactly where unrequested abstraction gets smuggled in. Deletion beats
  addition. If a task turns out not to need doing, say so and skip it — a
  well-argued skip is a passing result for this round.

Task 1 — Root-cause the intermittent `GuidedStudio.test.tsx` failure. Highest
value in this round.

- Test: `dashboard/src/features/studio/GuidedStudio.test.tsx:178`,
  "switches between Scenes and Prompt Lab tabs and preserves both drafts".
- History: round 4 observed it failing on one full `bun test` run and reproduced
  it at the same rate in a throwaway worktree at the unmodified commit `11fed99`,
  so it is pre-existing and not caused by any C2 round. It was left alone as
  out of scope each time. The gate review of round 5 ran a full `bun test` and saw
  203/203 with no flake, so it does not reproduce on every run.
- Why it matters: every one of the five C2 review rounds was signed off on a
  green `bun test`. A test that passes or fails by timing means that signal is
  weaker than it was reported to be. Fix the cause, or prove the test itself is
  the defect.
- Required first step: establish a reproduction rate before changing anything.
  Run the file in isolation and as part of the full suite, repeatedly, and report
  the observed failure counts for each. State the numbers, not an impression.
- Then find the actual cause. Likely candidates to confirm or eliminate, not to
  assume: an unawaited state update, a shared module-level fixture mutated across
  tests, a timer or promise still in flight when the test ends, or test ordering
  when the full suite runs. Note that `PromptProposalPanel.test.tsx` contains at
  least one test that resolves a deferred client promise at the very end without
  awaiting the rest of the load sequence; whether that leaks into other files is
  worth checking, not worth assuming.
- Fix the root cause. Do not add a retry, a `waitFor` with a longer timeout, a
  sleep, a `test.skip`, or an increased test timeout to make the symptom go away.
  If the correct answer is that the test asserts something the component never
  guaranteed, deleting or rewriting the assertion is an acceptable fix, provided
  you state exactly what coverage is lost.
- Evidence required: the reproduction rate before and after, from the same
  command, with enough runs that the numbers mean something.
- Stop condition: if you cannot reproduce it at all after a reasonable number of
  runs, do not guess at a fix. Report the runs you did, leave the test alone, and
  move to task 2.

Task 2 — Give the panel a generic error surface.

- `dashboard/src/features/studio/PromptProposalPanel.tsx:409` is the only reader
  of `state.lastError`, and it only handles `"stage_load_failed"`. Every other
  error the panel dispatches is invisible to the user: `"unknown_stage_id"` from
  `generate()`, and `"store_unavailable"` from the apply, reject, lock-save and
  preference-save `.catch()` handlers.
- Consequence today: an apply or a lock that fails against the store leaves the
  UI silent. The user sees a click that did nothing.
- Required fix: render `state.lastError` when it is set and is not already
  handled by the existing stage-load banner, mapping each known code to a short
  human message with a sensible fallback for an unrecognized code. Keep the
  existing stage-load banner and its retry button exactly as they are; this is an
  addition beside it, not a rewrite of it.
- Keep it to one element and one code-to-message map in this file. No toast
  library, no notification context, no error boundary, no new state slice, no new
  reducer action. `lastError` already exists and is already dispatched correctly;
  the only thing missing is a reader.
- Also required: `lastError` must be cleared when it no longer applies, otherwise
  the message becomes permanent. Determine where that belongs from the existing
  reducer cases rather than adding a dedicated clear action if an existing case
  already resets it.
- Required RED tests, in `PromptProposalPanel.test.tsx`: a failing lock save
  surfaces a visible message, and an unrecognized `stageId` surfaces a visible
  message. Assert on the DOM through `screen`, not on the reducer — the whole
  point of this task is the part a reducer spy cannot see.

Task 3 — Disable the retry banner's button while offline.

- `dashboard/src/features/studio/PromptProposalPanel.tsx:409-419`: the "Retry
  loading proposals" button has no `disabled` condition, so it fires a reload
  that is certain to fail while the browser is offline.
- Required fix: `disabled={!online}`, consistent with every other control in this
  panel. One attribute.
- Required RED test: with `online: false` and a failed load, the retry button is
  disabled and clicking it issues no client call.

Task 4 — Argue the `PromptProposalPanel.tsx` size question before acting on it.

- Rounds 3 and 4 both recorded a P3 "divergent change" note: the component is now
  724 lines and owns sequential loading, reconnect, polling, stale-generation
  guards, mutations, lock saves and rendering. Tasks 2 and 3 will add to it.
- Do not reflexively split it. A component split for its own sake is precisely
  the unrequested abstraction Ponytail forbids, and this file is currently
  correct, tested and just cleared by review. Churning it risks a real regression
  to fix a smell.
- What is authorized: extract only if you can name a seam that already exists —
  a block of state and effects with no bidirectional coupling to the rest — and
  only if the extraction reduces total lines rather than moving them plus
  boilerplate. A custom hook holding the load/reconnect/poll lifecycle is the one
  candidate worth evaluating.
- What is not authorized: splitting rendering into child components, introducing
  a context, a state library, a reducer file per concern, or any prop-drilling
  layer.
- Reporting an argued refusal is a fully acceptable outcome. If you do refuse,
  record the reason in the checkpoint so the next reviewer stops re-raising it.
- If you do extract, the full dashboard suite must stay green with no test
  rewritten to accommodate the move. A test that needs editing to keep passing
  means the refactor changed behavior; revert it.

Optional, only if task 1 leads you into the file anyway:
- `GuidedStudio.test.tsx` and `GuidedStudio.final-fix.test.tsx` (252 and 305
  lines) duplicate C2 mock fixtures — a round 1 and round 2 P3. Deduplicating is
  authorized only as a byproduct of task 1, never as its own excursion, and only
  by moving the shared fixture into one place both files import. Do not merge,
  rename, or reorganize the two test files.

Explicitly out of scope — do not touch:
- Python, Rust, Scout, OpenAPI, the generated client, migrations, and every file
  not named in a task above.
- Any C2 behavior the review just cleared: the readiness gates, the generation
  guards, the idempotency contract, the stage-id guard.
- Any C3+ work, and any unrelated refactor.

Verification, with actual commands and exit codes in the report:
- RED evidence per new test: the command, the observed failure text, and why it
  fails against the baseline.
- `bun test src/api/control-plane.test.ts
  src/features/studio/prompt_proposal_state.test.ts
  src/features/studio/PromptProposalPanel.test.tsx
  src/features/studio/PromptLab.test.tsx` from `dashboard/`. Baseline is 99/99;
  account for every added test.
- Full `bun test` from `dashboard/`. Baseline is 203/203 across 20 files. Run it
  at least three times and report each result separately — a single green run no
  longer counts as evidence for this round, because task 1 is about exactly that.
- `bun run lint` and `bun run build` from `dashboard/`.
- `git diff --check`.
- Python, OpenAPI, Scout, Compose and `build_cuda.bat` gates are not required: no
  file they cover is in scope. If your diff reaches them, you have exceeded scope
  — stop and report.

Preservation, security, operational constraints:
- No new dependency of any kind.
- No change to the wire contract, `openapi.json`, the generated client, or any
  Python route or repository.
- Keep C1 Prompt Lab save/conflict/offline behavior and all acquisition, parity,
  fallback and EditDocument behavior unchanged.
- No credential, endpoint, prompt text, or provider payload in code, tests, logs
  or the report.
- All tests stay offline against existing fakes; no network request.
- Commits: one concise subject line each, `git commit -m "<subject>"`, no body,
  no trailer, no Co-Authored-By, no Claude/Anthropic attribution. Separate the
  flake fix from the UI work so either can be reverted alone.
- Update the SDD `progress.md` checkpoint and append the completed-work record to
  `CHANGELOG.md`. Cite only hashes that exist in branch history.

Hard stops — not authorized:
- No push, force-push, fetch/pull integration, PR, tag, package/image
  publication, or GitHub Issue mutation.
- No deployment, image pull/build/run, service start/stop/restart, digest change,
  live migration, or acceptance/soak window.
- No real provider secret/env-file access and no live provider, TikTok, CDN,
  browser, Scout, acquisition or Temporal request.
- No parity attempt, controlled fallback, p1-p6 mutation, evidence/observation/
  aggregate/S3 mutation, or Issue #5 update.
- No commit, stage, restore or modification of the operator-owned working-tree
  items listed under Repository.
- No weakening, skipping, retrying or timeout-extending of any test to make it
  pass. This is the one rule that, if broken, invalidates the entire round.
- Stop on the first unexpected failure or any requirement needing broader
  authority. Report the exact blocker.

Required final report in Indonesian:
1. Baseline and final full HEAD, branch, upstream, ahead/behind, ancestor check,
   and confirmation the four operator-owned items are unchanged and uncommitted.
2. Task 1: reproduction rate before and after with raw run counts, the root cause
   with file:line, the fix, and what you ruled out. If unreproduced, the runs you
   performed and your recommendation.
3. Tasks 2 and 3: file:line of each fix, RED test names, observed baseline
   failure text, GREEN results.
4. Task 4: your decision with technical reasoning. If you extracted, the seam and
   the line-count delta. If you refused, the argument, stated well enough that
   the next reviewer can accept or overrule it on its merits.
5. Ordered commits with hashes, one-line subjects, changed files, empty bodies,
   and no prohibited attribution.
6. Verification table with actual commands, counts and exit codes, including all
   three full `bun test` runs reported separately.
7. Total changed source lines, split between product code and test code.
8. Anything you deliberately skipped and why.
9. Exact prohibited actions not performed, and next gate: Codex review before any
   push/publication decision.
10. End exactly:
    Prompt Lab deferred cleanup complete offline; Codex review required before push.
```
