# Creator Studio F3 UX-First Migration Design

**Date:** 2026-09-24
**Status:** Proposed for written-spec review
**Scope:** Creator Studio only; first `vertical_text_story` path

## 1. Outcome and boundaries

A creator can choose **Open in Studio** from a content set, understand the imported video at a glance, customize its creative choices in the browser, and render a saved edit revision without using a CLI. **Send render** remains the separate legacy-render choice. Opening Studio never silently switches a content set to the new renderer.

F3 is a UX-first continuation of the [parent Studio design](2026-09-11-ui-first-creator-studio-design.md), F2 responsive review, and the existing revision-bound render contract. It redesigns the Creator Studio experience, not Discovery, other dashboard pages, deployment controls, or the frontend stack. The first migration target is the existing `vertical_text_story` Studio template and the legacy path that supplies it. Other legacy modes remain on their current path.

F1 golden promotion, default cutover, live requests, deployment, evidence mutation, and the separate Python Scout migration are not implied by this design.

## 2. Selected visual direction

![Selected dark-canvas Creator Studio direction](2026-09-24-creator-studio-f3-selected-direction.png)

The approved direction is a restrained dark creative workspace: one prominent vertical preview, a compact scene sequence below it, a contextual inspector for the selected scene, and an Advanced timeline that expands only when requested. The same visual language carries through Edit, Prompt, Review, and Render. It must remain legible and navigable at the F2 viewport sizes and at 200% text zoom.

The image establishes hierarchy and tone, **not** a pixel-perfect contract or a list of implemented features. In particular, preview reflects the local draft directly; the pictured “Preview changes” button is not a separate required action. Sample media, copy, avatar, branding, and decorative details are illustrative.

## 3. One Studio, four jobs

The primary navigation is **Edit → Prompt → Review → Render**. These are destinations, not a forced wizard; users can return to an earlier job without losing drafts or selection. The header identifies the project and makes online, saving, saved, unsaved, failed, and conflicted states understandable. It shows the saved revision when a decision or render will bind to it. It does not claim “Saved” while local changes remain unsaved.

- **Edit:** The selected scene determines the visible controls. Simple mode starts with scene order and essential copy, media, duration in human units, captions, audio, and style. Control labels describe creative outcomes rather than internal frame counts or file paths. Advanced mode exposes the existing multi-track timeline on the same EditDocument; switching modes never forks or flattens it. Every drag-only operation has a button or keyboard alternative.
- **Prompt:** Preserve stage-by-stage navigation and the layered policy/template/project/video/scene model. Read-only policy is visibly distinct from editable text. Provider and model selection stay in the UI. Improve and Translate produce a comparison before selective Apply; translation creates a separate language variant. A proposal never overwrites a draft, locked layer, or user-edited work silently.
- **Review:** Show the saved revision and its preview, comments, and current editorial decision. The local unsaved draft is not misrepresented as reviewed. Review is optional before Render; an editorial approval is not render, publication, deployment, or Stage 1 authorization.
- **Render:** Show the exact saved revision and a short readiness checklist. An unmet condition names the affected scene, clip, field, or unavailable capability and offers a route to it where possible. The UI presents job status, safe failure reason, and download in one place. It does not expose internal queues, artifact paths, or secrets as user tasks.

There is one preview/composition source of truth. Other destinations may hide or reposition that preview, but must not create a second independent player or render interpretation.

## 4. Entry, import, and honest limits

The content-set surface keeps two explicit choices: **Open in Studio** and **Send render**. F3 must not rename the legacy action to imply that it uses Studio. Re-entering Studio must surface an existing applicable draft or clearly offer a new one; it must not overwrite a draft or silently replace its revision.

For the first supported path, the import preserves source text, relevant media identities, scene order, and meaningful durations. The Studio presentation and final output need not be pixel-identical to the legacy render. Visual customization through typed UI controls is intentional. An imported element that the Studio document or renderer cannot represent is not dropped: the creator sees what is unsupported and where it came from. Studio Render is blocked until that item is handled; the legacy path remains available. F3 cannot claim the first mode migrated while any creative input used by that mode is silently omitted.

The edit controls exposed for this first path must be real, persisted controls backed by the canonical EditDocument and its validated operations. Do not draw mockup controls that merely look functional. Template-owned choices may offer presets; security limits and system invariants remain internal, not user-authored executable code.

## 5. Responsive and failure behavior

F2's capability boundaries remain: desktop supports Simple and Advanced; tablet supports the permitted Simple editing and review work; phone supports preview, light copy/prompt edits, review, and read-only render monitoring. Narrow viewports present one primary job or pane at a time without duplicating preview or losing unsent text. Unsupported Advanced actions explain that a desktop-width screen is required.

Offline, save failure, conflict, stale revision, unavailable renderer, missing asset, unsupported import, and failed render each have a distinct explanation and recovery path. Keep the user's draft and review text. Never submit a render of an unsaved or conflicted draft. Do not automatically retry a provider, import, or render request. Disabled actions have visible reasons that remain available to keyboard and assistive-technology users; errors are not conveyed only by color or transient toast.

The dark workspace must meet readable text contrast, visible keyboard focus, logical focus order, reduced-motion behavior, accessible preview controls, and no horizontal overflow at the F2 reference widths. The active control must remain reachable at 200% zoom.

## 6. Architecture and delivery constraints

Reuse the existing React/Vite stack, EditDocument, editor operations, one Remotion preview, Prompt Lab, review resources, and revision-bound render APIs. F3 may reorganize Studio components and styling where that directly improves this experience. It does not introduce a second editor model, a new renderer, a parallel mobile editor, or an application-wide dashboard redesign. Creative output paths continue under the existing centralized artifact root contract.

Implementation should be planned as testable vertical slices: establish the shared shell and navigation; make the first-mode import and real controls honest; join readiness and render feedback to the same experience; then perform browser and contract verification. The plan must identify the exact legacy source path before modifying its mapping and preserve the legacy action throughout. Any release promotion or cutover requires a later operator gate.

## 7. Acceptance evidence

Offline tests and browser checks must demonstrate that a creator can:

1. Distinguish Open in Studio from Send render, return to a draft without an overwrite, and see any unsupported imported element before rendering.
2. Select, reorder, and edit scenes through Simple controls while the single preview reflects the draft; enter and leave Advanced without data conversion or loss.
3. Edit a stage prompt, compare a proposed change, and explicitly Apply only selected changes without clobbering unsaved text.
4. Review the saved revision, leave review optional, and start Studio Render only for a valid saved revision.
5. Locate a specific blocking issue from Render, recover from offline/conflict/failure without losing work, and monitor or download the resulting job in the UI.
6. Complete the permitted tasks by keyboard at desktop, tablet, and phone reference widths, with visible focus and no concealed active control at 200% zoom.

The first-mode import requires contract tests for preserved content, media identities, order, and duration, plus a negative test proving unsupported input blocks Studio Render without blocking the legacy path. Preview/render parity retains its separate F1 release gate; passing F3 UI tests does not promote a golden or authorize deployment.
