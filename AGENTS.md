# Agent Roles and Operator Handoff

## Role routing

Determine the active role from the current task before acting.

## Task entrypoints and documentation roles

For every task, invoke the applicable Superpowers skill first, then read the active SDD
checkpoint at `.superpowers/sdd/<task>/progress.md` and its linked design and plan under
`docs/superpowers/`. These are the task entrypoints.

- `BLUEPRINT.md` is an on-demand architecture and current-subsystem-status reference;
  it is not an entrypoint.
- `CHANGELOG.md` is an on-demand chronological implementation and audit-history
  reference, including records formerly maintained as `Last updated` entries in
  `BLUEPRINT.md`.
- Keep the active SDD `progress.md` checkpoint current. Append completed-work history,
  verification evidence, and audit records to `CHANGELOG.md`; do not recreate a
  chronological history section in `BLUEPRINT.md`.

## Technical stack and build verification

- **Stack:** Rust 2024 edition (async Tokio), Windows (CUDA 13.2, LLVM), local `ffmpeg.exe` at root, NVIDIA NVENC for encoding, CUDA for Whisper, `config.toml` (no secrets) + `.env` (API keys).
- **Mandatory verification sequence after every feature update:**
  1. **Full CUDA build:** Run `build_cuda.bat` (never rely on `cargo check` alone; zero errors and zero critical warnings required):
     ```cmd
     cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"
     ```
  2. **Testing:** Run relevant unit tests (`cargo test --bin thoth <module>`). Fix any failures before proceeding.
  3. **Record results:** Update the active SDD `progress.md` checkpoint and append the completed record to `CHANGELOG.md`. Never report complete from `cargo check` alone.

## Engineering conventions and git commits

- **Language rules:**
  - Chat responses to the operator: **Always Indonesian** (including explanations, summaries, clarifications, build/test reports).
  - Repository artifacts: **Always English** (code, comments, docstrings, variable names, commit messages, plans, specs, ADRs, issues, and all files under `docs/`).
- **Git commits:**
  - Write each commit message as one concise subject line, preferably no more than 72 characters.
  - Use exactly one `git commit -m "<subject>"`; do not add a body, detailed description, blank-line continuation, or trailer.
  - Never add `Co-Authored-By` or any AI attribution to a commit message.
- **Code & schema conventions:**
  - Use `#[serde(default)]` on new schema fields for backward-compatibility.
  - Every new feature must degrade gracefully if disabled or unavailable.
  - Log levels: `info!` for key progress, `warn!` for degradation, `debug!` for detail.

## Environment and operational guardrails

- **Python:** Use `python` (Anaconda 3.10). `python3` does NOT exist on this machine (returns exit 127).
- **Shell pathing:** In Bash use forward slashes (`C:/Users/...`) and `rg`/`tail`. In PowerShell use backslashes and `Select-Object -Last N`.
- **Large file access:** `src/analyze/service.rs` (~2400 lines) and generated JSON/HTML under `.understand-anything/tmp/`, `test/scraper/*.html`, and `arch-input.json` exceed read caps; use offset/limit, grep, or targeted scripts.
- **Issue tracker & domain docs:**
  - Issues live in GitHub (`muhfalihr/Thoth`) via `gh` CLI. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
  - Canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
  - Domain docs: Single-context `CONTEXT.md` plus `docs/adr/` at the repo root. See [`docs/agents/domain.md`](docs/agents/domain.md).

## Code intelligence routing

This repository is already indexed by several complementary layers. Do not add another
indexer, vector store, or RAG pipeline; use the layer that matches the question. Stop at
the first row that answers it, and prefer an index over reading whole files — a `Read` of
a 2000-line file to find one symbol is the most expensive way to answer a cheap question.

