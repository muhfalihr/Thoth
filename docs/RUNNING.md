# Running Thoth

There are two ways to run Thoth. Pick whichever fits how you work:

| Mode | What it is | Use it when |
|---|---|---|
| **[A. Single-command CLI](#a-single-command-cli)** | One `thoth run …` invocation does the whole pipeline and exits. | One-off clips, scripting, cron jobs. |
| **[B. Server + worker](#b-server--worker-deployment)** | A long-running web API (`thoth-server`) + a warm engine (`thoth worker`) sharing a SQLite queue; drive it from the dashboard SPA or the REST API. | A dashboard/UI, many jobs, or keeping models warm between jobs. |

This page assumes you have already built the binaries — see **[INSTALL.md](INSTALL.md)**.
Full flag reference is in **[CLI.md](CLI.md)**.

> **Binary names / paths.** On Windows the binaries are `thoth.exe` and
> `thoth-server.exe`; on Linux/macOS they are `thoth` and `thoth-server`. After a
> release build they live in `target/release/`. Either add that folder to your `PATH`
> or call the binary by its path. The examples use the bare name.

---

## A. Single-command CLI

Run the full pipeline on one URL (or local file) and get clips out.

### Windows (PowerShell)

```powershell
.\target\release\thoth.exe run "https://youtu.be/xxxx" --provider novita
# from a local file, square layout, 5 clips:
.\target\release\thoth.exe run .\video.mp4 --layout square --max-clips 5
# narrator-driven from a scout content-set:
.\target\release\thoth.exe run --content .\scout\output\thoth_content_set.json --provider novita
```

### Linux / macOS

```bash
./target/release/thoth run "https://youtu.be/xxxx" --provider novita
# from a local file, square layout, 5 clips:
./target/release/thoth run ./video.mp4 --layout square --max-clips 5
# narrator-driven from a scout content-set:
./target/release/thoth run --content ./scout/output/thoth_content_set.json --provider novita
```

Output lands in `output/.thoth/<job-id>/clips/*.mp4`. Resume a failed job with
`thoth run --resume <JOB_ID>`. See **[PIPELINE.md](PIPELINE.md)** for the full output
layout.

---

## B. Server + worker deployment

Thoth's UI mode runs as **two independent peer processes** that share nothing but one
SQLite file:

- **`thoth worker`** — the engine. Pulls queued jobs from the DB and runs the full
  pipeline in-process, so CUDA/Whisper models stay warm between jobs.
- **`thoth-server`** — the REST/SSE web API (serves the dashboard SPA).

There is **no parent/child link** between them: no spawning, no stdio, no supervisor.
The server enqueues a job row; the worker claims it; both watch the same `job_events`
table. Kill or restart either one independently.

### The one thing that must match

Both processes must point at the **same `THOTH_DB` file**. Start order does not matter
— whichever starts first creates the DB (WAL mode); the other attaches.

### Launch

Use two terminals. Replace `<key>` with a shared secret (the SPA sends it as a bearer
token; `dev-key` is the default for local use).

**Windows (PowerShell)**

```powershell
# Terminal 1 — engine (warm worker)
$env:THOTH_DB = ".\thoth.db"; .\target\release\thoth.exe worker

# Terminal 2 — web server + SPA (http://127.0.0.1:8787)
$env:THOTH_DB = ".\thoth.db"; $env:THOTH_API_KEY = "<key>"; $env:THOTH_OUTPUT_ROOT = ".\output"; .\target\release\thoth-server.exe
```

**Linux / macOS**

```bash
# Terminal 1 — engine (warm worker)
THOTH_DB=./thoth.db ./target/release/thoth worker

# Terminal 2 — web server + SPA (http://127.0.0.1:8787)
THOTH_DB=./thoth.db THOTH_API_KEY=<key> THOTH_OUTPUT_ROOT=./output ./target/release/thoth-server
```

`--db` is also accepted on the worker (`thoth worker --db ./thoth.db`); it and
`THOTH_DB` default to `thoth.db` in the current directory.

### Environment variables

| Variable | Process | Default | Purpose |
|---|---|---|---|
| `THOTH_DB` | both | `thoth.db` | Shared SQLite/WAL job database. **Must match on both.** |
| `THOTH_API_KEY` | server | `dev-key` | Bearer token the SPA/clients must send. |
| `THOTH_OUTPUT_ROOT` | server | `output` | Root served by `/api/artifacts/<job_id>/*`. |
| `THOTH_ADDR` | server | `127.0.0.1:8787` | Bind address. Set e.g. `0.0.0.0:9000` to expose on the network, or another port if 8787 is taken. |

The worker writes each job's artifacts to the `<output_dir>` recorded on the job row
(the server sets this to `THOTH_OUTPUT_ROOT/<job_id>`), so the artifact route and the
worker agree without any extra config.

### Using the API directly

```bash
# enqueue a run job (returns 201 + {"job_id": "..."})
curl -X POST http://127.0.0.1:8787/api/jobs \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"command":"run","url":"https://youtu.be/xxxx"}'

# list / inspect jobs
curl -H "Authorization: Bearer <key>" http://127.0.0.1:8787/api/jobs
curl -H "Authorization: Bearer <key>" http://127.0.0.1:8787/api/jobs/<job_id>

# live progress stream (SSE; self-authenticates via ?token=)
curl -N "http://127.0.0.1:8787/api/jobs/<job_id>/stream?token=<key>"
```

### Scaling & crash behaviour

- Run **multiple `thoth worker` processes** against the same DB for parallelism — the
  atomic claim (`UPDATE … WHERE id=(SELECT … LIMIT 1) RETURNING`) guarantees each job
  goes to exactly one worker.
- If a worker crashes mid-job, the server's **reaper** notices the stale heartbeat
  (~30s) and fails the job so it never hangs in `running` forever.
- Cancellation is **cooperative**: the server flips `cancel_requested` on the job row;
  the worker polls it. No process signalling, no `taskkill` — it works identically on
  Windows, Linux, and macOS.
