"""Tests for the E1 revision-bound render job contracts and state machine."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from thoth_control_plane.domain.render_jobs import (
    ACTIVE_RENDER_STATUSES,
    ALLOWED_TRANSITIONS,
    RENDER_FAILURE_CODES,
    TERMINAL_RENDER_STATUSES,
    InvalidRenderEvent,
    InvalidRenderTransition,
    RenderCapability,
    RenderJob,
    RenderJobEvent,
    RenderJobPage,
    RenderOutputFacts,
    RenderProvenance,
    apply_render_event,
    mark_cancel_requested,
)

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
LATER = datetime(2026, 9, 20, 12, 5, tzinfo=UTC)
CHECKSUM = "sha256:" + "a" * 64
ASSET_CHECKSUM = "sha256:" + "b" * 64
OUTPUT_PATH = "renders/rj_1/output.mp4"


def fixture_output(**overrides: object) -> RenderOutputFacts:
    payload: dict[str, object] = {
        "media_type": "video/mp4",
        "size_bytes": 2_048_000,
        "checksum": CHECKSUM,
        "codec": "h264",
        "width": 1080,
        "height": 1920,
        "fps": 30.0,
        "duration_seconds": 20.0,
        "has_audio": True,
    }
    payload.update(overrides)
    return RenderOutputFacts.model_validate(payload)


def fixture_provenance(**overrides: object) -> RenderProvenance:
    payload: dict[str, object] = {
        "document_revision": 7,
        "template_id": "vertical_text_story",
        "template_version": 1,
        "preset_id": "standard_vertical_mp4_v1",
        "renderer_version": "remotion-4.0.523",
        "asset_checksums": ({"asset_id": "asset_main", "checksum": ASSET_CHECKSUM},),
        "output": None,
    }
    payload.update(overrides)
    return RenderProvenance.model_validate(payload)


def fixture_job(**overrides: object) -> RenderJob:
    payload: dict[str, object] = {
        "render_job_id": "rj_1",
        "project_id": "project_alpha",
        "document_id": "doc_1",
        "document_revision": 7,
        "dispatch_id": "dispatch_1",
        "template_id": "vertical_text_story",
        "template_version": 1,
        "preset_id": "standard_vertical_mp4_v1",
        "renderer_version": "remotion-4.0.523",
        "status": "preparing",
        "last_event_sequence": 0,
        "created_by": "user_1",
        "created_at": NOW,
        "provenance": fixture_provenance(),
    }
    payload.update(overrides)
    return RenderJob.model_validate(payload)


def terminal_job(status: str, **overrides: object) -> RenderJob:
    payload: dict[str, object] = {
        "status": status,
        "last_event_sequence": 8,
        "finished_at": NOW,
    }
    if status == "completed":
        payload["output_relative_path"] = OUTPUT_PATH
        payload["output"] = fixture_output()
        payload["provenance"] = fixture_provenance(output=fixture_output())
    if status == "failed":
        payload["failure_code"] = "render_engine_failed"
    if status == "cancelled":
        payload["cancel_requested_at"] = NOW
    payload.update(overrides)
    return fixture_job(**payload)


def fixture_event(**overrides: object) -> RenderJobEvent:
    payload: dict[str, object] = {
        "render_job_id": "rj_1",
        "dispatch_id": "dispatch_1",
        "sequence": 1,
        "status": "rendering",
        "occurred_at": LATER,
    }
    payload.update(overrides)
    return RenderJobEvent.model_validate(payload)


def terminal_event(status: str, **overrides: object) -> RenderJobEvent:
    payload: dict[str, object] = {"status": status}
    if status == "completed":
        payload["output"] = fixture_output()
        payload["output_relative_path"] = OUTPUT_PATH
    if status == "failed":
        payload["failure_code"] = "render_engine_failed"
    payload.update(overrides)
    return fixture_event(**payload)


def event_for(status: str, **overrides: object) -> RenderJobEvent:
    if status in TERMINAL_RENDER_STATUSES:
        return terminal_event(status, **overrides)
    return fixture_event(status=status, **overrides)


# --- status sets and transition table -------------------------------------


def test_status_sets_partition_the_lifecycle() -> None:
    assert frozenset({"preparing", "rendering", "finalizing"}) == ACTIVE_RENDER_STATUSES
    assert frozenset({"completed", "failed", "cancelled"}) == TERMINAL_RENDER_STATUSES
    assert ACTIVE_RENDER_STATUSES.isdisjoint(TERMINAL_RENDER_STATUSES)
    assert set(ALLOWED_TRANSITIONS) == ACTIVE_RENDER_STATUSES | TERMINAL_RENDER_STATUSES


def test_terminal_statuses_allow_no_further_transition() -> None:
    assert all(ALLOWED_TRANSITIONS[status] == frozenset() for status in TERMINAL_RENDER_STATUSES)


def test_every_active_status_can_fail_and_cancel() -> None:
    assert all(
        {"failed", "cancelled"} <= ALLOWED_TRANSITIONS[status] for status in ACTIVE_RENDER_STATUSES
    )


@pytest.mark.parametrize(
    ("current", "following"),
    sorted(
        (current, following)
        for current, allowed in ALLOWED_TRANSITIONS.items()
        for following in allowed
    ),
)
def test_every_allowed_edge_is_applied(current: str, following: str) -> None:
    job = fixture_job(status=current, last_event_sequence=2)
    updated = apply_render_event(job, event_for(following, sequence=3), LATER)

    assert updated.status == following
    assert updated.last_event_sequence == 3


@pytest.mark.parametrize(
    ("current", "following"),
    sorted(
        (current, following)
        for current, allowed in ALLOWED_TRANSITIONS.items()
        for following in ACTIVE_RENDER_STATUSES
        if current in ACTIVE_RENDER_STATUSES and following != current and following not in allowed
    ),
)
def test_every_forbidden_active_edge_is_rejected(current: str, following: str) -> None:
    job = fixture_job(status=current, last_event_sequence=2)

    with pytest.raises(InvalidRenderTransition):
        apply_render_event(job, event_for(following, sequence=3), LATER)


# --- terminal immutability and event ordering -----------------------------


@pytest.mark.parametrize("status", sorted(TERMINAL_RENDER_STATUSES))
def test_terminal_jobs_ignore_every_later_event(status: str) -> None:
    job = terminal_job(status)

    assert apply_render_event(job, fixture_event(sequence=9), LATER) == job


def test_late_completion_cannot_resurrect_cancelled_job() -> None:
    cancelled = terminal_job("cancelled", last_event_sequence=8)
    late = terminal_event("completed", sequence=9)

    assert apply_render_event(cancelled, late, NOW) == cancelled


def test_duplicate_event_sequence_is_a_no_op() -> None:
    job = fixture_job(status="rendering", last_event_sequence=4)

    assert apply_render_event(job, fixture_event(sequence=4, status="finalizing"), LATER) == job


def test_older_event_sequence_is_a_no_op() -> None:
    job = fixture_job(status="rendering", last_event_sequence=4)

    assert apply_render_event(job, fixture_event(sequence=3, status="finalizing"), LATER) == job


def test_event_sequence_must_be_positive() -> None:
    with pytest.raises(ValidationError):
        fixture_event(sequence=0)


def test_event_for_another_job_is_rejected() -> None:
    job = fixture_job(status="rendering", last_event_sequence=1)

    with pytest.raises(InvalidRenderEvent):
        apply_render_event(job, fixture_event(render_job_id="rj_2", sequence=2), LATER)


def test_event_from_a_stale_dispatch_is_rejected() -> None:
    job = fixture_job(status="rendering", last_event_sequence=1)

    with pytest.raises(InvalidRenderEvent):
        apply_render_event(job, fixture_event(dispatch_id="dispatch_0", sequence=2), LATER)


# --- progress -------------------------------------------------------------


def test_progress_is_recorded_when_reported() -> None:
    job = fixture_job(status="rendering", last_event_sequence=1)

    updated = apply_render_event(
        job, fixture_event(sequence=2, status="rendering", progress_percent=40), LATER
    )

    assert updated.progress_percent == 40
    assert updated.status == "rendering"


def test_progress_never_decreases() -> None:
    job = fixture_job(status="rendering", last_event_sequence=1, progress_percent=60)

    updated = apply_render_event(
        job, fixture_event(sequence=2, status="rendering", progress_percent=10), LATER
    )

    assert updated.progress_percent == 60


def test_progress_survives_an_event_without_progress() -> None:
    job = fixture_job(status="rendering", last_event_sequence=1, progress_percent=60)

    updated = apply_render_event(job, fixture_event(sequence=2, status="finalizing"), LATER)

    assert updated.progress_percent == 60


@pytest.mark.parametrize("percent", [-1, 101])
def test_progress_outside_zero_to_one_hundred_is_rejected(percent: int) -> None:
    with pytest.raises(ValidationError):
        fixture_event(progress_percent=percent)


# --- completion requirements ----------------------------------------------


def test_completion_requires_validated_output_facts() -> None:
    job = fixture_job(status="finalizing", last_event_sequence=2)

    with pytest.raises(InvalidRenderEvent):
        apply_render_event(job, fixture_event(sequence=3, status="completed"), LATER)


def test_completion_requires_the_published_relative_path() -> None:
    job = fixture_job(status="finalizing", last_event_sequence=2)
    event = fixture_event(sequence=3, status="completed", output=fixture_output())

    with pytest.raises(InvalidRenderEvent):
        apply_render_event(job, event, LATER)


def test_completion_records_output_provenance_and_finish_time() -> None:
    job = fixture_job(status="finalizing", last_event_sequence=2, started_at=NOW)

    updated = apply_render_event(job, terminal_event("completed", sequence=3), LATER)

    assert updated.status == "completed"
    assert updated.output == fixture_output()
    assert updated.output_relative_path == OUTPUT_PATH
    assert updated.provenance.output == fixture_output()
    assert updated.finished_at == LATER


def test_completed_job_without_output_is_invalid() -> None:
    with pytest.raises(ValidationError):
        fixture_job(status="completed", finished_at=NOW)


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_unsuccessful_jobs_never_carry_output(status: str) -> None:
    with pytest.raises(ValidationError):
        terminal_job(status, output=fixture_output(), output_relative_path=OUTPUT_PATH)


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_unsuccessful_events_never_carry_output(status: str) -> None:
    job = fixture_job(status="rendering", last_event_sequence=2)
    event_kwargs: dict[str, object] = {"sequence": 3, "output": fixture_output()}
    if status == "failed":
        event_kwargs["failure_code"] = "render_engine_failed"

    with pytest.raises(InvalidRenderEvent):
        apply_render_event(job, fixture_event(status=status, **event_kwargs), LATER)


def test_output_path_must_stay_relative_and_bounded() -> None:
    for unsafe in ("../renders/rj_1/output.mp4", "/tmp/output.mp4", "C:/output.mp4"):
        with pytest.raises(ValidationError):
            terminal_event("completed", output_relative_path=unsafe)


def test_output_media_type_and_codec_are_the_server_owned_preset() -> None:
    with pytest.raises(ValidationError):
        fixture_output(media_type="video/webm")
    with pytest.raises(ValidationError):
        fixture_output(codec="vp9")


# --- failure codes --------------------------------------------------------


def test_failure_codes_are_a_bounded_safe_set() -> None:
    assert (
        frozenset(
            {
                "render_asset_unavailable",
                "render_bundle_invalid",
                "render_deadline_exceeded",
                "render_dispatch_failed",
                "render_engine_failed",
                "render_output_invalid",
                "render_storage_failed",
                "renderer_unavailable",
            }
        )
        == RENDER_FAILURE_CODES
    )


def test_failure_requires_a_known_code() -> None:
    job = fixture_job(status="rendering", last_event_sequence=2)

    with pytest.raises(InvalidRenderEvent):
        apply_render_event(job, fixture_event(sequence=3, status="failed"), LATER)


def test_unknown_failure_code_is_rejected_by_the_contract() -> None:
    with pytest.raises(ValidationError):
        fixture_event(status="failed", failure_code="disk full: /var/lib/renders")


def test_failure_records_the_code_and_finish_time() -> None:
    job = fixture_job(status="rendering", last_event_sequence=2)

    updated = apply_render_event(job, terminal_event("failed", sequence=3), LATER)

    assert updated.status == "failed"
    assert updated.failure_code == "render_engine_failed"
    assert updated.finished_at == LATER


def test_only_failed_jobs_carry_a_failure_code() -> None:
    with pytest.raises(ValidationError):
        fixture_job(status="rendering", failure_code="render_engine_failed")


# --- start and cancel -----------------------------------------------------


def test_first_rendering_event_records_the_start_time() -> None:
    job = fixture_job(status="preparing", last_event_sequence=1)

    updated = apply_render_event(job, fixture_event(sequence=2, status="rendering"), LATER)

    assert updated.started_at == LATER


def test_cancel_request_is_recorded_once_and_is_idempotent() -> None:
    job = fixture_job(status="rendering", last_event_sequence=2)

    requested = mark_cancel_requested(job, NOW)
    assert requested.cancel_requested_at == NOW
    assert requested.status == "rendering"

    assert mark_cancel_requested(requested, LATER) == requested


@pytest.mark.parametrize("status", sorted(TERMINAL_RENDER_STATUSES))
def test_cancel_request_is_refused_for_a_terminal_job(status: str) -> None:
    with pytest.raises(InvalidRenderTransition):
        mark_cancel_requested(terminal_job(status), LATER)


def test_cancelled_job_records_the_finish_time() -> None:
    job = mark_cancel_requested(fixture_job(status="rendering", last_event_sequence=2), NOW)

    updated = apply_render_event(job, terminal_event("cancelled", sequence=3), LATER)

    assert updated.status == "cancelled"
    assert updated.finished_at == LATER
    assert updated.cancel_requested_at == NOW


def test_completion_wins_when_it_arrives_before_the_cancel_confirmation() -> None:
    requested = mark_cancel_requested(fixture_job(status="finalizing", last_event_sequence=2), NOW)

    completed = apply_render_event(requested, terminal_event("completed", sequence=3), LATER)
    assert completed.status == "completed"

    assert (
        apply_render_event(completed, terminal_event("cancelled", sequence=4), LATER) == completed
    )


# --- retry lineage --------------------------------------------------------


def test_retry_job_records_its_source_lineage() -> None:
    retry = fixture_job(render_job_id="rj_2", retry_of_job_id="rj_1")

    assert retry.retry_of_job_id == "rj_1"


def test_a_job_never_retries_itself() -> None:
    with pytest.raises(ValidationError):
        fixture_job(retry_of_job_id="rj_1")


# --- bounded page and capability ------------------------------------------


def test_history_page_is_bounded_and_carries_an_opaque_cursor() -> None:
    page = RenderJobPage(jobs=(fixture_job(),), next_cursor="cursor_1")

    assert page.jobs[0].render_job_id == "rj_1"
    assert page.next_cursor == "cursor_1"


def test_capability_requires_a_reason_when_render_is_unavailable() -> None:
    unavailable = RenderCapability(
        available=False,
        reason="renderer_not_configured",
        preset_id="standard_vertical_mp4_v1",
        renderer_version="remotion-4.0.523",
    )
    assert unavailable.active_render_job_id is None

    with pytest.raises(ValidationError):
        RenderCapability(
            available=False,
            preset_id="standard_vertical_mp4_v1",
            renderer_version="remotion-4.0.523",
        )
    with pytest.raises(ValidationError):
        RenderCapability(
            available=True,
            reason="render_busy",
            preset_id="standard_vertical_mp4_v1",
            renderer_version="remotion-4.0.523",
        )


def test_job_contract_never_accepts_an_absolute_or_secret_bearing_field() -> None:
    with pytest.raises(ValidationError):
        fixture_job(renderer_url="http://remotion-renderer:8080")
    with pytest.raises(ValidationError):
        fixture_job(output_relative_path="/var/lib/thoth/renders/rj_1/output.mp4")
