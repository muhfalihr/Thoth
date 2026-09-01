"""Typed Python activities registered by the control-plane worker."""

from thoth_control_plane.activities.legacy_scout import (
    LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES,
    LEGACY_ADAPTER_TASK_QUEUE,
    LegacyScoutActivity,
    LegacyScoutInput,
    build_legacy_scout_activity,
    inspect_legacy_scout,
)
from thoth_control_plane.activities.source_investigation import (
    AcquisitionRunner,
    SourceInvestigationActivityInput,
    build_source_investigation_activity,
    inspect_source_candidates,
)

__all__ = [
    "LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES",
    "LEGACY_ADAPTER_TASK_QUEUE",
    "AcquisitionRunner",
    "LegacyScoutActivity",
    "LegacyScoutInput",
    "SourceInvestigationActivityInput",
    "build_legacy_scout_activity",
    "build_source_investigation_activity",
    "inspect_legacy_scout",
    "inspect_source_candidates",
]
