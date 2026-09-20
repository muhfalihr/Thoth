"""FastAPI application factory."""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request, Response, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from temporalio.service import RPCError

from thoth_control_plane.api.routes.edit_documents import router as edit_document_router
from thoth_control_plane.api.routes.editor_assets import router as editor_asset_router
from thoth_control_plane.api.routes.health import router as health_router
from thoth_control_plane.api.routes.internal_render_jobs import router as internal_render_router
from thoth_control_plane.api.routes.prompt_lab import router as prompt_lab_router
from thoth_control_plane.api.routes.prompt_proposals import router as prompt_proposal_router
from thoth_control_plane.api.routes.render_jobs import router as render_job_router
from thoth_control_plane.api.routes.workflows import router as workflow_router
from thoth_control_plane.application import (
    ApprovalNotAllowed,
    ArtifactNotFound,
    IdempotencyConflict,
    UnavailableWorkflowGateway,
    WorkflowGateway,
    WorkflowNotFound,
    WorkflowNotReady,
    WorkflowService,
)
from thoth_control_plane.application.edit_documents import EditDocumentService
from thoth_control_plane.application.editor_asset_ports import EditorAssetRepository
from thoth_control_plane.application.editor_assets import EditorAssetService
from thoth_control_plane.application.ports import EditDocumentRepository, PromptLabRepository
from thoth_control_plane.application.prompt_lab import PromptLabService
from thoth_control_plane.application.prompt_proposal_ports import (
    PromptProposalRepository as C2ProposalRepository,
)
from thoth_control_plane.application.prompt_proposal_ports import (
    PromptProposalWorkflowGateway as C2ProposalGateway,
)
from thoth_control_plane.application.prompt_proposals import PromptProposalService
from thoth_control_plane.application.render_bundles import RenderPresetSettings
from thoth_control_plane.application.render_jobs import RenderJobService
from thoth_control_plane.config import Settings
from thoth_control_plane.domain.prompt_proposals import PromptProviderDefinition
from thoth_control_plane.infrastructure.artifact_root import LocalArtifactRoot
from thoth_control_plane.infrastructure.editor_asset_repository import (
    PostgresEditorAssetRepository,
)
from thoth_control_plane.infrastructure.editor_preview import EditorPreviewSigner
from thoth_control_plane.infrastructure.editor_repository import PostgresEditDocumentRepository
from thoth_control_plane.infrastructure.prompt_proposal_gateway import (
    TemporalPromptProposalGateway,
)
from thoth_control_plane.infrastructure.prompt_proposal_repository import (
    PostgresPromptProposalRepository,
)
from thoth_control_plane.infrastructure.prompt_provider import (
    public_prompt_provider_catalog,
)
from thoth_control_plane.infrastructure.prompt_repository import PostgresPromptLabRepository
from thoth_control_plane.infrastructure.render_job_repository import PostgresRenderJobRepository
from thoth_control_plane.infrastructure.renderer_gateway import (
    HttpRendererGateway,
    UnavailableRendererGateway,
)
from thoth_control_plane.infrastructure.temporal_gateway import TemporalWorkflowGateway

CONTRACT_VERSION = "1"

#: One staged clip is bounded well below this; the renderer never streams.
RENDER_ASSET_MAX_BYTES = 1024 * 1024 * 1024
#: How often the deadline scan runs. It is a bounded sweep, never a queue.
RENDER_RECONCILE_INTERVAL_SECONDS = 60


def _preview_signer(settings: Settings) -> EditorPreviewSigner | None:
    """Build the preview signer only when an operator supplied a signing key."""
    if settings.THOTH_EDITOR_PREVIEW_SIGNING_KEY is None:
        return None
    return EditorPreviewSigner(
        key=settings.THOTH_EDITOR_PREVIEW_SIGNING_KEY.get_secret_value(),
        ttl_seconds=settings.THOTH_EDITOR_PREVIEW_TTL_SECONDS,
    )


