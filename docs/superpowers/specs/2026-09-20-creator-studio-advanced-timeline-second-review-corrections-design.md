# Creator Studio Advanced Timeline Second Review Corrections Design

**Date:** 2026-09-20

**Parent design:** `docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md`

**First correction:** `docs/superpowers/specs/2026-09-20-creator-studio-advanced-timeline-review-corrections-design.md`

## 1. Purpose

This addendum closes the seven actionable gaps found by the second independent
review of D1. It corrects state preservation, upgrade affordances, asset
pagination, image preview, normalized placement, and Player listener lifecycle
without widening D1 or beginning D2.

The parent design and first correction remain authoritative except where this
document makes an ambiguous behavior precise.

## 2. Scope and invariants

The correction keeps these invariants:

- `EditDocument` remains the only canonical saved draft.
- `EditDocumentOperation` and migrations `0001` through `0004` remain unchanged.
- No dependency, service, worker, queue, state library, media package, or API
  contract is added.
- Version 1 behavior and C1/C2 Prompt Lab behavior remain compatible.
- Preview sources remain transient and capabilities remain outside documents,
  URLs, logs, and public error bodies.
- Work and verification are offline only.

## 3. Autosave adopts data without resetting the editor session

A successful autosave may replace the canonical `base` and `draft`, clear the
acknowledged pending operations, and retain the existing save semantics. It
must not reconstruct unrelated editor-session state.

For a version 2 document, a successful save preserves:

- the selected Simple or Advanced projection;
- selected scene, track, clip, and issue when still valid;
- playhead, playback, zoom, snapping, and ripple state, clamped where required;
- the cumulative safe `EditorAsset` cache; and
- preview sources owned by `GuidedStudio`.

An asset that remains visible in `AssetLibrary` must remain addable after an
earlier edit has autosaved. A Simple-mode text edit must remain in Simple mode
after its save completes.

This correction does not redesign the existing undo/history contract.

## 4. Upgrade busy state is both enforced and visible

Timeline upgrade is valid only for a version 1 document in saved, online,
conflict-free, operation-free state. Any active preview gesture also makes the
state ineligible, even though the normal version 1 UI cannot create one.

While an upgrade request is running:

- document-mutating Inspector fields and undo/redo controls are disabled;
- the disabled state is available to accessibility APIs;
- selection, playback, workspace navigation, and connectivity handling remain
  usable because they do not mutate the document; and
- the reducer remains the final safety gate against delayed or synthetic
  mutation actions.

## 5. Asset pages form one deduplicated catalog

First-page loads replace the visible catalog. Continuation pages merge into it
by `asset_id`, preserving first-seen order and updating an existing entry with
the newest safe projection. Overlapping pages and repeated continuation
responses never produce duplicate rows or duplicate controls.

The reducer and `AssetLibrary` must agree on the same cumulative identities.
After any autosave, every still-rendered ready asset remains usable by the
timeline operation constructor.

## 6. Image and video preview use the correct trusted primitive

A timeline visual clip can reference either a validated video asset or a
validated image asset. `AdvancedTimelineComposition` resolves the corresponding
`asset_ref` and uses the installed Remotion primitive appropriate to that kind:

- video asset: `Video`;
- image asset: `Img`.

Both primitives receive the same safe preview source and the same bounded
fit/crop/scale/position projection. A missing or mismatched asset reference
falls back to the existing preview-unavailable state; the browser never guesses
a media kind from a URL.

## 7. Position offsets are normalized canvas fractions

The Python domain accepts `position.x` and `position.y` only in `[-1, 1]`.
Preview therefore interprets them as signed fractions of the canvas dimensions:

- `x = 0.25` moves the visual frame right by 25% of the canvas width;
- `y = -0.5` moves it up by 50% of the canvas height;
- `0` means no translation.

The CSS projection uses percentages, not pixels, and combines this translation
with the validated scale. Tests use only values accepted by the Python model.
The impossible `{x: 40, y: -20}` fixture is removed.

## 8. Player attachment follows the committed instance

Listener ownership is based on the actual committed `PlayerRef` instance, not
on reading a mutable ref during render. The integration may use a callback ref
or equivalent state-backed attachment, but it must provide these guarantees:

- the first committed Player receives exactly one listener per event;
- replacing the Player removes every listener from the old instance and adds
  them to the new instance;
- unmount removes every listener;
- fresh callback closures do not duplicate listeners; and
- seek, play, and pause target the currently committed Player.

Tests must replace a child ref during React commit rather than assigning
`ref.current` during render.

## 9. Acceptance criteria

| ID | Requirement | Required proof |
| --- | --- | --- |
| AC13 | Successful save preserves valid mode, selection, playback controls, and asset cache | Reducer and `GuidedStudio` integration tests |
| AC14 | A visible loaded asset remains addable after a save | Integration test covering load, add/save, then add |
| AC15 | Upgrade eligibility is version-1-only and mutation controls are visibly disabled while running | Reducer and accessibility component tests |
| AC16 | Overlapping continuation pages render one row per `asset_id` | `AssetLibrary` component test |
| AC17 | Image-backed visual clips use `Img`; video-backed clips use `Video` | Composition tests with valid asset refs |
| AC18 | Valid normalized offsets produce percentage translation and invalid fixtures are absent | Domain-compatible composition tests |
| AC19 | Player replacement at commit cleans and rebinds listeners exactly once | Hook integration test with real callback-ref lifecycle |
| AC20 | No dependency, migration, operation kind, public contract, or live behavior changes | Diff and generated-contract inspection |
| AC21 | Full offline gates and audit trail remain truthful | Fresh verification and append-only checkpoint records |

## 10. Operational boundary

This correction authorizes only local product code, tests, the active SDD
checkpoint, and `CHANGELOG.md`. It does not authorize push, publication,
deployment, service mutation, database migration against a running database,
real asset or secret access, provider/TikTok/browser/Scout-live requests,
render work, Stage 1 evidence mutation, Issue #5 mutation, parity, controlled
fallback, or acceptance/soak activation.
