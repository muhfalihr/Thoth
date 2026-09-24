# Creator Studio F2 Responsive Review Design

**Status:** Proposed for written-spec approval

## 1. Purpose and boundary

F2 makes Creator Studio usable for editing and review away from a desktop without creating a second editor. The desktop workspace remains the full editing surface. Tablet users can perform Simple-mode scene, copy, caption-text, Prompt Lab, preview, review, and approval work. Phone users can preview, comment, approve or request changes, make light copy and prompt edits, and monitor renders. Advanced multi-track editing remains a desktop operation.

F2 is product work, not an F1 release gate. It may be implemented and tested offline while F1 golden promotion and publication remain deferred. F2 does not promote an F1 golden, push, deploy, run a live provider request, or open an acceptance window. Studio approval is an editorial decision on a saved document revision; it is not Stage 1 operator approval, workflow approval, render authorization, publication, or deployment approval.

## 2. Existing seams and gaps

- `GuidedStudio` owns one edit reducer, autosave/conflict behavior, Scenes and Prompt Lab workspaces, preview, timeline, inspectors, and render panel. At narrow widths it currently stacks desktop regions vertically.
- `StudioPreview` and the isolated renderer use the existing document/composition contract. F2 reuses the preview; it does not fork composition or render behavior.
- The current Simple inspector edits heading/body and duration. Caption cues are displayed read-only in `TimelineInspector`; a tablet caption-text editor therefore needs a typed document operation and server validation, not a CSS-only change.
- Existing workflow approval endpoints do not approve Creator Studio documents. No Studio comment or approval resource exists yet. F2 adds project/document-scoped review resources rather than reusing the workflow endpoint.
- Render jobs already have a revision-bound public client and status model. Phone monitoring reuses that model without exposing internal artifact paths.

## 3. Adaptive workspace

The same `GuidedStudio` document, reducer, selected scene, save status, and Prompt Lab state serve every viewport. Layout changes never silently dispatch a document edit or change the saved editor mode.

| Viewport width | Surface | Available work |
| --- | --- | --- |
| 1440 px and wider | Four-region workspace | Existing full Simple and Advanced editing. |
| 1024–1439 px | Desktop workspace with collapsible side regions | Existing full editing, including Advanced; side regions can be opened without obscuring active controls. |
| 768–1023 px | Tablet workspace with one primary pane at a time | Simple scenes, preview, copy, caption text, Prompt Lab, review, approval, render status and permitted Simple-mode render actions. |
| Below 768 px | Phone review workspace | Preview, comments, approval/request changes, heading/body and saved prompt-text edits, and read-only render monitoring. |

The compact workspace uses labeled navigation between existing functions, not a second document implementation or duplicate mounted previews. Pane switches preserve unsaved drafts and current selection. The selected pane remains discoverable to keyboard and assistive-technology users. When the viewport contracts while Advanced mode is active, compact layouts offer review and permitted light edits without rewriting the stored mode or exposing multi-track controls; returning to desktop restores the Advanced workspace. Unsupported actions explain that desktop is required instead of silently disappearing.

Widths are CSS viewport widths, not device detection. Orientation and zoom can change the applicable layout. There is no horizontal page scroll at a 375 px viewport; intentionally scrollable media strips, if any, have labeled controls and do not trap page navigation. A compact header keeps project navigation and the persistent Saved/Unsaved/Offline/Conflict/Failed status visible. Width sliders appear only where side regions exist.

## 4. Tablet caption and phone light-edit scope

Tablet caption editing changes cue **text** on an existing caption clip. It does not change cue timing, clip timing, track order, style slots, or ownership. The operation identifies document revision, caption clip, cue index, and replacement text; the server checks that the clip/cue still exists, validates length and resulting document, and applies the operation through the existing revision/conflict path. Preview reflects the local draft; render still binds a saved revision. Phone shows captions for review but does not edit cue timing or text.

Phone copy edits reuse the existing heading/body operations and autosave/conflict handling. Phone prompt editing is limited to the existing saved template/override text flow; proposal generation, comparison/Apply, lock administration, and provider configuration are not added to the phone surface. Tablet Prompt Lab may retain its existing capabilities. F2 does not add a mobile-specific document format, offline mutation queue, or new renderer settings.

## 5. Review model and API

