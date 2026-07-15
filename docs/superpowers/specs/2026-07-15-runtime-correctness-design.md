# Thoth Runtime Correctness Hardening

*Date: 2026-07-15 · Status: approved in brainstorming, pending written-spec review*

## 1. Context

Thoth is intended to run as a single-operator tool on a trusted local machine or
LAN. The server and warm worker are independent peer processes that communicate
only through a shared SQLite database in WAL mode. That boundary remains intact:
the Axum server must not acquire pipeline, FFmpeg, CUDA, Whisper, or GPU
dependencies.

The publish-readiness audit found three runtime correctness gaps:

1. Cancelling a running job only sets `cancel_requested`; no live cancellation
   token is triggered, and the existing test simulates cancellation by returning
   a string error.
2. Artifact endpoints read the complete file into a `Vec<u8>`, which scales
   poorly for video and does not implement byte-range seeking.
3. Invalid job requests can enter the queue and fail later in the worker.

This design addresses those gaps as the first of four publish-hardening
subprojects.

## 2. Fixed Roadmap

The hardening program proceeds in this order:

1. **Runtime correctness** — this specification: live cancellation, cancellable
   child processes, artifact streaming and HTTP Range, and job validation.
2. **Local/LAN security** — remove unsafe defaults, define bind policy, improve
   token handling, and document the trusted-network boundary.
3. **Persistence and operations** — pagination, retention, atomic config writes,
   readiness, and operational visibility.
4. **CI and release** — quality gates, dashboard and Scout tests, packaging,
   dependency and secret scanning, and release documentation.

Each subproject receives its own design, implementation plan, TDD cycle, and
verification gate. Completing this specification does not implicitly complete
the other three.

## 3. Goals

- A cancellation request for a running job is observed and begins shutdown in
  no more than two seconds while SQLite is available.
- Rust stages exit cooperatively and active external process trees are
  terminated and reaped.
- A job emits exactly one terminal outcome and a terminal state cannot be
  overwritten by normal completion or the stale-worker reaper.
- Artifact delivery supports constant-memory streaming, `HEAD`, and single byte
  ranges for every artifact type.
- Invalid job requests are rejected before enqueue with a structured response.
- The worker remains warm and the server remains isolated from heavy pipeline
  dependencies.

## 4. Non-goals

- Internet-grade authentication, accounts, sessions, or role-based access.
- Job/event pagination and retention.
- Atomic configuration persistence and backup policy.
- CI, release packaging, containerization, or service-manager integration.
- Multiple byte ranges in one response.
- Replacing SQLite as the worker/server control plane.
- Reverting to one operating-system subprocess per job.

## 5. Chosen Approach

Use a central execution context per claimed job. The alternatives were rejected
as follows:

- A minimal token poll at a few stage boundaries cannot guarantee prompt
  shutdown of FFmpeg, yt-dlp, or newly added stages.
- Restoring subprocess-per-job execution makes process-tree cancellation easy
  but loses warm models and reverses the approved SQLite peer-process design.

The central context makes cancellation a runtime capability shared by every
stage without coupling the server to the media pipeline.

## 6. Runtime Architecture

### 6.1 Job execution context

Every claimed job owns a `JobExecutionContext` containing:

- a clonable cancellation token;
- a DB cancellation watcher;
- a child-process supervisor;
- lifecycle cleanup that stops the watcher and reaps registered children.

The worker creates the context before entering `run_once`. A reference or clone
is passed through `run_once`, the pipeline runner, stage services, and external
command helpers. The context is production infrastructure, not a test-only hook.

### 6.2 DB cancellation watcher

The watcher polls `cancel_requested` at most every 250 milliseconds. When the
flag becomes true it cancels the context token exactly once. Transient DB read
errors are logged and retried; the two-second target applies while SQLite can be
read. The watcher is always stopped when the job reaches a terminal outcome.

SQLite remains the sole cross-process control plane. The server does not hold or
signal an in-memory worker handle.

### 6.3 Child-process supervisor

All pipeline-owned external commands use one cancellable command abstraction.
It must:

- spawn the command in a process group suitable for the host platform;
- register the active child before waiting;
- race command completion against the cancellation token;
- on cancellation, terminate the process group/tree, wait for exit, unregister
  it, and return a typed cancellation result;
- unregister and return the real exit status on normal completion.

This abstraction covers FFmpeg, ffprobe, yt-dlp, and other commands used during
a job. Direct blocking waits in a cancellable pipeline path are migrated to the
abstraction. Dropping a future must not orphan a process.

## 7. State and Event Semantics

### 7.1 Cancel endpoint

- A queued job transitions directly to `cancelled` and receives one terminal
  cancellation event.
- A running job remains `running` while `cancel_requested` is set; the worker
  owns the terminal transition after runtime cleanup.
- Cancelling an already terminal job returns conflict without changing data.

### 7.2 Typed execution outcome

Pipeline execution distinguishes `Cancelled` from operational failure using a
typed outcome/error. Production code must not infer cancellation using string
matching such as `contains("cancelled")`.

### 7.3 Compare-and-set terminal transitions

