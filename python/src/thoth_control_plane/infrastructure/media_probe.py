"""Run the image's own ffprobe on one received upload and return its JSON report.

The argument vector is fixed and never passes through a shell; the only
caller-controlled value is a path this process composed below the artifact root.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from thoth_control_plane.application.editor_asset_ports import EditorAssetMediaInvalid

#: A local probe of one bounded file; anything slower is treated as unreadable.
PROBE_TIMEOUT_SECONDS = 30


async def probe_media(ffprobe: str, path: Path) -> dict[str, Any]:
    """Raise ``OSError`` when ffprobe itself is missing, invalid media when it refuses."""
    process = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        str(path),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), PROBE_TIMEOUT_SECONDS)
    except TimeoutError as error:
        process.kill()
        await process.wait()
        raise EditorAssetMediaInvalid("invalid_media") from error
    if process.returncode != 0:
        raise EditorAssetMediaInvalid("invalid_media")
    try:
        report = json.loads(stdout)
    except ValueError as error:
        raise EditorAssetMediaInvalid("invalid_media") from error
    if not isinstance(report, dict):
        raise EditorAssetMediaInvalid("invalid_media")
    return report