A comment is a project/document-scoped, immutable plain-text record with an opaque ID, authenticated actor, creation time, saved document revision, and optional frame anchor. A document-level comment has no frame. A frame anchor must be within the saved revision's frame range. The UI presents the corresponding timecode and identifies historical comments when the latest revision moves on. First release has a flat chronological comment list; it does not add replies, reactions, editing, deletion, presence, or real-time co-editing.

A decision is an append-only record for a saved revision: `approved` or `changes_requested`, with actor, time, opaque ID, and optional plain-text reason. The latest decision on the latest saved revision is the current editorial state. Saving a new document revision makes the older decision historical; it never mutates or deletes that record. Comments do not themselves change the decision. No decision automatically starts a render, publishes output, or changes Stage 1 evidence.

Public endpoints under `/api/v1/projects/{project_id}/edit-documents/{document_id}` list and create review comments, and read and create review decisions. Lists are bounded and paginated. Mutations carry the expected saved revision and a caller-generated idempotency key. The server authenticates the actor using the existing API dependency, checks project/document ownership, and performs revision check plus insert atomically. A stale revision returns a typed 409 with safe latest-revision facts; repeating the same key and body returns the original record, while key reuse with a different body conflicts. The API never accepts a client-supplied actor or internal path.

This first release follows the repository's current actor authentication. It does not claim independent-reviewer separation or introduce a new role system. If independent approver policy becomes a requirement, that is a separate authorization design. UI visibility is not an authorization boundary; server checks remain authoritative.

## 6. Review interaction and failure behavior

The review pane renders the **saved** document revision, not an unsaved local draft, and pairs that preview with comments and the current saved-revision decision. A reviewer may anchor a comment at that preview's current frame or leave it document-level. Before posting or deciding, the UI shows which saved revision will be affected. Approve and Request changes are distinct, labeled actions with confirmation of the revision; their success state comes from the server response, not optimistic UI state.

Review mutations are disabled while offline, while the document has unsaved changes or a save conflict, or while another review mutation is pending. Approval is additionally disabled when the saved document has blocking validation issues. A stale response preserves the typed comment or reason locally, displays the newer revision, and requires explicit user resubmission; there is no automatic retry or silent rebasing. Network failure also preserves input and exposes Retry as an explicit action. Navigation or viewport changes must not discard unsent review text. Read-only historical comments and decisions remain visible when available.

Phone render monitoring shows status, progress, safe failure code, and available download action through existing public capabilities. It does not start, retry, cancel, or clean up jobs. A missing render capability or disconnected state has an explicit non-destructive explanation.

## 7. Accessibility and visual behavior

Compact navigation uses semantic buttons/tabs with visible labels, selected state, and a predictable focus destination after switching panes. Focus order follows visual order; closing any collapsible region returns focus to its trigger. Sticky bars do not cover focused controls or errors. Pointer gestures have button/keyboard alternatives. Small-screen controls have usable touch areas, and status changes use appropriate live regions without moving focus unexpectedly.

Preview is click-to-play, does not autoplay off-screen, retains captions and pause controls, and respects reduced-motion preferences. Text zoom to 200% must not hide an active control. Both themes keep meaningful text and focus indicators legible. Reuse the existing Studio tokens, typography, and restrained visual language; F2 is a layout and interaction expansion, not a new visual brand.

## 8. Validation and delivery gates

Tests cover viewport/pane navigation at 375 px, tablet portrait and landscape, 1024 px, and 1440 px; preservation of drafts, selections, Advanced mode, and Prompt Lab edits across pane/viewport changes; no duplicate preview/network work; caption-text operation validation and revision conflict; project isolation, actor attribution, idempotency, pagination, and stale review writes; approval invalidation on a newer saved revision; offline and failure recovery; keyboard/focus and visible status; and phone render monitoring without mutation controls.

Use focused RED→GREEN tests for new behavior, then the repository's relevant non-live Python/dashboard checks, generated OpenAPI/client stability, lint/build, and mandatory CUDA build as specified by `AGENTS.md`. Do not claim visual usability from unit tests alone: inspect the compact UI in a browser at the stated widths before handoff. No live provider/TikTok request, real asset access, deployment, push, or operator approval-record mutation is part of implementation verification.

## 9. Out of scope

Real-time collaboration, reviewer roles, comment threads, attachment uploads, offline write queue, phone Advanced editing, caption timing/style editing, mobile render mutations, notification delivery, publication gates, F1 golden promotion, and F3 progressive migration are excluded. The next implementation plan should sequence the responsive shell and review contract as tested vertical slices without introducing a parallel editor or a second preview/render source of truth.
