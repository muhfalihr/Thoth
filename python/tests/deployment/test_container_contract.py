from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _repo_text(relative_path: str) -> str:
    return (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8")


def test_dockerignore_excludes_sensitive_and_generated_inputs() -> None:
    patterns = {
        line.strip()
        for line in _repo_text(".dockerignore").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    required_patterns = {
        ".git",
        ".worktrees",
        ".agents",
        ".claude",
        ".codex",
        ".superpowers",
        "**/.env*",
        "**/node_modules",
        "python/.venv",
        "**/__pycache__",
        "**/.pytest_cache",
        "**/.ruff_cache",
        "**/target",
        "output",
        "scout/output",
        ".thoth-artifacts",
        "*.db*",
        "*.log",
        "*.mp4",
        "*.wav",
        "*.jpg",
        "tiktok-stage1-soak-observations*.jsonl",
        "tiktok-stage1-soak-report.json*",
    }
    assert required_patterns <= patterns
    assert not any(pattern.startswith("!") for pattern in patterns)


def test_dockerfile_uses_locked_full_compatibility_runtime() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert "FROM ghcr.io/astral-sh/uv:0.10.8 AS uv-tools" in dockerfile
    assert "FROM oven/bun:1.3.14 AS bun-tools" in dockerfile
    assert "FROM python:3.12-slim-bookworm AS runtime" in dockerfile
    assert "uv sync --frozen --no-dev --extra acquisition" in dockerfile
    assert "bun --cwd=/opt/thoth/scout install --frozen-lockfile --production" in dockerfile
    assert "/opt/thoth/python/.venv/bin/scrapling install" in dockerfile
    assert "COPY . " not in dockerfile


def test_dockerfile_preserves_legacy_adapter_layout_and_non_root_runtime() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert "COPY --chown=thoth:thoth scout/ /opt/thoth/scout/" in dockerfile
    assert "test -f /opt/thoth/scout/cli.ts" in dockerfile
    assert "THOTH_CONTROL_PLANE_ARTIFACT_ROOT=/var/lib/thoth/artifacts" in dockerfile
    assert "USER thoth" in dockerfile
    assert "RUN test -w /var/lib/thoth/artifacts" in dockerfile


def test_dockerfile_default_command_is_worker_and_has_no_secret_arguments() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert (
        'CMD ["/opt/thoth/python/.venv/bin/python", "-m", '
        '"thoth_control_plane.worker"]' in dockerfile
    )
    assert "THOTH_LIVE_TIKTOK_URL" not in dockerfile
    assert "THOTH_CONTROL_PLANE_API_KEY=" not in dockerfile
    assert "ARG THOTH_" not in dockerfile


def test_container_workflow_separates_pr_validation_from_publication() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    validation = workflow.split("  validate-image:", 1)[1].split("  publish-image:", 1)[0]
    publication = workflow.split("  publish-image:", 1)[1]
    assert "if: github.event_name == 'pull_request'" in validation
    assert "push: false" in validation
    assert "packages: write" not in validation
    assert "if: github.event_name == 'push'" in publication
    assert "packages: write" in publication
    assert "push: true" in publication
    assert workflow.count("packages: write") == 1


def test_container_workflow_pins_gates_tags_platform_and_digest_summary() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    assert "REGISTRY_IMAGE: ghcr.io/muhfalihr/thoth" in workflow
    assert 'uv run --project python pytest -m "not live" -q' in workflow
    assert "bun --cwd=scout run test:acquisition" in workflow
    assert "bun --cwd scout" not in workflow
    assert "platforms: linux/amd64" in workflow
    assert "type=raw,value=sha-${{ github.sha }}" in workflow
    assert "type=ref,event=branch" in workflow
    assert "type=ref,event=tag" in workflow
    assert "refs/heads/master" in workflow
    assert "provenance: mode=max" in workflow
    assert "sbom: true" in workflow
    assert "steps.build.outputs.digest" in workflow
    assert "secrets." not in workflow


def test_operations_documentation_requires_digest_pinning_and_runtime_injection() -> None:
    documentation = _repo_text("docs/python-control-plane.md")
    digest_prompt = 'Read-Host "Paste the sha256 digest from the successful workflow summary"'
    assert "### Stage 1 compatibility container" in documentation
    assert "ghcr.io/muhfalihr/thoth@" in documentation
    assert digest_prompt in documentation
    assert "/var/lib/thoth/artifacts" in documentation
    assert "thoth_control_plane.api.app:create_app" in documentation
    assert "Publishing the image does not deploy it to AWS" in documentation


def test_dockerfile_pins_base_interpreter_and_editable_layout() -> None:
    """The spec's runtime line and editable layout must be enforced by the build itself.

    `uv` prefers its own managed interpreters by default, so an unpinned `uv sync`
    can resolve a downloaded CPython under `/root` instead of the base image's
    3.12. That would both violate the `python:3.12-slim-bookworm` runtime line and
    leave `.venv/bin/python` unreadable after dropping to `thoth`. A non-editable
    install fails the same way silently: `LegacyScoutActivity` resolves its
    repository root from `thoth_control_plane.__file__`, so the Scout fallback
    would break at runtime while the build stayed green.
    """
    dockerfile = _repo_text("Dockerfile")
    assert "UV_PYTHON=/usr/local/bin/python3.12" in dockerfile
    assert "UV_PYTHON_DOWNLOADS=never" in dockerfile
    assert "assert sys.version_info[:2] == (3, 12), sys.version" in dockerfile
    assert "assert m.__file__.startswith('/opt/thoth/python/src/'), m.__file__" in dockerfile
