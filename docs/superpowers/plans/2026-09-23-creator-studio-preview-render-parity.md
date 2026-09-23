# Creator Studio F1 Preview/Render Parity Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` or
> `superpowers:subagent-driven-development`, plus
> `superpowers:test-driven-development`. Complete each task RED then GREEN. Perform
> one whole-branch review after Task 6, then stop for operator visual approval.

**Goal:** Add a deterministic offline gate proving that the released Creator Studio
template draws identical production-preview and renderer pixels and cannot change
its active golden set without explicit operator approval.

**Architecture:** The shared composition and production preview projection are the
only visual implementation. `RendererArtifactRoot` remains the only generated-path
authority. One template-release module owns allowlisted capsule lookup, paired
capture, canonical-RGBA comparison, safe reporting, and immutable-set promotion.
All browser evidence is produced in one digest-pinned, network-disabled Linux/amd64
reference image.

**Tech stack:** TypeScript 6, Bun 1.3.14, React 19.2.7, Remotion 4.0.523,
`@remotion/player`, `@remotion/renderer`, FFmpeg/FFprobe, Docker, GitHub Actions.

**Spec:**
`docs/superpowers/specs/2026-09-23-creator-studio-preview-render-parity-design.md`

## Global constraints

- Work on `codex/stage1-container-ci` from the checkpoint baseline in
  `.superpowers/sdd/2026-09-23-creator-studio-f1-preview-render-parity/progress.md`.
  Inspect HEAD, upstream, ahead/behind, status, and drift before editing.
- Use focused RED, minimal GREEN, focused rerun, and one concise subject-only commit
  per task. Do not rewrite existing history.
- Keep `AdvancedTimelineComposition`, `COMPOSITION_ID`, and the production preview
  projection authoritative. Do not create a second production composition or
  test-only prop mapper.
- Extend `RendererArtifactRoot`; never add another module that composes generated
  paths and never pass a raw artifact-root string into the verifier.
- Add no output-root setting. Every candidate, diff, contact sheet, and report stays
  below `THOTH_CONTROL_PLANE_ARTIFACT_ROOT/template-release/`.
- Production release lookup accepts only the allowlisted release identity and
  derives the canonical repository path. No CLI or public function accepts an
  arbitrary capsule path or golden destination.
- A `pass` requires exact canonical RGBA equality. PNG hashes are diagnostic only.
  One changed pixel always blocks release.
- Golden sets are immutable. Promotion creates a content-addressed set and
  atomically switches only `golden-manifest.json` after explicit operator approval.
- Use only synthetic, license-safe fixtures. Do not read real projects, secrets,
  provider files, browser profiles, Stage 1 evidence, or operator assets.
- Capture and verification run only in the same digest-pinned Linux/amd64 reference
  image with Docker network mode `none`. Windows only orchestrates Docker.
- Preserve renderer isolation, private protocol, one active render slot, public
  contracts, database schema, deployment defaults, and existing MP4 smoke.
- Do not start F2, F3, Python Scout migration, deployment, or live work.

## File ownership map

- `renderer/src/release-capsule.ts` — allowlisted release lookup and strict parser.
- `renderer/src/artifact-root.ts` — existing sole path authority, extended with F1
  run handles.
- `packages/remotion-composition/src/preview-projection.ts` — shared production
  preview projection and Player configuration.
- `renderer/src/release-capture.tsx` — paired Player and `renderStill()` capture.
- `renderer/src/release-compare.ts` — canonical RGBA equality and diagnostics.
- `renderer/src/template-release.ts` — `verifyRelease()` and `promoteRelease()`.
- `renderer/scripts/verify-template-release.ts` — thin allowlisted verifier CLI.
- `renderer/scripts/promote-template-release.ts` — thin run-ID promotion CLI.
- `packages/remotion-composition/releases/vertical_text_story-v1/` — one capsule.
- `Dockerfile.renderer-f1` — reference-only test image.
- `Dockerfile.renderer` and `.dockerignore` — production image excludes release
  capsules while the F1 build context can read them.
- `.github/workflows/container-image.yml` — offline reference-image gate.

---

