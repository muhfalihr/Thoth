# Creator Studio F1 Review Corrections Executor

```text
Mode: IMPLEMENT_REVIEW_CORRECTIONS — offline F1 corrective round

Repository:
- Windows path: C:\Users\mfr\Documents\MyTools\CLIPPER
- Expected branch: codex/stage1-container-ci
- Required product baseline: 610552bef00e1d623d26c0fa1465718027b0e6ce
- Upstream at review: origin/codex/stage1-container-ci, 8 ahead / 0 behind
- Planning baseline: 5edf56905b045c9b360ad4545ffc3dd5f30c4824
- Planning package commit: 1b55343f9c96ec7216cf50aaafa1811d5a4477cb

Objective:
Correct the material findings from the independent F1 implementation review. Keep
the existing architecture and scope. Make promotion bind to the exact document and
reference image, authenticate immutable golden sets, make manifest publication
failure-safe, normalize verifier failures into safe closed reports with deadlines,
clean resources on partial setup failure, and secure atomic staging writes. Generate
one NEW candidate after the fixes, perform one final whole-range review, and stop
for operator visual approval. The previous run `run_8ff83fb0fda36674` is superseded
for approval and must never be promoted.

Read completely, in order:
1. AGENTS.md
2. .superpowers/sdd/2026-09-23-creator-studio-f1-preview-render-parity/progress.md
3. docs/superpowers/specs/2026-09-23-creator-studio-preview-render-parity-design.md
4. docs/superpowers/plans/2026-09-23-creator-studio-preview-render-parity.md
5. docs/agent-prompts/creator-studio-preview-render-parity-executor.md
6. renderer/src/release-capsule.ts and its tests
7. renderer/src/artifact-root.ts and its tests
8. renderer/src/release-capture.tsx and its tests
9. renderer/src/release-compare.ts and its tests
10. renderer/src/template-release.ts and its tests
11. renderer/scripts/verify-template-release.ts
12. renderer/scripts/promote-template-release.ts
13. Dockerfile.renderer-f1 and Dockerfile.renderer
14. python/tests/deployment/test_container_contract.py

Required process:
- Invoke superpowers:using-superpowers, superpowers:receiving-code-review,
  superpowers:systematic-debugging, superpowers:test-driven-development, and
  superpowers:verification-before-completion.
- Use Ponytail at full intensity and the Karpathy guidelines. Trace the current flow
  before editing, reuse existing helpers, and make the smallest root-cause changes.
- Use Context7 for the Remotion 4.0.523 cancellation/deadline APIs before changing
  `renderStill()` or browser lifecycle code.
- Work finding-by-finding with focused RED -> minimal GREEN -> focused rerun.
- Make concise subject-only commits with no body, trailer, or attribution. Do not
  amend, squash, rebase, or rewrite the existing F1 commits.
- Run one whole-range Standards + Spec review only after every corrective task and
  mandatory gate has passed.

Preflight — fail closed:
1. Report branch, HEAD, upstream, ahead/behind, tracked/untracked status, and active
   merge/rebase state.
2. Require product baseline `610552bef00e1d623d26c0fa1465718027b0e6ce` to be an ancestor and prove
   both planning baseline and planning-package commit are ancestors. HEAD may be the
   product baseline or descend from it only by the docs-only corrective-prompt
   commit containing this file.
3. Inspect all drift since the product baseline. Stop on any product-code drift or
   any tracked change other than this corrective prompt before implementation.
4. `dashboard/src/features/studio/StudioPreview.tsx` may appear modified only when
   both `git diff --` and `git diff --cached --` are empty and its worktree blob is
   identical to HEAD. Treat that exact index/line-ending artifact as operator-owned
   and do not reset, stage, rewrite, or normalize it. Any real byte diff is a stop.
5. Preserve the existing candidate directory and every unrelated/operator-owned
   file. Do not reset, checkout, clean, stash, or delete anything.

Corrective Task 1 — bind a candidate to exact visual inputs:
- Add focused RED tests proving promotion refuses:
  a. a different but syntactically valid `THOTH_F1_IMAGE_ID`;
  b. a different but valid base digest or renderer version;
  c. a changed `document.json` whose template, canvas, assets, and frame list remain
     otherwise valid; and
  d. a missing/unknown promotion environment identity.
- Compute a stable SHA-256 of the exact validated `document.json` bytes and carry it
  as a safe synthetic field in `ReleaseCapsule` and `ReleaseReport.capsule`.
- Revalidate that document digest at promotion.
- Compare the report's complete `reference_image` exactly with the active promotion
  environment. Use a test-only environment seam; production reads the existing F1
  environment values. Format-only validation is insufficient.
- Keep the public report allowlisted and path-free. Do not add raw document content,
  environment values beyond the three approved identity fields, or arbitrary paths.

Completion criterion: all four mutations fail with `PromotionRefused`, leave the
tracked capsule byte-identical, and the valid same-document/same-image case passes.

Corrective Task 2 — authenticate immutable golden sets:
- Add focused RED tests proving `loadReleaseCapsule()` rejects:
  a. changed PNG bytes under an unchanged `sha256-*` set directory;
  b. an extra file in the active set;
  c. a linked file or linked set component; and
  d. a manifest whose declared files do not produce its content address.
- Centralize the existing golden-set address algorithm in the smallest shared helper
  used by promotion and loading; do not maintain two formulas.
- During load, enumerate the directory, require exactly the manifest-declared files,
  hash every regular link-free file, recompute the address, and require equality to
  `manifest.golden_set`.
- Keep golden directories immutable. Never repair, rename, or delete one while
  loading.

Completion criterion: byte mutation, extras, links, and address mismatch all fail
before comparison; a valid promoted set still loads.

Corrective Task 3 — make publication failure-safe:
- Add RED failure-injection tests around candidate copy, file sync, set-directory
  sync, manifest staging write/sync, and manifest rename.
- Reproduce the current bug explicitly: a failure after manifest publication must
  never leave the manifest pointing at a removed set.
- Preserve the current immutable-set design. Fully write and sync the new set first.
  Fully write and sync the staged manifest next. Make the atomic manifest rename the
  final fallible publication operation; after a successful rename, do not run
  cleanup that can remove the now-active set.
- Every failure before the rename must leave the previous manifest and all previous
  sets byte-identical. A successful rename is success, not rollback territory.
- Do not implement a whole-directory replacement or a second pointer mechanism.

Completion criterion: every injected pre-publication failure preserves the previous
active state; successful publication always points to a complete authenticated set.

Corrective Task 4 — close verifier failures and capture lifecycle:
- Add RED tests for failures from `bundle()`, `selectComposition()`, `openBrowser()`,
  page creation/navigation, screenshot/write, `renderStill()`, FFmpeg, and timeout.
- Add RED tests proving every partially initialized resource is closed: preview
  server, browser, page where applicable, render/preview temporary directories, and
  staged public directory.
- Add one bounded internal capture deadline and an `AbortSignal` flow. Pass the
  cancellation signal through setup and both surfaces; connect it to Remotion's
  supported cancellation mechanism. Add SIGINT/SIGTERM handling only in the thin
  verifier CLI and remove handlers on completion.
- Normalize expected capsule/contract failures to `contract_failed` and expected
  setup/browser/render/decode/write/timeout failures to `capture_failed`.
- Write a safe closed failure report whenever the allowlisted release identity and
  artifact root permit a run to be reserved. A pre-browser contract failure must not
  launch Chrome. Use a small non-promotable failure-report variant if full capsule
  fields are unavailable; do not fabricate composition or fixture facts.
- Promotion must reject every failure-report variant.
- Unknown programmer errors may still fail loudly in tests, but operational process,
  browser, filesystem, and decoder errors must not escape as raw payloads.

Completion criterion: each operational failure produces a bounded fixed verdict,
nonzero CLI exit, safe report when reservable, and zero live resources afterward.

Corrective Task 5 — secure atomic staging paths:
- Add RED tests with a pre-created symlink at `report.json.tmp` and at the manifest
  staging path, each pointing outside the authorized root. Prove the outside target
  remains byte-identical.
- Create staging files with exclusive-create semantics (`wx` or equivalent), write
  through the opened handle, sync and close it, then rename within the same trusted
  directory. Refuse unexpected existing nodes instead of following them.
- Recheck containment/link state at the operation boundary. Cleanup may unlink only
  the staging directory entry itself and may never follow it.
- Reuse one small atomic-file helper only if it removes duplicated security logic;
  do not add an abstraction for hypothetical future writers.

Completion criterion: neither report nor manifest staging can follow a link, escape
its authority, overwrite an existing node, or expose a partial final file.

Corrective Task 6 — fresh candidate, verification, and review:
- Run focused tests after each task, then at minimum:
  `bun --cwd=renderer test`
  `bun --cwd=renderer run typecheck`
  `uv run --project python pytest python/tests/deployment/test_container_contract.py -q`
  `uv run --project python ruff check python/src python/tests`
  `uv run --project python ruff format --check python/src python/tests`
  `cmd /c ".\build_cuda.bat > build_log.txt 2>&1"`
  `cargo test --bin thoth`
  `git diff --check`
- Rebuild the F1 reference image and production renderer image. Re-run the
  production-image exclusion probe, existing isolated renderer smoke, and positive
  plus negative no-egress checks.
- Generate exactly one NEW candidate under a fresh external
  `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` with `--network none`. Require five paired
  Player/renderStill RGBA comparisons at delta zero and overall `golden_missing`.
- Do not reuse or promote `run_8ff83fb0fda36674`. The final report must name the new
  run ID and new contact-sheet path.
- Run `graphify update .` after final code changes; never stage generated indexes.
- Perform one final two-axis review of `1b55343...HEAD`, explicitly rechecking every
  finding above. Fix material findings, rerun affected gates, and avoid a separate
  documentation-only review loop.
- Update only the ignored F1 checkpoint with the corrective commits, fresh evidence,
  superseded old run, new candidate, limitations, and next operator gate. Do not add
  a completed-work `CHANGELOG.md` entry.

Suggested commits (adjust file grouping only when required by TDD):
1. `fix: bind template release candidates`
2. `fix: harden template release publication`
3. `fix: close template capture failures`

Security and preservation boundaries:
- Continue using one allowlisted release, one shared composition/projection, one
  `RendererArtifactRoot`, and one configured artifact parent.
- Add no public API, database migration, workflow/queue, dependency, output-root
  setting, arbitrary render knob, provider, or live integration.
- Use only synthetic tracked fixtures and temporary test roots.
- Do not expose absolute paths, environment values, credentials, raw process/browser
  logs, stderr, exception payloads, or fixture contents in machine reports.
- Do not touch the production Stage 1 stack, real projects/assets, restricted
  evidence, provider files, or browser profiles.

Hard stops:
- No promotion of any run and no invocation of the promotion CLI against the tracked
  capsule.
- No `golden-manifest.json` or tracked `golden-sets/` creation.
- No operator visual-approval claim. AI inspection does not satisfy that gate.
- No `CHANGELOG.md` completed-work entry and no F1-complete status.
- No push, force-push, PR, tag, release, package/image publication, deployment,
  service start/stop/restart, or database migration.
- No live TikTok/provider/CDN/Scout/acquisition/Temporal request; no Stage 1
  parity/fallback, p1-p6 retry, evidence/observation mutation, Issue #5 mutation,
  acceptance/soak, Task 7, F2, F3, or Python Scout migration.

Required final report (Indonesian):
1. Initial/final branch, HEAD, upstream, ahead/behind, worktree, and drift verdict.
2. Finding-by-finding RED -> GREEN evidence with exact focused commands/counts.
3. Files and concise commits, including why each changed line belongs to a finding.
4. Exact document/reference-image binding evidence and mismatch mutations.
5. Golden-set address, extra/link rejection, and byte-mutation evidence.
6. Publication failure matrix proving no dangling manifest or deleted active set.
7. Capture failure/timeout verdicts and resource-cleanup evidence.
8. Staging-symlink/exclusive-write evidence.
9. Full final gate table, Docker image identities, and limitations.
10. Whole-range review findings/fixes.
11. New candidate run ID, private contact-sheet path, paired RGBA verdicts, and the
    explicit statement that operator visual approval is still pending.
12. Every hard-stop action not performed.

Final handoff:
`F1 corrected candidate ready for operator visual review; promotion and tracked
goldens remain unauthorized.`

Stop after the report.
```
