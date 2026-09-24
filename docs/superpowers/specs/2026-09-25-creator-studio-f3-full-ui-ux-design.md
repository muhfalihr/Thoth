# Creator Studio F3 — Full UI/UX Design

**Date:** 2026-09-25
**Status:** Proposed for operator review
**Scope:** The F3 Creator Studio experience only — the dark four-job workspace
shipped by Plan A plus the first-mode migration surfaces defined by Plan B
(`docs/superpowers/plans/2026-09-25-creator-studio-f3-first-mode-migration.md`).
No other dashboard view, no second editor model, no new renderer surface.

## 0. Relationships

This document is the single visual-and-interaction contract for F3. It
implements the approved F3 design
(`2026-09-24-creator-studio-f3-ux-first-migration-design.md`), refines the
visual direction selected in
`2026-09-24-creator-studio-f3-selected-direction.png`, and sits under the
parent Studio design (`2026-09-11-ui-first-creator-studio-design.md`) and F2
responsive design (`2026-09-24-creator-studio-responsive-review-design.md`).
Where those documents set behavior, this one fixes pixels, states, and
keyboard behavior. Plan A already shipped the shell, job navigation, scene
strip, seconds-based duration, and scoped dark tokens; this design keeps those
contracts and specifies what Plan B adds.

### Method note (ui-ux-pro-max)

The `ui-ux-pro-max` dataset was searched for a matching design system
("video editing creator studio dark professional workstation", then the
narrower "pro app video editor productivity tool dark neutral", density 8–9).
No verified match exists: the dataset's pattern and palette rows are
landing-page oriented, and its suggestions (scroll-storytelling pattern, teal
marketing palette, Inter) conflict with the operator-approved direction and
the shipped Geist-based token system. Per the skill's contract those results
are **not persisted**. What was adopted from it is clearly labeled general
guidance: focusable error summaries with per-field links, visible focus in
dialogs, 4.5:1 text contrast, reduced-motion respect, vector icons only, and
44 px minimum touch targets on compact surfaces. The design system below is
anchored on the operator-approved mockup and the tokens Plan A already
shipped in `dashboard/src/features/studio/studio.css`.

## 1. Design principles

1. **One preview, one truth.** Exactly one mounted `StudioPreview`. Edit shows
   the local draft; Review shows the saved revision; every other destination
   repositions or hides that same player. No surface may imply a second
   render interpretation.
2. **Jobs, not a wizard.** Edit → Prompt → Review → Render are destinations.
   Any job is reachable at any time; switching never discards drafts,
   selection, or unsent text.
3. **Honest controls only.** Every visible control performs a real,
   persisted, revision-bound operation. If Plan B does not back it, it is not
   drawn. Unsupported inputs are named, not hidden; exclusions stay visible.
