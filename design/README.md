# Creator Studio F3 — UI/UX Interactive Design Prototype

This directory contains a self-contained, standalone interactive UI prototype designed to inspect and evaluate the **Creator Studio F3 UI/UX Design** with realistic dummy data.

## Referenced Specifications and Plans

This design prototype is built directly against:
1. **Design Specification:** [`docs/superpowers/specs/2026-09-25-creator-studio-f3-full-ui-ux-design.md`](../docs/superpowers/specs/2026-09-25-creator-studio-f3-full-ui-ux-design.md)
2. **Implementation Plan:** [`docs/superpowers/plans/2026-09-25-creator-studio-f3-first-mode-migration.md`](../docs/superpowers/plans/2026-09-25-creator-studio-f3-first-mode-migration.md)
3. **Approved Visual Direction Mockup:** [`docs/superpowers/specs/2026-09-24-creator-studio-f3-selected-direction.png`](../docs/superpowers/specs/2026-09-24-creator-studio-f3-selected-direction.png)

## How to Run

### Method 1: Python CLI Script (Recommended)

Run the Python server script directly from the repository root:
```bash
python design/serve.py
```
This automatically finds an open port (default: 3000), starts a local HTTP server, and opens your default browser at `http://localhost:3000/`.

To run on a specific port without auto-opening the browser:
```bash
python design/serve.py --port 8080 --no-open
```

### Method 2: Windows Batch Script

Double-click `run.bat` inside the `design/` folder:
```cmd
design\run.bat
```

### Method 3: Direct Browser File (Zero Server Required)

Double-click `design/index.html` in your file explorer or open it directly in Chrome, Edge, Firefox, or Safari.

## Key Design Features Implemented

1. **Tokens and Color Palette (§2.1):**
   - Exact dark tokens: `--background` (`#18191b`), `--card` (`#242628`), `--studio-well` (`#101113`), `--studio-raised` (`#2a2c2e`), `--foreground` (`#f5f3ee`), `--muted-foreground` (`#c5c6c7`), `--primary` (`#d49a79` terracotta), `--ring` (`#efb28e`), `--studio-ai` (`#af87ff`), `--studio-playhead` (`#82b1e8`), `--status-succeeded` (`#d7af5f` gold), `--status-failed` (`#ef4444`).
   - Monospace typography for timecodes, durations, and revision markers.

2. **Top Navigation & Job Routing (§4.1, §5.1):**
   - Job Nav: `Edit` | `Prompt` | `Review` | `Render` with 2px terracotta underline on the active job (`box-shadow: inset 0 -2px 0 var(--primary)`).
   - Mode switcher: `Simple` vs `Advanced`.
   - Save State simulator: `Saved` (gold dot), `Unsaved changes` (hollow dot), `Saving` (pulsing dot), `Failed` (red dot + alert banner with retry), `Conflict` (terracotta dot + conflict banner with reload/keep), and `Offline`.

3. **Simple Mode Studio (1:1 Alignment with Approved Direction Mockup):**
   - **Preview Stage (§5.5):** 9:16 vertical video player recessed into `--studio-well`, play/pause controls, timecode scrubber, and spacebar play/pause support.
   - **SceneBoard (§5.3):** 160px cards, role glyphs (`film`, `image`), ownership badges, mono duration, and functional `Move earlier [↑]` and `Move later [↓]` reorder buttons on selected card.
   - **Inspector (§5.4):**
     - Heading input (300 chars bound)
     - Body textarea (2000 chars bound)
     - Media truth status line and Replace/Resolve actions
     - Duration in seconds with validation
     - Captions cue list with Add Cue and delete
     - Audio bed volume slider and Mute toggle
     - Style slot selector (Cinematic, Modern Bold, Minimal Clean, Tokyo Neon)
     - Ownership selector (User edited, AI managed, Locked)

4. **Advanced Mode Studio (§3.2, §5.6):**
   - 14rem Asset Library with ready assets list.
   - Multi-track timeline (Video, Text, Caption, Audio) with clips tinted by role, ruler with second ticks, soft-blue playhead, and 0-blocking-issues bar.
   - Timeline inspector showing clip in/out frames and playback speed.

5. **StudioImportGate (§5.2, Plan B Tasks 2 & 5):**
   - Stage 1: Draft choice (Resume existing draft / Create new draft with idempotency key).
   - Stage 2: Source inventory table (Order, Role, Source name, Disposition status dot + text).
   - Actions: `Attach...` popover (Upload file / Choose ready asset) and `Exclude` toggle (with Undo Exclude).
   - Live unresolved item counter and Continue in Studio button.

6. **Prompt Lab (§5.7):**
   - Read-only system policy and brand guardrails on `--studio-well`.
   - Editable active prompt.
   - AI proposal comparison diff with `--studio-ai` border accent and "Apply proposal to draft" button.

7. **Review Panel (§5.8):**
   - Preview with "Reviewing saved revision 3" chip overlay.
   - Comment feed with timecodes, revision tags, and "Pin to timecode" comment input.
   - "Approve Revision 3" and "Request Changes" actions.

8. **Render Panel (§5.9, Plan B Task 6):**
   - Authoritative Readiness Checklist: Text complete, Timeline valid, Import resolved, Saved revision clean.
   - Disabled "Start Studio Render" button with honest reason line ("Resolve 2 import items before rendering revision 3").
   - "Simulate: All checks passed" toggle to test the enabled render state.
   - Recent jobs table with status dots, timestamps, and download actions.

9. **Device Breakpoint & Comparison Tools:**
   - Simulator buttons for Desktop (1440px+), Compact (1120px), Tablet (820px, showing `CompactStudioNav`), and Phone (375px).
   - Floating Prototype Variant Switcher (cycling via `←` and `→` arrow keys).
   - Side-by-side drawer to compare the live interactive prototype directly against the reference mockup.
