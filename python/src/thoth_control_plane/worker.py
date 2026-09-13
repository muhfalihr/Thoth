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
from thoth_control_plane.activities.prompt_proposal import (
    PROMPT_PROPOSAL_TASK_QUEUE,
    build_prompt_proposal_activity,
)
from thoth_control_plane.config import Settings, SettingsValidationError
from thoth_control_plane.infrastructure.prompt_proposal_repository import (
    PostgresPromptProposalRepository,
)
from thoth_control_plane.infrastructure.prompt_provider import OpenAICompatiblePromptProvider
from thoth_control_plane.infrastructure.temporal_gateway import TASK_QUEUE
from thoth_control_plane.observability import configure_provider_logging
from thoth_control_plane.workflows import SourceInvestigationWorkflow
from thoth_control_plane.workflows.prompt_proposal import PromptProposalWorkflow


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


def build_prompt_proposal_worker(client: Client, settings: Settings) -> Worker:
    """Register the proposal activity on its dedicated queue with stored secrets."""
    catalog = settings.THOTH_PROMPT_PROVIDER_CATALOG
    enabled = tuple(provider for provider in catalog if provider.enabled)
    secrets = settings.prompt_provider_secrets
    for provider in enabled:
        if provider.credential_id not in secrets:
            # Safe startup failure: never name the provider, model, or credential value.
            raise SettingsValidationError(
                "prompt provider catalog is enabled without its worker credential"
            )
    repository = PostgresPromptProposalRepository(
        settings.THOTH_EDITOR_DATABASE_URL.get_secret_value()
        if settings.THOTH_EDITOR_DATABASE_URL is not None
        else ""
    )
    provider_adapter = OpenAICompatiblePromptProvider(
        runtime_catalog=catalog,
        secrets=secrets,
    )
    activity = build_prompt_proposal_activity(repository=repository, provider=provider_adapter)
    return Worker(
        client,
        task_queue=PROMPT_PROPOSAL_TASK_QUEUE,
        workflows=[PromptProposalWorkflow],
        activities=[activity.run],
        max_concurrent_activities=1,
    )


async def run_worker(settings: Settings | None = None) -> None:
    """Run normal activities and the isolated single-concurrency legacy adapter."""
    runtime_settings = settings or Settings()  # type: ignore[call-arg]
    configure_provider_logging()
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
