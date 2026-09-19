"""Tests for the short-lived, asset-scoped preview capability and path resolver."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from thoth_control_plane.infrastructure.editor_preview import (
    EditorPreviewSigner,
    PreviewArtifactInvalid,
    PreviewCapabilityExpired,
    PreviewCapabilityInvalid,
    resolve_preview_path,
)

NOW = datetime(2026, 9, 19, 12, 0, 0, tzinfo=UTC)
TTL = timedelta(seconds=300)
SCOPE = {"project_id": "project_001", "asset_id": "asset_001"}


@pytest.fixture
def signer() -> EditorPreviewSigner:
    return EditorPreviewSigner(key="unit-test-signing-key", ttl_seconds=int(TTL.total_seconds()))


def test_preview_capability_is_scoped_and_expires(signer: EditorPreviewSigner) -> None:
    capability = signer.issue(**SCOPE, now=NOW)

    assert capability.expires_at == NOW + TTL
    assert signer.verify(capability.token, **SCOPE, now=NOW)
    with pytest.raises(PreviewCapabilityInvalid):
        signer.verify(capability.token, **{**SCOPE, "asset_id": "asset_002"}, now=NOW)
    with pytest.raises(PreviewCapabilityExpired):
        signer.verify(capability.token, **SCOPE, now=NOW + TTL + timedelta(seconds=1))


def test_preview_capability_binds_the_project_and_the_asset(
    signer: EditorPreviewSigner,
) -> None:
    token = signer.issue(**SCOPE, now=NOW).token

    for wrong in ({"project_id": "project_999"}, {"asset_id": "asset_999"}):
        with pytest.raises(PreviewCapabilityInvalid):
            signer.verify(token, **{**SCOPE, **wrong}, now=NOW)


def test_preview_capability_signs_only_the_scope_it_enforces(
    signer: EditorPreviewSigner,
) -> None:
    payload = signer.issue(**SCOPE, now=NOW).token.split(".")[0]

    claims = json.loads(base64.urlsafe_b64decode(payload + "=="))

    # An actor claim nothing verifies would misstate the boundary this token draws.
    assert set(claims) == {"v", "prj", "ast", "iat", "exp"}


def test_preview_capability_returns_the_verified_scope(signer: EditorPreviewSigner) -> None:
    token = signer.issue(**SCOPE, now=NOW).token

    claims = signer.verify(token, project_id="project_001", asset_id="asset_001", now=NOW)

    assert (claims.project_id, claims.asset_id) == ("project_001", "asset_001")
    assert claims.expires_at == NOW + TTL
    assert not hasattr(claims, "actor_id")


def test_preview_capability_rejects_a_foreign_signing_key(signer: EditorPreviewSigner) -> None:
    token = signer.issue(**SCOPE, now=NOW).token
    forged = EditorPreviewSigner(key="another-key", ttl_seconds=int(TTL.total_seconds()))

    with pytest.raises(PreviewCapabilityInvalid):
        forged.verify(token, **SCOPE, now=NOW)


def test_preview_capability_rejects_a_tampered_payload(signer: EditorPreviewSigner) -> None:
    payload, signature = signer.issue(**SCOPE, now=NOW).token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
    claims["ast"] = "asset_002"
    tampered = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")

    with pytest.raises(PreviewCapabilityInvalid):
        signer.verify(f"{tampered}.{signature}", **SCOPE, now=NOW)


@pytest.mark.parametrize(
    "token",
    [
        "",
        "no-separator",
        "a.b.c",
        "!!!.###",
        "eyJub3QiOiAianNvbiJ9",
        base64.urlsafe_b64encode(b"not json").decode() + ".sig",
    ],
)
def test_preview_capability_rejects_malformed_material(
    signer: EditorPreviewSigner, token: str
) -> None:
    with pytest.raises(PreviewCapabilityInvalid):
        signer.verify(token, **SCOPE, now=NOW)


def test_preview_capability_rejects_a_token_issued_beyond_the_allowed_skew(
    signer: EditorPreviewSigner,
) -> None:
    future = signer.issue(**SCOPE, now=NOW + timedelta(hours=1))

    with pytest.raises(PreviewCapabilityInvalid):
        signer.verify(future.token, **SCOPE, now=NOW)


def test_preview_capability_failures_never_carry_the_token(signer: EditorPreviewSigner) -> None:
    token = signer.issue(**SCOPE, now=NOW).token

    with pytest.raises(PreviewCapabilityExpired) as expired:
        signer.verify(token, **SCOPE, now=NOW + timedelta(days=1))
    with pytest.raises(PreviewCapabilityInvalid) as invalid:
        signer.verify(token, **{**SCOPE, "asset_id": "asset_002"}, now=NOW)

    for error in (expired, invalid):
        assert token not in f"{error.value!r} {error.value}"
        assert "unit-test-signing-key" not in f"{error.value!r} {error.value}"


def test_preview_signer_refuses_an_empty_signing_key() -> None:
    with pytest.raises(ValueError):
        EditorPreviewSigner(key="   ", ttl_seconds=300)


def test_resolve_preview_path_returns_a_file_inside_the_artifact_root(tmp_path: Path) -> None:
    media = tmp_path / "project_001"
    media.mkdir()
    (media / "asset_001.mp4").write_bytes(b"0123456789")

    resolved = resolve_preview_path(tmp_path, "project_001/asset_001.mp4")

    assert resolved.read_bytes() == b"0123456789"
    assert resolved.parent == media


@pytest.mark.parametrize(
    "location",
    [
        "../secret.mp4",
        "project_001/../../secret.mp4",
        "/etc/passwd",
        "C:/Windows/system32/config",
        "\\\\server\\share\\clip.mp4",
        "https://example.test/clip.mp4",
        "project_001/asset_001.mp4?token=abc",
        "",
    ],
)
def test_resolve_preview_path_refuses_a_locator_outside_the_artifact_root(
    tmp_path: Path, location: str
) -> None:
    with pytest.raises(PreviewArtifactInvalid):
        resolve_preview_path(tmp_path, location)


def test_resolve_preview_path_refuses_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(PreviewArtifactInvalid):
        resolve_preview_path(tmp_path, "project_001/absent.mp4")


def test_resolve_preview_path_failures_never_carry_the_resolved_path(tmp_path: Path) -> None:
    with pytest.raises(PreviewArtifactInvalid) as error:
        resolve_preview_path(tmp_path, "project_001/absent.mp4")

    assert str(tmp_path) not in f"{error.value!r} {error.value}"
    assert "absent.mp4" not in f"{error.value!r} {error.value}"
