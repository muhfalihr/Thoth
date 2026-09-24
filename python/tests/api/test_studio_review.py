"""Contract tests for the revision-bound Studio review endpoints.

The route layer owns authentication, project/document scoping from the path, a
server-supplied actor, and one fixed safe answer per failure. Revision binding
and idempotency themselves are proven against the repository.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from thoth_control_plane.api import create_app
from thoth_control_plane.application.studio_review_ports import (
    InvalidStudioReviewPage,
    StudioReviewDocumentNotFound,
    StudioReviewFrameOutOfRange,
    StudioReviewIdempotencyConflict,
    StudioReviewNotEligible,
    StudioReviewPersistenceError,
    StudioReviewRevisionConflict,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.studio_review import (
    ReviewComment,
    ReviewCommentPage,
    ReviewDecision,
    ReviewDecisionPage,
)

AUTH_HEADERS = {"Authorization": "Bearer test-key"}
DOCUMENT_URL = "/api/v1/projects/project_001/edit-documents/document_001"
COMMENTS_URL = f"{DOCUMENT_URL}/review-comments"
DECISIONS_URL = f"{DOCUMENT_URL}/review-decisions"
COMMENT_BODY = {"base_revision": 3, "operation_id": "op_review_1", "text": "Check the hook"}
DECISION_BODY = {"base_revision": 3, "operation_id": "op_review_3", "decision": "approved"}
NOW = datetime(2026, 9, 24, 9, 0, tzinfo=UTC)


class StubReviewRepository:
    """Answer from the request it was given, or fail once with a fixed error."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[str, dict[str, object]]] = []

    def _record(self, name: str, arguments: dict[str, object]) -> None:
        self.calls.append((name, arguments))
        if self.error is not None:
            raise self.error

    async def create_comment(self, **arguments: object) -> ReviewComment:
        self._record("create_comment", arguments)
        request = arguments["request"]
        return ReviewComment(
            comment_id="rev_comment_1",
            project_id=arguments["project_id"],
            document_id=arguments["document_id"],
            document_revision=request.base_revision,
            actor=arguments["actor"],
            text=request.text,
            frame=request.frame,
            created_at=NOW,
        )

    async def create_decision(self, **arguments: object) -> ReviewDecision:
        self._record("create_decision", arguments)
        request = arguments["request"]
        return ReviewDecision(
            decision_id="rev_decision_1",
            project_id=arguments["project_id"],
            document_id=arguments["document_id"],
            document_revision=request.base_revision,
            actor=arguments["actor"],
            decision=request.decision,
            reason=request.reason,
            created_at=NOW,
        )

    async def list_comments(self, **arguments: object) -> ReviewCommentPage:
        self._record("list_comments", arguments)
        return ReviewCommentPage(next_cursor="bmV4dA")

    async def list_decisions(self, **arguments: object) -> ReviewDecisionPage:
        self._record("list_decisions", arguments)
        return ReviewDecisionPage()


def client(gateway, repository: StubReviewRepository | None) -> httpx.AsyncClient:
    app = create_app(
        Settings(THOTH_CONTROL_PLANE_API_KEY="test-key"),
        gateway,
        studio_review_repository=repository,
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "url"),
    [
        ("GET", COMMENTS_URL),
        ("POST", COMMENTS_URL),
        ("GET", DECISIONS_URL),
        ("POST", DECISIONS_URL),
    ],
)
async def test_every_review_route_refuses_an_unauthenticated_caller(
    gateway, method: str, url: str
) -> None:
    repository = StubReviewRepository()
    async with client(gateway, repository) as http:
        response = await http.request(method, url, json=COMMENT_BODY)

    assert response.status_code == 403
    assert repository.calls == []


@pytest.mark.asyncio
async def test_a_decision_binds_the_saved_revision_and_the_server_actor(gateway) -> None:
    repository = StubReviewRepository()
    async with client(gateway, repository) as http:
        response = await http.post(DECISIONS_URL, json=DECISION_BODY, headers=AUTH_HEADERS)

    assert response.status_code == 201
    body = response.json()
    assert body["document_revision"] == 3
    assert body["decision"] == "approved"
    assert body["actor"] == {"actor_id": "owner", "actor_type": "user", "display_name": None}
    ((name, arguments),) = repository.calls
    assert (name, arguments["project_id"], arguments["document_id"]) == (
        "create_decision",
        "project_001",
        "document_001",
    )


