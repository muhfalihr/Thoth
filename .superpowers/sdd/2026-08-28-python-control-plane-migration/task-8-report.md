# Task 8 Report: bounded source-investigator SDK comparison

## Scope

Implemented a framework-neutral, read-only source-investigator protocol plus isolated Agno
and PydanticAI spike adapters. Both adapters use deterministic fake model responses, expose
exactly three tools, and remain absent from FastAPI and Temporal worker registration.

The pre-existing untracked `docs/research/` content was preserved and not staged. This task
did not edit `progress.md`.

## RED evidence

The acceptance tests were created before production/spike implementation. The first required
command was run from `python/`:

```text
rtk uv run pytest tests/application/test_source_investigator_contract.py tests/spikes/test_agent_sdk_acceptance.py -q

ERROR tests/application/test_source_investigator_contract.py
ERROR tests/spikes/test_agent_sdk_acceptance.py
ModuleNotFoundError: No module named 'thoth_control_plane.application.source_investigator'
```

This was the expected RED: the framework-neutral contract and both adapters did not exist.

After selecting Agno and removing PydanticAI from the environment, the unchanged comparison
import also produced the expected dependency-cleanup RED:

```text
ModuleNotFoundError: No module named 'pydantic_ai'
```

The acceptance matrix now discovers the unselected adapter only when its temporary SDK is
installed; the selected-runtime command continues to exercise the full Agno matrix.

## Systematic debugging evidence

Pytest initially loaded `tests/spikes` as the top-level `spikes` namespace, shadowing the
repository's adapter directory. Direct `importlib.util.find_spec` showed that plain Python
from `python/` found `python/spikes/agno_source_investigator.py`, while pytest collection
failed from `tests/spikes/test_agent_sdk_acceptance.py`.

Root cause: `python/tests` was not a package, so pytest imported the test module under the
top-level `spikes` namespace. One minimal layout correction added `python/tests/__init__.py`.
The immediate collection check then reported all 12 adapter acceptance cases collected.

The next behavioral run exposed one shared adapter bug: the fixture tool response carried a
correlation ID in addition to proposal fields, while strict `ProposedApproval` correctly
rejected the extra field. Each adapter was minimally changed to project only `kind` and
`evidence_ids` into the strict application model. The focused citation case then passed for
both SDKs.

## GREEN comparison evidence

With the temporary dependency group containing Agno 3.0.1 and PydanticAI 2.36.0:

```text
rtk uv run pytest tests/application/test_source_investigator_contract.py tests/spikes/test_agent_sdk_acceptance.py -q
...............                                                          [100%]
15 passed in 1.35s
```

The fixed six-case score was:

| Case | Agno | PydanticAI |
| --- | --- | --- |
| cited explanation | pass | pass |
| no side effect before approval | pass | pass |
| approval pause/restart/resume, no duplicate activity | pass | pass |
| cancellation | pass | pass |
| typed dashboard events | pass | pass |
| correlation/redaction | pass | pass |

The restart case creates the proposed approval from the investigator result, instantiates a
new worker adapter, and records exactly one authorized decision through `WorkflowService`.
The cancellation case cancels a task blocked inside the read-only inspection tool. The input
model forbids credentials/media as extra data and all three tool calls receive the same
correlation ID.

## Decision

- Agno custom adapter modules: 1
- Agno new persistent services: 0
- PydanticAI custom adapter modules: 1
- PydanticAI new persistent services: 0

Both SDKs passed all six cases and tied on implementation surface. The binding rule therefore
selects `agno`. The explicit no-agent outcome `defer_agent_layer` was considered and not
selected because at least one SDK passed all six. It remains the fallback if the boundary
cannot be preserved during a later production integration.

Only `agno>=3,<4` moved into `project.dependencies`; the temporary spike group and all
PydanticAI lock entries were removed. Neither SDK was added to FastAPI or Temporal worker
wiring.

## Selected-runtime GREEN evidence

```text
rtk uv run pytest tests/application/test_source_investigator_contract.py tests/spikes/test_agent_sdk_acceptance.py -q
.........                                                                [100%]
9 passed in 0.36s

rtk rg -n "agno|pydantic-ai|pydantic_ai" pyproject.toml
6:    "agno>=3,<4",
```

Final Ruff, dependency-wiring search, and repository test evidence are appended after the
last verification run.

## Final verification

Fresh verification from the selected dependency state produced:

```text
rtk uv run pytest tests/application/test_source_investigator_contract.py tests/spikes/test_agent_sdk_acceptance.py -q
.........                                                                [100%]
9 passed in 0.36s

rtk uv run ruff check src tests spikes
All checks passed!

rtk uv run ruff format --check src tests spikes
41 files already formatted

rtk rg -n "agno|pydantic-ai|pydantic_ai" pyproject.toml
6:    "agno>=3,<4",

rtk uv run pytest -q
103 passed in 5.15s
```

Two production-wiring searches for SDK imports and spike adapter names under
`src/thoth_control_plane`, including API, workflows, and infrastructure, returned no matches.
