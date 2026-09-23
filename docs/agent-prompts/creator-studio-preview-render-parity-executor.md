# Creator Studio F1 Preview/Render Parity Executor

```text
Mode: IMPLEMENT_PLAN — F1 implementation through operator visual-approval checkpoint

Repository:
- Windows path: C:\Users\mfr\Documents\MyTools\CLIPPER
- Expected branch: codex/stage1-container-ci
- Planning baseline: 5edf56905b045c9b360ad4545ffc3dd5f30c4824

Objective:
Implement Creator Studio F1 preview/render parity through Tasks 1–6 of the approved
plan. Build the strict synthetic capsule, shared production preview seam,
digest-pinned offline Linux/amd64 reference image, paired captures, canonical-RGBA
comparison, immutable-set promotion mechanism, and CI contract. Generate the initial
candidate and contact sheet, perform one whole-branch review, then STOP for explicit
operator visual approval. Do not invoke promotion or create tracked goldens in this
run.

Read completely, in order:
1. AGENTS.md
2. .superpowers/sdd/2026-09-23-creator-studio-f1-preview-render-parity/progress.md
3. docs/superpowers/specs/2026-09-11-ui-first-creator-studio-design.md
4. docs/superpowers/specs/2026-09-20-creator-studio-revision-bound-render-job-design.md
5. docs/superpowers/specs/2026-09-23-creator-studio-preview-render-parity-design.md
6. docs/superpowers/plans/2026-09-23-creator-studio-preview-render-parity.md
7. renderer/src/artifact-root.ts and its tests
8. renderer/src/remotion-adapter.ts and renderer/src/contracts.ts
9. packages/remotion-composition/src/AdvancedTimelineComposition.tsx
10. packages/remotion-composition/src/register.tsx
11. dashboard/src/features/studio/preview.ts
12. dashboard/src/features/studio/StudioPreview.tsx
13. Dockerfile.renderer and .dockerignore
14. .github/workflows/container-image.yml

Required process:
- Invoke superpowers:using-superpowers, superpowers:executing-plans or
  superpowers:subagent-driven-development, superpowers:test-driven-development, and
  superpowers:verification-before-completion.
- Use Ponytail at full intensity and the Karpathy guidelines. Trace existing flows,
  prefer existing modules and dependencies, make the smallest root-cause change,
  and keep one runnable check for non-trivial logic.
- Use Context7 for current Remotion 4.0.523 API details before implementing Player,
  renderStill, browser, or render-delay behavior.
- Follow Tasks 1–6 exactly. Capture focused RED before implementation, then minimal
  GREEN and focused rerun. Make the concise subject-only commits named by the plan.
- Perform one whole-branch review only after Task 6 candidate generation. Do not
  stop for intermediate documentation review.

Preflight — fail closed:
1. Report branch, HEAD, upstream, ahead/behind, tracked/untracked status, and whether
   planning baseline is an ancestor.
2. Read the active checkpoint and compare its recorded baseline/current state.
3. Inspect every commit and diff since the planning baseline. Preserve all
   operator-owned and unrelated files byte-for-byte.
4. Stop before edits on overlapping product-code drift, a conflicting contract,
   an in-progress merge/rebase, or a dirty task-owned file not explained by the
   checkpoint. Do not reset, checkout, clean, stash, rebase, or discard anything.

Authorized deliverables:
- Complete plan Tasks 1–6 only.
- Keep one allowlisted release identity: vertical_text_story-v1.
- Extend RendererArtifactRoot as the sole generated-path authority. Do not create a
  release-artifacts module or pass raw artifact-root strings to the verifier.
- Derive the capsule from the canonical repository release root. No function or CLI
  may accept an arbitrary capsule path, golden path, or output root.
- Extract/reuse the production StudioPreview projection/configuration so the real
  dashboard, parity Player, and renderer share effective props and geometry. Add a
  wiring test; do not build a test-only prop mapper.
- Add synthetic, license-safe release.json, document, and local image/video/audio
  fixtures for vertical_text_story version 1.
- Reuse repository Poppins Regular/Bold bytes. Use FontFace plus Remotion
  delayRender/continueRender/cancelRender so both surfaces wait for fonts.
- Add paired controls-free Player and renderStill capture at the selected frames.
- Decode PNGs through FFmpeg to canonical raw RGBA. Exact RGBA equality is the only
  pass path; PNG SHA-256 is diagnostic only. Any changed pixel must be non-pass.
- Add fixed safe verdicts, bounded reports, diffs, and a contact sheet.
- Implement immutable content-addressed golden sets and atomic replacement of only
  golden-manifest.json, with failure-injection tests against temporary roots.
  Implement the mechanism but DO NOT invoke it against the tracked capsule.
- Add a digest-pinned, build-identified linux/amd64 F1 reference image. Resolve and
  record the immutable oven/bun:1.3.14 base digest; a tag-only base is not allowed.
  Registry metadata and locked dependency/browser retrieval needed to build this
  test image are allowed. Do not publish the image.
- Run captures in that reference image with Docker network mode none. Keep loopback
  only for the local Player harness and prove non-loopback egress fails.
- Keep the production renderer image free of release fixtures, tracked goldens,
  Player development dependencies, and F1 scripts.
- Wire CI to build/use the same reference contract, run verifier with network none,
  and never promote or upload candidates.
- Generate exactly one initial candidate under a fresh external
  THOTH_CONTROL_PLANE_ARTIFACT_ROOT, complete the final review, update the ignored
  F1 checkpoint, and report its contact sheet for operator inspection.

TDD and evidence requirements:
- RED must fail for the intended missing behavior, not a broken harness.
- Do not weaken an assertion or replace an integration requirement with mocks.
- Dependency injection is allowed only at process, browser, filesystem, clock, or
  test canonical-root seams already justified by the design.
- Mutation-check the load-bearing cases: stale asset digest; traversal/link;
  arbitrary release target; production preview mapping mismatch; changed RGBA pixel;
  equivalent pixels with different PNG encoding; partial/stale capture; no-egress;
  promotion copy/fsync failure; manifest-switch failure.
- Record actual commands, exit codes, test counts, image identity, and limitations.
  Do not claim browser, Docker, or visual evidence from source inspection.

Path and privacy constraints:
- Every generated preview, render, diff, contact sheet, and report must remain below
  one configured THOTH_CONTROL_PLANE_ARTIFACT_ROOT/template-release parent.
- Test roots must be fresh, resolved absolute paths outside the repository. Validate
  containment before any bounded cleanup.
- Tracked capsule inputs are repository fixtures; generated candidates are runtime
  artifacts. Do not confuse them.
- Never read a real project, operator fixture, provider environment file, browser
  profile, restricted evidence root, production artifact, or user media.
- Never place absolute paths, environment values, credentials, raw browser logs,
  stderr, exception payloads, or real asset identity in the machine report.
- The private final handoff may show the absolute local contact-sheet path solely so
  the operator can inspect it.

Product boundaries:
- Keep one trusted composition and one released template.
- Add no public API route, OpenAPI field, database migration, Temporal workflow,
  queue, S3/CDN path, provider, arbitrary renderer knob, or production cleanup API.
- Do not change the existing MP4 media-fact authority or require video byte equality.
- Do not start responsive F2, progressive-migration F3, or Python Scout migration.

Verification:
- Run every focused command at its task boundary.
- In Task 6 run the full renderer, dashboard, Python non-live/Ruff, CUDA/Rust, Scout,
  Compose, isolated renderer smoke, production-image exclusion, reference-image
  no-egress, generated-contract, and diff-hygiene gates listed in the plan.
- Use bun --cwd=renderer run typecheck. Do not use unpinned bun x compiler resolution.
- Run graphify update . after final product-code changes; never stage graphify-out,
  .serena, .codegraph databases, or the ignored .superpowers checkpoint.
- If Docker or another mandatory gate is unavailable, stop with an exact BLOCKED
  report. Do not call an unrun gate unnecessary.

Final review policy:
- After all implementation tasks and pre-approval gates, review the entire F1 range
  against both repository standards and the F1 specification.
- Fix material product, security, contract, evidence, or operational findings and
  rerun affected gates. Fix minor documentation issues directly without starting a
  new review round.
- Generate the contact sheet but do not claim AI/Codex inspection is human visual
  approval. The operator retains that gate.

Hard stops:
- Do not invoke the promotion CLI against the tracked release capsule.
- Do not create golden-manifest.json or any tracked golden-set directory.
- Do not mark F1 complete or append a completed-work CHANGELOG entry.
- Do not push, force-push, create a PR/tag/release, publish a package/image, deploy,
  or start/stop/restart services.
- Do not render a real project or use real assets, secrets, provider/TikTok/CDN,
  browser profiles, Scout-live, acquisition, or Temporal-live requests.
- Do not run Stage 1 parity/fallback, retry p1–p6, mutate restricted evidence or
  observations, change Issue #5, or open acceptance/soak.
- Do not start Task 7, F2, F3, or Python Scout migration.

Required final report (Indonesian):
1. Preflight and final branch/HEAD/upstream/ahead-behind/worktree state.
2. Task-by-task file responsibility and concise commits.
3. Actual RED -> GREEN evidence and mutation evidence for Tasks 1–6.
4. Release identity, selected frames, synthetic fixture coverage/checksums without
   absolute paths or fixture payloads.
5. Reference environment identity: base digest, built image ID/digest, platform,
   Remotion/React/Chrome/font versions, device scale, and no-egress proof.
6. Paired Player/renderStill candidate verdict and safe report fields.
7. Path containment, link rejection, canonical RGBA, atomic file/manifest, bounded
   cleanup, and safe-report evidence.
8. Full gate table with exact commands, test counts, exit codes, and any blocker.
9. Whole-branch review findings and fixes.
10. Private absolute contact-sheet path, exact candidate run ID, and explicit note
    that operator visual approval is still required.
11. Limitations and every hard-stop action not performed.
12. Final handoff exactly: F1 candidate ready for operator visual review; promotion
    and tracked goldens not authorized.

Stop after the report. Do not continue to Task 7 or any later gate.
```
