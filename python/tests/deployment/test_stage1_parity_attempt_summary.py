"""Behavioural tests for the offline parity attempt summary.

Routine inspection of a finished parity reference used to mean listing a sample
directory and reading a raw Scout log. Both are evidence surfaces: the sample
holds the fixture URL, the report holds post identifiers, and the stderr log holds
whatever the browser printed. The summary exists so an operator never has to open
any of them.

Every input here is synthetic. Each test plants canaries -- a URL, a filesystem
path, a post identifier, a credential, a filename, and a raw exception string --
in the places a careless implementation would read from, and asserts that none of
them reaches the summary, stdout, or stderr.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from thoth_control_plane.operations.stage1_parity_attempt_summary import _summarize_attempt

REFERENCE_ID = "ref-p9"

CANARY_URL = "https://www.tiktok.com/@synthetic-canary/video/1234567890123456789"
CANARY_PATH = "/restricted/synthetic-canary/p9"
CANARY_POST_ID = "1234567890123456789"
CANARY_CREDENTIAL = "sessionid=synthetic-canary-credential"
CANARY_FILENAME = "reference.stderr.log"
CANARY_ERROR = "TypeError: Cannot read properties of undefined"

CANARIES = (
    CANARY_URL,
    CANARY_PATH,
    CANARY_POST_ID,
    CANARY_CREDENTIAL,
    CANARY_FILENAME,
    CANARY_ERROR,
)

DISCOVERY_SIGNAL = {
    "schema_version": 1,
    "kind": "signal",
    "stage": "trace_source",
    "category": "media_candidate_discovery",
    "code": "profile_discovery_exception",
}
TERMINAL_EVENT = {
    "schema_version": 1,
    "kind": "terminal",
    "stage": "trace_source",
    "category": "unknown",
    "code": "required_stage_failed",
}

COMPLETE_RECORD = {
    "started_at": "2026-09-08T00:00:00.000Z",
    "finished_at": "2026-09-08T00:05:00.000Z",
    "status": "complete",
    "referenceExit": 1,
    "browserExit": 0,
    "cleanupPassed": True,
    "timedOut": False,
    "interrupted": False,
}

posix_only = pytest.mark.skipif(
    os.name != "posix", reason="symlink creation is privileged on non-POSIX hosts"
)


def _sample(root: Path) -> Path:
    """Build a sample directory that is entirely canaries except the attempt record."""
    sample = root / "restricted" / "p9"
    attempt_directory = sample / "scout-output" / "legacy-scout" / REFERENCE_ID
    attempt_directory.mkdir(parents=True)

    (sample / "reference-input").mkdir()
    (sample / "reference-input" / "url").write_text(f"{CANARY_URL}\n", encoding="utf-8")
    (attempt_directory / CANARY_FILENAME).write_text(
        f"{CANARY_ERROR} at {CANARY_URL}\n{CANARY_CREDENTIAL}\n", encoding="utf-8"
    )
    (attempt_directory / "source-report.json").write_text(
        json.dumps({"post_id": CANARY_POST_ID, "url": CANARY_URL}), encoding="utf-8"
    )
    other = sample / "scout-output" / "legacy-scout" / "ref-other"
    other.mkdir()
    (other / "reference-attempt.json").write_text(
        json.dumps({"status": "complete", "note": CANARY_PATH}), encoding="utf-8"
    )
    return sample


def _write_attempt(sample: Path, record: object) -> Path:
    target = sample / "scout-output" / "legacy-scout" / REFERENCE_ID / "reference-attempt.json"
    target.write_text(json.dumps(record), encoding="utf-8")
    return target


def _record(**overrides: object) -> dict[str, object]:
    """A complete record plus free-form fields no summary field may ever carry."""
    return {
        **COMPLETE_RECORD,
        "note": f"failed on {CANARY_URL}",
        "command": f"scout trace_source --out {CANARY_PATH}",
        "error": CANARY_ERROR,
        **overrides,
    }


def _assert_contained(summary: dict[str, object]) -> None:
    rendered = json.dumps(summary)
    for canary in CANARIES:
        assert canary not in rendered


def _run_cli(sample: Path, reference_id: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "thoth_control_plane.operations.stage1_parity_attempt_summary",
            "--sample",
            str(sample),
            "--reference-id",
            reference_id,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_a_missing_attempt_record_reports_absence_without_naming_a_path(tmp_path: Path) -> None:
    summary = _summarize_attempt(_sample(tmp_path), REFERENCE_ID)

    assert summary["attempt_present"] is False
    assert summary["attempt_complete"] is False
    # Fail closed: with no record there is no evidence the reference exited cleanly,
    # and a summary that read "clean" here would be the wrong default for an operator.
    assert summary["reference_exit_nonzero"] is True
    assert summary["cleanup_passed"] is False
    assert summary["diagnostic_contract"] == "legacy"
    assert summary["diagnostics_valid"] is False
    assert summary["diagnostic_event_count"] == 0
    assert summary["terminal_stage"] is None
    assert summary["terminal_category"] is None
    assert summary["media_candidate_discovery_signal"] is False
    _assert_contained(summary)


def test_a_pending_attempt_is_present_but_not_complete(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    _write_attempt(sample, {"started_at": "2026-09-08T00:00:00.000Z", "status": "pending"})

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_present"] is True
    assert summary["attempt_complete"] is False
    assert summary["diagnostic_contract"] == "legacy"
    assert summary["diagnostic_event_count"] == 0
    _assert_contained(summary)


def test_a_legacy_complete_attempt_keeps_its_lifecycle_facts(tmp_path: Path) -> None:
    """p1-p4 predate the diagnostic contract and are never migrated or amended."""
    sample = _sample(tmp_path)
    _write_attempt(sample, _record())

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_present"] is True
    assert summary["attempt_complete"] is True
    assert summary["reference_exit_nonzero"] is True
    assert summary["cleanup_passed"] is True
    assert summary["diagnostic_contract"] == "legacy"
    assert summary["diagnostics_valid"] is False
    assert summary["diagnostic_event_count"] == 0
    assert summary["terminal_stage"] is None
    assert summary["media_candidate_discovery_signal"] is False
    _assert_contained(summary)


def test_a_current_attempt_reports_a_terminal_stage_and_an_earlier_signal(tmp_path: Path) -> None:
    """The two stay separate fields: one says where the run ended, one says what was seen."""
    sample = _sample(tmp_path)
    _write_attempt(
        sample,
        _record(diagnostics_valid=True, diagnostic_events=[DISCOVERY_SIGNAL, TERMINAL_EVENT]),
    )

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["diagnostic_contract"] == "current"
    assert summary["diagnostics_valid"] is True
    assert summary["diagnostic_event_count"] == 2
    assert summary["terminal_stage"] == "trace_source"
    assert summary["terminal_category"] == "unknown"
    assert summary["media_candidate_discovery_signal"] is True
    _assert_contained(summary)


def test_a_current_attempt_without_a_terminal_event_claims_no_terminal_stage(
    tmp_path: Path,
) -> None:
    sample = _sample(tmp_path)
    _write_attempt(sample, _record(diagnostics_valid=True, diagnostic_events=[DISCOVERY_SIGNAL]))

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["diagnostic_contract"] == "current"
    assert summary["diagnostic_event_count"] == 1
    assert summary["terminal_stage"] is None
    assert summary["terminal_category"] is None
    assert summary["media_candidate_discovery_signal"] is True


def test_a_clean_current_attempt_reports_no_findings(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    _write_attempt(sample, _record(referenceExit=0, diagnostics_valid=True, diagnostic_events=[]))

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["reference_exit_nonzero"] is False
    assert summary["cleanup_passed"] is True
    assert summary["diagnostic_contract"] == "current"
    assert summary["diagnostics_valid"] is True
    assert summary["diagnostic_event_count"] == 0
    assert summary["media_candidate_discovery_signal"] is False


def test_a_boolean_exit_code_is_not_read_as_a_clean_exit(tmp_path: Path) -> None:
    """`False == 0` in Python, so a boolean here would otherwise report a clean run."""
    sample = _sample(tmp_path)
    _write_attempt(sample, _record(referenceExit=False))

    assert _summarize_attempt(sample, REFERENCE_ID)["reference_exit_nonzero"] is True


def test_a_cleanup_failure_is_reported_separately_from_the_exit_code(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    _write_attempt(
        sample,
        _record(referenceExit=0, cleanupPassed=False, diagnostics_valid=True, diagnostic_events=[]),
    )

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["reference_exit_nonzero"] is False
    assert summary["cleanup_passed"] is False


def test_an_untrusted_diagnostic_stream_reports_no_events(tmp_path: Path) -> None:
    """The supervisor already refused the stream; the summary must not soften that."""
    sample = _sample(tmp_path)
    _write_attempt(sample, _record(diagnostics_valid=False, diagnostic_events=[]))

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["diagnostic_contract"] == "current"
    assert summary["diagnostics_valid"] is False
    assert summary["diagnostic_event_count"] == 0
    assert summary["terminal_stage"] is None


def test_a_non_boolean_validity_flag_is_not_read_as_trusted(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    _write_attempt(sample, _record(diagnostics_valid="yes", diagnostic_events=[TERMINAL_EVENT]))

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["diagnostics_valid"] is False
    assert summary["diagnostic_event_count"] == 0


@pytest.mark.parametrize(
    "events",
    [
        [{**TERMINAL_EVENT, "code": "profile_discovery_empty"}],
        [{**TERMINAL_EVENT, "path": CANARY_PATH}],
        [{**TERMINAL_EVENT, "schema_version": 2}],
        # `True == 1`, so a boolean version would pass a bare equality check.
        [{**TERMINAL_EVENT, "schema_version": True}],
        [dict(TERMINAL_EVENT), dict(TERMINAL_EVENT)],
        [CANARY_URL],
        "not-a-list",
        [{"message": CANARY_ERROR}],
    ],
)
def test_an_event_outside_the_allowlist_invalidates_the_whole_set(
    tmp_path: Path, events: object
) -> None:
    """The record is re-validated here, so a smuggled field cannot be counted or echoed."""
    sample = _sample(tmp_path)
    _write_attempt(sample, _record(diagnostics_valid=True, diagnostic_events=events))

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["diagnostics_valid"] is False
    assert summary["diagnostic_event_count"] == 0
    assert summary["terminal_stage"] is None
    assert summary["media_candidate_discovery_signal"] is False
    _assert_contained(summary)


def test_an_unreadable_attempt_record_reports_incompleteness(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    target = sample / "scout-output" / "legacy-scout" / REFERENCE_ID / "reference-attempt.json"
    target.write_text(f"{{ broken json {CANARY_URL}", encoding="utf-8")

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_present"] is True
    assert summary["attempt_complete"] is False
    assert summary["diagnostic_contract"] == "legacy"
    _assert_contained(summary)


def test_an_oversized_attempt_record_is_refused_rather_than_parsed(tmp_path: Path) -> None:
    """The record is written by a supervised child, so its size is bounded on read."""
    sample = _sample(tmp_path)
    _write_attempt(sample, _record(padding=CANARY_URL * 60_000))

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_present"] is True
    assert summary["attempt_complete"] is False
    _assert_contained(summary)


def test_an_attempt_record_that_is_not_an_object_reports_incompleteness(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    _write_attempt(sample, [CANARY_URL])

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_complete"] is False
    _assert_contained(summary)


@pytest.mark.parametrize(
    "reference_id",
    ["", "../escape", "Ref-P9", "ref p9", "9ref", "ref/p9", "r" * 65, CANARY_PATH],
)
def test_an_invalid_reference_identifier_is_rejected_before_any_path_is_built(
    tmp_path: Path, reference_id: str
) -> None:
    with pytest.raises(ValueError) as error:
        _summarize_attempt(_sample(tmp_path), reference_id)

    message = str(error.value)
    assert "reference identifier" in message
    for canary in CANARIES:
        assert canary not in message


@posix_only
def test_a_symlinked_attempt_record_is_refused(tmp_path: Path) -> None:
    """A symlink is how a reader gets steered at evidence it was told not to open."""
    sample = _sample(tmp_path)
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text(json.dumps(_record()), encoding="utf-8")
    link = sample / "scout-output" / "legacy-scout" / REFERENCE_ID / "reference-attempt.json"
    link.symlink_to(elsewhere)

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_present"] is False
    assert summary["attempt_complete"] is False


@posix_only
def test_a_symlink_to_a_sibling_inside_the_sample_is_also_refused(tmp_path: Path) -> None:
    """Containment alone would allow this one: the target is the report full of post IDs."""
    sample = _sample(tmp_path)
    directory = sample / "scout-output" / "legacy-scout" / REFERENCE_ID
    (directory / "reference-attempt.json").symlink_to(directory / "source-report.json")

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_present"] is False
    _assert_contained(summary)


@posix_only
def test_a_symlinked_reference_directory_cannot_redirect_the_read(tmp_path: Path) -> None:
    """A symlink check sees only the final component; a redirected parent needs containment."""
    sample = _sample(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "reference-attempt.json").write_text(json.dumps(_record()), encoding="utf-8")

    directory = sample / "scout-output" / "legacy-scout" / REFERENCE_ID
    shutil.rmtree(directory)
    directory.symlink_to(outside, target_is_directory=True)

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["attempt_present"] is False
    assert summary["attempt_complete"] is False


def test_the_summary_never_walks_the_sample_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Enumeration is the leak: a listing names files this command must never reveal."""
    sample = _sample(tmp_path)
    _write_attempt(
        sample,
        _record(diagnostics_valid=True, diagnostic_events=[DISCOVERY_SIGNAL, TERMINAL_EVENT]),
    )

    def refuse(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("the summary enumerated a directory")

    monkeypatch.setattr(Path, "iterdir", refuse)
    monkeypatch.setattr(Path, "glob", refuse)
    monkeypatch.setattr(Path, "rglob", refuse)
    monkeypatch.setattr(os, "listdir", refuse)
    monkeypatch.setattr(os, "walk", refuse)

    summary = _summarize_attempt(sample, REFERENCE_ID)

    assert summary["diagnostic_event_count"] == 2


def test_the_summary_cli_emits_one_compact_json_line_without_canaries(tmp_path: Path) -> None:
    sample = _sample(tmp_path)
    _write_attempt(
        sample,
        _record(diagnostics_valid=True, diagnostic_events=[DISCOVERY_SIGNAL, TERMINAL_EVENT]),
    )

    result = _run_cli(sample, REFERENCE_ID)

    assert result.returncode == 0
    assert result.stdout.count("\n") == 1
    summary = json.loads(result.stdout)
    assert summary["terminal_stage"] == "trace_source"
    assert summary["media_candidate_discovery_signal"] is True
    for canary in CANARIES:
        assert canary not in result.stdout + result.stderr
    assert str(sample) not in result.stdout + result.stderr


def test_the_summary_cli_exits_nonzero_when_no_complete_attempt_exists(tmp_path: Path) -> None:
    result = _run_cli(_sample(tmp_path), REFERENCE_ID)

    assert result.returncode == 1
    assert json.loads(result.stdout)["attempt_present"] is False
    for canary in CANARIES:
        assert canary not in result.stdout + result.stderr


def test_the_summary_cli_rejects_an_invalid_identifier_without_echoing_it(tmp_path: Path) -> None:
    result = _run_cli(_sample(tmp_path), f"../{CANARY_POST_ID}")

    assert result.returncode == 2
    assert result.stdout == ""
    for canary in CANARIES:
        assert canary not in result.stdout + result.stderr
