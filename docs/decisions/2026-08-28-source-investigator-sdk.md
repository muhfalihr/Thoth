# Source Investigator SDK Decision

- Date: 2026-08-30
- Status: accepted
- Selected SDK: `agno`
- No-agent decision: `do_not_defer`; `defer_agent_layer` remains the explicit fallback
  sentinel if a later production integration cannot preserve this boundary.

## Boundary held constant

The application owns a framework-neutral `SourceInvestigator` protocol. Its input contains
only workflow, correlation, and candidate IDs. Its output contains one candidate ID, cited
normalized evidence, and a proposed next-stage approval. A proposal is not an approval
decision.

Both disposable adapters received exactly these three application tools:

1. `inspect_source_candidates`
2. `explain_source_choice`
3. `request_next_stage`

No adapter can download media, render, delete, publish, read secrets, mutate a content set,
or record approval. The spike used deterministic fixture/fake model responses and no provider
credentials or media payloads. Approval was recorded through `WorkflowService`, outside the
agent boundary.

## Fixed acceptance score

| Acceptance case | Agno 3.0.1 | PydanticAI 2.36.0 |
| --- | --- | --- |
| Cited source explanation | pass | pass |
| No side effect before server-side approval | pass | pass |
| Pause/restart/resume without duplicate activity | pass | pass |
| Cancellation of blocking work | pass | pass |
| Typed dashboard events | pass | pass |
| Correlation propagation and sensitive-context exclusion | pass | pass |

Both candidates passed all six cases against the same fixture. Each requires one custom
adapter module and zero new persistent services; both reuse the existing application service.
The implementation-surface score is therefore tied at `1`. The binding selection rule breaks
the tie in favor of Agno.

## Dependency and integration outcome

`agno>=3,<4` is the only selected SDK in production dependencies. The temporary comparison
group and PydanticAI lock entries were removed. The PydanticAI adapter remains a disposable
comparison artifact and runs only when that SDK is temporarily installed.

Neither adapter is imported or registered by the FastAPI application or the Temporal worker.
Any production use must continue through the application protocol so routes, workflow
signatures, approval authorization, and worker registration remain SDK-independent.

## Evidence

- Comparison environment: `15 passed` across the contract and both six-case adapter matrices.
- Selected environment: `9 passed` across the contract and the Agno six-case matrix.
- Final dependency search in `pyproject.toml`: only `"agno>=3,<4"`.

