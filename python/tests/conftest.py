import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from thoth_control_plane.activities.source_investigation import SourceInvestigationActivityInput
from thoth_control_plane.api.app import create_app
from thoth_control_plane.application import (
    ApprovalNotAllowed,
    ApprovalSubmission,
    WorkflowNotFound,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.domain import (
    Actor,
    ArtifactRef,
    SourceInvestigationActivityResult,
    StylePreset,
    WorkflowEvent,
    WorkflowRequest,
    WorkflowStatus,
    WorkflowSummary,
    request_snapshot_id,
)
from thoth_control_plane.domain.models import SafeActivityError
from thoth_control_plane.infrastructure.temporal_gateway import (
    TASK_QUEUE,
    TemporalWorkflowGateway,
)
from thoth_control_plane.workflows.source_investigation import SourceInvestigationWorkflow


class InMemoryWorkflowGateway:
    def __init__(self) -> None:
        self.workflows: dict[str, WorkflowSummary] = {}
        self.actors: list[Actor] = []
        self.connection_available = True
        self.last_from_stage: str | None = None
        self.last_approval: ApprovalSubmission | None = None
        self.approval_allowed = True
        timestamp = datetime(2026, 8, 28, 8, tzinfo=UTC)
        self.events = [
            WorkflowEvent(
                workflow_id="wf_001",
                event_id="evt_001",
                sequence=1,
                kind="workflow.queued",
                occurred_at=timestamp,
            ),
            WorkflowEvent(
                workflow_id="wf_001",
                event_id="evt_002",
                sequence=2,
                kind="workflow.started",
                occurred_at=timestamp,
            ),
        ]
        self.last_event_cursor: int | None = None

    def _workflow(self, workflow_id: str) -> WorkflowSummary:
        try:
            return self.workflows[workflow_id]
        except KeyError as exc:
            raise WorkflowNotFound from exc

    async def check_connection(self) -> bool:
        return self.connection_available

    async def list_style_presets(self, *, actor: Actor) -> list[StylePreset]:
        self.actors.append(actor)
        return [
            StylePreset(
                preset_id="news-vertical",
                label="News vertical",
                description="Fast-paced vertical news treatment",
            )
        ]

    async def start(
        self,
        request: WorkflowRequest,
        *,
        actor: Actor,
        idempotency_key: str,
    ) -> WorkflowSummary:
        self.actors.append(actor)
        timestamp = datetime(2026, 8, 28, 8, tzinfo=UTC)
        summary = WorkflowSummary(
            workflow_id="wf_001",
            status="queued",
            created_at=timestamp,
            updated_at=timestamp,
            source={"display_url": request.source.url, "platform": "tiktok"},
            stages=[],
        )
        self.workflows[summary.workflow_id] = summary
        return summary

    async def get(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        self.actors.append(actor)
        return self._workflow(workflow_id)

    async def stream_events(
        self, workflow_id: str, *, actor: Actor, after_sequence: int
    ) -> AsyncIterator[WorkflowEvent]:
        self.actors.append(actor)
        self._workflow(workflow_id)
        self.last_event_cursor = after_sequence
        for event in self.events:
            if event.sequence > after_sequence:
                yield event

    async def cancel(self, workflow_id: str, *, actor: Actor) -> WorkflowSummary:
        self.actors.append(actor)
        summary = self._workflow(workflow_id).model_copy(
            update={"status": WorkflowStatus.CANCELLED}
        )
        self.workflows[workflow_id] = summary
        return summary

    async def retry(
        self,
        workflow_id: str,
        *,
        from_stage: str | None,
        actor: Actor,
    ) -> WorkflowSummary:
        self.actors.append(actor)
        self.last_from_stage = from_stage
        summary = self._workflow(workflow_id).model_copy(update={"status": WorkflowStatus.QUEUED})
        self.workflows[workflow_id] = summary
        return summary

    async def record_approval(
        self,
        workflow_id: str,
        approval: ApprovalSubmission,
        *,
        actor: Actor,
    ) -> WorkflowSummary:
        self.actors.append(actor)
        if not self.approval_allowed:
            raise ApprovalNotAllowed
        self.last_approval = approval
        summary = self._workflow(workflow_id).model_copy(update={"status": WorkflowStatus.RUNNING})
        self.workflows[workflow_id] = summary
        return summary


@pytest.fixture
def gateway() -> InMemoryWorkflowGateway:
    return InMemoryWorkflowGateway()


@pytest_asyncio.fixture
async def client(gateway: InMemoryWorkflowGateway):
    settings = Settings(THOTH_CONTROL_PLANE_API_KEY="test-key")
    app = create_app(settings, gateway)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as test_client:
        yield test_client


class OfflineControlPlane:
    """Public HTTP harness backed by durable Temporal's offline test server."""

    def __init__(
        self,
        environment: WorkflowEnvironment,
        artifact_root: Path,
        fixture_modes: dict[str, str],
        inspect_activity,
    ) -> None:
        self._environment = environment
        self._artifact_root = artifact_root
        self._fixture_modes = fixture_modes
        self._inspect_activity = inspect_activity
        self._worker: Worker | None = None
        self._client: httpx.AsyncClient | None = None
        self._request_snapshots: dict[str, str] = {}
        self.recorded_http_paths: list[str] = []

    async def start(self) -> None:
        await self._start_worker()
        await self._start_api()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        if self._worker is not None:
            await self._worker.__aexit__(None, None, None)
            self._worker = None

    async def restart_api_and_worker(self) -> None:
        await self.close()
        await self.start()

    async def create(self, payload: dict[str, Any], *, idempotency_key: str) -> dict[str, Any]:
        request = WorkflowRequest.model_validate(payload)
        snapshot = request_snapshot_id(request)
        source_url = str(request.source.url)
        if "retryable-failure" in source_url:
            self._fixture_modes[snapshot] = "retryable-failure"
        elif "block-until-cancelled" in source_url:
            self._fixture_modes[snapshot] = "block"
        else:
            self._fixture_modes[snapshot] = "ready"
        response = await self._request(
            "POST",
            "/api/v1/workflows",
            headers={"Idempotency-Key": idempotency_key},
            json=payload,
        )
        assert response.status_code == 202, response.text
        body = response.json()
        self._request_snapshots[body["workflow_id"]] = snapshot
        return body

    async def events(self, workflow_id: str) -> list[dict[str, Any]]:
        response = await self._request("GET", f"/api/v1/workflows/{workflow_id}/events")
        assert response.status_code == 200, response.text
        events: list[dict[str, Any]] = []
        for frame in response.text.strip().split("\n\n"):
            lines = dict(line.split(": ", 1) for line in frame.splitlines() if ": " in line)
            data = json.loads(lines["data"])
            events.append(
                {
                    "event": lines["event"],
                    "sequence": data["sequence"],
                    "data": data,
                }
            )
        return events

    async def approve(
        self,
        workflow_id: str,
        *,
        approval_id: str,
        decision: str,
    ) -> dict[str, Any]:
        response = await self._request(
            "POST",
            f"/api/v1/workflows/{workflow_id}/approve",
            json={"approval_id": approval_id, "decision": decision},
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def cancel(self, workflow_id: str) -> dict[str, Any]:
        response = await self._request("POST", f"/api/v1/workflows/{workflow_id}/cancel")
        assert response.status_code == 200, response.text
        return response.json()

    async def fetch_artifact(self, workflow_id: str, artifact_id: str) -> dict[str, Any]:
        response = await self._request(
            "GET", f"/api/v1/workflows/{workflow_id}/artifacts/{artifact_id}"
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def artifact_status(
        self,
        workflow_id: str,
        artifact_id: str,
        *,
        api_key: str,
    ) -> int:
        response = await self._request(
            "GET",
            f"/api/v1/workflows/{workflow_id}/artifacts/{artifact_id}",
            api_key=api_key,
        )
        return response.status_code

    async def retry_status(self, workflow_id: str, *, from_stage: str) -> int:
        response = await self._request(
            "POST",
            f"/api/v1/workflows/{workflow_id}/retry",
            json={"from_stage": from_stage},
        )
        return response.status_code

    async def wait_for_status(self, workflow_id: str, status: str) -> dict[str, Any]:
        for _ in range(300):
            response = await self._request("GET", f"/api/v1/workflows/{workflow_id}")
            assert response.status_code == 200, response.text
            summary = response.json()
            if summary["status"] == status:
                return summary
            await asyncio.sleep(0.01)
        pytest.fail(f"workflow {workflow_id} did not reach {status}")

    async def wait_for_terminal(self, workflow_id: str) -> dict[str, Any]:
        summary: dict[str, Any] | None = None
        for _ in range(300):
            response = await self._request("GET", f"/api/v1/workflows/{workflow_id}")
            assert response.status_code == 200, response.text
            summary = response.json()
            if summary["status"] in {"succeeded", "failed", "cancelled"}:
                return summary
            await asyncio.sleep(0.01)
        final_status = summary["status"] if summary else "unknown"
        pytest.fail(f"workflow {workflow_id} remained {final_status}")

    def request_snapshot_id(self, workflow_id: str) -> str:
        return self._request_snapshots[workflow_id]

    async def _start_worker(self) -> None:
        worker = Worker(
            self._environment.client,
            task_queue=TASK_QUEUE,
            workflows=[SourceInvestigationWorkflow],
            activities=[self._inspect_activity],
            max_cached_workflows=0,
        )
        await worker.__aenter__()
        self._worker = worker

    async def _start_api(self) -> None:
        settings = Settings(
            THOTH_CONTROL_PLANE_API_KEY="offline-smoke-key",
            THOTH_CONTROL_PLANE_ARTIFACT_ROOT=self._artifact_root,
        )
        gateway = TemporalWorkflowGateway(self._environment.client)
        app = create_app(settings, gateway)
        self._client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://offline-control-plane",
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        api_key: str = "offline-smoke-key",
        headers: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
    ) -> httpx.Response:
        assert self._client is not None
        self.recorded_http_paths.append(path)
        request_headers = {"Authorization": f"Bearer {api_key}", **(headers or {})}
        return await self._client.request(method, path, headers=request_headers, json=json)


@pytest_asyncio.fixture
async def control_plane(tmp_path: Path) -> AsyncIterator[OfflineControlPlane]:
    fixture_modes: dict[str, str] = {}

    @activity.defn(name="inspect_source_candidates")
    async def inspect_fixture(
        input_: SourceInvestigationActivityInput,
    ) -> SourceInvestigationActivityResult:
        mode = fixture_modes[input_.request_snapshot_id]
        if mode == "retryable-failure":
            return SourceInvestigationActivityResult(
                failure=SafeActivityError(code="fixture_retryable_failure", retryable=True)
            )
        if mode == "block":
            await asyncio.Event().wait()

        content = json.dumps(
            {"request_snapshot_id": input_.request_snapshot_id},
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        digest = sha256(content).hexdigest()
        location = f"reports/{input_.workflow_id}/source-report.json"
        report_path = tmp_path / location
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_bytes(content)
        return SourceInvestigationActivityResult(
            report=ArtifactRef(
                artifact_id=f"art_source_{digest[:20]}",
                kind="source_report",
                label="Source investigation report",
                media_type="application/json",
                location=location,
                checksum=f"sha256:{digest}",
            )
        )

    environment = await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    )
    harness = OfflineControlPlane(environment, tmp_path, fixture_modes, inspect_fixture)
    await harness.start()
    try:
        yield harness
    finally:
        await harness.close()
        await environment.shutdown()
