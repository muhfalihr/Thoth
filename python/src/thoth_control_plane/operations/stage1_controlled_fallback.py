"""Fail-closed inputs and append-only evidence for the `f1` controlled fallback gate.

The gate is a single, non-retryable, operator-authorized activation of the deployed
legacy fallback supervisor against one real fixture. `check_controlled_fallback_inputs`
is the preflight Compose cannot be: it runs before any container is created and
rejects a mutable image tag, a sample outside its own directory, a reused or
malformed fixture, an unsafe permission, or a gate that has already recorded a
result. Everything after preflight is append-only: `reserve_attempt` claims a
pending record before the one-shot container starts, `finalize_attempt` writes the
one terminal result exactly once, and `append_index` records it. Nothing here is
rewritten -- a correction is a new amendment row, never an edit of existing bytes.

As with the sibling preflights, no failure message and no safe result field ever
carries the fixture URL, a checksum, a path, a container ID, or raw exception text.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from thoth_control_plane.acquisition.adapters.tiktok import (
    TikTokUrlError,
    canonicalize_tiktok_post_url,
)
from thoth_control_plane.domain.models import SHA256_PATTERN
from thoth_control_plane.operations.stage1_local_preflight import (
    IMAGE_PATTERN,
    Stage1PreflightError,
)
from thoth_control_plane.operations.stage1_provider_preflight import check_stage1_provider_file

GATE_ID = "f1"
ATTEMPT_NAME = "controlled-fallback-attempt.json"
PRIVATE_INTEGRITY_NAME = "artifact-integrity.private.json"
INDEX_NAME = "controlled-fallback-record.jsonl"

_REVISION_PATTERN = re.compile(r"[0-9a-f]{40}")
_DIGEST_PATTERN = re.compile(SHA256_PATTERN)
_FIXTURE_NAME = "url.txt"


class ControlledFallbackEvidenceError(ValueError):
    """Raised when the append-only evidence contract cannot be honoured.

    The message is always drawn from a fixed, value-free set: it never
    contains a path, a digest, a URL, or the underlying exception.
    """


def check_controlled_fallback_inputs(
    image: str,
    sample: Path,
    provider: Path,
    *,
    repository_root: Path,
    data_root: Path,
    parity_root: Path,
) -> None:
    """Validate every host input of one `f1` attempt, or raise.

    Checks run in a fixed order so the first failure is deterministic: release
    identity, sample location, gate directory identity and mode, fixture
    contents and permissions, byte-distinctness from every retained parity
    fixture, tree-wide symlink containment, the shared provider contract, and
    finally absence of any prior evidence for this gate.
    """
    _check_image(image)
    resolved = _check_sample_location(sample, repository_root, data_root, parity_root)
    _check_gate_directory_name(resolved)
    _check_directory_mode(resolved)
    fixture = _check_fixture(resolved)
    _check_fixture_distinct_from_parity(fixture, parity_root)
    _check_no_symlink(resolved)
    check_stage1_provider_file(provider, repository_root=repository_root)
    _check_absent_attempt_evidence(resolved)
    _check_absent_index_row(resolved.parent)


def _check_image(image: str) -> None:
    if not IMAGE_PATTERN.fullmatch(image):
        raise Stage1PreflightError(
            "the controlled fallback image must be ghcr.io/muhfalihr/thoth pinned to "
            "a lowercase sha256 digest, the same release as the deployed worker"
        )


def _check_sample_location(
    sample: Path, repository_root: Path, data_root: Path, parity_root: Path
) -> Path:
    if not sample.is_absolute():
        raise Stage1PreflightError(
            "the controlled fallback gate directory must be given as an absolute host path"
        )
    resolved = sample.resolve()
    if not resolved.is_dir():
        raise Stage1PreflightError("the controlled fallback gate directory does not exist")
    for root, label in (
        (repository_root, "the repository"),
        (data_root, "the deployment data root"),
        (parity_root, "the parity sample root"),
    ):
        if _is_inside(resolved, root):
            raise Stage1PreflightError(
                f"the controlled fallback gate directory must resolve outside {label}"
            )
    return resolved


def _is_inside(candidate: Path, root: Path) -> bool:
    try:
        resolved_root = root.resolve()
    except OSError:  # pragma: no cover - an unreachable root cannot contain the sample
        return False
    return candidate == resolved_root or resolved_root in candidate.parents


def _check_gate_directory_name(sample: Path) -> None:
    if sample.name != GATE_ID:
        raise Stage1PreflightError(
            f"the controlled fallback gate directory must be named {GATE_ID}"
        )


def _check_directory_mode(sample: Path) -> None:
    if os.name != "posix":
        return
    if stat.S_IMODE(sample.stat().st_mode) & 0o077:
        raise Stage1PreflightError(
            "the controlled fallback gate directory must be accessible by its "
            "owner only (chmod 0700)"
        )


def _check_fixture(sample: Path) -> Path:
    fixture = sample / _FIXTURE_NAME
    if fixture.is_symlink() or not fixture.is_file():
        raise Stage1PreflightError(
            f"the controlled fallback fixture must exist as a regular file at {_FIXTURE_NAME}"
        )
    _check_fixture_mode(fixture)
    try:
        content = fixture.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise Stage1PreflightError("the controlled fallback fixture file is unreadable") from error
    if len(content.strip().splitlines()) != 1:
        raise Stage1PreflightError(
            "the controlled fallback fixture file must hold exactly one bare URL"
        )
    try:
        canonicalize_tiktok_post_url(content.strip())
    except TikTokUrlError as error:
        raise Stage1PreflightError(
            "the controlled fallback fixture must be a canonical https TikTok post URL "
            "without credentials, port, query, or fragment"
        ) from error
    return fixture


def _check_fixture_mode(fixture: Path) -> None:
    if os.name != "posix":
        return
    if stat.S_IMODE(fixture.stat().st_mode) & 0o077:
        raise Stage1PreflightError(
            "the controlled fallback fixture file must be readable by its owner only (chmod 0600)"
        )


def _check_fixture_distinct_from_parity(fixture: Path, parity_root: Path) -> None:
    """Reject byte-identity with any retained parity fixture, never its value."""
    try:
        fixture_bytes = fixture.read_bytes()
    except OSError as error:
        raise Stage1PreflightError("the controlled fallback fixture file is unreadable") from error
    for other in sorted(parity_root.glob("p*/url.txt")):
        try:
            other_bytes = other.read_bytes()
        except OSError:
            continue
        if hmac.compare_digest(fixture_bytes, other_bytes):
            raise Stage1PreflightError(
                "the controlled fallback fixture must be byte-distinct from every "
                "retained parity fixture; f1 is independent of p1-p6"
            )


def _check_no_symlink(sample: Path) -> None:
    """Refuse a symlink anywhere: the gate directory is bind-mounted read-only.

    A link inside would still resolve outside the gate directory, so it is
    rejected outright rather than followed.
    """
    for entry in sample.rglob("*"):
        if entry.is_symlink():
            raise Stage1PreflightError(
                "the controlled fallback gate directory must not contain a symlink"
            )


def _check_absent_attempt_evidence(sample: Path) -> None:
    if (sample / ATTEMPT_NAME).exists():
        raise Stage1PreflightError(
            "the controlled fallback gate directory already holds an attempt record; "
            "f1 does not retry, so use a fresh gate directory"
        )
    if (sample / PRIVATE_INTEGRITY_NAME).exists():
        raise Stage1PreflightError(
            "the controlled fallback gate directory already holds a private integrity "
            "record; f1 does not retry, so use a fresh gate directory"
        )


def _check_absent_index_row(root: Path) -> None:
    """Reject a prior sample or amendment row for this gate anywhere in the index."""
    index_path = root / INDEX_NAME
    if not index_path.is_file():
        return
    try:
        lines = index_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise Stage1PreflightError("the controlled fallback index is unreadable") from error
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as error:
            raise Stage1PreflightError(
                "the controlled fallback index contains a malformed row"
            ) from error
        if isinstance(row, dict) and row.get("gate_id") == GATE_ID:
            raise Stage1PreflightError(
                "the controlled fallback index already records an f1 attempt; a "
                "correction is a separate amendment, not a new run"
            )


class ControlledFallbackFacts(BaseModel):
    """Every postcondition `classify_attempt()` needs, gathered by the runner.

    `supervisor_exit_code` is `None` exactly when the terminal supervisor
    status could not be recovered after authorization was consumed -- the
    only path to an `inconclusive` verdict.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    supervisor_exit_code: int | None
    artifact_present: bool
    artifact_validated: bool
    temporary_target_observed: bool
    health_target_preserved: bool
    target_count_restored: bool
    cdp_healthy_after: bool
    api_healthy_after: bool
    restart_counts_unchanged: bool
    cleanup_passed: bool
    teardown_leaves_nothing: bool