### Task 1: Strict capsule and single path authority

**Files:**

- Create: `renderer/src/release-capsule.ts`
- Create: `renderer/src/release-capsule.test.ts`
- Modify: `renderer/src/artifact-root.ts`
- Modify: `renderer/src/artifact-root.test.ts`
- Modify: `renderer/src/config.ts`
- Modify: `renderer/src/config.test.ts`
- Modify: `renderer/package.json`

**Interfaces:**

```ts
type ReleaseIdentity = "vertical_text_story-v1";
loadReleaseCapsule(identity: ReleaseIdentity, deps?: CapsuleTestDeps): Promise<ReleaseCapsule>;
RendererArtifactRoot.createTemplateReleaseRun(identity, runId): Promise<TemplateReleaseRun>;
```

- [ ] **Step 1: Write capsule RED tests.** Cover unknown fields, wrong schema or
  identity, absolute paths, traversal, links/reparse points, missing/extra assets,
  checksum mismatch, duplicate/unordered/out-of-range frames, invalid manifest,
  manifest escape, and document/composition mismatch. Prove production lookup has
  no arbitrary path parameter.
- [ ] **Step 2: Write `RendererArtifactRoot` RED tests.** Cover root containment,
  validated identities, `0700` run directories where supported, atomic report
  replacement, link rejection, and cleanup limited to one selected run. Assert all
  path composition remains in `artifact-root.ts`.
- [ ] **Step 3: Verify RED.** Run:

  ```powershell
  bun --cwd=renderer test src/release-capsule.test.ts src/artifact-root.test.ts src/config.test.ts
  ```

- [ ] **Step 4: Implement the minimum GREEN change.** Derive the canonical release
  root from repository-owned module location, use `realpath`/`lstat`/`relative`,
  strict exact-key parsing, and SHA-256 verification. Extend
  `RendererArtifactRoot` with a typed run handle exposing bounded write and cleanup
  methods. Add `"typecheck": "tsc -p tsconfig.json --noEmit"`; do not add
  `release-artifacts.ts`.
- [ ] **Step 5: Run GREEN gates.** Run the focused test command and:

  ```powershell
  bun --cwd=renderer run typecheck
  ```

- [ ] **Step 6: Commit.** Stage only Task 1 files and commit:

  ```powershell
  git commit -m "feat: define template release capsule"
  ```

---

### Task 2: Production preview seam and deterministic capsule

**Files:**

- Create: `packages/remotion-composition/src/preview-projection.ts`
- Create: `packages/remotion-composition/src/preview-projection.test.ts`
- Modify: `packages/remotion-composition/src/index.ts`
- Modify: `packages/remotion-composition/src/AdvancedTimelineComposition.tsx`
- Create: `packages/remotion-composition/src/font-assets.d.ts`
- Modify: `dashboard/src/features/studio/StudioPreview.tsx`
- Modify: `dashboard/src/features/studio/StudioPreview.test.tsx`
- Modify: `dashboard/src/features/studio/preview.ts`
- Modify: `dashboard/src/features/studio/preview.test.ts`
- Create: `packages/remotion-composition/releases/vertical_text_story-v1/release.json`
- Create: `packages/remotion-composition/releases/vertical_text_story-v1/document.json`
- Create: synthetic files under
  `packages/remotion-composition/releases/vertical_text_story-v1/assets/`
- Modify: `renderer/src/release-capsule.test.ts`

- [ ] **Step 1: Write RED tests.** Prove `StudioPreview` and the F1 harness can only
  obtain effective props, geometry, FPS, and duration from the same exported
  projection. Assert the composition root owns `ThothComposition`; capture waits
  for both local Poppins weights; a load failure calls `cancelRender()`; fixture
  assets contain no network source; hidden/muted content stays hidden/muted.
- [ ] **Step 2: Verify RED.** Run:

  ```powershell
  bun --cwd=dashboard test src/features/studio/StudioPreview.test.tsx src/features/studio/preview.test.ts
  bun --cwd=renderer test src/release-capsule.test.ts
  ```

