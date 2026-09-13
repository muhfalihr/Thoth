# Creator Studio Prompt Lab AI Proposals Review Corrections Executor

Copy the fenced block directly into the implementation executor. It authorizes
one offline corrective round for the independently reviewed C2 implementation
and local commits only. It does not authorize push, publication, deployment,
provider requests, secrets, or Stage 1 operational mutation.

```text
Mode: IMPLEMENT_PLAN — C2 Prompt Lab AI Proposals review corrections

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- Expected branch: codex/stage1-container-ci
- Required corrective baseline ancestor: 29a7900254c0890ff89b04bdb3a58e27cda49251
- Baseline subject: fix: align prompt proposal contracts
- Expected pre-implementation drift from the baseline: at most the docs-only
  commit containing this corrective executor prompt.
- Upstream observed at review: origin/codex/stage1-container-ci at 70cfbbc;
  do not fetch, pull, merge, rebase, or push.

Objective:
Correct every verified C2 review finding so the production API can expose the
configured safe provider catalog, proposal creation uses the real saved source,
all approved Improve/Translate interactions work from the UI, recovery is
durable, Apply and lock mutations serialize correctly, provider/Temporal/public
error contracts fail closed, and the SDD/audit trail accurately records the
completed offline verification.

Read completely, in this order:
1. CLAUDE.md
2. AGENTS.md and C:\Users\mfr\.codex\RTK.md
3. .superpowers/sdd/2026-09-13-creator-studio-prompt-lab-ai-proposals/progress.md
4. docs/superpowers/specs/2026-09-13-creator-studio-prompt-lab-ai-proposals-design.md
5. docs/superpowers/plans/2026-09-13-creator-studio-prompt-lab-ai-proposals.md
6. docs/agent-prompts/creator-studio-prompt-lab-ai-proposals-executor.md
7. CHANGELOG.md
8. The current implementations and tests named below before editing them.

Entrypoint and process:
- Invoke superpowers:receiving-code-review first and verify each finding against
  the baseline code.
- Use superpowers:executing-plans for the four corrective tasks below.
- Use superpowers:test-driven-development for every behavior change. Capture a
  focused RED that fails for the intended reason before implementing that fix,
  then capture fresh GREEN evidence.
- Use Ponytail at full intensity: fix root causes in existing modules, delete
  no-ops, reuse stdlib and installed dependencies, and add no speculative layer.
- Use Context7 only if current third-party API documentation is required.
- Use superpowers:verification-before-completion before any completion claim.
- Prefix every shell command with rtk. Use apply_patch for manual edits.
- BLUEPRINT.md is not the task entrypoint or progress ledger and remains
  untouched. The active progress.md and CHANGELOG.md own checkpoint/history.

Preflight — fail closed:
1. Report branch, full HEAD, upstream, ahead/behind, worktree state, and prove
   29a7900254c0890ff89b04bdb3a58e27cda49251 is an ancestor.
2. Inspect all drift from that baseline. Continue only when committed drift is
   this corrective prompt and the only uncommitted state is exactly:
   - operator-owned `.gitignore` addition `.zcode/`;
   - untracked `compose.stage1.controlled-fallback.yml`;
   - untracked `docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md`.
3. Preserve those three operator-owned items byte-for-byte. Never stage, stash,
   reset, clean, overwrite, or commit them.
4. Stop and report any overlapping product-code drift or conflicting contract.

Corrective Task 1 — production catalog, source identity, and safe API errors

Files to inspect/modify:
- python/src/thoth_control_plane/api/app.py
- python/src/thoth_control_plane/api/routes/prompt_proposals.py
- python/src/thoth_control_plane/application/prompt_proposals.py
- python/src/thoth_control_plane/domain/prompt_proposals.py
- python/tests/api/test_prompt_proposals.py
- python/tests/application/test_prompt_proposals.py
- dashboard/src/features/studio/PromptLab.tsx
- dashboard/src/features/studio/PromptProposalPanel.tsx
- dashboard/src/features/studio/PromptLab.test.tsx
- dashboard/src/features/studio/PromptProposalPanel.test.tsx

Write RED tests proving all of these defects first:
1. create_app(Settings(...)) with an enabled runtime catalog and no injected
   catalog returns the safe projected provider/model catalog. The response
   omits base_url, protocol, credential_id, and secrets.
2. Explicit injected catalog still overrides settings for isolated tests.
3. PromptLab passes the exact server binding template_id, template_revision,
   binding_revision, and override into PromptProposalPanel.
4. Improve and Translate request bodies send that exact template ID; no ID is
   synthesized from a revision.
5. Saved source identity/revisions update after a stage change, binding reload,
   save, Apply reload, and reconnect; they are not frozen at reducer mount.
6. Every known proposal API failure returns a typed safe `detail.code` matching
   the approved failure contract. No raw exception, URL, prompt, credential,
   payload, or stack trace enters the response.
7. Project-scoped absent resources remain 404 and workflow/store unavailable
   remain 503.

Minimal implementation contract:
- Change the application factory catalog injection to optional. When absent,
  call public_prompt_provider_catalog(settings); when supplied, use the injected
  safe tuple unchanged.
- Add `savedTemplateId` to the panel boundary and store/synchronize the complete
  saved-source tuple in proposal state using an explicit reducer action/effect.
- Proposal creation is disabled unless template ID and both positive revisions
  are present.
- Map concrete application errors to stable safe codes in one route-level
  helper; do not duplicate exception bodies across handlers.
- Reuse the current authentication and project-scoping dependencies.

Focused GREEN:
- From repository root:
  rtk uv run --project python pytest python/tests/api/test_prompt_proposals.py python/tests/application/test_prompt_proposals.py -q
- From dashboard/:
  rtk bun test src/features/studio/PromptProposalPanel.test.tsx src/features/studio/PromptLab.test.tsx

Commit only after GREEN:
rtk git commit -m "fix: wire prompt proposal runtime"

Corrective Task 2 — complete UI interactions, locks, history, and recovery

Files to inspect/modify:
- dashboard/src/features/studio/prompt_proposal_state.ts
- dashboard/src/features/studio/prompt_proposal_state.test.ts
- dashboard/src/features/studio/PromptProposalPanel.tsx
- dashboard/src/features/studio/PromptProposalPanel.test.tsx
- dashboard/src/features/studio/PromptLab.tsx
- dashboard/src/features/studio/PromptLab.test.tsx
- dashboard/src/features/studio/GuidedStudio.tsx
- dashboard/src/features/studio/GuidedStudio.test.tsx
- dashboard/src/features/studio/GuidedStudio.final-fix.test.tsx
- dashboard/src/features/studio/prompt-proposal-test-fixtures.ts only if one shared
  typed fixture removes the current duplication without creating a framework.

Write RED tests proving:
1. Improve exposes a target-layer selector for template/project_override,
   optional improvement instructions, and sends exactly those saved values.
2. Improve is disabled only when its selected target is empty, locked, dirty,
   unsupported by the selected model, offline, or another proposal is active.
   An unrelated locked layer does not block it.
3. Translate exposes an editable target-language control and sends its value;
   it targets template plus only a non-empty override.
4. Improve and Translate buttons independently honor model capabilities.
5. Translate review renders source and proposed template plus source and
   proposed override when present. Improve continues selectable stored hunks.
6. A collapsed, keyboard-accessible history is rendered and selecting an entry
   opens its immutable comparison without creating a request.
7. Locking an absent/unlocked layer upserts the returned lock into reducer
   state. Unlock remains enabled while online and sends that lock's current
   `base_revision`. Both lock actions are disabled offline and while pending.
8. Revision conflicts display a safe recovery state and keep the latest
   returned preference/lock resource.
9. Initial offline state performs no proposal API writes. Reconnection reloads
   catalog/preference/locks/history, restores the persisted active proposal,
   and only then resumes polling.
10. A transient poll read failure schedules another bounded GET while online;
    polling remains sequential, pauses offline, stops terminal, and cleans the
    timer plus late async completion on unmount.
11. C1 unsaved template/override drafts remain byte-identical throughout every
    C2 load, reconnect, poll, selection, and terminal transition.

Minimal implementation contract:
- Extend the existing pure proposal reducer; do not merge it into PromptLab's C1
  authoring reducer and do not add a state/polling dependency.
- Make canGenerateProposal operation- and target-aware. Return visible disabled
  reasons; model capability and layer locks must be evaluated for that action.
- Use native select/input/textarea/details/summary controls and plain-text
  rendering. Never use dangerouslySetInnerHTML.
- Use one reload callback and one sequential polling effect. The next timeout is
  scheduled only after the previous GET settles. All listeners/timers/late
  completions have cleanup guards.
- Regenerate remains one explicit new proposal with a new idempotency key. It is
  not an automatic provider retry.
- Remove the no-op `void useCallback(() => undefined, [])` and its unused import.
- Extract the duplicated GuidedStudio C2 fixture only when both existing suites
  can import one small typed builder directly.

Focused GREEN from dashboard/:
rtk bun test src/features/studio/prompt_proposal_state.test.ts src/features/studio/PromptProposalPanel.test.tsx src/features/studio/PromptLab.test.tsx src/features/studio/GuidedStudio.test.tsx src/features/studio/GuidedStudio.final-fix.test.tsx
rtk bun run lint
rtk bun run build

Commit only after GREEN:
rtk git commit -m "fix: complete prompt proposal interactions"

Corrective Task 3 — translation, concurrency, provider, lifecycle, and Temporal contracts

Files to inspect/modify:
- python/src/thoth_control_plane/domain/prompt_proposals.py
- python/src/thoth_control_plane/application/prompt_proposal_ports.py
- python/src/thoth_control_plane/application/prompt_proposals.py
- python/src/thoth_control_plane/infrastructure/prompt_proposal_repository.py
- python/src/thoth_control_plane/infrastructure/prompt_provider.py
- python/src/thoth_control_plane/infrastructure/prompt_proposal_gateway.py
- python/src/thoth_control_plane/workflows/prompt_proposal.py
- corresponding domain/application/infrastructure/workflow tests
- python/openapi.json and dashboard/src/api/generated/control-plane.ts when the
  corrected public contract changes them.

Write RED tests proving:
1. Translate proposal target_layers is (`template`,) when saved override is
   null/blank, and (`template`, `project_override`) only when override is
   non-empty. A lock on an empty non-target override cannot block Apply.
2. save_lock and both Apply transactions acquire the same
   `pg_advisory_xact_lock(hashtext(project_id), hashtext(stage_id))` convention;
   Apply reads applicable lock rows with `FOR UPDATE`. A concurrent lock change
   therefore serializes before the final lock recheck/write.
3. A new proposal supersedes the previous succeeded proposal for that
   project-stage in the same reservation transaction, but never supersedes
   applied/rejected/failed history.
4. Saving a provider/model preference accepts any enabled catalog model with at
   least one supported capability. Each Generate action separately validates
   the capability it needs.
5. Provider output rejects numbers, booleans, arrays, objects, null, missing or
   extra layer keys, blank text, and oversized text as invalid_provider_output;
   it never coerces a non-string value with str().
6. PromptProposal timestamps use timezone-aware datetime contracts and stage_id
   reuses the existing closed PromptStageId type end-to-end where the domain
   permits it. Generated JSON remains ISO-8601 compatible.
7. Temporal already-started idempotency catches the SDK's exact
   WorkflowAlreadyStartedError (or exact documented ALREADY_EXISTS status), not
   an arbitrary exception whose message merely contains `already`.
8. Temporal workflow-facing input/result still contains only proposal ID, safe
   status, and safe failure code; maximum_attempts remains 1 and activity
   start-to-close remains 135 seconds.

Minimal implementation contract:
- Keep one database transaction per reservation/Apply and parameterized SQL.
- Standardize the advisory-lock tuple rather than layering a second lock scheme.
- Preserve one active queued/running proposal partial unique index and bounded
  newest-first history.
- Require exact JSON string values before strict ProviderPromptResult parsing.
- Catch the concrete Temporal idempotency exception. Every other exception maps
  to PromptWorkflowUnavailable without leaking its message.
- Remove the empty `workflow.unsafe.imports_passed_through()` block, unused
  gateway Settings field/parameter, unused provider runtime parameter, and the
  unconditional `if True:` block. Do not redesign working modules.

Focused GREEN from repository root:
rtk uv run --project python pytest python/tests/domain/test_prompt_proposals.py python/tests/application/test_prompt_proposals.py python/tests/infrastructure/test_prompt_proposal_repository.py python/tests/infrastructure/test_prompt_provider.py python/tests/infrastructure/test_prompt_proposal_gateway.py python/tests/workflows/test_prompt_proposal.py python/tests/activities/test_prompt_proposal.py python/tests/api/test_prompt_proposals.py python/tests/test_worker.py -q
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests

Regenerate contracts when necessary:
rtk uv run --project python python python/scripts/export_openapi.py
Then from dashboard/:
rtk bun run generate:control-plane-types
Do not hand-edit generated control-plane types.

Commit only after GREEN:
rtk git commit -m "fix: enforce prompt proposal contracts"

Corrective Task 4 — complete verification and truthful audit trail

Files:
- CHANGELOG.md
- local ignored .superpowers/sdd/2026-09-13-creator-studio-prompt-lab-ai-proposals/progress.md
- No BLUEPRINT.md change.

Required verification after the final product edit:

From repository root:
1. rtk uv sync --project python --frozen --all-groups --extra acquisition
2. rtk uv run --project python pytest -m "not live" -q
3. rtk uv run --project python ruff check python/src python/tests
4. rtk uv run --project python ruff format --check python/src python/tests
5. rtk uv run --project python python python/scripts/export_openapi.py
6. rtk cmd /c build_cuda.bat
7. rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
8. rtk git diff --check

From dashboard/:
9. rtk bun run generate:control-plane-types
10. rtk bun test
11. rtk bun run lint
12. rtk bun run build

From scout/:
13. rtk bun install --frozen-lockfile
14. rtk bun run test:acquisition
15. rtk bun run test:runtime

Generation stability:
16. Run the OpenAPI export and TypeScript generation a second time and prove
    they produce no additional diff.

Audit updates:
- Replace the stale active progress.md checkpoint with the actual baseline,
  ordered implementation/corrective commits, test evidence, known warnings,
  review status, and next operator gate.
- Append a concise corrective entry to CHANGELOG.md. Record the fresh
  build_cuda.bat result and do not claim a gate that was not run.
- Keep progress.md ignored; never force-add it.
- Verify every C2 commit has one short subject, empty body, and no
  Co-Authored-By trailer.

Commit only CHANGELOG.md and any necessary generated tracked files not already
committed by Task 3:
rtk git commit -m "docs: record prompt proposal corrections"

Preservation and security boundaries:
- No new dependency, service, process, queue, migration framework, provider SDK,
  state library, diff library, or polling library.
- Migrations 0001 and 0002 remain byte-identical. Migration 0003 may be corrected
  in place because it has not been pushed/deployed; report every SQL change.
- Credentials stay worker-only. The API/browser/Temporal history/logs/public
  errors never expose credentials, endpoint, credential ID, hidden instruction,
  prompt text, result text, or raw provider payload.
- All automated provider tests use httpx.MockTransport/fakes and make no network
  request.
- Keep existing C1 Prompt Lab save/conflict/offline behavior and all acquisition,
  parity, fallback, and EditDocument behavior unchanged.

Hard stops — not authorized:
- No push, force-push, fetch/pull integration, PR, tag, package/image publication,
  or GitHub Issue mutation.
- No deployment, image pull/build/run, service start/stop/restart, digest change,
  database migration against a live database, or acceptance/soak window.
- No real provider secret/env-file access and no live provider, TikTok, CDN,
  browser, Scout, acquisition, or Temporal request.
- No parity attempt, controlled fallback, p1-p6 mutation, evidence/observation/
  aggregate/S3 mutation, or Issue #5 update.
- No C3+, timeline, media, audio, render, or unrelated refactor.
- Stop on the first unexpected post-GREEN failure or any requirement that needs
  broader authority. Report the exact blocker without weakening tests.

Required final report in Indonesian:
1. Baseline/final full HEAD, branch, upstream, ahead/behind, ancestor result,
   tracked status, and byte-for-byte preservation of the three operator items.
2. Finding-by-finding closure table covering every RED test and implementation
   location, including catalog wiring, real template ID, UI inputs/capabilities,
   Translate comparison/history, reconnect/polling, revisioned unlock, empty
   override, lock serialization, strict provider output, typed safe API errors,
   lifecycle supersede, closed stage/timestamp types, and exact Temporal
   already-started handling.
3. Ordered corrective commits with hashes, one-line subjects, changed files,
   empty bodies, and no prohibited attribution.
4. Focused RED -> GREEN evidence with actual commands, failure causes, counts,
   and exit codes.
5. Full final verification table: Python, Ruff, dashboard tests/lint/build,
   OpenAPI/type generation stability, Scout suites, Compose config,
   build_cuda.bat, and git diff checks.
6. Security inspection proving browser/API/Temporal/log boundaries without
   printing a secret, endpoint, prompt, or payload.
7. Remaining limitations: offline fakes do not prove provider authentication,
   quota, model compatibility, deployment health, or live proposal success.
8. Exact prohibited actions not performed and next gate: independent Codex
   re-review before any push/publication decision.
9. End exactly:
   C2 review corrections complete offline; Codex re-review required before push.
```
