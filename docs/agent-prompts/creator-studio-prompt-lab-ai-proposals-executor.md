# Creator Studio Prompt Lab AI Proposals Executor

Copy the fenced block directly into the implementation executor. It authorizes
the complete offline C2 implementation and local commits only. It does not
authorize push, publication, deployment, secrets, provider requests, or any
Stage 1 operational mutation.

```text
Mode: IMPLEMENT_PLAN — Creator Studio Prompt Lab AI Proposals (C2)

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- Expected branch: codex/stage1-container-ci
- Required implementation baseline ancestor: 695966aa1f11b347fe388ee1eaad1d4788ceca2b
- Baseline subject: docs: plan prompt lab AI proposals
- Expected pre-implementation drift from that baseline: at most the docs-only commit containing this executor prompt.

Objective:
Implement the approved C2 design task-by-task: durable review-before-Apply AI
prompt proposals for narrative_plan, visual_plan, and caption_copy; UI-selected
server-allowlisted provider/model preferences; explicit starter templates;
layer locks; one-request asynchronous Temporal execution; selective Improve
Apply; whole-proposal Translate Apply; and offline-safe dashboard recovery.

Read completely, in this order:
1. CLAUDE.md
2. AGENTS.md and its imported C:\Users\mfr\.codex\RTK.md instructions
3. .superpowers/sdd/2026-09-13-creator-studio-prompt-lab-ai-proposals/progress.md
4. docs/superpowers/specs/2026-09-13-creator-studio-prompt-lab-ai-proposals-design.md
5. docs/superpowers/plans/2026-09-13-creator-studio-prompt-lab-ai-proposals.md
6. docs/superpowers/specs/2026-09-12-creator-studio-prompt-lab-foundation-design.md
7. CHANGELOG.md
8. The existing files named by each plan task before editing that task.

Entrypoint rule:
- The approved spec, implementation plan, and local SDD progress file are the
  execution source of truth.
- CHANGELOG.md is the durable completed-work trail.
- BLUEPRINT.md is not an execution entrypoint or progress ledger. Do not use it
  to override the approved C2 spec/plan and do not edit it for this task.

Preflight — fail closed before editing:
1. Run only read-only repository inspection first. Prefix every shell command
   with rtk.
2. Report branch, full HEAD, upstream, ahead/behind, worktree status, and
   git merge-base --is-ancestor result for
   695966aa1f11b347fe388ee1eaad1d4788ceca2b.
3. Inspect all drift since the baseline. Continue only if it is documentation
   for this C2 spec/plan/prompt and the two known untracked operator files.
4. Preserve these untracked operator files byte-for-byte and never stage them:
   - compose.stage1.controlled-fallback.yml
   - docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md
5. If product-code drift, a dirty overlapping file, a conflicting spec, or an
   unexpected operational mutation is present, stop and report it. Do not
   reset, clean, stash, rewrite, or discard user work.

Required process:
- Use superpowers:executing-plans and execute the twelve tasks in the approved
  plan in order.
- Use superpowers:test-driven-development for every product-code task. Capture
  the focused RED command/output before implementation and fresh GREEN output
  afterward.
- Use Ponytail at full intensity: trace the existing path, reuse project code,
  Python stdlib, native platform behavior, and installed dependencies. Do not
  add a provider SDK, diff library, state library, queue, service, process,
  migration framework, polling library, or speculative abstraction.
- Use Context7 only when current third-party library documentation is needed;
  query one concept at a time. The approved direction already uses httpx,
  pydantic-settings, Temporal Python SDK, FastAPI, psycopg, React, and Bun.
- Use superpowers:verification-before-completion before any completion claim.
- Use apply_patch for manual file edits. Do not use shell/Python write tricks.
- Keep each task independently reviewable and commit only after its specified
  GREEN gate passes.
- Every commit message is one short subject line with no body and no
  Co-Authored-By trailer. Use the exact short commit subjects from the plan.
- Do not rewrite or squash commits that existed before this task.

Authorized implementation scope:
1. Strict domain contracts, all three server-owned starter templates, and
   deterministic stdlib difflib hunks with stable IDs and server-side
   reconstruction.
2. Append-only editor migration 0003 with provider preferences, layer locks,
   durable proposals, changes, idempotency, applications, constraints, indexes,
   and atomic Apply provenance. Migrations 0001 and 0002 remain byte-identical.
3. Parameterized PostgreSQL repositories, bounded opaque-cursor history,
   revision conflicts, one active generation per project-stage, legal lifecycle
   transitions, and fully transactional Improve/Translate Apply.
4. PromptProposalService validation and orchestration, including saved-source,
   stage, capability, lock, idempotency, workflow-start, Reject, and Apply
   behavior.
5. Typed THOTH_PROMPT_PROVIDER_CATALOG and worker-only
   THOTH_PROMPT_PROVIDER_SECRETS configuration, both empty by default. The API
   may expose only the safe provider/model projection.
6. One OpenAI-compatible httpx request per activity invocation with a
   120-second request timeout, no transport/application retry, redirects
   disabled, strict JSON layer output, bounded validation, safe failure codes,
   and no raw payload retention.
7. A dedicated thoth-prompt-proposals Temporal task queue in the existing
   worker process. Workflow/activity history-facing inputs and results contain
   only proposal ID, safe status, and safe failure code. Use a 135-second
   activity start-to-close timeout and RetryPolicy(maximum_attempts=1).
8. Authenticated project-scoped FastAPI routes for safe catalog, starter,
   preference, locks, proposal create/history/detail, Apply, and Reject, with
   documented 202/404/409/422/503 behavior.
9. Deterministically regenerated python/openapi.json and generated dashboard
   TypeScript types, plus a thin one-request-per-call control-plane client.
10. A pure prompt_proposal_state reducer separate from the C1 authoring reducer.
11. PromptProposalPanel and PromptLab integration for starter/scratch,
    provider/model preference, locks, Improve/Translate generation, accessible
    durable status/history, plain-text comparison, selective Improve Apply,
    whole Translate Apply, Reject, Regenerate, bounded polling, and offline
    recovery without clobbering C1 drafts.
12. Disabled-by-default Stage 1 Compose wiring and contract tests. API receives
    catalog only; worker receives catalog, worker-only secret map, and restricted
    editor database URL. Example values remain empty JSON.
13. CHANGELOG.md completed-work entry and ignored local progress.md checkpoint.

Non-negotiable product contracts:
- All three stages support C2, but one action targets only the selected stage.
- Provider/model selection comes only from the server-owned allowlist and is
  persisted per project-stage with optimistic concurrency.
- Credentials, private endpoints, credential references, hidden policy, raw
  provider payloads, and arbitrary provider options never enter browser
  responses.
- Prompt text, proposal result text, provider payloads, credentials, endpoints,
  model IDs, and hidden policy never enter Temporal input/result, memo, search
  attributes, query payloads, signals, normal logs, metric labels, or public
  errors.
- Generate is disabled until the targeted source revision is saved and clean.
- One user action reserves one durable proposal and performs at most one
  provider request. No automatic retry or second request after persistence
  failure. Regenerate is a new explicit proposal and idempotency key.
- Provider output never mutates prompt data before explicit Apply.
- Improve targets one selected unlocked layer and Apply accepts only stored
  stable change IDs, never client-authored replacement text.
- Translate preserves template and project override as separate complete
  target-language layers and applies all-or-nothing.
- Apply rechecks project/stage ownership, succeeded status, exact source
  revisions, locks, change IDs, and language constraints inside one transaction.
- Stale or locked Apply fails closed and leaves the proposal inspectable.
- Applied revisions are ai_assisted and user_approved with immutable proposal,
  provider/model, actor, accepted-change, and resulting-revision provenance.
- Only one queued/running proposal exists per project-stage.
- Proposals/history survive navigation, refresh, API restart, and reconnection.
- Polling is sequential, stops on terminal state, pauses offline, resumes only
  after state reload, and cleans timers/listeners/late async updates on unmount.
- Existing C1 draft/save/offline semantics remain authoritative and unchanged.
- Render provider output as plain text. Never use dangerouslySetInnerHTML.

Task execution:
- Follow every Files, Interfaces, RED, implementation, GREEN, and Commit step in
  docs/superpowers/plans/2026-09-13-creator-studio-prompt-lab-ai-proposals.md.
- Do not silently rename interfaces, routes, environment variables, task queue,
  statuses, failure codes, or timeout values. If the plan conflicts with current
  code in a way that changes the public/domain contract, stop and report the
  exact conflict for operator/Codex review.
- Test doubles must use httpx.MockTransport or in-memory repositories and must
  never contact a network.
- Generated control-plane types must be produced by the repository scripts, not
  hand-edited.
- The local ignored progress.md may be updated but must not be force-added.

Required final verification from repository root:
1. rtk uv sync --project python --frozen --all-groups --extra acquisition
2. rtk uv run --project python pytest -m "not live" -q
3. rtk uv run --project python ruff check python/src python/tests
4. rtk uv run --project python ruff format --check python/src python/tests
5. rtk uv run --project python python python/scripts/export_openapi.py
6. rtk bun --cwd dashboard run generate:control-plane-types
7. rtk bun --cwd dashboard test
8. rtk bun --cwd dashboard run lint
9. rtk bun --cwd dashboard run build
10. rtk bun --cwd scout install --frozen-lockfile
11. rtk bun --cwd scout run test:acquisition
12. rtk bun --cwd scout run test:runtime
13. rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
14. rtk git diff --check
15. Re-run OpenAPI export and TypeScript generation once more and prove there is
    no new generated diff.

Verification evidence requirements:
- Record every focused RED and fresh GREEN command, expected failure cause,
  actual exit status, and test count.
- Record full Python, dashboard, Scout, Compose, lint, formatting, build, and
  generation-stability results after the final edit.
- Distinguish pre-existing warnings from new warnings. New warnings introduced
  by C2 must be fixed before completion.
- Inspect git diff/stat/status and commit messages after all tasks. Confirm only
  approved files changed and both operator files remain untracked and intact.
- Inspect the public OpenAPI/provider payloads, Temporal workflow-facing models,
  logging calls, and Compose environment projection to substantiate the secret
  and prompt-content boundaries; do not reveal any secret or prompt value while
  reporting.

Hard stops — not authorized:
- Do not push, force-push, publish an image/package, open a PR, create a tag, or
  mutate any GitHub issue.
- Do not deploy, pull/build/run a container image, restart/stop/start services,
  change a deployed digest, or open an acceptance/soak window.
- Do not read, create, copy, print, validate, or use real provider credentials,
  provider env files, restricted fixture URLs, or operational secrets.
- Do not make a TikTok, CDN, provider, browser, Scout-live, acquisition,
  Temporal-live, or any other external request.
- Do not execute a live provider compatibility, authentication, quota, billing,
  or model check.
- Do not run parity, controlled fallback, p1-p6 retry/new sample, or mutate
  pairing records, observations, aggregates, backups, reports, media, S3 data,
  evidence permissions, or Issue #5.
- Do not change the default acquisition mode, remove Scout, implement timeline,
  rendering, EditDocument, media, audio, or any C3+ feature.
- Do not add dependencies or broaden scope without explicit operator approval.
- Stop on the first unexpected post-GREEN failure or any requirement that would
  cross these boundaries. Diagnose only with read-only/offline evidence in the
  approved files and report the blocker.

Required final report in Indonesian:
1. Baseline, final full HEAD, branch, upstream, ahead/behind, baseline ancestor,
   tracked cleanliness, and preserved untracked operator files.
2. Ordered commit table: task, commit hash, one-line subject, changed files, and
   confirmation of no body or Co-Authored-By trailer.
3. Per-task RED -> GREEN evidence with commands, actual test counts, and exit
   codes.
4. File-by-file responsibility summary, including migration and generated files.
5. Domain/API/UI behavior proven for all three stages, one selected stage per
   action, starter/scratch, preferences, locks, Improve, Translate, Apply,
   Reject, Regenerate, history, stale state, and offline recovery.
6. Provider proof: safe catalog projection, one mocked request, 120-second HTTP
   timeout, no retry, strict output validation, and safe failure classification.
7. Temporal proof: dedicated queue, proposal-ID-only history-facing contracts,
   135-second activity timeout, maximum_attempts=1, and existing worker process.
8. Persistence proof: append-only migration, parameterized writes, bounded
   history, active uniqueness, idempotency, atomic Apply rollback, and immutable
   approval provenance.
9. Complete final verification table with actual counts/results for Python,
   Ruff, OpenAPI generation stability, dashboard tests/lint/build, Scout suites,
   Compose config, and git diff checks.
10. Security/privacy inspection results without including any secret, endpoint,
    prompt content, or provider payload.
11. Pre-existing warnings and remaining limitations. State explicitly that
    offline fakes do not prove provider authentication, quota, model
    compatibility, deployment health, or live proposal success.
12. Exact hard-stop operations not performed and the next operator gate:
    independent Codex review before any push/publication decision.
13. End exactly with:
    Offline C2 implementation complete; Codex review required before push.
```
