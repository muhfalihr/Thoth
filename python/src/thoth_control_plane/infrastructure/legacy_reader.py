"""Read-only translation of legacy Rust jobs into v1 workflow contracts."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from thoth_control_plane.domain import (
    Actor,
    EventKind,
    WorkflowEvent,
    WorkflowFailure,
    WorkflowStatus,
    WorkflowSummary,
)
from thoth_control_plane.domain.models import StageProgress, StageSummary, WorkflowSource

_STATUS_MAP = {
    "queued": WorkflowStatus.QUEUED,
    "running": WorkflowStatus.RUNNING,
    "succeeded": WorkflowStatus.SUCCEEDED,
    "failed": WorkflowStatus.FAILED,
    "cancelled": WorkflowStatus.CANCELLED,
}
_STAGE_MAP = {
    "validation": ("validation", "Checking the request"),
    "scout": ("source", "Finding the original source"),
    "source": ("source", "Finding the original source"),
    "assets": ("assets", "Preparing visual assets"),
    "narration": ("narration", "Creating narration"),
    "render": ("render", "Rendering the video"),
    "review": ("review", "Reviewing the output"),
    "delivery": ("delivery", "Preparing delivery"),
}
_TERMINAL_EVENT_KINDS = {
    "done": EventKind.WORKFLOW_COMPLETED,
    "error": EventKind.WORKFLOW_FAILED,
    "cancelled": EventKind.WORKFLOW_CANCELLED,
}
_SENSITIVE_VALUE = re.compile(
    r"(?i)\b(token|secret|cookie|authorization|signed[_-]?url|provider[_-]?payload)"
    r"\s*[:=]\s*[^\s,;]+"
)
_HTTP_URL = re.compile(r"https?://[^\s]+", re.IGNORECASE)
_LOCAL_PATH = re.compile(r"(?<!\w)(?:[A-Za-z]:[\\/]|\\\\|/)[^\s,;]+")


class LegacyJobNotFound(Exception):
    """The configured legacy server could not find a requested job."""


class LegacyJobMappingError(ValueError):
    """Structured legacy data cannot be represented safely by the v1 contract."""


@dataclass(frozen=True)
class _LegacyEvent:
    sequence: int
    kind: str
    stage: str | None
    progress: float | None
    message: str | None
    occurred_at: str


class LegacyJobReader:
    """Read legacy job observations without invoking any state-changing endpoints."""

    def __init__(self, *, client: httpx.AsyncClient, stream_token: str | None = None) -> None:
        self._client = client
        self._stream_token = stream_token

    @classmethod
    def from_settings(cls, base_url: str, api_key: str) -> LegacyJobReader:
        """Create the authenticated GET-only legacy client from a validated settings pair."""
        client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
        )
        return cls(client=client, stream_token=api_key)

    async def get_summary(self, legacy_job_id: str, actor: Actor) -> WorkflowSummary:
        """Fetch one structured job record and convert only its safe public fields."""
        del actor  # Legacy jobs have no actor model; authorization is scoped to this bridge.
        _workflow_id(legacy_job_id)
        response = await self._client.get(f"/api/jobs/{legacy_job_id}")
        if response.status_code == httpx.codes.NOT_FOUND:
            raise LegacyJobNotFound from None
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, Mapping):
            raise LegacyJobMappingError("legacy job response was not an object")
        return self._summary_from_record(legacy_job_id, payload)

    async def iter_events(
        self, legacy_job_id: str, after_sequence: int
    ) -> AsyncIterator[WorkflowEvent]:
        """Replay only normalized events after a legacy event sequence cursor."""
        if after_sequence < 0:
            raise LegacyJobMappingError("event sequence must not be negative")
        _workflow_id(legacy_job_id)
        params: dict[str, str | int] = {"after": after_sequence}
        if self._stream_token is not None:
            params["token"] = self._stream_token
        response = await self._client.get(f"/api/jobs/{legacy_job_id}/stream", params=params)
        if response.status_code == httpx.codes.NOT_FOUND:
            raise LegacyJobNotFound from None
        response.raise_for_status()
        for record in _parse_sse_records(response.text):
            if record.sequence <= after_sequence:
                continue
            event = self._event_from_record(legacy_job_id, record)
            if event is not None:
                yield event

    def _summary_from_record(
        self, legacy_job_id: str, record: Mapping[str, Any]
    ) -> WorkflowSummary:
        status = _STATUS_MAP.get(record.get("status"))
        if status is None:
            raise LegacyJobMappingError("legacy job has an unknown status")
        created_at = _required_string(record, "created_at")
        updated_at = _required_string(record, "updated_at")
        stage = _stage_summary(record.get("stage"), record.get("pct"), status)
        stages = [stage] if stage is not None else []
        failure = None
        if status == WorkflowStatus.FAILED:
            failure = WorkflowFailure(
                code="legacy_job_failed",
                message="The legacy job failed",
                failed_stage=stage.id if stage is not None else None,
            )
        return WorkflowSummary(
            workflow_id=_workflow_id(legacy_job_id),
            status=status,
            created_at=created_at,
            updated_at=updated_at,
            source=_safe_source(record.get("spec"), legacy_job_id),
            stages=stages,
            failure=failure,
        )

    def _event_from_record(self, legacy_job_id: str, record: _LegacyEvent) -> WorkflowEvent | None:
        workflow_id = _workflow_id(legacy_job_id)
        event_id = f"{workflow_id}_event_{record.sequence}"
        terminal_kind = _TERMINAL_EVENT_KINDS.get(record.kind)
        if terminal_kind is not None:
            return WorkflowEvent(
                workflow_id=workflow_id,
                event_id=event_id,
                sequence=record.sequence,
                kind=terminal_kind,
                occurred_at=record.occurred_at,
                message={
                    EventKind.WORKFLOW_COMPLETED: "The legacy job completed",
                    EventKind.WORKFLOW_FAILED: "The legacy job failed",
                    EventKind.WORKFLOW_CANCELLED: "The legacy job was cancelled",
                }[terminal_kind],
            )
        if record.kind == "progress":
            stage = _stage_progress(record.stage, record.progress)
            if stage is not None:
                return WorkflowEvent(
                    workflow_id=workflow_id,
                    event_id=event_id,
                    sequence=record.sequence,
                    kind=EventKind.STAGE_PROGRESS,
                    occurred_at=record.occurred_at,
                    stage=stage,
                )
        if record.message:
            return WorkflowEvent(
                workflow_id=workflow_id,
                event_id=event_id,
                sequence=record.sequence,
                kind=EventKind.DIAGNOSTIC_RECORDED,
                occurred_at=record.occurred_at,
                message=_redact_diagnostic(record.message),
            )
        return None


def _workflow_id(legacy_job_id: str) -> str:
    value = f"legacy_{legacy_job_id}"
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,127}", value):
        raise LegacyJobMappingError("legacy job ID is not a safe opaque identifier")
    return value


def _required_string(record: Mapping[str, Any], key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str):
        raise LegacyJobMappingError(f"legacy job has no valid {key}")
    return value


def _stage_summary(
    legacy_stage: object, progress: object, workflow_status: WorkflowStatus
) -> StageSummary | None:
    if not isinstance(legacy_stage, str) or legacy_stage not in _STAGE_MAP:
        return None
    stage_id, label = _STAGE_MAP[legacy_stage]
    stage_status = {
        WorkflowStatus.QUEUED: "queued",
        WorkflowStatus.RUNNING: "running",
        WorkflowStatus.SUCCEEDED: "completed",
        WorkflowStatus.FAILED: "failed",
        WorkflowStatus.CANCELLED: "cancelled",
        WorkflowStatus.AWAITING_APPROVAL: "waiting",
    }[workflow_status]
    return StageSummary(
        id=stage_id,
        label=label,
        status=stage_status,
        progress=_valid_progress(progress),
    )


def _stage_progress(legacy_stage: str | None, progress: float | None) -> StageProgress | None:
    if legacy_stage not in _STAGE_MAP or progress is None:
        return None
    stage_id, _ = _STAGE_MAP[legacy_stage]
    value = _valid_progress(progress)
    if value is None:
        return None
    return StageProgress(name=stage_id, progress=value)


def _valid_progress(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    converted = float(value)
    return converted if 0 <= converted <= 1 else None


def _safe_source(spec: object, legacy_job_id: str) -> WorkflowSource:
    url = spec.get("url") if isinstance(spec, Mapping) else None
    if isinstance(url, str):
        parsed = urlsplit(url)
        if parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username:
            display_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
            platform = re.sub(r"[^a-z0-9_]", "_", parsed.hostname.lower()).strip("_")
            if platform:
                return WorkflowSource(display_url=display_url, platform=platform[:63])
    return WorkflowSource(
        display_url=f"https://legacy.invalid/jobs/{legacy_job_id}",
        platform="legacy",
    )


def _parse_sse_records(body: str) -> list[_LegacyEvent]:
    records: list[_LegacyEvent] = []
    for block in re.split(r"\r?\n\r?\n", body):
        data_lines = [line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")]
        if not data_lines:
            continue
        try:
            payload = json.loads("\n".join(data_lines))
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, Mapping):
            continue
        sequence = payload.get("seq")
        kind = payload.get("type")
        timestamp = payload.get("ts")
        if isinstance(sequence, bool) or not isinstance(sequence, int):
            continue
        if not isinstance(kind, str) or not isinstance(timestamp, str):
            continue
        stage = payload.get("stage")
        progress = payload.get("pct")
        message = payload.get("message")
        records.append(
            _LegacyEvent(
                sequence=sequence,
                kind=kind,
                stage=stage if isinstance(stage, str) else None,
                progress=float(progress) if isinstance(progress, (int, float)) else None,
                message=message if isinstance(message, str) else None,
                occurred_at=timestamp,
            )
        )
    return sorted(records, key=lambda record: record.sequence)


def _redact_diagnostic(message: str) -> str:
    redacted = _SENSITIVE_VALUE.sub(lambda match: f"{match.group(1)}=[REDACTED]", message)
    redacted = _HTTP_URL.sub("[REDACTED_URL]", redacted)
    redacted = _LOCAL_PATH.sub("[REDACTED_PATH]", redacted)
    return redacted[:2_000] or "Legacy diagnostic recorded"
