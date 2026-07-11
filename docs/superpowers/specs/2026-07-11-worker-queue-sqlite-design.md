# Thoth Worker↔Server Redesign — SQLite Job Queue

*Date: 2026-07-11 · Status: approved for planning*

## 1. Overview

Phase 1 of the dashboard (just shipped) runs jobs by having `thoth-server` **spawn
`thoth <cmd> --progress-json` as a fresh subprocess per job** and scraping NDJSON
from its stdout. This redesign replaces that with **two independent peer
processes that communicate only through a shared SQLite database (WAL mode)**:

- **`thoth-server`** (Axum) — produces jobs (`INSERT`), reads state, relays SSE.
- **`thoth worker`** — a persistent, **warm** process that pulls queued jobs from
  the DB, runs the pipeline with models kept resident across jobs, and writes
  progress/results back to the DB.

There is **no parent/child link, no stdin/stdout channel, and no supervisor**. The
database is the sole contract between the two processes.

### Why (motivations, from brainstorming)
1. **Cold-start cost** — the per-job subprocess reloads CUDA/Whisper/models every
   time. A persistent worker loads them once and reuses them across all jobs.
2. **Fragile stdout scraping** — CLI argv in + loose NDJSON out is hacky. A
   structured DB row/event model replaces it (and deletes the whole `worker_args`
   argv-contract class of bug).
3. **Decoupled engine** — the engine runs continuously as its own process,
   independent of the web server's lifecycle (server can restart without
   disturbing an in-flight job; the engine can run headless).

### Non-goals (explicitly out of scope — separate specs/YAGNI)
- **Cross-platform hardware-acceleration adaptation** (encoder NVENC/VideoToolbox/
  VAAPI/QSV→libx264, Whisper CUDA/Metal/CoreML→CPU). Its **own follow-up spec**.
  This redesign keeps the current acceleration path unchanged.
- **N concurrent workers.** The design is claim-safe for N (atomic claim +
  `worker_id`), but v1 runs **one** warm worker. Scaling to N is a later toggle.
- **Loopback-UDP "doorbell"** to cut poll latency to ~0. Adaptive polling is
  enough for minute-long jobs; the doorbell is a noted future optimization.
- **OS service-manager integration** (systemd/launchd/Windows Service). v1 ships a
  cross-platform launch story (run the two binaries); packaging as OS services is
  later ops work.
- **Migrating existing redb job rows.** Job state is ephemeral operational data —
  redb is removed and replaced outright, no data migration.

## 2. Architecture

```
Browser ──REST/SSE──▶ thoth-server ◀──┐
                        (Axum)         │  both open the SAME thoth.db
                        reads+writes   │  independently — WAL allows
                        state,         ▼  concurrent readers + serialized
                        relays SSE   thoth.db (SQLite, WAL)   writers
                                        ▲
                        claims+runs     │  worker pulls queued jobs,
thoth worker ───────────────────────────┘  writes progress/state back
  (warm: models loaded once, reused)
```

### Why this shape
- **The DB is the only shared medium.** No IPC to get platform-specific about —
  SQLite files behave identically on Linux/macOS/Windows.
- **Full independence.** Server restart doesn't touch a running job; the worker
  keeps consuming the queue regardless of the server. The engine can even run on
  its own for headless batch processing.
- **Warm models.** The worker process is long-lived; CUDA/Whisper context and
  loaded models persist between jobs — the cold-start motivation is solved.
