"""Strict, serializable v1 workflow contracts with safe diagnostic redaction."""

from __future__ import annotations

import math
import re
from datetime import datetime
from enum import StrEnum
from hashlib import sha256
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

OPAQUE_ID_PATTERN = r"^[A-Za-z][A-Za-z0-9_-]{0,127}$"
SHA256_PATTERN = r"^sha256:[0-9a-fA-F]{64}$"
SENSITIVE_KEY_PARTS = frozenset(
    {"token", "secret", "cookie", "authorization", "signedurl", "providerpayload"}
)
RFC3339_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)

OpaqueId = Annotated[str, Field(pattern=OPAQUE_ID_PATTERN)]
Checksum = Annotated[str, Field(pattern=SHA256_PATTERN)]


class StrictModel(BaseModel):
    """Base model that rejects implicit coercion and unversioned fields."""

    model_config = ConfigDict(extra="forbid", strict=True)

    def redacted_dict(self) -> dict[str, Any]:
        """Return a recursively redacted representation suitable for diagnostics."""
        return _redact(self.model_dump(mode="json"))


def _redact(value: Any, *, key: str | None = None) -> Any:
    normalized_key = re.sub(r"[^a-z0-9]", "", key.lower()) if key is not None else ""
    if any(part in normalized_key for part in SENSITIVE_KEY_PARTS):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            item_key: _redact(item_value, key=item_key) for item_key, item_value in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _parse_rfc3339_timestamp(value: datetime | str) -> datetime:
    if isinstance(value, str):
        if not RFC3339_TIMESTAMP_PATTERN.fullmatch(value):
            raise ValueError("timestamp must be RFC 3339")
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("timestamp must be RFC 3339") from error
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must be RFC 3339 with a timezone offset")
    return value


class WorkflowStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EventKind(StrEnum):
    WORKFLOW_QUEUED = "workflow.queued"
    WORKFLOW_STARTED = "workflow.started"
    WORKFLOW_COMPLETED = "workflow.completed"
    WORKFLOW_FAILED = "workflow.failed"
    WORKFLOW_CANCELLED = "workflow.cancelled"
    STAGE_STARTED = "stage.started"
    STAGE_PROGRESS = "stage.progress"
    STAGE_COMPLETED = "stage.completed"
    APPROVAL_REQUIRED = "approval.required"
    APPROVAL_RECORDED = "approval.recorded"
    ARTIFACT_CREATED = "artifact.created"
    DIAGNOSTIC_RECORDED = "diagnostic.recorded"


class SourceInput(StrictModel):
    url: HttpUrl
    intent: Literal["identify_original", "produce_video"]

    @field_validator("url")
    @classmethod
    def validate_public_url(cls, url: HttpUrl) -> HttpUrl:
        if url.username is not None or url.password is not None:
            raise ValueError("source URL must not contain credentials")
        return url


class StyleChoice(StrictModel):
    preset_id: OpaqueId


class StylePreset(StrictModel):
    preset_id: OpaqueId
    label: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(min_length=1, max_length=2_000)]


class OutputRequest(StrictModel):
    format: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    language: Annotated[str, Field(pattern=r"^[a-z]{2,3}(?:-[A-Z]{2})?$")]


class ReviewRequest(StrictModel):
    require_publish_approval: bool


class WorkflowRequest(StrictModel):
    source: SourceInput
    style: StyleChoice
    output: OutputRequest
    review: ReviewRequest


class ArtifactRef(StrictModel):
    artifact_id: OpaqueId
    kind: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    label: Annotated[str, Field(min_length=1, max_length=500)]
    media_type: Annotated[str, Field(pattern=r"^[a-z][a-z0-9.+-]*/[a-z][a-z0-9.+-]*$")]
    location: Annotated[str, Field(min_length=1, max_length=1_024)]
    checksum: Checksum | None = None
    size_bytes: Annotated[int, Field(ge=0)] | None = None

    @field_validator("location")
    @classmethod
    def validate_location(cls, location: str) -> str:
        normalized = location.replace("\\", "/")
        parsed = urlsplit(normalized)
        if (
            location.startswith(("/", "\\"))
            or re.match(r"^[A-Za-z]:", location)
            or parsed.scheme
            or parsed.netloc
            or parsed.username
            or parsed.password
            or "?" in location
            or "#" in location
            or any(segment == ".." for segment in normalized.split("/"))
        ):
            raise ValueError("artifact location must be a safe relative durable path")
        return normalized


