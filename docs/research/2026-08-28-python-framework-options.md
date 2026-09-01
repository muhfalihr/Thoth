# Python control-plane and agent framework options for Thoth/CLIPPER

**Research date:** 2026-08-28  
**Method:** first-party documentation and the maintainers' source repositories only. Every external citation below is a primary source and was accessed on 2026-08-28.

## Decision in one page

Do not do a big-bang rewrite of TypeScript and Rust. The simplest durable target is:

```text
React + TypeScript dashboard
        |
        | stable, user-oriented REST + SSE/WebSocket contract
        v
Python FastAPI control plane
        |
        | start/query/cancel/approve jobs; never build a CLI command string
        v
Temporal workflows and Python workers
        |                         |
        |                         +-- Python acquisition/AI activities (incremental migration)
        +-- Rust media activities (Whisper/CUDA/FFmpeg/render, retained initially)
```

Use **FastAPI** for the product API and **Temporal Python** for long-running, restart-safe workflows. They solve different problems and should both be deliberate parts of the platform. The React application remains the only user dashboard.

For agents, select **one** SDK after a small acceptance-test spike; do not run Agno, LangGraph, and PydanticAI in the same production path. The evidence supports two viable choices:

1. **Agno SDK, behind FastAPI**, if its built-in approval model, toolkits, sessions, and traces are the immediate product priority. Do not expose AgentOS's generic API as the dashboard contract or add its Control Plane as a second user UI.
2. **PydanticAI, inside Temporal workflows**, if typed tools and the strongest documented direct Temporal integration are the priority. It is the lower-overlap choice when FastAPI owns the API and Temporal owns workflow state.

For this repository, start with a FastAPI + Temporal foundation and a narrow **Agno-versus-PydanticAI** spike for one read-only "source investigation" agent. Keep the winning SDK; remove the other. **LangGraph** is a credible alternative if explicit graph state and review/edit nodes become the main requirement, not an additional layer. **Taskiq** is not the primary media-workflow engine.

## Current-repository constraints

The recommendation preserves the work that already exists instead of assuming Python is a free replacement:

