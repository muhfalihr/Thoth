# Thoth Dashboard — Architecture Design

*Date: 2026-07-11 · Status: draft for review*

## 1. Overview

Thoth is today a Rust **CLI** (`thoth`) that sources, narrates, and edits short-form
viral clips. This design adds a **web dashboard** to drive and observe it, without
turning the engine into a fragile CLI-output-scraper.

The dashboard is planned in three phases (Control+Monitor → Review/QC →
Config/Style). The foundation this design lays — a shared core library plus a
thin service adapter — is what makes all three phases (and an eventual cloud
deployment) sit on one architecture rather than a rewrite per phase.

### Goals
- Drive pipeline runs (`run`, `scout`, `analyze`, …) from a browser, on this
  machine or any device on the network; remote/cloud later on the **same** arch.
- Live per-stage progress + log streaming for long (minutes-long) jobs.
- Typed access to structured pipeline data (moment scores, transcript, narration)
  for the later Review/QC phase — not scraped from human-readable logs.
- CLI and service share **one** interface, kept in sync by the compiler.

### Non-goals (YAGNI for now)
- gRPC (browser can't speak it natively; revisit only for service-to-service).
- Multi-user auth / RBAC / OIDC (single operator; a static API key is enough now,
  OIDC is a later upgrade).
- Moving the engine off this GPU box (CUDA is required; cloud = expose this box).
- A hosted/third-party datastore for job state (use a local embedded SQLite file).

## 2. Current state → why refactor

- The `thoth` crate is **binary-only** (`[[bin]]`, no `[lib]`): pipeline logic and
  types live under `src/` reachable only from `main.rs`. A service cannot reuse
  them in-process today.
- The CLI already shells out to `python` (scripts/) and `bun` (scout/) and to
  `ffmpeg.exe` — the system is already subprocess-oriented, so a CLI-as-worker
  model fits the existing grain.
- Whisper (whisper-rs, `cuda` feature) is linked **in-process**. Any in-process
  caller of the pipeline inherits GPU/native crash risk — the motivation for
  running jobs as isolated worker subprocesses.

## 3. Target architecture

Cargo **workspace**, three crates + a frontend folder:

```
crates/
  thoth-core    (lib)  Pipeline logic + ALL serde types. Heavy deps
                       (wgpu, whisper-rs/cuda, ffmpeg-sidecar) are FEATURE-GATED
                       so a consumer can depend on the types alone.
  thoth         (bin)  CLI adapter (clap + branded TTY output). ALSO the worker
                       that thoth-server spawns. Depends on thoth-core with full
                       features (links CUDA).
  thoth-server  (bin)  REST + SSE adapter (axum). Depends on thoth-core with
                       default-features = false (types + light helpers only) →
                       does NOT link CUDA/Whisper. Serves the built SPA.
dashboard/            Vite + React + TypeScript + shadcn/ui + Tailwind SPA.
scout/  scripts/  src→crates/thoth-*   (existing TS / Python unchanged)
```

```
 Browser (any device)
   │  REST (commands, config, artifacts)  +  SSE (progress/log stream)
   ▼
 thoth-server (axum)  ── serves SPA static bundle (single origin)
   │  spawns worker subprocess per job:  `thoth <cmd> --progress-json`
   │  reads NDJSON progress  +  typed JSON artifacts (thoth-core types)
   ▼
 thoth (CLI worker)  ── thoth-core (full features)
   │
   ▼  ffmpeg.exe · Whisper CUDA · wgpu · python/ · bun scout/
```

### Why this shape
- **Shared interface, enforced by compiler.** Change a public signature/type in
  `thoth-core` → `thoth` and `thoth-server` fail to compile until both are
  updated. The sync rule is structural, not a promise in a doc.
- **Crash isolation.** A GPU OOM / native segfault kills only the worker process;
  the server observes a non-zero exit and reports a failed job. Server stays up.
- **Lightweight server.** thoth-server never links CUDA/Whisper, so it builds fast
  and deploys without the GPU toolchain — it only needs the worker binary present.
- **Not scraping.** The worker emits *structured* NDJSON progress and writes typed
  JSON artifacts; the server deserializes them with thoth-core's own types.

## 4. Component responsibilities

### thoth-core (lib)
- Owns every pipeline type: `JobSpec`, `Moment`, `Transcript`, `NarrationScript`,
  `ProgressEvent`, config structs, content-set structs, etc. (`serde`, no heavy
  deps in the type layer).
- Owns the orchestration + stage logic (ingest, transcribe, analyze, narration,
  edit, encode) behind feature flags for the heavy runtime deps.
- Emits progress as a typed `ProgressEvent` stream that adapters render however
  they like (TTY for CLI, NDJSON+SSE for server).

### thoth (CLI / worker bin)
- Parses clap args → builds a `JobSpec` → calls thoth-core.
- Default: branded TTY output (unchanged; `src/brand.rs` behavior preserved).
- New opt-in flag `--progress-json`: emit newline-delimited `ProgressEvent` JSON
  to stdout (machine channel). Without it, nothing changes for human use.
- This binary is exactly what the server spawns as a worker.

### thoth-server (REST/SSE bin)
- REST endpoints (see §6) + SSE stream per job.
- Job executor: spawns `thoth … --progress-json` via `tokio::process`, parses the
  NDJSON line stream into `ProgressEvent`s, fans them out to SSE subscribers,
  and persists job state to an **embedded SQLite store** — the existing `sqlx`
  dependency with its `sqlite` feature; a local file, no external service. (A
  small in-memory map still fronts SQLite for the live SSE fan-out.)
- Auth: a static **API key** guards every endpoint (from config/env). OIDC is a
  later upgrade, not built now.
- Serves the compiled SPA as static files (single origin; no CORS).
- Generates OpenAPI via `utoipa`; a build step generates the TS client for the SPA.

### dashboard/ (SPA)
- fetch (REST) + `EventSource` (SSE). shadcn/ui components; Recharts for score viz.

## 5. Execution model (one run, end to end)

1. Browser `POST /jobs` with a typed `JobSpec` (url/content-set + params).
2. Server validates, assigns `job_id`, spawns `thoth run --progress-json …`.
3. Worker runs the pipeline; on each stage boundary/tick it prints one
   `ProgressEvent` JSON line: `{"job_id","stage","pct","message","ts"}`.
4. Server parses each line, updates the SQLite job store, pushes to SSE
   subscribers of `GET /jobs/:id/stream`. Log lines (stderr) → `log` events.
5. Worker writes structured artifacts to the job's output dir (moments.json,
   transcript.json, narration, cover.png, final .mp4) — same files as today.
