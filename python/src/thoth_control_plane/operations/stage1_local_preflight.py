"""Fail-closed operator preflight for the Stage 1 local Docker deployment.

Compose interpolation of the form `${VAR:?message}` only rejects an empty
value. A mutable tag such as `:latest`, a foreign registry, a malformed
digest, a relative data root, or a data root inside the repository worktree
all render and start successfully. This module is the gate Compose cannot be:
it validates release identity, the external data root, the approved activity
mode, and the presence of local credentials before any image is pulled.

No failure message echoes a value. Messages name the offending variable only,
so running the check in a shared terminal or pasting its output into a change
record cannot leak the API key, the database password, or the fixture URL.
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath

IMAGE_PATTERN = re.compile(r"ghcr\.io/muhfalihr/thoth@sha256:[0-9a-f]{64}")
DEFAULT_ACTIVITY_MODE = "python_tiktok_with_legacy_fallback"
ROLLBACK_ACTIVITY_MODE = "legacy_scout"
APPROVED_ACTIVITY_MODES = (DEFAULT_ACTIVITY_MODE, ROLLBACK_ACTIVITY_MODE)
REQUIRED_SECRET_VARIABLES = ("THOTH_CONTROL_PLANE_API_KEY", "THOTH_POSTGRES_PASSWORD")
PLACEHOLDER_SECRET = "replace-with-local-secret"


class Stage1PreflightError(ValueError):
    """Raised when the local Stage 1 environment fails a deployment contract.

    The message names the offending variable and the contract it breaks, and
    never contains the rejected value.
    """


def load_stage1_local_environment(path: Path) -> dict[str, str]:
    """Parse an untracked `.env.stage1.local` file into plain values.

    Blank lines and `#` comments are ignored; surrounding single or double
    quotes are removed. Any unreadable file or line without `=` aborts the
    whole load, because a partially understood environment is not a validated
    one. The failure message never contains file content.
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise Stage1PreflightError("stage 1 local environment file is unreadable") from error

    values: dict[str, str] = {}
    for line in lines:
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        if "=" not in entry:
            raise Stage1PreflightError("stage 1 local environment file has a malformed line")
        name, _, value = entry.partition("=")
        values[name.strip()] = value.strip().strip("\"'")
    return values


def check_stage1_local_environment(values: dict[str, str], *, repository_root: Path) -> None:
    """Validate every operator-supplied deployment input, or raise.

    Checks run in a fixed order so the first failure is deterministic:
    release identity, external data root, approved activity mode, then local
    credentials.
    """
    _check_image(values.get("THOTH_IMAGE", ""))
    _check_data_root(values.get("THOTH_STAGE1_DATA_ROOT", ""), repository_root)
    _check_activity_mode(values.get("THOTH_STAGE1_ACTIVITY_MODE", DEFAULT_ACTIVITY_MODE))
    _check_secrets(values)


def _check_image(image: str) -> None:
    if not IMAGE_PATTERN.fullmatch(image):
        raise Stage1PreflightError(
            "THOTH_IMAGE must be ghcr.io/muhfalihr/thoth pinned to a lowercase sha256 digest"
        )


def _check_data_root(data_root: str, repository_root: Path) -> None:
    if not data_root.startswith("/"):
        raise Stage1PreflightError(
            "THOTH_STAGE1_DATA_ROOT must be an absolute POSIX path on the Docker host"
        )
    if ".." in PurePosixPath(data_root).parts:
        raise Stage1PreflightError("THOTH_STAGE1_DATA_ROOT must not traverse parent directories")

    candidate = data_root.rstrip("/").lower()
    for root in _repository_host_paths(repository_root):
        if candidate == root or candidate.startswith(f"{root}/"):
            raise Stage1PreflightError("THOTH_STAGE1_DATA_ROOT must be outside the repository")


def _repository_host_paths(repository_root: Path) -> tuple[str, ...]:
    """Return every lowercase host path the repository can be reached by.

    A Windows checkout driven through WSL is visible under both `C:/…` and
    `/mnt/c/…`, and only the second form can appear in a Compose bind mount,
    so both are compared.
    """
    posix_root = repository_root.as_posix().rstrip("/").lower()
    drive, _, remainder = posix_root.partition(":")
    if not remainder:
        return (posix_root,)
    return (posix_root, f"/mnt/{drive}{remainder}")


def _check_activity_mode(mode: str) -> None:
    if mode not in APPROVED_ACTIVITY_MODES:
        raise Stage1PreflightError(
            "THOTH_STAGE1_ACTIVITY_MODE must be "
            f"{DEFAULT_ACTIVITY_MODE} or {ROLLBACK_ACTIVITY_MODE}"
        )


def _check_secrets(values: dict[str, str]) -> None:
    for name in REQUIRED_SECRET_VARIABLES:
        value = values.get(name, "").strip()
        if not value or value == PLACEHOLDER_SECRET:
            raise Stage1PreflightError(f"{name} must be a non-empty local credential")
