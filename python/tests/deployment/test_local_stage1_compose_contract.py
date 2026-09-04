import re
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _repo_text(relative_path: str) -> str:
    return (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8")


def _service_block(compose: str, service: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(service)}:\n(?P<body>.*?)(?=^  [a-z][a-z0-9-]*:\n|^networks:|\Z)",
        compose,
    )
    assert match is not None, f"missing Compose service: {service}"
    return match.group("body")


def test_local_stage1_secret_and_evidence_inputs_are_git_safe() -> None:
    gitignore = _repo_text(".gitignore")
    env_example = _repo_text(".env.stage1.local.example")

    assert ".env.stage1.local" in gitignore
    assert "stage1-local-observations*.jsonl" in gitignore
    assert "stage1-local-reports/" in gitignore
    assert "THOTH_IMAGE=ghcr.io/muhfalihr/thoth@sha256:" + "0" * 64 in env_example
    assert "THOTH_STAGE1_DATA_ROOT=/absolute/path/outside/repository/thoth-stage1" in env_example
    assert "THOTH_CONTROL_PLANE_API_KEY=replace-with-local-secret" in env_example
    assert "THOTH_POSTGRES_PASSWORD=replace-with-local-secret" in env_example
    assert "THOTH_STAGE1_ACTIVITY_MODE=python_tiktok_with_legacy_fallback" in env_example
    assert "THOTH_LIVE_TIKTOK_URL=replace-with-approved-public-fixture" in env_example
    assert "https://www.tiktok.com/" not in env_example
    assert "4630917242bd9e3483c8f89ae4017438cadc23a1f699f5e516c2dc610beb18b1" not in env_example


def test_local_stage1_infrastructure_is_pinned_persistent_and_private() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    postgres = _service_block(compose, "postgresql")
    temporal = _service_block(compose, "temporal")
    temporal_ui = _service_block(compose, "temporal-ui")

    assert (
        "postgres:16.4-bookworm@sha256:"
        "e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412" in postgres
    )
    assert (
        "temporalio/auto-setup:1.29.1@sha256:"
        "5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312" in temporal
    )
    assert (
        "temporalio/ui:2.34.0@sha256:"
        "cb17ea423d76a8a19a269d0bcd81fc12eee1f6365acd2a56b590dafb35696a95" in temporal_ui
    )
    assert "${THOTH_STAGE1_DATA_ROOT:?" in postgres
    assert "/postgres" in postgres
    assert "pg_isready" in postgres
    assert "DB: postgres12" in temporal
    assert "DEFAULT_NAMESPACE: thoth-stage1" in temporal
    assert "DEFAULT_NAMESPACE_RETENTION: 30d" in temporal
    assert "temporal operator cluster health --address temporal:7233" in temporal
    assert '"127.0.0.1:8080:8080"' in temporal_ui
    assert "ports:" not in postgres
    assert "ports:" not in temporal


def test_local_stage1_thoth_roles_share_one_digest_and_keep_cdp_private() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    api = _service_block(compose, "api")
    worker = _service_block(compose, "worker")
    cdp = _service_block(compose, "legacy-cdp")

    required_image = "${THOTH_IMAGE:?set digest-qualified THOTH_IMAGE}"
    assert api.count(required_image) == 1
    assert worker.count(required_image) == 1
    assert cdp.count(required_image) == 1
    assert 'user: "10001:10001"' in api
    assert 'user: "10001:10001"' in worker
    assert 'user: "10001:10001"' in cdp
    assert '"127.0.0.1:8000:8000"' in api
    assert "ports:" not in worker
    assert "ports:" not in cdp
    assert "THOTH_TEMPORAL_TARGET: temporal:7233" in api
    assert "THOTH_TEMPORAL_TARGET: temporal:7233" in worker
    assert "THOTH_TEMPORAL_NAMESPACE: thoth-stage1" in api
    assert "THOTH_TEMPORAL_NAMESPACE: thoth-stage1" in worker
    assert "THOTH_CDP: http://legacy-cdp:18800" in worker
    approved_mode = (
        "THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: "
        "${THOTH_STAGE1_ACTIVITY_MODE:-python_tiktok_with_legacy_fallback}"
    )
    assert approved_mode in worker
    assert "/opt/thoth/bin/start-legacy-cdp" in cdp
    assert "/json/version" in cdp
    assert "/json" in cdp
    assert "tiktok.com" in cdp
    assert "/artifacts" in api
    assert "/artifacts" in worker
    assert "/browser-profile" in cdp
    assert "/browser-profile" not in api
    assert "/browser-profile" not in worker


