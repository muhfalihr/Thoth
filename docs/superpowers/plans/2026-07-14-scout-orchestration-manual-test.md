# Scout Orchestration — Manual Integration Test (gated, not CI)

This flow drives the interactive `scout/` Bun discovery pipeline (real browser + CDP,
human login, strictly serial — one tab) from the thoth-server dashboard. It cannot run in
CI: it needs a logged-in managed browser and hits live social platforms. Run it by hand
after any change to the scout-orchestration surface (`crates/thoth-server/src/scout.rs`,
`routes.rs` scout handlers, `dashboard/src/components/Discovery.tsx`, `api.ts` scout client).

The automated tests (`cargo test --workspace`, `bun run build`) cover the wire contract,
auth, 202/409/400 semantics, and the SSE reject path with a hermetic echo child. Everything
below is the part machines can't verify: that the buttons drive a real scout run end to end.

## Prerequisites

- A logged-in managed browser reachable over CDP. Start it once and log into the platforms
  you'll discover from (IG / TikTok / X):
  ```
  bun scout/cli.ts browser start
  ```
  The dashboard's **Start browser** button runs this same command; doing it once here just
  lets you complete the interactive login before the timed steps below.
- `THOTH_CDP` (default `http://127.0.0.1:18800`) pointing at that browser's debug port.
- A built `thoth-server.exe` (from `build_cuda.bat`) and the dashboard (`cd dashboard && bun run build`,
  or `bun run dev` for live iteration).

## Steps

1. Start `thoth-server` with **cwd = repo root** (it resolves `scout/cli.ts` and
   `scout/output/` relative to cwd) and open the dashboard. Switch to the **Discovery** tab.

2. **Browser status.** The header pill reads **"Browser attached"** (green) once CDP:18800
   answers. If it's red/"not attached", click **Start browser**, complete any login prompt in
   the launched window, and within ~3s (the status poll interval) the pill flips to attached.

3. **Discover.** In section 1 set `max_per = 6` (leave the rest default) and click **Discover**.
   - The right-hand log pane streams live (stdout + stderr interleaved, monotonic).
   - Every action button is disabled while it runs; a **Cancel** button appears.
   - On finish the **Topics** list (section 2) populates from `scout/output/reel_topics.json`.

4. **Run pipeline.** Click a topic in section 2 — it fills the URL field in section 3. Click
   **Run pipeline**.
   - The log streams the pipeline stages: `trace_source → comments → footage → figures → validate`.
   - On finish, section 4 shows the content-set path and `exists = true`
     (default `scout/output/thoth_content_set.json`).

5. **Validate.** Click **Validate**. It exits 0 and the log shows the RINGKASAN (summary) block
   for the content-set. If validation fails, the run status goes **failed** and the summary
   explains what's missing.

6. **Single-slot / busy guard.** While any command runs, confirm the action buttons are
   disabled. A direct `POST /api/scout/discover` (curl/Bearer) during a run must return **409**
   with `{"error": ..., "busy_kind": ...}` — the supervisor holds exactly one slot (mirrors the
   one browser tab).

7. **Cancel.** Start a **Discover**, then click **Cancel** mid-run. The whole process **tree** is
   killed (tokio `select!` → `taskkill /PID <pid> /T /F` on Windows; on Unix the child leads its own
   process group (`process_group(0)`) and cancel sends `kill -9 -<pgid>` to the whole group — the real
   pipeline runs in a grandchild the `bun cli.ts` dispatcher spawns, so `child.kill()` alone would
   not reach it). A "cancelled" line lands in the log, the run status goes **failed** with a
   non-zero exit code, and the browser tab stops being driven. The next command can start
   immediately — the reader-drain is timeout-bounded so the single slot is always released, even if
   a dying grandchild briefly holds the pipe open.

8. **Reconnect / resume.** Reload the dashboard mid-run: the log pane re-opens the SSE stream
   from `since=0` and repaints the run's lines; the status pill reflects the still-running command.

9. **Hand-off to render (manual).** Copy the content-set path from section 4 into the **Runs**
   tab's render form and start a render. This is the manual seam; the one-click hand-off from
   Discovery → render is out of scope here (sub-project D).

## Out of scope (deferred sub-projects)

- One-click Discovery → render hand-off — **sub-project D**.
- Content-set editing / inspection in the UI — **sub-project C**.
- Per-step re-runs, discovery history table — not planned for B.