4. **Creator language.** Labels describe creative outcomes ("Duration
   (seconds)", "City loop · ready"), never frame counts, file paths, or queue
   internals. Monospace appears only for timecode, duration, and revision ids.
5. **Keyboard parity.** Every operation has a button or keyboard path; drag is
   progressive enhancement. Focus order equals visual order; focus is always
   visible.
6. **Status is text, not color.** Save/readiness states pair a word with a
   tone; failures persist in banners with recovery actions, never a toast.
7. **Dense but calm.** A professional workstation density (4/8 rhythm,
   compact controls) with restrained motion and one warm accent. No glow, no
   gradients, no decorative media.

## 2. Design system

### 2.1 Color tokens

Plan A shipped the scoped `.studio-shell` token block. Plan B keeps every
existing value unchanged and appends the tokens marked **new**. Global status
tokens (`--status-*`) cascade in from `:root` and are reused, not redefined.

| Token | Value | Role | Notes |
| --- | --- | --- | --- |
| `--background` | `#18191b` | Workspace canvas | Warm charcoal, shipped |
| `--card` | `#242628` | Panels (header, inspector, strips) | Shipped |
| `--studio-well` **new** | `#101113` | Preview/timeline recess | Makes the 9:16 stage and timeline read as a "well"; ~13.9:1 with `--foreground` |
| `--studio-raised` **new** | `#2a2c2e` | Menus, popovers, dialog surfaces | One step above `--card` |
| `--foreground` | `#f5f3ee` | Primary text | ~13.9:1 on well, ~11.8:1 on card |
| `--muted-foreground` | `#c5c6c7` | Secondary text | ~8.9:1 on card — passes AA at all sizes |
| `--primary` | `#d49a79` | Terracotta: CTA, selection, active | ~6.9:1 on background as text |
| `--primary-foreground` | `#1b1918` | Text on terracotta | ~7.6:1 |
| `--ring` | `#efb28e` | Focus ring | 2 px, always visible |
| `--accent` | `#3b3532` | Hover surface | Shipped |
| `--border` | `#47494a` | 1 px hairlines | Shipped |
| `--studio-ai` **new** | `#af87ff` | AI-touched content, proposals | Brand violet already used dashboard-wide; distinct from terracotta |
| `--studio-playhead` **new** | `#82b1e8` | Playhead + timeline ruler caret | Soft blue per parent design §13; distinct from cyan "running" and terracotta selection |
| `--status-succeeded` | `#d7af5f` | Saved/ready/attached | Inherited; gold supersedes the parent design's "green success" — the shipped CLI-mirrored palette is authoritative |
| `--status-failed` | `#ef4444` | Failures, unresolved import | Inherited |
| `--status-running` | `#22d3ee` | Active render job | Inherited |
| `--status-queued` | `#8b8794` | Pending | Inherited |
| `--status-cancelled` | `#6f6b78` | Excluded/cancelled | Inherited |

Import dispositions map to status tokens, never to new hues:
`unresolved → --status-failed`, `attached → --status-succeeded`,
`excluded → --status-cancelled`. Color never carries the meaning alone; every
disposition also has a word ("Unresolved", "Attached", "Excluded").

Contrast pairs to verify at review time: foreground/well, foreground/card,
muted-foreground/card, primary/background, primary-foreground/primary,
status-failed/card (small red text must sit on `--studio-raised` chips, where
it clears 4.5:1), ring/card.

### 2.2 Typography

Geist Variable (shipped) for everything; `font-mono` for timecode, durations,
and revision identifiers only.

| Role | Spec | Used by |
| --- | --- | --- |
| Section label | 11 px / 600 / mono / uppercase / +0.16em tracking / muted | "SCENES", "INSPECTOR", "READINESS", "SOURCE INVENTORY" |
| Dialog title | 16 px / 600 | Import gate title |
| Header title | 14 px / 600 | Project/revision line stays 12 px mono |
| Body | 14 px / 400 | Paragraphs, list rows |
| Secondary | 12 px / 400 / muted | Card meta, hints, reasons |
| Control label | 14 px / 500 | Inspector field labels |
| Scene heading | 14 px / 500 / truncate | Scene cards |
| Timecode/duration | 12 px / mono | Scene cards, timeline ruler, jobs |

No text below 11 px. At 200% zoom nothing may clip: inspector and gate use
the 4/8 grid, so text growth wraps rather than overflows.

### 2.3 Spacing, radius, elevation

- **Rhythm:** 4/8 dense. Panel padding 16, control gaps 8, section rhythm 20
  (the shipped `space-y-5`), strip card padding 12.
- **Radius:** `rounded-md` (6 px) for cards, inputs, buttons; `rounded-sm`
  for chips and badges; `rounded-lg` (8 px) only for the preview well and the
  import-gate dialog.
- **Elevation is borders, not shadows:** 1 px `--border` hairlines separate
  regions. `--studio-raised` surfaces may add one soft shadow
  (`0 8px 24px rgba(0,0,0,.4)`); the workspace itself never does.
- **Z-map:** workspace 0 → preview overlay controls 10 → popovers/menus 20 →
  import gate dialog 30. Banners are in-flow under the header (never sticky
  over content), so nothing can obscure focus.

### 2.4 Controls and targets

- Desktop controls: 36 px min height, 8 px horizontal padding.
- Compact (tablet/phone) controls: 44 px min height (the shipped `min-h-11`
  on nav buttons), full-width rows in the inspector.
- Primary action (one per surface): terracotta fill, `--primary-foreground`
  text. Secondary: bordered `--card` button. Destructive (Exclude, Cancel
  job): bordered, `--status-failed` text; never filled red.
- Disabled controls keep 40% opacity, `cursor-not-allowed`, and a visible
  reason text or `aria-describedby` — a disabled state without a reason is a
  defect (F3 spec §5).

### 2.5 Iconography

Lucide (shipped stack), 16 px inline / 20 px standalone, 1.5 px stroke,
currentColor. Icons are decorative next to a visible label
(`aria-hidden="true"`); icon-only buttons carry `aria-label` and expose
pressed/expanded state. Media-role glyphs: `film` (footage/main), `image`
(stills), `audio-lines` (audio), `type` (text), `captions` (caption cues).
No emoji, ever.

### 2.6 Motion

| Transition | Duration/easing | Notes |
| --- | --- | --- |
| Hover/selection color | 150 ms ease-out | Opacity/color only; no bounds change |
| Pressed feedback | Background tint within 100 ms | Never shifts layout |
| Job/pane switch | Instant (`hidden`) | Player pauses when hidden; no fade |
| Attach/exclude state change | 150 ms color | Row stays in place; no reflow animation |
| Saving indicator | CSS pulse 1.2 s | Disabled under `prefers-reduced-motion` |

The shipped `prefers-reduced-motion` override in `studio.css` already maps
every animation to 0.01 ms; new components inherit it and add nothing that
transforms layout.

## 3. Layout anatomy

### 3.1 Full desktop (≥ 1440 px) — Simple mode

```
+-------------------------------------------------------------------------------------------------+
| [< Back]  [Edit][Prompt][Review][Render]   [Undo][Redo]   [Simple|Advanced]    Project p-182    |
|                                                                              Rev 3 · Saved ●   |
+=================================================================================================+
|                                                       |  INSPECTOR (19 rem)                    |
|                 PREVIEW STAGE  (--studio-well)        |  SCENE 02 — "City loop"              |
|                 +------------------+                  |  Heading  [______________________]   |
|                 |    9:16 player   |                  |  Body     [______________________]   |
|                 |                  |                  |  Media    City loop · ready [Replace]|
|                 |                  |                  |  Duration [5    ] seconds            |
|                 +------------------+                  |  Captions 2 cues            [Edit]   |
|                 Space to play/pause                   |  Audio    ambient.mp3 [vol] [Mute]   |
|                                                       |  Style    [Bold center        v]     |
|                                                       |  Ownership [AI managed         v]    |
+-------------------------------------------------------+-----------------------------------------+
| SCENES                                                     (strip scrolls horizontally)        |
| [01 Hook 5s] [02 City loop 4s ↑↓] [03 Proof 6s] [04 CTA 3s] [05 …]                                |
+-------------------------------------------------------------------------------------------------+
```

Grid: column 1 = preview (row 1) + scene strip (row 2, auto height); column 2
= inspector spanning both rows. The strip belongs to Edit only; Prompt, Review,
and Render reclaim the full width for their own surfaces. Review overlays a
chip above the stage: "Reviewing saved revision 3".

### 3.2 Full desktop — Advanced mode

```
+------------------+--------------------------------------+---------------------------+
| ASSETS (14 rem)  |        PREVIEW STAGE (well)          | TIMELINE INSPECTOR (19rem)|
| [Upload]         +--------------------------------------+  selected clip properties |
| ready assets     | TIMELINE  [- zoom +] [snap]  ruler   |                           |
| (project list)   | video   |====[clip]====|====[clip]==|                           |
|                  | text    |==[clip]==|                                                 |
|                  | caption |==[cue]==|====[cue]====|    |                           |
|                  | audio   |======[music bed]======|    |                           |
|                  | ISSUES (0 blocking)                 |                           |
+------------------+--------------------------------------+---------------------------+
```

Track rows are 40 px lanes on `--studio-well` with 1 px separators. Clip
fills are role tints at 20% (media → terracotta, text → neutral
`--muted-foreground`, caption → `--studio-playhead`, audio → `--studio-ai`),
selected clip bordered `--primary` (shipped behavior). Playhead is a 1 px
`--studio-playhead` line with a ruler caret. The ruler is mono 12 px with
second ticks. Advanced stays desktop-only; compact screens explain why
(shipped message).

### 3.3 Compact desktop (1024–1439 px)

Same anatomy; both side regions (Advanced assets, inspector) become
collapsible via the shipped header toggles, with the shipped width sliders.
Collapsed regions never overlay content; reopening returns focus to the
toggle (F2 rule).

### 3.4 Tablet (768–1023 px)

Header wraps to two rows (Back + jobs; then status). The shipped
`CompactStudioNav` (Scenes / Preview / Controls) appears under the header
during Edit; one pane at a time. Scene strip and inspector become full-width.
Simple mode only; Preview defaults; duration, captions, audio, and style
controls remain available (Plan B makes them real operations); Advanced is
explained as desktop-only.

### 3.5 Phone (< 768 px)

```
+---------------------------+
| [< Back]          Rev 3 ● |
| [Edit][Prompt][Rev][Rend] |
+---------------------------+
| [Scenes][Preview][Control]|
+---------------------------+
| Preview (min-height 288px)|
|                           |
+---------------------------+
```

Phone keeps: preview, heading/body text edits, Prompt Lab text editing,
review reading/commenting, and read-only render monitoring (no start, retry,
cancel, or cleanup controls — shipped `monitorOnly`). Ownership, duration,
captions, audio, and style editing are hidden, not disabled-noise, per F2.

## 4. Header and global status

### 4.1 Header (shipped structure, finalized visuals)

Back (disabled while unsaved/offline, reason in `sr-only`) → job nav →
Undo/Redo → mode toggle (desktop, v2 documents) → panel toggles (compact
desktop) → right-aligned status block: `Project {id} · Saved revision {n} ·
{status}` in 12 px mono. The status block is `aria-live="polite"`.

### 4.2 Save-state vocabulary (one word + one tone + one behavior)

| State | Text | Marker | Extra UI |
| --- | --- | --- | --- |
| saved | "Saved" | gold dot (`--status-succeeded`) | none |
| dirty | "Unsaved changes" | hollow dot (muted) | Back disabled |
| saving | "Saving" | pulsing dot | none |
| failed | "Failed" | red dot | Banner + Retry (shipped) |
| conflict | "Conflict" | terracotta dot | Banner: Reload Latest / Keep Editing Locally (shipped) |
| offline | "Offline" | muted dot | Banner: edits kept, save resumes (shipped) |

Banners sit in flow under the header, `role="alert"` for failed/conflict,
`role="status"` for offline, and persist until resolved.

## 5. Component specifications

Each spec lists: purpose, anatomy, behavior, states, and the persisted
operation behind every control (honest-UI mapping). "Shipped" = Plan A.

### 5.1 StudioJobNav (shipped; visual refinement specified)

Four native buttons Edit/Prompt/Review/Render, `aria-current="page"`,
`min-h-11`. Shipped style: accent pill on the active job. **Final target:**
active job keeps 600 weight and gains a 2 px terracotta underline
(`box-shadow: inset 0 -2px 0 var(--primary)`) matching the approved mockup;
inactive jobs stay quiet. Purely presentational — no test-visible behavior
change; adopt during any Plan B task that touches the header, not as a
standalone task.

### 5.2 StudioImportGate (new — Plan B Tasks 2/5)

The dialog opened by **Open in Studio** in the content-set surface. It has
two stages in one dialog; Esc/Close never creates anything.

**Stage 1 — Draft choice**

```
+=======================================================================+
| Open in Studio — Neon Nights teaser                        [Close]   |
+=======================================================================+
| DRAFTS FOR THIS SOURCE                                                |
| ( ) Draft · revision 3 · saved 24 Sep 18:02 · 2 items unresolved     |
| ( ) Draft · revision 1 · saved 23 Sep 09:14                          |
|                                                                       |
|                          [ Create new draft ]                         |
+=======================================================================+
```

- Inspection (the `inspect` call) never writes. The list is read-only
  radio-style rows (native radio semantics); each row shows saved revision,
  save date, and unresolved count in secondary text.
- **Resume** = opening the selected draft's row (double-click/Enter or a
  row-level button). **Create new draft** is a separate primary-outline
  button with its own idempotency key per click; an explicit retry reuses
  the key (Plan B Task 5 contract).
