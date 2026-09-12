import re
import tomllib
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _repo_text(relative_path: str) -> str:
    return (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8")


def _fenced_commands(markdown: str) -> list[str]:
    """Return only the lines inside fenced blocks, so prose cannot trip a command check."""
    commands: list[str] = []
    inside = False
    for line in markdown.splitlines():
        if line.startswith("```"):
            inside = not inside
        elif inside:
            commands.append(line.strip())
    return commands


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


def test_container_workflow_boots_the_stack_it_publishes() -> None:
    """Rendering Compose cannot open a path that lives inside the image.

    `docker compose config` resolved a dynamic-config path that did not exist in the
    pinned Temporal image, so the offline gate passed while the stack crash-looped.
    Publication is therefore also gated on the four non-live services reporting
    healthy against the digest that was just published.
    """
    workflow = _repo_text(".github/workflows/container-image.yml")
    assert "  stack-smoke:" in workflow
    smoke = workflow.split("  stack-smoke:", 1)[1]
    assert "needs: publish-image" in smoke
    assert "up -d --wait postgresql editor-postgresql temporal temporal-ui api" in smoke
    assert "exec -T api id -u" in smoke
    assert "test -w /var/lib/thoth/artifacts" in smoke
    assert "operator namespace describe" in smoke
    assert "stage1-local-preflight" in smoke


def test_container_workflow_smoke_never_starts_the_live_services() -> None:
    """The CDP sidecar opens TikTok and the worker depends on it; CI starts neither."""
    workflow = _repo_text(".github/workflows/container-image.yml")
    smoke = workflow.split("  stack-smoke:", 1)[1]
    assert "up -d --wait legacy-cdp" not in smoke
    assert " worker" not in smoke.replace("--wait postgresql temporal temporal-ui api", "")
    assert "down -v" not in smoke


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


def test_legacy_cdp_launcher_is_fixed_private_contract() -> None:
    """The launcher validates the container, then hands off to the supervisor.

    It used to `exec` Chromium with `--remote-debugging-address=0.0.0.0`, which
    Chromium ignores: DevTools stayed bound to loopback, so the sidecar answered its
    own healthcheck while refusing every sibling container. The browser flags now live
    in `scout/runtime/legacy_cdp.ts`; what stays here is argument validation, single
    Chromium discovery, the writable profile, and the silent `--check`.
    """
    launcher = _repo_text("docker/start-legacy-cdp")
    required = {
        "/ms-playwright/chromium-[0-9]*/chrome-linux*/chrome",
        "chromium_count=$((chromium_count + 1))",
        'if [ "$chromium_count" -ne 1 ]; then',
        'if [ ! -d "$profile_dir" ] || [ ! -w "$profile_dir" ]; then',
        "runtime=/opt/thoth/scout/runtime/legacy_cdp.ts",
        'exec bun "$runtime" \\',
        '--chromium "$chromium_path" --profile "$profile_dir"',
        "--offline-smoke",
    }
    assert all(token in launcher for token in required)
    assert 'case "$#" in' in launcher
    assert launcher.index('case "$#" in') < launcher.index("chromium_path=")
    assert launcher.index("offline_smoke=false") < launcher.index('case "$#" in')
    assert "--check" in launcher
    assert launcher.index('if [ "$check_only" = true ]') < launcher.index("exec bun")
    assert "sync_playwright" not in launcher
    assert "--no-sandbox" not in launcher
    assert "THOTH_LIVE_TIKTOK_URL" not in launcher
    assert "--remote-debugging" not in launcher


def test_legacy_cdp_supervisor_keeps_the_browser_private_and_sandboxed() -> None:
    supervisor = _repo_text("scout/runtime/legacy_cdp.ts")
    relay = _repo_text("scout/runtime/cdp_relay.ts")
    assert "new URL('http://127.0.0.1:18801')" in supervisor
    assert "new URL('http://legacy-cdp:18800')" in supervisor
    assert "'--remote-debugging-address=127.0.0.1'" in supervisor
    assert "'--headless=new'" in supervisor
    assert "'https://www.tiktok.com/'" in supervisor
    assert "'about:blank'" in supervisor
    assert "--no-sandbox" not in supervisor
    assert "--remote-allow-origins" not in supervisor and "--remote-allow-origins" not in relay


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


def test_blueprint_records_published_container_checkpoint() -> None:
    blueprint = _repo_text("BLUEPRINT.md")
    prose = " ".join(blueprint.split())
    assert "Stage 1 container checkpoint (2026-09-04)" in blueprint
    assert "worker/API/CDP sidecar" in blueprint
    assert "Deployment, controlled live smoke, and the operational soak remain pending" in prose
    assert "| Stage 1 container + CI | ⚠️ 95% |" in blueprint
    assert (
        "`Dockerfile`, `docker/start-legacy-cdp`, `.github/workflows/container-image.yml`"
        in blueprint
    )
    assert "controlled fallback smoke" in blueprint


def test_blueprint_does_not_pin_a_release_digest_it_cannot_keep_current() -> None:
    """Every push publishes a new digest, so a digest written here is stale on arrival.

    The image labels bind each digest to its own revision, which means the commit that
    records a digest can never be the commit that digest was built from. The blueprint
    therefore names the source of the release identity instead of a literal digest.
    """
    blueprint = _repo_text("BLUEPRINT.md")
    prose = " ".join(blueprint.split())
    assert not re.search(r"ghcr\.io/muhfalihr/thoth@sha256:[0-9a-f]{64}", blueprint)
    assert "read from the Actions summary of the exact commit being deployed" in prose


def test_parity_runbook_routes_routine_attempt_inspection_through_the_summary() -> None:
    """The sample is evidence, so reading one attempt must not mean opening the rest.

    An attempt record answers "did it finish, and where did it stop". Reaching that
    answer by listing the sample or printing a log puts the fixture URL, post
    identifiers, and raw browser output on a terminal for a question that needs none
    of them, so the runbook names one command and forbids the alternatives.
    """
    runbook = _repo_text("docs/operations/stage1-parity-sampling.md")
    prose = " ".join(runbook.split())
    assert "python -m thoth_control_plane.operations.stage1_parity_attempt_summary" in runbook
    assert "--reference-id" in runbook
    for field in (
        "diagnostics_valid",
        "diagnostic_contract",
        "diagnostic_event_count",
        "terminal_stage",
        "terminal_category",
        "media_candidate_discovery_signal",
    ):
        assert field in runbook
    assert "Routine inspection is that command and nothing else" in prose
    assert "diagnostic_contract=legacy" in runbook
    assert "never migrated or amended" in prose
    # The terminal event is an observation. Promoting it to a cause is the inference
    # the p3/p4 review found, and the runbook is where that boundary is stated.
    assert "says where a reference stopped, never why" in prose
    enumerating = ("ls ", "find ", "tree ", "cat ", "head ", "tail ", "grep ")
    assert [line for line in _fenced_commands(runbook) if line.startswith(enumerating)] == []


def test_blueprint_records_the_safe_parity_diagnostic_contract() -> None:
    blueprint = _repo_text("BLUEPRINT.md")
    prose = " ".join(blueprint.split())
    assert "stage1_parity_attempt_summary" in blueprint
    assert "safe_runtime_diagnostic" in blueprint
    assert "diagnostic_contract" in blueprint
    assert "p1-p4 are never migrated or amended" in prose
    assert "p5 remains a separate operator authorization" in prose


def test_scout_runtime_downloader_versions_are_exact() -> None:
    """Scout shells out to both downloaders; neither was installed in the image.

    Images are acquired with gallery-dl and the existing video/probe callers shell
    out to yt-dlp, so a compatibility image that omits either one cannot run the
    legacy fallback it exists to host. Both are pinned exactly so a rebuilt image
    keeps the runtime the recorded evidence was produced against.
    """
    project = tomllib.loads(_repo_text("python/pyproject.toml"))
    assert project["project"]["optional-dependencies"]["scout-runtime"] == [
        "gallery-dl==1.32.11",
        "yt-dlp==2026.8.19",
    ]


def test_uv_lock_resolves_the_pinned_downloaders() -> None:
    lock = tomllib.loads(_repo_text("python/uv.lock"))
    locked = {package["name"]: package["version"] for package in lock["package"]}
    assert locked["gallery-dl"] == "1.32.11"
    assert locked["yt-dlp"] == "2026.8.19"


def test_dockerfile_syncs_the_scout_runtime_extra_in_every_locked_install() -> None:
    dockerfile = _repo_text("Dockerfile")
    sync_commands = [line.strip() for line in dockerfile.splitlines() if "uv sync --frozen" in line]
    assert len(sync_commands) == 2
    assert all("--extra acquisition" in command for command in sync_commands)
    assert all("--extra scout-runtime" in command for command in sync_commands)


def test_dockerfile_probes_downloader_executables_as_the_runtime_user() -> None:
    """A source-level pin proves nothing about the layer the worker actually runs.

    The probes live after `USER thoth` so the build fails when the executables are
    missing, unreadable by the runtime user, or a different version than the lock.
    """
    dockerfile = _repo_text("Dockerfile")
    runtime_stage = dockerfile.split("USER thoth", 1)[1]
    assert "GALLERY_DL=/opt/thoth/python/.venv/bin/gallery-dl" in dockerfile
    assert "YTDLP=/opt/thoth/python/.venv/bin/yt-dlp" in dockerfile
    assert 'test -x "$GALLERY_DL"' in runtime_stage
    assert 'test -x "$YTDLP"' in runtime_stage
    assert 'test "$("$GALLERY_DL" --version)" = "1.32.11"' in runtime_stage
    assert 'test "$("$YTDLP" --version)" = "2026.08.19"' in runtime_stage


def test_pull_request_builds_load_the_image_and_prove_cdp_transport() -> None:
    """A PR must fail on a broken relay, which requires the image locally.

    `push: false` alone leaves the build in the buildx cache with nothing to run, so
    the loopback-only regression this harness exists to catch would pass review.
    """
    workflow = _repo_text(".github/workflows/container-image.yml")
    validate = workflow[workflow.index("  validate-image:") : workflow.index("  publish-image:")]

    assert "push: false" in validate
    assert "load: true" in validate
    assert "tags: ${{ env.CANDIDATE_IMAGE }}" in validate
    assert 'bash docker/test-cdp-offline.sh "${CANDIDATE_IMAGE}"' in validate
    assert "compose.stage1.local.yml" not in validate


def test_published_digest_is_proved_by_the_same_harness() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    smoke = workflow[workflow.index("  stack-smoke:") :]

    assert (
        "THOTH_IMAGE_REF: ghcr.io/muhfalihr/thoth@${{ needs.publish-image.outputs.digest }}"
        in smoke
    )
    assert 'bash docker/test-cdp-offline.sh "${THOTH_IMAGE_REF}"' in smoke
    assert "up -d --wait postgresql editor-postgresql temporal temporal-ui api" in smoke
    assert "curl -fsS http://127.0.0.1:8000/readyz" in smoke


def test_quality_gates_run_the_scout_runtime_tests() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    package = _repo_text("scout/package.json")

    assert "bun --cwd=scout run test:runtime" in workflow
    assert "bun --cwd=scout run test:acquisition" in workflow
    assert '"test:runtime": "bun test runtime/"' in package


def test_cdp_harness_owns_everything_it_creates() -> None:
    """The harness runs beside a real deployment, so its blast radius is the contract."""
    harness = _repo_text("docker/test-cdp-offline.sh")
    smoke_compose = _repo_text("compose.stage1.cdp-smoke.yml")

    assert "set -euo pipefail" in harness
    assert "trap teardown EXIT" in harness
    assert "project_prefix=stage1-cdp-smoke" in harness
    assert '"${project_prefix}"-*)' in harness
    assert "--wait-timeout" in harness
    assert "compose.stage1.local.yml" not in harness
    assert 'docker compose -p "$test_project" -f "$compose_file"' in harness
    assert "compose logs" not in harness and "docker logs" not in harness

    assert "${THOTH_TEST_IMAGE:?set candidate image}" in smoke_compose
    assert "internal: true" in smoke_compose
    assert "ports:" not in smoke_compose
    assert "- /var/lib/thoth/browser-profile:uid=10001,gid=10001,mode=0700" in smoke_compose
    assert "/opt/thoth/bin/start-legacy-cdp" in smoke_compose
    assert "--offline-smoke" in smoke_compose
    assert "THOTH_CDP: http://legacy-cdp:18800" in smoke_compose
    assert "NOVITA" not in smoke_compose
    assert smoke_compose.count("seccomp:unconfined") == 1


def test_cdp_harness_proves_legacy_fallback_target_isolation() -> None:
    """The image smoke must exercise the production fallback supervisor itself.

    Transport reachability alone cannot prove that a fallback avoids the sidecar's
    health page or releases its temporary page on both child outcomes.  The harness
    emits only fixed booleans so target identifiers and URLs never reach CI logs.
    """
    harness = _repo_text("docker/test-cdp-offline.sh")
    runtime_harness = _repo_text("scout/runtime/legacy_fallback_harness.ts")

    assert "bun scout/runtime/legacy_fallback_harness.ts" in harness
    for field in (
        "initial_target_preserved",
        "temporary_target_observed",
        "success_target_removed",
        "failure_target_removed",
    ):
        assert f'"{field}":true' in harness
        assert field in runtime_harness
    assert "THOTH_LEGACY_FALLBACK_SMOKE_HOLD_MS" in runtime_harness
    assert "console.log" not in runtime_harness.split("async function main", 1)[0]


def test_both_image_jobs_prove_the_reference_owns_its_browser() -> None:
    """Isolation is a property of the image, so both gates must exercise it.

    The PR gate catches a regression before it is published; the digest gate
    catches one in the artifact that operators actually run.
    """
    workflow = _repo_text(".github/workflows/container-image.yml")
    validate = workflow[workflow.index("  validate-image:") : workflow.index("  publish-image:")]
    smoke = workflow[workflow.index("  stack-smoke:") :]

    assert 'bash docker/test-parity-offline.sh "${CANDIDATE_IMAGE}"' in validate
    assert 'bash docker/test-parity-offline.sh "${THOTH_IMAGE_REF}"' in smoke
    # The parity harness is additional evidence, never a replacement.
    assert 'bash docker/test-cdp-offline.sh "${CANDIDATE_IMAGE}"' in validate
    assert 'bash docker/test-cdp-offline.sh "${THOTH_IMAGE_REF}"' in smoke


def test_parity_harness_owns_everything_it_creates() -> None:
    """The harness runs beside a real deployment, so its blast radius is the contract."""
    harness = _repo_text("docker/test-parity-offline.sh")

    assert "set -euo pipefail" in harness
    assert "trap teardown EXIT INT TERM" in harness
    assert "project_prefix=stage1-parity-smoke" in harness
    assert '"${project_prefix}"-*)' in harness
    assert 'docker compose -p "$test_project" -f "$compose_file"' in harness
    # A forced browser death must be signalled at Chromium's parent only; a
    # renderer dying is not the failure this proves.
    assert "--type=" in harness
    # Neither the deployment nor the operator file may be driven from a test.
    assert "compose.stage1.local.yml" not in harness
    assert "compose.stage1.parity.yml" not in harness
    assert "docker system prune" not in harness
    assert "compose logs" not in harness and "docker logs" not in harness


def test_parity_smoke_network_is_internal_and_carries_a_synthetic_sentinel() -> None:
    """The sentinel stands in for a production relay and must stay untouched."""
    smoke_compose = _repo_text("compose.stage1.parity-smoke.yml")

    assert "${THOTH_TEST_IMAGE:?set candidate image}" in smoke_compose
    assert "internal: true" in smoke_compose
    assert "ports:" not in smoke_compose
    assert "- /var/lib/thoth/parity-profile:uid=10001,gid=10001,mode=0700" in smoke_compose
    assert "/opt/thoth/bin/start-parity-reference" in smoke_compose
    assert "--offline-smoke" in smoke_compose
    # The reference drives only the browser it started, never the alias a
    # deployment sidecar answers on.
    assert "THOTH_CDP: http://127.0.0.1:18801" in smoke_compose
    assert "- legacy-cdp" in smoke_compose
    assert "NOVITA" not in smoke_compose
    # Only the browser-bearing container may relax seccomp.
    assert smoke_compose.count("seccomp:unconfined") == 1


def test_the_parity_harness_accepts_only_the_supervisor_own_verdicts() -> None:
    """A nonzero container exit is not evidence that the supervisor decided anything.

    Docker's own forced kill after a stop timeout is nonzero too, so a harness that
    accepts any failure would pass a reference whose signal handling and child
    reaping are both broken. The supervisor emits 143 only when it was cancelled,
    reaped both children, and recorded the attempt, and 70 when its browser died,
    so the smoke asserts those codes rather than their absence from zero.
    """
    harness = _repo_text("docker/test-parity-offline.sh")

    assert "docker wait" in harness
    # Every wait is bounded: an unbounded one turns a hung reference into a hung job.
    for wait in re.findall(r"^.*docker wait.*$", harness, re.MULTILINE):
        assert "timeout" in wait, "an unbounded docker wait can hang the whole job"
    assert "-eq 143" in harness
    assert "-eq 70" in harness
    # The declared budgets must be used, not merely declared.
    assert harness.count("$exit_timeout") >= 2
    # The cancellation phase must reach a probe that is still running. Without the
    # hold, a probe that finished first would exit 0 and the phase would fail for a
    # reason that has nothing to do with signal handling.
    assert "THOTH_PARITY_SMOKE_HOLD_MS" in harness


def test_the_diagnostic_contract_documents_describe_all_five_frame_keys() -> None:
    """A frame carries five keys. A four-key description legitimizes dropping one of them,
    and `schema_version` is the one a shortened count keeps losing."""
    documents = (
        "docs/superpowers/specs/2026-09-08-stage1-parity-diagnostic-preservation-design.md",
        "docs/superpowers/plans/2026-09-08-stage1-parity-diagnostic-preservation.md",
        "docs/agent-prompts/stage1-parity-diagnostic-preservation-executor.md",
    )
    for relative in documents:
        prose = " ".join(_repo_text(relative).split())
        assert "five keys" in prose, f"{relative} does not state the five-key count"
        for key in ("schema_version", "kind", "stage", "category", "code"):
            assert f"`{key}`" in prose, f"{relative} does not name `{key}`"
        for wrong in ("four-key", "four defined keys", "four keys"):
            assert wrong not in prose, f"{relative} still describes a {wrong} contract"


def test_the_parity_reference_stops_at_the_source_boundary_within_one_budget() -> None:
    """p5 died between two numbers that were never written down together.

    The supervisor bounded the whole general Scout run at 15 minutes while the
    source stage it was really waiting on owned 30, so a source resolution that
    used its budget was killed from the outside and recorded as incomparable.
    The image contract therefore pins both halves of the correction: the shipped
    reference command is bounded to source discovery, and the outer deadline is
    derived from the retained stage rather than written as its own literal.
    """
    supervisor = _repo_text("scout/runtime/parity_reference.ts")
    pipeline = _repo_text("scout/pipeline/run_pipeline.ts")
    contract = _repo_text("scout/lib/parity_reference_contract.ts")

    assert "'--source-reference-only'" in supervisor
    assert "'--source-reference-only'" in pipeline
    assert "SOURCE_REFERENCE_TRACE_TIMEOUT_MS = 30 * 60_000" in contract
    assert "SOURCE_REFERENCE_OVERHEAD_RESERVE_MS = 5 * 60_000" in contract
    # Derived, not restated: a second literal is exactly how the two drifted apart.
    assert "35 * 60_000" not in contract
    assert (
        "SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS ="
        " SOURCE_REFERENCE_TRACE_TIMEOUT_MS + SOURCE_REFERENCE_OVERHEAD_RESERVE_MS;"
    ) in " ".join(contract.split())
    assert "SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS" in supervisor
    assert "SOURCE_REFERENCE_TRACE_TIMEOUT_MS" in pipeline
    # The deadline p5 hit must no longer be reachable as a production default.
    assert "15 * 60_000" not in supervisor


def test_the_parity_runbook_states_the_completion_boundary_and_its_budgets() -> None:
    """An operator reading the runbook must not expect the stages the reference no longer runs.

    Exit zero is the cheapest thing to mistake for parity, so the runbook has to keep
    saying that artifact validation and the field comparison are what decide it.

    The 35 minutes bound the supervised acquisition phase and nothing after it. An
    operator who reads that number as a cap on the whole supervisor would expect a
    reference to abandon teardown and attempt finalization once it expires, which is
    the opposite of what the lifecycle does and would make a missing attempt record
    look normal.
    """
    prose = " ".join(_repo_text("docs/operations/stage1-parity-sampling.md").split())

    assert "--source-reference-only" in prose
    assert "30 minutes" in prose and "35 minutes" in prose
    for outside in ("collect_comments", "topic_dossier", "build_footage"):
        assert outside in prose, f"the runbook does not place {outside} outside the reference"
    assert "necessary but not sufficient" in prose
    assert "supervised acquisition deadline" in prose
    assert "cleanup and attempt finalization continue after that outcome" in prose
