from pathlib import Path

import pytest
from typer.testing import CliRunner

from thoth_control_plane.cli import app
from thoth_control_plane.operations.stage1_local_preflight import (
    Stage1PreflightError,
    check_stage1_local_environment,
    load_stage1_local_environment,
)

runner = CliRunner()

REPOSITORY_ROOT = Path("C:/Users/operator/checkouts/CLIPPER")
VALID_IMAGE = "ghcr.io/muhfalihr/thoth@sha256:" + "a1" * 32

VALID_ENVIRONMENT = {
    "THOTH_IMAGE": VALID_IMAGE,
    "THOTH_STAGE1_DATA_ROOT": "/home/operator/thoth-stage1",
    "THOTH_STAGE1_ACTIVITY_MODE": "python_tiktok_with_legacy_fallback",
    "THOTH_CONTROL_PLANE_API_KEY": "local-api-key",
    "THOTH_POSTGRES_PASSWORD": "local-database-password",
}


def _environment(**overrides: str) -> dict[str, str]:
    return {**VALID_ENVIRONMENT, **overrides}


def test_approved_environment_passes() -> None:
    check_stage1_local_environment(_environment(), repository_root=REPOSITORY_ROOT)


def test_activity_mode_is_optional_and_defaults_to_the_approved_fallback() -> None:
    values = _environment()
    del values["THOTH_STAGE1_ACTIVITY_MODE"]

    check_stage1_local_environment(values, repository_root=REPOSITORY_ROOT)


@pytest.mark.parametrize(
    "image",
    [
        "ghcr.io/muhfalihr/thoth:latest",
        "ghcr.io/muhfalihr/thoth:sha-1c904a7",
        "ghcr.io/muhfalihr/thoth",
        "ghcr.io/muhfalihr/thoth@sha256:" + "A1" * 32,
        "ghcr.io/muhfalihr/thoth@sha256:" + "a1" * 31,
        "ghcr.io/muhfalihr/other@sha256:" + "a1" * 32,
        "docker.io/muhfalihr/thoth@sha256:" + "a1" * 32,
        VALID_IMAGE + " extra",
        "",
    ],
)
def test_mutable_or_malformed_image_is_rejected(image: str) -> None:
    with pytest.raises(Stage1PreflightError):
        check_stage1_local_environment(
            _environment(THOTH_IMAGE=image), repository_root=REPOSITORY_ROOT
        )


@pytest.mark.parametrize(
    "data_root",
    [
        "",
        "stage1-data",
        "./stage1-data",
        "../thoth-stage1",
        "/home/operator/../thoth-stage1",
        "C:/Users/operator/checkouts/CLIPPER/stage1-data",
        "/mnt/c/Users/operator/checkouts/CLIPPER/stage1-data",
        "/mnt/c/users/operator/checkouts/clipper/browser-profile",
    ],
)
def test_relative_or_in_repository_data_root_is_rejected(data_root: str) -> None:
    with pytest.raises(Stage1PreflightError):
        check_stage1_local_environment(
            _environment(THOTH_STAGE1_DATA_ROOT=data_root), repository_root=REPOSITORY_ROOT
        )


@pytest.mark.parametrize("mode", ["python", "legacy", "", "PYTHON_TIKTOK_WITH_LEGACY_FALLBACK"])
def test_unapproved_activity_mode_is_rejected(mode: str) -> None:
    with pytest.raises(Stage1PreflightError):
        check_stage1_local_environment(
            _environment(THOTH_STAGE1_ACTIVITY_MODE=mode), repository_root=REPOSITORY_ROOT
        )


def test_rollback_activity_mode_is_accepted() -> None:
    check_stage1_local_environment(
        _environment(THOTH_STAGE1_ACTIVITY_MODE="legacy_scout"), repository_root=REPOSITORY_ROOT
    )


@pytest.mark.parametrize("secret", ["THOTH_CONTROL_PLANE_API_KEY", "THOTH_POSTGRES_PASSWORD"])
@pytest.mark.parametrize("value", ["", "   ", "replace-with-local-secret"])
def test_missing_or_placeholder_secret_is_rejected(secret: str, value: str) -> None:
    with pytest.raises(Stage1PreflightError):
        check_stage1_local_environment(
            _environment(**{secret: value}), repository_root=REPOSITORY_ROOT
        )


def test_failure_messages_never_echo_the_offending_value() -> None:
    values = _environment(
        THOTH_IMAGE="ghcr.io/muhfalihr/thoth:secret-looking-tag",
        THOTH_CONTROL_PLANE_API_KEY="super-secret-api-key",
    )

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_local_environment(values, repository_root=REPOSITORY_ROOT)

    message = str(failure.value)
    assert "THOTH_IMAGE" in message
    assert "secret-looking-tag" not in message
    assert "super-secret-api-key" not in message


def test_environment_file_loading_keeps_comments_and_quotes_out(tmp_path: Path) -> None:
    env_file = tmp_path / ".env.stage1.local"
    env_file.write_text(
        f"# comment\n\nTHOTH_IMAGE='{VALID_IMAGE}'\n"
        'THOTH_STAGE1_DATA_ROOT="/home/operator/thoth-stage1"\n',
        encoding="utf-8",
    )

    values = load_stage1_local_environment(env_file)

    assert values["THOTH_IMAGE"] == VALID_IMAGE
    assert values["THOTH_STAGE1_DATA_ROOT"] == "/home/operator/thoth-stage1"


def test_malformed_environment_file_is_rejected_without_echoing_content(tmp_path: Path) -> None:
    env_file = tmp_path / ".env.stage1.local"
    env_file.write_text("THOTH_POSTGRES_PASSWORD\n", encoding="utf-8")

    with pytest.raises(Stage1PreflightError) as failure:
        load_stage1_local_environment(env_file)

    assert "THOTH_POSTGRES_PASSWORD" not in str(failure.value)


def test_missing_environment_file_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(Stage1PreflightError):
        load_stage1_local_environment(tmp_path / "absent.env")


def _write_environment(directory: Path, **overrides: str) -> Path:
    env_file = directory / ".env.stage1.local"
    values = _environment(**overrides)
    lines = [f"{name}={value}" for name, value in values.items()]
    env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return env_file


def test_preflight_command_accepts_an_approved_environment(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["operations", "stage1-local-preflight", "--env-file", str(_write_environment(tmp_path))],
    )

    assert result.exit_code == 0


def test_preflight_command_rejects_a_mutable_image_without_echoing_values(tmp_path: Path) -> None:
    env_file = _write_environment(
        tmp_path,
        THOTH_IMAGE="ghcr.io/muhfalihr/thoth:latest",
        THOTH_CONTROL_PLANE_API_KEY="super-secret-api-key",
    )

    result = runner.invoke(
        app, ["operations", "stage1-local-preflight", "--env-file", str(env_file)]
    )

    assert result.exit_code == 1
    assert "THOTH_IMAGE" in result.output
    assert "latest" not in result.output
    assert "super-secret-api-key" not in result.output
