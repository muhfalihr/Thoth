"""Revision-bound Studio review: attribute to the authenticated actor, then persist.

Revision, frame, eligibility, and idempotency checks belong to the repository,
which runs them under the document lock; this service only supplies the author
and degrades to "unavailable" when no review storage is configured.
"""

from __future__ import annotations

from thoth_control_plane.application.studio_review_ports import (
    StudioReviewPersistenceError,
    StudioReviewRepository,
)
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


def _snapshot(actor: Actor) -> ActorSnapshot:
    return ActorSnapshot.model_validate(actor.model_dump())


class StudioReviewService:
    def __init__(self, repository: StudioReviewRepository | None) -> None:
        self._repository = repository

    def _store(self) -> StudioReviewRepository:
        if self._repository is None:
            raise StudioReviewPersistenceError()
        return self._repository

    async def create_comment(
        self, project_id: str, document_id: str, request: CreateComment, actor: Actor
    ) -> ReviewComment:
        return await self._store().create_comment(
            project_id=project_id, document_id=document_id, request=request, actor=_snapshot(actor)
        )

    async def create_decision(
        self, project_id: str, document_id: str, request: CreateDecision, actor: Actor
    ) -> ReviewDecision:
        return await self._store().create_decision(
            project_id=project_id, document_id=document_id, request=request, actor=_snapshot(actor)
        )

    async def list_comments(
        self, project_id: str, document_id: str, *, limit: int, cursor: str | None
    ) -> ReviewCommentPage:
        return await self._store().list_comments(
            project_id=project_id, document_id=document_id, limit=limit, cursor=cursor
        )

    async def list_decisions(
        self, project_id: str, document_id: str, *, limit: int, cursor: str | None
    ) -> ReviewDecisionPage:
        return await self._store().list_decisions(
            project_id=project_id, document_id=document_id, limit=limit, cursor=cursor
        )
