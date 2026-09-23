# Creator Studio F1 Preview/Render Parity Design

**Status:** Approved direction; implementation not started

## 1. Purpose

F1 makes the visual contract of the released Creator Studio template testable. For
the same immutable `EditDocumentV2`, staged asset bytes, composition, and frame
number, the production browser-preview projection and the isolated renderer must
draw the same canonical canvas. A template cannot pass its release gate when that
contract is missing, stale, or visibly changed without explicit operator review.

F1 is deliberately smaller than the parent roadmap's responsive rollout. It covers
preview/render parity, golden frames, and the template release gate. Tablet and
phone review surfaces and progressive migration remain later F2 and F3 work.

## 2. Existing foundation

The repository already has the important parity seam:

- `@thoth/remotion-composition` owns `AdvancedTimelineComposition` and
  `COMPOSITION_ID`;
- `StudioPreview` mounts that composition through `@remotion/player`;
- the isolated renderer registers and selects the same composition;
- render bundles bind one immutable document revision and staged asset checksums;
- renderer codec and browser settings are server-owned; and
- generated render paths already live below
  `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`.

F1 deepens that seam. It does not create a second preview implementation, path
authority, template registry, or output root.

## 3. Scope

F1 includes:

1. one release capsule for `vertical_text_story` version `1`;
2. one production preview projection shared by `StudioPreview` and the parity
   harness;
3. deterministic package-owned fonts used by Player and renderer;
4. paired Player and `renderStill()` captures at fixed frames;
5. exact canonical-RGBA comparison with bounded diagnostics;
6. one machine-readable release report with a closed verdict set;
7. explicit operator-reviewed golden promotion through an immutable golden set
   and atomic manifest pointer; and
8. an offline, pinned Linux/amd64 CI gate.

F1 excludes responsive breakpoints, mobile/tablet review surfaces, a second
template, user-selectable render settings, CDN/S3 publication, full-video byte
equality, provider or acquisition work, TikTok/Scout/Python migration work,
deployment, live project rendering, migration of historical outputs, and automatic
acceptance of changed pixels.

## 4. Parity definition

Parity is layered because an encoded MP4 checksum is not a stable visual contract.

### 4.1 Contract parity

The production preview projection and renderer share:

- `AdvancedTimelineComposition` and `COMPOSITION_ID`;
- the validated `EditDocumentV2` value;
- canvas width, height, FPS, and duration;
- staged asset identity and bytes;
- the requested frame number; and
- package-owned font bytes.

The Player harness must consume the same exported production projection and Player
configuration used by `StudioPreview`. The small projection may move into the
shared composition package, but F1 must not recreate it in test-only code. A wiring
test keeps `StudioPreview` attached to that shared seam. Any mismatch is
`contract_failed`, and no image comparison runs after that failure.

### 4.2 Frame parity

For every selected frame, F1 captures:

- the shared composition mounted in a controls-free `@remotion/player` harness
  through the production preview projection; and
- the registered composition rendered through Remotion `renderStill()`.

Both captures run in the same digest-pinned, build-identified Linux/amd64 Docker
reference image with device scale factor `1`, software rendering, and container
network mode `none`. Loopback remains available only inside the container for the
local Player harness. A negative integration check proves non-loopback requests
fail. Both surfaces use the same local fixture assets and fonts. Studio chrome,
controls, scaling, and surrounding dashboard CSS are outside the compared canvas.

The two surfaces must decode to identical canonical RGBA pixels for a passing
release.

### 4.3 Encoded-output contract

The existing isolated-render smoke remains authoritative for MP4/H.264 geometry,
FPS, duration, codec, audio expectation, checksum, publication, and cleanup. F1
does not introduce an MP4 golden file.

## 5. Release capsule

The release capsule is a tracked test input, not a runtime template registry:

```text
packages/remotion-composition/releases/
`-- vertical_text_story-v1/
    |-- release.json
    |-- golden-manifest.json
    |-- document.json
    |-- assets/
    |   |-- image.png
    |   |-- video.mp4
    |   `-- audio.wav
    `-- golden-sets/
        `-- sha256-<set-digest>/
            |-- frame-000000-preview.png
            |-- frame-000000-render.png
            `-- ...
