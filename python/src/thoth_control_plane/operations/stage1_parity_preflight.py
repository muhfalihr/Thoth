"""Fail-closed operator preflight for a standalone parity reference container.

A reference is a one-shot container that owns its browser and writes the only
durable record of an attempt. Compose cannot protect either property: `${VAR:?}`
rejects an empty value, so a mutable image tag, a sample directory inside the
repository or the deployment data root, a symlink pointing back at production
storage, a world-readable fixture, or a sample that already holds an attempt
record all render and start successfully.

This module is the gate that runs before any container is created. It refuses a
`THOTH_CDP` inherited from the operator's shell rather than overriding it: a
reference that could be pointed at the production sidecar is exactly the failure
this container exists to prevent.

As with the sibling preflights, no message contains a rejected value. The fixture
is a real post URL and the provider file is a live credential, so both are
described by contract only, and nothing here returns parsed values.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

from thoth_control_plane.acquisition.adapters.tiktok import (
    TikTokUrlError,
    canonicalize_tiktok_post_url,
)
from thoth_control_plane.operations.stage1_local_preflight import (
    IMAGE_PATTERN,
    Stage1PreflightError,
)
from thoth_control_plane.operations.stage1_provider_preflight import check_stage1_provider_file

#: The loopback endpoint of the browser a reference starts for itself.
REFERENCE_CDP_ENDPOINT = "http://127.0.0.1:18801"

FIXTURE_RELATIVE_PATH = ("reference-input", "url")
OUTPUT_DIRECTORY_NAME = "scout-output"
ATTEMPT_RECORD_NAME = "reference-attempt.json"


def check_parity_inputs(
    image: str,
    sample: Path,
    provider: Path,
    *,
    repository_root: Path,
    data_root: Path,
) -> None:
    """Validate every host input of a parity reference run, or raise.

    Checks run in a fixed order so the first failure is deterministic: release
    identity, sample location, sample contents and permissions, the inherited
    CDP endpoint, then the shared provider contract.
    """
    _check_image(image)
    resolved = _check_sample_location(sample, repository_root, data_root)
    _check_sample_tree(resolved)
    _check_fixture(resolved)
    _check_absent_attempt_record(resolved)
    _check_inherited_cdp(os.environ.get("THOTH_CDP"))
    check_stage1_provider_file(provider, repository_root=repository_root)


def _check_image(image: str) -> None:
    if not IMAGE_PATTERN.fullmatch(image):
        raise Stage1PreflightError(
            "the parity reference image must be ghcr.io/muhfalihr/thoth pinned to a "
            "lowercase sha256 digest, the same release as the Python worker"
        )


def _check_sample_location(sample: Path, repository_root: Path, data_root: Path) -> Path:
    if not sample.is_absolute():
        raise Stage1PreflightError(
            "the parity sample directory must be given as an absolute host path"
        )
    resolved = sample.resolve()
    if not resolved.is_dir():
        raise Stage1PreflightError("the parity sample directory does not exist")
    if _is_inside(resolved, repository_root):
        raise Stage1PreflightError(
            "the parity sample directory must resolve outside the repository worktree"
        )
    if _is_inside(resolved, data_root):
        raise Stage1PreflightError(
            "the parity sample directory must resolve outside the deployment data root"
        )
    return resolved


def _is_inside(candidate: Path, root: Path) -> bool:
    try:
        resolved_root = root.resolve()
    except OSError:  # pragma: no cover - an unreachable root cannot contain the sample
        return False
    return candidate == resolved_root or resolved_root in candidate.parents


def _check_sample_tree(sample: Path) -> None:
    """Refuse a sample whose own permissions or links widen the evidence boundary.

    A symlink anywhere in the tree is rejected outright rather than resolved: the
    directory is bind-mounted read-write into the container, so a link is a
    writable path out of the sample and back into whatever it names.
    """
    _check_directory_mode(sample)
    for entry in sample.rglob("*"):
        if entry.is_symlink():
            raise Stage1PreflightError(
                "the parity sample directory must not contain a symlink; it is "
                "bind-mounted read-write into the reference container"
            )


def _check_directory_mode(sample: Path) -> None:
    if os.name != "posix":
        return
    if stat.S_IMODE(sample.stat().st_mode) & 0o077:
        raise Stage1PreflightError(
            "the parity sample directory must be accessible by its owner only (chmod 0700)"
        )


def _check_fixture(sample: Path) -> None:
    fixture = sample.joinpath(*FIXTURE_RELATIVE_PATH)
    if not fixture.is_file():
        raise Stage1PreflightError(
            "the parity fixture must exist at reference-input/url inside the sample directory"
        )
    _check_fixture_mode(fixture)

    try:
        content = fixture.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise Stage1PreflightError("the parity fixture file is unreadable") from error
    if len(content.strip().splitlines()) != 1:
        raise Stage1PreflightError("the parity fixture file must hold exactly one bare URL")

    try:
        canonicalize_tiktok_post_url(content.strip())
    except TikTokUrlError as error:
        # The canonicalizer's message is already value-free; the fixture is still
        # restated as a contract so the operator is not told to inspect a URL.
        raise Stage1PreflightError(
            "the parity fixture must be a canonical https TikTok post URL without "
            "credentials, port, query, or fragment"
        ) from error


def _check_fixture_mode(fixture: Path) -> None:
    """Allow group read, because the reference runs as a different identity.

    The fixture is bind-mounted into the container, and Docker honours the host
    file's permissions there, so an owner-only fixture is simply unreadable to the
    reference. Group read is the narrowest mode that works; anything the world can
    read, or the group can write, is not.
    """
    if os.name != "posix":
        return
    if stat.S_IMODE(fixture.stat().st_mode) & 0o027:
        raise Stage1PreflightError(
            "the parity fixture file must be readable by its owner and the "
            "container group only (chmod 0640)"
        )


def _check_absent_attempt_record(sample: Path) -> None:
    output = sample / OUTPUT_DIRECTORY_NAME
    if not output.is_dir():
        raise Stage1PreflightError(
            f"the parity sample directory must contain an empty {OUTPUT_DIRECTORY_NAME} directory"
        )
    if next(output.rglob(ATTEMPT_RECORD_NAME), None) is not None:
        raise Stage1PreflightError(
            "the parity sample directory already holds an attempt record; a rerun "
            "would overwrite evidence, so use a fresh sample directory"
        )


def _check_inherited_cdp(endpoint: str | None) -> None:
    if endpoint is None:
        return
    if endpoint.strip().rstrip("/") != REFERENCE_CDP_ENDPOINT:
        raise Stage1PreflightError(
            "THOTH_CDP is set to an endpoint the reference does not own; a reference "
            f"drives only its own browser at {REFERENCE_CDP_ENDPOINT}"
        )


def _main() -> int:
    """Validate the four operator inputs and print booleans only."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m thoth_control_plane.operations.stage1_parity_preflight",
        description="Validate the inputs of a standalone Stage 1 parity reference run.",
    )
    parser.add_argument("--image", required=True)
    parser.add_argument("--sample", required=True, type=Path)
    parser.add_argument("--provider", required=True, type=Path)
    parser.add_argument("--repository-root", required=True, type=Path)
    parser.add_argument("--data-root", required=True, type=Path)
    arguments = parser.parse_args()

    try:
        check_parity_inputs(
            arguments.image,
            arguments.sample,
            arguments.provider,
            repository_root=arguments.repository_root,
            data_root=arguments.data_root,
        )
    except Stage1PreflightError as error:
        print("parity_inputs_valid=false")
        print(f"reason={error}")
        return 1
    print("parity_inputs_valid=true")
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised as a module CLI
    raise SystemExit(_main())