Finishing a job is conditional on its expected active state. The worker,
cancel endpoint, and reaper cannot overwrite a terminal status. Cancellation
produces one `cancelled` terminal event; success produces `done`; real failures
produce `error`. The dashboard treats `cancelled` as a terminal state distinct
from failure and closes the event stream cleanly.

## 8. Artifact HTTP Contract

Artifact path validation occurs before opening the file. Both the job id and
relative path must consist only of normal path components and must remain under
the configured output root.

For every regular artifact file:

- `HEAD` returns the same status and representation headers as `GET`, but no
  body.
- `GET` without `Range` returns `200`, `Content-Type`, `Content-Length`, and
  `Accept-Ranges: bytes`, while streaming from disk.
- A valid single prefix, suffix, or open-ended byte range returns `206` with
  correct `Content-Range` and `Content-Length`.
- An unsatisfiable, malformed, or multi-range request returns `416` and
  `Content-Range: bytes */<full-length>`.
- Missing and non-regular files return `404`.

The body is backed by asynchronous file I/O and bounded chunks. No handler may
load the complete artifact into memory. The same responder serves job artifacts
and Scout output while preserving their existing authentication boundaries.

## 9. Job Validation Contract

The pure validation contract lives in `thoth-jobs` so the server and worker can
share it without making the server depend on `thoth-core`. The server invokes it
before `JobStore::enqueue`; CLI argument translation consumes the same parameter
and protected-flag definitions. Invalid input returns HTTP `422` with:

```json
{
  "error": {
    "field": "content_set",
    "code": "exactly_one_source",
    "message": "provide exactly one of url or content_set"
  }
}
```

Rules:

- `command` must be exactly `run`.
- Exactly one of `url` and `content_set` must be present.
- Source strings and string parameters must not be blank after trimming.
- Known parameters must match the type and numeric range accepted by the CLI.
- Unknown keys inside `params` are rejected rather than silently ignored.
- `extra_args` remains available to the trusted local operator and must be an
  array of non-empty strings.
- `extra_args` may not provide positional source input or override worker-owned
  flags, including `--output-dir`, `--job-id`, `--content`, and their
  `--flag=value` forms.

Validation and CLI argument translation share one definition of protected
flags so their behavior cannot drift.

## 10. Error Handling and Cleanup

- Cancellation is not logged or presented as a pipeline failure.
- Failure to terminate a child process is recorded with command and process id,
  but cleanup continues for all registered children before the job is finalized.
- A watcher DB error never panics the worker; it is retried with bounded polling.
- Artifact streaming errors after headers are sent terminate the response and
  are logged without allocating a retry buffer.
- Request validation errors never create a job row or job event.
- Worker cleanup runs on success, failure, cancellation, and task unwinding.

## 11. TDD Strategy

Every behavior change begins with a failing test that is observed before the
production change.

### 11.1 Store and state tests

- Queued cancellation is terminal and idempotent.
- A running cancellation request only sets the flag.
- Conditional finish cannot overwrite `cancelled`, `failed`, or `succeeded`.
- Reaper cannot replace a terminal state or duplicate the terminal event.

### 11.2 Runtime cancellation tests

- A long-running injected future is cancelled through the real DB flag and
  finishes in less than two seconds.
- The terminal status and event are `cancelled`, not `failed`.
- A sleeping helper child process and its process group are terminated and
  reaped when the token is cancelled.
- Normal command completion preserves stdout/stderr and exit status.

### 11.3 Artifact route tests

- `HEAD` and full `GET` headers.
- Prefix, suffix, and open-ended ranges.
- `206`, `416`, and `Content-Range` calculations.
- Empty files, missing files, malformed and multiple ranges.
- Traversal and Windows-prefix rejection.
- A response body is streamed rather than materialized as `Vec<u8>`.

### 11.4 Validation tests

Use table-driven unit and HTTP route tests for command allowlisting, exactly-one
source, blank strings, known parameter types/ranges, unknown keys, valid
`extra_args`, and every protected flag spelling. Tests assert that invalid input
does not increase the job count.

### 11.5 Dashboard contract tests

The client recognizes a `cancelled` terminal event, updates the visible job
state, and closes its EventSource without presenting a failure message.

## 12. Verification Gate

The subproject is complete only when fresh verification demonstrates:

- targeted red-green tests for each behavior;
- all Rust workspace tests pass;
- Rust format check passes for touched Rust files and no new Clippy warnings are
  introduced by this work;
- dashboard lint and production build pass;
- Scout typecheck still passes;
- an HTTP smoke test proves enqueue rejection, live cancellation, `HEAD`, full
  streaming, `206`, and `416` behavior;
- no worker/server dependency-boundary regression is present.

## 13. Rollout and Compatibility

No database migration is required because `cancel_requested` and job status
already exist. The API gains structured `422` errors, `HEAD` support, Range
responses, and a distinct cancellation terminal event. Existing valid `run`
requests and full-file downloads remain compatible.

The operator documentation is updated in the same implementation plan so it no
longer claims cancellation behavior that the code does not provide. The next
hardening cycle begins with the separately tracked Local/LAN Security design.
