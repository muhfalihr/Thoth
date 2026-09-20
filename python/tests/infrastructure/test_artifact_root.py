"""Filesystem containment tests for the one E1 artifact path authority."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from thoth_control_plane.application.render_job_ports import (
    ArtifactPathInvalid,
    ArtifactUnavailable,
)
from thoth_control_plane.domain.render_jobs import RenderOutputFacts
from thoth_control_plane.infrastructure.artifact_root import LocalArtifactRoot

JOB = "rj_1"
OTHER_JOB = "rj_2"
UNSAFE_IDS = [
    "../job",
    "..",
    "/tmp/job",
    "C:\\job",
    "file:x",
    "job/../../escape",
    "job\\nested",
    "job id",
    "",
    "_leading",
    "a" * 129,
]


def checksum_of(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def facts(payload: bytes, **overrides: object) -> RenderOutputFacts:
    values: dict[str, object] = {
        "media_type": "video/mp4",
        "size_bytes": len(payload),
        "checksum": checksum_of(payload),
        "codec": "h264",
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
        "duration_seconds": 20.0,
        "has_audio": True,
    }
    values.update(overrides)
    return RenderOutputFacts.model_validate(values)


def source_file(tmp_path: Path, payload: bytes, name: str = "source.mp4") -> Path:
    path = tmp_path / "outside" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def temporary_output(root: LocalArtifactRoot, base: Path, payload: bytes) -> None:
    root.prepare(JOB)
    (base / "temp" / JOB / "output.mp4").write_bytes(payload)


# --- identity containment -------------------------------------------------


@pytest.mark.parametrize("unsafe", UNSAFE_IDS)
def test_job_identity_never_escapes_root(tmp_path: Path, unsafe: str) -> None:
    with pytest.raises(ArtifactPathInvalid):
        LocalArtifactRoot(tmp_path).prepare(unsafe)


@pytest.mark.parametrize("unsafe", UNSAFE_IDS)
def test_every_entry_point_validates_job_identity(tmp_path: Path, unsafe: str) -> None:
    root = LocalArtifactRoot(tmp_path)
    expected = facts(b"payload")
    with pytest.raises(ArtifactPathInvalid):
        root.verify_temporary_output(unsafe, expected)
    with pytest.raises(ArtifactPathInvalid):
        root.publish(unsafe, expected, b"{}", b"{}")
    with pytest.raises(ArtifactPathInvalid):
        root.resolve_download(unsafe, "renders/rj_1/output.mp4")
    with pytest.raises(ArtifactPathInvalid):
        root.cleanup(unsafe)


def test_prepare_creates_only_this_job_workspace_and_exposes_relative_names(
    tmp_path: Path,
) -> None:
    workspace = LocalArtifactRoot(tmp_path).prepare(JOB)

    assert workspace.render_job_id == JOB
    assert workspace.bundle_name == "bundle.json"
    assert workspace.assets_name == "assets"
    assert str(tmp_path) not in repr(workspace)
    assert (tmp_path / "work" / JOB / "assets").is_dir()
    assert (tmp_path / "temp" / JOB).is_dir()
    assert not (tmp_path / "work" / OTHER_JOB).exists()


def test_prepare_is_idempotent(tmp_path: Path) -> None:
    root = LocalArtifactRoot(tmp_path)
    root.prepare(JOB)
    (tmp_path / "work" / JOB / "assets" / "kept").write_bytes(b"x")

    root.prepare(JOB)

    assert (tmp_path / "work" / JOB / "assets" / "kept").exists()


# --- asset staging --------------------------------------------------------


def test_stage_asset_copies_bytes_into_the_job_workspace(tmp_path: Path) -> None:
    payload = b"asset-bytes"
    root = LocalArtifactRoot(tmp_path)
    workspace = root.prepare(JOB)
    source = source_file(tmp_path, payload)

    staged = root.stage_asset(
        workspace,
        asset_id="asset_main",
        source=source,
        expected_checksum=checksum_of(payload),
        max_bytes=1024,
    )

    copied = tmp_path / "work" / JOB / staged.relative_name
    assert staged.relative_name.startswith("assets/")
    assert staged.size_bytes == len(payload)
    assert copied.read_bytes() == payload
    assert copied.stat().st_nlink == 1
    assert copied.stat().st_ino != source.stat().st_ino or copied.stat().st_dev != (
        source.stat().st_dev
    )


def test_staged_asset_is_a_copy_that_outlives_its_source(tmp_path: Path) -> None:
    payload = b"asset-bytes"
    root = LocalArtifactRoot(tmp_path)
    workspace = root.prepare(JOB)
    source = source_file(tmp_path, payload)

    staged = root.stage_asset(
        workspace,
        asset_id="asset_main",
        source=source,
        expected_checksum=checksum_of(payload),
        max_bytes=1024,
    )
    source.write_bytes(b"mutated-after-staging")

    assert (tmp_path / "work" / JOB / staged.relative_name).read_bytes() == payload


def test_stage_asset_rejects_a_checksum_that_does_not_match_the_record(
    tmp_path: Path,
) -> None:
    root = LocalArtifactRoot(tmp_path)
    workspace = root.prepare(JOB)
    source = source_file(tmp_path, b"asset-bytes")

    with pytest.raises(ArtifactUnavailable):
        root.stage_asset(
            workspace,
            asset_id="asset_main",
            source=source,
            expected_checksum=checksum_of(b"different"),
            max_bytes=1024,
        )
    assert list((tmp_path / "work" / JOB / "assets").iterdir()) == []


def test_stage_asset_refuses_a_source_larger_than_the_bound(tmp_path: Path) -> None:
    payload = b"a" * 64
    root = LocalArtifactRoot(tmp_path)
    workspace = root.prepare(JOB)
    source = source_file(tmp_path, payload)

    with pytest.raises(ArtifactUnavailable):
        root.stage_asset(
            workspace,
            asset_id="asset_main",
            source=source,
            expected_checksum=checksum_of(payload),
            max_bytes=16,
        )
    assert list((tmp_path / "work" / JOB / "assets").iterdir()) == []


def test_stage_asset_refuses_a_non_regular_source(tmp_path: Path) -> None:
    root = LocalArtifactRoot(tmp_path)
    workspace = root.prepare(JOB)
    directory = tmp_path / "outside" / "directory"
    directory.mkdir(parents=True)

    with pytest.raises(ArtifactUnavailable):
        root.stage_asset(
            workspace,
            asset_id="asset_main",
            source=directory,
            expected_checksum=checksum_of(b""),
            max_bytes=1024,
        )


@pytest.mark.parametrize("unsafe", UNSAFE_IDS)
def test_stage_asset_validates_the_asset_identity(tmp_path: Path, unsafe: str) -> None:
    root = LocalArtifactRoot(tmp_path)
    workspace = root.prepare(JOB)
    source = source_file(tmp_path, b"asset-bytes")

    with pytest.raises(ArtifactPathInvalid):
        root.stage_asset(
            workspace,
            asset_id=unsafe,
            source=source,
            expected_checksum=checksum_of(b"asset-bytes"),
            max_bytes=1024,
        )


def test_write_bundle_returns_only_a_relative_name(tmp_path: Path) -> None:
    root = LocalArtifactRoot(tmp_path)
    workspace = root.prepare(JOB)

    name = root.write_bundle(workspace, json.dumps({"version": 1}).encode("utf-8"))

    assert name == "bundle.json"
    assert json.loads((tmp_path / "work" / JOB / "bundle.json").read_text("utf-8")) == {
        "version": 1
    }


# --- verification and publication ----------------------------------------


def test_verify_temporary_output_accepts_only_the_exact_validated_file(
    tmp_path: Path,
) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)

    verified = root.verify_temporary_output(JOB, facts(payload))

    assert verified.read_bytes() == payload
    assert verified.is_relative_to(tmp_path)


@pytest.mark.parametrize(
    "overrides",
    [{"size_bytes": 9_999}, {"checksum": "sha256:" + "f" * 64}],
)
def test_verify_temporary_output_rejects_a_file_that_is_not_what_was_reported(
    tmp_path: Path, overrides: dict[str, object]
) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)

    with pytest.raises(ArtifactUnavailable):
        root.verify_temporary_output(JOB, facts(payload, **overrides))


def test_verify_temporary_output_rejects_a_missing_render(tmp_path: Path) -> None:
    root = LocalArtifactRoot(tmp_path)
    root.prepare(JOB)

    with pytest.raises(ArtifactUnavailable):
        root.verify_temporary_output(JOB, facts(b"rendered-bytes"))


def test_publish_moves_the_verified_render_and_retains_bounded_records(
    tmp_path: Path,
) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)

    published = root.publish(
        JOB,
        facts(payload),
        json.dumps({"render_job_id": JOB}).encode("utf-8"),
        json.dumps({"stage": "finalizing"}).encode("utf-8"),
    )

    assert published.relative_path == f"renders/{JOB}/output.mp4"
    assert published.size_bytes == len(payload)
    assert (tmp_path / published.relative_path).read_bytes() == payload
    assert (tmp_path / "renders" / JOB / "metadata.json").exists()
    assert (tmp_path / "renders" / JOB / "diagnostics.json").exists()
    assert not (tmp_path / "temp" / JOB / "output.mp4").exists()


def test_publish_refuses_an_unvalidated_render_and_leaves_nothing_behind(
    tmp_path: Path,
) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)

    with pytest.raises(ArtifactUnavailable):
        root.publish(JOB, facts(payload, size_bytes=1), b"{}", b"{}")

    assert not (tmp_path / "renders" / JOB / "output.mp4").exists()


# --- download and cleanup -------------------------------------------------


def test_resolve_download_returns_the_published_regular_file(tmp_path: Path) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)
    published = root.publish(JOB, facts(payload), b"{}", b"{}")

    resolved = root.resolve_download(JOB, published.relative_path)

    assert resolved.read_bytes() == payload


@pytest.mark.parametrize(
    "relative",
    [
        "renders/rj_2/output.mp4",
        "renders/rj_1/../rj_2/output.mp4",
        "../renders/rj_1/output.mp4",
        "/etc/passwd",
        "C:\\Windows\\System32\\config\\SAM",
        "renders\\rj_1\\output.mp4",
        "work/rj_1/bundle.json",
        "renders/rj_1/metadata.json",
    ],
)
def test_resolve_download_only_serves_this_job_published_render(
    tmp_path: Path, relative: str
) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)
    root.publish(JOB, facts(payload), b"{}", b"{}")

    with pytest.raises(ArtifactPathInvalid):
        root.resolve_download(JOB, relative)


def test_resolve_download_reports_a_removed_render_as_unavailable(tmp_path: Path) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)
    published = root.publish(JOB, facts(payload), b"{}", b"{}")
    root.cleanup(JOB)

    with pytest.raises(ArtifactUnavailable):
        root.resolve_download(JOB, published.relative_path)


def test_cleanup_removes_only_this_job_files_and_keeps_safe_records(tmp_path: Path) -> None:
    payload = b"rendered-bytes"
    root = LocalArtifactRoot(tmp_path)
    temporary_output(root, tmp_path, payload)
    root.stage_asset(
        root.prepare(JOB),
        asset_id="asset_main",
        source=source_file(tmp_path, payload),
        expected_checksum=checksum_of(payload),
        max_bytes=1024,
    )
    root.publish(JOB, facts(payload), b'{"render_job_id": "rj_1"}', b'{"stage": "finalizing"}')
    other = root.prepare(OTHER_JOB)
    root.write_bundle(other, b"{}")

    root.cleanup(JOB)

    assert not (tmp_path / "renders" / JOB / "output.mp4").exists()
    assert not (tmp_path / "work" / JOB).exists()
    assert not (tmp_path / "temp" / JOB).exists()
    assert (tmp_path / "renders" / JOB / "metadata.json").exists()
    assert (tmp_path / "renders" / JOB / "diagnostics.json").exists()
    assert (tmp_path / "work" / OTHER_JOB / "bundle.json").exists()


def test_cleanup_is_idempotent(tmp_path: Path) -> None:
    root = LocalArtifactRoot(tmp_path)

    root.cleanup(JOB)
    root.cleanup(JOB)

    assert not (tmp_path / "renders" / JOB).exists()


def test_a_linked_job_directory_is_never_followed(tmp_path: Path) -> None:
    outside = tmp_path / "outside" / "elsewhere"
    outside.mkdir(parents=True)
    root = LocalArtifactRoot(tmp_path)
    (tmp_path / "renders").mkdir()
    try:
        (tmp_path / "renders" / JOB).symlink_to(outside, target_is_directory=True)
    except OSError:  # pragma: no cover - unprivileged Windows session
        pytest.skip("this session cannot create a symlink")
    (outside / "output.mp4").write_bytes(b"planted")

    with pytest.raises(ArtifactPathInvalid):
        root.resolve_download(JOB, f"renders/{JOB}/output.mp4")
    with pytest.raises(ArtifactPathInvalid):
        root.cleanup(JOB)
    assert (outside / "output.mp4").exists()


def test_resolve_source_finds_a_stored_asset_below_the_root(tmp_path: Path) -> None:
    stored = tmp_path / "project_001" / "assets"
    stored.mkdir(parents=True)
    (stored / "asset_main.mp4").write_bytes(b"media")

    resolved = LocalArtifactRoot(tmp_path).resolve_source("project_001/assets/asset_main.mp4")

    assert resolved.read_bytes() == b"media"
    assert resolved.resolve().is_relative_to(tmp_path.resolve())


@pytest.mark.parametrize(
    "locator",
    [
        "../outside.mp4",
        "project_001/../../outside.mp4",
        "/etc/passwd",
        "C:\\Windows\\win.ini",
        "project_001\\asset.mp4",
        "http://example.test/a.mp4",
        "project_001//asset.mp4",
        "project_001/.hidden/asset.mp4",
        "",
        "a" * 513,
    ],
)
def test_resolve_source_refuses_anything_that_is_not_a_contained_locator(
    tmp_path: Path, locator: str
) -> None:
    with pytest.raises(ArtifactPathInvalid):
        LocalArtifactRoot(tmp_path).resolve_source(locator)


def test_resolve_source_reports_a_missing_asset_without_a_path(tmp_path: Path) -> None:
    with pytest.raises(ArtifactUnavailable, match=r"^render artifact unavailable$"):
        LocalArtifactRoot(tmp_path).resolve_source("project_001/asset_main.mp4")


def test_resolve_source_refuses_a_directory(tmp_path: Path) -> None:
    (tmp_path / "project_001").mkdir()

    with pytest.raises(ArtifactUnavailable):
        LocalArtifactRoot(tmp_path).resolve_source("project_001")
