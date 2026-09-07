"""Behavioural tests for the standalone parity reference container.

A parity reference is a one-shot container that owns its browser. Two things can
still go wrong before it starts, and neither is caught by Compose interpolation:
the operator can point it at production state, and they can point it at evidence
that already exists. Compose renders both happily.

These tests pin the host gate that runs first. Every input here is synthetic; no
real image digest, fixture, or provider value appears, and each assertion also
checks that a rejection names the contract rather than the value.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from thoth_control_plane.operations.stage1_local_preflight import Stage1PreflightError
from thoth_control_plane.operations.stage1_parity_preflight import (
    REFERENCE_CDP_ENDPOINT,
    check_parity_inputs,
)

CANARY_KEY = "synthetic-canary-only-not-a-real-key"
CANARY_FIXTURE = "https://www.tiktok.com/@synthetic-canary/video/1234567890123456789"
VALID_IMAGE = "ghcr.io/muhfalihr/thoth@sha256:" + "a1" * 32
PROVIDER_CONTENT = f"THOTH_NOVITA_API_KEY={CANARY_KEY}\nTHOTH_SUBTITLE_OCR_MODEL=vendor/model\n"

posix_only = pytest.mark.skipif(
    os.name != "posix", reason="file mode bits are only meaningful on POSIX hosts"
)


@pytest.fixture(autouse=True)
def _no_inherited_cdp(monkeypatch: pytest.MonkeyPatch) -> None:
    """The host shell must not decide which browser a reference talks to."""
    monkeypatch.delenv("THOTH_CDP", raising=False)


def _sample(root: Path, *, fixture: str | None = CANARY_FIXTURE) -> Path:
    sample = root / "restricted" / "p3"
    (sample / "reference-input").mkdir(parents=True)
    (sample / "scout-output").mkdir(parents=True)
    if fixture is not None:
        target = sample / "reference-input" / "url"
        target.write_text(f"{fixture}\n", encoding="utf-8")
        target.chmod(0o600)
    sample.chmod(0o700)
    return sample


def _provider(root: Path, content: str = PROVIDER_CONTENT) -> Path:
    target = root / "restricted" / "provider.env"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    target.chmod(0o600)
    return target


def _check(tmp_path: Path, **overrides) -> None:
    """Validate a synthetic sample, building only the inputs a test did not supply."""
    check_parity_inputs(
        overrides.get("image", VALID_IMAGE),
        overrides["sample"] if "sample" in overrides else _sample(tmp_path),
        overrides["provider"] if "provider" in overrides else _provider(tmp_path),
        repository_root=overrides.get("repository_root", tmp_path / "repo"),
        data_root=overrides.get("data_root", tmp_path / "data"),
    )


def test_a_complete_synthetic_sample_passes(tmp_path: Path) -> None:
    _check(tmp_path)


def test_the_preflight_returns_nothing_so_inputs_cannot_be_printed(tmp_path: Path) -> None:
    assert (
        check_parity_inputs(
            VALID_IMAGE,
            _sample(tmp_path),
            _provider(tmp_path),
            repository_root=tmp_path / "repo",
            data_root=tmp_path / "data",
        )
        is None
    )


def test_mutable_reference_image_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        check_parity_inputs(
            "ghcr.io/muhfalihr/thoth:latest",
            tmp_path / "sample",
            tmp_path / "provider.env",
            repository_root=tmp_path / "repo",
            data_root=tmp_path / "data",
        )


@pytest.mark.parametrize(
    "image",
    [
        "ghcr.io/muhfalihr/thoth:stage1",
        "ghcr.io/muhfalihr/thoth",
        "ghcr.io/someone-else/thoth@sha256:" + "a1" * 32,
        "ghcr.io/muhfalihr/thoth@sha256:" + "A1" * 32,
        "ghcr.io/muhfalihr/thoth@sha256:a1",
        "",
    ],
)
def test_only_a_pinned_lowercase_digest_of_this_repository_is_accepted(
    tmp_path: Path, image: str
) -> None:
    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, image=image)

    assert "digest" in str(failure.value)


def test_a_relative_sample_directory_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(Stage1PreflightError):
        _check(tmp_path, sample=Path("sample"))


def test_a_sample_inside_the_repository_would_reach_the_build_context(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    sample = _sample(repository)

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=sample, repository_root=repository)

    assert "repository" in str(failure.value)


def test_a_sample_inside_the_deployment_data_root_is_rejected(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    sample = _sample(data_root)

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=sample, data_root=data_root)

    assert "data root" in str(failure.value)


def test_a_missing_fixture_is_rejected_before_the_container_starts(tmp_path: Path) -> None:
    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=_sample(tmp_path, fixture=None))

    assert "fixture" in str(failure.value)


def test_an_unreadable_fixture_never_appears_in_the_rejection(tmp_path: Path) -> None:
    sample = _sample(tmp_path, fixture="https://www.instagram.com/p/synthetic-canary/")

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=sample)

    assert "synthetic-canary" not in str(failure.value)


def test_existing_attempt_evidence_is_never_silently_overwritten(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    attempt = sample / "scout-output" / "legacy-scout" / "ref-p3" / "reference-attempt.json"
    attempt.parent.mkdir(parents=True)
    attempt.write_text("{}\n", encoding="utf-8")

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=sample)

    assert "attempt" in str(failure.value)


def test_a_conflicting_cdp_endpoint_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("THOTH_CDP", "http://legacy-cdp:18800")

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path)

    assert "THOTH_CDP" in str(failure.value)


def test_the_reference_endpoint_itself_is_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("THOTH_CDP", REFERENCE_CDP_ENDPOINT)

    _check(tmp_path)


def test_provider_extras_are_rejected_by_the_shared_validator(tmp_path: Path) -> None:
    provider = _provider(tmp_path, PROVIDER_CONTENT + "AWS_SECRET_ACCESS_KEY=do-not-print-this\n")

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, provider=provider)

    assert "do-not-print-this" not in str(failure.value)


@posix_only
def test_a_symlinked_sample_that_escapes_the_restricted_parent_is_rejected(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    link = tmp_path / "restricted" / "linked"
    link.symlink_to(sample, target_is_directory=True)
    escaping = sample / "scout-output" / "elsewhere"
    escaping.symlink_to(tmp_path / "data", target_is_directory=True)

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=sample)

    assert "symlink" in str(failure.value)


@posix_only
def test_a_world_readable_sample_directory_is_rejected(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    sample.chmod(0o755)

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=sample)

    assert "0700" in str(failure.value)


@posix_only
def test_the_container_group_may_read_the_fixture(tmp_path: Path) -> None:
    """The fixture is bind-mounted into a container that runs as another identity.

    Docker honours host permissions on a bind mount, so an owner-only fixture is
    unreadable to the reference. Group read is the narrowest mode that works.
    """
    sample = _sample(tmp_path)
    (sample / "reference-input" / "url").chmod(0o640)

    _check(tmp_path, sample=sample)


@posix_only
@pytest.mark.parametrize("mode", [0o644, 0o604, 0o660, 0o666])
def test_a_fixture_the_world_can_read_or_the_group_can_write_is_rejected(
    tmp_path: Path, mode: int
) -> None:
    sample = _sample(tmp_path)
    (sample / "reference-input" / "url").chmod(mode)

    with pytest.raises(Stage1PreflightError) as failure:
        _check(tmp_path, sample=sample)

    assert "0640" in str(failure.value)


# --- standalone topology ----------------------------------------------------
#
# Compose interpolation renders a wrong topology as happily as a right one, so the
# rendered configuration is inspected rather than the file text. It is captured in
# this process and never printed: it contains the provider values.

COMPOSE_FILE = "compose.stage1.parity.yml"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

PRODUCTION_PATHS = (
    "/var/lib/thoth/artifacts",
    "/var/lib/thoth/browser-profile",
    "/var/run/docker.sock",
)

docker_only = pytest.mark.skipif(
    shutil.which("docker") is None, reason="rendering the topology requires the Docker CLI"
)


def _render(tmp_path: Path) -> dict:
    """Render the standalone file with synthetic inputs, returning parsed JSON."""
    sample = _sample(tmp_path)
    environment = {
        **os.environ,
        "THOTH_PARITY_IMAGE": VALID_IMAGE,
        "THOTH_PARITY_REFERENCE_ID": "ref-synthetic",
        "THOTH_PARITY_SAMPLE_DIR": str(sample),
        "THOTH_STAGE1_PROVIDER_ENV_FILE": str(_provider(tmp_path)),
    }
    result = subprocess.run(
        ["docker", "compose", "-f", COMPOSE_FILE, "config", "--format", "json"],
        cwd=REPOSITORY_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, "the standalone parity file did not render"
    return json.loads(result.stdout)


@docker_only
def test_the_parity_file_composes_exactly_one_disposable_service(tmp_path: Path) -> None:
    rendered = _render(tmp_path)

    assert list(rendered["services"]) == ["reference"]
    reference = rendered["services"]["reference"]
    assert reference["command"] == ["/opt/thoth/bin/start-parity-reference"]
    assert reference["user"] == "10001:10001"
    assert reference["restart"] == "no"
    assert reference["security_opt"] == ["seccomp:unconfined"]
    assert reference.get("privileged") in (None, False)
    assert not reference.get("ports")
    assert not reference.get("cap_add")
    assert reference.get("network_mode") is None
    # Compose always synthesises a default network; it must stay project-scoped
    # rather than joining a network the deployment already runs on.
    assert list(reference["networks"]) == ["default"]
    default = rendered["networks"]["default"]
    assert default["name"].startswith(f"{rendered['name']}_")
    assert default.get("external") in (None, False)


@docker_only
def test_the_reference_receives_only_a_fresh_tmpfs_profile(tmp_path: Path) -> None:
    reference = _render(tmp_path)["services"]["reference"]

    assert reference["tmpfs"] == ["/var/lib/thoth/parity-profile:uid=10001,gid=10001,mode=0700"]
    assert all(mount["type"] == "bind" for mount in reference["volumes"])


@docker_only
def test_no_production_state_is_mounted_into_a_reference(tmp_path: Path) -> None:
    reference = _render(tmp_path)["services"]["reference"]

    binds = {mount["target"]: mount for mount in reference["volumes"] if mount["type"] == "bind"}
    assert set(binds) == {"/run/parity/url", "/opt/thoth/scout/output"}
    assert binds["/run/parity/url"]["read_only"] is True
    # Compose omits the flag when it is false, so absence is the writable case.
    assert binds["/opt/thoth/scout/output"].get("read_only", False) is False
    for mount in reference["volumes"]:
        assert mount.get("source", "") not in PRODUCTION_PATHS
        assert mount["target"] not in PRODUCTION_PATHS


@docker_only
def test_the_reference_environment_admits_no_endpoint_or_credential_it_did_not_declare(
    tmp_path: Path,
) -> None:
    reference = _render(tmp_path)["services"]["reference"]

    assert reference["environment"]["THOTH_CDP"] == REFERENCE_CDP_ENDPOINT
    assert set(reference["environment"]) == {
        "THOTH_CDP",
        "THOTH_PARITY_REFERENCE_ID",
        "THOTH_SCOUT_PROVIDER",
        "THOTH_SCOUT_CHAT_PROVIDER",
        "THOTH_SCOUT_VISION_PROVIDER",
        "THOTH_SCOUT_EMBED_PROVIDER",
        "THOTH_NOVITA_API_KEY",
        "THOTH_SUBTITLE_OCR_MODEL",
    }


def test_the_preflight_cli_reports_booleans_without_echoing_its_inputs(tmp_path: Path) -> None:
    sample = _sample(tmp_path, fixture="https://www.instagram.com/p/synthetic-canary/")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "thoth_control_plane.operations.stage1_parity_preflight",
            "--image",
            VALID_IMAGE,
            "--sample",
            str(sample),
            "--provider",
            str(_provider(tmp_path)),
            "--repository-root",
            str(tmp_path / "repo"),
            "--data-root",
            str(tmp_path / "data"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "parity_inputs_valid=false" in result.stdout
    assert CANARY_KEY not in result.stdout + result.stderr
    assert "synthetic-canary" not in result.stdout + result.stderr


@docker_only
def test_the_fixture_url_never_reaches_the_container_configuration(tmp_path: Path) -> None:
    """The fixture is read from a mount, so it must not appear in the topology.

    A URL placed in an environment variable or an argument vector is visible to
    anyone who can run `docker inspect`, which is the leak the read-only mount
    exists to prevent. The rendered configuration is the only place that could
    reintroduce it.

    The provider key does appear in the rendered configuration, because that is
    how the container receives it; that is why this module captures the
    rendering instead of printing it. The fixture has no such excuse.
    """
    rendered = json.dumps(_render(tmp_path))

    assert CANARY_FIXTURE not in rendered
    assert CANARY_FIXTURE.rsplit("/", 1)[-1] not in rendered
    assert "tiktok.com" not in rendered
