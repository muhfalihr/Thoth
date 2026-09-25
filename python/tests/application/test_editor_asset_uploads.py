"""Registering one explicitly uploaded media file as a ready, project-scoped asset."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from thoth_control_plane.application.editor_asset_ports import (
    EditorAssetMediaInvalid,
    EditorAssetUploadTooLarge,
)
from thoth_control_plane.application.editor_asset_uploads import (
    EditorAssetUploadService,
    described_asset,
)
from thoth_control_plane.application.editor_assets import EditorAssetsUnavailable
from thoth_control_plane.domain.editor_assets import EditorAssetRecord
from thoth_control_plane.infrastructure.artifact_root import LocalArtifactRoot

# Small synthetic payloads: a real signature, then filler. Nothing here is operator media.
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 24
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 16

IMAGE_REPORT = {"streams": [{"codec_type": "video", "width": 64, "height": 32}], "format": {}}
VIDEO_REPORT = {
    "streams": [
        {"codec_type": "video", "width": 1080, "height": 1920, "avg_frame_rate": "30000/1001"},
        {"codec_type": "audio"},
    ],
    "format": {"duration": "2.000000"},
}
AUDIO_REPORT = {"streams": [{"codec_type": "audio"}], "format": {"duration": "1.5"}}


class MemoryRepository:
    def __init__(self, *, fail: bool = False) -> None:
        self.records: list[EditorAssetRecord] = []
        self.fail = fail

    async def register_ready(self, record: EditorAssetRecord) -> None:
        if self.fail:
            raise RuntimeError("postgresql://secret@db")
        self.records.append(record)


async def chunks_of(payload: bytes):
    yield payload[:5]
    yield payload[5:]


def canned(report: dict[str, Any] | Exception):
    async def probe(path: Path) -> dict[str, Any]:
        assert path.is_file()
        if isinstance(report, Exception):
            raise report
        return report

    return probe


def leftovers(root: Path) -> list[str]:
    return sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())


def service(
    root: Path,
    report: dict[str, Any] | Exception,
    repository: MemoryRepository | None = None,
    *,
    max_bytes: int = 1024,
) -> EditorAssetUploadService:
    return EditorAssetUploadService(
        repository if repository is not None else MemoryRepository(),
        LocalArtifactRoot(root),
        canned(report),
        max_bytes=max_bytes,
    )


@pytest.mark.parametrize(
    ("media_type", "payload", "report", "expected"),
    [
        (
            "image/png",
            PNG,
            IMAGE_REPORT,
            {
                "kind": "image",
                "width": 64,
                "height": 32,
                "fps": None,
                "duration_in_frames": None,
                "has_audio": False,
            },
        ),
        (
            "video/mp4",
            MP4,
            VIDEO_REPORT,
            {
                "kind": "video",
                "width": 1080,
                "height": 1920,
                "fps": pytest.approx(29.97, 0.01),
                "duration_in_frames": 60,
                "has_audio": True,
            },
        ),
        (
            "audio/wav",
            WAV,
            AUDIO_REPORT,
            {
                "kind": "audio",
                "width": None,
                "height": None,
                "fps": None,
                "duration_in_frames": 45,
                "has_audio": True,
            },
        ),
    ],
)
@pytest.mark.asyncio
async def test_a_supported_upload_is_published_and_registered_ready(
    tmp_path: Path,
    media_type: str,
    payload: bytes,
    report: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    repository = MemoryRepository()

    asset = await service(tmp_path, report, repository).upload(
        "project_001", media_type, chunks_of(payload)
    )

    assert asset.model_dump(include=set(expected)) == expected
    assert asset.project_id == "project_001"
    assert asset.media_type == media_type
    assert asset.validation_state == "ready"
    assert asset.checksum is not None and asset.checksum.startswith("sha256:")
    assert "artifact_location" not in asset.model_dump()
    [record] = repository.records
    assert record.asset == asset
    assert record.artifact_location.startswith(f"uploads/project_001/{asset.asset_id}.")
    assert (tmp_path / record.artifact_location).read_bytes() == payload
    assert leftovers(tmp_path) == [str(Path(record.artifact_location))]


@pytest.mark.asyncio
async def test_an_unsupported_media_type_is_refused_before_reading(tmp_path: Path) -> None:
    async def never_read():
        raise AssertionError("the body must not be read")
        yield b""

    with pytest.raises(EditorAssetMediaInvalid) as refused:
        await service(tmp_path, IMAGE_REPORT).upload("project_001", "text/html", never_read())

    assert refused.value.code == "unsupported_media_type"
    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_spoofed_bytes_are_refused_and_nothing_remains(tmp_path: Path) -> None:
    repository = MemoryRepository()

    with pytest.raises(EditorAssetMediaInvalid) as refused:
        await service(tmp_path, IMAGE_REPORT, repository).upload(
            "project_001", "image/png", chunks_of(MP4)
        )

    assert refused.value.code == "media_type_mismatch"
    assert repository.records == []
    assert leftovers(tmp_path) == []


@pytest.mark.parametrize(
    "report",
    [
        {"streams": [], "format": {}},
        {"streams": [{"codec_type": "video", "width": 0, "height": 32}], "format": {}},
        {
            "streams": [{"codec_type": "video", "width": 8, "height": 8, "avg_frame_rate": "0/0"}],
            "format": {"duration": "1.0"},
        },
        {
            "streams": [
                {"codec_type": "video", "width": 8, "height": 8, "avg_frame_rate": "960/1"}
            ],
            "format": {"duration": "1.0"},
        },
        {
            "streams": [{"codec_type": "video", "width": 8, "height": 8, "avg_frame_rate": "30/1"}],
            "format": {"duration": "N/A"},
        },
    ],
)
@pytest.mark.asyncio
async def test_invalid_metadata_is_refused_and_nothing_remains(
    tmp_path: Path, report: dict[str, Any]
) -> None:
    repository = MemoryRepository()

    with pytest.raises(EditorAssetMediaInvalid) as refused:
        await service(tmp_path, report, repository).upload(
            "project_001", "video/mp4", chunks_of(MP4)
        )

    assert refused.value.code == "invalid_media"
    assert repository.records == []
    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_an_upload_over_the_ceiling_leaves_nothing(tmp_path: Path) -> None:
    repository = MemoryRepository()

    with pytest.raises(EditorAssetUploadTooLarge):
        await service(tmp_path, IMAGE_REPORT, repository, max_bytes=8).upload(
            "project_001", "image/png", chunks_of(PNG)
        )

    assert repository.records == []
    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_a_database_failure_unpublishes_the_file(tmp_path: Path) -> None:
    with pytest.raises(EditorAssetsUnavailable):
        await service(tmp_path, IMAGE_REPORT, MemoryRepository(fail=True)).upload(
            "project_001", "image/png", chunks_of(PNG)
        )

    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_a_missing_probe_runtime_is_unavailable_and_cleans_up(tmp_path: Path) -> None:
    with pytest.raises(EditorAssetsUnavailable):
        await service(tmp_path, FileNotFoundError("ffprobe")).upload(
            "project_001", "image/png", chunks_of(PNG)
        )

    assert leftovers(tmp_path) == []


@pytest.mark.asyncio
async def test_a_missing_artifact_root_is_unavailable(tmp_path: Path) -> None:
    with pytest.raises(EditorAssetsUnavailable):
        await service(tmp_path / "absent", IMAGE_REPORT).upload(
            "project_001", "image/png", chunks_of(PNG)
        )

    assert not (tmp_path / "absent").exists()


@pytest.mark.asyncio
async def test_without_a_database_uploads_are_unavailable(tmp_path: Path) -> None:
    upload_service = EditorAssetUploadService(None, LocalArtifactRoot(tmp_path), canned({}))

    with pytest.raises(EditorAssetsUnavailable):
        await upload_service.upload("project_001", "image/png", chunks_of(PNG))

    assert leftovers(tmp_path) == []


def test_described_asset_counts_duration_on_the_canvas_clock() -> None:
    asset = described_asset(
        asset_id="asset_1",
        project_id="project_001",
        media_type="video/mp4",
        kind="video",
        checksum="sha256:" + "c" * 64,
        report={
            "streams": [{"codec_type": "video", "width": 8, "height": 8, "avg_frame_rate": "25/1"}],
            "format": {"duration": "0.01"},
        },
    )

    assert asset.duration_in_frames == 1
    assert asset.fps == 25.0
    assert asset.has_audio is False