6. On exit: zero → job `succeeded`; non-zero → `failed` with captured stderr tail.
7. Browser fetches artifacts via `GET /artifacts/:job/*` (served from the dir).
8. `POST /jobs/:id/cancel` → server kills the worker process group.

## 6. Transport & API

**REST + SSE.** JSON bodies; OpenAPI (`utoipa`) is the typed contract → generated
TS client. gRPC intentionally deferred (browser needs a grpc-web proxy for zero
benefit here; the shared core means a gRPC adapter can be added later as a thin
fourth bin without touching core).

Endpoint sketch (MVP = §7 Phase 1 subset):

| Method | Path | Purpose | Phase |
|---|---|---|---|
| POST | `/jobs` | start a run (`JobSpec`) → `job_id` | 1 |
| GET | `/jobs` | list jobs + status | 1 |
| GET | `/jobs/:id` | one job detail | 1 |
| GET | `/jobs/:id/stream` | **SSE** progress + log | 1 |
| POST | `/jobs/:id/cancel` | kill worker | 1 |
| GET | `/artifacts/:id/*` | serve output files | 1 |
| GET | `/jobs/:id/moments` | typed moments + scores | 2 |
| POST | `/jobs/:id/rerender` | re-run edit with edited narration/subs | 2 |
| GET/PUT | `/config` | read/write config.toml | 3 |
| GET/PUT | `/profiles`, `/vocab`, `/curators` | style/data management | 3 |