- **Preserves the Phase-1 boundary.** `thoth-server` still links **no** heavy deps
  (ffmpeg/wgpu/CUDA/Whisper). It gains `sqlx` (a DB client — legitimately the
  server's concern), not the pipeline.

### Crate structure
A new shared crate **`thoth-jobs`** owns everything both processes touch:
- **Types**: `JobRecord`, `JobStatus` (`Queued|Running|Succeeded|Failed|Cancelled`),
  `JobSpec`, `JobEvent`, `SseEvent` — moved out of `thoth-server/src/job.rs`.
- **Store**: `JobStore` over a `sqlx::SqlitePool` with the WAL/pragma setup and
  every query (§5).
- Depends on `thoth-types` for the shared `ProgressEvent` wire type.

Dependency graph:
```
thoth-types  (pure serde: ProgressEvent)
   ▲                       ▲
   └── thoth-jobs (sqlx + SQLite store + job types)
          ▲                      ▲
          │                      │
   thoth-server (Axum,      thoth-core → thoth (worker + CLI)
   NO ffmpeg/CUDA)          (pipeline, links CUDA/ffmpeg)
```
`redb` is removed from `thoth-server`'s deps; `store.rs`/`job.rs` are replaced by
`thoth-jobs`.

## 3. Components & responsibilities

### thoth-jobs (new shared crate)
- Connection factory applying WAL + `synchronous=NORMAL` + `busy_timeout` (§2 code).
- Embedded migrations (`sqlx::migrate!`, SQL under `crates/thoth-jobs/migrations/`).
- Query API (all parameterized): `enqueue`, `claim_next`, `append_event`,
  `update_progress`, `heartbeat`, `is_cancel_requested`, `request_cancel`,
  `finish` (succeeded/failed/cancelled), `get`, `list`, `events_since`,
  `reap_stale`.

### thoth worker (`thoth worker` subcommand on the existing binary)
- Opens its own `SqlitePool`, loads pipeline/model state once, runs the claim loop
  (§5). Executes each claimed job by calling the **same pipeline functions** `run`
  uses (models stay resident between jobs). Streams progress via `append_event` +
  `update_progress`, heartbeats while running, checks the cancel flag at stage
  boundaries, and owns/reaps its own pipeline child processes (ffmpeg/python/bun).

### thoth-server (Axum) — mostly unchanged surface
- REST `/api/jobs*` + SSE + artifacts + API-key auth + SPA hosting stay.
- `POST /api/jobs` → `enqueue` (status `queued`). `POST /api/jobs/:id/cancel` →
  `request_cancel`. `GET /api/jobs/:id/stream` → tail `job_events` by `seq` (§5).
- Runs the **reaper** timer (§6) — the liveness net that replaces the supervisor.

## 4. Schema

`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; busy_timeout=5s` on every
connection (both processes). `busy_timeout` is what makes multi-process writes
safe: WAL permits one writer at a time, and the timeout makes a second writer
**wait** rather than raise `SQLITE_BUSY`.

```sql
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  command        TEXT NOT NULL,               -- 'run' (phase 1)
  url            TEXT,
  content_set    TEXT,
  params         TEXT NOT NULL DEFAULT '{}',  -- JSON
  status         TEXT NOT NULL DEFAULT 'queued', -- queued|running|succeeded|failed|cancelled
  stage          TEXT,
  pct            REAL NOT NULL DEFAULT 0,
  error          TEXT,
  output_dir     TEXT NOT NULL,
  worker_id      TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  heartbeat_at   TEXT,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON jobs(status, created_at);
CREATE INDEX idx_jobs_reap  ON jobs(status, heartbeat_at);

CREATE TABLE job_events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,  -- global monotonic → SSE Last-Event-ID
  job_id   TEXT NOT NULL REFERENCES jobs(id),
  type     TEXT NOT NULL,                       -- progress|log|done|error
  stage    TEXT, pct REAL, message TEXT,
  ts       TEXT NOT NULL
);
CREATE INDEX idx_events_job ON job_events(job_id, seq);
```

Timestamps are RFC-3339 TEXT (SQLite has no native datetime; string compare is
correct for RFC-3339). `job_events.seq` is the SSE resume cursor.

## 5. Data flow & the loops

### Enqueue (server)
`POST /api/jobs` validates the `JobSpec`, generates an id + `output_dir`, and
`INSERT`s a `queued` row. Returns `201 {job_id}`. No dispatch — the worker pulls.

### Claim + adaptive poll (worker)
SQLite has no LISTEN/NOTIFY, so the worker polls — but cheaply, with backoff:
```rust
let mut backoff = Duration::from_millis(250);      // fast when busy
loop {
    let claimed = sqlx::query_as(r#"
        UPDATE jobs SET status='running', worker_id=?1,
               started_at=?2, heartbeat_at=?2, updated_at=?2
        WHERE id = (SELECT id FROM jobs WHERE status='queued'
                    ORDER BY created_at LIMIT 1)
        RETURNING id, command, url, content_set, params
    "#)
    .bind(&worker_id).bind(now_rfc3339())
    .fetch_optional(&pool).await?;

    match claimed {
        None => { sleep(backoff).await; backoff = (backoff*2).min(Duration::from_secs(2)); }
        Some(job) => { backoff = Duration::from_millis(250); run_job(&pool, &worker_id, job).await; }
    }
}
```
The claim is a single atomic writer statement (SQLite 3.35+ `UPDATE…RETURNING`
with a `LIMIT 1` subselect); with one writer at a time under WAL, two workers can
never claim the same row. Idle cost is one indexed statement every 0.25–2 s.

### run_job (worker)
- Runs the pipeline via the same functions `run` uses, with resident models.
- **Throttled progress**: `append_event('progress', …)` + `update_progress` only on
  stage change or a `pct` delta ≥ ~2% (not every frame) to bound write volume.
- **Heartbeat**: a background task bumps `heartbeat_at=now()` every ~5 s.
- **Cancel check**: at each stage boundary read `cancel_requested`; if set → trip
  the `CancellationToken`, kill the pipeline children it owns (portable
  `child.kill().await` — the worker owns them directly, so no `taskkill`), and
  `finish(Cancelled)`.
- **Terminal**: `finish(Succeeded)` + `append_event('done', …)`, or on any error
  `finish(Failed, err)` + `append_event('error', msg)`. The `jobs` row write
  precedes the terminal event append so a reader that sees the event always sees
  the final status.

### SSE relay (server)
```
GET /api/jobs/:id/stream          (last_seq = Last-Event-ID header or 0)
  loop every ~400ms:
    rows = events_since(job_id, last_seq)      -- seq > last_seq ORDER BY seq
    for r in rows: emit SSE(id=r.seq, type=r.type, …); last_seq = r.seq
    if a done|error event was emitted: close
```
`seq` as SSE `id` makes reconnects resumable (browser sends `Last-Event-ID`).
Auth for SSE stays the query-token scheme (EventSource can't set headers).

### Cancel (server)
`POST /api/jobs/:id/cancel`: if `queued` → `finish(Cancelled)` directly; if
`running` → `request_cancel` (sets `cancel_requested=1`), the worker picks it up.

## 6. Error handling & isolation

- **Worker crash mid-job** → no parent to notice, so the **reaper** (server timer,
  ~15 s) reclaims it: `UPDATE jobs SET status='failed', error='worker died (stale
  heartbeat)', finished_at=now() WHERE status='running' AND heartbeat_at <
  now-30s`, then append a terminal `error` event so the UI sees it. (Retry —
  reset to `queued` instead of `failed` — is a deliberate future option; v1 fails
  to avoid crash loops.)
- **Write contention** → `busy_timeout` makes writers wait; queries treat a
  timeout as a retryable error with a bounded retry, not a panic.
- **Malformed pipeline output / bad progress** → dropped with a `warn`, the job
  continues (graceful-degradation convention).
- **DB unavailable at startup** → the process fails fast with a clear message
  (mirrors the CLI's existing "X not found" degrade).
- **Cancellation** is cooperative (flag-polled), so a wedged native call may take
  until the next stage boundary to stop; the reaper is the backstop if the worker
  itself hangs.

## 7. Cross-platform worker lifecycle

- **No `taskkill`, no OS-specific process hacks.** The worker owns its pipeline
  children directly and kills them with tokio's portable `Child::kill`. If a tool
  spawns grandchildren, spawn it via the cross-platform `command-group` /
  `tokio-command-group` crate and kill the group — identical on all three OSes.
- **Launch (v1):** the two binaries are started independently (`thoth-server` and
  `thoth worker`), documented for Linux/macOS/Windows. They coordinate purely
  through `thoth.db`; start order does not matter (each creates the DB if missing).
- **DB path** is shared config (env/CLI), defaulting to a per-project `thoth.db`;
  both processes must point at the same file.

## 8. Testing

- **thoth-jobs**: `sqlx` against a temp-file SQLite DB — round-trip enqueue→claim→
  progress→finish; **atomic-claim test** (two concurrent claim calls, exactly one
  wins); `events_since` ordering + resume; `reap_stale` marks a stale-heartbeat
  `running` job failed and appends a terminal event.
- **worker**: a claim-loop test against a seeded DB with a stub job body (no GPU)
  asserting the row transitions queued→running→succeeded and events are appended
  in order; a cancel test (set `cancel_requested`, assert the job ends
  `cancelled`).
- **server**: in-process `oneshot` HTTP tests — enqueue returns 201+id; SSE tail
  emits seeded `job_events` and resumes from `Last-Event-ID`; cancel sets the flag
  / cancels a queued job.
- **Cross-platform**: the store + loop tests are pure SQLite/tokio (no OS-specific
  calls), so they run on all three OSes; CI note to run them on each.
- Feature work closes with a full `build_cuda.bat` (workspace) + `cargo test
  --workspace`.

## 9. Migration from Phase 1 (redb → SQLite)

- **Remove**: `redb` dep; `thoth-server/src/store.rs` (redb) and `src/job.rs`
  (types → `thoth-jobs`); the spawn-per-job executor and its `worker_args`.
- **Add**: `thoth-jobs` crate; `sqlx` (SQLite, runtime-tokio, migrate) to
  `thoth-server` and the worker; `thoth worker` subcommand + claim loop; the
  server reaper timer; SSE relay rewritten to tail `job_events`.
- **Keep**: REST routes, SSE endpoint shape + auth, artifact serving, SPA,
  `thoth-types`, the interface-sync contract (extended: `thoth-jobs` schema/types
  are now shared surface — a change updates both processes; the compiler enforces
  the Rust side, SQL migrations are the manual step).
- **SPA**: `JobStatus` gains `cancelled`; `api.ts` adds it to the union. Otherwise
  the wire shapes are unchanged.

## 10. Interface-sync contract (update CLAUDE.md)

> `thoth-jobs` (schema + job types) and `thoth-types` (wire types) are shared
> surface between `thoth-server` and the `thoth` worker. A change to either MUST
> update both processes — the compiler enforces the Rust types; SQL schema
> changes require a new migration in `crates/thoth-jobs/migrations/` and a matching
> `api.ts` update (not compiler-enforced).

## 11. Open questions / future

- Retry-on-crash (reaper → `queued` instead of `failed`) with an attempt cap.
- N concurrent workers (claim is already safe; needs a per-worker concurrency
  cap + UI for worker fleet).
- Loopback-UDP doorbell to cut claim latency toward zero.
- OS service-manager packaging (systemd/launchd/Windows Service).
- Hardware-acceleration adaptation — its own spec (§1 non-goals).
