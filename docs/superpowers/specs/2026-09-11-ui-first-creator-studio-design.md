# UI-First Creator Studio Design

**Date:** 2026-09-11  
**Status:** Approved in brainstorming  
**Scope:** Replace the current dashboard editing experience with a UI-first,
browser-based creator workflow while preserving the existing React stack,
Python control plane, Temporal orchestration, and Rust/FFmpeg media engine.

## 1. Context

Thoth currently exposes useful workflow, content-set, profile, and run controls
through separate dashboard views. The underlying capabilities are valuable, but
the current navigation and form-heavy interaction do not form a coherent video
editing product. Creative choices also remain distributed across configuration,
CLI arguments, templates, and hardcoded renderer behavior.

The research in
docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md
recommends Remotion as the initial browser preview and programmable rendering
foundation. It also identifies the key architectural requirement: Thoth, not a
renderer framework, must own a typed and versioned edit document.

This design turns the existing dashboard into a Creator Studio. All creative
work is performed in the UI. Deployment, secret provisioning, worker
maintenance, and other operator duties remain outside the Creator Studio.

## 2. Decisions

1. Keep the existing React 19, Vite, Tailwind CSS, shadcn/Base UI, and Lucide
   frontend stack.
2. Redesign the dashboard experience rather than replace the frontend stack.
3. Use one product-owned EditDocument as the canonical representation of a
   video edit.
4. Use Remotion Player for interactive preview and a Remotion adapter for the
   first programmable renderer.
5. Keep FFmpeg and the Rust media engine for probing, normalization, audio,
   codecs, and existing render compatibility.
6. Treat HyperFrames as a possible future renderer adapter, not as the primary
   editor state model.
7. Support guided and professional workflows through Simple and Advanced modes
   over the same document.
8. Never execute user-authored React, TypeScript, JavaScript, HTML, shell
   arguments, or raw FFmpeg filters.
9. Make every creative decision editable through typed controls. Keep security
   and infrastructure limits internal.
10. Build the system as a sequence of vertical sub-projects rather than one
    editor rewrite.

## 3. Goals

- A user can start with a URL or uploaded asset, generate a draft, edit it,
  review it, and request a final render without using a CLI.
- Automated generation and human editing write the same domain model.
- Prompt templates are editable, versioned, reusable, improvable, and
  translatable through the UI.
- AI regeneration cannot silently overwrite user work.
- Preview and final render consume the same saved edit revision.
- Current discovery, content-set, project profile, workflow monitoring, and
  media-processing capabilities are incorporated instead of duplicated.
- The UI remains approachable for a beginner while exposing a real multi-track
  timeline to an advanced editor.

## 4. Non-goals

- Deployment, environment variables, secrets, or worker administration in the
  Creator Studio.
- User-authored executable templates or arbitrary renderer code.
- Raw FFmpeg flags or the existing extra_args escape hatch in the new editor.
- Real-time multi-cursor editing in the first release.
- A full professional timeline on phone-sized screens.
- Migrating every historical render path before one end-to-end template works.
- Replacing FFmpeg as the final encoding and media utility layer.

## 5. Users and Editing Modes

### 5.1 Guided creator

The guided creator enters through a wizard, accepts sensible defaults, and
edits the generated result as an ordered set of scenes. Technical tracks and
renderer settings remain hidden unless needed.

### 5.2 Advanced editor

The advanced editor can open the same project directly in a multi-track
workspace, make frame-accurate changes, and inspect detailed properties.

### 5.3 One model, two projections

Simple and Advanced mode are UI projections over the same EditDocument.
Switching modes never converts, forks, or flattens data.

Simple mode provides:

- ordered scene cards;
- canvas preview;
- essential copy, media, duration, crop, caption, audio, and style controls;
- move, duplicate, hide, lock, and regenerate actions;
- button and keyboard alternatives for every drag operation.

Advanced mode adds:

- video, B-roll, overlay, caption, narration, music, and SFX tracks;
- trim, split, ripple editing, snapping, and explicit timing;
- animation presets and supported keyframe controls;
- volume envelopes and safe-zone overlays;
- aspect-ratio override editing.

## 6. Information Architecture

