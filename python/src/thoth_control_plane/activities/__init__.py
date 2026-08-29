"""Typed Python activities registered by the control-plane worker."""

from thoth_control_plane.activities.legacy_scout import (
    LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES,
    LEGACY_ADAPTER_TASK_QUEUE,
    LegacyScoutActivity,
    LegacyScoutInput,
    inspect_legacy_scout,
)
from thoth_control_plane.activities.source_investigation import (
    SourceInvestigationActivityInput,
    inspect_source_candidates,
)

__all__ = [
    "LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES",
    "LEGACY_ADAPTER_TASK_QUEUE",
    "LegacyScoutActivity",
    "LegacyScoutInput",
    "SourceInvestigationActivityInput",
    "inspect_legacy_scout",
    "inspect_source_candidates",
]
