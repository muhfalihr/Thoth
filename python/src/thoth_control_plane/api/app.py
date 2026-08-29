"""FastAPI application factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse

from thoth_control_plane.api.routes.health import router as health_router
from thoth_control_plane.api.routes.workflows import router as workflow_router
from thoth_control_plane.application import (
    ApprovalNotAllowed,
    IdempotencyConflict,
    UnavailableWorkflowGateway,
    WorkflowGateway,
    WorkflowNotFound,
    WorkflowNotReady,
    WorkflowService,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.infrastructure.temporal_gateway import TemporalWorkflowGateway

CONTRACT_VERSION = "1"


def create_app(settings: Settings, gateway: WorkflowGateway | None = None) -> FastAPI:
    """Create an isolated v1 API application for the supplied workflow gateway."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        resolved_gateway = gateway
        try:
            if resolved_gateway is None:
                resolved_gateway = await TemporalWorkflowGateway.connect(settings)
            checker: Any = getattr(resolved_gateway, "check_connection", None)
            if checker is not None and not await checker():
                raise WorkflowNotReady
        except Exception:
            app.state.workflow_ready = False
            app.state.workflow_service = WorkflowService(UnavailableWorkflowGateway())
        else:
            app.state.workflow_ready = True
            app.state.workflow_service = WorkflowService(resolved_gateway)
        yield

    app = FastAPI(
        title="Thoth Control Plane",
        version=CONTRACT_VERSION,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.workflow_ready = gateway is not None
    app.state.workflow_service = WorkflowService(gateway or UnavailableWorkflowGateway())

    exception_statuses = {
        IdempotencyConflict: status.HTTP_409_CONFLICT,
        ApprovalNotAllowed: status.HTTP_409_CONFLICT,
        WorkflowNotFound: status.HTTP_404_NOT_FOUND,
        WorkflowNotReady: status.HTTP_503_SERVICE_UNAVAILABLE,
    }

    for exception_type, status_code in exception_statuses.items():

        @app.exception_handler(exception_type)
        async def workflow_error_handler(
            request: Request,
            exc: Exception,
            mapped_status: int = status_code,
        ) -> JSONResponse:
            return JSONResponse(status_code=mapped_status, content={"detail": str(exc)})

    @app.middleware("http")
    async def add_contract_version(request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Thoth-Contract-Version"] = CONTRACT_VERSION
        return response

    app.include_router(health_router)
    app.include_router(workflow_router, prefix="/api/v1")
    return app
