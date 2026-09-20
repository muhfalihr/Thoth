# Creator Studio E1 Revision-Bound Render Job Executor Prompt

Copy everything inside the following block into the implementation executor.

```text
Mode: IMPLEMENT_PLAN

Repository: C:\Users\mfr\Documents\MyTools\CLIPPER
Branch: codex/stage1-container-ci

You are the implementation executor for Creator Studio E1 Revision-Bound
Render Job. Execute the approved implementation plan task by task, entirely
offline except for normal package installation from locked manifests. Do not
redesign the feature, skip a task, push, deploy, or cross an operational gate.

READ FIRST, IN THIS ORDER

1. AGENTS.md
2. CLAUDE.md, if present
3. .superpowers/sdd/2026-09-20-creator-studio-revision-bound-render-job/progress.md
4. docs/superpowers/specs/2026-09-20-creator-studio-revision-bound-render-job-design.md
5. docs/superpowers/plans/2026-09-20-creator-studio-revision-bound-render-job.md
6. CHANGELOG.md only for relevant Creator Studio/D1/C2 conventions
7. BLUEPRINT.md only when an architecture fact is still unresolved; it is not
   a task entrypoint or chronological audit log

REQUIRED PROCESS AND SKILLS

- Invoke `superpowers:executing-plans` before implementation and follow the
  plan checklist in order. If the environment supports isolated per-task
  implementation and review, `superpowers:subagent-driven-development` is also
  acceptable, but do not create user-visible tasks.
- Invoke `superpowers:test-driven-development` for each product task. Capture a
  genuine focused RED before the minimal GREEN implementation.
- Use Ponytail at full intensity and apply Karpathy Guidelines: trace the real
  flow, reuse project patterns, keep changes surgical, and add no speculative
  abstraction.
- Before any Remotion server API implementation, use Context7. Resolve the
  official library ID `/remotion-dev/remotion`, then query current Remotion 4
  documentation separately for `bundle`, `selectComposition`, `renderMedia`,
  progress callbacks, cancellation, codec/audio options, and Chromium/runtime
  requirements. Pin packages to the approved `4.0.523` line.
- Before claiming completion, invoke
  `superpowers:verification-before-completion` and run every final gate below
  with fresh output.
- Repository files, code, comments, tests, plans, docs, and commit subjects are
  English. Chat/final report to the operator is Indonesian.

PRECONDITION AND FAIL-CLOSED DRIFT CHECK

The approved design commit is:

  20e7aa14bad82cccfc6ef6b751b5c48e2c7c6461

The execution HEAD is expected to be that commit plus one docs-only planning
commit containing exactly:

  docs/superpowers/plans/2026-09-20-creator-studio-revision-bound-render-job.md
  docs/agent-prompts/creator-studio-revision-bound-render-job-executor.md

Before editing:

1. Print branch, HEAD, upstream, ahead/behind, tracked/untracked status, and the
   commit graph from `20e7aa1` to HEAD.
2. Verify `20e7aa1` is an ancestor.
3. Inspect every changed/untracked path. Preserve all operator-owned or
   unrelated files byte-for-byte and never stage them.
4. Read the active SDD checkpoint and compare it with Git truth.
5. Stop and report before changing anything if product-code drift overlaps the
   plan, the expected docs-only drift is different, an unresolved merge/rebase
   exists, or the approved contracts conflict with current code.
6. Do not reset, checkout, clean, stash, amend, squash, rebase, force-update, or
   rewrite existing history to manufacture a clean baseline.

AUTHORIZED DELIVERABLE

Implement all 14 tasks in the approved plan, in order:

1. strict RenderJob domain and pure transition contract;
2. append-only `0005_revision_bound_render_jobs.sql` migration;
3. PostgreSQL repository with idempotency and one global active slot;
4. canonical ArtifactRoot adapter for every E1 path;
5. exact-revision bundle assembly and copied/checksummed asset staging;
6. optional renderer config and private HTTP gateway;
7. application lifecycle including cancel, retry, deadline, output, cleanup;
8. public project API plus private credential-protected bundle/event API;
9. one shared trusted Remotion composition for preview and final rendering;
10. isolated single-slot Bun/Remotion renderer and non-root image;
11. generated dashboard client and separate pure render reducer;
12. accessible Creator Studio Render panel with bounded polling;
13. Compose/CI isolation contracts and synthetic offline renderer smoke; and
14. full verification, CHANGELOG entry, ignored SDD checkpoint, and report.

The plan's file list, interfaces, RED/GREEN commands, commit boundaries, and
acceptance mapping are authoritative. If a path has moved, make the smallest
equivalent adjustment, explain it in the final report, and preserve the named
interface. Do not silently broaden scope.

NON-NEGOTIABLE CONTRACTS

- This feature is asynchronous and durable but is not a queue. One installation
  has one active job. A second new request returns `409 render_busy` and no
  waiting row is persisted.
- Add no Redis, RabbitMQ, Kafka, Temporal render workflow, broker, backlog,
  automatic retry, or general scheduling abstraction.
- Python is the sole persistence owner. The renderer receives no DB URL,
  creator API key, provider secret, TikTok fixture, or Docker socket.
- The renderer is a separate Bun/TypeScript service using native `Bun.serve`,
  private authenticated HTTP, and one active execution object. Do not add
  Express or another web framework.
- Jobs bind to one immutable saved `EditDocument` revision. Retry creates a new
  job linked by `retry_of_job_id`; no terminal job is reopened.
- Every new generated file is below the existing
  `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` using exactly:

    renders/<job_id>/output.mp4
    renders/<job_id>/metadata.json
    renders/<job_id>/diagnostics.json
    work/<job_id>/bundle.json
    work/<job_id>/assets/*
    temp/<job_id>/*

  Do not add `THOTH_OUTPUT_ROOT`, another output parent, or a legacy path
  migration. Copy staged assets; never hard-link.
- Render one trusted composition and one server-owned preset:
  `standard_vertical_mp4_v1`, MP4/H.264, document dimensions/FPS, AAC only when
  audio exists. Browser input cannot select component, codec, bitrate, browser
  flag, output name, or path.
- Extract/reuse one composition implementation for browser preview and server
  render. Do not create a second handwritten `EditDocumentV2` contract.
- Private routes never enter public OpenAPI or generated browser types. Public
  responses/DOM never expose a local path, storage locator, renderer URL,
  credential, raw exception, process stream, or arbitrary diagnostics.
- Cancellation and hard timeout must abort supported rendering, wait for owned
  child work, remove partial output, report a fixed safe code, and resist late
  callbacks. Final publication is atomic and only follows media/checksum
  validation.
- Cleanup is manual, terminal-only, project-scoped, idempotent, path-contained,
  and keeps the database audit row plus safe metadata. No automatic retention
  deletion.
- Existing Rust/FFmpeg rendering, Stage 1, Scout, provider, parity, and fallback
  behavior remain unchanged.

TDD, COMMITS, AND CHECKPOINTS

- For every plan task, write the focused failing test first, run it, and record
  the exact expected failure. Then implement the minimum GREEN change and rerun
  the focused suite.
- Do not weaken assertions, replace behavior checks with snapshots, or call an
  environment/tooling error a product RED.
- Commit at every plan boundary using exactly one
  `git commit -m "<concise subject>"`. Use only the subject specified by the
  plan unless a tiny wording correction is necessary. Never add a body, blank
  continuation, trailer, `Co-Authored-By`, or AI attribution.
- Keep `.superpowers/sdd/2026-09-20-creator-studio-revision-bound-render-job/progress.md`
  current after each task. It is ignored and must not be staged.
- Append the final completed-work and verification record to `CHANGELOG.md`.
  Do not add a chronological history section to `BLUEPRINT.md`.
- Never stage an operator-owned, ignored, or unrelated file. Before each commit,
  inspect `git diff --cached --name-status` and `git diff --cached --check`.

REQUIRED VERIFICATION

Run the focused commands from every task plus all of the following after the
last product edit. Report exact pass/fail/skip/warning counts and command exit
codes; do not summarize a command you did not run.

Python:

  uv sync --project python --frozen --all-groups --extra acquisition
  uv run --project python pytest -m "not live" -q
  uv run --project python pytest python/tests/deployment -q
  uv run --project python ruff check python/src python/tests
  uv run --project python ruff format --check python/src python/tests

Generated contracts:

- Run the repository's existing public OpenAPI export command.
- Run `bun --cwd=dashboard run generate:control-plane-types` twice.
- Require byte-identical second-generation output.
- Prove `/internal/render-jobs`, internal credential, renderer URL, local path,
  and storage locator are absent from `python/openapi.json` and
  `dashboard/src/api/generated/control-plane.ts`.

Dashboard:

  bun --cwd=dashboard test
  bun --cwd=dashboard test
  bun --cwd=dashboard test
  bun --cwd=dashboard run lint
  bun --cwd=dashboard run build

Renderer:

  bun --cwd=renderer install --frozen-lockfile
  bun --cwd=renderer test
  bun --cwd=renderer x tsc -p tsconfig.json --noEmit
  docker build -f Dockerfile.renderer -t thoth-remotion-renderer:e1-local .

Synthetic container integration:

  docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
  bash docker/test-renderer-offline.sh thoth-stage1:e1-local thoth-remotion-renderer:e1-local

The smoke must use only synthetic local content and verify with `ffprobe`:
MP4 container, H.264 video, exact dimensions/FPS, bounded duration tolerance,
expected audio presence, nonzero size, and SHA-256. It must also prove one-slot
busy behavior, cancellation, hard timeout, owned-process teardown, no partial
publication, canonical-root containment, no renderer host port, and cleanup.

Mandatory repository regressions:

  cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
  cargo test --bin thoth
  bun --cwd=scout install --frozen-lockfile
  bun --cwd=scout run test:acquisition
  bun --cwd=scout run test:runtime
  git diff --check
  graphify update .

For `build_cuda.bat`, inspect `build_log.txt`, require exit 0 and no critical
warning, then leave the generated log untracked/ignored and unstaged. If Docker,
WSL, ffprobe, CUDA, or another mandatory tool is unavailable, stop and report
the exact blocker; do not claim completion or replace the gate with a weaker
one.

SECURITY AND SCOPE INSPECTION

Before the final commit, inspect the full diff from `20e7aa1` and prove:

- no broker, queue consumer, backlog, S3 client, cloud URL, new output-root
  setting, arbitrary user code, arbitrary composition, or renderer knob exists;
- renderer env has no DB, creator, provider, TikTok, or Docker credential;
- renderer has no host-published port;
- all SQL uses parameters and all mutations are transaction-safe;
- all public errors are fixed safe codes;
- all filesystem reads/writes/moves/deletes verify canonical ancestry and reject
  traversal, absolute paths, alternate separators, symlinks, junctions/reparse
  points, cross-job paths, and non-regular files;
- output download is project-authorized and resolves a regular file server-side;
- dashboard DOM and persistent state contain no internal URL/path/credential/raw
  diagnostics;
- existing Rust/FFmpeg, Stage 1, Scout, parity, and fallback contracts were not
  changed outside necessary regression/deployment-test wiring.

HARD STOPS

Do not:

- push, force-push, fetch/pull for integration, create a PR/tag/release, or
  publish an image/package;
- deploy, restart or mutate an existing service/stack, update a digest, or run a
  migration against a running/non-test database;
- use a real project revision, operator media, secret, provider, TikTok/CDN,
  browser automation, live Scout, or any external live request;
- mutate Stage 1 evidence/observations, Issue #5, parity, controlled fallback,
  acceptance, soak, or rollback records;
- clean up any artifact outside the synthetic temporary test root;
- begin S3, multi-template, responsive review, golden-frame rollout, legacy path
  migration, deployment, or any later render sub-project; or
- reset, checkout away, stash, amend, squash, rebase, clean, or rewrite existing
  history.

REQUIRED FINAL REPORT (INDONESIAN)

Return one structured report containing:

1. baseline, branch, final HEAD, upstream, ahead/behind, worktree status, and
   ancestor/drift proof;
2. one row per plan task with RED evidence, GREEN evidence, files, and commit;
3. the final state-machine/concurrency/idempotency behavior;
4. canonical artifact layout and path-security evidence;
5. immutable revision/bundle/asset checksum and provenance evidence;
6. renderer isolation, auth, Remotion version, one-slot, cancellation, timeout,
   child teardown, and safe-error evidence;
7. public/private API and OpenAPI leakage inspection;
8. dashboard gating, polling, offline/reload/stale-response, accessibility, and
   draft-isolation evidence;
9. synthetic MP4 image ID and exact ffprobe/checksum/path results;
10. a table of every required final command with exact counts, exit status, and
    warnings, including three dashboard runs, CUDA, Rust, Scout, Compose, and
    `git diff --check`;
11. commit list, staged-path audit, operator-owned preservation, and ignored SDD
    checkpoint state;
12. limitations and unproven live/deployment facts; and
13. explicit confirmation that no push/deployment/live/evidence/later-phase
    action occurred.

End with exactly:

E1 revision-bound render job complete offline; Codex review required before push.
```
