"""Project-scoped PostgreSQL persistence for Prompt Lab revisions and bindings."""

from __future__ import annotations

from psycopg import AsyncConnection

from thoth_control_plane.application.ports import (
    PromptBindingNotFound,
    PromptBindingRevisionConflict,
    PromptTemplateNotFound,
    PromptTemplateRevisionConflict,
)
from thoth_control_plane.domain.prompts import (
    ProjectPromptBinding,
    PromptStageId,
    PromptTemplateRevision,
    SaveProjectPromptBindingRequest,
)

TEMPLATE_ROW_KEYS = ("project_id", "template_id", "revision", "stage_id", "language", "body")
BINDING_ROW_KEYS = (
    "project_id",
    "stage_id",
    "template_id",
    "template_revision",
    "project_override",
    "revision",
)


class PromptLabPersistenceError(Exception):
    """The prompt lab store is unavailable without leaking connection details."""

    def __init__(self) -> None:
        super().__init__("prompt lab persistence unavailable")


def _template(row: tuple[object, ...]) -> PromptTemplateRevision:
    return PromptTemplateRevision.model_validate(dict(zip(TEMPLATE_ROW_KEYS, row, strict=True)))


def _binding(row: tuple[object, ...]) -> ProjectPromptBinding:
    return ProjectPromptBinding.model_validate(dict(zip(BINDING_ROW_KEYS, row, strict=True)))


class PostgresPromptLabRepository:
    """Open one short-lived async connection per project-scoped operation."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def list_template_heads(
        self, *, project_id: str, stage_id: PromptStageId
    ) -> list[PromptTemplateRevision]:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT DISTINCT ON (template_id) project_id, template_id, revision, stage_id,
                        language, body
                    FROM prompt_template_revisions
                    WHERE project_id = %s AND stage_id = %s
                    ORDER BY template_id, revision DESC
                    """,
                    (project_id, stage_id),
                )
                rows = await cursor.fetchall()
                return [_template(row) for row in rows]
        except Exception as error:
            raise PromptLabPersistenceError() from error

    async def get_template_revision(
        self, *, project_id: str, template_id: str, revision: int
    ) -> PromptTemplateRevision | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT project_id, template_id, revision, stage_id, language, body
                    FROM prompt_template_revisions
                    WHERE project_id = %s AND template_id = %s AND revision = %s
                    """,
                    (project_id, template_id, revision),
                )
                row = await cursor.fetchone()
                return _template(row) if row else None
        except Exception as error:
            raise PromptLabPersistenceError() from error

    async def save_template(
        self,
        *,
        project_id: str,
        template_id: str,
        base_revision: int | None,
        stage_id: PromptStageId,
        language: str,
        body: str,
    ) -> PromptTemplateRevision:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                    (project_id, template_id),
                )
                await cursor.execute(
                    """
                    SELECT project_id, template_id, revision, stage_id, language, body
                    FROM prompt_template_revisions
                    WHERE project_id = %s AND template_id = %s
                    ORDER BY revision DESC LIMIT 1
                    FOR UPDATE
                    """,
                    (project_id, template_id),
                )
                row = await cursor.fetchone()
                latest = _template(row) if row else None
                if base_revision is None:
                    if latest is not None:
                        raise PromptTemplateRevisionConflict(latest)
                    next_revision = 1
                else:
                    if latest is None:
                        raise PromptTemplateNotFound()
                    if latest.revision != base_revision:
                        raise PromptTemplateRevisionConflict(latest)
                    next_revision = latest.revision + 1
                saved = PromptTemplateRevision.model_validate(
                    {
                        "project_id": project_id,
                        "template_id": template_id,
                        "revision": next_revision,
                        "stage_id": stage_id,
                        "language": language,
                        "body": body,
                    }
                )
                await cursor.execute(
                    """
                    INSERT INTO prompt_template_revisions
                        (project_id, template_id, revision, stage_id, language, body)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        saved.project_id,
                        saved.template_id,
                        saved.revision,
                        saved.stage_id,
                        saved.language,
                        saved.body,
                    ),
                )
                return saved
        except (PromptTemplateRevisionConflict, PromptTemplateNotFound):
            raise
        except Exception as error:
            raise PromptLabPersistenceError() from error

    async def get_binding(
        self, *, project_id: str, stage_id: PromptStageId
    ) -> ProjectPromptBinding | None:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    """
                    SELECT project_id, stage_id, template_id, template_revision,
                        project_override, revision
                    FROM project_prompt_bindings
                    WHERE project_id = %s AND stage_id = %s
                    """,
                    (project_id, stage_id),
                )
                row = await cursor.fetchone()
                return _binding(row) if row else None
        except Exception as error:
            raise PromptLabPersistenceError() from error

    async def save_binding(
        self,
        *,
        project_id: str,
        stage_id: PromptStageId,
        request: SaveProjectPromptBindingRequest,
    ) -> ProjectPromptBinding:
        try:
            connection = await AsyncConnection.connect(self._database_url)
            async with connection:
                cursor = connection.cursor()
                await cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                    (project_id, stage_id),
                )
                await cursor.execute(
                    """
                    SELECT project_id, stage_id, template_id, template_revision,
                        project_override, revision
                    FROM project_prompt_bindings
                    WHERE project_id = %s AND stage_id = %s
                    FOR UPDATE
                    """,
                    (project_id, stage_id),
                )
                row = await cursor.fetchone()
                latest = _binding(row) if row else None
                if request.base_revision is None:
                    if latest is not None:
                        raise PromptBindingRevisionConflict(latest)
                    next_revision = 1
                else:
                    if latest is None:
                        raise PromptBindingNotFound()
                    if latest.revision != request.base_revision:
                        raise PromptBindingRevisionConflict(latest)
                    next_revision = latest.revision + 1
                if latest is None:
                    await cursor.execute(
                        """
                        INSERT INTO project_prompt_bindings
                            (project_id, stage_id, template_id, template_revision,
                                project_override, revision)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            project_id,
                            stage_id,
                            request.template_id,
                            request.template_revision,
                            request.project_override,
                            next_revision,
                        ),
                    )
                else:
                    await cursor.execute(
                        """
                        UPDATE project_prompt_bindings
                        SET template_id = %s, template_revision = %s, project_override = %s,
                            revision = %s, updated_at = CURRENT_TIMESTAMP
                        WHERE project_id = %s AND stage_id = %s
                        """,
                        (
                            request.template_id,
                            request.template_revision,
                            request.project_override,
                            next_revision,
                            project_id,
                            stage_id,
                        ),
                    )
                return ProjectPromptBinding.model_validate(
                    {
                        "project_id": project_id,
                        "stage_id": stage_id,
                        "template_id": request.template_id,
                        "template_revision": request.template_revision,
                        "project_override": request.project_override,
                        "revision": next_revision,
                    }
                )
        except (PromptBindingRevisionConflict, PromptBindingNotFound):
            raise
        except Exception as error:
            raise PromptLabPersistenceError() from error
