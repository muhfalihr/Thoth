"""Offline comparison of one designated Python/Scout TikTok parity sample.

The soak evaluator counts parity samples but cannot judge one: `parity_passed`
is an operator field with no command behind it. This module is the offline half
of that judgement. It consumes two reports that already exist -- the actual soak
workflow's `source-report.json` and a separately captured Scout reference
content-set -- validates each local artifact against its own recorded integrity
evidence, and compares the nine normalized fields that
`docs/operations/stage1-parity-sampling.md` declares authoritative.

Cross-provider byte equality is deliberately not a criterion: headless and CDN
acquisition legitimately produce different encodings of the same post. Each
checksum is therefore compared with its own recorded value, which proves
integrity, never parity.

Nothing here acquires, writes an observation, or labels a sample, and no console
line carries a URL, caption, post identity, checksum, path, payload, or raw
exception text -- only field names and booleans. Acquisition and observation
edits stay explicit operator steps.

`resolve_artifact_path`, `normalize_python_tiktok`, and `normalize_legacy_tiktok`
live here rather than in the live smoke so the reference contract has exactly one
implementation; `python/tests/live/test_tiktok_acquisition_live.py` imports them.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

from thoth_control_plane.acquisition.adapters.tiktok import (
    TikTokUrlError,
    canonicalize_tiktok_post_url,
)
from thoth_control_plane.acquisition.models import TikTokSourceReport
from thoth_control_plane.domain.models import SHA256_PATTERN

PARITY_FIELDS = (
    "canonical_url",
    "platform",
    "post_id",
    "owner_handle",
    "caption",
    "media_kind",
    "media_index",
    "local_media_present",
    "outcome",
)

# The live smoke's own media floor. Repeated here rather than imported so the
# helper keeps working when tests are absent, as they are in the runtime image.
MINIMUM_MEDIA_BYTES = 10_000

# Scout's output directory is fixed at `<scout>/output`, so a reference captured
# inside the pinned image records container paths. The operator binds a host
# directory onto this prefix and the helper rebases onto it.
DEFAULT_SCOUT_RECORDED_ROOT = "/opt/thoth/scout/output"

_CHECKSUM = re.compile(SHA256_PATTERN)


class TikTokParityEvidenceError(ValueError):
    """Raised when the paired evidence cannot be compared at all.

    Messages come from a fixed safe set: they name the failing side and check,
    never a path, a value, or the underlying exception. An artifact that is
    present but invalid is not an error -- it is a false integrity boolean, so
    the operator can still tell "invalid artifact" apart from "valid artifacts,
    mismatching contract".
    """


class _ScoutProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    username: str | None = None


class _ScoutMain(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_url: str | None = None
    platform: str | None = None
    description: str | None = None
    is_video: bool = True
    source_local: str | None = None
    profile: _ScoutProfile | None = None


class _ScoutReferenceReport(BaseModel):
    """The stable slice of the legacy content-set this comparison reads.

    Extra keys are ignored rather than rejected: the content-set carries
    footage, comments, and enrichment that are outside the agreed subset and
    are excluded rather than synthesized.
    """

    model_config = ConfigDict(extra="ignore")

    main: _ScoutMain


def resolve_artifact_path(
    artifact_root: Path,
    location: str,
    *,
    absolute_roots: tuple[Path, ...] = (),
    recorded_root: str | None = None,
) -> Path | None:
    """Resolve one recorded location below its root, or None when it escapes.

    `recorded_root` rebases a location recorded inside a container onto the host
    directory bound to it. `absolute_roots` accepts a location that already names
    a real directory on this machine. `resolve()` follows symlinks, so a link out
    of the root fails containment like any other escape. Returning None instead
    of raising keeps containment reportable as a boolean; the escaping path is
    never opened either way.
    """
    if not location:
        return None
    if recorded_root is not None:
        recorded = PurePosixPath(location)
        if recorded.is_absolute():
            if not recorded.is_relative_to(PurePosixPath(recorded_root)):
                return None
            location = str(recorded.relative_to(PurePosixPath(recorded_root)))
    path = Path(location)
    if ".." in path.parts:
        return None
    if path.is_absolute():
        resolved = path.resolve()
        if not any(resolved.is_relative_to(root.resolve()) for root in absolute_roots):
            return None
        return resolved
    resolved = (artifact_root / path).resolve()
    if not resolved.is_relative_to(artifact_root.resolve()):
        return None
    return resolved


def file_checksum(path: Path) -> str:
    """Recompute one artifact's digest in the recorded `sha256:<hex>` form."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def normalize_python_tiktok(payload: Mapping[str, Any], artifact_root: Path) -> dict[str, Any]:
    """Reduce a Python source report to the nine authoritative fields."""
    media = payload["media"][0]
    media_path = resolve_artifact_path(artifact_root, media["location"])
    return {
        "canonical_url": payload["source"]["canonical_url"],
        "platform": payload["source"]["platform"],
        "post_id": payload["post"]["post_id"],
        "owner_handle": payload["post"]["owner_handle"],
        "caption": payload["post"]["caption"],
        "media_kind": media["kind"],
        "media_index": media["index"],
        "local_media_present": media_path is not None and media_path.is_file(),
        "outcome": payload["outcome"]["status"],
    }


