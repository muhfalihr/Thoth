"""Strict JSONL loading and atomic report writing for the TikTok Stage 1 soak.

Parses a soak dataset from a JSONL file, handing each parsed line straight to
`TikTokSoakObservation` for the strict per-observation validation that model
already owns — this module never re-implements any of those checks. Writes
the evaluator's aggregate `TikTokSoakReport` to disk atomically: a sibling
`.part` file is written, flushed, `fsync`'d, then `os.replace`d onto the
final name, so a reader never observes a truncated or half-written report.
The `.part` file is removed on any failure, including cancellation
(`BaseException`, not just `Exception`).

This module owns its own error boundary, `TikTokSoakInputError`, rather than
raising `TikTokSoakDatasetError`: a malformed input line is an input-format
failure, not a structural dataset failure, and the two contracts stay
independent.
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

from pydantic import ValidationError

from thoth_control_plane.operations.tiktok_soak import TikTokSoakObservation, TikTokSoakReport

REPORT_NAME = "tiktok-stage1-soak-report.json"


class TikTokSoakInputError(ValueError):
    """Raised when a soak observations file fails to parse strictly.

    The message is always the same fixed string: it never echoes the
    offending line, its content, a line number, a path, or the underlying
    exception.
    """


def load_tiktok_soak_observations(path: Path) -> list[TikTokSoakObservation]:
    """Parse one strict `TikTokSoakObservation` per non-empty line.

    Fails closed: any I/O error, encoding error, blank line, malformed JSON,
    or per-observation validation failure aborts the entire load with
    `TikTokSoakInputError` before any observation is returned. Never skips a
    bad line and never returns a partial list.
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        if not lines or any(not line.strip() for line in lines):
            raise ValueError
        return [TikTokSoakObservation.model_validate_json(line) for line in lines]
    except (OSError, UnicodeError, ValueError, ValidationError) as error:
        raise TikTokSoakInputError("invalid tiktok soak observation input") from error


def write_tiktok_soak_report(report: TikTokSoakReport, output_directory: Path) -> Path:
    """Write the aggregate report atomically: `.part`, flush, fsync, replace.

    The partial file is removed on any failure or cancellation
    (`BaseException`), so a reader never observes a truncated report and no
    `.part` is ever stranded.
    """
    destination = output_directory / REPORT_NAME
    partial = output_directory / f"{REPORT_NAME}.part"
    output_directory.mkdir(parents=True, exist_ok=True)
    try:
        with partial.open("wb") as handle:
            handle.write(report.model_dump_json(indent=2).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(partial, destination)
        return destination
    except BaseException:
        with contextlib.suppress(OSError):
            partial.unlink(missing_ok=True)
        raise