- [ ] **Step 3: Implement the shared seam.** Move only the smallest existing
  projection/configuration logic needed by both consumers. `StudioPreview` imports
  it; the parity harness will import the same symbol in Task 3. Do not move Studio
  chrome or interaction state into the package.
- [ ] **Step 4: Add deterministic typography and capsule.** Reuse
  `assets/fonts/Poppins-Regular.ttf` and `Poppins-Bold.ttf`; register with
  `FontFace`, `delayRender()`, `continueRender()`, and `cancelRender()`. Add the
  strict synthetic document and small FFmpeg-generated image/video/audio assets,
  their exact digests, and representative frames. Do not add a golden manifest yet.
- [ ] **Step 5: Run GREEN gates.** Run the focused tests plus:

  ```powershell
  bun --cwd=dashboard run build
  bun --cwd=renderer run typecheck
  ```

- [ ] **Step 6: Commit.** Stage only Task 2 files and commit:

  ```powershell
  git commit -m "feat: share deterministic preview projection"
  ```

---

### Task 3: Pinned reference image and paired capture

**Files:**

- Create: `Dockerfile.renderer-f1`
- Modify: `Dockerfile.renderer`
- Modify: `.dockerignore`
- Create: `renderer/src/release-capture.tsx`
- Create: `renderer/src/release-capture.test.ts`
- Create: `renderer/src/release-preview-entry.tsx`
- Modify: `renderer/src/remotion-adapter.ts`
- Modify: `renderer/src/remotion-adapter.test.ts`
- Modify: `renderer/package.json`
- Modify: `renderer/bun.lock`
- Modify: `python/tests/deployment/test_container_contract.py`

- [ ] **Step 1: Write capture and image-contract RED tests.** Prove each frame is
  sent through the shared production preview projection and the registered renderer
  with identical props and dimensions; capture is ordered; stale/partial callbacks
  cannot complete a frame; browser/process teardown always runs; non-loopback
  egress fails while loopback works. Prove the production image does not contain
  release fixtures or `@remotion/player`.
- [ ] **Step 2: Verify RED.** Run:

  ```powershell
  bun --cwd=renderer test src/release-capture.test.ts src/remotion-adapter.test.ts
  uv run --project python pytest python/tests/deployment/test_container_contract.py -q
  ```

- [ ] **Step 3: Pin the reference environment.** Resolve the immutable multi-arch
  digest for the existing `oven/bun:1.3.14` build input through registry metadata,
  record the exact `linux/amd64` base digest in `Dockerfile.renderer-f1`, and make
  its build identify the resulting image ID/digest in reports. A tag-only base is
  not acceptable. The reference target installs locked development dependencies,
  the pinned Remotion browser, FFmpeg, and local fonts. Do not publish the image.
- [ ] **Step 4: Keep production lean.** Allow only the F1 Dockerfile to copy release
  fixtures. Narrow production `Dockerfile.renderer` copies so the existing runtime
  image contains composition sources/fonts needed at runtime but no release capsule,
  goldens, scripts, or Player development dependency.
- [ ] **Step 5: Implement paired capture.** Add `@remotion/player` `4.0.523` as a
  renderer development dependency. The controls-free page imports the shared
  production projection. Reuse `rendererWebpackOverride`, `bundle()`,
  `selectComposition()`, `renderStill()`, and Remotion's Chrome Headless Shell. Do
  not add Playwright, Puppeteer, or another browser download.
- [ ] **Step 6: Run GREEN gates.** Run focused tests, `typecheck`, build the
  `linux/amd64` F1 image, then invoke its no-egress self-check using
  `--network none`. If Docker is unavailable, stop as blocked; do not claim capture
  completion.
- [ ] **Step 7: Commit.** Stage only Task 3 files and commit:

  ```powershell
  git commit -m "feat: capture template parity frames"
  ```

---

### Task 4: Canonical RGBA comparison and safe verification

**Files:**

- Create: `renderer/src/release-compare.ts`
- Create: `renderer/src/release-compare.test.ts`
- Create: `renderer/src/template-release.ts`
- Create: `renderer/src/template-release.test.ts`
- Create: `renderer/scripts/verify-template-release.ts`
- Modify: `renderer/package.json`

**Interface:**