- Empty state: "No drafts for this source yet." + Create as the only action.
- Offline: dialog stays, choices disabled, status text "Offline — reconnect
  to list drafts."; local choices already made are preserved.

**Stage 2 — Source inventory (after Resume or Create)**

```
| SOURCE INVENTORY — what this Studio edit contains                     |
| #  Role          Source            Status        Actions              |
| 1  Main footage  neon-nights-main  ● Unresolved  [Attach…] [Exclude]  |
| 2  Footage       city-loop         ● Unresolved  [Attach…] [Exclude]  |
| 3  Footage       react-closeup     ● Unresolved  [Attach…] [Exclude]  |
| 4  Footage       skyline-drone     ● Unresolved  [Attach…] [Exclude]  |
| 5  Image         poster-frame      ● Unresolved  [Attach…] [Exclude]  |
| 6  Text scenes   6 ordered scenes  ✓ Imported    —                    |
| Unsupported fields: crop focal rect (image 5) · 2 comments            |
+-----------------------------------------------------------------------+
| 5 items need media before Studio Render      [ Continue in Studio ]   |
+-----------------------------------------------------------------------+
```

- One row per ordered source item: index, role, safe title, disposition
  word + tone dot, and row actions. Context-only items (6) are listed, not
  fabricated into scenes.