class ControlledFallbackAttempt(BaseModel):
    """The one safe, finalized `f1` result. Fixed fields only, extras forbidden."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    schema_version: Literal[1] = 1
    gate_id: Literal["f1"] = GATE_ID
    status: Literal["completed"] = "completed"
    occurred_at: str
    acquisition_digest: str = Field(pattern=SHA256_PATTERN)
    acquisition_revision: str = Field(pattern=r"[0-9a-f]{40}")
    harness_revision: str = Field(pattern=r"[0-9a-f]{40}")
    supervisor_exit_code: int | None
    artifact_present: bool
    artifact_validated: bool
    temporary_target_observed: bool
    health_target_preserved: bool
    target_count_restored: bool
    cdp_healthy_after: bool
    api_healthy_after: bool
    restart_counts_unchanged: bool
    cleanup_passed: bool
    teardown_leaves_nothing: bool
    verdict: Literal["passed", "failed", "inconclusive"]


class PrivateArtifactIntegrity(BaseModel):
    """Restricted evidence: never printed, never copied into a safe record."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    report_checksum: str = Field(pattern=SHA256_PATTERN)
    media_checksum: str = Field(pattern=SHA256_PATTERN)
    media_bytes: int = Field(ge=0)


def classify_attempt(
    facts: ControlledFallbackFacts,
) -> Literal["passed", "failed", "inconclusive"]:
    """Classify one attempt by fixed precedence.

    Cleanup/teardown failure, then health-page/restart drift, then artifact
    failure, each outrank the supervisor's own exit status. Only once all of
    those hold does an unrecovered terminal status yield `inconclusive`
    instead of `passed` -- it never grants activation credit.
    """
    if not facts.cleanup_passed or not facts.teardown_leaves_nothing:
        return "failed"
    if not (
        facts.health_target_preserved
        and facts.target_count_restored
        and facts.cdp_healthy_after
        and facts.api_healthy_after
        and facts.restart_counts_unchanged
    ):
        return "failed"
    if not (facts.artifact_present and facts.artifact_validated):
        return "failed"
    if facts.supervisor_exit_code is None:
        return "inconclusive"
    if facts.supervisor_exit_code != 0:
        return "failed"
    return "passed"


