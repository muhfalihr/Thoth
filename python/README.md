# Thoth Control Plane

The Python control plane is an isolated `uv` project. It requires Python 3.11 through 3.13.

From this directory, install dependencies and run the checks with:

```bash
uv sync --all-groups
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

Runtime configuration is supplied through the `THOTH_*` environment variables described by
`thoth_control_plane.config.Settings`. The legacy gateway URL and API key must be provided as a
complete pair.