- **Attach…** opens a `--studio-raised` popover menu with the two real
  routes only: **Upload file** (streams to the artifact root; progress row;
  cancel aborts and cleans up) and **Choose a ready asset** (project-scoped
  ready list with kind icons). Choosing either resolves the row in place to
  "Attached · {asset name}". No URL or path field is ever shown.
- **Exclude** asks nothing; the row immediately becomes
  "Excluded · ~~react-closeup~~" (muted, struck, actions collapse to
  **Undo exclude** until the dialog closes). Exclusions stay listed forever —
  visible in the gate, the Render checklist, and the import summary.
- The footer is a live count ("5 of 10 items unresolved") plus
  **Continue in Studio**, which is always enabled: editing may proceed with
  unresolved items; only Studio Render is blocked.
- Validation failures surface as a focusable error summary at the top of the
  dialog (`role="alert"`, focus moved to it, one link per failed row) with
  inline row reasons retained — the adopted ui-ux-pro-max error-summary
  pattern; never a toast.
- Dialog mechanics: `role="dialog"` `aria-modal`, initial focus on the first
  draft row (or Create), focus trapped, Esc closes without side effects,
  focus returns to the trigger. Raw URLs, Windows paths, and artifact
  locators never appear in any row, response, or log (Plan B security
  contract).