| Question | Use | Notes |
|---|---|---|
| Exact string, regex, known token | `Grep` / `rg` | No index, never stale. Always correct for literals. |
| What is `X`? Who calls it? What breaks if I change it? | `codegraph` MCP | `codegraph_context` first; then `codegraph_callers`/`codegraph_callees`/`codegraph_impact`. |
| Survey several related symbols at once | `codegraph_explore` | One capped call instead of many `Read`s. |
| Precise definition/reference/rename with compiler-grade accuracy | `serena` MCP | LSP-backed. See the language-coverage caveat below. |
| Architecture, cross-cutting concept, onboarding to an unfamiliar area | `graphify query "<question>"` | Returns a scoped subgraph. `graphify path`/`explain` for relationships. |
| Structural pattern match, codemod, mass refactor | `ast-grep` (`sg`) | AST-aware; use instead of regex for code shape. |

Current coverage, verified 2026-09-18:

- **codegraph** — 488 files, 9640 nodes, 10983 edges across Python, Rust, TypeScript, TSX,
  and JavaScript. This is the default layer for symbol questions in every part of the
  repository: the Rust crates, `python/`, `dashboard/`, and `scout/`.
- **serena** — `.serena/project.yml` sets `language_servers: [rust]`, so Serena answers
  only for Rust today. It returns nothing useful for `dashboard/` or `python/`. Until that
  list is extended, route non-Rust symbol questions to codegraph.
- **graphify** — `graphify-out/` holds 15229 nodes and 29036 links. `graph.json` records
  `built_at_commit`; compare it against `HEAD` before trusting a broad architectural answer.
  Read `graphify-out/GRAPH_REPORT.md` only for a broad architecture review, or when
  `query`/`path`/`explain` do not surface enough context — it is far larger than a scoped
  subgraph.
- **headroom** is context compression, not code search. Never reach for it to locate code.

Index hygiene:

- Check freshness before trusting a broad answer: `codegraph_status` for coverage, and the
  `built_at_commit` field in `graphify-out/graph.json` against `git rev-parse HEAD`.
- Run `graphify update .` after modifying code. codegraph updates through
  its own file watcher and lags writes by about a second.
- `graphify-out/`, `.serena/`, and the `.codegraph/` database are gitignored and must stay
  that way. Never stage or commit an index; only `.codegraph/.gitignore` and
  `.codegraph/config.json` are tracked.

## Plugin and skill routing

At the start of every task, evaluate all routes below before acting:

- **Ponytail:** For coding, debugging, refactoring, code review, or software design, activate the
  installed Ponytail skill at `full` intensity unless the operator selects another intensity or
  says `stop ponytail`. Trace the real flow first, then prefer existing project code, the standard
  library, native platform behavior, and already-installed dependencies in that order. Make the
  smallest root-cause change that satisfies the approved scope, with one runnable check for
  non-trivial logic. Ponytail does not apply to purely non-coding requests.
- **Context7:** For library, framework, SDK, API-reference, setup, configuration, or third-party
  code-example work, use the installed `context7-mcp` skill before relying on model memory. Resolve
  the official/version-matched library ID once, query one documentation topic at a time, and base
  implementation or advice on the retrieved current documentation. If the Context7 capability is
  unavailable in the active session, state that limitation and use the library's primary
  documentation instead.
- **Karpathy Guidelines (`karpathy-guidelines`):** For coding, debugging, refactoring, or review,
  enforce Karpathy's four anti-pitfall disciplines:
  1. *Think Before Coding:* State assumptions explicitly; don't pick interpretations silently;
     surface tradeoffs and clarify confusion before implementing.
  2. *Simplicity First:* Minimum code that solves the problem; no speculative abstractions or
     unrequested configurability; rewrite if 50 lines suffice for 200.
  3. *Surgical Changes:* Touch only required code; match surrounding style; clean up only self-created
     orphans; leave orthogonal code and comments alone.
  4. *Goal-Driven Execution:* Define verifiable success criteria first (tests/checks); loop until
     verified. See `.agents/skills/karpathy-guidelines/SKILL.md`.

### Matt Pocock engineering skills

The repository includes the Matt Pocock engineering skill suite under `.agents/skills/`.
When unsure which flow fits, invoke the router skill `/ask-matt`.

