"""Temporal worker entry point for the Python control plane."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from thoth_control_plane.acquisition.browser import ScraplingCapability, check_scrapling_capability
from thoth_control_plane.activities import (
    LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES,
    LEGACY_ADAPTER_TASK_QUEUE,
    AcquisitionRunner,
    build_legacy_scout_activity,
    build_source_investigation_activity,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.infrastructure.temporal_gateway import TASK_QUEUE
from thoth_control_plane.workflows import SourceInvestigationWorkflow


def build_source_investigation_worker(
    client: Client,
    settings: Settings,
    *,
    runner: AcquisitionRunner | None = None,
    capability: ScraplingCapability | Mapping[str, object] | None = None,
) -> Worker:
    """Register the production source activity with its configured artifact root."""
    return Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[SourceInvestigationWorkflow],
        activities=[
            build_source_investigation_activity(settings, runner=runner, capability=capability)
        ],
        max_concurrent_activities=1,
    )


async def run_worker(settings: Settings | None = None) -> None:
    """Run normal activities and the isolated single-concurrency legacy adapter."""
    runtime_settings = settings or Settings()  # type: ignore[call-arg]
    capability = await check_scrapling_capability()
    client = await Client.connect(
        runtime_settings.THOTH_TEMPORAL_TARGET,
        namespace=runtime_settings.THOTH_TEMPORAL_NAMESPACE,
        data_converter=pydantic_data_converter,
    )
    async with (
        build_source_investigation_worker(client, runtime_settings, capability=capability),
        Worker(
            client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[
                build_legacy_scout_activity(runtime_settings.THOTH_CONTROL_PLANE_ARTIFACT_ROOT)
            ],
            max_concurrent_activities=LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES,
        ),
    ):
        await asyncio.Future()


def main() -> None:
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
