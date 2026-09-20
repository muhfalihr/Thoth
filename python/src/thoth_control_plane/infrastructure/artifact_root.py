"""The one local adapter that composes and resolves every E1 filesystem path.

Layout below the configured artifact root::

    renders/<render_job_id>/{output.mp4,metadata.json,diagnostics.json}
    work/<render_job_id>/{bundle.json,assets/}
    temp/<render_job_id>/

Identifiers are validated before they become path segments, and every resolved
target is re-checked for canonical ancestry with no symlink, junction, or other
reparse point in its chain immediately before it is read, written, moved, or
deleted. Assets are copied, never hard-linked, so a mutated source inode cannot
change what an already staged revision renders.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
from pathlib import Path

from thoth_control_plane.application.render_job_ports import (
    ArtifactPathInvalid,
    ArtifactUnavailable,
    JobWorkspace,
    PublishedArtifact,
    StagedAsset,
)
from thoth_control_plane.domain.render_jobs import RenderOutputFacts

#: Identical to the domain `OpaqueId`: one safe segment, never a path fragment.
_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
#: A source extension is only carried over when it is itself a safe segment.
_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,8}$")
#: One segment of a stored asset locator: no dot-segment, separator, or colon.
_LOCATOR_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

_CHUNK_BYTES = 1024 * 1024
_OUTPUT_NAME = "output.mp4"


def _valid_identifier(value: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.match(value):
        raise ArtifactPathInvalid()
    return value


def _is_link(path: Path) -> bool:
    """Report symlinks, junctions, and any other reparse point."""
    try:
        info = path.lstat()
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as reader:
        while chunk := reader.read(_CHUNK_BYTES):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _atomic_write(path: Path, payload: bytes) -> None:
    partial = path.with_name(f"{path.name}.part")
    try:
        partial.write_bytes(payload)
        os.replace(partial, path)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


class LocalArtifactRoot:
    """Own every path below one resolved artifact root."""

    def __init__(self, root: Path) -> None:
        self._root = Path(root).resolve()

    def prepare(self, render_job_id: str) -> JobWorkspace:
        job = _valid_identifier(render_job_id)
        (self._contained("work", job, "assets")).mkdir(parents=True, exist_ok=True)
        (self._contained("temp", job)).mkdir(parents=True, exist_ok=True)
        return JobWorkspace(render_job_id=job)

    def resolve_source(self, relative_location: str) -> Path:
        """Resolve one stored asset locator below this root, or refuse it.

        The repository already constrains what it stores, so this is the second
        of two independent checks and the only place a locator becomes a path.
        """
        if not isinstance(relative_location, str) or not 0 < len(relative_location) <= 512:
            raise ArtifactPathInvalid()
        segments = relative_location.split("/")
        if any(not _LOCATOR_SEGMENT.match(segment) for segment in segments):
            raise ArtifactPathInvalid()
        target = self._contained(*segments)
        if _is_link(target):
            raise ArtifactPathInvalid()
        if not target.is_file():
            raise ArtifactUnavailable()
        return target

    def stage_asset(
        self,
        workspace: JobWorkspace,
        *,
        asset_id: str,
        source: Path,
        expected_checksum: str,
        max_bytes: int,
    ) -> StagedAsset:
        job = _valid_identifier(workspace.render_job_id)
        asset = _valid_identifier(asset_id)
        origin = Path(source)
        suffix = origin.suffix if _SUFFIX.match(origin.suffix) else ""
        destination = self._contained("work", job, workspace.assets_name, f"{asset}{suffix}")

        if _is_link(origin) or not origin.is_file():
            raise ArtifactUnavailable()
        if origin.stat().st_size > max_bytes:
            raise ArtifactUnavailable()

        partial = destination.with_name(f"{destination.name}.part")
        digest = hashlib.sha256()
        written = 0
        try:
            with origin.open("rb") as reader, partial.open("wb") as writer:
                while chunk := reader.read(_CHUNK_BYTES):
                    written += len(chunk)
                    if written > max_bytes:
                        raise ArtifactUnavailable()
                    digest.update(chunk)
                    writer.write(chunk)
            # Hash the copy, so a source mutated mid-read cannot pass silently.
            if f"sha256:{digest.hexdigest()}" != expected_checksum:
                raise ArtifactUnavailable()
            os.replace(partial, destination)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise

        return StagedAsset(
            asset_id=asset,
            relative_name=f"{workspace.assets_name}/{destination.name}",
            size_bytes=written,
            checksum=expected_checksum,
        )

    def write_bundle(self, workspace: JobWorkspace, bundle_json: bytes) -> str:
        job = _valid_identifier(workspace.render_job_id)
        _atomic_write(self._contained("work", job, workspace.bundle_name), bundle_json)
        return workspace.bundle_name

    def verify_temporary_output(self, render_job_id: str, expected: RenderOutputFacts) -> Path:
        job = _valid_identifier(render_job_id)
        target = self._contained("temp", job, _OUTPUT_NAME)
        if _is_link(target):
            raise ArtifactPathInvalid()
        if not target.is_file():
            raise ArtifactUnavailable()
        if target.stat().st_size != expected.size_bytes:
            raise ArtifactUnavailable()
        if _digest(target) != expected.checksum:
            raise ArtifactUnavailable()
        return target

    def publish(
        self,
        render_job_id: str,
        output: RenderOutputFacts,
        metadata_json: bytes,
        diagnostics_json: bytes,
    ) -> PublishedArtifact:
        job = _valid_identifier(render_job_id)
        verified = self.verify_temporary_output(job, output)
        directory = self._contained("renders", job)
        directory.mkdir(parents=True, exist_ok=True)
        _atomic_write(directory / "metadata.json", metadata_json)
        _atomic_write(directory / "diagnostics.json", diagnostics_json)
        # Publication is the last step and is a single atomic rename.
        os.replace(verified, directory / _OUTPUT_NAME)
        return PublishedArtifact(
            relative_path=f"renders/{job}/{_OUTPUT_NAME}",
            size_bytes=output.size_bytes,
            checksum=output.checksum,
        )

    def resolve_download(self, render_job_id: str, relative_path: str) -> Path:
        job = _valid_identifier(render_job_id)
        if relative_path != f"renders/{job}/{_OUTPUT_NAME}":
            raise ArtifactPathInvalid()
        target = self._contained("renders", job, _OUTPUT_NAME)
        if _is_link(target):
            raise ArtifactPathInvalid()
        if not target.is_file():
            raise ArtifactUnavailable()
        return target

    def cleanup(self, render_job_id: str) -> None:
        job = _valid_identifier(render_job_id)
        # Resolve every target first: nothing is deleted unless all of this
        # job's locations are contained and link-free.
        published = self._contained("renders", job, _OUTPUT_NAME)
        workspace = self._contained("work", job)
        temporary = self._contained("temp", job)
        if _is_link(published) or _is_link(workspace) or _is_link(temporary):
            raise ArtifactPathInvalid()
        published.unlink(missing_ok=True)
        for directory in (workspace, temporary):
            if directory.is_dir():
                shutil.rmtree(directory, ignore_errors=True)

    def _contained(self, *segments: str) -> Path:
        """Join validated segments and prove the result stays below the root."""
        candidate = self._root.joinpath(*segments)
        resolved = candidate.resolve()
        if resolved != self._root and not resolved.is_relative_to(self._root):
            raise ArtifactPathInvalid()
        current = self._root
        for segment in segments:
            current = current / segment
            if _is_link(current):
                raise ArtifactPathInvalid()
        return candidate
