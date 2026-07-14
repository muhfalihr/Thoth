# Scout Orchestration Engine (Operator Console sub-project B) — Design

Date: 2026-07-14
Status: IMPLEMENTED (2026-07-14) — see BLUEPRINT.md Update 2026-07-14 + plan
`docs/superpowers/plans/2026-07-14-scout-orchestration.md` (7-task TDD, subagent-driven).
Manual integration: `docs/superpowers/plans/2026-07-14-scout-orchestration-manual-test.md`.
Initiative: Full Operator Console (A -> B -> C -> D). Sub-project A (render parity + config
editor) is merged (`59eb39a`). This is **B**.

## Goal

Drive the interactive `scout/` discovery pipeline from the thoth-server dashboard, so the
operator can run the daily flow `browser -> discover -> run <url> -> validate` from the UI
instead of the terminal, ending with a validated content-set on disk ready to render.

MVP scope is the **core daily flow only**. Per-step re-runs (comments/footage/figures) and the
experimental commands (trending/topics/news/pulse) stay CLI-only for now.

## Why this is not a queue job

Scout is fundamentally unlike the render worker and must not share its machinery:

| | Render (existing) | Scout (this slice) |
|---|---|---|
| Runtime | Rust worker, warm, GPU/CUDA | `bun scout/cli.ts`, browser + CDP, no GPU |
| Shape | fire-and-forget queue jobs | interactive, human login, strictly serial (one browser tab) |
| Transport | SQLite (WAL) claimed by worker | supervised child of the server process |
| Cancel | cooperative DB flag `cancel_requested` | kill the child |
| Persistence | durable job rows | durable artifact = the content-set JSON on disk |

So B keeps the render half (worker + `thoth-jobs` + `thoth-core`) **completely untouched — no
schema migration, no worker change** — and adds a server-owned supervisor plus a separate
dashboard surface.

## Architecture (Approach 2: server-owned single-slot supervisor + SSE)

Confined to two crates/dirs:

- **`crates/thoth-server`** — a new `scout.rs` module + new routes in `routes.rs`, one new
  field on `AppState`.
- **`dashboard`** — a new `Discovery` view (third toggle beside Runs/Config) + `api.ts`
  additions.

Nothing else changes.

### The supervisor (`crates/thoth-server/src/scout.rs`)

One mutex-guarded slot, shared via `AppState` (which is `Clone`), so scout commands **never
overlap** — this is the software mirror of the single browser tab.

```rust
// Shared handle placed on AppState.
pub type ScoutSupervisor = std::sync::Arc<tokio::sync::Mutex<ScoutRun>>;

pub struct ScoutRun {
    pub kind: Option<ScoutKind>,   // None when Idle
    pub status: ScoutStatus,       // Idle | Running | Done | Failed
    pub lines: Vec<LogLine>,       // ring/append log of the current (or last) run
    pub started_at: Option<i64>,   // epoch millis
    pub finished_at: Option<i64>,
    pub exit_code: Option<i32>,
    kill: Option<KillHandle>,      // to implement cancel
    pub last_content_set: Option<std::path::PathBuf>, // out path of the last `run`; NOT
                                   // cleared by a later start() so /content-set survives a
                                   // subsequent discover/validate. Defaults to
                                   // output/thoth_content_set.json when a run omits --out.
}

pub struct LogLine { pub seq: u64, pub stream: Stream /* Out|Err */, pub text: String }

pub enum ScoutKind { Browser, Discover, Run, Validate }
pub enum ScoutStatus { Idle, Running, Done, Failed }
```

Lifecycle:

1. A `start(kind, args)` call takes the mutex. If `status == Running` it returns
   `Busy` -> the route maps that to **HTTP 409** (naming the current `kind`).
2. Otherwise it resets the run state (clears `lines`, sets `Running`, `started_at`,
   `kind`), spawns `bun scout/cli.ts <cmd> [flags...]` via `tokio::process::Command`
   with **cwd = repo root** (same convention as `config_path`), `stdout`+`stderr` piped.
3. A detached tokio task reads both pipes line-by-line, appending each to `lines` under
   the mutex with a **monotonic `seq`** and its `stream` tag. On child exit it sets
   `status = Done|Failed` (by exit code), `finished_at`, `exit_code`, and drops `kill`.
