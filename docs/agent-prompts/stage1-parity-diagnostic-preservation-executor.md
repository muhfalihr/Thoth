# Stage 1 Parity Diagnostic Preservation — Executor Prompt

Copy the fenced block into the implementation executor. This authorizes offline
implementation only and stops before push, publication, deployment, or p5.

```text
Mode: IMPLEMENT_PLAN

Repository:
- Windows: C:\Users\mfr\Documents\MyTools\CLIPPER
- WSL: /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
- Expected branch: codex/stage1-container-ci

Objective:
Implement the approved Stage 1 parity diagnostic-preservation corrective round.
Preserve safe structured Scout failure signals into the atomic reference attempt
record and add a no-enumeration offline summary command. Stop after offline
verification and local commits for independent review.

Read completely in this order:
1. `CLAUDE.md`
2. `AGENTS.md` and every instruction it references
3. `BLUEPRINT.md`
4. `docs/superpowers/specs/2026-09-08-stage1-parity-diagnostic-preservation-design.md`
5. `docs/superpowers/plans/2026-09-08-stage1-parity-diagnostic-preservation.md`
6. `docs/operations/stage1-parity-sampling.md`
7. `docs/superpowers/specs/2026-09-07-stage1-parity-browser-isolation-design.md`
8. `docs/agent-prompts/stage1-p4-checkpoint-offline-diagnosis-executor.md`
9. The relevant source and tests named by the implementation plan

Baseline and drift gate:
- Capture branch, HEAD, upstream, ahead/behind state, and worktree state.
- Require `c1db5dd6f48db4aefe14d3b1e9b79513f63c15d5` to be an ancestor of HEAD.
- Inspect and report every commit and changed path after that baseline.
- The expected drift is documentation for this corrective round. Do not reset,
  rebase, clean, discard, or overwrite unrelated work.
- If the worktree is dirty or drift changes runtime contracts beyond the approved
  spec, stop before editing and report the conflict.

Required process:
- Use `superpowers:test-driven-development` for every behavior change.
- Use `superpowers:systematic-debugging` for any unexpected failure.
- Execute the written plan task by task using `superpowers:executing-plans`.
- Use `superpowers:verification-before-completion` before the final report.
- Do not delegate inspection of operator evidence or secrets. This task does not
  require reading either.
- Chat report to the operator must be Indonesian. Repository artifacts, code,
  comments, tests, docs, and commit subjects remain English.

Authorized deliverables:
1. Strict safe diagnostic formatter/parser and tests.
2. Distinct profile-discovery exception versus empty-result signals, preserving
   current candidate behavior.
3. A terminal `trace_source` failure event that does not promote an earlier signal
   into a claimed root cause.
4. Additive, atomic attempt-record fields for validated diagnostic events.
5. A Python attempt-summary CLI that opens only the known attempt record and emits
   safe booleans/counts/enums without directory enumeration or raw logs.
6. Runbook, BLUEPRINT, and contract-test updates required by the approved design.
7. Concise local commits and full offline verification.

Implementation invariants:
- Use exactly the diagnostic schema and combination table in the approved spec.
- Diagnostic frames contain no free-form value. Never pass a caught error, URL,
  handle, caption, path, HTTP response, model, provider, identifier, or secret to
  the diagnostic sink or attempt record.
- Preserve both current `return []` branches in TikTok profile discovery.
- Preserve existing exit-code precedence, cleanup behavior, browser isolation,
  reference logs, artifact checks, and parity classification.
- The required-stage terminal event uses category `unknown`. An earlier discovery
  signal is evidence, not proof that discovery caused the terminal failure.
- Pending attempt records remain unchanged. Complete current records add
  `diagnostics_valid` and `diagnostic_events`. Missing fields in old records mean
  `diagnostic_contract=legacy`; never migrate or amend p1-p4.
- Parser limits: at most 1 MiB input, at most 32 frames, exact four-key objects,
  exact allowlisted combinations, no duplicates. Invalid input returns no events.
- The Python summary validates and reads one contained known path. It never walks
  the sample directory and never opens raw logs, reports, fixtures, or media.
- Tests must prove that URL, filesystem-path, post-ID, credential, filename, and
  raw-error canaries cannot reach command output or structured attempt evidence.
- Add no dependency unless the approved interfaces are impossible with the
  standard libraries; if that occurs, stop and request review.

Commit rules:
- Create local commits only; no push.
- Each commit uses exactly one concise subject line, preferably at most 72 chars.
- Use exactly `git commit -m "<subject>"`.
- Do not add a body, detailed description, blank continuation, trailer,
  `Co-Authored-By`, Claude attribution, or Anthropic attribution.
- Recommended subjects are the four subjects in the plan. Adjust only when the
  actual task boundary differs, while retaining the one-line rule.

Verification:
1. Record RED and GREEN evidence for every new targeted test.
2. Run:
   - `rtk bun run test:runtime`
   - `rtk bun run test:acquisition`
   - `rtk bun run typecheck`
   - `rtk uv run --project python python -m pytest python/tests/deployment -q`
   - `rtk uv run --project python ruff check python/src python/tests`
   - `rtk uv run --project python ruff format --check python/src python/tests`
   - `rtk git diff --check`
3. From Windows PowerShell, run the exact project-required CUDA build:
   `rtk proxy cmd /c build_cuda.bat`
4. From WSL with Docker, build a local Linux candidate and run only non-live checks:
   - `rtk docker build --platform linux/amd64 --tag thoth-stage1:diagnostic-corrective .`
   - `rtk docker run --rm --network none --entrypoint /opt/thoth/python/.venv/bin/python thoth-stage1:diagnostic-corrective -m thoth_control_plane.operations.stage1_parity_attempt_summary --help`
   - `rtk bash docker/test-parity-offline.sh thoth-stage1:diagnostic-corrective`
5. If a required tool is unavailable or a gate fails for an environmental reason,
   record the exact safe failure and stop. Do not convert it into a pass or silently
   skip it.

Hard stops — not authorized:
- Do not read, list, hash, copy, chmod, rename, delete, or mutate real p1-p4 evidence,
  pairing records, fixtures, logs, reports, observations, backups, or secrets.
- No TikTok, CDN, provider, browser acquisition, Scout live run, Python acquisition,
  HTTP probe, Temporal query/start/retry/cancel, p3/p4 retry, replacement fixture,
  p5, cookie/profile seeding, authentication workaround, or provider change.
- No GitHub Issue mutation, push, publication, deployment, pull into the active
  stack, service restart/recreate/stop, controlled fallback, acceptance-window
  activation, soak collection/evaluation, S3 operation, rollback, cutover,
  Python-only default, Scout removal, or Task 10.
- Docker use is limited to the local candidate build and the existing internal,
  non-live offline smoke named above. Do not inspect or operate the deployed stack.

Required final report in Indonesian:
1. Baseline/final branch, HEAD, upstream, drift, and worktree state.
2. Files changed and contract delivered for each implementation-plan task.
3. RED-to-GREEN evidence with test names and actual counts.
4. Diagnostic schema and explicit proof that no free-form data enters it.
5. Proof that discovery exception, empty result, and terminal stage remain distinct.
6. Proof that lifecycle exit/cleanup and parity semantics are unchanged.
7. Python summary output schema and canary-containment results.
8. Full gate results, CUDA build result, candidate image identity, and offline smoke.
9. Local commits, each one-line subject, and confirmation of no trailer/attribution.
10. Limitations and the exact next operator gate.
11. Explicit list of actions not performed.

Stop after the verified local implementation and independent-review handoff.
Do not prepare or execute p5. Do not push or deploy.
```
