# Thoth Control Plane

This is the isolated Python 3.11–3.13 `uv` project that owns the versioned workflow API,
Temporal orchestration, Python activities, and thin operator CLI.

```powershell
uv sync --all-groups
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

For a local stack, start Temporal development server, FastAPI, this package's Temporal worker,
and the React dashboard in separate terminals. The canonical process commands, ports, safe
environment-variable handling, endpoints, stop order, and migration/retirement gates are in
[the operator guide](../docs/python-control-plane.md).

Run the deterministic offline vertical smoke with:

```powershell
uv run pytest tests/integration/test_control_plane_smoke.py -q
```

The smoke uses Temporal's offline time-skipping server. It verifies submit, summary/SSE,
authorization, approval across API/worker restart, completion, cancellation, retry eligibility
with the current controlled `503` retry response, artifact download authorization, and that the
HTTP client never uses a Scout CLI route. It is not evidence of a controlled live provider run.

Runtime configuration comes from `thoth_control_plane.config.Settings`. Required secrets must be
injected without printing them. The legacy gateway URL/key pair must be complete, and the
legacy-activity implementation choice is worker-owned rather than request-controlled.