4. `cancel()` kills the child if `Running` (else 409).

Invocation details:
- `bun` is invoked bare (assumed on `PATH`, as scout already runs natively via Bun). A spawn
  failure (`bun` not found) is caught and recorded as a `Failed` run with a clear log line,
  not a server error.
- The scout command is `scout/cli.ts <cmd>`, matching the existing `bun cli.ts <cmd>`
  dispatch. Flags are passed through positionally exactly as the CLI expects.

### CDP / browser-attached probe

`browser_attached` = a short (~500ms) `GET {THOTH_CDP|http://127.0.0.1:18800}/json/version`
that returns 2xx. Mirrors `scout/lib/cdp.ts` (`CDP_BASE = process.env.THOTH_CDP ||
'http://127.0.0.1:18800'`). This is a read-only health probe; it never blocks or mutates the
slot.

### Argv building (per command)

The route handlers translate a small typed request body into the exact CLI argv, the same
pattern as sub-project A's `push_params` (unset fields fall to scout's own defaults):

- `browser start` -> `["browser", "start"]`
- `discover` `{max_per?, hours?, include?, tiktok?}` ->
  `["discover", ("--max-per", n)?, ("--hours", n)?, ("--include", csv)?, ("--tiktok")?]`
- `run` `{url, out?, per?, max?, cap?, no_comments?}` ->
  `["run", url, ("--out", f)?, ("--per", n)?, ("--max", n)?, ("--cap", n)?, ("--no-comments")?]`
- `validate` `{set}` -> `["validate", set]`

(`discover` flags per `scout/cli.ts`: `--max-per --hours --include --tiktok`. `run` flags:
`--out --per --max --cap --no-comments`.)

## Endpoints

All bearer-guarded (mounted in the same protected router as `/api/config`) **except** the SSE
stream, which self-authenticates via `?token=` and mounts outside the bearer layer — exactly
as the existing `stream_job` does (EventSource cannot send an `Authorization` header).

| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| GET | `/api/scout/status` | - | 200 `ScoutStatus` | browser probe + current run summary |
| POST | `/api/scout/browser/start` | - | 202 | 409 if busy |
| POST | `/api/scout/discover` | `{max_per?,hours?,include?,tiktok?}` | 202 | 409 if busy |
| POST | `/api/scout/run` | `{url,out?,per?,max?,cap?,no_comments?}` | 202 | 409 if busy; `url` required -> 400 if missing |
| POST | `/api/scout/validate` | `{set}` | 202 | 409 if busy; `set` required |
| POST | `/api/scout/cancel` | - | 202 | 409 if idle |
| GET | `/api/scout/topics` | - | 200 `ScoutTopic[]` | reads `scout/output/reel_topics.json`; `[]` if absent |
| GET | `/api/scout/content-set` | - | 200 `{path,exists}` | `ScoutRun.last_content_set`, default `output/thoth_content_set.json` |
| GET | `/api/scout/stream?token=&since=<seq>` | - | 200 SSE | poll-based tail of `ScoutRun.lines` |

Response shapes:

```jsonc
// GET /api/scout/status
{ "browser_attached": true,
  "cdp_base": "http://127.0.0.1:18800",
  "run": { "kind": "discover", "status": "running", "started_at": 1720900000000,
           "exit_code": null } }   // or "run": null when Idle

// GET /api/scout/topics  (shape mirrors scout/output/reel_topics.json entries; unknown
//                         fields ignored, additive-safe)
[ { "url": "...", "title": "...", "score": 0.0, "platform": "instagram" } ]
```

The SSE payload per event is one `LogLine` (`{seq, stream, text}`), and the stream replays
from `?since=<seq>` so a reconnecting client resumes without gaps, identical to `stream_job`.

## Dashboard (`Discovery` view)

- `App.tsx` gains a third view value `"discovery"` and a `Discovery` toggle button beside
  Runs/Config.
