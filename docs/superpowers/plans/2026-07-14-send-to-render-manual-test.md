# Manual Integration Test — Sub-project D: "Send to render" hand-off

- **Date:** 2026-07-14
- **Plan:** `docs/superpowers/plans/2026-07-14-send-to-render.md`
- **Design:** `docs/superpowers/specs/2026-07-14-send-to-render-design.md`
- **Scope under test:** `dashboard/` — RunForm prefill, ContentSet trigger, App wiring.

## Prerequisites

1. Build the dashboard: `cd dashboard && bun run build` (EXIT 0).
2. Start thoth-server (serves the built SPA + REST/SSE). Have a warm
   `thoth worker` running so enqueued jobs actually execute.
3. Have a real content-set on disk at the canonical path
   `scout/output/thoth_content_set.json` (run scout Discovery + validate, or
   place a known-good set there). Open the dashboard and go to the **Content Set**
   view; confirm the Main card + footage/comments grids render.

## Test 1 — Clean set → pre-fill, no auto-submit

1. In the Content-Set view, do **not** edit anything (footer shows no "unsaved
   changes"). Click **Send to render →**.
2. **Expect:** the app switches to the **Runs** view. `RunForm`'s content-set
   field is pre-filled with `scout/output/thoth_content_set.json`; the **Options**
   panel is already expanded (provider/profile visible). **No job has started.**
3. Confirm the URL field is empty and the JobList shows no new job yet.

## Test 2 — Dirty set → auto-save + validate, then hand off

1. Back in the Content-Set view, edit `main.title` (or prune a footage item) so
   the footer shows **"unsaved changes"**.
2. Click **Send to render →**.
3. **Expect:** the footer briefly shows **"Saved. Validating…"** (save +
   validate ran first), then the app switches to the Runs view with the
   content-set path pre-filled. The saved file on disk reflects your edit
   (reopen the Content-Set view afterward to confirm the edit persisted).

## Test 3 — Disabled states

1. **Empty/missing set:** temporarily point at (or delete) the canonical file so
   the Content-Set view shows the empty/"file not found" notice. **Expect:**
   the **Send to render →** button is disabled (as is Save).
2. **Scout running:** trigger a scout command (e.g. re-validate from the
   Discovery view) so a scout run is in-flight. Switch to the Content-Set view.
   **Expect:** both **Save** and **Send to render →** are disabled until the
   scout run finishes (≤ ~3 s status-poll lag).

## Test 4 — One-shot prefill (no accidental re-prefill)

1. Perform Test 1 (land on Runs with a prefilled RunForm).
2. Switch to the **Config** (or Discovery) view, then switch **back to Runs**.
3. **Expect:** `RunForm` is **empty** (content-set field blank, Options collapsed)
   — the pending path was consumed once via `onConsumed` and not re-applied.

## Test 5 — Full smoke: curate → render → stream

1. From the Content-Set view, click **Send to render →** (clean or dirty).
2. On the Runs view, in the expanded Options set **provider = novita** (per the
   groq → 429 → clip-mode-fallback gotcha — do **not** leave it on the groq
   default for a real narration run). Adjust any other params as desired.
3. Click **Run**.
4. **Expect:** a new job appears in the JobList and is auto-selected; the
   JobMonitor streams stages (ingest → analyze → … → render) to completion. The
   job's content-set is the one you curated.

## Pass criteria

- All five tests behave as described.
- `cd dashboard && bun run build` and `bun run lint` both EXIT 0.
- No Rust rebuild required (sub-project D touches no Rust).