The Creator Studio is one persistent workspace rather than a collection of
unrelated dashboard pages.

    +-----------------------------------------------------------------------+
    | Project / save state     Undo / Redo       Preview quality / Export   |
    +-------------+---------------------------------------+-----------------+
    | Sources     |                                       | Inspector       |
    | Assets      |             Video Canvas              |                 |
    | Scenes      |                                       |                 |
    | Prompt Lab  |                                       |                 |
    | Brand       |                                       |                 |
    +-------------+---------------------------------------+-----------------+
    | Scene board in Simple mode / multi-track timeline in Advanced mode    |
    +-----------------------------------------------------------------------+

- The left panel selects sources, assets, scenes, prompts, and brand data.
- The center canvas is the visual focus and contains preview controls.
- The right inspector edits the current selection using schema-derived
  controls.
- The bottom workspace switches between the scene board and timeline.
- Left, right, and bottom panels can be resized or collapsed. Layout preference
  is stored per user.
- Existing workflow monitoring becomes contextual project activity rather than
  a separate primary destination.

## 7. Creation Flow

The new-project wizard creates a draft; it is not the editor itself.

1. Select a source URL or uploaded asset.
2. Select output language and target format.
3. Select a Brand Kit and style template.
4. Review registered prompt stages or accept their defaults.
5. Generate the initial draft.
6. Enter the Creator Studio.

An advanced user may create an empty project or open an existing project
directly in the workspace.

## 8. Domain Model

The system avoids one unbounded JSON object by separating stable concepts.

### 8.1 Project

Owns project identity, access, default language, Brand Kit reference, and active
draft/revision references.

### 8.2 AssetCatalog

Owns immutable asset identifiers, media metadata, provenance, ownership,
validation state, derivatives, and artifact locations. Media bytes are stored
in the artifact store, not in relational records.

### 8.3 EditDocument

Owns creative intent:

- versioned canvas dimensions, frame rate, and duration;
- scenes and their narrative roles;
- tracks and typed clips;
- captions and word/cue timing;
- overlays and trusted component references;
- audio clips and mix controls;
- transitions and supported animation parameters;
- Brand Kit and style-template references;
- per-target aspect-ratio overrides;
- revision and validation metadata.

The first canvas target is 9:16. Horizontal and square outputs are explicit
overrides on the same document rather than independent copies.

### 8.4 PromptTemplate and PromptBinding

PromptTemplate owns a versioned prompt for one registered workflow stage, its
input-variable contract, default language, editable regions, and policy
visibility. PromptBinding owns overrides at project, video, or scene scope.

### 8.5 EditProposal

An AI action produces a proposal containing typed operations and a human-
readable diff. It does not mutate the active document.

### 8.6 EditRevision

An immutable snapshot of a validated EditDocument and all referenced template
versions. Final render jobs always point to a revision, never a mutable draft.

### 8.7 RenderJob

Owns revision identity, renderer/template versions, lifecycle state, progress,
safe diagnostics, output metadata, and output artifact references.

## 9. Editing and Ownership Semantics

All document changes are expressed as typed operations. The same operation
contract supports direct UI edits, undo/redo, autosave, proposal diffs, and
server-side validation.

Each editable entity records one ownership state:

- ai-managed: regeneration may propose a replacement;
- user-edited: regeneration may propose a change but requires explicit review;
- locked: regeneration cannot include a modifying operation for the entity.

Generate, Improve, Translate, and Regenerate create EditProposals. The UI shows
before/after values, affected scenes, and validation impact. A user may apply
selected operations, apply all valid operations, or reject the proposal.

The first release uses one active editor with optimistic concurrency. A stale
save returns a conflict and preserves both the server revision and local draft.
Review comments and approval are supported without real-time co-editing.

## 10. Prompt Lab

Prompt authoring is a first-class project workspace, not one global textarea.
Prompt-capable stages are registered by the backend so the UI reflects the real
pipeline instead of maintaining a second hardcoded stage list.

The initial stage mapping follows the existing workflow boundaries for source
investigation, narrative planning, visual/asset planning, and caption/copy
generation. A stage without an LLM prompt does not appear merely for symmetry.

The resolved prompt is composed in this order:

1. read-only system policy;
2. versioned base template;
3. project override;
4. video override;
5. scene override.

The UI provides:

- stage navigation and version history;
- editable and read-only region distinction;
- typed variable chips with source and missing-value status;
- a resolved-prompt preview;
- reusable template save and restore;
- Improve and Translate actions that return a diff;
- selective application of proposed changes.

