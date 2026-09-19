# Creator Studio Advanced Timeline Review Corrections Design

**Date:** 2026-09-20
**Status:** Approved corrective scope; implementation requires the linked plan
**Baseline:** `a2cafa672dcb11a88d73e4546a698577021ee10f`
**Parent:** `docs/superpowers/specs/2026-09-19-creator-studio-advanced-timeline-foundation-design.md`

## 1. Purpose

This addendum closes the independent Codex review findings for D1 without
starting D2, adding a renderer, or widening the approved operation union. It
supersedes the parent design only where this document explicitly narrows an
ambiguous contract.

The corrective round must make the existing foundation truthful and safe:

- upgrading cannot discard a local draft;
- every document-owned asynchronous response is generation guarded;
- Simple and Advanced are selectable projections of one version 2 draft;
- the Remotion Player and timeline share one playhead and playback state;
- paginated assets remain usable and Inspector values follow selection;
- preview faithfully projects persisted typed fields; and
- preview authorization accurately matches the current single-owner control
  plane rather than implying a session identity that does not exist.

## 2. Non-goals

The correction does not add new edit operations for crop, position, fit,
overlay parameters, caption cues or style, or audio fades. Those fields remain
strict persisted document data and must be rendered and displayed, but are
read-only in D1 unless an already-approved operation exists.

It also does not add multi-user sessions, uploads, acquisition, final rendering,
waveforms, filmstrips, multi-select, keyframes, a state library, a timeline
dependency, a service worker, a media proxy service, or a new API service.

## 3. Upgrade and asynchronous integrity

Upgrade is a document replacement, not an autosave acknowledgement. It gets a
dedicated reducer transition and must never reuse `save_succeeded` semantics.

The upgrade action is available only when the editor is online, the current
draft is saved, no document operation is pending or in flight, and no upgrade
is already running. Once started, document mutation controls are visibly
disabled until the request settles. The reducer rejects document-mutating
actions while upgrade is in flight, so keyboard, pointer, Inspector, and delayed
callbacks share the same gate.

Starting upgrade increments the monotonic document generation. Autosave,
upgrade, asset pages, preview capabilities, initial document load, and every
other document-owned asynchronous callback capture the generation and compare
it before dispatching or invoking an external callback. Unmount increments it
again. A late response is a no-op.

Upgrade success atomically adopts the returned version 2 document, clears the
upgrade state, and opens Advanced mode. Upgrade conflict preserves the local
version 1 draft and exposes the existing explicit conflict choices. Failure
preserves the draft and makes upgrade retryable.

## 4. One draft, two editor projections

A version 2 document exposes a labelled Simple/Advanced mode control. The mode
is transient UI state and never enters `EditDocument` or a patch.

- Simple mode shows the existing Scene Board and text/scene Inspector against
  version 2 scenes and text clips.
- Advanced mode shows the asset library, timeline, issues, and typed timeline
  Inspector.
- Both projections read and mutate the same reducer `draft`, `base`, pending
  operations, history, conflict, and save state.
- Switching mode neither clones the document nor clears selection, undo/redo,
  pending operations, Prompt Lab drafts, or preview sources.

The existing text operations remain the only way Simple mode edits version 2
text clips and scene duration. Shared presentational components may widen their
types to the smallest structural shape common to version 1 and version 2; they
must not create a second document adapter or stored projection.

## 5. Player and timeline synchronization

The Studio editor owns one `PlayerRef`. It passes the same ref to
`StudioPreview` and `usePlayerTimeline`.

- `frameupdate` and `seeked` dispatch the current frame into transient editor
  state.
- `play` and `pause` update transient playback state.
- moving the timeline playhead calls `seekTo(frame)` and updates the reducer.
- labelled Play and Pause controls call the Player through the hook.
- listener cleanup runs on unmount and Player replacement; callbacks from an
  old document cannot update the new editor.

The Player continues to receive the canonical draft through `inputProps`.
Neither the hook nor timeline owns a document copy.

## 6. Asset pagination and operation construction

`AssetLibrary` and the reducer maintain the same cumulative set of all pages
loaded for the current document. A later page merges by `asset_id`; it never
replaces earlier pages. Retry of the first page resets the set, while retry or
pagination of a continuation page deduplicates records.

An asset shown in any loaded page remains addable after further pages load.
The smallest pure helper in `timeline_domain.ts` constructs
`add_clip_from_asset` from the current document, asset, playhead, and generated
IDs. `GuidedStudio` supplies values and dispatches the result; it does not own
track compatibility or duration defaults.

