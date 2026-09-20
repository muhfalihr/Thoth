"""Tests for the one-slot, revision-bound render lifecycle without a queue."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tests.domain.edit_document_v2_fixtures import document_v2_payload
from thoth_control_plane.application.render_bundles import (
    RenderBundleInvalid,
    RenderPresetSettings,
)
from thoth_control_plane.application.render_job_ports import (
    ArtifactUnavailable,
    JobWorkspace,
    PublishedArtifact,
    RenderBusy,
    RendererNotConfigured,
    RendererUnavailable,
    RenderIdempotencyConflict,
    RenderJobNotCancellable,
    RenderJobNotCleanable,
    RenderJobNotFound,
    RenderJobNotRetryable,
    StagedAsset,
)
from thoth_control_plane.application.render_jobs import (
    CreateRenderJobRequest,
    ListRenderJobsRequest,
    RenderJobService,
)
from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2
from thoth_control_plane.domain.editor_assets import EditorAsset, EditorAssetRecord
from thoth_control_plane.domain.render_jobs import (
    ACTIVE_RENDER_STATUSES,
    RenderJob,
    RenderJobEvent,
    RenderJobPage,
    RenderOutputFacts,
    apply_render_event,
    mark_cancel_requested,
)

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
CHECKSUM = "sha256:" + "a" * 64
OUTPUT_CHECKSUM = "sha256:" + "b" * 64
PROJECT = "project_001"
OTHER_PROJECT = "project_002"
DOCUMENT = "edoc_abc123"
REVISION = 3
ACTOR = "actor_1"


def document(**overrides: Any) -> EditDocumentV2:
    payload = deepcopy(document_v2_payload())
    payload["revision"] = REVISION
    payload.update(overrides)
    return EditDocumentV2.model_validate(payload)


def asset_record() -> EditorAssetRecord:
    return EditorAssetRecord(
        asset=EditorAsset.model_validate(
            {
                "asset_id": "asset_main",
                "project_id": PROJECT,
                "kind": "video",
                "media_type": "video/mp4",
                "duration_in_frames": 900,
                "width": 1080,
                "height": 1920,
                "fps": 30.0,
                "has_audio": True,
                "validation_state": "ready",
                "checksum": CHECKSUM,
            }
        ),
        artifact_location=f"{PROJECT}/assets/asset_main.mp4",
        provenance="operator_upload",
    )


def output_facts() -> RenderOutputFacts:
    return RenderOutputFacts(
        media_type="video/mp4",
        size_bytes=4096,
        checksum=OUTPUT_CHECKSUM,
        codec="h264",
        width=1080,
        height=1920,
        fps=30.0,
        duration_seconds=10.0,
        has_audio=True,
    )


class Documents:
    def __init__(self, revisions: dict[int, Any] | None = None) -> None:
        self.revisions = (
            {REVISION: document(), REVISION + 1: document(revision=REVISION + 1)}
            if revisions is None
            else revisions
        )

    async def get_revision(self, *, project_id: str, document_id: str, revision: int) -> Any | None:
        if project_id != PROJECT or document_id != DOCUMENT:
            return None
        return self.revisions.get(revision)


class Assets:
    def __init__(self, records: tuple[EditorAssetRecord, ...] | None = None) -> None:
        self.records = (asset_record(),) if records is None else records

    async def get_ready_records(
        self, *, project_id: str, asset_ids: tuple[str, ...]
    ) -> tuple[EditorAssetRecord, ...]:
        wanted = set(asset_ids)
        return tuple(item for item in self.records if item.asset.asset_id in wanted)


class Artifacts:
    """Record every path decision without touching a real filesystem."""

    def __init__(self, *, publish_error: Exception | None = None) -> None:
        self.publish_error = publish_error
        self.stage_error: Exception | None = None
        self.published: list[str] = []
        self.cleaned: list[str] = []
        self.downloads: list[str] = []

    def prepare(self, render_job_id: str) -> JobWorkspace:
        return JobWorkspace(render_job_id=render_job_id)

    def resolve_source(self, relative_location: str) -> Path:
        return Path("/srv/artifacts") / relative_location

    def stage_asset(
        self,
        workspace: JobWorkspace,
        *,
        asset_id: str,
        source: Path,
        expected_checksum: str,
        max_bytes: int,
    ) -> StagedAsset:
        if self.stage_error is not None:
            raise self.stage_error
        return StagedAsset(
            asset_id=asset_id,
            relative_name=f"assets/{asset_id}.mp4",
            size_bytes=2048,
            checksum=expected_checksum,
        )

    def write_bundle(self, workspace: JobWorkspace, bundle_json: bytes) -> str:
        return workspace.bundle_name

    def publish(
        self,
        render_job_id: str,
        output: RenderOutputFacts,
        metadata_json: bytes,
        diagnostics_json: bytes,
    ) -> PublishedArtifact:
        if self.publish_error is not None:
            raise self.publish_error
        self.published.append(render_job_id)
        return PublishedArtifact(
            relative_path=f"renders/{render_job_id}/output.mp4",
            size_bytes=output.size_bytes,
            checksum=output.checksum,
        )

    def resolve_download(self, render_job_id: str, relative_path: str) -> Path:
        self.downloads.append(relative_path)
        return Path("/srv/artifacts") / relative_path

    def cleanup(self, render_job_id: str) -> None:
        self.cleaned.append(render_job_id)


class Renderer:
    def __init__(self, *, configured: bool = True, error: Exception | None = None) -> None:
        self.configured = configured
        self.error = error
        self.started: list[tuple[str, str]] = []
        self.cancelled: list[str] = []

    async def start(self, *, render_job_id: str, dispatch_id: str) -> None:
        self.started.append((render_job_id, dispatch_id))
        if self.error is not None:
            raise self.error

    async def cancel(self, *, render_job_id: str) -> None:
        self.cancelled.append(render_job_id)
        if self.error is not None:
            raise self.error


class Jobs:
    """An in-memory stand-in enforcing the same one-slot rule as the database."""

    def __init__(self) -> None:
        self.rows: dict[str, RenderJob] = {}
        self.keys: dict[tuple[str, str], tuple[str, str]] = {}
        self.order: list[str] = []
        self.cleaned: list[str] = []

    def _active(self) -> RenderJob | None:
        for render_job_id in self.order:
            job = self.rows[render_job_id]
            if job.status in ACTIVE_RENDER_STATUSES:
                return job
        return None

    async def reserve(
        self, job: RenderJob, *, idempotency_key: str, payload_hash: str
    ) -> RenderJob:
        recorded = self.keys.get((job.project_id, idempotency_key))
        if recorded is not None:
            if recorded[0] != payload_hash:
                raise RenderIdempotencyConflict()
            return self.rows[recorded[1]]
        active = self._active()
        if active is not None:
            raise RenderBusy(
                active_render_job_id=active.render_job_id,
                active_project_id=active.project_id,
            )
        self.rows[job.render_job_id] = job
        self.order.insert(0, job.render_job_id)
        self.keys[(job.project_id, idempotency_key)] = (payload_hash, job.render_job_id)
        return job

    async def get_active(self) -> RenderJob | None:
        return self._active()

    async def get(self, *, project_id: str, render_job_id: str) -> RenderJob | None:
        job = self.rows.get(render_job_id)
        return job if job is not None and job.project_id == project_id else None

    async def get_internal(self, *, render_job_id: str) -> RenderJob | None:
        return self.rows.get(render_job_id)

    async def list(self, *, project_id: str, limit: int, cursor: str | None) -> RenderJobPage:
        owned = [key for key in self.order if self.rows[key].project_id == project_id]
        page = owned[: max(1, min(limit, 50))]
        return RenderJobPage(
            jobs=tuple(self.rows[key] for key in page),
            next_cursor="cursor_next" if len(page) < len(owned) else None,
        )

    async def apply_event(
        self, *, render_job_id: str, event: RenderJobEvent, now: datetime
    ) -> RenderJob:
        job = self.rows.get(render_job_id)
        if job is None:
            raise RenderJobNotFound()
        updated = apply_render_event(job, event, now)
        self.rows[render_job_id] = updated
        return updated

    async def mark_cancel_requested(
        self, *, project_id: str, render_job_id: str, now: datetime
    ) -> tuple[RenderJob, bool]:
        job = await self.get(project_id=project_id, render_job_id=render_job_id)
        if job is None:
            raise RenderJobNotFound()
        first = job.cancel_requested_at is None
        updated = mark_cancel_requested(job, now)
        self.rows[render_job_id] = updated
        return updated, first

    async def mark_cleaned(
        self, *, project_id: str, render_job_id: str, now: datetime
    ) -> RenderJob:
        job = await self.get(project_id=project_id, render_job_id=render_job_id)
        if job is None:
            raise RenderJobNotFound()
        updated = RenderJob.model_validate({**job.model_dump(), "artifacts_cleaned_at": now})
        self.rows[render_job_id] = updated
        self.cleaned.append(render_job_id)
        return updated

    async def list_expired_active(self, *, deadline: datetime, limit: int) -> tuple[RenderJob, ...]:
        expired = [
            self.rows[key]
            for key in self.order
            if self.rows[key].status in ACTIVE_RENDER_STATUSES
            and self.rows[key].created_at < deadline
        ]
        return tuple(expired[:limit])


class Clock:
    """A monotonic test clock, so every recorded time is distinguishable."""

    def __init__(self, start: datetime = NOW) -> None:
        self.current = start

    def __call__(self) -> datetime:
        self.current += timedelta(seconds=1)
        return self.current


def build_service(
    *,
    jobs: Jobs | None = None,
    documents: Documents | None = None,
    assets: Assets | None = None,
    artifacts: Artifacts | None = None,
    renderer: Renderer | None = None,
    max_render_seconds: int = 900,
    unconfigured_repository: bool = False,
) -> RenderJobService:
    counter = {"n": 0}

    def new_id(prefix: str) -> str:
        counter["n"] += 1
        return f"{prefix}_{counter['n']}"

    return RenderJobService(
        jobs=None if unconfigured_repository else (jobs if jobs is not None else Jobs()),
        documents=documents if documents is not None else Documents(),
        assets=assets if assets is not None else Assets(),
        artifacts=artifacts if artifacts is not None else Artifacts(),
        renderer=renderer if renderer is not None else Renderer(),
        settings=RenderPresetSettings(
            preset_id="standard_vertical_mp4_v1",
            renderer_version="remotion-4.0.523",
            max_asset_bytes=512 * 1024 * 1024,
        ),
        max_render_seconds=max_render_seconds,
        clock=Clock(),
        new_id=new_id,
    )


def create_request(**overrides: Any) -> CreateRenderJobRequest:
    return CreateRenderJobRequest.model_validate(
        {"document_id": DOCUMENT, "document_revision": REVISION, **overrides}
    )


async def create_one(service: RenderJobService, key: str = "key-1", **overrides: Any) -> RenderJob:
    return await service.create(
        project_id=PROJECT,
        actor_id=ACTOR,
        request=create_request(**overrides),
        idempotency_key=key,
    )


def event(job: RenderJob, status: str, sequence: int, **overrides: Any) -> RenderJobEvent:
    return RenderJobEvent.model_validate(
        {
            "render_job_id": job.render_job_id,
            "dispatch_id": job.dispatch_id,
            "sequence": sequence,
            "status": status,
            "occurred_at": NOW,
            **overrides,
        }
    )


def completion_event(job: RenderJob, sequence: int = 3) -> RenderJobEvent:
    return event(
        job,
        "completed",
        sequence,
        output=output_facts(),
        output_relative_path=f"renders/{job.render_job_id}/output.mp4",
    )


async def complete(service: RenderJobService, job: RenderJob) -> RenderJob:
    await service.ingest_event(job.render_job_id, event(job, "rendering", 1))
    await service.ingest_event(job.render_job_id, event(job, "finalizing", 2))
    return await service.ingest_event(job.render_job_id, completion_event(job))


async def fail(service: RenderJobService, job: RenderJob) -> RenderJob:
    return await service.ingest_event(
        job.render_job_id, event(job, "failed", 1, failure_code="render_engine_failed")
    )


# --- capability -----------------------------------------------------------


@pytest.mark.asyncio
async def test_capability_is_unavailable_with_a_safe_reason_when_no_renderer_exists() -> None:
    service = build_service(renderer=Renderer(configured=False))

    capability = await service.capability(PROJECT)

    assert capability.available is False
    assert capability.reason == "renderer_not_configured"
    assert capability.active_render_job_id is None
    assert capability.preset_id == "standard_vertical_mp4_v1"
    assert capability.renderer_version == "remotion-4.0.523"


@pytest.mark.asyncio
async def test_capability_is_unavailable_when_render_storage_is_not_configured() -> None:
    service = build_service(unconfigured_repository=True)

    capability = await service.capability(PROJECT)

    assert capability.available is False
    assert capability.reason == "renderer_not_configured"


@pytest.mark.asyncio
async def test_capability_is_available_when_the_single_slot_is_free() -> None:
    capability = await build_service().capability(PROJECT)

    assert capability.available is True
    assert capability.reason is None
    assert capability.active_render_job_id is None


@pytest.mark.asyncio
async def test_capability_reports_busy_while_this_project_holds_the_slot() -> None:
    service = build_service()
    job = await create_one(service)

    capability = await service.capability(PROJECT)

    assert capability.available is False
    assert capability.reason == "render_busy"
    assert capability.active_render_job_id == job.render_job_id


@pytest.mark.asyncio
async def test_capability_hides_the_active_job_identity_from_another_project() -> None:
    service = build_service()
    await create_one(service)

    capability = await service.capability(OTHER_PROJECT)

    assert capability.available is False
    assert capability.reason == "render_busy"
    assert capability.active_render_job_id is None


# --- create ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_binds_the_exact_saved_revision_and_dispatches_once() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer)

    job = await create_one(service)

    assert job.status == "preparing"
    assert job.project_id == PROJECT
    assert job.document_id == DOCUMENT
    assert job.document_revision == REVISION
    assert job.created_by == ACTOR
    assert job.retry_of_job_id is None
    assert job.output is None
    assert job.provenance.document_revision == REVISION
    assert job.provenance.preset_id == "standard_vertical_mp4_v1"
    assert [item.asset_id for item in job.provenance.asset_checksums] == ["asset_main"]
    assert renderer.started == [(job.render_job_id, job.dispatch_id)]


@pytest.mark.asyncio
async def test_create_refuses_a_revision_that_was_never_saved() -> None:
    service = build_service(documents=Documents(revisions={}))

    with pytest.raises(RenderBundleInvalid):
        await create_one(service)


@pytest.mark.asyncio
async def test_create_replays_an_identical_request_without_dispatching_again() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer)

    first = await create_one(service)
    second = await create_one(service)

    assert second.render_job_id == first.render_job_id
    assert renderer.started == [(first.render_job_id, first.dispatch_id)]


@pytest.mark.asyncio
async def test_create_refuses_one_key_reused_for_a_different_request() -> None:
    artifacts = Artifacts()
    service = build_service(artifacts=artifacts)
    await create_one(service)

    with pytest.raises(RenderIdempotencyConflict):
        await create_one(service, document_revision=REVISION + 1)

    # The refused request keeps nothing staged behind it.
    assert len(artifacts.cleaned) == 1


@pytest.mark.asyncio
async def test_create_refuses_a_second_job_while_one_is_active() -> None:
    renderer = Renderer()
    artifacts = Artifacts()
    service = build_service(renderer=renderer, artifacts=artifacts)
    first = await create_one(service)

    with pytest.raises(RenderBusy):
        await create_one(service, key="key-2")

    assert renderer.started == [(first.render_job_id, first.dispatch_id)]
    assert artifacts.cleaned == ["rj_3"]


@pytest.mark.asyncio
async def test_create_refuses_to_start_when_no_renderer_is_configured() -> None:
    jobs = Jobs()
    service = build_service(jobs=jobs, renderer=Renderer(configured=False))

    with pytest.raises(RendererNotConfigured):
        await create_one(service)

    assert jobs.rows == {}


@pytest.mark.asyncio
async def test_a_staging_failure_closes_the_job_without_dispatch_or_retry() -> None:
    artifacts = Artifacts()
    artifacts.stage_error = ArtifactUnavailable()
    renderer = Renderer()
    service = build_service(artifacts=artifacts, renderer=renderer)

    with pytest.raises(ArtifactUnavailable):
        await create_one(service)

    history = await service.list(PROJECT, ListRenderJobsRequest())
    assert [job.status for job in history.jobs] == ["failed"]
    assert history.jobs[0].failure_code == "render_asset_unavailable"
    assert renderer.started == []
    assert (await service.capability(PROJECT)).available is True


@pytest.mark.asyncio
async def test_a_dispatch_failure_closes_the_job_and_frees_the_slot() -> None:
    renderer = Renderer(error=RendererUnavailable())
    service = build_service(renderer=renderer)

    with pytest.raises(RendererUnavailable):
        await create_one(service)

    history = await service.list(PROJECT, ListRenderJobsRequest())
    assert history.jobs[0].status == "failed"
    assert history.jobs[0].failure_code == "render_dispatch_failed"
    # Closing the job is the whole recovery: nothing is dispatched a second time.
    assert len(renderer.started) == 1
    assert (await service.capability(PROJECT)).available is True


# --- read -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_returns_the_job_this_project_owns() -> None:
    service = build_service()
    job = await create_one(service)

    assert (await service.get(PROJECT, job.render_job_id)).render_job_id == job.render_job_id


@pytest.mark.asyncio
async def test_get_refuses_a_job_another_project_owns() -> None:
    service = build_service()
    job = await create_one(service)

    with pytest.raises(RenderJobNotFound):
        await service.get(OTHER_PROJECT, job.render_job_id)


@pytest.mark.asyncio
async def test_history_stays_inside_the_requesting_project() -> None:
    service = build_service()
    job = await create_one(service)
    await fail(service, job)

    mine = await service.list(PROJECT, ListRenderJobsRequest())
    theirs = await service.list(OTHER_PROJECT, ListRenderJobsRequest())

    assert [item.render_job_id for item in mine.jobs] == [job.render_job_id]
    assert theirs.jobs == ()


def test_a_history_request_is_bounded_on_both_sides() -> None:
    assert ListRenderJobsRequest().limit <= 50
    with pytest.raises(ValueError):
        ListRenderJobsRequest(limit=0)
    with pytest.raises(ValueError):
        ListRenderJobsRequest(limit=51)


# --- cancel ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_asks_the_renderer_exactly_once() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer)
    job = await create_one(service)

    first = await service.cancel(PROJECT, job.render_job_id)
    second = await service.cancel(PROJECT, job.render_job_id)

    assert first.cancel_requested_at is not None
    assert second.cancel_requested_at == first.cancel_requested_at
    assert renderer.cancelled == [job.render_job_id]


@pytest.mark.asyncio
async def test_cancel_never_reopens_a_job_that_finished_first() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer)
    job = await create_one(service)
    await complete(service, job)

    with pytest.raises(RenderJobNotCancellable):
        await service.cancel(PROJECT, job.render_job_id)

    assert renderer.cancelled == []
    assert (await service.get(PROJECT, job.render_job_id)).status == "completed"


@pytest.mark.asyncio
async def test_cancel_never_reaches_another_project() -> None:
    service = build_service()
    job = await create_one(service)

    with pytest.raises(RenderJobNotFound):
        await service.cancel(OTHER_PROJECT, job.render_job_id)


@pytest.mark.asyncio
async def test_a_renderer_that_cannot_be_reached_still_records_the_cancel_request() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer)
    job = await create_one(service)
    renderer.error = RendererUnavailable()

    cancelled = await service.cancel(PROJECT, job.render_job_id)

    assert cancelled.cancel_requested_at is not None
    assert renderer.cancelled == [job.render_job_id]


# --- retry ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_retry_creates_a_new_job_bound_to_the_same_immutable_revision() -> None:
    service = build_service()
    source = await create_one(service)
    await fail(service, source)

    retried = await service.retry(PROJECT, ACTOR, source.render_job_id, "key-retry")

    assert retried.render_job_id != source.render_job_id
    assert retried.retry_of_job_id == source.render_job_id
    assert retried.document_id == source.document_id
    assert retried.document_revision == source.document_revision
    assert retried.status == "preparing"
    assert (await service.get(PROJECT, source.render_job_id)).status == "failed"


@pytest.mark.asyncio
async def test_retry_is_refused_while_the_source_job_is_still_active() -> None:
    service = build_service()
    source = await create_one(service)

    with pytest.raises(RenderJobNotRetryable):
        await service.retry(PROJECT, ACTOR, source.render_job_id, "key-retry")


@pytest.mark.asyncio
async def test_retry_is_refused_for_a_completed_job() -> None:
    service = build_service()
    source = await create_one(service)
    await complete(service, source)

    with pytest.raises(RenderJobNotRetryable):
        await service.retry(PROJECT, ACTOR, source.render_job_id, "key-retry")


@pytest.mark.asyncio
async def test_retry_never_reaches_across_projects() -> None:
    service = build_service()
    source = await create_one(service)
    await fail(service, source)

    with pytest.raises(RenderJobNotFound):
        await service.retry(OTHER_PROJECT, ACTOR, source.render_job_id, "key-retry")


# --- events ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_completed_event_publishes_before_the_row_becomes_completed() -> None:
    artifacts = Artifacts()
    service = build_service(artifacts=artifacts)
    job = await create_one(service)

    finished = await complete(service, job)

    assert artifacts.published == [job.render_job_id]
    assert finished.status == "completed"
    assert finished.output_relative_path == f"renders/{job.render_job_id}/output.mp4"
    assert finished.output == output_facts()
    assert finished.provenance.output == output_facts()


@pytest.mark.asyncio
async def test_output_that_cannot_be_published_fails_the_job_instead() -> None:
    artifacts = Artifacts(publish_error=ArtifactUnavailable())
    service = build_service(artifacts=artifacts)
    job = await create_one(service)
    await service.ingest_event(job.render_job_id, event(job, "rendering", 1))
    await service.ingest_event(job.render_job_id, event(job, "finalizing", 2))

    result = await service.ingest_event(job.render_job_id, completion_event(job))

    assert result.status == "failed"
    assert result.failure_code == "render_output_invalid"
    assert result.output is None
    assert result.output_relative_path is None
    assert artifacts.published == []


@pytest.mark.asyncio
async def test_progress_is_recorded_while_the_job_is_still_active() -> None:
    service = build_service()
    job = await create_one(service)

    updated = await service.ingest_event(
        job.render_job_id, event(job, "rendering", 1, progress_percent=40)
    )

    assert updated.status == "rendering"
    assert updated.progress_percent == 40


@pytest.mark.asyncio
async def test_a_late_event_never_reopens_a_terminal_job_or_republishes() -> None:
    artifacts = Artifacts()
    service = build_service(artifacts=artifacts)
    job = await create_one(service)
    await complete(service, job)

    result = await service.ingest_event(job.render_job_id, completion_event(job, sequence=99))

    assert result.status == "completed"
    assert artifacts.published == [job.render_job_id]


@pytest.mark.asyncio
async def test_an_event_from_a_superseded_dispatch_is_refused() -> None:
    service = build_service()
    job = await create_one(service)
    stray = event(job, "rendering", 1).model_copy(update={"dispatch_id": "dispatch_other"})

    with pytest.raises(Exception):  # noqa: B017 - the route maps this to one safe code
        await service.ingest_event(job.render_job_id, stray)

    assert (await service.get(PROJECT, job.render_job_id)).status == "preparing"


@pytest.mark.asyncio
async def test_an_event_for_an_unknown_job_is_refused() -> None:
    service = build_service()
    job = await create_one(service)
    stray = event(job, "rendering", 1).model_copy(update={"render_job_id": "rj_absent"})

    with pytest.raises(RenderJobNotFound):
        await service.ingest_event("rj_absent", stray)


# --- output ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_output_is_downloadable_only_after_a_verified_completion() -> None:
    artifacts = Artifacts()
    service = build_service(artifacts=artifacts)
    job = await create_one(service)

    with pytest.raises(ArtifactUnavailable):
        await service.output_path(PROJECT, job.render_job_id)

    await complete(service, job)
    download = await service.output_path(PROJECT, job.render_job_id)

    assert download.media_type == "video/mp4"
    assert download.size_bytes == 4096
    assert download.checksum == OUTPUT_CHECKSUM
    assert download.filename.endswith(".mp4")
    assert artifacts.downloads == [f"renders/{job.render_job_id}/output.mp4"]


@pytest.mark.asyncio
async def test_a_cleaned_render_is_no_longer_downloadable() -> None:
    service = build_service()
    job = await create_one(service)
    await complete(service, job)
    await service.cleanup(PROJECT, job.render_job_id)

    with pytest.raises(ArtifactUnavailable):
        await service.output_path(PROJECT, job.render_job_id)


@pytest.mark.asyncio
async def test_the_output_never_crosses_a_project_boundary() -> None:
    service = build_service()
    job = await create_one(service)
    await complete(service, job)

    with pytest.raises(RenderJobNotFound):
        await service.output_path(OTHER_PROJECT, job.render_job_id)


# --- cleanup --------------------------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_keeps_the_audit_row_and_is_idempotent() -> None:
    artifacts = Artifacts()
    service = build_service(artifacts=artifacts)
    job = await create_one(service)
    await complete(service, job)

    first = await service.cleanup(PROJECT, job.render_job_id)
    second = await service.cleanup(PROJECT, job.render_job_id)

    assert first.artifacts_cleaned_at is not None
    assert second.artifacts_cleaned_at == first.artifacts_cleaned_at
    assert second.status == "completed"
    assert second.provenance.document_revision == REVISION
    assert artifacts.cleaned == [job.render_job_id]


@pytest.mark.asyncio
async def test_cleanup_refuses_a_job_a_renderer_may_still_be_writing() -> None:
    artifacts = Artifacts()
    service = build_service(artifacts=artifacts)
    job = await create_one(service)

    with pytest.raises(RenderJobNotCleanable):
        await service.cleanup(PROJECT, job.render_job_id)

    assert artifacts.cleaned == []


@pytest.mark.asyncio
async def test_cleanup_never_reaches_another_project() -> None:
    service = build_service()
    job = await create_one(service)
    await complete(service, job)

    with pytest.raises(RenderJobNotFound):
        await service.cleanup(OTHER_PROJECT, job.render_job_id)


# --- deadline -------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_job_past_its_deadline_fails_with_one_best_effort_cancel() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer, max_render_seconds=60)
    job = await create_one(service)

    assert await service.reconcile_expired(NOW + timedelta(seconds=3600)) == 1

    assert renderer.cancelled == [job.render_job_id]
    stored = await service.get(PROJECT, job.render_job_id)
    assert stored.status == "failed"
    assert stored.failure_code == "render_deadline_exceeded"


@pytest.mark.asyncio
async def test_reconciliation_leaves_a_job_inside_its_deadline_alone() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer, max_render_seconds=900)
    job = await create_one(service)

    assert await service.reconcile_expired(NOW + timedelta(seconds=10)) == 0

    assert renderer.cancelled == []
    assert (await service.get(PROJECT, job.render_job_id)).status == "preparing"


@pytest.mark.asyncio
async def test_reconciliation_closes_an_expired_job_even_if_the_renderer_is_gone() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer, max_render_seconds=60)
    job = await create_one(service)
    renderer.error = RendererUnavailable()

    assert await service.reconcile_expired(NOW + timedelta(seconds=3600)) == 1

    stored = await service.get(PROJECT, job.render_job_id)
    assert stored.failure_code == "render_deadline_exceeded"


@pytest.mark.asyncio
async def test_reconciliation_never_touches_a_terminal_job() -> None:
    renderer = Renderer()
    service = build_service(renderer=renderer, max_render_seconds=60)
    job = await create_one(service)
    await complete(service, job)

    assert await service.reconcile_expired(NOW + timedelta(seconds=3600)) == 0
    assert renderer.cancelled == []