Interface language, prompt language, and output language are independent.
Translation always creates a new language variant. It never overwrites the
source text or changes the output language implicitly.

Secrets, hidden policy, provider credentials, and raw provider payloads are not
rendered into the Prompt Lab.

## 11. Configuration Classification

Moving creative editing to the UI does not mean exposing every implementation
constant.

### 11.1 Product-editable

Copy, timing, trim, crop, position, font, color, caption style, volume,
transition, asset selection, animation preset, prompt, and output language must
be editable through typed UI controls.

### 11.2 Template-owned

Scene grammar, allowed component types, default animation, initial layout, and
control ranges belong to trusted versioned templates. Each template exposes a
control schema that drives the Inspector.

### 11.3 System invariant

Security limits, resource ceilings, codec compatibility, filesystem boundaries,
worker timeouts, and isolation policy remain internal.

This classification removes creative hardcoding without turning the UI into a
shell or FFmpeg command builder.

## 12. Technical Architecture

    React Creator Studio
        |
        | generated OpenAPI client
        v
    Python Control Plane / Editor API
        |-- document and prompt validation
        |-- drafts, proposals, revisions, approvals
        |-- optimistic concurrency
        |-- Temporal workflow commands and status
        |
        +--> Application PostgreSQL metadata
        +--> Artifact storage for media and render outputs
        +--> Temporal activities
                |-- existing Python acquisition
                |-- existing Rust/FFmpeg media operations
                +-- TypeScript Remotion render worker

### 12.1 Frontend boundaries

- studio-domain: generated contracts, pure edit operations, selection, and
  undo/redo behavior;
- studio-shell: workspace layout, navigation, mode switching, and save state;
- asset-library: sources, uploads, validation, and replacement;
- scene-board: guided scene editing;
- timeline: advanced time-based editing;
- prompt-lab: prompt bindings, versions, translation, and proposal review;
- remotion-preview: Player integration and playhead synchronization;
- inspector: schema-derived controls for the current selection.

The frontend begins with React state and pure reducers. A new state-management
dependency is added only if profiling or cross-panel behavior demonstrates a
concrete need.

### 12.2 API and persistence

The Python control plane owns the new editor-facing API because it already owns
the durable workflow boundary and generated OpenAPI contract. Editor metadata
uses an application database/schema separate from Temporal internals. Media
bytes remain in the configured artifact store.

Draft saves send typed operations with a base revision. The server validates
scope, authorization, operation order, and the resulting document. It then
increments the draft revision atomically or returns a conflict.

Creating a render first validates and freezes an EditRevision. The render
worker receives only that revision, approved asset references, and trusted
template versions.

### 12.3 Renderer boundary

Remotion is an adapter, not the canonical model. A composition compiler maps an
EditRevision to trusted React components and input props. Remotion Player uses
the same input contract for preview; the worker uses it for final render.

FFmpeg and Rust remain responsible for existing strengths such as probing,
normalization, extraction, audio processing, and compatibility rendering.
HyperFrames can be evaluated later by implementing another compiler against
the same EditRevision.

## 13. Visual System

The visual direction is a professional creative workstation, informed by
Spectrum-style hierarchy without copying Adobe branding.

- dark-first near-black workspace with layered neutral surfaces;
- existing Thoth gold for primary actions and brand identity;
- violet for AI-generated content and proposals;
- blue for selection and the playhead;
- green for saved/success and red only for failure/destructive actions;
- Geist for interface text and monospace only for timecode and technical data;
- compact 4/8-pixel spacing rhythm, small radii, and restrained elevation;
- Lucide icons, with text labels for ambiguous actions;
- no decorative glow, large gradients, emoji controls, or card-heavy layout.

Interaction motion is short and functional, normally 120-180 ms. Pressed and
selection states do not change layout bounds. Reduced-motion preferences are
respected.

## 14. Responsive and Accessible Behavior

- At 1440 pixels and above, the full four-region workspace is visible.
- From 1024 to 1439 pixels, the Inspector or Asset panel becomes collapsible.
- Tablet supports Simple mode, scene editing, preview, captions, Prompt Lab,
  review, and approval.
- Phone supports review, comments, approval, light copy/prompt edits, and render
  monitoring.
- Advanced multi-track editing requires a desktop-sized viewport.