## 7. Inspector selection fidelity

Start, end, volume, and other selection-derived controls must reflect the
currently selected clip after every selection change. Use controlled values or
a selection-keyed local editor where temporary invalid text is necessary.
`defaultValue` must not retain a previous clip's value.

Fields covered by the approved operation union remain editable. Persisted typed
fields without an approved operation are rendered as labelled read-only values:

- video fit, crop, and position;
- overlay preset and bounded parameters;
- caption style and cues; and
- audio fade-in and fade-out.

This is an explicit correction to the parent plan's instruction to emit
operations that the approved union never defined. D1 does not invent those
operations during review correction.

## 8. Preview semantic fidelity

`AdvancedTimelineComposition` must project every persisted visual or audio
field it already accepts:

- video/image fit, crop, scale, and position affect the media presentation;
- trusted overlay parameters affect only the registered preset component;
- caption style references select only trusted local styles and cue timing
  remains relative to the clip;
- audio volume combines track mute with bounded fade-in and fade-out; and
- missing preview media still produces the existing safe unavailable state.

Use the installed Remotion 4.0.523 APIs and CSS. Do not add `@remotion/media` or
another package. Remotion's documented PlayerRef event/listener lifecycle and
volume callback behavior are the reference for this correction.

## 9. Preview authorization contract

The current control plane authenticates one fixed actor, `owner`, with a global
bearer key. It has no browser session identity that a media element can replay
independently. Therefore D1's exact contract is:

1. The capability-minting POST requires the authenticated control-plane actor.
2. The returned HttpOnly, SameSite=Strict, exact-path cookie is the bearer
   authorization for one project/asset preview route.
3. Signature, expiry, project, and asset scope are verified on every preview
   request.
4. The capability never appears in a URL, JSON response, document, log, public
   error, or render input.

The unused actor claim and optional actor verification path must be removed so
the code does not imply a second factor it cannot enforce. True per-user session
binding is deferred until the control plane has distinct authenticated browser
sessions; it is not simulated with a second cookie or client-readable token.

## 10. Historical audit corrections

History is append-only. Do not rewrite, squash, or amend D1 commits to repair
their task boundaries. The checkpoint and `CHANGELOG.md` must state:

- Task 8 was not implemented RED-first;
- Task 9 crossed the planned file boundary; and
- the corrective round supplies fresh RED-to-GREEN coverage for every behavior
  changed here.

New corrective commits use one-line subjects, no body, and no
`Co-Authored-By` trailer.

## 11. Acceptance criteria

| ID | Requirement | Required proof |
| --- | --- | --- |
| AC1 | Upgrade cannot start from dirty, saving, offline, conflicted, or otherwise in-flight state | Reducer and Studio component tests |
| AC2 | Upgrade uses a dedicated transition and cannot consume pending operation IDs | Reducer RED-to-GREEN test |
| AC3 | Every document-owned async result is generation guarded | Late save/upgrade/asset/capability/unmount tests |
| AC4 | Version 2 Simple and Advanced modes edit one draft | Integration tests across mode and Prompt Lab round trips |
| AC5 | Player events and timeline controls share frame and playback state | PlayerRef integration and cleanup tests |
| AC6 | Earlier asset pages remain addable after pagination | Asset library plus reducer integration test |
| AC7 | Inspector values follow selected clip and unsupported typed fields are labelled read-only | Component tests |
| AC8 | Preview renders fit/crop/position, overlay parameters, caption style, and audio fades | Composition tests using trusted fixtures |
| AC9 | Preview authorization matches the single-owner bearer-capability contract and leaks no capability | Signer, route, OpenAPI, and log/error tests |
| AC10 | C1/C2 Prompt Lab, v1 editing, immutable revisions, and operation validation do not regress | Focused and full offline suites |
| AC11 | No new dependency, service, migration, operation kind, or live behavior is introduced | Diff and contract inspection |
| AC12 | Audit trail records original deviations and corrective evidence without rewriting history | Checkpoint, changelog, and git history inspection |

## 12. Operational boundary

Implementation and verification are offline only. They may modify product code,
tests, generated contracts only when the public schema genuinely changes, the
active checkpoint, and `CHANGELOG.md`. They do not authorize push, publication,
deployment, Docker service mutation, database migration against a running
database, real asset or secret access, provider/TikTok/browser live requests,
parity, controlled fallback, evidence mutation, Issue #5 mutation, acceptance
activation, or D2/render work.