def normalize_legacy_tiktok(
    payload: Mapping[str, Any],
    input_url: str,
    artifact_root: Path,
    *,
    absolute_roots: tuple[Path, ...] = (),
    recorded_root: str | None = None,
) -> dict[str, Any]:
    """Reduce a legacy Scout content-set to the same nine fields."""
    main = payload["main"]
    page_url = main.get("source_url") or input_url
    identity = canonicalize_tiktok_post_url(page_url)
    profile = main.get("profile") or {}
    location = main.get("source_local")
    media_path = (
        resolve_artifact_path(
            artifact_root,
            location,
            absolute_roots=absolute_roots,
            recorded_root=recorded_root,
        )
        if isinstance(location, str)
        else None
    )
    return {
        "canonical_url": str(identity.canonical_url),
        "platform": main.get("platform"),
        "post_id": identity.post_id,
        "owner_handle": profile.get("username") or identity.owner_handle,
        "caption": main.get("description") or "",
        "media_kind": "video" if main.get("is_video", True) else "image",
        "media_index": 1,
        "local_media_present": media_path is not None and media_path.is_file(),
        "outcome": "resolved",
    }


@dataclass(frozen=True)
class ArtifactIntegrity:
    """One side's independent integrity result. Every check must hold to pass."""

    report_checksum_verified: bool
    media_contained: bool
    media_signature_valid: bool
    media_minimum_size_met: bool
    media_byte_count_verified: bool
    media_checksum_verified: bool

    @property
    def passed(self) -> bool:
        return all(asdict(self).values())


@dataclass(frozen=True)
class ParityComparison:
    """Safe result of one paired sample: booleans only, no values."""

    fields: Mapping[str, bool]
    python_artifact: ArtifactIntegrity
    scout_artifact: ArtifactIntegrity

    @property
    def artifacts_validated(self) -> bool:
        return self.python_artifact.passed and self.scout_artifact.passed

    @property
    def fields_match(self) -> bool:
        return all(self.fields.values())

    @property
    def passed(self) -> bool:
        return self.artifacts_validated and self.fields_match


def _validate_checksum_input(checksum: str) -> str:
    if not _CHECKSUM.fullmatch(checksum):
        raise TikTokParityEvidenceError("parity evidence checksum is not a sha256 digest")
    return checksum.lower()


def _read_report(path: Path) -> tuple[dict[str, Any], str]:
    """Return the parsed report and its raw text.

    The text is kept because the strict models validate in JSON mode: a report
    read back as a Python dict would reject its own serialized enums and paths.
    """
    try:
        text = path.read_text(encoding="utf-8")
        payload = json.loads(text)
    except (OSError, UnicodeError, ValueError) as error:
        raise TikTokParityEvidenceError(
            "parity evidence report is missing, unreadable, or not valid json"
        ) from error
    if not isinstance(payload, dict):
        raise TikTokParityEvidenceError(
            "parity evidence report is missing, unreadable, or not valid json"
        )
    return payload, text


