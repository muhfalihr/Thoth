"""Tests for revision-bound Studio review contracts and review eligibility."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from tests.domain.edit_document_v2_fixtures import clip_by_id, document_v2_payload, track_by_id
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.edit_documents import EditDocumentV1
from thoth_control_plane.domain.studio_review import (
    CreateComment,
    CreateDecision,
    ReviewComment,
    ReviewCommentPage,
    ReviewDecision,
    ReviewRevisionConflictBody,
    review_blocking_issues,
)

ACTOR = {"actor_id": "user_owner", "actor_type": "user", "display_name": "Owner"}
CREATED_AT = datetime(2026, 9, 24, 9, 0, tzinfo=UTC)


def v1_document(heading: str = "Title") -> EditDocumentV1:
    return EditDocumentV1.model_validate(
        {
            "schema_version": 1,
            "document_id": "edoc_abc123",
            "project_id": "project_001",
            "revision": 1,
            "template": {"template_id": "vertical_text_story", "version": 1},
            "canvas": {"width": 1080, "height": 1920, "fps": 30, "duration_in_frames": 90},
            "scenes": [
                {
                    "scene_id": "scene_001",
                    "role": "title",
                    "start_frame": 0,
                    "duration_in_frames": 90,
                    "clip_ids": ["clip_001"],
                }
            ],
            "tracks": [{"track_id": "track_visual", "kind": "visual", "clip_ids": ["clip_001"]}],
            "clips": [
                {
                    "kind": "text",
                    "clip_id": "clip_001",
                    "scene_id": "scene_001",
                    "track_id": "track_visual",
                    "start_frame": 0,
                    "duration_in_frames": 90,
                    "heading": heading,
                    "body": "",
                    "style_slot": "title",
                    "ownership": "ai_managed",
                }
            ],
        }
    )


def test_a_comment_carries_bounded_plain_text_and_an_optional_frame() -> None:
    comment = CreateComment(
        base_revision=3, operation_id="op_review_1", text="Check title", frame=29
    )

    assert comment.frame == 29
    assert (
        CreateComment(base_revision=3, operation_id="op_review_2", text="Whole cut").frame is None
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"text": " "},
        {"text": ""},
        {"text": "x" * 2_001},
        {"text": "bell\x07"},
        {"frame": -1},
        {"base_revision": 0},
        {"operation_id": "1_starts_with_digit"},
        {"operation_id": "op review"},
        {"actor": ACTOR},
    ],
)
def test_a_comment_rejects_blank_oversized_or_unsafe_input(overrides: dict[str, object]) -> None:
    payload: dict[str, object] = {"base_revision": 3, "operation_id": "op_review_1", "text": "Ok"}

    with pytest.raises(ValidationError):
        CreateComment.model_validate(payload | overrides)


def test_a_comment_keeps_line_breaks_in_plain_text() -> None:
    comment = CreateComment(base_revision=1, operation_id="op_review_1", text="One\nTwo\tthree")

    assert comment.text == "One\nTwo\tthree"


def test_a_decision_is_approved_or_changes_requested_with_an_optional_reason() -> None:
    approved = CreateDecision(base_revision=2, operation_id="op_decide_1", decision="approved")
    changes = CreateDecision(
        base_revision=2,
        operation_id="op_decide_2",
        decision="changes_requested",
        reason="Tighten the hook",
    )

    assert approved.reason is None
    assert changes.reason == "Tighten the hook"
    for bad in ({"decision": "rejected"}, {"decision": "approved", "reason": "  "}):
        with pytest.raises(ValidationError):
            CreateDecision.model_validate({"base_revision": 2, "operation_id": "op_d"} | bad)


def test_review_records_expose_only_public_fields() -> None:
    comment = ReviewComment(
        comment_id="rev_comment_1",
        project_id="project_001",
        document_id="edoc_abc123",
        document_revision=3,
        actor=ACTOR,
        text="Check title",
        frame=None,
        created_at=CREATED_AT,
    )
    decision = ReviewDecision(
        decision_id="rev_decision_1",
        project_id="project_001",
        document_id="edoc_abc123",
        document_revision=3,
        actor=ACTOR,
        decision="approved",
        reason=None,
        created_at=CREATED_AT,
    )

    assert set(comment.model_dump()) == {
        "comment_id",
        "project_id",
        "document_id",
        "document_revision",
        "actor",
        "text",
        "frame",
        "created_at",
    }
    assert decision.decision == "approved"
    assert ReviewCommentPage(comments=[comment]).comments == (comment,)
    with pytest.raises(ValidationError):
        ReviewCommentPage(comments=[comment] * 51)


def test_a_stale_review_write_conflict_reports_only_the_latest_revision() -> None:
    body = ReviewRevisionConflictBody(latest_revision=4)

    assert body.model_dump() == {"code": "review_revision_conflict", "latest_revision": 4}


def test_a_clean_saved_document_has_no_blocking_issue() -> None:
    assert review_blocking_issues(EditDocumentV2.model_validate(document_v2_payload())) == ()
    assert review_blocking_issues(v1_document()) == ()


def test_a_main_track_gap_blocks_review_approval() -> None:
    payload = document_v2_payload()
    main = clip_by_id(payload, "clip_main")
    main["from_frame"] = 30
    main["duration_in_frames"] = 270

    assert review_blocking_issues(EditDocumentV2.model_validate(payload)) == ("main_track_gap",)


def test_overlapping_clips_on_one_track_block_review_approval() -> None:
    payload = document_v2_payload()
    clip_by_id(payload, "clip_002")["from_frame"] = 100
    clip_by_id(payload, "clip_002")["scene_id"] = None

    assert review_blocking_issues(EditDocumentV2.model_validate(payload)) == ("clip_overlap",)


def test_empty_tracks_do_not_block_because_the_studio_never_reports_them() -> None:
    payload = document_v2_payload()

    assert track_by_id(payload, "track_music")["clip_ids"] == []
    assert review_blocking_issues(EditDocumentV2.model_validate(payload)) == ()


def test_a_blank_saved_heading_blocks_review_approval() -> None:
    payload = document_v2_payload()
    clip_by_id(payload, "clip_001")["heading"] = "   "

    assert review_blocking_issues(EditDocumentV2.model_validate(payload)) == ("text_invalid",)
    assert review_blocking_issues(v1_document(heading=" ")) == ("text_invalid",)