```ts
verifyRelease(
  identity: ReleaseIdentity,
  artifacts: RendererArtifactRoot,
  deps?: VerifyDeps,
): Promise<ReleaseReport>;
```

- [ ] **Step 1: Write comparator and report RED tests.** Cover equal RGBA with
  different PNG compression/metadata (`pass`), one changed pixel
  (`review_required`, never `pass`), over-bound mismatch, missing/extra golden,
  contract failure, capture failure, unordered callback rejection, malformed
  FFmpeg output, and serialization allowlisting.
- [ ] **Step 2: Verify RED.** Run:

  ```powershell
  bun --cwd=renderer test src/release-compare.test.ts src/template-release.test.ts
  ```

- [ ] **Step 3: Implement canonical decoding.** Invoke configured FFmpeg through an
  argument array and decode both images to raw `rgba` at the declared dimensions.
  Stream or compare the exact byte count. File SHA-256 remains diagnostic only.
  For unequal RGBA, compute fixed metrics and a diff image; map subprocess/parse
  failures to `capture_failed` without exposing stderr.
- [ ] **Step 4: Implement verification orchestration.** Order phases as capsule
  validation, run reservation, paired capture, pair comparison, active-golden
  comparison, contact sheet, and atomic safe report. Stop on the first failed phase,
  release all processes, and retain only bounded diagnostics. CLI arguments permit
  the allowlisted release identity only; artifact root comes from existing config.
- [ ] **Step 5: Run GREEN gates.** Run focused tests and `typecheck`. Build and run
  the F1 image with a fresh external artifact root and `--network none`. Before an
  initial manifest exists, the expected safe verdict is `golden_missing` with a
  complete candidate, not `pass`.
- [ ] **Step 6: Commit.** Stage only Task 4 files and commit:

  ```powershell
  git commit -m "feat: verify template release parity"
  ```

---

### Task 5: Immutable-set promotion mechanism and CI wiring

**Files:**

- Create: `renderer/scripts/promote-template-release.ts`
- Modify: `renderer/src/template-release.ts`
- Modify: `renderer/src/template-release.test.ts`
- Modify: `renderer/package.json`
- Modify: `.github/workflows/container-image.yml`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interface:**

```ts
promoteRelease(
  identity: ReleaseIdentity,
  artifacts: RendererArtifactRoot,
  runId: string,
  deps?: PromotionTestDeps,
): Promise<void>;
```

- [ ] **Step 1: Write promotion RED tests.** Use temporary canonical repository and
  artifact roots. Cover missing report, wrong release/run/reference-image identity,
  stale fixture hash, incomplete/extra frame, link, traversal, dirty target,
  duplicate set, injected copy/fsync failure, and injected manifest-switch failure.
  Every failure must leave the prior manifest and immutable sets byte-identical.
- [ ] **Step 2: Write CI contract RED tests.** Require one digest-pinned F1 image,
  `linux/amd64`, `--network none`, a fresh artifact root outside checkout, verifier
  invocation, no promotion invocation, no candidate upload, and no second output
  root.
- [ ] **Step 3: Verify RED.** Run focused promotion and deployment tests.
- [ ] **Step 4: Implement promotion without invoking it.** Revalidate the allowlisted
  capsule and exact run. Build the complete candidate set under a new
  content-addressed `golden-sets/sha256-...` directory, reject any existing
  nonidentical set, fsync files/directories, then atomically replace only a
  same-directory temporary `golden-manifest.json`. The CLI accepts `--run-id` and
  the allowlisted identity, never a path. Do not promote the real capsule in this
  task.
- [ ] **Step 5: Wire CI.** Build or load the same reference image, record its build
  identity, and run verification with network disabled. CI must not promote or
  upload candidate artifacts. The gate will remain non-pass until Task 7 creates the
  operator-approved initial manifest.
- [ ] **Step 6: Run GREEN gates.** Run focused tests, renderer tests/typecheck, and
  deployment tests. Exercise promotion failure injection only against temporary
  roots.
- [ ] **Step 7: Commit.** Stage only Task 5 code/workflow/tests and commit:

  ```powershell
  git commit -m "ci: define template golden release gate"
  ```

