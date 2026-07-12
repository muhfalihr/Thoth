# Running Thoth (server + worker)

Since the SQLite job-queue redesign, Thoth runs as **two independent peer
processes** that share nothing but one SQLite file:

- **`thoth worker`** — the engine. Pulls queued jobs from the DB and runs the
  full pipeline in-process, so CUDA/Whisper models stay warm between jobs.
- **`thoth-server`** — the REST/SSE web API (serves the dashboard SPA).

There is **no parent/child link** between them: no spawning, no stdio, no
supervisor. The server enqueues a job row; the worker claims it; both watch the
same `job_events` table. Kill or restart either one independently.

## The one thing that must match

Both processes must point at the **same `THOTH_DB` file**. Start order does not
matter — whichever starts first creates the DB (WAL mode); the other attaches.

## Launch

Two terminals. Replace `<key>` with a shared secret (the SPA sends it as a
bearer token; `dev-key` is the default for local use).

### Linux / macOS

```sh
# Terminal 1 — engine (warm worker)
THOTH_DB=./thoth.db thoth worker

# Terminal 2 — web server + SPA (http://127.0.0.1:8787)
THOTH_DB=./thoth.db THOTH_API_KEY=<key> THOTH_OUTPUT_ROOT=./output thoth-server
```

### Windows (PowerShell)

```powershell
# Terminal 1 — engine
$env:THOTH_DB = ".\thoth.db"; .\thoth.exe worker

# Terminal 2 — web server
$env:THOTH_DB = ".\thoth.db"; $env:THOTH_API_KEY = "<key>"; $env:THOTH_OUTPUT_ROOT = ".\output"; .\thoth-server.exe
```

`--db` is also accepted on the worker (`thoth worker --db ./thoth.db`); it and
`THOTH_DB` default to `thoth.db` in the current directory.

## Environment variables

| Variable            | Process        | Default    | Purpose                                            |
|---------------------|----------------|------------|----------------------------------------------------|
| `THOTH_DB`          | both           | `thoth.db` | Shared SQLite/WAL job database. **Must match.**    |
| `THOTH_API_KEY`     | server         | `dev-key`  | Bearer token the SPA/clients must send.            |
| `THOTH_OUTPUT_ROOT` | server         | `output`   | Root served by `/api/artifacts/<job_id>/*`.        |
| `THOTH_ADDR`        | server         | `127.0.0.1:8787` | Bind address. Set e.g. `0.0.0.0:9000` to expose, or another port if 8787 is taken. |

The worker writes each job's artifacts to `<output_dir>` recorded on the job row
(the server sets this to `THOTH_OUTPUT_ROOT/<job_id>`), so the artifact route and
the worker agree without any extra config.

## Scaling / crashes

- Run **multiple `thoth worker` processes** against the same DB for parallelism —
  the atomic claim (`UPDATE … WHERE id=(SELECT … LIMIT 1) RETURNING`) guarantees
  each job goes to exactly one worker.
- If a worker crashes mid-job, the server's **reaper** notices the stale
  heartbeat (~30s) and fails the job so it doesn't hang `running` forever.
- Cancellation is **cooperative**: the server flips `cancel_requested` on the job
  row; the worker polls it. No process signalling, no `taskkill` — works
  identically on Linux, macOS, and Windows.
