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

## Fix round 1 evidence

The review's two Important evidence gaps are closed without production wiring.

The native-tool boundary received an additional TDD mutation guard. Before the adapters
reported the callable names actually registered with their SDK, the focused selected-runtime
test failed for the expected missing behavior:

```text
rtk uv run pytest tests/spikes/test_agent_sdk_acceptance.py -q -k cited_explanation
FAILED test_cited_explanation_uses_only_three_read_only_tools[agno]
AttributeError: 'AgnoSourceInvestigator' object has no attribute 'sdk_registered_tools'
```

Both adapters now create one tuple of exactly three read-only callables, derive the recorded
SDK registry from that tuple, and give that same tuple to the native SDK agent. Agno's offline
fake model requests those registered names as native tool calls; PydanticAI's offline
`TestModel(call_tools="all")` requests every registered tool. The acceptance test independently
proves that the registered names, model-invoked wrappers, and fixture-service call counts are
exactly the three allowed tools, once each. The focused selected and comparison checks passed:

```text
rtk uv run pytest tests/spikes/test_agent_sdk_acceptance.py -q -k cited_explanation
1 passed, 5 deselected in 0.31s

rtk uv run --with pydantic-ai==2.36.0 pytest tests/spikes/test_agent_sdk_acceptance.py -q -k cited_explanation
2 passed, 10 deselected in 1.77s
```

The restart case now uses a replacement-worker fixture that owns both the fresh adapter and
the durable `WorkflowService`. It records the one authorized approval in that restarted
execution context, then asks the fresh adapter to recover the durable explanation. Assertions
prove two checkpoint loads (initial miss and restarted recovery), one checkpoint save, one
approval record, and exactly one call to each source-inspection tool across both worker
instances. Focused selected and comparison checks passed:

```text
rtk uv run pytest tests/spikes/test_agent_sdk_acceptance.py -q -k pause_restart_resume
1 passed, 5 deselected in 0.32s

rtk uv run --with pydantic-ai==2.36.0 pytest tests/spikes/test_agent_sdk_acceptance.py -q -k pause_restart_resume
2 passed, 10 deselected in 1.57s
```

The corrected comparison matrix still passes all six cases for both SDKs:

```text
rtk uv run --with pydantic-ai==2.36.0 pytest tests/application/test_source_investigator_contract.py tests/spikes/test_agent_sdk_acceptance.py -q
15 passed in 1.87s
```

Therefore the fixed selection rule produces the same result: Agno and PydanticAI tie at one
custom adapter module and zero new persistent services, so the binding tie-break selects Agno.
`pyproject.toml` and `uv.lock` remain faithfully selected-runtime-only: Agno is present and
PydanticAI is absent.

Final fix-round verification from that selected dependency state:

```text
rtk uv lock --check
Resolved 51 packages in 4ms

rtk uv run pytest tests/application/test_source_investigator_contract.py tests/spikes/test_agent_sdk_acceptance.py -q
9 passed in 0.35s

rtk uv run pytest -q
103 passed in 6.42s

rtk uv run ruff check src tests spikes
All checks passed!

rtk uv run ruff format --check src tests spikes
41 files already formatted

rtk rg -n "agno|pydantic-ai|pydantic_ai" pyproject.toml
6:    "agno>=3,<4",
```

The production-wiring search under `src/thoth_control_plane` again returned no SDK imports,
spike imports, or adapter registrations. `rtk git diff --check` also passed. The pre-existing
untracked `docs/research/` content was preserved.