- Thoth already has a Rust server/worker and a shared SQLite job queue; cancellation and streamed artifacts are part of its documented runtime contract. The dashboard is a React/Vite SPA served by the Rust server today. [Repository runtime documentation](../RUNNING.md) and [README](../../README.md)
- The Rust video pipeline is GPU/media intensive: ingest, Whisper transcription, LLM analysis, enrichment, and FFmpeg/GPU editing. [Pipeline architecture](../PIPELINE.md)
- `thoth scout` currently forwards its arguments to `scout/cli.ts`; this is exactly the CLI coupling that the new API must eliminate. [CLI reference](../CLI.md#scout)
- Python is already present for targeted scripts (Playwright/scraping, TTS, Pillow, requests, and optional ML tooling), but it is not a web control plane yet. [Python requirements](../../requirements.txt)

The first migration is therefore an interface migration, not a language migration: represent a user request as a typed `WorkflowRequest`, invoke a workflow/activity/service directly, and publish typed `JobEvent`s. A CLI may call the same application service or Temporal Client, but the HTTP API must never shell out to the CLI.

## Capability comparison

| Option | HTTP, SSE, WebSocket | Durable long-running work | Approval / interruption | Agent and tool model | Observability | Runtime and local-first fit | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **FastAPI** | Native HTTP and WebSocket endpoints; `StreamingResponse` streams an iterator/generator, which can carry an SSE response. [WebSockets](https://fastapi.tiangolo.com/advanced/websockets/), [streaming responses](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse) | `BackgroundTasks` run after a response but are not a durable workflow engine. Its own docs direct heavy multi-process/distributed work to larger queue tools. [Caveat](https://fastapi.tiangolo.com/tutorial/background-tasks/#caveat) | Implemented by the domain/workflow service; no native pause/resume state machine | No agent runtime; this is desirable for the stable product boundary | Normal Python logging/OTel integration; automatic OpenAPI docs help preserve the React contract. [FastAPI README](https://github.com/fastapi/fastapi#interactive-api-docs) | One Python ASGI process (normally Uvicorn) plus the services it calls; excellent local API/BFF fit | **Adopt.** Own `/api/v1`, authentication, request validation, artifact download, and event streaming here. |
| **Agno + AgentOS** | AgentOS documents REST, SSE, workflow WebSocket, MCP, and other interfaces, using a FastAPI backend. [AgentOS introduction](https://docs.agno.com/agent-os/introduction) | Documents background execution, checkpointing, persisted run history, cancellation, and database-configured state. [AgentOS introduction](https://docs.agno.com/agent-os/introduction) | Native HITL requirements pause a run, collect confirmation/input/external execution, then `continue_run`. [HITL](https://docs.agno.com/runtime/human-approval) | Agents, teams, workflows, toolkits, MCP, storage, and guardrails | OpenTelemetry instrumentation; built-in records can be stored in the configured database or exported. [Observability](https://docs.agno.com/runtime/observability) | SDK can use SQLite locally. AgentOS adds its own runtime/API/state concerns; production templates commonly add Docker and PostgreSQL. [Deployment templates](https://docs.agno.com/runtime/deploy) | **Shortlist/pilot.** Use its SDK from a custom FastAPI route; keep AgentOS/Control Plane optional and do not make it the dashboard's public contract. |
| **Temporal Python SDK** | No end-user HTTP/SSE/UI server; FastAPI must translate product requests into Temporal Client calls | Purpose-built durable workflows: event history is replayed; workflows resume after failures and external side effects belong in Activities. [Workflow overview](https://docs.temporal.io/workflows) | Signals/Updates plus `workflow.wait_condition` support a persisted approval/cancel state; protect concurrent handler state. [Python message passing](https://docs.temporal.io/develop/python/workflows/message-passing) | Not an LLM framework; activities are normal code and can invoke an agent SDK or a Rust/Python engine | Optional metrics and OpenTelemetry cover client, workflow, and activity operations. [Observability](https://docs.temporal.io/develop/python/platform/observability) | Requires a Temporal Server and independently running Workers; a local dev server is available. Python SDK currently requires Python 3.10+. [SDK README](https://github.com/temporalio/sdk-python) | **Adopt for durable jobs.** It has an operational cost, but directly addresses multi-stage retry, restart, human approval, cancellation, and audit needs. |
| **LangGraph** | Python streaming APIs expose updates/messages/custom events; FastAPI still provides the HTTP/SSE/WebSocket boundary. [Streaming](https://docs.langchain.com/oss/python/langgraph/streaming) | Checkpointers persist thread state; SQLite is documented for local development and PostgreSQL for production. [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | `interrupt()` saves state and pauses indefinitely; a `Command(resume=...)` resumes the same `thread_id`. [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Low-level graph/stateful agent infrastructure; tools can be nodes | LangSmith is an optional ecosystem observability product; graph streaming is useful for a custom dashboard. [Project README](https://github.com/langchain-ai/langgraph#why-use-langgraph) | Library plus persistent checkpointer; self-managed storage/worker/API design remains necessary | **Alternative, not additive.** Choose instead of Agno/PydanticAI only if explicit graph composition and state editing outweigh their simpler agent abstractions. |
| **PydanticAI** | It is not a general HTTP server. UI adapters can integrate with FastAPI/Starlette and stream supported UI protocols; keep the product REST/SSE contract custom. [UI overview](https://github.com/pydantic/pydantic-ai/blob/main/docs/ui/overview.md) | With `TemporalDurability`, model/tool/MCP work can run as durable Activities *when the agent is invoked from a Temporal Workflow*. Direct endpoint calls do not become durable merely by adding the dependency. [Temporal integration](https://github.com/pydantic/pydantic-ai/blob/main/docs/durable_execution/temporal.md) | Deferred tools can require approval or external execution; a caller resumes using `DeferredToolResults`. Approval is not authorization. [Deferred tools](https://github.com/pydantic/pydantic-ai/blob/main/docs/deferred-tools.md) | Typed Python functions/toolsets and `RunContext`; function signatures supply schemas. [Tools](https://github.com/pydantic/pydantic-ai/blob/main/docs/tools.md) | Optional Logfire and arbitrary OpenTelemetry backend; content/binary capture can be disabled. [Logfire](https://github.com/pydantic/pydantic-ai/blob/main/docs/logfire.md) | Python 3.10+; base package plus provider extras, and a `temporal` extra only when selected. [Package metadata](https://github.com/pydantic/pydantic-ai/blob/main/pyproject.toml) | **Strong alternative/pilot.** Particularly good if the platform wants FastAPI/Pydantic contracts and Temporal-native agent durability with minimal duplicated runtime surface. |
| **Taskiq** | Optional `taskiq-fastapi` integration starts/shuts a broker with the FastAPI lifespan. [Integration](https://github.com/taskiq-python/taskiq/blob/master/docs/framework_integrations/taskiq-with-fastapi.md) | Queued tasks and result lookup, not a persisted multi-step workflow state machine | No first-class durable approval/resume conversation; implement it separately | No agent SDK | Retry, Prometheus, and OTel middleware exist. [Middleware](https://github.com/taskiq-python/taskiq/blob/master/docs/available-components/middlewares.md) | Production setup adds broker, result backend, and separate worker; docs point to broker/result backend choices. [Getting started](https://github.com/taskiq-python/taskiq/blob/master/docs/guide/getting-started.md) | **Do not adopt as the main engine.** Consider only later for isolated fire-and-forget side work if Temporal is intentionally not used. |

## Consequences for the three interfaces

### Dashboard: reduce technical choices to a workflow

The dashboard should use vocabulary such as **New video**, **Source**, **Style**, **Review**, **Progress**, **Needs your decision**, **Results**, and **Retry**. It should not expose `per`, `max`, `cap`, raw CLI flags, or a process log as the primary interface.

Suggested minimal contract:

```text
POST /api/v1/workflows               -> { workflowId, status: "queued" }
GET  /api/v1/workflows/{id}          -> typed summary, stages, artifacts, current decision
GET  /api/v1/workflows/{id}/events   -> SSE JobEvent stream
POST /api/v1/workflows/{id}/approve  -> a specific, audited decision payload
POST /api/v1/workflows/{id}/cancel   -> cancellation request
POST /api/v1/workflows/{id}/retry    -> explicit stage/workflow retry policy
```

Persist structured events and decisions; terminal text is an optional diagnostic, not the source of truth. The React client generates types from OpenAPI or shares a versioned schema package, never from CLI help text.

### CLI: an operator/client adapter, not the execution engine

Keep `thoth` and Scout CLI commands for development, batch automation, and recovery. Rework them gradually so they parse flags into the same typed request model and call the same domain service/Temporal Client as FastAPI. The sequence must be:

```text
CLI flags -> typed request -> application service / Temporal Client -> workflow
HTTP JSON -> typed request -> application service / Temporal Client -> workflow
React form -> HTTP JSON -> typed request -> application service / Temporal Client -> workflow
```

There is no `HTTP handler -> subprocess("thoth ...")` or `HTTP handler -> subprocess("bun scout/cli.ts ...")` arrow. This is the boundary that makes UI/CLI/API independently replaceable.

### Engine activities: keep large bytes and permissions out of workflow state

Temporal's workflow history is not a place for videos, audio, frame arrays, raw model payloads, or secrets. Store only job IDs, small typed metadata, artifact references/checksums, and user decisions in workflow state. Implement download, browser acquisition, Whisper, model calls, FFmpeg/GPU render, and filesystem writes as activities that report artifact references.

This permits safe incremental migration:

1. Wrap the existing Rust engine as a well-bounded Activity/worker adapter first. It can remain the CUDA/FFmpeg/Whisper implementation.
2. Move Scout/browser and LLM acquisition into Python Activities only after parity tests prove the result and cancellation behavior.
3. Replace a Rust activity only when Python has equivalent artifact, timeout, cancellation, and performance acceptance evidence. Python feasibility is not evidence that a rewrite improves the GPU path.

## Approval and agent safety model

An agent should be a planner and a user-facing investigator, not the authority that executes irreversible work. Tool definitions should map to narrow domain actions, for example `inspect_source`, `propose_replacement`, `prepare_render`, and `request_publish`. The domain/activity boundary must authenticate the caller, authorize the action, validate the typed input, record an audit event, and require a persisted approval for sensitive actions.

Both Agno and PydanticAI document human approval flows, but their approval mechanisms are not a replacement for server-side authorization. In particular, PydanticAI explicitly warns that client-supplied history/approval is not an authorization boundary. [Deferred-tools security note](https://github.com/pydantic/pydantic-ai/blob/main/docs/deferred-tools.md#human-in-the-loop-tool-approval)

## Recommended evaluation gates before adopting the agent SDK

Run the same small, disposable implementation through Agno and PydanticAI. No production workflow should depend on either before it passes these tests:

| Test | Pass condition |
| --- | --- |
| Source explanation | Given a URL and the existing candidate diagnostics, agent returns a validated, citation-bearing explanation without acquiring/downloading media |
| Permission | Agent proposes, but cannot download, render, delete, or publish until a server-side approved decision is submitted |
| Restart | Pause for approval, restart API/worker, then resume exactly one workflow without duplicating the activity |
| Cancellation | Cancel during a long acquisition/render; the owned subprocess/browser is stopped and terminal state is `cancelled`, never silently `failed` |
| Dashboard events | React receives stage transitions, progress, approval-needed, completion, and error as stable typed events without parsing stdout |
| Observability | One workflow ID correlates HTTP request, agent/tool call, activity, artifact, failure/retry, approval, and cancellation; secret/media content is excluded by default |

Select the SDK that passes with the smaller custom adapter and fewer long-lived services. If neither provides measurable user value after this spike, defer the agent layer: FastAPI + Temporal still makes the dashboard and pipeline materially simpler.

## Adoption order

1. **Write the API and event schemas before moving code.** Use product terms; publish OpenAPI; map them to the current SQLite job model temporarily.
2. **Introduce FastAPI as a local control plane** with read-only workflow/job endpoints and an SSE event bridge. Do not expose CLI flags.
3. **Move job lifecycle to Temporal** with one workflow and existing Rust execution behind Activities. Run its local server/worker beside the current system during a parity period; do not create a second, competing queue permanently.
4. **Add approval, cancel, retry, and artifact-reference semantics** to the workflow and dashboard. Verify crash/restart behavior.
5. **Run the one-agent SDK spike**, make a deliberate single-SDK choice, and only then add bounded agent tools.
6. **Migrate Scout incrementally** from TypeScript/Bun only where Python has parity. Retain React/TypeScript dashboard and Rust GPU path until evidence justifies a replacement.

## Source index

All sources are official documentation or the owning project's repository, accessed 2026-08-28.

- FastAPI: [WebSockets](https://fastapi.tiangolo.com/advanced/websockets/), [StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse), [BackgroundTasks caveat](https://fastapi.tiangolo.com/tutorial/background-tasks/#caveat), [source repository](https://github.com/fastapi/fastapi)
- Agno: [AgentOS introduction](https://docs.agno.com/agent-os/introduction), [human-in-the-loop](https://docs.agno.com/runtime/human-approval), [observability](https://docs.agno.com/runtime/observability), [source repository](https://github.com/agno-agi/agno)
- Temporal: [workflow overview](https://docs.temporal.io/workflows), [Python message passing](https://docs.temporal.io/develop/python/workflows/message-passing), [Python observability](https://docs.temporal.io/develop/python/platform/observability), [Python SDK repository](https://github.com/temporalio/sdk-python)
- LangGraph: [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [streaming](https://docs.langchain.com/oss/python/langgraph/streaming), [source repository](https://github.com/langchain-ai/langgraph)
- PydanticAI: [deferred tools](https://github.com/pydantic/pydantic-ai/blob/main/docs/deferred-tools.md), [Temporal integration](https://github.com/pydantic/pydantic-ai/blob/main/docs/durable_execution/temporal.md), [tools](https://github.com/pydantic/pydantic-ai/blob/main/docs/tools.md), [UI adapter](https://github.com/pydantic/pydantic-ai/blob/main/docs/ui/overview.md), [observability](https://github.com/pydantic/pydantic-ai/blob/main/docs/logfire.md)
- Taskiq: [FastAPI integration](https://github.com/taskiq-python/taskiq/blob/master/docs/framework_integrations/taskiq-with-fastapi.md), [task/broker/result lifecycle](https://github.com/taskiq-python/taskiq/blob/master/docs/guide/getting-started.md), [middleware](https://github.com/taskiq-python/taskiq/blob/master/docs/available-components/middlewares.md)
