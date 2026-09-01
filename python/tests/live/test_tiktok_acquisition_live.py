"""Explicit, public-fixture-only TikTok acquisition smoke tests.

These tests are skipped unless the caller deliberately supplies an approved
public TikTok post URL through ``THOTH_LIVE_TIKTOK_URL``. They never print or
persist that environment value directly.
"""

import asyncio
import hashlib
import json
import os
from datetime import timedelta
from pathlib import Path

import pytest

from thoth_control_plane.acquisition.adapters.tiktok import canonicalize_tiktok_post_url
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
    """Resolve one location below its relative root or an explicit absolute root."""
    path = Path(location)
    assert ".." not in path.parts
    if path.is_absolute():
        resolved_path = path.resolve()
        assert any(resolved_path.is_relative_to(root.resolve()) for root in absolute_roots)
    else:
        resolved_path = (artifact_root / path).resolve()
        assert resolved_path.is_relative_to(artifact_root.resolve())
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


def _file_checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def normalize_legacy_tiktok(payload: dict, input_url: str, artifact_root: Path) -> dict:
    main = payload["main"]
    page_url = main.get("source_url") or input_url
    identity = canonicalize_tiktok_post_url(page_url)
    profile = main.get("profile") or {}
    return {
        "canonical_url": str(identity.canonical_url),
        "platform": main.get("platform"),
        "post_id": identity.post_id,
        "owner_handle": profile.get("username") or identity.owner_handle,
        "caption": main.get("description") or "",
        "media_kind": "video" if main.get("is_video", True) else "image",
        "media_index": 1,
        "local_media_present": isinstance(main.get("source_local"), str)
        and _artifact_path(
            artifact_root,
            main["source_local"],
            absolute_roots=(_SCOUT_ACQUISITION_MEDIA_ROOT,),
        ).is_file(),
        "outcome": "resolved",
    }


def normalize_python_tiktok(payload: dict, artifact_root: Path) -> dict:
    media = payload["media"][0]
    return {
        "canonical_url": payload["source"]["canonical_url"],
        "platform": payload["source"]["platform"],
        "post_id": payload["post"]["post_id"],
        "owner_handle": payload["post"]["owner_handle"],
        "caption": payload["post"]["caption"],
        "media_kind": media["kind"],
        "media_index": media["index"],
        "local_media_present": _artifact_path(artifact_root, media["location"]).is_file(),
        "outcome": payload["outcome"]["status"],
    }


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
        legacy_payload, url, legacy_root
    )
