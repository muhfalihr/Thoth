"""Offline summary of one Stage 1 parity attempt record.

A finished parity sample is an evidence directory: it holds the fixture URL, a
source report full of post identifiers, and the raw stderr of a browser session.
Routine inspection used to mean listing that directory and reading those files,
which puts every one of those values on an operator's terminal for a question as
small as "did the reference finish, and where did it stop?".

This command answers that question from a single known path. It validates the
reference identifier before building anything, opens only the attempt record, and
prints fixed booleans, counts, and allowlisted enum values. It never enumerates a
directory and never opens a report, fixture, log, or media file.

Diagnostic events are re-validated here rather than trusted. The supervisor that
wrote them applied the same allowlist, but this side is the one printing to a
terminal, so an event carrying an unexpected key or value invalidates the whole
set instead of being echoed.

Absent evidence fails closed: a missing or unusable record reports a nonzero
reference exit and a failed cleanup, because "no record" is not "clean run".
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from thoth_control_plane.operations.stage1_local_preflight import Stage1PreflightError
from thoth_control_plane.operations.stage1_parity_preflight import (
    ATTEMPT_RECORD_NAME,
    OUTPUT_DIRECTORY_NAME,
)

#: The identifier names a directory, so it may not escape its parent. Mirrors the
#: pattern the reference supervisor enforces when it creates that directory.
REFERENCE_ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,63}")

LEGACY_SCOUT_DIRECTORY_NAME = "legacy-scout"

MAX_RECORD_BYTES = 1024 * 1024
MAX_EVENTS = 32

DIAGNOSTIC_KEYS = frozenset({"schema_version", "kind", "stage", "category", "code"})
DIAGNOSTIC_VALUE_KEYS = ("kind", "stage", "category", "code")

#: The closed set of frames the supervisor may record, as (kind, stage, category, code).
VALID_COMBINATIONS = frozenset(
    {
        (
            "signal",
            "trace_source",
            "media_candidate_discovery",
            "profile_discovery_exception",
        ),
        ("signal", "trace_source", "media_candidate_discovery", "profile_discovery_empty"),
        ("terminal", "trace_source", "unknown", "required_stage_failed"),
    }
)

Event = tuple[str, str, str, str]


def _attempt_path(sample: Path, reference_id: str) -> Path | None:
    """Return the one path this command may open, or None when it is not containable."""
    if REFERENCE_ID_PATTERN.fullmatch(reference_id) is None:
        raise Stage1PreflightError(
            "the reference identifier must match the container contract: a lowercase "
            "letter followed by up to 63 lowercase letters, digits, or hyphens"
        )
    try:
        # A symlink anywhere in this chain is how a reader gets steered at evidence it was
        # told not to open. Containment catches only redirects that leave the sample; a
        # redirected sample root or an intermediate directory pointing at a sibling attempt
        # lands squarely inside it, so every existing component is inspected on its own.
        if sample.is_symlink():
            return None
        root = sample.resolve()
        chain = (
            OUTPUT_DIRECTORY_NAME,
            LEGACY_SCOUT_DIRECTORY_NAME,
            reference_id,
            ATTEMPT_RECORD_NAME,
        )
        component = root
        for name in chain:
            component = component / name
            if component.is_symlink():
                return None
        candidate = component
        # Kept as defense in depth: it is the check that still holds if the walk above ever
        # races a link created between the inspection and the read.
        if not candidate.resolve().is_relative_to(root):
            return None
    except OSError:
        return None
    return candidate


def _read_record(path: Path | None) -> tuple[bool, dict[str, object] | None]:
    """Read the attempt record, separating "no file" from "file I cannot use"."""
    if path is None:
        return False, None
    try:
        if not path.is_file():
            return False, None
        with path.open("rb") as handle:
            raw = handle.read(MAX_RECORD_BYTES + 1)
    except OSError:
        return False, None
    if len(raw) > MAX_RECORD_BYTES:
        return True, None
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return True, None
    return True, record if isinstance(record, dict) else None


def _validated_events(value: object) -> list[Event] | None:
    """Re-validate recorded events, rejecting the whole set if any frame is untrusted."""
    if not isinstance(value, list) or len(value) > MAX_EVENTS:
        return None
    events: list[Event] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != DIAGNOSTIC_KEYS:
            return None
        version = item["schema_version"]
        if isinstance(version, bool) or version != 1:
            return None
        if not all(isinstance(item[key], str) for key in DIAGNOSTIC_VALUE_KEYS):
            return None
        identity: Event = tuple(item[key] for key in DIAGNOSTIC_VALUE_KEYS)  # type: ignore[assignment]
        if identity not in VALID_COMBINATIONS or identity in events:
            return None
        events.append(identity)
    return events


def _diagnostics(record: dict[str, object] | None) -> tuple[str, bool, list[Event]]:
    """Classify a record as carrying the current diagnostic contract or predating it."""
    if record is None:
        return "legacy", False, []
    has_flag = "diagnostics_valid" in record
    has_events = "diagnostic_events" in record
    # Only a record predating the contract entirely is legacy. One field alone means a writer
    # that knew about the contract and did not complete it, which is current-era evidence and
    # exactly the kind not worth trusting.
    if not has_flag and not has_events:
        return "legacy", False, []
    if not (has_flag and has_events) or record["diagnostics_valid"] is not True:
        return "current", False, []
    events = _validated_events(record["diagnostic_events"])
    if events is None:
        return "current", False, []
    return "current", True, events


def _exited_cleanly(record: dict[str, object]) -> bool:
    code = record.get("referenceExit")
    return isinstance(code, int) and not isinstance(code, bool) and code == 0


def _summarize_attempt(sample: Path, reference_id: str) -> dict[str, object]:
    """Summarize one attempt record as fixed booleans, counts, and allowlisted enums."""
    present, record = _read_record(_attempt_path(sample, reference_id))
    complete = record is not None and record.get("status") == "complete"
    finished = record if complete else None
    contract, valid, events = _diagnostics(finished)
    terminal = next((event for event in events if event[0] == "terminal"), None)
    return {
        "attempt_present": present,
        "attempt_complete": complete,
        "reference_exit_nonzero": not (finished is not None and _exited_cleanly(finished)),
        "cleanup_passed": finished is not None and finished.get("cleanupPassed") is True,
        "diagnostic_contract": contract,
        "diagnostics_valid": valid,
        "diagnostic_event_count": len(events),
        # The terminal event says where a run ended. It never says why, so no earlier
        # signal is promoted into a cause here; both are reported as separate facts.
        "terminal_stage": terminal[1] if terminal else None,
        "terminal_category": terminal[2] if terminal else None,
        "media_candidate_discovery_signal": any(
            event[0] == "signal" and event[2] == "media_candidate_discovery" for event in events
        ),
    }


def _main() -> int:
    """Print one compact JSON object describing a single attempt record."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m thoth_control_plane.operations.stage1_parity_attempt_summary",
        description=(
            "Summarize one Stage 1 parity attempt record. Reads only the attempt "
            "record itself; never lists the sample or opens reports, logs, or media."
        ),
    )
    parser.add_argument("--sample", required=True, type=Path)
    parser.add_argument("--reference-id", required=True)
    arguments = parser.parse_args()

    try:
        summary = _summarize_attempt(arguments.sample, arguments.reference_id)
    except Stage1PreflightError as error:
        print(f"reason={error}", file=sys.stderr)
        return 2
    print(json.dumps(summary, separators=(",", ":")))
    return 0 if summary["attempt_complete"] else 1


if __name__ == "__main__":  # pragma: no cover - exercised as a module CLI
    raise SystemExit(_main())
