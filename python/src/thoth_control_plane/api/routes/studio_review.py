"""Authenticated, project-scoped Studio review comments and editorial decisions.

A decision here is editorial metadata on one saved revision. It is not workflow
approval, Stage 1 approval, or render/publish authorization.
"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse

from thoth_control_plane.api.dependencies import current_actor
from thoth_control_plane.application.studio_review import StudioReviewService
from thoth_control_plane.application.studio_review_ports import (
    InvalidStudioReviewPage,
    StudioReviewDocumentNotFound,
    StudioReviewFrameOutOfRange,
    StudioReviewIdempotencyConflict,
    StudioReviewNotEligible,
    StudioReviewPersistenceError,
    StudioReviewRevisionConflict,
)
from thoth_control_plane.domain import Actor
from thoth_control_plane.domain.models import OpaqueId, ProjectId
from thoth_control_plane.domain.studio_review import (
    PAGE_LIMIT,
    CreateComment,
    CreateDecision,
    ReviewComment,
    ReviewCommentPage,
    ReviewDecision,
    ReviewDecisionPage,
    ReviewRevisionConflictBody,
)

router = APIRouter()
T = TypeVar("T")

DOCUMENT_PATH = "/projects/{project_id}/edit-documents/{document_id}"

#: Every review failure the public surface is allowed to describe.
_ERRORS: tuple[tuple[type[Exception], int, str], ...] = (
    (StudioReviewDocumentNotFound, status.HTTP_404_NOT_FOUND, "review_document_not_found"),
    (StudioReviewIdempotencyConflict, status.HTTP_409_CONFLICT, "idempotency_conflict"),
    (StudioReviewFrameOutOfRange, status.HTTP_400_BAD_REQUEST, "review_frame_out_of_range"),
    (InvalidStudioReviewPage, status.HTTP_400_BAD_REQUEST, "invalid_review_page"),
    (StudioReviewPersistenceError, status.HTTP_503_SERVICE_UNAVAILABLE, "review_unavailable"),
)
_CONFLICT = {status.HTTP_409_CONFLICT: {"model": ReviewRevisionConflictBody}}


def get_studio_review_service(request: Request) -> StudioReviewService:
    return request.app.state.studio_review_service


ActorDependency = Annotated[Actor, Depends(current_actor)]
ServiceDependency = Annotated[StudioReviewService, Depends(get_studio_review_service)]
Limit = Annotated[int, Query(ge=1, le=PAGE_LIMIT)]
Cursor = Annotated[str | None, Query(min_length=1, max_length=256)]


async def _safely(call: Awaitable[T]) -> T | JSONResponse:
    """Answer one review call, or its fixed safe failure."""
    try:
        return await call
    except StudioReviewRevisionConflict as error:
        body = ReviewRevisionConflictBody(latest_revision=error.latest_revision)
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=body.model_dump())
    except StudioReviewNotEligible as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "review_not_eligible", "issues": list(error.issues)},
        ) from None
    except Exception as error:
        for kind, status_code, code in _ERRORS:
            if isinstance(error, kind):
                raise HTTPException(status_code=status_code, detail={"code": code}) from None
        raise


@router.get(f"{DOCUMENT_PATH}/review-comments", response_model=ReviewCommentPage)
async def list_review_comments(
    project_id: ProjectId,
    document_id: OpaqueId,
    _: ActorDependency,
    service: ServiceDependency,
    limit: Limit = 20,
    cursor: Cursor = None,
) -> ReviewCommentPage | JSONResponse:
    return await _safely(service.list_comments(project_id, document_id, limit=limit, cursor=cursor))


@router.post(
    f"{DOCUMENT_PATH}/review-comments",
    response_model=ReviewComment,
    status_code=status.HTTP_201_CREATED,
    responses=_CONFLICT,
)
async def create_review_comment(
    project_id: ProjectId,
    document_id: OpaqueId,
    payload: CreateComment,
    actor: ActorDependency,
    service: ServiceDependency,
) -> ReviewComment | JSONResponse:
    return await _safely(service.create_comment(project_id, document_id, payload, actor))


@router.get(f"{DOCUMENT_PATH}/review-decisions", response_model=ReviewDecisionPage)
async def list_review_decisions(
    project_id: ProjectId,
    document_id: OpaqueId,
    _: ActorDependency,
    service: ServiceDependency,
    limit: Limit = 20,
    cursor: Cursor = None,
) -> ReviewDecisionPage | JSONResponse:
    return await _safely(
        service.list_decisions(project_id, document_id, limit=limit, cursor=cursor)
    )


@router.post(
    f"{DOCUMENT_PATH}/review-decisions",
    response_model=ReviewDecision,
    status_code=status.HTTP_201_CREATED,
    responses=_CONFLICT,
)
async def create_review_decision(
    project_id: ProjectId,
    document_id: OpaqueId,
    payload: CreateDecision,
    actor: ActorDependency,
    service: ServiceDependency,
) -> ReviewDecision | JSONResponse:
    return await _safely(service.create_decision(project_id, document_id, payload, actor))