- Phone: the dialog becomes a full-screen sheet; rows stack (title line +
  status line + action row); the attach popover becomes a bottom sheet.

### 5.3 SceneBoard (shipped; Plan B Task 4 adds reorder + media truth)

Horizontal strip of 160 px cards under the preview (desktop) or a full-width
list (compact Scenes pane).

Card anatomy (top to bottom):

```
+-----------------------------+
| City loop              [film]|   heading (first text clip, shipped) + role glyph
| footage · user edited        |   role (capitalize) + ownership (shipped)
| 4s              [↑] [↓]      |   mono duration + reorder (selected card only)
+-----------------------------+
```

- Heading resolution, selection (`aria-pressed`), role, ownership, and mono
  seconds are shipped behavior and stay.
- **Reorder (new):** the selected card reveals two 32 px icon buttons,
  **Move earlier** / **Move later** (`aria-label`s, disabled at the ends,
  reasons in `title`/`sr-only`). They dispatch the persisted
  `reorder_scene` operation; the strip re-renders from the saved shape and
  focus stays on the moved card's button. Drag reordering may be added later
  as enhancement only — the buttons remain.
- **Media truth:** a scene whose first clip is media shows the role glyph
  (film/image/audio) instead of a fabricated thumbnail. Scenes carrying an
  unresolved import item show a small red dot on the card corner; activating
  it opens the import inventory focused on that item.
