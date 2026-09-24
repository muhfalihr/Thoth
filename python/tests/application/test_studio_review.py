"""The review service authenticates the author and never runs without storage."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from thoth_control_plane.application.studio_review import StudioReviewService
from thoth_control_plane.application.studio_review_ports import StudioReviewPersistenceError
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.models import ActorSnapshot
from thoth_control_plane.domain.studio_review import (
    CreateComment,
    CreateDecision,
    ReviewComment,
    ReviewCommentPage,
    ReviewDecision,
    ReviewDecisionPage,
)

NOW = datetime(2026, 9, 24, 9, 0, tzinfo=UTC)
ACTOR = Actor(actor_id="owner", actor_type="user")


class RecordingRepository:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def create_comment(self, **arguments: object) -> ReviewComment:
        self.calls.append(("create_comment", arguments))
        request = arguments["request"]
        assert isinstance(request, CreateComment)
        return ReviewComment(
            comment_id="rev_1",
            project_id="project_001",
            document_id="edoc_abc123",
            document_revision=request.base_revision,
            actor=arguments["actor"],
            text=request.text,
            created_at=NOW,
        )

    async def create_decision(self, **arguments: object) -> ReviewDecision:
        self.calls.append(("create_decision", arguments))
        return ReviewDecision(
            decision_id="rev_2",
            project_id="project_001",
            document_id="edoc_abc123",
            document_revision=3,
            actor=arguments["actor"],
            decision="approved",
            created_at=NOW,
        )

    async def list_comments(self, **arguments: object) -> ReviewCommentPage:
        self.calls.append(("list_comments", arguments))
        return ReviewCommentPage()

    async def list_decisions(self, **arguments: object) -> ReviewDecisionPage:
        self.calls.append(("list_decisions", arguments))
        return ReviewDecisionPage()


@pytest.mark.asyncio
async def test_a_comment_is_attributed_to_the_authenticated_actor() -> None:
    repository = RecordingRepository()
    request = CreateComment(base_revision=3, operation_id="op_1", text="Check")

    comment = await StudioReviewService(repository).create_comment(
        "project_001", "edoc_abc123", request, ACTOR
    )

    assert comment.actor == ActorSnapshot(actor_id="owner", actor_type="user")
    assert repository.calls == [
        (
            "create_comment",
            {
                "project_id": "project_001",
                "document_id": "edoc_abc123",
                "request": request,
                "actor": ActorSnapshot(actor_id="owner", actor_type="user"),
            },
        )
    ]


@pytest.mark.asyncio
async def test_a_decision_and_both_lists_pass_the_exact_project_scope() -> None:
    repository = RecordingRepository()
    service = StudioReviewService(repository)
    request = CreateDecision(base_revision=3, operation_id="op_2", decision="approved")

    await service.create_decision("project_001", "edoc_abc123", request, ACTOR)
    await service.list_comments("project_001", "edoc_abc123", limit=5, cursor=None)
    await service.list_decisions("project_001", "edoc_abc123", limit=5, cursor="abc")

    assert [name for name, _ in repository.calls] == [
        "create_decision",
        "list_comments",
        "list_decisions",
    ]
    assert repository.calls[2][1] == {
        "project_id": "project_001",
        "document_id": "edoc_abc123",
        "limit": 5,
        "cursor": "abc",
    }


@pytest.mark.asyncio
async def test_every_operation_is_unavailable_without_review_storage() -> None:
    service = StudioReviewService(None)
    request = CreateComment(base_revision=3, operation_id="op_1", text="Check")

    with pytest.raises(StudioReviewPersistenceError):
        await service.create_comment("project_001", "edoc_abc123", request, ACTOR)
    with pytest.raises(StudioReviewPersistenceError):
        await service.list_decisions("project_001", "edoc_abc123", limit=5, cursor=None)