**SSE event shape** (one JSON per `data:` line):
`{"type":"progress"|"log"|"done"|"error","job_id","stage","pct","message","ts"}`.

**Auth.** Every endpoint requires a static API key. REST/fetch sends it as an
`Authorization: Bearer <key>` header. SSE is the exception — the browser
`EventSource` API **cannot set headers**, so the stream authenticates via a
same-origin cookie (set on first authenticated request) or a short-lived token
query param; the choice is settled in implementation.

## 7. Phasing

| Phase | Area | Scope |
|---|---|---|
| **1 — MVP** | Control + Monitor | `thoth-core` extraction (workspace + lib split), `--progress-json`, thoth-server job executor + SSE, SQLite job store, API-key auth, `/jobs*` + `/artifacts`, dashboard "cockpit": start a run, live stage progress, log pane, artifact links. |
| **2** | Review & QC | `/jobs/:id/moments`, video player, score charts, edit narration/subtitle, `/rerender`. |
| **3** | Config & Style | `/config`, `/profiles`, `/vocab`, `/curators`, API keys panel. |

Phase 1 is the MVP because the job/run infrastructure + live monitoring is the
backbone the other two phases consume; a config panel without the ability to run
is just a TOML editor.

## 8. Error handling & isolation

- Worker failure → non-zero exit → job `failed`, stderr tail surfaced to UI. The
  server process is never brought down by a job (native GPU crash included).
- Malformed NDJSON line → dropped with a `warn`, stream continues (best-effort,
  matching the codebase's graceful-degradation convention).
- SSE auto-reconnects (browser `EventSource`); on reconnect the client re-reads
  `GET /jobs/:id` for a state snapshot, then resumes the stream.
- thoth-server refuses to start jobs if the `thoth` worker binary is not found,
  with a clear message (mirrors the CLI's existing "python not found" degrade).

## 9. Interface-sync contract (to add to CLAUDE.md)

> `thoth-core` is the single source of truth for pipeline types and behavior.
> Any change to its public surface MUST update both adapters (`thoth` CLI and
> `thoth-server`) and regenerate the OpenAPI + TS client. The compiler enforces
> the Rust side; the OpenAPI/TS-client regen is the one step it cannot, so it is
> mandatory in the same change.

## 10. Testing

- **thoth-core**: unit tests for `JobSpec`/artifact (de)serialization round-trips
  and the `ProgressEvent` schema (the wire contract between worker and server).
- **thoth-server**: an integration test that spawns a stub worker emitting canned
  NDJSON and asserts the SSE stream + final job state — no GPU needed.
- **CLI**: one test asserting `--progress-json` emits valid `ProgressEvent` lines.
- Per repo rule, feature work closes with a full `build_cuda.bat` (workspace)
  before being marked done.

## 11. Open questions / future

- Job persistence: **embedded SQLite** (local file via `sqlx`'s `sqlite` feature)
  — self-hosted, no third-party service. RAG/embeddings stay on Supabase/pgvector;
  that is heavy pipeline data, separate from operational job metadata.
- Auth: **static API key by default** on all endpoints. **OIDC** is the planned
  later upgrade for real multi-user / external exposure.
- gRPC adapter: only if service-to-service (worker fleet / native clients) appears.
- Cloud: this GPU box becomes the exposed worker host (tunnel/port-forward), not a
  GPU-less web server.

## 12. Crate-boundary detail to resolve during implementation

- Whether the heavy-dep gating in `thoth-core` is done via cargo features
  (`default-features = false` for the server) or by extracting a tiny
  `thoth-types` crate. Feature-gating is preferred first (one fewer crate); split
  only if the server still pulls unwanted deps transitively.
