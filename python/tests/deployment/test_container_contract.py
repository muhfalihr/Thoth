import re
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
        "data/cookies.txt",
        "**/*.key",
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
        "**/*.png",
        "**/*.part",
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


def test_quality_workflow_provisions_linux_ffmpeg_for_scout() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    assert "Install media test dependencies" in workflow
    assert "sudo apt-get update" in workflow
    assert "sudo apt-get install --yes --no-install-recommends ffmpeg" in workflow
    assert "THOTH_FFMPEG: /usr/bin/ffmpeg" in workflow
    assert "THOTH_FFPROBE: /usr/bin/ffprobe" in workflow
    assert 'test -x "$THOTH_FFMPEG"' in workflow
    assert 'test -x "$THOTH_FFPROBE"' in workflow


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


def test_dockerfile_provides_linux_legacy_media_and_cdp_runtime() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert "ca-certificates ffmpeg tini" in dockerfile
    assert "THOTH_FFMPEG=/usr/bin/ffmpeg" in dockerfile
    assert "THOTH_FFPROBE=/usr/bin/ffprobe" in dockerfile
    assert "/var/lib/thoth/browser-profile" in dockerfile
    assert "COPY --chmod=0755 --chown=thoth:thoth docker/start-legacy-cdp" in dockerfile
    assert "/opt/thoth/bin/start-legacy-cdp --check" in dockerfile
    assert 'cdp_check_log="$(mktemp)"' in dockerfile
    assert '/opt/thoth/bin/start-legacy-cdp --check >"$cdp_check_log" 2>&1' in dockerfile
    assert 'test ! -s "$cdp_check_log"' in dockerfile
    assert 'cat "$cdp_check_log" >&2' in dockerfile
    assert "cdp_check_output=$(" not in dockerfile
    assert "/usr/bin/ffmpeg -version" in dockerfile
    assert "/usr/bin/ffprobe -version" in dockerfile
    assert "EXPOSE 8000 18800" in dockerfile


def test_legacy_cdp_launcher_is_fixed_headless_private_contract() -> None:
    launcher = _repo_text("docker/start-legacy-cdp")
    required = {
        "/ms-playwright/chromium-[0-9]*/chrome-linux*/chrome",
        "chromium_count=$((chromium_count + 1))",
        'if [ "$chromium_count" -ne 1 ]; then',
        "--headless=new",
        "--remote-debugging-address=0.0.0.0",
        "--remote-debugging-port=18800",
        '--user-data-dir="$profile_dir"',
        "https://www.tiktok.com/",
    }
    assert all(token in launcher for token in required)
    assert 'case "$#" in' in launcher
    assert launcher.index('case "$#" in') < launcher.index("chromium_path=")
    assert "--check" in launcher
    assert "sync_playwright" not in launcher
    assert "--no-sandbox" not in launcher
    assert "THOTH_LIVE_TIKTOK_URL" not in launcher


def test_container_workflow_pins_every_action_to_full_commit_sha() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    expected = {
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262": "# v4",
        "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065": "# v5",
        "astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e": "# v6",
        "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6": "# v2",
        "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f": "# v3",
        "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9": "# v3",
        "docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051": "# v5",
        "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8": "# v6",
    }
    action_lines = [line for line in workflow.splitlines() if "uses:" in line]
    references = {
        line.split("uses:", 1)[1].split("#", 1)[0].strip()
        for line in action_lines
        if not line.split("uses:", 1)[1].strip().startswith("./")
    }
    assert references == set(expected)
    assert all(re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", reference) for reference in references)
    for line in action_lines:
        reference = line.split("uses:", 1)[1].split("#", 1)[0].strip()
        if reference in expected:
            assert line.rstrip().endswith(expected[reference])


def test_operations_docs_define_private_same_digest_cdp_sidecar() -> None:
    documentation = _repo_text("docs/python-control-plane.md")
    required = {
        "/opt/thoth/bin/start-legacy-cdp",
        "THOTH_CDP=http://legacy-cdp:18800",
        "THOTH_FFMPEG=/usr/bin/ffmpeg",
        "THOTH_FFPROBE=/usr/bin/ffprobe",
        "/var/lib/thoth/browser-profile",
        "10001:10001",
        "GET http://legacy-cdp:18800/json/version",
        "GET http://legacy-cdp:18800/json",
        "must not have public ingress or a host-port mapping",
    }
    assert all(token in documentation for token in required)


def test_blueprint_records_corrected_container_checkpoint() -> None:
    blueprint = _repo_text("BLUEPRINT.md")
    assert "Stage 1 container checkpoint (2026-09-03)" in blueprint
    assert "worker/API/CDP sidecar" in blueprint
    assert "GHCR publication and the operational soak remain pending" in blueprint
    assert "| Stage 1 container + CI | ⚠️ 90% |" in blueprint
    assert (
        "`Dockerfile`, `docker/start-legacy-cdp`, `.github/workflows/container-image.yml`"
        in blueprint
    )
    assert "controlled fallback smoke" in blueprint