@pytest.mark.asyncio
async def test_a_frame_anchored_comment_is_created_once(gateway) -> None:
    repository = StubReviewRepository()
    async with client(gateway, repository) as http:
        response = await http.post(
            COMMENTS_URL, json=COMMENT_BODY | {"frame": 29}, headers=AUTH_HEADERS
        )

    assert response.status_code == 201
    assert response.json()["frame"] == 29
    assert response.json()["text"] == "Check the hook"
    assert len(repository.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "body"),
    [
        (COMMENTS_URL, COMMENT_BODY | {"frame": -1}),
        (COMMENTS_URL, COMMENT_BODY | {"text": "   "}),
        (COMMENTS_URL, COMMENT_BODY | {"text": "x" * 2_001}),
        (COMMENTS_URL, COMMENT_BODY | {"actor": {"actor_id": "mallory", "actor_type": "user"}}),
        (DECISIONS_URL, DECISION_BODY | {"decision": "rejected"}),
        (DECISIONS_URL, DECISION_BODY | {"base_revision": 0}),
        (f"{DOCUMENT_URL.replace('project_001', 'bad project')}/review-comments", COMMENT_BODY),
    ],
)
async def test_invalid_review_input_is_rejected_before_storage(
    gateway, url: str, body: dict[str, object]
) -> None:
    repository = StubReviewRepository()
    async with client(gateway, repository) as http:
        response = await http.post(url, json=body, headers=AUTH_HEADERS)

    assert response.status_code == 422
    assert repository.calls == []


@pytest.mark.asyncio
async def test_a_stale_review_write_returns_only_the_latest_revision(gateway) -> None:
    repository = StubReviewRepository(StudioReviewRevisionConflict(latest_revision=4))
    async with client(gateway, repository) as http:
        response = await http.post(COMMENTS_URL, json=COMMENT_BODY, headers=AUTH_HEADERS)

    assert response.status_code == 409
    assert response.json() == {"code": "review_revision_conflict", "latest_revision": 4}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status_code", "detail"),
    [
        (StudioReviewDocumentNotFound(), 404, {"code": "review_document_not_found"}),
        (StudioReviewIdempotencyConflict(), 409, {"code": "idempotency_conflict"}),
        (StudioReviewFrameOutOfRange(), 400, {"code": "review_frame_out_of_range"}),
        (
            StudioReviewNotEligible(("main_track_gap",)),
            409,
            {"code": "review_not_eligible", "issues": ["main_track_gap"]},
        ),
        (StudioReviewPersistenceError(), 503, {"code": "review_unavailable"}),
    ],
)
async def test_every_review_write_failure_has_one_fixed_safe_answer(
    gateway, error: Exception, status_code: int, detail: dict[str, object]
) -> None:
    async with client(gateway, StubReviewRepository(error)) as http:
        response = await http.post(DECISIONS_URL, json=DECISION_BODY, headers=AUTH_HEADERS)

    assert response.status_code == status_code
    assert response.json() == {"detail": detail}


