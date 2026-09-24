"""The ffprobe runner: argument vector, output parsing, and failure classes."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from thoth_control_plane.application.editor_asset_ports import EditorAssetMediaInvalid
from thoth_control_plane.infrastructure import media_probe


class Process:
    def __init__(self, returncode: int, stdout: bytes) -> None:
        self.returncode = returncode
        self._stdout = stdout

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, b""


def spawned(monkeypatch: pytest.MonkeyPatch, process: Process) -> list[tuple[object, ...]]:
    calls: list[tuple[object, ...]] = []

    async def create(*argv: object, **_: object) -> Process:
        calls.append(argv)
        return process

    monkeypatch.setattr(media_probe.asyncio, "create_subprocess_exec", create)
    return calls


async def test_probe_runs_ffprobe_without_a_shell_and_parses_json(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    report = {"streams": [{"codec_type": "audio"}], "format": {"duration": "1.0"}}
    calls = spawned(monkeypatch, Process(0, json.dumps(report).encode()))

    result = await media_probe.probe_media("/usr/bin/ffprobe", tmp_path / "a.wav")

    assert result == report
    [argv] = calls
    assert argv[0] == "/usr/bin/ffprobe"
    assert argv[-1] == str(tmp_path / "a.wav")
    assert "-show_streams" in argv and "-show_format" in argv


async def test_unreadable_media_is_invalid(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    spawned(monkeypatch, Process(1, b""))

    with pytest.raises(EditorAssetMediaInvalid) as refused:
        await media_probe.probe_media("ffprobe", tmp_path / "a.mp4")

    assert refused.value.code == "invalid_media"


async def test_a_missing_ffprobe_is_an_os_error(tmp_path: Path) -> None:
    with pytest.raises(OSError):
        await media_probe.probe_media(str(tmp_path / "no-ffprobe"), tmp_path / "a.mp4")