def _render_job_service(
    settings: Settings,
    editor_repository: EditDocumentRepository | None,
    editor_asset_repository: EditorAssetRepository | None,
) -> RenderJobService:
    """Compose the render service from settings, degrading instead of failing.

    A missing database or renderer only makes render unavailable: every other
    part of the control plane must still start and serve.
    """
    database_url = settings.THOTH_EDITOR_DATABASE_URL
    renderer = (
        HttpRendererGateway(
            base_url=str(settings.THOTH_RENDERER_INTERNAL_URL),
            credential=settings.THOTH_RENDERER_INTERNAL_CREDENTIAL,  # type: ignore[arg-type]
        )
        if settings.renderer_enabled
        else UnavailableRendererGateway()
    )
    return RenderJobService(
        jobs=(
            PostgresRenderJobRepository(database_url.get_secret_value())
            if database_url is not None
            else None
        ),
        documents=editor_repository,
        assets=editor_asset_repository,
        artifacts=LocalArtifactRoot(settings.THOTH_CONTROL_PLANE_ARTIFACT_ROOT),
        renderer=renderer,
        settings=RenderPresetSettings(
            preset_id=settings.THOTH_RENDER_PRESET_ID,
            renderer_version=settings.THOTH_RENDERER_VERSION,
            max_asset_bytes=RENDER_ASSET_MAX_BYTES,
        ),
        max_render_seconds=settings.THOTH_RENDER_MAX_SECONDS,
    )


async def _reconcile_render_deadlines(service: RenderJobService, interval: float) -> None:
    """Close jobs that outlived their deadline; nothing here starts a render."""
    while True:
        await asyncio.sleep(interval)
        with contextlib.suppress(Exception):
            await service.reconcile_expired(datetime.now(UTC))