- `components/Discovery.tsx`:
  - **Header:** browser status pill (polls `GET /api/scout/status` every few seconds) +
    **[Start browser]** button (`POST /api/scout/browser/start`).
  - **Flow bar** mirroring `browser -> discover -> run -> validate`:
    1. **[Discover]** opens a small form exposing **all four** flags: `max_per`, `hours`,
       `include` (comma list), and a `tiktok` toggle.
    2. On completion, a ranked **topic picker** populated from `GET /api/scout/topics`;
       clicking a topic fills the Run box's URL.
    3. **[Run pipeline `<url>`]** — url + `per`/`max`/`cap` (and a `no-comments` toggle).
    4. **[Validate]** — validates the produced content-set.
  - **One live log pane** subscribed to the SSE stream, reusing the `JobMonitor` line-view
    pattern.
  - On `run` + `validate` success: show the produced **content-set path** (from
    `GET /api/scout/content-set`), copyable. One-click "send to render" that pre-fills sub-
    project A's `RunForm` is **explicitly out of scope — that is sub-project D**. B's boundary
    ends at surfacing the path.
- `dashboard/src/api.ts` gains `scoutStatus/Start/Discover/Run/Validate/Cancel/Topics/
  ContentSet` functions plus `ScoutStatus`, `ScoutRunSummary`, and `ScoutTopic` TS types,
  hand-synced to the Rust types (not compiler-enforced — the standing `api.ts` rule).

## Error handling

- **Start while busy** -> 409, body names the current run `kind`. UI disables action buttons
  while `status.run.status == "running"`.
- **`bun` not found / spawn error** -> run marked `Failed`, first log line states the cause.
- **CDP down** -> `status.browser_attached=false` pre-warns the operator (buttons still
  enabled). If they run discover/run anyway, scout's own preflight ("CDP tidak aktif ...")
  exits non-zero -> `Failed` with that hint in the log pane.
- **Logged-out platform** -> scout prints the platform error -> `Failed`; the UI shows a
  generic "check the browser / log in, then retry" hint on any `Failed` discover/run.
- **Cancel** -> `child.kill()` (cross-platform via tokio) -> `Failed`.

## State & persistence

None — the supervisor is in-memory. The **durable artifact is the content-set JSON on disk**
(`scout/output/`); a server restart mid-run only loses the ephemeral live log, and discovery
is cheap and idempotent to re-run. A `scout_runs` history table (Approach 3) is a clean
additive follow-up if browsable discovery history is wanted later; it is deliberately excluded
here (YAGNI for the daily flow).

## Testing

- **Rust unit tests** (`cargo test -p thoth-server`):
  - single-slot: `start` while `Running` returns `Busy` -> 409.
  - `ScoutStatus` JSON serialization shape (idle and running).
  - per-command argv building for `browser/discover/run/validate` (mirrors A's `push_params`
    tests), including the `url` positional and each optional flag.
  - CDP probe returns `false` when nothing listens on the port.
  - supervisor lifecycle (spawn -> capture lines with monotonic `seq` -> exit sets
    `Done|Failed`) exercised with a **trivial cross-platform echo child** (not real
    `bun`/browser), so tests are hermetic.
- **`api.ts`**: not compiler-enforced; correctness verified by line-by-line sync against the
  Rust route bodies + `bun run build` exit 0.
- **Gated manual integration**: a real `browser -> discover -> run -> validate` against a
  logged-in browser, documented (like the CUDA build gate) — not run in CI.

## Interface-contract impact

- `thoth-core`, `thoth-jobs`, `thoth-types`: **unchanged**. No migration.
- `crates/thoth-server`: new `scout.rs`, new routes, one `AppState` field
  (`scout: ScoutSupervisor`). Compiler-enforced within the crate.
- `dashboard/src/api.ts`: new functions + types, **hand-synced** to the Rust route shapes
  (the one non-compiler-enforced seam, per CLAUDE.md).

## Explicitly out of scope (later sub-projects)

- Per-step re-runs (comments/footage/figures/enrich/images) — would be a "B+" or C concern.
- One-click discovery -> render hand-off (pre-filling `RunForm`) — **sub-project D**.
- Discovery run history / audit table — Approach 3 follow-up.
- Content-set editing UI — **sub-project C**.
- Any credential/login automation — out of scope permanently (human login only).