def test_local_stage1_compose_requires_digest_qualified_thoth_image() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    assert "latest" not in compose
    assert "sha-1c904a7" not in compose
    assert compose.count("${THOTH_IMAGE:?set digest-qualified THOTH_IMAGE}") == 3


def test_local_stage1_compose_is_validated_by_offline_ci() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    command = (
        "docker compose --env-file .env.stage1.local.example "
        "-f compose.stage1.local.yml config --quiet"
    )
    assert "Validate local Stage 1 Compose" in workflow
    assert command in workflow


def test_local_stage1_runbook_keeps_live_and_evidence_actions_operator_gated() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    required = {
        "docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config",
        "docker compose --env-file .env.stage1.local -f compose.stage1.local.yml pull",
        "127.0.0.1:8000/healthz",
        "127.0.0.1:8000/readyz",
        "temporal operator namespace describe --namespace thoth-stage1",
        "python_tiktok_with_legacy_fallback",
        "legacy_scout",
        "s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/observations/",
        "s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/reports/",
        "Do not run `docker compose up` for `legacy-cdp` or `worker` "
        "without explicit live approval.",
        "Do not run `docker compose down -v`",
    }
    assert all(token in runbook for token in required)
    assert "https://www.tiktok.com/@" not in runbook
    assert "THOTH_CONTROL_PLANE_API_KEY=" not in runbook
    assert "THOTH_POSTGRES_PASSWORD=" not in runbook


def test_blueprint_records_local_stage1_orchestration_without_claiming_soak() -> None:
    blueprint = _repo_text("BLUEPRINT.md")
    assert "Stage 1 local Docker orchestration" in blueprint
    assert "PostgreSQL-backed Temporal" in blueprint
    assert "controlled live smoke and operational soak remain pending" in blueprint


def test_local_stage1_live_fixture_never_reaches_a_container() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    runbook = _repo_text("docs/operations/stage1-local-docker.md")

    assert "THOTH_LIVE_TIKTOK_URL" not in compose
    assert (
        "`THOTH_LIVE_TIKTOK_URL` is a host-side pytest variable and is never injected into a "
        "container." in runbook
    )


def test_local_stage1_runbook_never_renders_resolved_secrets() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    marker = "compose.stage1.local.yml config"
    render_commands = [line.strip() for line in runbook.splitlines() if marker in line]

    assert render_commands
    for command in render_commands:
        assert command.endswith(("--quiet", "--images", "--no-interpolate"))


def test_local_stage1_runbook_inspects_topology_without_extra_tooling() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    assert "config --no-interpolate" in runbook


def test_local_stage1_rollback_recreates_the_worker_with_the_selected_mode() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    worker = _service_block(compose, "worker")

    assert "${THOTH_STAGE1_ACTIVITY_MODE:-python_tiktok_with_legacy_fallback}" in worker
    assert "up -d --no-deps --force-recreate worker" in runbook
    assert "printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE" in runbook
    assert "docker compose restart` with the same digest" not in runbook


def test_local_stage1_runbook_verifies_the_deployment_before_any_live_action() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    required = {
        "operations stage1-local-preflight --env-file .env.stage1.local",
        "exec api id -u",
        "exec api test -w /var/lib/thoth/artifacts",
        "port legacy-cdp 18800",
        "exec worker id -u",
    }

    assert all(token in runbook for token in required)