class StageProgress(StrictModel):
    name: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    progress: float | None = None

    @field_validator("progress")
    @classmethod
    def validate_progress(cls, progress: float | None) -> float | None:
        if progress is not None and (not math.isfinite(progress) or not 0 <= progress <= 1):
            raise ValueError("stage progress must be finite and between 0 and 1")
        return progress


class WorkflowEvent(StrictModel):
    workflow_id: OpaqueId
    event_id: OpaqueId
    sequence: Annotated[int, Field(gt=0)]
    kind: EventKind
    occurred_at: datetime
    stage: StageProgress | None = None
    artifact: ArtifactRef | None = None
    message: Annotated[str, Field(min_length=1, max_length=2_000)] | None = None

    @field_validator("kind", mode="before")
    @classmethod
    def validate_kind(cls, kind: EventKind | str) -> EventKind:
        return EventKind(kind)

    @field_validator("occurred_at", mode="before")
    @classmethod
    def validate_timestamp(cls, occurred_at: datetime | str) -> datetime:
        return _parse_rfc3339_timestamp(occurred_at)

    @model_validator(mode="after")
    def validate_event_payload(self) -> WorkflowEvent:
        if self.kind == EventKind.STAGE_PROGRESS and self.stage is None:
            raise ValueError("stage_progress events require stage data")
        if self.kind == EventKind.ARTIFACT_CREATED and self.artifact is None:
            raise ValueError("artifact_created events require an artifact")
        return self


class Actor(StrictModel):
    actor_id: OpaqueId
    actor_type: Literal["user", "service"]
    display_name: Annotated[str, Field(min_length=1, max_length=200)] | None = None


class ActorSnapshot(StrictModel):
    actor_id: OpaqueId
    actor_type: Literal["user", "service"]
    display_name: Annotated[str, Field(min_length=1, max_length=200)] | None = None


class ApprovalRequest(StrictModel):
    approval_id: OpaqueId
    kind: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    prompt: Annotated[str, Field(min_length=1, max_length=2_000)]
    allowed_decisions: list[Literal["approve", "reject"]]


class ApprovalDecision(StrictModel):
    decision: Literal["approve", "reject"]
    note: Annotated[str, Field(max_length=2_000)] | None = None
    provider_payload: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ApprovalSignal(StrictModel):
    approval_id: OpaqueId
    decision: ApprovalDecision
    actor: ActorSnapshot
    decided_at: datetime

    @field_validator("decided_at", mode="before")
    @classmethod
    def validate_timestamp(cls, timestamp: datetime | str) -> datetime:
        return _parse_rfc3339_timestamp(timestamp)


class WorkflowFailure(StrictModel):
    code: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    message: Annotated[str, Field(min_length=1, max_length=2_000)]
    failed_stage: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")] | None = None
    retryable: bool = False


class WorkflowSource(StrictModel):
    display_url: HttpUrl
    platform: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class StageSummary(StrictModel):
    id: Annotated[
        str, Field(pattern=r"^(validation|source|assets|narration|render|review|delivery)$")
    ]
    label: Annotated[str, Field(min_length=1, max_length=500)]
    status: Literal["queued", "running", "completed", "waiting", "failed", "cancelled"]
    progress: float | None = None

    @field_validator("progress")
    @classmethod
    def validate_progress(cls, progress: float | None) -> float | None:
        if progress is not None and (not math.isfinite(progress) or not 0 <= progress <= 1):
            raise ValueError("stage progress must be finite and between 0 and 1")
        return progress