```

`release.json` is strict and contains only:

```json
{
  "schema_version": 1,
  "template_id": "vertical_text_story",
  "template_version": 1,
  "composition_id": "advanced-timeline-v1",
  "document": "document.json",
  "assets": [
    {
      "asset_id": "asset_image",
      "file": "assets/image.png",
      "sha256": "sha256:<64 lowercase hex>"
    }
  ],
  "frames": [0, 30, 60, 89]
}
```

The release identity is an allowlisted typed value, not a caller-supplied path.
Production code derives its directory from the canonical repository release root,
proves resolved containment, and rejects links at every component. Test-only
dependencies may substitute a temporary canonical release root.

The parser rejects unknown fields, absolute paths, traversal, links, missing or
extra assets, checksum mismatch, duplicate or unordered frames, out-of-range
frames, and template/composition identity that contradicts the validated document.

`golden-manifest.json` is the only mutable release pointer. It strictly identifies
one immutable content-addressed directory under `golden-sets/` and records the
complete expected frame/file set. It cannot point outside the capsule or through a
link. Golden-set directories are never modified in place.

The document exercises every visual primitive supported by the released template:
text, caption cues, overlays, presets, accent slots, image crop/position, video,
audio presence, hidden content, and muted content. Media is small, synthetic,
license-safe, committed, and contains no real project, provider, or network URL.

## 6. Deterministic rendering

The composition owns its typography. Existing repository-owned Poppins Regular and
Bold bytes are bundled into both consumers under one private family name. The
composition does not inherit dashboard Geist CSS or host system fonts.

Font loading uses the web `FontFace` interface with Remotion `delayRender()`,
`continueRender()`, and `cancelRender()`. Both Player capture and `renderStill()`
wait for identical local bytes instead of racing browser fallback.

The reference environment fixes:

- Remotion `4.0.523`;
- React and React DOM `19.2.7`;
- the renderer lockfile and Remotion-managed Chrome Headless Shell;
- a digest-pinned Linux/amd64 base/reference image whose build identity is reported;
- device scale factor `1` and software rendering;
- network mode `none`, with loopback used only by the local harness;
- explicit light/dark emulation and an integer frame;
- no time, randomness, locale-sensitive formatting, or remote input; and
- fixture checksum verification before capture.

The Player receives the resolved production composition props, geometry, FPS,
duration, and `initialFrame`. `renderStill()` follows Remotion 4's documented
bundle/select/render flow.

## 7. Visual comparison verdicts

Each PNG records width, height, file size, and SHA-256 for diagnostics. FFmpeg then
decodes both inputs to canonical raw RGBA for the declared geometry. Exact RGBA
equality, not PNG byte equality, determines `pass`; equivalent pixels may have
different PNG metadata or compression bytes.

For unequal pixels, the comparator creates a diff image and fixed numeric metrics.
The closed verdict set is:

- `pass` — all contract checks pass, preview/render RGBA pixels are exactly equal,
  and every generated surface exactly matches its active golden RGBA pixels;
- `review_required` — pixels differ but remain within maximum channel delta `8`
  and changed-pixel ratio `0.001`; this still blocks release;
- `visual_mismatch` — either diagnostic bound is exceeded;
- `contract_failed` — identity, schema, path, asset, geometry, frame, font, or
  environment checks fail;
- `capture_failed` — either surface cannot produce a complete PNG; or
- `golden_missing` — the manifest or a required golden is absent, unexpected, or
  inconsistent.

Only `pass` succeeds as a machine gate. Diagnostic tolerance never auto-approves a
pixel change. Reports contain only fixture-relative names, public release identity,
frame numbers, synthetic hashes, numeric metrics, reference-image identity, and
fixed verdict codes. They contain no absolute path, environment value, credential,
real asset identity, raw browser log, stderr, or exception text.

## 8. Artifact layout

`RendererArtifactRoot` remains the only renderer module allowed to compose or
touch paths. F1 extends it with a typed template-release run handle:

```text
THOTH_CONTROL_PLANE_ARTIFACT_ROOT/
`-- template-release/
    `-- vertical_text_story-v1/
        `-- <opaque-run-id>/
            |-- preview/
            |-- render/
            |-- diff/
            |-- contact-sheet.png
            `-- report.json
