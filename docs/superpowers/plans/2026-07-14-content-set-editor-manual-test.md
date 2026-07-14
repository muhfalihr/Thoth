# Content-Set Curation UI — Manual Integration Test (gated, not CI)

This flow drives the **Content Set** dashboard view (sub-project C) end to end against a
real thoth-server + a real scout-produced content-set on disk. It cannot run in CI: it needs
a built `thoth-server.exe`, the dashboard, and an actual content-set JSON with crop images.

The automated tests (`cargo test --workspace`, `bun run build`) cover the wire contract:
verbatim read (exists/missing/malformed), the lossless PUT round-trip (discourse + unknown
fields survive byte-for-byte), the PUT shape guards (400 on non-object / missing `main` /
non-array collection), and the image route's auth + traversal + missing-file paths (401 / 401
/ 404) with a hermetic harness. Everything below is the part machines can't verify: that the
view loads real crops, prunes items, edits the two text fields, saves losslessly, and
re-validates.

## Prerequisites

- A built `thoth-server.exe` (from `build_cuda.bat`) and the dashboard
  (`cd dashboard && bun run build`, or `bun run dev` for live iteration).
- An existing content-set at `scout/output/thoth_content_set.json` with at least a few
  `footage[]`, `comments[]` (with `image_path` crop PNGs under `scout/output/crops/`), and
  ideally some `figures[]`/`references[]`. Produce one from the **Discovery** tab first
  (Discover → Run pipeline), or reuse a prior run's output.
- Start `thoth-server` with **cwd = repo root** — it resolves `scout/cli.ts` and
  `scout/output/` relative to cwd, and the image route reads from `scout/output/`.

## Steps

1. **Open the view.** Switch to the **Content Set** tab (4th toggle beside
   Runs/Config/Discovery). The view loads via `GET /api/scout/content-set/data`:
   - The **Main** card shows the cover/thumbnail (or `main.image_path` crop) with editable
     **title** and **description** fields.
   - The **Footage** grid shows a thumbnail + title + platform per item.
   - The **Comments** grid shows each comment's **crop PNG** (served token-authed from
     `scout/output/`), author, and text.
   - **Figures** and **References** render as compact rows.

2. **Images load (token auth).** Confirm the comment crop `<img>`s render — their `src` is
   `/api/scout/output/crops/comment_*.png?token=<api_key>`. In DevTools, a request to that
   path **without** `?token=` returns **401**; with the correct token it returns the PNG.

3. **Prune.** Click the **✕** on an irrelevant footage item, a black/off-topic comment crop,
   and a wrong figure/reference. Each removes the card immediately and flips the footer to
   **"unsaved changes"**.

4. **Edit text.** Change `main.title` and `main.description`. Still "unsaved changes".

5. **Save + auto-validate.** Click **Save**:
   - `PUT /api/scout/content-set` overwrites `scout/output/thoth_content_set.json` in place.
   - The footer shows "Saved. Validating…" and the **LogPane** streams the auto
     `scout validate` output (RINGKASAN / summary) over SSE.
   - The view repaints from disk; the pruned items stay gone, the edited text persists.

6. **Losslessness.** Open the saved JSON and confirm untouched data survived byte-for-byte:
   `discourse`, per-footage `relevance`/`query`, and any field the Rust side doesn't model are
   all still present. Only the pruned array entries and the two edited `main` fields changed.

7. **Race guard.** Start a **Discover** or **Run** from the Discovery tab, return to the
   **Content Set** tab: the **Save** button is **disabled** while a scout command is in-flight
   (status poll → "scout busy — save disabled"). It re-enables when the run finishes.

8. **Empty / malformed states.**
   - With no `scout/output/thoth_content_set.json`, the view shows
     **"No content-set yet — run Discovery first."**
   - With a deliberately corrupted JSON on disk, it shows the read-only
     **"The content-set on disk isn't valid JSON"** notice and never overwrites it.

## Out of scope (deferred sub-projects)

- One-click Discovery → render hand-off (pre-filling the render form) — **sub-project D**.
- Swapping `main` URL, adding new footage/comments by hand, editing arbitrary fields — that is
  re-running scout, not curation.
- Arbitrary content-set path picker / multiple content-sets — C follow-up.
- Rendering non-video `image_path` entries as static cards — separate content-set FOLLOW-UP.
