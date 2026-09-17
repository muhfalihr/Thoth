# Creator Studio Prompt Lab Flake and Error Persistence Executor

Copy the fenced block directly into the implementation executor. It authorizes
one micro round for two items left open by the gate review of `7519d62`, plus
local commits only. It does not authorize push, publication, deployment,
provider requests, secrets, or Stage 1 operational mutation.

Task 1 reopens an item the previous round was correctly instructed to leave
alone. The stop condition that closed it is withdrawn for this case, and the
reason is stated in the block so the executor is not being asked to contradict
its predecessor without cause.

```text
Mode: IMPLEMENT_PLAN — Prompt Lab flake fix and error persistence

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- Expected branch: codex/stage1-container-ci
- Required baseline HEAD: 614a3cf (docs: record prompt lab deferred cleanup)
- Reviewed and cleared last round: 7519d62. Do not revisit or modify it.
- Upstream observed at review: origin/codex/stage1-container-ci at 70cfbbc;
  do not fetch, pull, merge, rebase, or push.
- Operator-owned working-tree items that must stay untouched and uncommitted:
  the unstaged `.gitignore` modification, `compose.stage1.controlled-fallback.yml`,
  `docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md`,
  and `docs/sessions/`.

Entrypoint and process:
- superpowers:test-driven-development. Ponytail at full intensity. Both fixes are
  one to three lines of real change; a larger diff means you have left scope.

Task 1 — Fix the lying mock behind the GuidedStudio flake.

The previous round investigated this, could not reproduce it in 45 runs, and was
instructed to stop rather than guess. That instruction is withdrawn here, because
the gate review then reproduced the failure (1 failure in 12 full-suite runs,
roughly 8%) and independently confirmed the mechanism by code inspection. This is
no longer a guess, so the no-guessing stop no longer applies. The previous round's
own root-cause analysis was correct; this task implements the fix it proposed.

Confirmed mechanism, verified in three files:
1. `GuidedStudio.test.tsx:186` — the test passes
   `patchEditDocument: mock(async () => ({ kind: "saved" as const, document }))`,
   returning the static module-level `document` fixture, which still carries the
   original heading.
2. `GuidedStudio.tsx:63-77` — the autosave effect fires on a 500ms debounce and
   dispatches `save_succeeded` with whatever that mock returned.
3. `editor_state.ts:250-272` — `save_succeeded` with no remaining pending
   operations calls `createEditorState(action.document)`, a full reset of the
   draft from the returned document.

So once 500ms elapses before the assertion line in
`GuidedStudio.test.tsx:178` ("switches between Scenes and Prompt Lab tabs and
preserves both drafts") is evaluated, the typed heading is overwritten by the
stale fixture and the draft assertion fails. Timing decides whether the race is
lost; the defect is constant. A real server echoes back the document with the
operations applied, so the mock is the thing that is wrong, not the component.

Required fix: make that mock return a document reflecting the patch it received,
rather than the static fixture. Apply the received operations, or otherwise
derive the returned document from the patch argument. The mock at
`GuidedStudio.test.tsx:64` is the existing precedent for a patch-aware mock in
this file; follow it rather than inventing a new pattern.

Also required: audit the other `patchEditDocument` mocks in
`GuidedStudio.test.tsx` and `GuidedStudio.final-fix.test.tsx` for the same stale-
fixture return. Fix any that carry the identical defect. Report every one you
found, including the ones you judged correct as-is and why.

Not authorized: any sleep, retry, increased timeout, fake timers, `test.skip`, or
change to `GuidedStudio.tsx` or `editor_state.ts`. The product code is correct.
Only the test doubles are wrong.

Evidence required: run the full `bun test` suite at least fifteen times after the
fix and report the pass/fail count of every run individually. Before the fix, also
report at least five runs, so the comparison means something even if the
pre-fix runs all happen to pass. State plainly if you never observe the failure
yourself; the fix stands on the verified mechanism, not on your reproduction.

Task 2 — Stop a background poll from erasing a visible error.

`prompt_proposal_state.ts` `case "proposal_loaded"` now resets `lastError: null`,
which was correct for the user-initiated paths. But the polling effect in
`PromptProposalPanel.tsx` also dispatches `proposal_loaded` on every tick while a
proposal is `queued` or `running`. So a failed lock save or apply shows its new
error banner and then has it silently wiped by an unrelated background timer
within one poll interval — defeating the error surface added last round.

Required fix: keep clearing the error when a genuinely new proposal arrives, stop
clearing it on a refresh of the proposal already in state. The candidate is a
condition inside the existing `proposal_loaded` case keyed on whether
`action.proposal.proposal_id` differs from `state.activeProposal?.proposal_id`.
Use it, or a better one you can defend — but no new action type, no new state
field, and no change to the polling effect itself.

Required RED test in `prompt_proposal_state.test.ts`: a `proposal_loaded` for the
same proposal id preserves an existing `lastError`, while a `proposal_loaded` for
a different proposal id clears it. Add a `PromptProposalPanel.test.tsx` DOM test
only if the reducer test cannot express the regression.

Out of scope — do not touch:
- Anything cleared in the last round: the error surface, the offline retry
  disable, the readiness gates, the generation guards.
- The `PromptProposalPanel.tsx` component size question. It was argued and closed;
  do not reopen it.
- Fixture deduplication between the two GuidedStudio test files.
- Python, Rust, Scout, OpenAPI, the generated client, and every file not named
  above.

Verification, with actual commands and exit codes:
- RED evidence for the task 2 test: command, observed failure text, and why it
  fails against the baseline.
- Focused suite: `bun test src/api/control-plane.test.ts
  src/features/studio/prompt_proposal_state.test.ts
  src/features/studio/PromptProposalPanel.test.tsx
  src/features/studio/PromptLab.test.tsx` from `dashboard/`. Baseline 102/102.
- Full `bun test` from `dashboard/`, at least fifteen runs, each reported.
  Baseline is 206 tests with the known intermittent failure.
- `bun run lint`, `bun run build`, `git diff --check`.
- No other gate is required; touching a file that needs one means you exceeded
  scope. Stop and report instead.

Constraints:
- No new dependency. No wire-contract, OpenAPI, generated-client or Python change.
- No credential, endpoint, prompt text, or provider payload anywhere.
- All tests stay offline against existing fakes.
- Commits: one concise subject line each, `git commit -m "<subject>"`, empty body,
  no trailer, no Co-Authored-By, no Claude/Anthropic attribution. Keep the flake
  fix and the reducer fix in separate commits.
- Update the SDD `progress.md` checkpoint and append to `CHANGELOG.md`. Cite only
  hashes that exist in branch history. Record that the previous round's stop
  decision on this flake was correct under the instruction it was given, and that
  this round proceeds on evidence that arrived afterwards — do not write it up as
  a failure of that round.

Hard stops — not authorized:
- No push, force-push, fetch/pull integration, PR, tag, or publication.
- No deployment, container build/run, restart, digest change, or live migration.
- No real secret access and no live provider, TikTok, CDN, browser, Scout,
  acquisition or Temporal request.
- No parity, fallback, p1-p6, evidence/observation/S3 mutation, or Issue #5 update.
- No commit, stage, restore or modification of the operator-owned items above.
- No weakening, skipping, retrying or timeout-extending of any test.
- Stop on the first unexpected failure or anything needing broader authority.

Required final report in Indonesian:
1. Baseline and final HEAD, branch, upstream, ahead/behind, and confirmation the
   four operator-owned items are unchanged and uncommitted.
2. Task 1: the fix with file:line, every `patchEditDocument` mock audited and your
   verdict on each, and the individual results of all pre-fix and post-fix full
   suite runs.
3. Task 2: the fix with file:line, the RED test name, its observed baseline
   failure text, and the GREEN result. State which condition you chose and why.
4. Ordered commits with hashes, one-line subjects, changed files, empty bodies,
   and no prohibited attribution.
5. Verification table with actual commands, counts and exit codes.
6. Total changed source lines, split between product code and test code.
7. Anything skipped and why.
8. Prohibited actions not performed, and next gate: Codex review before any
   push/publication decision.
9. End exactly:
   Prompt Lab flake and error persistence complete offline; Codex review required before push.
```
