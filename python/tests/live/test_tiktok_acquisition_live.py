"""Explicit, public-fixture-only TikTok acquisition smoke tests.

These tests are skipped unless the caller deliberately supplies an approved
public TikTok post URL through ``THOTH_LIVE_TIKTOK_URL``. They never print or
persist that environment value directly.

The parity test additionally requires a *first-party* post: legacy Scout
investigates provenance, so it rejects a repost as its own main candidate and
traces it to the original creator instead. Supplying a repost URL fails the
parity test inside legacy Scout, not in the Python acquisition path.
"""

import asyncio
import json
import os
from datetime import timedelta
from pathlib import Path

import pytest

from thoth_control_plane.acquisition.browser import (
    active_scrapling_session_count,
    check_scrapling_capability,
)
from thoth_control_plane.activities.legacy_scout import LegacyScoutActivity, LegacyScoutInput
from thoth_control_plane.activities.source_investigation import (
    SourceInvestigationActivityInput,
    build_source_investigation_activity,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.operations.tiktok_parity import (
    file_checksum as _file_checksum,
)
from thoth_control_plane.operations.tiktok_parity import (
    normalize_legacy_tiktok,
    normalize_python_tiktok,
    resolve_artifact_path,
)

LIVE_URL = os.getenv("THOTH_LIVE_TIKTOK_URL")
_SCOUT_ACQUISITION_MEDIA_ROOT = (
    Path(__file__).resolve().parents[3] / "scout" / "output" / "acquisition-media"
)

_BANNED_PERSISTED_KEYS = frozenset(
    {
        "ephemeral_url",
        "cookie",
        "cookies",
        "raw_html",
        "raw_provider_body",
        "raw_provider_response",
        "provider_body",
        "provider_payload",
        "browser_trace",
        "browser_traces",
        "trace",
        "traces",
        "exception",
        "exceptions",
        "diagnostic",
        "diagnostics",
    }
)


def _artifact_path(
    artifact_root: Path, location: str, *, absolute_roots: tuple[Path, ...] = ()
) -> Path:
    """Resolve one location below its root, failing the test when it escapes.

    Containment itself lives in `resolve_artifact_path`, which the offline
    parity helper shares: this smoke and that helper must never disagree about
    what an artifact root contains.
    """
    resolved_path = resolve_artifact_path(artifact_root, location, absolute_roots=absolute_roots)
    assert resolved_path is not None
    return resolved_path


def _persisted_keys(value: object) -> set[str]:
    """Collect JSON object keys so report redaction is checked structurally."""
    if isinstance(value, dict):
        return set(value) | set().union(*(_persisted_keys(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(_persisted_keys(item) for item in value)) if value else set()
    return set()


def _persisted_strings(value: object) -> set[str]:
    """Collect report strings without relying on JSON's platform-specific escaping."""
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return set().union(*(_persisted_strings(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(_persisted_strings(item) for item in value)) if value else set()
    return set()


def _live_activity(tmp_path: Path, capability: object):
    return build_source_investigation_activity(
        Settings(
            THOTH_CONTROL_PLANE_API_KEY="live-local-only",
            THOTH_CONTROL_PLANE_ARTIFACT_ROOT=tmp_path,
            THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE="python",
        ),
        capability=capability,
    )


@pytest.mark.live
@pytest.mark.asyncio
@pytest.mark.skipif(not LIVE_URL, reason="THOTH_LIVE_TIKTOK_URL is not configured")
async def test_public_tiktok_post_produces_safe_local_report(tmp_path: Path) -> None:
    url = LIVE_URL
    assert url is not None
    capability = await check_scrapling_capability()
    assert capability.available is True
    activity = _live_activity(tmp_path, capability)
    result = await activity(
        SourceInvestigationActivityInput(
            workflow_id="wf_live_tiktok_001",
            request_snapshot_id="req_live_tiktok_001",
            canonical_source_url=url,
        )
    )
    assert result.report is not None
    assert not Path(result.report.location).is_absolute()
    report_path = _artifact_path(tmp_path, result.report.location)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["outcome"]["attempts"][0]["strategy"] == "scrapling_headless"
    media = report["media"][0]
    assert not Path(media["location"]).is_absolute()
    media_path = _artifact_path(tmp_path, media["location"])
    assert media["media_type"] == "video/mp4"
    assert media_path.is_file()
    assert media_path.stat().st_size >= 10_000
    assert media_path.stat().st_size == media["bytes"]
    with media_path.open("rb") as handle:
        assert handle.read(12)[4:8] == b"ftyp"
    assert _file_checksum(media_path) == media["checksum"]
    assert not (_persisted_keys(report) & _BANNED_PERSISTED_KEYS)
    resolved_artifact_root = str(tmp_path.resolve()).lower()
    assert not any(resolved_artifact_root in value.lower() for value in _persisted_strings(report))
    assert report["source"]["canonical_url"] in _persisted_strings(report)
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.live
@pytest.mark.asyncio
@pytest.mark.skipif(not LIVE_URL, reason="THOTH_LIVE_TIKTOK_URL is not configured")
async def test_live_cancellation_closes_owned_browser_and_partial_files(tmp_path: Path) -> None:
    url = LIVE_URL
    assert url is not None
    capability = await check_scrapling_capability()
    assert capability.available is True
    activity = _live_activity(tmp_path, capability)
    task = asyncio.create_task(
        activity(
            SourceInvestigationActivityInput(
                workflow_id="wf_live_tiktok_cancel_001",
                request_snapshot_id="req_live_tiktok_cancel_001",
                canonical_source_url=url,
            )
        )
    )
    for _ in range(200):
        if active_scrapling_session_count() == 1:
            break
        await asyncio.sleep(0.025)
    assert active_scrapling_session_count() == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert active_scrapling_session_count() == 0
    assert list(tmp_path.rglob("*.part")) == []


@pytest.mark.live
@pytest.mark.asyncio
@pytest.mark.skipif(not LIVE_URL, reason="THOTH_LIVE_TIKTOK_URL is not configured")
async def test_live_python_and_legacy_tiktok_contracts_match(tmp_path: Path) -> None:
    url = LIVE_URL
    assert url is not None
    capability = await check_scrapling_capability()
    assert capability.available is True
    activity = _live_activity(tmp_path, capability)
    python_result = await activity(
        SourceInvestigationActivityInput(
            workflow_id="wf_live_tiktok_parity_001",
            request_snapshot_id="req_live_tiktok_parity_001",
            canonical_source_url=url,
        )
    )
    assert python_result.report is not None
    python_payload = json.loads(
        _artifact_path(tmp_path, python_result.report.location).read_text(encoding="utf-8")
    )

    legacy_root = tmp_path / "legacy"
    legacy_result = await LegacyScoutActivity(artifact_root=legacy_root).inspect(
        LegacyScoutInput(
            workflow_id="wf_live_tiktok_legacy_001",
            canonical_source_url=url,
            output_package_id="pkg_live_tiktok_legacy_001",
            timeout=timedelta(minutes=5),
            cancellation_token="can_live_tiktok_legacy_001",
        )
    )
    assert legacy_result.report is not None
    assert not Path(legacy_result.report.location).is_absolute()
    legacy_payload = json.loads(
        _artifact_path(legacy_root, legacy_result.report.location).read_text(encoding="utf-8")
    )

    assert normalize_python_tiktok(python_payload, tmp_path) == normalize_legacy_tiktok(
        legacy_payload, url, legacy_root, absolute_roots=(_SCOUT_ACQUISITION_MEDIA_ROOT,)
    )
