"""Temporal worker entry point for the Python control plane."""

from __future__ import annotations

import asyncio

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from thoth_control_plane.activities import (
    LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES,
    LEGACY_ADAPTER_TASK_QUEUE,
    inspect_legacy_scout,
    inspect_source_candidates,
)
from thoth_control_plane.config import Settings
from thoth_control_plane.infrastructure.temporal_gateway import TASK_QUEUE
from thoth_control_plane.workflows import SourceInvestigationWorkflow


async def run_worker(settings: Settings | None = None) -> None:
    """Run normal activities and the isolated single-concurrency legacy adapter."""
    runtime_settings = settings or Settings()  # type: ignore[call-arg]
    client = await Client.connect(
        runtime_settings.THOTH_TEMPORAL_TARGET,
        namespace=runtime_settings.THOTH_TEMPORAL_NAMESPACE,
        data_converter=pydantic_data_converter,
    )
    async with (
        Worker(
            client,
            task_queue=TASK_QUEUE,
            workflows=[SourceInvestigationWorkflow],
            activities=[inspect_source_candidates],
        ),
        Worker(
            client,
            task_queue=LEGACY_ADAPTER_TASK_QUEUE,
            activities=[inspect_legacy_scout],
            max_concurrent_activities=LEGACY_ADAPTER_MAX_CONCURRENT_ACTIVITIES,
        ),
    ):
        await asyncio.Future()


def main() -> None:
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
