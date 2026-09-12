"""Behavioural tests for the restricted Scout provider file.

The reference container and the fallback worker must receive the same provider
input, which means an operator-held file on restricted storage becomes part of the
deployment contract. The validator therefore has to be as fail-closed as the rest of
the preflight: a wider file (an accidental copy of `.env`), a placeholder value, an
in-repository path that would land in a build context, or a group-readable mode are
all rejected before Compose is invoked.

Every assertion below also pins the second requirement: a rejection may name the
variable and the broken contract, never the value.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from thoth_control_plane.cli import app
from thoth_control_plane.operations.stage1_local_preflight import Stage1PreflightError
from thoth_control_plane.operations.stage1_provider_preflight import check_stage1_provider_file

runner = CliRunner()

CANARY_KEY = "synthetic-canary-only-not-a-real-key"
VALID_OCR_MODEL = "deepseek/deepseek-ocr"
VALID_CONTENT = f"THOTH_NOVITA_API_KEY={CANARY_KEY}\nTHOTH_SUBTITLE_OCR_MODEL={VALID_OCR_MODEL}\n"

REPOSITORY_ROOT = Path("C:/Users/operator/checkouts/CLIPPER")

VALID_LOCAL_ENVIRONMENT = {
    "THOTH_IMAGE": "ghcr.io/muhfalihr/thoth@sha256:" + "a1" * 32,
    "THOTH_STAGE1_DATA_ROOT": "/home/operator/thoth-stage1",
    "THOTH_STAGE1_ACTIVITY_MODE": "python_tiktok_with_legacy_fallback",
    "THOTH_CONTROL_PLANE_API_KEY": "local-api-key",
    "THOTH_POSTGRES_PASSWORD": "local-database-password",
    "THOTH_EDITOR_POSTGRES_PASSWORD": "local-editor-database-password",
}

posix_only = pytest.mark.skipif(
    os.name != "posix", reason="file mode bits are only meaningful on POSIX hosts"
)


def _provider_file(directory: Path, content: str = VALID_CONTENT, *, name: str = "provider.env"):
    candidate = directory / name
    candidate.write_text(content, encoding="utf-8")
    candidate.chmod(0o600)
    return candidate


def _outside_repository(tmp_path: Path) -> Path:
    """Return a directory that is not inside the repository root under test."""
    outside = tmp_path / "restricted"
    outside.mkdir()
    return outside


def test_provider_file_accepts_exactly_the_two_required_variables(tmp_path: Path) -> None:
    candidate = _provider_file(_outside_repository(tmp_path))

    check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")


def test_provider_file_returns_nothing_so_values_cannot_be_printed(tmp_path: Path) -> None:
    candidate = _provider_file(_outside_repository(tmp_path))

    assert check_stage1_provider_file(candidate, repository_root=tmp_path / "repo") is None


def test_provider_file_rejects_extra_environment(tmp_path: Path) -> None:
    candidate = _provider_file(
        _outside_repository(tmp_path),
        VALID_CONTENT + "AWS_SECRET_ACCESS_KEY=do-not-print-this\n",
    )

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
    assert "unrecognized variable" in str(failure.value)
    assert "do-not-print-this" not in str(failure.value)


@pytest.mark.parametrize(
    "unknown", ["synthetic-key/with+padding", "SyntheticKeyWithoutPunctuation"]
)
def test_provider_file_does_not_echo_unrecognized_assignment_names(
    tmp_path: Path, unknown: str
) -> None:
    candidate = _provider_file(_outside_repository(tmp_path), VALID_CONTENT + f"{unknown}==\n")
    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
    assert unknown not in str(failure.value)


def test_provider_file_requires_both_variables(tmp_path: Path) -> None:
    directory = _outside_repository(tmp_path)
    for content, missing in (
        (f"THOTH_NOVITA_API_KEY={CANARY_KEY}\n", "THOTH_SUBTITLE_OCR_MODEL"),
        (f"THOTH_SUBTITLE_OCR_MODEL={VALID_OCR_MODEL}\n", "THOTH_NOVITA_API_KEY"),
        ("", "THOTH_NOVITA_API_KEY"),
    ):
        candidate = _provider_file(directory, content)
        with pytest.raises(Stage1PreflightError) as failure:
            check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
        assert missing in str(failure.value)


def test_provider_file_rejects_a_duplicated_variable(tmp_path: Path) -> None:
    candidate = _provider_file(
        _outside_repository(tmp_path), VALID_CONTENT + "THOTH_NOVITA_API_KEY=second-value\n"
    )

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
    assert "THOTH_NOVITA_API_KEY" in str(failure.value)
    assert "second-value" not in str(failure.value)


@pytest.mark.parametrize(
    "key",
    ["", "   ", "replace-with-local-secret", "changeme", "your-novita-api-key", "<paste-key-here>"],
)
def test_provider_file_rejects_an_empty_or_placeholder_key(tmp_path: Path, key: str) -> None:
    candidate = _provider_file(
        _outside_repository(tmp_path),
        f"THOTH_NOVITA_API_KEY={key}\nTHOTH_SUBTITLE_OCR_MODEL={VALID_OCR_MODEL}\n",
    )

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
    assert "THOTH_NOVITA_API_KEY" in str(failure.value)


@pytest.mark.parametrize("model", ["", "deepseek ocr", "deepseek-ocr", "  ", "a/b c"])
def test_provider_file_requires_a_provider_qualified_ocr_model(tmp_path: Path, model: str) -> None:
    candidate = _provider_file(
        _outside_repository(tmp_path),
        f"THOTH_NOVITA_API_KEY={CANARY_KEY}\nTHOTH_SUBTITLE_OCR_MODEL={model}\n",
    )

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
    assert "THOTH_SUBTITLE_OCR_MODEL" in str(failure.value)


def test_provider_file_rejects_a_control_character_in_a_value(tmp_path: Path) -> None:
    candidate = _provider_file(
        _outside_repository(tmp_path),
        f"THOTH_NOVITA_API_KEY={CANARY_KEY}\x00tail\nTHOTH_SUBTITLE_OCR_MODEL={VALID_OCR_MODEL}\n",
    )

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
    assert CANARY_KEY not in str(failure.value)


def test_provider_file_rejects_a_malformed_line(tmp_path: Path) -> None:
    candidate = _provider_file(_outside_repository(tmp_path), VALID_CONTENT + "not-an-assignment\n")

    with pytest.raises(Stage1PreflightError):
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")


def test_provider_file_must_be_an_absolute_path(tmp_path: Path) -> None:
    _provider_file(_outside_repository(tmp_path))

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(Path("provider.env"), repository_root=tmp_path / "repo")
    assert "absolute" in str(failure.value)


def test_provider_file_must_live_outside_the_repository(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    (repository / "secrets").mkdir(parents=True)
    candidate = _provider_file(repository / "secrets")

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=repository)
    assert "repository" in str(failure.value)


@posix_only
def test_provider_file_may_not_be_a_symlink_into_the_repository(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    (repository / "secrets").mkdir(parents=True)
    target = _provider_file(repository / "secrets")
    link = _outside_repository(tmp_path) / "provider.env"
    link.symlink_to(target)

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(link, repository_root=repository)
    assert "repository" in str(failure.value)


def test_provider_file_must_exist(tmp_path: Path) -> None:
    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(
            _outside_repository(tmp_path) / "absent.env", repository_root=tmp_path / "repo"
        )
    assert "unreadable" in str(failure.value) or "not a regular file" in str(failure.value)


def test_provider_file_must_be_a_regular_file(tmp_path: Path) -> None:
    directory = _outside_repository(tmp_path) / "provider.env"
    directory.mkdir()

    with pytest.raises(Stage1PreflightError):
        check_stage1_provider_file(directory, repository_root=tmp_path / "repo")


@posix_only
def test_provider_file_must_be_unreadable_to_group_and_world(tmp_path: Path) -> None:
    outside = _outside_repository(tmp_path)
    for index, mode in enumerate((0o640, 0o604, 0o660, 0o644)):
        candidate = _provider_file(outside, name=f"wide-{index}.env")
        candidate.chmod(mode)
        with pytest.raises(Stage1PreflightError) as failure:
            check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
        assert "owner" in str(failure.value)
        assert CANARY_KEY not in str(failure.value)


@posix_only
def test_provider_file_must_be_readable(tmp_path: Path) -> None:
    if os.geteuid() == 0:  # type: ignore[attr-defined]
        pytest.skip("root bypasses the permission bits this check relies on")
    candidate = _provider_file(_outside_repository(tmp_path))
    candidate.chmod(0o200)

    with pytest.raises(Stage1PreflightError) as failure:
        check_stage1_provider_file(candidate, repository_root=tmp_path / "repo")
    assert "unreadable" in str(failure.value)


def _local_environment_file(directory: Path) -> Path:
    env_file = directory / ".env.stage1.local"
    env_file.write_text(
        "\n".join(f"{name}={value}" for name, value in VALID_LOCAL_ENVIRONMENT.items()) + "\n",
        encoding="utf-8",
    )
    return env_file


def test_preflight_command_without_the_option_keeps_its_existing_behaviour(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "operations",
            "stage1-local-preflight",
            "--env-file",
            str(_local_environment_file(tmp_path)),
        ],
    )

    assert result.exit_code == 0
    assert "provider" not in result.output.lower()


def test_preflight_command_validates_the_provider_file_without_echoing_it(tmp_path: Path) -> None:
    outside = _outside_repository(tmp_path)
    result = runner.invoke(
        app,
        [
            "operations",
            "stage1-local-preflight",
            "--env-file",
            str(_local_environment_file(tmp_path)),
            "--provider-env-file",
            str(_provider_file(outside)),
        ],
    )

    assert result.exit_code == 0, result.output
    assert CANARY_KEY not in result.output


def test_preflight_command_rejects_a_wide_provider_file_without_echoing_it(tmp_path: Path) -> None:
    outside = _outside_repository(tmp_path)
    candidate = _provider_file(outside, VALID_CONTENT + "AWS_SECRET_ACCESS_KEY=do-not-print\n")

    result = runner.invoke(
        app,
        [
            "operations",
            "stage1-local-preflight",
            "--env-file",
            str(_local_environment_file(tmp_path)),
            "--provider-env-file",
            str(candidate),
        ],
    )

    assert result.exit_code == 1
    assert "unrecognized variable" in result.output
    assert CANARY_KEY not in result.output
    assert "do-not-print" not in result.output