def create_app(
    settings: Settings | None = None,
    gateway: WorkflowGateway | None = None,
    editor_repository: EditDocumentRepository | None = None,
    prompt_repository: PromptLabRepository | None = None,
    prompt_proposal_repository: C2ProposalRepository | None = None,
    prompt_proposal_gateway: C2ProposalGateway | None = None,
    prompt_provider_catalog: tuple[PromptProviderDefinition, ...] | None = None,
    editor_asset_repository: EditorAssetRepository | None = None,
    render_job_service: RenderJobService | None = None,
) -> FastAPI:
    """Create an isolated v1 API application for the supplied workflow gateway."""
    settings = settings or Settings()  # type: ignore[call-arg]
    if editor_repository is None and settings.THOTH_EDITOR_DATABASE_URL is not None:
        editor_repository = PostgresEditDocumentRepository(
            settings.THOTH_EDITOR_DATABASE_URL.get_secret_value()
        )
    if editor_asset_repository is None and settings.THOTH_EDITOR_DATABASE_URL is not None:
        editor_asset_repository = PostgresEditorAssetRepository(
            settings.THOTH_EDITOR_DATABASE_URL.get_secret_value()
        )
    if prompt_repository is None and settings.THOTH_EDITOR_DATABASE_URL is not None:
        prompt_repository = PostgresPromptLabRepository(
            settings.THOTH_EDITOR_DATABASE_URL.get_secret_value()
        )
    if prompt_proposal_repository is None and settings.THOTH_EDITOR_DATABASE_URL is not None:
        prompt_proposal_repository = PostgresPromptProposalRepository(
            settings.THOTH_EDITOR_DATABASE_URL.get_secret_value()
        )
    effective_catalog = (
        prompt_provider_catalog
        if prompt_provider_catalog is not None
        else public_prompt_provider_catalog(settings)
    )
    prompt_proposal_service = PromptProposalService(
        prompt_repository=prompt_repository,
        proposal_repository=prompt_proposal_repository,
        catalog=effective_catalog,
        gateway=prompt_proposal_gateway,
    )

    render_service = render_job_service or _render_job_service(
        settings, editor_repository, editor_asset_repository
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        resolved_gateway = gateway
        try:
            if resolved_gateway is None:
                resolved_gateway = await TemporalWorkflowGateway.connect(settings)
            checker: Any = getattr(resolved_gateway, "check_connection", None)
            if checker is not None and not await checker():
                raise WorkflowNotReady
        except (OSError, RPCError, WorkflowNotReady):
            app.state.workflow_ready = False
            app.state.workflow_gateway = UnavailableWorkflowGateway()
            app.state.workflow_service = WorkflowService(UnavailableWorkflowGateway())
        else:
            app.state.workflow_ready = True
            app.state.workflow_gateway = resolved_gateway
            app.state.workflow_service = WorkflowService(resolved_gateway)
        effective_gateway = prompt_proposal_gateway
        if effective_gateway is None and isinstance(resolved_gateway, TemporalWorkflowGateway):
            effective_gateway = TemporalPromptProposalGateway(resolved_gateway.client)
        app.state.prompt_proposal_service = PromptProposalService(
            prompt_repository=prompt_repository,
            proposal_repository=prompt_proposal_repository,
            catalog=effective_catalog,
            gateway=effective_gateway,
        )
        # One bounded pass first, so a job left active by a restart is closed
        # rather than resumed, then the same pass on a cancellable interval.
        with contextlib.suppress(Exception):
            await render_service.reconcile_expired(datetime.now(UTC))
        reconciler = asyncio.create_task(
            _reconcile_render_deadlines(render_service, RENDER_RECONCILE_INTERVAL_SECONDS)
        )
        try:
            yield
        finally:
            reconciler.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reconciler

    app = FastAPI(
        title="Thoth Control Plane",
        version=CONTRACT_VERSION,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.workflow_ready = gateway is not None
    app.state.workflow_gateway = gateway or UnavailableWorkflowGateway()
    app.state.workflow_service = WorkflowService(gateway or UnavailableWorkflowGateway())
    app.state.edit_document_service = EditDocumentService(editor_repository)
    app.state.editor_asset_service = EditorAssetService(editor_asset_repository)
    app.state.editor_preview_signer = _preview_signer(settings)
    app.state.prompt_lab_service = PromptLabService(prompt_repository)
    app.state.prompt_proposal_service = prompt_proposal_service
    app.state.render_job_service = render_service

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.THOTH_CONTROL_PLANE_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "PATCH", "POST", "PUT", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "Last-Event-ID",
        ],
        expose_headers=["X-Thoth-Contract-Version"],
    )

    exception_statuses = {
        ArtifactNotFound: status.HTTP_404_NOT_FOUND,
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

    # A required Idempotency-Key header is part of the OpenAPI contract (so
    # generated clients cannot omit it), but FastAPI's own missing-header error
    # exposes raw pydantic loc/msg detail. The same applies to an asset page
    # token, which would otherwise be reflected verbatim into the error body.
    # Rewrite only those cases to a stable safe code; every other validation
    # error keeps FastAPI's default handling untouched.
    idempotent_suffixes = ("/prompt-lab/proposals", "/upgrade-timeline", "/render-jobs", "/retry")

    @app.exception_handler(RequestValidationError)
    async def safe_validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> Response:
        path = request.url.path
        if request.method == "POST" and path.endswith(idempotent_suffixes):
            for error in exc.errors():
                loc = tuple(str(part).lower() for part in error.get("loc", ()))
                if loc == ("header", "idempotency-key"):
                    return JSONResponse(
                        status_code=422, content={"detail": {"code": "missing_idempotency_key"}}
                    )
        if request.method == "GET" and path.endswith("/editor-assets"):
            return JSONResponse(
                status_code=422, content={"detail": {"code": "invalid_asset_query"}}
            )
        return await request_validation_exception_handler(request, exc)

    @app.middleware("http")
    async def add_contract_version(request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Thoth-Contract-Version"] = CONTRACT_VERSION
        return response

    app.include_router(health_router)
    app.include_router(workflow_router, prefix="/api/v1")
    app.include_router(edit_document_router, prefix="/api/v1")
    app.include_router(editor_asset_router, prefix="/api/v1")
    app.include_router(prompt_lab_router, prefix="/api/v1")
    app.include_router(prompt_proposal_router, prefix="/api/v1")
    app.include_router(render_job_router, prefix="/api/v1")
    # Unversioned and unpublished: only the private renderer ever calls these.
    app.include_router(internal_render_router)
    return app