class WorkflowSummary(StrictModel):
    workflow_id: OpaqueId
    status: WorkflowStatus
    created_at: datetime
    updated_at: datetime
    source: WorkflowSource
    stages: list[StageSummary]
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    approval: ApprovalRequest | None = None
    failure: WorkflowFailure | None = None

    @field_validator("status", mode="before")
    @classmethod
    def validate_status(cls, status: WorkflowStatus | str) -> WorkflowStatus:
        return WorkflowStatus(status)

    @field_validator("created_at", "updated_at", mode="before")
    @classmethod
    def validate_timestamp(cls, timestamp: datetime | str) -> datetime:
        return _parse_rfc3339_timestamp(timestamp)


SourceActivityMode = Literal[
    "python",
    "python_tiktok_with_legacy_fallback",
    "legacy_scout",
]


class SourceInvestigationInput(StrictModel):
    source_url: HttpUrl


class SourceCandidate(StrictModel):
    candidate_id: OpaqueId
    citation: Annotated[str, Field(min_length=1, max_length=2_000)]
    score: float

    @field_validator("score")
    @classmethod
    def validate_score(cls, score: float) -> float:
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("candidate score must be finite and between 0 and 1")
        return score


class SourceInvestigationResult(StrictModel):
    candidates: list[SourceCandidate] = Field(default_factory=list)
    report: ArtifactRef | None = None
    failure: SafeActivityError | None = None
    events: list[SourceProgressEvent] = Field(default_factory=list)
    diagnostics: list[Annotated[str, Field(min_length=1, max_length=2_000)]] = Field(
        default_factory=list
    )

    @model_validator(mode="after")
    def require_exactly_one_outcome(self) -> SourceInvestigationResult:
        if (self.report is None) == (self.failure is None):
            raise ValueError("source investigation result must contain exactly one outcome")
        return self


class SourceProgressEvent(StrictModel):
    """Small machine-readable compatibility event; never derived from CLI prose."""

    kind: Literal[
        "stage.started", "stage.progress", "stage.completed", "stage.failed", "stage.cancelled"
    ]
    payload: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


LegacyScoutProgressEvent = SourceProgressEvent
"""Backward-compatible alias; import compatibility only, do not extend."""


class SafeActivityError(StrictModel):
    """A stable activity error safe to store in Temporal history."""

    code: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    retryable: bool


class SourceInvestigationActivityResult(StrictModel):
    """The history-safe result from source investigation."""

    report: ArtifactRef | None = None
    failure: SafeActivityError | None = None
    events: list[SourceProgressEvent] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_exactly_one_outcome(self) -> SourceInvestigationActivityResult:
        if (self.report is None) == (self.failure is None):
            raise ValueError("activity result must contain exactly one outcome")
        return self


class SourceInvestigationWorkflowInput(StrictModel):
    """The minimal, redacted Temporal workflow input."""

    request_snapshot_id: OpaqueId
    source: WorkflowSource
    intent: Literal["identify_original", "produce_video"]
    actor: ActorSnapshot
    activity_mode: SourceActivityMode = "python"


def request_snapshot_id(request: WorkflowRequest) -> str:
    """Return the opaque fingerprint used to compare durable start requests."""
    digest = sha256(request.model_dump_json().encode()).hexdigest()
    return f"req_{digest[:24]}"


def safe_workflow_source(request: WorkflowRequest) -> WorkflowSource:
    """Strip a request URL to the display-safe source representation."""
    parsed = urlsplit(str(request.source.url))
    display_url = urlsplit(str(request.source.url))._replace(query="", fragment="").geturl()
    labels = (parsed.hostname or "unknown").lower().split(".")
    platform = labels[-2] if len(labels) > 1 else labels[0]
    platform = re.sub(r"[^a-z0-9_]", "_", platform).strip("_") or "unknown"
    return WorkflowSource(display_url=display_url, platform=platform)
