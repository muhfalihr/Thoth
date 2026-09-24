"""Port and safe failures for revision-bound Studio review persistence.

Every exception carries a fixed safe message; structured facts a route may show
(the latest revision, the blocking issue codes) travel as attributes.
"""

from __future__ import annotations

from typing import Protocol

from thoth_control_plane.domain.models import ActorSnapshot
from thoth_control_plane.domain.studio_review import (
    CreateComment,
    CreateDecision,
    ReviewComment,
    ReviewCommentPage,
    ReviewDecision,
    ReviewDecisionPage,
    ReviewIssueCode,
)


class StudioReviewPersistenceError(Exception):
    """Raised when review storage is unusable, with nothing to leak."""

    def __init__(self) -> None:
        super().__init__("studio review persistence unavailable")


class StudioReviewDocumentNotFound(Exception):
    """Raised when the project owns no saved document with this ID."""

    def __init__(self) -> None:
        super().__init__("studio review document not found")


class StudioReviewRevisionConflict(Exception):
    """Raised when a review targets a revision that is no longer the latest."""

    def __init__(self, latest_revision: int) -> None:
        super().__init__("studio review revision conflict")
        self.latest_revision = latest_revision


class StudioReviewIdempotencyConflict(Exception):
    """Raised when one operation ID is reused for a different review request."""

    def __init__(self) -> None:
        super().__init__("studio review idempotency conflict")


class StudioReviewFrameOutOfRange(Exception):
    """Raised when a comment anchors a frame outside the saved revision."""

    def __init__(self) -> None:
        super().__init__("studio review frame out of range")


class StudioReviewNotEligible(Exception):
    """Raised when an approval targets a saved revision with blocking issues."""

    def __init__(self, issues: tuple[ReviewIssueCode, ...]) -> None:
        super().__init__("studio review approval blocked")
        self.issues = issues


class InvalidStudioReviewPage(Exception):
    """Raised when a page cursor was not issued here or a limit is out of range."""

    def __init__(self) -> None:
        super().__init__("studio review page invalid")


class StudioReviewRepository(Protocol):
    """Append-only review store; every write binds to the locked latest revision."""

    async def create_comment(
        self,
        *,
        project_id: str,
        document_id: str,
        request: CreateComment,
        actor: ActorSnapshot,
    ) -> ReviewComment: ...

    async def create_decision(
        self,
        *,
        project_id: str,
        document_id: str,
        request: CreateDecision,
        actor: ActorSnapshot,
    ) -> ReviewDecision: ...

    async def list_comments(
        self, *, project_id: str, document_id: str, limit: int, cursor: str | None
    ) -> ReviewCommentPage: ...

    async def list_decisions(
        self, *, project_id: str, document_id: str, limit: int, cursor: str | None
    ) -> ReviewDecisionPage: ...