---

### Task 6: Candidate evidence, final review, and operator checkpoint

**Files:**

- Modify (ignored):
  `.superpowers/sdd/2026-09-23-creator-studio-f1-preview-render-parity/progress.md`
- No tracked golden or manifest change is authorized in this task.

- [ ] **Step 1: Generate one fresh candidate.** Use the pinned F1 image,
  `linux/amd64`, `--network none`, and a fresh external
  `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`. Require complete preview/render frames, diffs,
  contact sheet, safe report, and the expected initial `golden_missing` verdict.
- [ ] **Step 2: Run the full pre-approval gate matrix.** Run:

  ```powershell
  bun --cwd=renderer test
  bun --cwd=renderer run typecheck
  bun --cwd=dashboard test
  bun --cwd=dashboard run lint
  bun --cwd=dashboard run build
  uv run --project python pytest -m "not live" -q
  uv run --project python ruff check python/src python/tests
  uv run --project python ruff format --check python/src python/tests
  cmd /c ".\build_cuda.bat > build_log.txt 2>&1"
  cargo test --bin thoth
  bun --cwd=scout install --frozen-lockfile
  bun --cwd=scout run test:acquisition
  bun --cwd=scout run test:runtime
  docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
  git diff --check
  ```

  Also run the existing isolated renderer container smoke with locally built images.
  If Docker or a mandatory gate is unavailable, report `BLOCKED`; do not relabel it
  unnecessary.
- [ ] **Step 3: Run one whole-branch review.** Review the entire F1 range against
  this spec and repository standards. Fix material code, security, contract, and
  operational findings; fix minor documentation directly. Rerun affected gates and
  final `git diff --check`. Do not open another documentation-only review round.
- [ ] **Step 4: Prepare operator evidence.** Report the candidate run ID, safe report
  fields, exact reference image identity, frame list, and absolute local contact
  sheet path only in the private operator handoff (never in the public report).
  Do not claim Codex/AI inspection as human approval.
- [ ] **Step 5: Update the ignored checkpoint and stop.** Record commits, test
  counts, limits, and the exact visual-approval gate. Do not invoke promotion, add a
  golden manifest, modify `CHANGELOG.md` as completed work, push, or deploy.

**Mandatory stop:** Operator must inspect the contact sheet and explicitly authorize
promotion of that exact run ID before Task 7.

---

### Task 7: Post-approval promotion and final release gate

This task is documented but is not authorized by the initial executor prompt.

**Files:**

- Create:
  `packages/remotion-composition/releases/vertical_text_story-v1/golden-manifest.json`
- Create: one immutable directory under
  `packages/remotion-composition/releases/vertical_text_story-v1/golden-sets/`
- Modify: `CHANGELOG.md`
- Modify (ignored): active F1 `progress.md`

- [ ] **Step 1: Reconfirm authorization and candidate identity.** Require explicit
  operator approval naming the exact candidate run ID produced by Task 6. Reject a
  changed HEAD, fixture hash, reference-image identity, or candidate report.
- [ ] **Step 2: Promote inside the reference image.** Run the promotion CLI with the
  allowlisted identity and exact run ID, `linux/amd64`, network disabled, and the
  existing artifact root. Review the resulting manifest and new immutable set diff.
- [ ] **Step 3: Prove two fresh passes.** Use two new external artifact roots and two
  fresh containers from the same image. Both verifier runs must exit zero with
  `pass`; tracked files must remain unchanged between runs.
- [ ] **Step 4: Run final affected gates.** Run renderer tests/typecheck, deployment
  contract tests, the CI-equivalent Docker gate, production-image fixture exclusion,
  isolated-render smoke, and `git diff --check`.
- [ ] **Step 5: Record and commit.** Append one exact English entry to `CHANGELOG.md`,
  update the ignored checkpoint, and commit the manifest, immutable set, and audit
  record:

  ```powershell
  git commit -m "test: approve template release goldens"
  ```

- [ ] **Step 6: Stop for the operator push decision.** Do not push, publish images,
  deploy, render real projects, or start F2/F3/Python migration.
