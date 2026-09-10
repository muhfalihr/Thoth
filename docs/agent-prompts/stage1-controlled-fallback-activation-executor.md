# Stage 1 Controlled Fallback Activation — Offline Executor Prompt

Copy the fenced block below into the executor agent unchanged.

```text
Mode: IMPLEMENT_PLAN

Repository: C:\Users\mfr\Documents\MyTools\CLIPPER
Branch: codex/stage1-container-ci
Execution environment: Windows repository with Docker available only through WSL.

Objective

Implement the offline Stage 1 controlled fallback activation harness exactly as specified. This
round creates and verifies the operator tooling only. It does not run the real f1 gate.

Read these documents completely, in this order:

1. AGENTS.md
2. CLAUDE.md
3. docs/superpowers/specs/2026-09-10-stage1-controlled-fallback-activation-design.md
4. docs/superpowers/plans/2026-09-10-stage1-controlled-fallback-activation.md
5. docs/operations/stage1-local-docker.md
6. docs/operations/stage1-parity-sampling.md
7. docs/superpowers/specs/2026-09-09-stage1-legacy-fallback-target-isolation-design.md

Baseline and drift gate

- The deployed acquisition implementation is
  c61f5789c1ad702b11b025b6ce99a5ba7afef9ff.
- The deployed digest is
  ghcr.io/muhfalihr/thoth@sha256:0bc3d00cace0244d5d91ef7caa66151ab1f59222bef29ad686d9b942d2400d6e.
- The written design commit 3b4c4fc67c399585a4c2f24ddb32ffcdda9e7196 must be an ancestor of
  the current HEAD.
- Record branch, HEAD, upstream, ahead/behind, worktree state, and every commit/diff since c61f578
  before editing.
- Preserve unrelated user changes. Stop if the worktree contains an overlapping modification.
- Do not reset, rebase, clean, force checkout, or discard any existing work.

Required process

- Use the Ponytail plugin in full mode for repository navigation, implementation, debugging, and
  review.
- Use Context7 for any external library, framework, Docker Compose, Pydantic, Typer, or subprocess
  API reference. If Context7 is unavailable, use primary documentation and state that limitation.
- Use superpowers:executing-plans and execute the plan task by task.
- Use strict RED -> GREEN TDD for every behavioral change. Record the failing test and the passing
  result; do not manufacture RED by breaking unrelated code.
- Use Docker, never Podman.
- Use apply_patch for source and documentation edits.
- Keep every commit to one concise subject line with no body and no Co-Authored-By trailer.

Authorized deliverables

Implement all five tasks in
docs/superpowers/plans/2026-09-10-stage1-controlled-fallback-activation.md:

1. reusable one-sided Scout artifact measurement and validation;
2. fail-closed f1 preflight, fixed result models, atomic reservation/finalization, private integrity
   record, and append-only index;
3. deterministic shell-free Docker orchestration plus guarded CLI commands;
4. production Compose overlay, isolated offline smoke overlay/harness, container contracts, and CI
   non-live integration; and
5. runbook, architecture documentation, BLUEPRINT audit trail, and full verification.

Implement the written interfaces and names exactly unless the existing code proves one impossible.
If an interface must change, stop and report the concrete contradiction before continuing.

Security and preservation boundaries

- Treat all real fixture, evidence, provider, environment, and Docker deployment data as out of
  scope.
- Do not open, compare, hash, stat, copy, stage, or print:
  - /home/mfr/thoth-stage1-fallback/f1/url.txt;
  - any p1-p6 fixture;
  - the provider environment file;
  - restricted parity/fallback evidence.
- Do not invoke stage1-controlled-fallback-run with real arguments.
- Do not contact TikTok, CDN endpoints, model providers, or any other live fixture endpoint.
- Do not run a workflow, retry p6, create a parity sample, or mutate evidence/observations/reports.
- Do not inspect, pull for, restart, stop, recreate, or deploy the project named
  thoth-stage1-local. Do not modify .env.stage1.local.
- Do not mutate S3, Temporal state, GitHub Issue #5, or acceptance records.
- Do not open an acceptance window, run controlled fallback live, perform rollback, cut over,
  disable Scout, or enter Task 10.
- Offline Docker tests must use unique test-owned project names, internal networks, synthetic
  about:blank pages, and trap-based bounded teardown. They must leave no container, network,
  volume, profile, fixture copy, or temporary directory.
- No host port, privileged container, Docker socket mount, deployment artifact root, or production
  browser profile may appear in the gate service.
- Console and safe JSON output may contain fixed booleans, counts, enum verdicts, and status codes
  only. Keep URLs, target IDs, WebSocket URLs, provider/model values, credentials, checksums,
  filesystem paths, container IDs, raw exceptions, and raw child output out of safe output.

Environment hygiene

- Keep the Windows project venv at python/.venv a Windows venv.
- Every WSL Python command must set:
  UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv"
- Do not let WSL uv create or replace python/.venv inside the repository.
- Build and Docker harness commands run through WSL from
  /mnt/c/Users/mfr/Documents/MyTools/CLIPPER.

Required verification

Run every focused RED/GREEN command from the plan, then run:

Windows:

- scout: bun run test:runtime
- scout: bun run test:acquisition
- scout: bun run typecheck
- python: uv run python -m pytest -q
- python: uv run ruff check .
- python: uv run ruff format --check .
- repository: git diff --check

WSL/Linux:

- POSIX controlled-fallback tests using the external UV_PROJECT_ENVIRONMENT.
- docker build --platform linux/amd64 --tag thoth-stage1:controlled-fallback-corrective .
- bash docker/test-controlled-fallback-offline.sh thoth-stage1:controlled-fallback-corrective
- bash docker/test-cdp-offline.sh thoth-stage1:controlled-fallback-corrective
- bash docker/test-parity-offline.sh thoth-stage1:controlled-fallback-corrective

For the Docker harnesses, report every fixed boolean and verify no test-owned resource survives.
An intermittent failure is not silently retried: retain and report the first result, diagnose it,
then ask for direction if the plan does not already define the correction.

Hard stops

- Stop on any unexpected live/network request, secret/fixture exposure, deployment-project match,
  dirty overlapping file, evidence path access, or teardown failure.
- Stop if the implementation would require changing the deployed image or current stack to verify
  it.
- Stop if a test repeatedly fails for the same unresolved reason; report the evidence instead of
  weakening the contract.
- Stop after local offline commits and final verification. Do not push or create a PR.

Final report format

Report in Indonesian with:

1. baseline branch, initial/final HEAD, upstream drift, and worktree state;
2. one row per plan task listing changed files, RED evidence, GREEN evidence, and commit;
3. exact Windows and WSL test counts/exit codes;
4. local image tag/ID/platform/user and every Docker harness boolean;
5. proof that the deployed project, .env.stage1.local, fixtures, provider file, evidence, S3,
   Temporal, and Issue #5 were untouched;
6. security/privacy review results and any residual exposure;
7. limitations, especially that offline success does not prove Python-to-fallback routing or live
   f1 success;
8. confirmation that commit messages are one-line and contain no Co-Authored-By; and
9. the next operator checkpoint.

End the report with exactly:

controlled fallback activation tooling implemented offline; ready for independent review; no live f1, deployment, evidence mutation, or acceptance window entered
```
