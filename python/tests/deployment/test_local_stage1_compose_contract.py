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
