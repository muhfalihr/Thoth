# Stage 1 Parity Browser Isolation Executor

Copy the following prompt into the executor task. Issuing it authorizes the local
implementation and isolated offline checks described below, not live activation.

```text
Implement Stage 1 Parity Browser Isolation in CLIPPER. Mode: IMPLEMENT_PLAN.

Read in this order:
1. Repository AGENTS.md and referenced instructions, CLAUDE.md, and BLUEPRINT.md.
2. docs/superpowers/specs/2026-09-07-stage1-parity-browser-isolation-design.md
3. docs/superpowers/plans/2026-09-07-stage1-parity-browser-isolation.md
4. docs/operations/stage1-parity-sampling.md and docs/operations/stage1-local-docker.md.
5. The runtime, Compose, Dockerfile, CI, and tests named by the active plan task.

Use superpowers:executing-plans, test-driven-development for runtime changes,
and verification-before-completion. Capture branch/HEAD/upstream/worktree first;
preserve all existing changes and inspect drift from 7ab6e04, never reset it.
Use task-sized local commits and review each task before advancing. Delegate
only if separately authorized. Chat in Indonesian; code/docs/commits in English.

Deliver all four plan tasks:
- One-shot reference entrypoint supervising ephemeral local Chromium and Scout.
- Standalone reference Compose and fail-closed host preflight.
- Real-image offline CDP/navigation/lifecycle/isolation tests and CI wiring.
- Updated operator runbooks and truthful offline status in BLUEPRINT.

Chosen design is option B, fresh anonymous tmpfs profile by default. The
reference child receives THOTH_CDP=http://127.0.0.1:18801 and cannot attach to
production CDP. Keep production Compose, relay, healthcheck, worker mode, and
acquisition policies unchanged. This isolates parity references, not the actual
legacy fallback path. Copying a live production profile/cookies is out of scope.

Authority: local source/docs/tests, local commits, candidate Docker build, and
isolated non-live tests using synthetic inputs. Use Docker only, RTK, and the
exact bun --cwd=scout syntax. Use WSL for Linux evidence without replacing the
Windows venv. Capture command exit codes; empty output alone is not success.

Hard stops: no push/publication/deployment/restart of production services; no
reading real .env, provider files, fixture values, browser profiles, or raw
operational evidence; no TikTok/provider requests; no fixture replacement,
cookie/login provisioning, parity retry, controlled fallback, observation edits,
S3 transfer, issue comments, soak start, rollback, Task 10, or default-mode change.
Do not recover or operate production to make a test pass. Use synthetic sentinel
services on internal Docker networks and clean up only resources your harness owns.

Preserve p2 as evidence_incomparable. Neither absence of missing_api_key markers
nor offline provider readiness proves authentication/quota/model health. Do not
claim every reference causes sidecar degradation: one incident established the
risk. Do not weaken nine-field parity or six per-side artifact integrity checks.

If the design is infeasible, report the concrete offline evidence and proposed
deviation before expanding scope. Authentication needs a separate operator gate,
not a copied profile. New reference code requires a newly built image; later
Python/reference live runs must use the same approved immutable release.

Finish with baseline/final commits, changed files, actual RED/GREEN results,
Linux image ID and smoke outcomes, review findings, remaining limitations, and
the next operator approval gate. Stop at offline implementation handoff.
```