- No Add Scene control exists in F3 (not backed by an operation).

### 5.4 Inspector — Simple mode (shipped fields + Plan B Task 4A sections)

Right dock (desktop) or Controls pane (compact). Section labels use the
mono-uppercase style; every field commits explicitly (blur/Enter/button),
never per keystroke.

| Section | Control | Persisted operation | Notes |
| --- | --- | --- | --- |
| Heading | text input, 300 chars, required | `edit_text` | Shipped; inline error + `aria-describedby` |
| Body | textarea, 2000 chars | `edit_text` | Shipped |
| Media | status line + **Replace…**/**Resolve import…** | resolve endpoint (`attach_asset`) | New; status line names the attached ready asset or the unresolved item |
| Duration | seconds input w/ inline error | `edit_duration` | Shipped (`DurationField`: parse → frames, explicit commit) |
| Captions | cue list (mono range + text) + **Add caption** + inline cue-text edit | `add_caption_clip`, `set_caption_cue_text` | New; timing stays Advanced-only (F2 scope) |
| Audio | attach control + volume slider (0–100) + **Mute** toggle | `add_clip_from_asset`, `set_clip_volume`, `set_track_muted` | New; disabled with reason when no audio clip is attached |
| Style | select of allowlisted style slots | `set_text_style_slot` | New; only slots with a real renderer effect in the composition contract; unknown IDs rejected with a visible reason |
| Ownership | select ai/user/locked | `edit_ownership` | Shipped; hidden on phone |

- A media-first scene still exposes its **first text clip** for
  Heading/Body (Plan B Task 4 requirement); the Media section explains whose
  pixels the scene shows.
- Phone (`textOnly`): Heading + Body only, full-width 44 px fields.
- Section-level failures (stale revision, locked clip, unavailable audio)
  render as inline `role="alert"` text within the section and disable only
  the affected control.

### 5.5 Preview stage (single player — shipped)

`--studio-well` recess, `rounded-lg`, centered 9:16 player, minimum height
288 px on compact (shipped). One `StudioPreview` instance for the whole
studio (shipped, preserved — the file is operator-owned). Click-to-play;
"Space to play/pause" hint in secondary text; player pauses whenever its
pane is hidden. Review shows the saved revision with the
"Reviewing saved revision N" chip; Edit shows the draft. No
"Preview changes" button exists (spec §2).

### 5.6 Advanced timeline (shipped; token alignment only)

Anatomy per §3.2. Existing interactions (select, move/trim gestures with
pointer, arrow-key nudge, zoom, snapping, issues panel) are unchanged; Plan B
adds scene reorder at the scene level, not extra timeline gestures. Clip
labels read `<track> clip` (shipped); with Plan B the label gains the source
title when one is attached ("footage clip · city-loop"). Locked clips show
"· locked" and disable handles (shipped).

### 5.7 Prompt Lab (shipped; destination styling only)

Occupies the full workspace when the Prompt job is selected. Read-only
policy regions render on `--studio-well` with a lock icon; editable regions
are standard bordered inputs. Proposals and AI-authored regions use
`--studio-ai` left-border accents. Compare-then-Apply behavior, provider
selection, and stage navigation are shipped and untouched by this design;
only token alignment (backgrounds, focus ring, 44 px targets on compact)
applies.

### 5.8 Review panel (shipped)

Beside the shared preview (desktop) or full pane (compact). Comments list
(mono revision tag + actor + text), frame-anchored comments show their
timecode, decision actions **Approve** / **Request changes** with
confirmation of the affected saved revision. Mutations disabled while
offline/unsaved/conflicted with visible reasons (shipped). Historical
comments dim to secondary text when a newer revision exists.

### 5.9 RenderPanel (shipped gate; Plan B Task 6 readiness design)

```
| RENDER · saved revision 3 · vertical_text_story v4                     |
| Readiness                                                              |
|  [✓] Text complete                                                     |
|  [✓] Timeline valid                                                    |
|  [!] Import — 2 unresolved items (Scene 3 "react-closeup", Scene 4)    |
|       [Resolve import]                                                 |
|  [!] Unsaved changes                                                   |
|       [Save and review]                                                |
|  [ Start Studio render ]   ← disabled while any check fails            |
|  Reason line: "Resolve 2 import items before rendering revision 3."    |
| Recent jobs                                                             |
|  #12 succeeded 24 Sep 18:31 · vertical_text_story           [Download] |
|  #11 failed 24 Sep 17:02 · renderer_unavailable            [Details]   |
```

- The checklist mirrors server authority (unresolved items, stale revision,
  asset readiness, renderer capability); a disabled button is never the only
  guard (server re-checks in the render-creation transaction).
- Each failing row names the affected scene/source and offers a route:
  **Resolve import** reopens the inventory on that item; **Save and review**
  switches to Edit. Safe failure codes render as human phrases with a
  Details expander for the safe diagnostic text; no queue ids, paths, or
  secrets.
- Job rows: mono job id, status word + tone, template name, timestamp, and
  one action (Download / Details / Retry for user-attributable failures).
  Phone strips every action except Download (monitor-only).
- Legacy **Send render** stays on the content-set surface, unchanged and
  clearly separate from Studio render.

### 5.10 IssuesPanel (shipped)

Stays under the Advanced timeline; blocking issues use
`--status-failed` text and focus the affected clip on activation. Simple
mode surfaces the same facts through the Render checklist instead.

## 6. Responsive capability matrix

| Capability | ≥1440 | 1024–1439 | 768–1023 | <768 |
| --- | --- | --- | --- | --- |
| Preview (one player) | ● | ● | ● | ● |
| Job navigation | ● | ● | ● | ● |
| Simple text/duration/ownership | ● | ● | ● | text only |
| Scene reorder buttons | ● | ● | ● | — |
| Captions/audio/style controls | ● | ● | ● | read-only none |
| Advanced timeline | ● | ● | explained | explained |
| Import gate dialog | dialog | dialog | dialog | full-screen sheet |
| Prompt Lab | full | full | full | saved text only |
| Review comments/decisions | ● | ● | ● | read + comment |
| Studio render start | ● | ● | ● | monitor only |

## 7. State and recovery matrix

| Surface | State | Presentation | Recovery |
| --- | --- | --- | --- |
| Studio load | loading | "Loading Studio…" (shipped) | — |
| Studio load | failed | alert + Retry/Back (shipped) | Retry |
| Header | offline/dirty/saving/failed/conflict/saved | §4.2 vocabulary + banners | per banner action |
| Import gate | inspect failed | Dialog stays; error summary; Retry inspect | Retry, Close |
| Import gate | create conflict/offline | Chooser preserved; typed decisions kept | Explicit retry reuses key |
| Attach | upload failed/unsupported/oversize | Row stays Unresolved; inline reason on the row | Choose again / Exclude |
| Inspector | stale revision | Section alert "Someone saved a newer revision" | Conflict banner actions |
| Render | blocked | Checklist row + reason + route | Route buttons |
| Render job | failed | Safe code phrase + Details | Retry (new job, desktop/tablet) |
| Any | destination unavailable | `role="status"` "…is not available in this Studio session." (shipped) | None needed |

No automatic retries anywhere (spec §5); every failure keeps the user's
text and offers an explicit action.

## 8. Keyboard map

| Key / control | Action | Surface |
| --- | --- | --- |
| Tab / Shift+Tab | DOM-order traversal (equals visual order) | Global |
| Space / K | Play/pause the focused player | Preview |
| ← / → | Nudge selected clip one frame | Advanced timeline (shipped) |
| Enter / Space | Select scene card (native button) | Scene strip |
| Move earlier / later buttons | Reorder selected scene | Scene strip (new) |
| Esc | Close attach popover / import gate without side effects | Import gate |
| Focus trap | Dialog traps focus; returns to trigger on close | Import gate |

Hidden destinations never contain tab stops (shipped `hidden` strategy).

## 9. Accessibility contract

- **Focus:** 2 px `--ring` on every interactive control, including inside
  dialogs and popovers; nothing persistent may cover a focused control
  (banners are in-flow).
- **Live regions:** save status `aria-live="polite"`; failures/conflicts
  `role="alert"`; the import gate's validation summary receives focus and
  links to failed rows.
- **Contrast:** all §2.1 pairs ≥ 4.5:1 for text; dots/tone markers always
  pair with words.
- **Touch:** 44 px targets on tablet/phone; icon buttons keep expanded hit
  areas.
- **Zoom/motion:** 200% text zoom wraps within the 4/8 grid without hiding
  the active control; `prefers-reduced-motion` collapses animation to
  0.01 ms (shipped override).
- **Screen readers:** dispositions, save states, and readiness rows are
  announced; decorative icons are `aria-hidden`; icon-only controls are
  labeled and expose pressed/expanded.

## 10. Honest-UI guardrails

Every drawn control maps to a persisted, revision-bound operation:

| Control | Operation |
| --- | --- |
| Heading/Body inputs | `edit_text` |
| Ownership select | `edit_ownership` |
| Duration field | `edit_duration` |
| Move earlier/later | `reorder_scene` |
| Attach/Exclude rows | studio-import `resolve` (`attach_asset` / `exclude`) |
| Add caption / cue text | `add_caption_clip` / `set_caption_cue_text` |
| Audio attach/volume/mute | `add_clip_from_asset` / `set_clip_volume` / `set_track_muted` |
| Style select | `set_text_style_slot` |
| Start Studio render | revision-bound render job (server-guarded) |

Explicitly **not** drawn in F3: Add Scene, "Preview changes", fabricated
media thumbnails, brand avatars/decoration from the mockup, style slots
without a real renderer effect, drag-only reorder, any URL/path input, and
any control whose failure would be silent.

## 11. Mapping to delivery plans

| Design section | Plan A (shipped) | Plan B task |
| --- | --- | --- |
| Job nav, shell, header, banners | Tasks 1–2 | — |
| Scene strip cards/labels/duration | Task 3 | Task 4 (reorder, media truth, unresolved dot) |
| Inspector Heading/Body/Ownership/Duration | Task 3 | Task 4A (Media/Captions/Audio/Style) |
| Import gate | — | Tasks 2 & 5 (`StudioImportGate.tsx`) |
| Attach popover/upload | — | Task 3 (asset uploads) + Task 5 |
| Render readiness checklist | — | Task 6 |
| Advanced timeline visuals | Prior slices | Token alignment only |
| Dark tokens | Task 4 | Append `--studio-well/raised/ai/playhead` |

## 12. Visual QA acceptance checklist

1. 1440 / 1024 / 820 / 375 px + 200% zoom: no horizontal overflow, active
   control reachable, one preview mounted.
2. All §2.1 contrast pairs measured ≥ 4.5:1 on their real surfaces.
3. Keyboard-only pass of §8; focus visible at every stop, including inside
   the import gate.
4. Every state in §7 reproduced in the offline fixture harness with its
   exact copy and recovery action.
5. Import gate: 4-footage + main + cropped-image fixture shows every item
   and both unsupported fields; no URL/path anywhere in DOM or logs.
6. Render checklist blocks and names scenes/sources; legacy Send render
   unaffected.
7. Reduced-motion pass: no animation beyond color changes.
8. No emoji icons; all icons Lucide at 16/20 px, 1.5 px stroke.
