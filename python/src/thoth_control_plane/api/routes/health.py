"""Liveness and orchestration-readiness routes."""

from fastapi import APIRouter, Request

from thoth_control_plane.application import WorkflowNotReady

router = APIRouter()


@router.get("/healthz")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
async def readiness(request: Request) -> dict[str, str]:
    if not request.app.state.workflow_ready:
        raise WorkflowNotReady
    checker = getattr(request.app.state.workflow_gateway, "check_connection", None)
    if checker is not None and not await checker():
        raise WorkflowNotReady
    return {"status": "ready"}
