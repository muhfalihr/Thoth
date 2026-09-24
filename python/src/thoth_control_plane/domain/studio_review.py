"""Revision-bound Studio review contracts and review eligibility.

A comment or decision is editorial metadata on one immutable saved revision. It
never approves a workflow, a Stage 1 gate, a render, or a publication, and a
newer saved revision leaves earlier records historical rather than rewriting
them. The actor always comes from server authentication, never from a request.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal, TypeAlias

from pydantic import AfterValidator, AwareDatetime, Field, field_validator

from thoth_control_plane.domain.edit_document_v2 import EditDocument, EditDocumentV2
from thoth_control_plane.domain.edit_documents import FrameStart
from thoth_control_plane.domain.models import ActorSnapshot, OpaqueId, ProjectId, StrictModel

# C0 controls other than tab, line feed, and carriage return, plus DEL.
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _plain_text(value: str) -> str:
    if not value.strip():
        raise ValueError("review text must not be blank")
    if _CONTROL_CHARACTERS.search(value):
        raise ValueError("review text must be plain text")
    return value


ReviewText: TypeAlias = Annotated[
    str, Field(min_length=1, max_length=2_000), AfterValidator(_plain_text)
]
ReviewDecisionKind: TypeAlias = Literal["approved", "changes_requested"]
ReviewIssueCode: TypeAlias = Literal[
    "main_track_gap", "clip_overlap", "clip_exceeds_canvas", "track_empty", "text_invalid"
]
Revision: TypeAlias = Annotated[int, Field(gt=0)]
Timestamp: TypeAlias = Annotated[AwareDatetime, Field(strict=False)]
PAGE_LIMIT = 50


class CreateComment(StrictModel):
    """A plain-text comment on the saved revision the caller last saw."""

    base_revision: Revision
    operation_id: OpaqueId
    text: ReviewText
    frame: FrameStart | None = None


class CreateDecision(StrictModel):
    """An editorial decision on the saved revision the caller last saw."""

    base_revision: Revision
    operation_id: OpaqueId
    decision: ReviewDecisionKind
    reason: ReviewText | None = None


class ReviewComment(StrictModel):
    comment_id: OpaqueId
    project_id: ProjectId
    document_id: OpaqueId
    document_revision: Revision
    actor: ActorSnapshot
    text: ReviewText
    frame: FrameStart | None = None
    created_at: Timestamp


class ReviewDecision(StrictModel):
    decision_id: OpaqueId
    project_id: ProjectId
    document_id: OpaqueId
    document_revision: Revision
    actor: ActorSnapshot
    decision: ReviewDecisionKind
    reason: ReviewText | None = None
    created_at: Timestamp


class ReviewCommentPage(StrictModel):
    """Bounded oldest-first comment page with an opaque cursor."""

    comments: Annotated[tuple[ReviewComment, ...], Field(max_length=PAGE_LIMIT)] = ()
    next_cursor: str | None = None

    @field_validator("comments", mode="before")
    @classmethod
    def _coerce_comments(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value


class ReviewDecisionPage(StrictModel):
    """Bounded newest-first decision page with an opaque cursor."""

    decisions: Annotated[tuple[ReviewDecision, ...], Field(max_length=PAGE_LIMIT)] = ()
    next_cursor: str | None = None

    @field_validator("decisions", mode="before")
    @classmethod
    def _coerce_decisions(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value


class ReviewRevisionConflictBody(StrictModel):
    """Typed 409 body: the review targeted a revision that is no longer the latest."""

    code: Literal["review_revision_conflict"] = "review_revision_conflict"
    latest_revision: Revision


def review_blocking_issues(document: EditDocument) -> tuple[ReviewIssueCode, ...]:
    """Issues that block approval, mirroring the Studio's `timelineIssues` and text checks.

    The Studio declares `track_empty` but never reports it, so neither does this.
    """
    issues: list[ReviewIssueCode] = [
        "text_invalid"
        for clip in document.clips
        if clip.kind == "text" and not clip.heading.strip()
    ]
    if not isinstance(document, EditDocumentV2):
        return tuple(issues)
    for track in sorted(document.tracks, key=lambda item: item.order):
        expected_start = 0
        clips = sorted(
            (clip for clip in document.clips if clip.track_id == track.track_id),
            key=lambda clip: clip.from_frame,
        )
        for clip in clips:
            if track.kind == "main_video" and clip.from_frame > expected_start:
                issues.append("main_track_gap")
            if clip.from_frame < expected_start:
                issues.append("clip_overlap")
            if clip.end_frame > document.canvas.duration_in_frames:
                issues.append("clip_exceeds_canvas")
            expected_start = max(expected_start, clip.end_frame)
    return tuple(issues)
