# Creator Studio Advanced Timeline Review Corrections Executor

Copy the fenced block directly into the implementation executor. It authorizes
one offline corrective round and local commits only.

```text
Mode: IMPLEMENT_PLAN — D1 Creator Studio Advanced Timeline review corrections

Repository:
- Windows path: C:\Users\mfr\Documents\MyTools\CLIPPER
- Required branch: codex/stage1-container-ci
- Required product baseline ancestor and reviewed implementation HEAD: a2cafa672dcb11a88d73e4546a698577021ee10f
- Baseline subject: docs: record advanced timeline foundation
- Upstream observed during review: origin/codex/stage1-container-ci at e8fd07383d3f86936ea1866ca1d1d59592937036
- Observed ahead/behind: 19/0
- Expected HEAD before implementation: at most one docs-only commit after a2cafa6 containing the corrective spec, plan, and executor prompt.
- Expected worktree before implementation: clean tracked files; the gitignored checkpoint may contain Codex's review update. Treat any product-code drift as unexpected.

Objective:
Close every accepted independent review finding for D1 without adding D2 scope, new operation kinds, dependencies, services, migrations, or live behavior. Preserve local drafts during upgrade, guard every document-owned async result, provide real Simple/Advanced projections over one v2 draft, connect the existing PlayerRef hook to Studio, retain paginated assets, keep Inspector values selection-correct, faithfully preview persisted typed fields, and align the preview capability implementation with the current single-owner bearer-capability contract.

Read completely, in order:
1. CLAUDE.md
2. AGENTS.md
3. C:\Users\mfr\.codex\RTK.md
4. .superpowers/sdd/2026-09-19-creator-studio-advanced-timeline-foundation/progress.md
5. docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md
6. docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-review-corrections-design.md
7. docs/superpowers/plans/2026-09-19-creator-studio-advanced-timeline-foundation.md
8. docs/superpowers/plans/2026-09-20-creator-studio-advanced-timeline-review-corrections.md
9. docs/agent-prompts/creator-studio-advanced-timeline-review-corrections-executor.md
10. CHANGELOG.md
11. Every current implementation and test named by the corrective plan before editing it.

Entrypoint and process:
- Invoke superpowers:receiving-code-review first.
- Invoke Ponytail at full intensity and trace each real flow before changing it.
- Use superpowers:executing-plans for the corrective plan, Tasks 1 through 5, in order.
- Use superpowers:test-driven-development for every product behavior change. Capture a genuine RED before implementation and the focused GREEN after it.
- Use Context7 for current React and Remotion API questions. Resolve official/version-matched documentation first; query one concept at a time.
- Use superpowers:verification-before-completion before any completion claim.
- Keep repository artifacts and commit subjects in English. Report to the operator in Indonesian.

Fail-closed preflight:
1. Record branch, full HEAD, upstream, ahead/behind, tracked/untracked status, and `git diff --name-status a2cafa6...HEAD`. Before product work that diff may contain only the three corrective documentation files.
2. Require a2cafa6 to be an ancestor of HEAD.
3. Confirm all original D1 commits remain reachable. Do not amend, squash, rebase, reset, or rewrite them.
4. Inspect every current worktree difference. The three new corrective documents and gitignored progress checkpoint are expected. Preserve any other operator-owned item byte-for-byte and keep it unstaged.
5. Stop and report before editing product code if there is overlapping product drift, an unresolved merge/rebase, a changed migration, a new dependency, or a contract conflict not resolved by the corrective spec.

Authorized deliverables:

Corrective Task 1 — lossless upgrade and async lifecycle
- Add dedicated reducer upgrade lifecycle actions; never reuse `save_succeeded` for upgrade.
- Permit upgrade only from saved, online, operation-free state.
- Block document mutations while upgrade is running with a visible accessible reason.
- Increment the shared document generation before upgrade and on cleanup.
- Guard save and upgrade success/failure/finally callbacks against generation drift.
- Preserve the local draft on conflicts, failures, stale responses, and unmount.
- Write RED tests for dirty/saving/offline/conflict gates, an edit attempted while upgrade is running, a late save after upgrade starts, stale responses after unmount, and success adopting v2 without consuming pending operation IDs.
- Commit only GREEN as: `fix: preserve drafts during timeline upgrade`

Corrective Task 2 — one v2 draft, two modes, one PlayerRef
- Add labelled Simple/Advanced controls for v2. Simple renders Scene Board plus the existing text/scene Inspector; Advanced renders assets, timeline, issues, and timeline Inspector.
- Both modes must read and mutate the same reducer draft, base, pending operations, history, conflict, and save state. Do not create a second document projection or store.
- Widen Scene Board/Inspector only to the smallest structural scene/text-clip shapes shared by v1 and v2.
- Create one PlayerRef in Studio, pass it to StudioPreview, and call the existing `usePlayerTimeline` hook.
- Player `frameupdate`/`seeked` update the playhead; play/pause update transient state; scrubbing calls `seekTo`; labelled controls call play/pause.
- Prove listener cleanup on unmount/ref/document replacement and no duplicate listeners.
- Prove a v2 unsaved text edit and timeline edit survive Simple → Advanced → Prompt Lab → Simple.
- Commit only GREEN as: `fix: synchronize timeline editor projections`

Corrective Task 3 — cumulative assets and selection-correct Inspector
- Make first-page load replace asset state and continuation pages merge/deduplicate by asset_id.
- Prove a first-page asset remains addable after a second page loads.
- Move add-clip operation construction into one small pure helper in timeline_domain.ts; keep UUID generation and dispatch at the UI boundary.
- Replace selection-derived defaultValue usage with controlled or selection-keyed values so clip B never shows clip A values.
- Keep approved-operation fields editable. Show fit/crop/position, overlay preset/parameters, caption style/cues, and audio fades as labelled read-only values because D1 defines no setter operations for them.
- Do not invent a new operation kind.
- Commit only GREEN as: `fix: retain timeline assets and inspector state`

Corrective Task 4 — preview fidelity and honest capability contract
- Add composition RED tests for video/image fit, crop, scale, position; trusted overlay parameters; trusted caption style/cue timing; audio fades; mute; and safe missing-source behavior.
- Implement with installed Remotion 4.0.523 primitives and CSS only. Compose bounded fade multipliers through the existing volume callback. Do not add @remotion/media.
- Keep preview sources transient and separate from EditDocument.
- Keep capability minting behind current_actor and keep the exact-path HttpOnly SameSite=Strict cookie as the sole media bearer credential.
- Remove the unenforced actor claim and optional actor verification path. Verify signature, expiry, project, and asset on every GET.
- Prove wrong scope, tampering, expiry, traversal, missing cookie, and secret/capability leakage fail safely.
- Do not expose the global API key to media elements, add a second cookie, use a URL token, or add a service worker/proxy service.
- Regenerate OpenAPI/TypeScript only if the public schema actually changes; require the second generation run to be byte-identical.
- Commit only GREEN as: `fix: align timeline preview contracts`

Corrective Task 5 — full offline verification and truthful audit
- Run every command in Task 5 of the corrective plan after the final product edit.
- Run the full dashboard suite three consecutive times without labelling a failure flaky unless root-caused.
- Run Python non-live/deployment/Ruff gates, generated-contract stability, build_cuda.bat, Scout acquisition/runtime, Compose config, security inspection, git diff check, and graphify update.
- Update the gitignored progress checkpoint and CHANGELOG.md. Record that original Task 8 was not RED-first and original Task 9 crossed its planned file boundary. Do not rewrite history to conceal either fact.
- Record exact RED/GREEN evidence, counts, warnings, limitations, and hard stops.
- Commit only CHANGELOG.md as: `docs: record timeline review corrections`

Required focused and final verification:
- Use the exact focused commands in Tasks 1–4 of the corrective plan.
- Final Python:
  `rtk uv sync --project python --frozen --all-groups --extra acquisition`
  `rtk uv run --project python pytest -m "not live" -q`
  `rtk uv run --project python pytest python/tests/deployment -q`
  `rtk uv run --project python ruff check python/src python/tests`
  `rtk uv run --project python ruff format --check python/src python/tests`
- Contracts:
  `rtk uv run --project python python python/scripts/export_openapi.py`
  from dashboard: `rtk bun run generate:control-plane-types`
  then require no generated diff after the second run.
- Dashboard:
  from dashboard run `rtk bun test` three times, then `rtk bun run lint` and `rtk bun run build`.
- Rust:
  `cmd /c ".\build_cuda.bat > build_log.txt 2>&1"`; require exit 0, inspect warnings, then remove only the task-created log.
- Scout:
  from scout run `rtk bun install --frozen-lockfile`, `rtk bun run test:acquisition`, and `rtk bun run test:runtime`.
- Compose:
  `docker compose -f compose.stage1.local.yml --env-file .env.stage1.local.example config --quiet`; if native Docker is unavailable, use WSL only for this read-only config command and report it.
- Final:
  `rtk git diff --check`, security rg commands from the plan, commit-format inspection, migration/dependency/service/operation-kind inspection, and `rtk graphify update .` with all indexes ignored and unstaged.

Preservation and security constraints:
- Migrations 0001–0004 remain byte-identical.
- The generated EditDocument and EditDocumentOperation public contracts remain canonical; no replacement JSON mutation endpoint.
- No raw artifact locator, capability, API key, path, stack trace, executable content, or secret enters documents, OpenAPI document models, dashboard state, logs, or public errors.
- Preserve C1/C2 Prompt Lab, version 1 editing, append-only revisions, optimistic conflicts, undo/redo, offline recovery, and Stage 1 code not owned by this correction.
- Preserve every operator-owned/untracked file exactly; stage only files owned by the current task.
- No new dependency, service, queue, process, migration, operation kind, state library, timeline library, or media package.

Hard stops — not authorized:
- No push, force-push, fetch/pull integration, PR, tag, release, package/image publication, or GitHub mutation.
- No deployment, image pull/build/run, service start/stop/restart, digest change, or migration against a running database.
- No real secret, provider env file, asset, fixture, artifact, or operator evidence access.
- No live provider, TikTok, CDN, browser, Scout, acquisition, Temporal, preview-media, or render request.
- No parity, controlled fallback, p1–p6 mutation, evidence/observation/aggregate/S3 mutation, Issue #5 update, acceptance/soak activation, D2, or render-queue work.
- Stop on the first unexpected post-GREEN failure or any need to expand scope. Report the exact blocker; do not weaken a test or silently narrow the contract.

Required final report in Indonesian:
1. Baseline/final full SHA, branch, upstream, ahead/behind, ancestor check, tracked/untracked state, and preserved operator items.
2. A finding-by-finding closure table for all Standards and Spec findings, with RED test, implementation location, and GREEN evidence.
3. Per-task commit table with one-line subjects and proof of empty bodies/no trailers.
4. Exact delivered behavior for upgrade, generation guards, Simple/Advanced, PlayerRef, pagination, operation helper, Inspector, preview semantics, and capability contract.
5. Focused and full verification table with actual pass/skip/fail counts, three dashboard runs, warnings, build_cuda, Scout, Compose, generated-contract stability, and git diff checks.
6. Security and scope inspection proving no capability/secret/locator/executable input leakage, no changed migration/dependency/service/operation kind, and no rewritten D1 commit.
7. Remaining limitations: single-owner bearer-capability model, read-only D1 fields without approved operations, and offline tests do not prove deployment or live media.
8. Exact prohibited actions not performed.
9. Next gate: independent Codex re-review before any push decision.
10. End exactly with:
D1 review corrections complete offline; Codex re-review required before push.
```
