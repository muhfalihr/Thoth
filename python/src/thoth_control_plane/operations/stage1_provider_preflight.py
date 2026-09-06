"""Fail-closed validation of the restricted Scout provider file.

Legacy Scout aborts its very first pipeline step without a model provider key, so
the fallback worker and every one-off reference must be given the same provider
input. That input is an operator-held file on restricted storage rather than a
tracked value, which makes its shape part of the deployment contract:

* exactly two variables, both required — a wider file is usually an accidental copy
  of the repository `.env`, and a service-level `env_file` injects every line of it
  into the container;
* an absolute path resolved outside the repository, so it can never be captured by a
  build context or committed;
* owner-only permissions on POSIX hosts, because the file is a live credential.

As with `stage1_local_preflight`, a rejection names the variable and the broken
contract and never contains the value; nothing here returns parsed values either, so
a caller cannot print them by accident.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

from thoth_control_plane.operations.stage1_local_preflight import Stage1PreflightError

PROVIDER_KEY_VARIABLE = "THOTH_NOVITA_API_KEY"
PROVIDER_OCR_MODEL_VARIABLE = "THOTH_SUBTITLE_OCR_MODEL"
REQUIRED_PROVIDER_VARIABLES = (PROVIDER_KEY_VARIABLE, PROVIDER_OCR_MODEL_VARIABLE)

MINIMUM_KEY_LENGTH = 12
PLACEHOLDER_MARKERS = ("replace-with", "changeme", "change-me", "your-", "example", "todo", "<")
OCR_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*")


def check_stage1_provider_file(path: Path, *, repository_root: Path) -> None:
    """Raise Stage1PreflightError with safe diagnostics for invalid provider input."""
    resolved = _check_location(path, repository_root)
    _check_permissions(resolved)
    values = _parse_provider_file(resolved)
    _check_values(values)


def _check_location(path: Path, repository_root: Path) -> Path:
    if not path.is_absolute():
        raise Stage1PreflightError(
            "the provider env file must be given as an absolute path outside the repository"
        )
    resolved = path.resolve()
    if _is_inside(resolved, repository_root):
        raise Stage1PreflightError(
            "the provider env file must resolve outside the repository worktree"
        )
    if not resolved.is_file():
        raise Stage1PreflightError("the provider env file is unreadable or not a regular file")
    return resolved


def _is_inside(candidate: Path, repository_root: Path) -> bool:
    try:
        root = repository_root.resolve()
    except OSError:  # pragma: no cover - an unreachable root cannot contain the file
        return False
    return candidate == root or root in candidate.parents


def _check_permissions(path: Path) -> None:
    if os.name != "posix":
        return
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise Stage1PreflightError(
            "the provider env file must be readable by its owner only (chmod 600)"
        )


def _parse_provider_file(path: Path) -> dict[str, str]:
    """Parse the file strictly, rejecting duplicates before insertion."""
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise Stage1PreflightError("the provider env file is unreadable") from error

    values: dict[str, str] = {}
    for line in content.splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        if "=" not in entry:
            raise Stage1PreflightError("the provider env file has a line that is not an assignment")
        name, _, value = entry.partition("=")
        name = name.strip()
        if name not in REQUIRED_PROVIDER_VARIABLES:
            raise Stage1PreflightError(
                "the provider env file contains an unrecognized variable; "
                f"it admits only {' and '.join(REQUIRED_PROVIDER_VARIABLES)}"
            )
        if name in values:
            raise Stage1PreflightError(f"{name} is defined more than once in the provider env file")
        values[name] = value.strip().strip("\"'")
    return values


def _check_values(values: dict[str, str]) -> None:
    for name in REQUIRED_PROVIDER_VARIABLES:
        if name not in values:
            raise Stage1PreflightError(f"{name} is missing from the provider env file")
        if any(character < " " or character == "\x7f" for character in values[name]):
            raise Stage1PreflightError(f"{name} must not contain control characters")

    key = values[PROVIDER_KEY_VARIABLE]
    lowered = key.lower()
    if (
        len(key) < MINIMUM_KEY_LENGTH
        or any(character.isspace() for character in key)
        or any(marker in lowered for marker in PLACEHOLDER_MARKERS)
    ):
        raise Stage1PreflightError(
            f"{PROVIDER_KEY_VARIABLE} must be a real provider key, not empty or a placeholder"
        )

    if not OCR_MODEL_PATTERN.fullmatch(values[PROVIDER_OCR_MODEL_VARIABLE]):
        raise Stage1PreflightError(
            f"{PROVIDER_OCR_MODEL_VARIABLE} must be a provider-qualified model such as "
            "vendor/model, without whitespace"
        )