@pytest.mark.asyncio
async def test_lists_are_bounded_and_scoped_to_the_path(gateway) -> None:
    repository = StubReviewRepository()
    async with client(gateway, repository) as http:
        comments = await http.get(COMMENTS_URL, headers=AUTH_HEADERS)
        decisions = await http.get(
            DECISIONS_URL, params={"limit": 50, "cursor": "abc"}, headers=AUTH_HEADERS
        )
        oversized = await http.get(COMMENTS_URL, params={"limit": 51}, headers=AUTH_HEADERS)

    assert comments.json() == {"comments": [], "next_cursor": "bmV4dA"}
    assert decisions.json() == {"decisions": [], "next_cursor": None}
    assert oversized.status_code == 422
    assert repository.calls == [
        (
            "list_comments",
            {
                "project_id": "project_001",
                "document_id": "document_001",
                "limit": 20,
                "cursor": None,
            },
        ),
        (
            "list_decisions",
            {
                "project_id": "project_001",
                "document_id": "document_001",
                "limit": 50,
                "cursor": "abc",
            },
        ),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (InvalidStudioReviewPage(), 400, "invalid_review_page"),
        (StudioReviewPersistenceError(), 503, "review_unavailable"),
    ],
)
async def test_a_list_failure_has_one_fixed_safe_answer(
    gateway, error: Exception, status_code: int, code: str
) -> None:
    async with client(gateway, StubReviewRepository(error)) as http:
        response = await http.get(COMMENTS_URL, params={"cursor": "zz"}, headers=AUTH_HEADERS)

    assert response.status_code == status_code
    assert response.json() == {"detail": {"code": code}}


@pytest.mark.asyncio
async def test_review_is_unavailable_without_a_database(gateway) -> None:
    async with client(gateway, None) as http:
        response = await http.get(DECISIONS_URL, headers=AUTH_HEADERS)

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "review_unavailable"}}


class RevisionBoundReviews:
    """An in-memory store with the repository's revision contract, for one HTTP round trip."""

    def __init__(self, revision: int) -> None:
        self.revision = revision
        self.comments: list[ReviewComment] = []
        self.decisions: list[ReviewDecision] = []

    def _check(self, request) -> None:
        if request.base_revision != self.revision:
            raise StudioReviewRevisionConflict(latest_revision=self.revision)

    async def create_comment(self, *, project_id, document_id, request, actor) -> ReviewComment:
        self._check(request)
        record = ReviewComment(
            comment_id=f"comment_{len(self.comments)}",
            project_id=project_id,
            document_id=document_id,
            document_revision=request.base_revision,
            actor=actor,
            text=request.text,
            frame=request.frame,
            created_at=NOW,
        )
        self.comments.append(record)
        return record

    async def create_decision(self, *, project_id, document_id, request, actor) -> ReviewDecision:
        self._check(request)
        record = ReviewDecision(
            decision_id=f"decision_{len(self.decisions)}",
            project_id=project_id,
            document_id=document_id,
            document_revision=request.base_revision,
            actor=actor,
            decision=request.decision,
            reason=request.reason,
            created_at=NOW,
        )
        self.decisions.insert(0, record)
        return record

    async def list_comments(self, **_: object) -> ReviewCommentPage:
        return ReviewCommentPage(comments=tuple(self.comments))

    async def list_decisions(self, **_: object) -> ReviewDecisionPage:
        return ReviewDecisionPage(decisions=tuple(self.decisions))


@pytest.mark.asyncio
async def test_a_new_saved_revision_keeps_history_and_retires_the_current_approval(gateway) -> None:
    store = RevisionBoundReviews(revision=3)
    async with client(gateway, store) as http:
        await http.post(COMMENTS_URL, json=COMMENT_BODY | {"frame": 29}, headers=AUTH_HEADERS)
        await http.post(DECISIONS_URL, json=DECISION_BODY, headers=AUTH_HEADERS)
        store.revision = 4
        comments = (await http.get(COMMENTS_URL, headers=AUTH_HEADERS)).json()["comments"]
        decisions = (await http.get(DECISIONS_URL, headers=AUTH_HEADERS)).json()["decisions"]
        stale_response = await http.post(
            COMMENTS_URL, json=COMMENT_BODY | {"operation_id": "op_review_9"}, headers=AUTH_HEADERS
        )

    prior_decision = decisions[0]
    current_decision_for_revision_4 = next(
        (item for item in decisions[:1] if item["document_revision"] == 4), None
    )
    assert [item["document_revision"] for item in comments] == [3]
    assert comments[0]["frame"] == 29
    assert prior_decision["document_revision"] == 3
    assert prior_decision["decision"] == "approved"
    assert current_decision_for_revision_4 is None
    assert stale_response.status_code == 409
    assert stale_response.json() == {"code": "review_revision_conflict", "latest_revision": 4}
    assert len(store.comments) == 1