def _write_exclusive(path: Path, data: bytes) -> None:
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise ControlledFallbackEvidenceError(
            "controlled fallback evidence already exists at this path"
        ) from error
    try:
        os.write(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _format_timestamp(occurred_at: datetime) -> str:
    return occurred_at.astimezone(UTC).isoformat().replace("+00:00", "Z")


def reserve_attempt(
    sample: Path,
    *,
    digest: str,
    acquisition_revision: str,
    harness_revision: str,
    occurred_at: datetime,
) -> None:
    """Atomically reserve one pending attempt record.

    Exclusive creation is the entire guard: a stale pending record from a
    prior run blocks a new one rather than being silently overwritten.
    """
    if not _DIGEST_PATTERN.fullmatch(digest):
        raise ControlledFallbackEvidenceError(
            "controlled fallback digest must be a pinned sha256 image reference"
        )
    for label, revision in (
        ("acquisition", acquisition_revision),
        ("harness", harness_revision),
    ):
        if not _REVISION_PATTERN.fullmatch(revision):
            raise ControlledFallbackEvidenceError(
                f"controlled fallback {label} revision must be a full lowercase commit hash"
            )
    payload = {
        "schema_version": 1,
        "gate_id": GATE_ID,
        "status": "pending",
        "occurred_at": _format_timestamp(occurred_at),
        "acquisition_digest": digest,
        "acquisition_revision": acquisition_revision,
        "harness_revision": harness_revision,
    }
    _write_exclusive(sample / ATTEMPT_NAME, json.dumps(payload).encode("utf-8"))


def _read_pending_attempt(sample: Path) -> dict[str, str]:
    path = sample / ATTEMPT_NAME
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ControlledFallbackEvidenceError(
            "controlled fallback attempt was not reserved before finalization"
        ) from error
    if not isinstance(payload, dict) or payload.get("status") != "pending":
        raise ControlledFallbackEvidenceError(
            "controlled fallback attempt is not a pending reservation"
        )
    return payload


def _write_replace(path: Path, data: bytes) -> None:
    """Write-to-temporary-file, fsync, then atomic replace onto `path`."""
    partial = path.with_name(path.name + ".part")
    try:
        with open(partial, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(partial, 0o600)
        os.replace(partial, path)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def finalize_attempt(
    sample: Path,
    facts: ControlledFallbackFacts,
    integrity: PrivateArtifactIntegrity,
) -> ControlledFallbackAttempt:
    """Finalize one reserved attempt exactly once.

    The private integrity record is written first, by exclusive creation, so
    it can never silently overwrite a prior one; the safe attempt record is
    then replaced atomically over its own pending reservation.
    """
    pending = _read_pending_attempt(sample)
    attempt = ControlledFallbackAttempt(
        occurred_at=pending["occurred_at"],
        acquisition_digest=pending["acquisition_digest"],
        acquisition_revision=pending["acquisition_revision"],
        harness_revision=pending["harness_revision"],
        supervisor_exit_code=facts.supervisor_exit_code,
        artifact_present=facts.artifact_present,
        artifact_validated=facts.artifact_validated,
        temporary_target_observed=facts.temporary_target_observed,
        health_target_preserved=facts.health_target_preserved,
        target_count_restored=facts.target_count_restored,
        cdp_healthy_after=facts.cdp_healthy_after,
        api_healthy_after=facts.api_healthy_after,
        restart_counts_unchanged=facts.restart_counts_unchanged,
        cleanup_passed=facts.cleanup_passed,
        teardown_leaves_nothing=facts.teardown_leaves_nothing,
        verdict=classify_attempt(facts),
    )
    _write_exclusive(sample / PRIVATE_INTEGRITY_NAME, integrity.model_dump_json().encode("utf-8"))
    _write_replace(sample / ATTEMPT_NAME, attempt.model_dump_json().encode("utf-8"))
    return attempt


def append_index(root: Path, attempt: ControlledFallbackAttempt) -> None:
    """Append one immutable index row. Existing bytes are never rewritten."""
    line = (attempt.model_dump_json() + "\n").encode("utf-8")
    descriptor = os.open(root / INDEX_NAME, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, line)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