def _validate_integrity(
    *,
    report_path: Path,
    expected_report_checksum: str,
    media_path: Path | None,
    expected_media_bytes: int,
    expected_media_checksum: str,
) -> ArtifactIntegrity:
    """Check one side's report and media against that side's own recorded values."""
    try:
        report_verified = file_checksum(report_path) == expected_report_checksum
        if media_path is None or not media_path.is_file():
            return ArtifactIntegrity(
                report_checksum_verified=report_verified,
                media_contained=media_path is not None,
                media_signature_valid=False,
                media_minimum_size_met=False,
                media_byte_count_verified=False,
                media_checksum_verified=False,
            )
        size = media_path.stat().st_size
        with media_path.open("rb") as handle:
            header = handle.read(12)
        return ArtifactIntegrity(
            report_checksum_verified=report_verified,
            media_contained=True,
            media_signature_valid=header[4:8] == b"ftyp",
            media_minimum_size_met=size >= MINIMUM_MEDIA_BYTES,
            media_byte_count_verified=size == expected_media_bytes,
            media_checksum_verified=file_checksum(media_path) == expected_media_checksum,
        )
    except OSError as error:
        raise TikTokParityEvidenceError("parity evidence artifact is unreadable") from error


def compare_parity_sample(
    *,
    python_report: Path,
    python_artifact_root: Path,
    python_report_checksum: str,
    scout_report: Path,
    scout_artifact_root: Path,
    scout_report_checksum: str,
    scout_media_checksum: str,
    scout_media_bytes: int,
    scout_recorded_root: str = DEFAULT_SCOUT_RECORDED_ROOT,
    input_url: str = "",
) -> ParityComparison:
    """Compare one designated sample offline and return safe booleans.

    Raises `TikTokParityEvidenceError` when the pair cannot be compared at all:
    absent, unreadable, malformed, or schema-invalid evidence is rejected rather
    than reported as a mismatch.
    """
    python_report_checksum = _validate_checksum_input(python_report_checksum)
    scout_report_checksum = _validate_checksum_input(scout_report_checksum)
    scout_media_checksum = _validate_checksum_input(scout_media_checksum)

    python_payload, python_text = _read_report(python_report)
    scout_payload, scout_text = _read_report(scout_report)
    try:
        validated_python = TikTokSourceReport.model_validate_json(python_text)
    except ValidationError as error:
        raise TikTokParityEvidenceError("python parity report failed schema validation") from error
    try:
        _ScoutReferenceReport.model_validate_json(scout_text)
    except ValidationError as error:
        raise TikTokParityEvidenceError("scout parity report failed schema validation") from error

    try:
        python_fields = normalize_python_tiktok(python_payload, python_artifact_root)
        scout_fields = normalize_legacy_tiktok(
            scout_payload,
            input_url,
            scout_artifact_root,
            recorded_root=scout_recorded_root,
        )
    except (TikTokUrlError, KeyError, IndexError, TypeError) as error:
        raise TikTokParityEvidenceError(
            "parity evidence lacks a comparable tiktok post identity"
        ) from error

    media = validated_python.media[0]
    python_integrity = _validate_integrity(
        report_path=python_report,
        expected_report_checksum=python_report_checksum,
        media_path=resolve_artifact_path(python_artifact_root, str(media.location)),
        expected_media_bytes=media.bytes,
        expected_media_checksum=media.checksum.lower(),
    )
    scout_integrity = _validate_integrity(
        report_path=scout_report,
        expected_report_checksum=scout_report_checksum,
        media_path=resolve_artifact_path(
            scout_artifact_root,
            scout_payload["main"].get("source_local") or "",
            recorded_root=scout_recorded_root,
        ),
        expected_media_bytes=scout_media_bytes,
        expected_media_checksum=scout_media_checksum,
    )
    return ParityComparison(
        fields={name: python_fields[name] == scout_fields[name] for name in PARITY_FIELDS},
        python_artifact=python_integrity,
        scout_artifact=scout_integrity,
    )


def render_parity_comparison(comparison: ParityComparison) -> list[str]:
    """Render the comparison as booleans only: no values ever reach the console."""
    lines = [
        f"python artifact {name}: {'pass' if value else 'fail'}"
        for name, value in asdict(comparison.python_artifact).items()
    ]
    lines += [
        f"scout artifact {name}: {'pass' if value else 'fail'}"
        for name, value in asdict(comparison.scout_artifact).items()
    ]
    lines += [
        f"field {name}: {'match' if comparison.fields[name] else 'mismatch'}"
        for name in PARITY_FIELDS
    ]
    lines.append(f"result: {'pass' if comparison.passed else 'fail'}")
    return lines
