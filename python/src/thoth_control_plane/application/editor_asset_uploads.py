"""Register one explicitly uploaded media file as a ready, project-scoped asset.

The body arrives as a stream, is bounded and hashed as it lands in temporary
storage below the artifact root, is checked against its declared type and the
image's ffprobe report, and is only then atomically published and registered.
Nothing here accepts or follows a URL or a caller-supplied path, and a failure
at any step leaves neither a file nor a row behind.
"""

from __future__ import annotations

import contextlib
import math
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal
from uuid import uuid4

from thoth_control_plane.application.editor_asset_ports import (
    EditorAssetMediaInvalid,
    EditorAssetUploadTooLarge,
    ReceivedUpload,
)
from thoth_control_plane.application.editor_assets import EditorAssetsUnavailable
from thoth_control_plane.domain.editor_assets import EditorAsset, EditorAssetRecord

if TYPE_CHECKING:
    from thoth_control_plane.application.editor_asset_ports import EditorAssetRepository
    from thoth_control_plane.infrastructure.artifact_root import LocalArtifactRoot

#: The fixed upload ceiling: half the render staging bound, so any upload stays renderable.
UPLOAD_MAX_BYTES = 512 * 1024 * 1024
#: Asset durations are counted on the Studio canvas clock, not the media's own rate.
CANVAS_FPS = 30
PROVENANCE = "studio_upload"

MediaProbe = Callable[[Path], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class UploadType:
    kind: Literal["image", "video", "audio"]
    suffix: str
    signature: Callable[[bytes], bool]


def _riff(form: bytes) -> Callable[[bytes], bool]:
    return lambda head: head[:4] == b"RIFF" and head[8:12] == form


def _mpeg_audio(head: bytes) -> bool:
    return head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and head[1] >= 0xE0)


#: The only accepted declared types, each with the leading bytes it must carry.
UPLOAD_TYPES: dict[str, UploadType] = {
    "image/png": UploadType("image", ".png", lambda head: head.startswith(b"\x89PNG\r\n\x1a\n")),
    "image/jpeg": UploadType("image", ".jpg", lambda head: head.startswith(b"\xff\xd8\xff")),
    "image/webp": UploadType("image", ".webp", _riff(b"WEBP")),
    "video/mp4": UploadType("video", ".mp4", lambda head: head[4:8] == b"ftyp"),
    "video/webm": UploadType("video", ".webm", lambda head: head.startswith(b"\x1a\x45\xdf\xa3")),
    "audio/mpeg": UploadType("audio", ".mp3", _mpeg_audio),
    "audio/wav": UploadType("audio", ".wav", _riff(b"WAVE")),
}


def _rate(value: object) -> float | None:
    numerator, _, denominator = str(value).partition("/")
    rate = float(numerator) / float(denominator or 1) if float(denominator or 1) else 0.0
    return rate if rate > 0 else None


def described_asset(
    *,
    asset_id: str,
    project_id: str,
    media_type: str,
    kind: Literal["image", "video", "audio"],
    checksum: str,
    report: dict[str, Any],
) -> EditorAsset:
    """Turn one ffprobe report into the public asset, or refuse it as invalid media."""
    try:
        streams = report.get("streams") or []
        visual = next((s for s in streams if s.get("codec_type") == "video"), None)
        audible = any(s.get("codec_type") == "audio" for s in streams)
        values: dict[str, Any] = {"has_audio": audible and kind != "image"}
        if kind == "audio" and not audible:
            raise ValueError("no audio stream")
        if kind != "audio":
            if visual is None:
                raise ValueError("no visual stream")
            values |= {"width": visual.get("width"), "height": visual.get("height")}
        if kind == "video":
            fps = _rate(visual.get("avg_frame_rate")) or _rate(visual.get("r_frame_rate"))
            if fps is None:
                raise ValueError("no frame rate")
            values["fps"] = fps
        if kind != "image":
            seconds = float((report.get("format") or {}).get("duration"))
            if not math.isfinite(seconds) or seconds <= 0:
                raise ValueError("no duration")
            values["duration_in_frames"] = max(1, math.ceil(seconds * CANVAS_FPS))
        return EditorAsset(
            asset_id=asset_id,
            project_id=project_id,
            kind=kind,
            media_type=media_type,
            validation_state="ready",
            checksum=checksum,
            **values,
        )
    except (ArithmeticError, AttributeError, TypeError, ValueError) as error:
        # A pydantic ValidationError is a ValueError, so a bad width or rate lands here too.
        raise EditorAssetMediaInvalid("invalid_media") from error


class EditorAssetUploadService:
    """Receive, inspect, publish, and register one upload; roll every step back on failure."""

    def __init__(
        self,
        repository: EditorAssetRepository | None,
        artifacts: LocalArtifactRoot,
        probe: MediaProbe,
        *,
        max_bytes: int = UPLOAD_MAX_BYTES,
    ) -> None:
        self._repository = repository
        self._artifacts = artifacts
        self._probe = probe
        self._max_bytes = max_bytes

    async def upload(
        self, project_id: str, media_type: str, chunks: AsyncIterator[bytes]
    ) -> EditorAsset:
        upload_type = UPLOAD_TYPES.get(media_type)
        if upload_type is None:
            raise EditorAssetMediaInvalid("unsupported_media_type")
        if self._repository is None:
            raise EditorAssetsUnavailable()
        asset_id = f"asset_{uuid4().hex}"
        try:
            received = await self._artifacts.receive_upload(
                asset_id=asset_id, chunks=chunks, max_bytes=self._max_bytes
            )
        except EditorAssetUploadTooLarge:
            raise
        except Exception as error:
            raise EditorAssetsUnavailable() from error

        published: str | None = None
        try:
            asset = await self._inspect(received, project_id, media_type, upload_type, asset_id)
            published = self._artifacts.publish_upload(
                received, project_id=project_id, suffix=upload_type.suffix
            )
            await self._repository.register_ready(
                EditorAssetRecord(asset=asset, artifact_location=published, provenance=PROVENANCE)
            )
        except BaseException as error:
            for location in (received.location, published):
                if location is not None:
                    with contextlib.suppress(Exception):
                        self._artifacts.discard(location)
            if isinstance(error, EditorAssetMediaInvalid) or not isinstance(error, Exception):
                raise
            raise EditorAssetsUnavailable() from error
        return asset

    async def _inspect(
        self,
        received: ReceivedUpload,
        project_id: str,
        media_type: str,
        upload_type: UploadType,
        asset_id: str,
    ) -> EditorAsset:
        if not upload_type.signature(received.head):
            raise EditorAssetMediaInvalid("media_type_mismatch")
        return described_asset(
            asset_id=asset_id,
            project_id=project_id,
            media_type=media_type,
            kind=upload_type.kind,
            checksum=received.checksum,
            report=await self._probe(received.path),
        )