| Phase / Trigger | Primary Skill | Notes & Invocation |
|---|---|---|
| Idea sharpening, design interview | `grill-with-docs` / `grilling` | State-retaining interview; records domain findings in `CONTEXT.md` and ADRs. |
| UI / state spike | `prototype` | Build a throwaway prototype to answer design/state questions before implementation. |
| Architecture & module design | `codebase-design` | Deep module vocabulary (interfaces, seams, depth, leverage, locality). |
| Domain terminology & ADRs | `domain-modeling` | Pin down domain language; resolve overloaded terms into `CONTEXT.md`. |
| Technical investigation | `research` | Delegate reading legwork against primary sources to a background agent. |
| Requirements & tickets | `to-spec` → `to-tickets` | Transform ideas into specifications and blocker-linked tickets. |
| Hard bug or regression | `diagnosing-bugs` | 6-phase loop; mandates a tight red-capable check before hypothesizing. |
| Test-driven implementation | `tdd` / `implement` | Red-green loop at pre-agreed seams; prevents implementation coupling. |
| Code review & diff inspection | `code-review` | Two-axis review (Standards + Spec) of diffs before committing. |
| Merge / rebase conflict | `resolving-merge-conflicts` | Intent-based resolution traced to each side's primary source. |
| Issue queue management | `triage` | Move raw issues into canonical roles (`docs/agents/triage-labels.md`). |
| Writing agent documentation | `writing-for-agents` | Pruning, single source of truth, and progressive disclosure rules. |

### Codex: operator bridge

Codex is the operator's review and planning assistant. Its default responsibilities are:

1. Inspect executor reports, repository changes, test evidence, and operational checkpoints.
2. Review claims against the approved specification and plan; report gaps, risks, and the next operator decision.
3. Write or revise specifications and implementation plans when requested.
4. Produce a self-contained executor prompt in a fenced text block that the operator can copy directly into Claude.
5. Preserve the boundary between offline implementation, push/publication, deployment, live gates, evidence mutation, and soak approval.

Codex does not implement product code or continue Claude's implementation by default. It may perform read-only inspection and proportionate verification, including non-live tests, while reviewing. Writing task-owned specs, plans, review notes, and executor prompts is within its role when requested.

An ambiguous instruction such as "continue" means continue the review/orchestration flow: inspect the latest checkpoint, determine the next gate, and prepare the next executor prompt. It does not authorize Codex to implement code. Codex may implement only when the operator explicitly overrides this role for the current request by directly assigning implementation to Codex.

### Claude: implementation executor

Claude acts as the executor only when the operator supplies an explicit implementation prompt, normally marked `Mode: IMPLEMENT_PLAN`. In that role Claude:

1. Reads the named specification, plan, repository instructions, and current checkpoint.
2. Implements the approved scope task by task.
3. Runs the required verification and reports actual evidence, commits, limitations, and remaining gates.
4. Stops at the handoff boundary stated in the executor prompt.

The Codex review-only restriction does not prevent Claude from implementing a task explicitly assigned through an executor prompt.

## Copy-paste executor prompt contract

Every executor prompt prepared by Codex must be directly usable without relying on hidden chat context. Include:

- repository and execution mode;
- documents to read in order;
- baseline/current checkpoint and required drift inspection;
- exact authorized deliverables;
- applicable skills or development process;
- verification commands and evidence expectations;
- preservation, security, and operational constraints;
- explicit hard stops;
- required final report format and next operator checkpoint.

Keep chat responses to the operator in Indonesian. Keep repository artifacts, specifications, plans, prompts, code, comments, and commit messages in English, consistent with repository standards.

## Operator authority

The operator retains authority for every state-changing gate outside an explicitly issued executor prompt. Push/publication, deployment or restart, real secret or fixture access, live TikTok/provider requests, evidence or observation mutation, S3 export, rollback drill, soak-window activation, approval records, and cutover require the operator's explicit authorization for that gate.

Never infer a later gate from approval of an earlier one. A completed implementation report returns to Codex for review before the operator sends the next executor prompt.
