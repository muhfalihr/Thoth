# Stage 1 Scout Runtime Corrective Executor

```text
Implement the Stage 1 Scout Runtime Corrective plan in repository CLIPPER.
Mode: IMPLEMENT_PLAN. This handoff authorizes local implementation and isolated offline validation.

Read, in order:
1. AGENTS.md if present and its referenced instructions; otherwise the project instructions
   supplied in this task. Read CLAUDE.md and BLUEPRINT.md for repository conventions.
2. docs/superpowers/specs/2026-09-06-stage1-scout-runtime-corrective-design.md
3. docs/superpowers/plans/2026-09-06-stage1-scout-runtime-corrective.md
4. docs/operations/stage1-local-docker.md and docs/operations/stage1-parity-sampling.md
5. The implementation and tests referenced by the active task.

Use superpowers:executing-plans and work task-by-task. Use RED/GREEN tests for runtime changes,
superpowers:verification-before-completion for completion claims, and independent review before
the final handoff. Preserve all pre-existing edits, especially the parity runbook corrections.
Capture actual branch, HEAD, upstream, and worktree status. The documented baseline is
671a18060308e1ef84429d98bf3ae64f6e9f1cc9; inspect drift rather than assuming the checkout is identical.

Deliver the five planned tasks:
- Lock gallery-dl 1.32.11 for the existing image/gallery policy and yt-dlp 2026.8.19 for existing
  video/probe consumers. Prove installed executables under the image's non-root user.
- Add the private in-sidecar Bun relay and Chromium supervision. Prove HTTP discovery and both
  browser/page WebSockets from a sibling container, including the real Scout client.
- Add the restricted Novita provider-file validator and worker-only Compose override. Use the
  same configuration for references and fallback worker; only synthetic credentials in tests.
- Run isolated real-image tests with about:blank on an internal Docker network, and wire them
  into PR and published-digest CI. Existing infrastructure smoke must continue to pass.
- Update operations docs and record the future new-window activation procedure accurately.

Keep Python TikTok headless-first with CDN fallback. Do not change image acquisition to yt-dlp,
extend Python platform scope, change parity fields, or relax cleanup/OCR/health/retirement gates.
Do not equate missing yt-dlp with guaranteed failure on every direct-CDN branch.

The existing production stack must remain untouched. Do not read real .env, key, fixture, or
observation files. Do not start the default TikTok launcher, send provider requests, acquire live
references, update observations, upload S3, redeploy, restart production services, or change its
digest/configuration. No push, image publication, rollback drill, human cutover approval, or Task 10.
Local builds and task-owned offline browser/probe containers are authorized. Bound startup and
teardown, and remove only the isolated resources your test created.

Use Docker. Run Linux checks in WSL without modifying the Windows venv. Follow RTK instructions;
if RTK is unavailable, report the failed availability check and use underlying commands. Preserve
the exact bun --cwd=scout form. Inspect actual outputs rather than treating empty output as PASS.

Keep credentials and browser payloads out of logs. Service-level env_file resolution is separate
from interpolation: config --no-interpolate alone is not a safe diagnostic. Use config --quiet or
verified non-resolving views. Provider key presence is not proof of authentication, quota, or model
availability. Adding credentials changes runtime configuration, not the OCI image digest.

If a planned API is unsupported, prove it with a bounded offline test, record a focused deviation,
and preserve the spec's contracts. Do not solve transport by publishing CDP to the host, sharing
the worker network namespace, removing the browser sandbox, or bypassing authentication walls.

Finish with baseline/final commits, per-task results, actual RED/GREEN and Linux-image evidence,
review verdicts, unresolved issues, and the next operator checkpoint. State explicitly that the
old window evidence is preserved and new-image deployment will use a separate evaluation window.
Do not claim offline verification proves live fallback, parity, or operational readiness.
```