All pointer drag operations have buttons, menus, or keyboard alternatives.
Focus order follows visual order, focus indicators remain visible, and
asynchronous save/proposal status uses an appropriate live region without
moving focus. Text and meaningful controls meet WCAG 2.2 AA contrast. Zoom and
text scaling must not make fixed panels obscure the active control.

## 15. Validation and Failure Experience

Autosave has explicit Saving, Saved, Offline, Conflict, and Failed states.
Errors never disappear only in a transient toast.

Before a revision can render, a persistent Issues panel reports:

- missing or deleted assets;
- invalid clip timing or duration;
- caption overflow and safe-zone violations;
- missing prompt variables;
- unavailable font or language variants;
- incompatible template versions;
- invalid aspect-ratio overrides.

Selecting an issue focuses the affected scene, clip, or field. Render failure
preserves the revision and safe diagnostic record. A retry creates a new render
job and does not mutate the revision.

## 16. Security and Reproducibility

- User input is data validated against typed schemas, never executable code.
- Assets use immutable identifiers and pass probe and normalization policy.
- Renderer jobs use isolated workspaces with bounded resources and restricted
  access.
- Browser, fonts, renderer, component templates, and dependencies are pinned.
- Preview may use lightweight proxies; final rendering uses validated assets.
- Each output records document revision, template version, renderer version,
  asset identities, and checksum provenance.
- Hidden prompt policy and secrets never enter browser-readable responses.

## 17. Delivery Sequence

This architecture is too large for one implementation plan. It is divided into
vertical sub-projects with separate specifications, plans, reviews, and
operator gates.

### A. Document foundation and read-only preview

Define version 1 contracts and persistence, import one existing content-set
into an EditDocument, compile one vertical template, and display it through
Remotion Player. No editing breadth is added yet.

### B. Guided editing core

Add the studio shell, scene board, Inspector controls for the first template,
typed operations, autosave, validation, immutable revisions, and undo/redo.

### C. Prompt Lab and AI proposals

Add stage registry, template/binding versions, resolved preview, Improve,
Translate, selective diff application, ownership states, and locks.

### D. Advanced timeline

Add synchronized multi-track editing, trim/split/ripple behavior, snapping,
audio controls, and keyboard alternatives.

### E. Render queue and output workflow

Add the isolated Remotion worker, revision-bound render requests, progress,
artifact delivery, retry semantics, and render diagnostics.

### F. Responsive review and production rollout

Add tablet/phone review surfaces, golden-frame tests, preview/render parity,
template release gates, and progressive migration from existing render modes.

Each sub-project must leave the current production path operational until its
replacement path passes its own acceptance gate.

## 18. Verification Strategy

- Schema and migration tests for every EditDocument version.
- Reducer tests for operations, undo/redo, ownership, locks, and proposal
  application.
- API tests for autosave, authorization, optimistic conflicts, and immutable
  revisions.
- Contract tests across OpenAPI, generated TypeScript, and renderer inputs.
- Browser tests for the wizard, Simple mode, Prompt Lab, issue navigation, and
  render submission.
- Keyboard-only tests and alternatives for all drag interactions.
- Golden-frame and preview/render parity tests for every released template.
- Media duration, audio, caption bounds, and artifact checksum checks.
- Human visual review before a template becomes a production default.

## 19. Product Acceptance

The end-state is accepted when a user can:

1. start from a source URL or asset through the UI;
2. generate a draft into the canonical EditDocument;
3. edit every creative decision in Simple or Advanced mode;
4. edit, improve, translate, version, and reuse stage prompts;
5. review AI changes as diffs without losing locked or user-edited work;
6. save and restore immutable revisions;
7. preview and render the same revision contract;
8. monitor and retrieve the final result without opening a CLI.

Deployment, secret management, and infrastructure maintenance remain explicit
operator workflows and are not part of this acceptance definition.

## 20. Sources

- Remotion Player documentation:
  https://www.remotion.dev/docs/player
- Remotion Editor Starter documentation:
  https://www.remotion.dev/docs/editor-starter
- Remotion server-side rendering documentation:
  https://www.remotion.dev/docs/ssr
- HyperFrames Studio documentation:
  https://hyperframes.heygen.com/packages/studio
- HyperFrames Player documentation:
  https://hyperframes.heygen.com/packages/player
- Project research:
  docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md