```

Callers provide typed identities, never paths. The verifier receives a validated
`RendererArtifactRoot`, never a raw root string. The module enforces containment,
link/reparse-point rejection, file modes, atomic file writes, and cleanup limited to
one selected run. No new output-root setting is added.

Tracked capsule inputs and goldens are repository fixtures, not runtime output.
Promotion accepts only the allowlisted release identity and exact run ID, derives
source and destination through their canonical authorities, writes a new immutable
content-addressed golden set, validates and fsyncs it, then atomically replaces only
the same-directory `golden-manifest.json` pointer. It never renames over or edits a
nonempty golden directory.

## 9. Golden promotion and operator review

An intentional visual change follows this sequence:

1. run the verifier and receive `review_required`, `visual_mismatch`, or
   `golden_missing` with a complete candidate;
2. finish the single whole-branch code review and generate a contact sheet;
3. stop and obtain explicit operator visual approval; executor or Codex inspection
   is not human approval;
4. run promotion for the exact run ID and allowlisted release identity inside the
   same pinned reference environment;
5. revalidate report, fixture hashes, frame set, worktree target, containment, and
   link-free paths;
6. write a new immutable set and atomically switch the manifest pointer; and
7. verify twice in fresh reference containers and require `pass` before commit.

Promotion does not fabricate an approver record or contact GitHub. The operator
decision plus the reviewed golden/manifest diff and commit are the audit trail. CI
never promotes goldens.

## 10. Module design

F1 adds one deep release module behind this small interface:

```text
verifyRelease(releaseIdentity, RendererArtifactRoot) -> ReleaseReport
promoteRelease(releaseIdentity, RendererArtifactRoot, runId) -> void
```

It hides canonical capsule lookup, validation, asset staging, browser lifecycle,
Player capture, `renderStill()`, RGBA comparison, diagnostics, contact-sheet
creation, safe reporting, manifest switching, and cleanup. Tests cross the same
interface. The production renderer keeps only its existing render-job HTTP
interface; F1 adds no route, database table, dashboard control, Temporal workflow,
or public schema.

## 11. Failure and cleanup behavior

- Contract failure stops before browser launch.
- Browser and subprocess cleanup runs on success, failure, cancellation, timeout,
  and interruption.
- Failed runs retain only bounded diagnostics under their run directory.
- A timeout produces `capture_failed` and a nonzero CLI exit.
- Failed promotion leaves the active manifest and all existing immutable golden
  sets byte-identical.
- Cleanup may remove only one selected F1 run beneath the canonical artifact root;
  no broad prune or recursive deletion is exposed.

## 12. Reference environment and CI

Capture, initial candidate generation, promotion validation, both fresh verification
runs, and CI use the same digest-pinned, build-identified Linux/amd64 Docker
reference image. Windows and GitHub Actions only orchestrate Docker. The container
runs with network mode `none`; a test proves non-loopback egress fails while the
local Player loopback harness still works.

The host creates a fresh `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` outside the checkout
and bind-mounts only that root plus the minimum repository inputs required by the
reference command. The production renderer image excludes release capsules and
goldens. CI requires `pass`, never invokes promotion, and never uploads candidates.

The existing dashboard, renderer, Python, Scout, Compose, isolated-render smoke,
Rust/CUDA, generated-contract, lint, and build gates remain applicable according to
the implementation plan. The implementation performs one whole-branch review
after candidate generation, then stops at the operator visual-approval checkpoint.

## 13. Acceptance criteria

| ID | Requirement | Required proof |
|---|---|---|
| F1-AC1 | `StudioPreview`, parity Player, and renderer consume one trusted composition with identical effective props | Projection and wiring contract tests |
| F1-AC2 | The allowlisted release has one strict, self-contained capsule | Parser fixture tests |
| F1-AC3 | Fonts and fixtures are independent of host CSS, system fonts, network, locale, time, and randomness | Determinism and no-egress tests |
| F1-AC4 | Every selected frame produces paired Player and renderer PNGs | Capture integration test |
| F1-AC5 | Canonical RGBA pixels match the active tracked goldens | Gate in the pinned, network-disabled Linux/amd64 image |
| F1-AC6 | Any changed pixel blocks release until explicit operator-approved promotion and fresh passes | Mutation and promotion tests |
| F1-AC7 | Invalid paths, links, stale assets, arbitrary targets, wrong identity, and incomplete frames fail closed | Security and negative tests |
| F1-AC8 | Generated output stays below `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` through `RendererArtifactRoot` | Path-authority tests |
| F1-AC9 | Reports expose only fixed safe fields and codes | Serialization allowlist test |
| F1-AC10 | Existing encoded MP4 facts remain covered without a video golden | Existing render-smoke regression |
| F1-AC11 | Promotion writes an immutable set and atomically switches only its validated manifest | Failure-injection tests |
| F1-AC12 | F1 adds no public API, database, live workflow, or production image fixture payload | Diff, image, and full regression review |

## 14. Delivery boundaries

This design authorizes preparation of the implementation plan and executor prompt.
The executor prompt may authorize offline product changes, synthetic fixtures,
reference-image builds, candidate capture, and non-live verification. It must stop
for explicit operator visual approval before promotion.

Separate operator authorization remains required for promotion after inspection,
push, image publication, deployment, service restart, real project or asset access,
live rendering, cleanup outside synthetic F1 runs, external approval records, Python
Scout migration, Stage 1 evidence mutation, parity, controlled fallback, or an
acceptance/soak window.
