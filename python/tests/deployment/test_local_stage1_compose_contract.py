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
