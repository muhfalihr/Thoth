# Creator Studio Prompt Lab AI Proposals Round 5 Corrective Executor

Copy the fenced block directly into the implementation executor. It authorizes
one narrow offline corrective round for the two findings raised by the round 4
gate review of `df140e6`/`6bdc540`, plus local commits only. It does not
authorize push, publication, deployment, provider requests, secrets, or Stage 1
operational mutation.

```text
Mode: IMPLEMENT_PLAN — C2 Prompt Lab AI Proposals review corrections, round 5

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- Expected branch: codex/stage1-container-ci
- Required baseline HEAD: 6bdc5409dec25c74c8d6ea0a91b87367d9fb3930
- Baseline subject: docs: correct prompt proposal final review
- Reviewed fix commit under this gate: df140e6df58b8cd85c39f738ec7f67cac94b03aa
- Expected pre-implementation drift from the baseline: at most the docs-only
  commit containing this corrective executor prompt.
- Upstream observed at review: origin/codex/stage1-container-ci at 70cfbbc;
  do not fetch, pull, merge, rebase, or push.
- Operator-owned working-tree items that must stay untouched and uncommitted:
  the unstaged `.gitignore` modification, `.freebuff/`,
  `compose.stage1.controlled-fallback.yml`,
  `docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md`,
  and `docs/sessions/`.

Objective:
Finish round 4 finding 1. The `resourcesReady` readiness flag that round
introduced is the declared gate for every prompt-lab mutation, but two of the
mutations it names by its own contract never consult it. Make the UI honor the
flag it documents, and stop one silent no-op from presenting itself as a
working button.

Read completely, in this order:
1. CLAUDE.md
2. AGENTS.md and C:\Users\mfr\.codex\RTK.md
3. .superpowers/sdd/2026-09-13-creator-studio-prompt-lab-ai-proposals/progress.md
4. docs/superpowers/specs/2026-09-13-creator-studio-prompt-lab-ai-proposals-design.md
5. docs/superpowers/plans/2026-09-13-creator-studio-prompt-lab-ai-proposals.md
6. CHANGELOG.md, round 2 and round 3 entries
7. dashboard/src/features/studio/prompt_proposal_state.ts and
   dashboard/src/features/studio/PromptProposalPanel.tsx before editing them.

Entrypoint and process:
- Invoke superpowers:receiving-code-review first and verify each finding against
  the current code before changing anything. Push back in the final report, with
  file:line evidence, on any finding you can prove wrong instead of writing code
  to satisfy it.
- Then superpowers:test-driven-development. Every behavior change lands RED
  first: the new test must fail against the unmodified baseline for the stated
  reason, and you must record that observed failure text.
- Ponytail at full intensity. Both fixes are small by nature; a diff larger than
  roughly thirty changed source lines means you have left the authorized scope.

Finding 1 — Important. The readiness flag is not consulted by the preference
write or the lock writes.

- `prompt_proposal_state.ts:44-49` documents `resourcesReady` as the flag that
  "every proposal mutation (generate/apply/reject/preference write/lock write)
  must check ... so a partial or failed load can never be mistaken for 'nothing
  is locked' or 'no preference exists'".
- `canGenerateProposal` and `canApplyProposal` do check it. The three UI controls
  at `PromptProposalPanel.tsx:474` (Save preference), `:508` (Lock template) and
  `:518` (Lock project override) instead gate on
  `state.lastError === "stage_load_failed"`.
- Reachable consequence: `stage_selected` sets `locks: []`, `preference: null`,
  `resourcesReady: false` and `lastError: null`, and `loadStage` then awaits four
  sequential requests. Throughout that window the three controls are enabled on
  empty state. A lock button reads "Lock template" for a layer that is actually
  locked, and clicking sends `base_revision: null`.
- The server is fail-closed here: `prompt_proposal_repository.py:209` and `:323`
  raise a revision conflict for a null `base_revision` against an existing row,
  so there is no lost update. Fix the client gate, not the repository.
- Secondary fragility to remove with the same change: `lastError` is a
  last-writer-wins field, so any unrelated `error` dispatch after a failed load
  both hides the retry banner and re-enables those controls while
  `resourcesReady` is still false.
- Required fix: gate the three controls on `!state.resourcesReady` instead of
  `state.lastError === "stage_load_failed"`. `stage_load_failed` also sets
  `resourcesReady: false`, so the new condition strictly subsumes the old one and
  no failed-state behavior may regress. Do not introduce a second flag, a
  derived selector, a new reducer action, or a new hook.
- Required RED test: in `PromptProposalPanel.test.tsx`, a lock mutation attempted
  while a stage load is still in flight (resolved catalog, unresolved
  locks/history) must find the control disabled and must issue no
  `savePromptLock` call. Assert on the client fake, not only on the DOM.
- Consider, and state your conclusion on, whether the retry banner condition
  `!state.resourcesReady && state.lastError === "stage_load_failed"` should keep
  both halves. Changing it is authorized only if you can show the single-half
  form is strictly equivalent; otherwise leave it and say why.

Finding 2 — Minor. Silent no-op on an unknown stage id.

- `PromptProposalPanel.tsx:245`: `if (!isPromptStageId(stageId)) return;`. `Props.stageId`
  is `string` (`PromptProposalPanel.tsx:31`), so this is a live runtime branch,
  and the Generate button stays visibly enabled while doing nothing.
- Required fix: surface the refusal through the existing error channel rather
  than returning silently. Reuse the reducer's existing `error` action with a new
  code only if no existing code fits; do not add a new action type, a toast
  system, or a new error surface.
- Required RED test: rendering the panel with an unrecognized `stageId` and
  clicking Generate must surface the error state and must issue no
  `createPromptProposal` call.

Explicitly out of scope this round — do not touch:
- The round 3 P3 "divergent change" note on `PromptProposalPanel.tsx` (now 721
  lines). No extraction, no hook split, no file split, no reorganization.
- The retry banner's missing offline disable.
- The pre-existing `GuidedStudio.test.tsx` flake, its duplicated fixtures, and
  every other deferred P3 recorded in earlier rounds.
- Python, Rust, Scout, OpenAPI, the generated client, and every other file not
  named above. This round is expected to change
  `dashboard/src/features/studio/PromptProposalPanel.tsx`, possibly
  `dashboard/src/features/studio/prompt_proposal_state.ts`, their tests,
  `CHANGELOG.md`, and the SDD `progress.md` — nothing else.

Verification, with actual commands and exit codes in the report:
- RED evidence per test: the command, the observed failure text, and the reason
  it fails against the baseline.
- `bun test src/api/control-plane.test.ts
  src/features/studio/prompt_proposal_state.test.ts
  src/features/studio/PromptProposalPanel.test.tsx
  src/features/studio/PromptLab.test.tsx` from `dashboard/`. The gate measured
  97 pass / 0 fail on the baseline; report the new count and account for every
  added test.
- Full `bun test` from `dashboard/`. The baseline is 201 tests across 20 files
  with one known pre-existing `GuidedStudio.test.tsx` flake. If that flake
  appears, say so and do not fix it. Any other failure is a stop condition.
- `bun run lint` and `bun run build` from `dashboard/`.
- `git diff --check`.
- Python, OpenAPI export, TS generation, Scout, Compose, and `build_cuda.bat` are
  not required this round: no file they cover is in the authorized scope. If your
  diff touches any of them you have exceeded scope — stop and report instead of
  running the extra gates.

Preservation, security, operational constraints:
- No new dependency, hook library, state library, or test framework.
- No change to the wire contract, `openapi.json`, the generated client, any
  Python route, any repository, or any migration.
- Keep C1 Prompt Lab save/conflict/offline behavior and all acquisition, parity,
  fallback, and EditDocument behavior unchanged.
- No credential, endpoint, prompt text, or provider payload in code, tests, logs,
  or the report.
- All tests stay offline against existing fakes; no network request.
- Commits: one concise subject line each, `git commit -m "<subject>"`, no body,
  no trailer, no Co-Authored-By, no Claude/Anthropic attribution.
- Update the SDD `progress.md` checkpoint and append the completed-work record to
  `CHANGELOG.md`. State the fix commit hash accurately; do not cite a hash that
  does not exist in branch history.

Hard stops — not authorized:
- No push, force-push, fetch/pull integration, PR, tag, package/image
  publication, or GitHub Issue mutation.
- No deployment, image pull/build/run, service start/stop/restart, digest change,
  live migration, or acceptance/soak window.
- No real provider secret/env-file access and no live provider, TikTok, CDN,
  browser, Scout, acquisition, or Temporal request.
- No parity attempt, controlled fallback, p1-p6 mutation, evidence/observation/
  aggregate/S3 mutation, or Issue #5 update.
- No commit, stage, restore, or modification of the operator-owned working-tree
  items listed under Repository.
- No C3+, timeline, media, audio, render, or unrelated refactor.
- Stop on the first unexpected post-GREEN failure or any requirement needing
  broader authority. Report the exact blocker without weakening a test.

Required final report in Indonesian:
1. Baseline and final full HEAD, branch, upstream, ahead/behind, ancestor check,
   and confirmation that the five operator-owned items are byte-for-byte
   unchanged and uncommitted.
2. Finding-by-finding closure: for each of the two findings, the file:line of the
   fix, the RED test name, its observed baseline failure text, and its GREEN
   result. Include any finding you are pushing back on, with evidence.
3. Your conclusion on the retry banner condition question, with reasoning.
4. Ordered commits with hashes, one-line subjects, changed files, empty bodies,
   and no prohibited attribution.
5. Verification table with actual commands, counts, and exit codes, including the
   full `bun test` result and explicit handling of the known flake.
6. Total changed source lines, as evidence the scope held.
7. Remaining limitations and everything deliberately left untouched.
8. Exact prohibited actions not performed, and next gate: independent Codex
   re-review before any push/publication decision.
9. End exactly:
   C2 round 5 corrections complete offline; Codex re-review required before push.
```
