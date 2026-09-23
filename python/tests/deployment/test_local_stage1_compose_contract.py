import re
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

#: Rendering is an overlay, not a member of the base stack. See
#: ``test_renderer_is_opt_in_and_the_base_stack_carries_no_renderer_input``.
RENDERER_OVERLAY = "compose.stage1.renderer.yml"


def _repo_text(relative_path: str) -> str:
    return (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8")


def _service_block(compose: str, service: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(service)}:\n(?P<body>.*?)(?=^  [a-z][a-z0-9-]*:\n|^networks:|\Z)",
        compose,
    )
    assert match is not None, f"missing Compose service: {service}"
    return match.group("body")


def test_local_stage1_secret_and_evidence_inputs_are_git_safe() -> None:
    gitignore = _repo_text(".gitignore")
    env_example = _repo_text(".env.stage1.local.example")

    assert ".env.stage1.local" in gitignore
    assert "stage1-local-observations*.jsonl" in gitignore
    assert "stage1-local-reports/" in gitignore
    assert "THOTH_IMAGE=ghcr.io/muhfalihr/thoth@sha256:" + "0" * 64 in env_example
    assert "THOTH_STAGE1_DATA_ROOT=/absolute/path/outside/repository/thoth-stage1" in env_example
    assert "THOTH_CONTROL_PLANE_API_KEY=replace-with-local-secret" in env_example
    assert "THOTH_POSTGRES_PASSWORD=replace-with-local-secret" in env_example
    assert "THOTH_STAGE1_ACTIVITY_MODE=python_tiktok_with_legacy_fallback" in env_example
    assert "THOTH_LIVE_TIKTOK_URL=replace-with-approved-public-fixture" in env_example
    assert "https://www.tiktok.com/" not in env_example
    assert "4630917242bd9e3483c8f89ae4017438cadc23a1f699f5e516c2dc610beb18b1" not in env_example


def test_local_stage1_infrastructure_is_pinned_persistent_and_private() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    postgres = _service_block(compose, "postgresql")
    temporal = _service_block(compose, "temporal")
    temporal_ui = _service_block(compose, "temporal-ui")

    assert (
        "postgres:16.4-bookworm@sha256:"
        "e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412" in postgres
    )
    assert (
        "temporalio/auto-setup:1.29.1@sha256:"
        "5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312" in temporal
    )
    assert (
        "temporalio/ui:2.34.0@sha256:"
        "cb17ea423d76a8a19a269d0bcd81fc12eee1f6365acd2a56b590dafb35696a95" in temporal_ui
    )
    assert "${THOTH_STAGE1_DATA_ROOT:?" in postgres
    assert "/postgres" in postgres
    assert "pg_isready" in postgres
    assert "DB: postgres12" in temporal
    assert "DEFAULT_NAMESPACE: thoth-stage1" in temporal
    assert "DEFAULT_NAMESPACE_RETENTION: 30d" in temporal
    assert "temporal operator cluster health --address temporal:7233" in temporal
    assert '"127.0.0.1:8080:8080"' in temporal_ui
    assert "ports:" not in postgres
    assert "ports:" not in temporal


def test_local_stage1_thoth_roles_share_one_digest_and_keep_cdp_private() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    api = _service_block(compose, "api")
    worker = _service_block(compose, "worker")
    cdp = _service_block(compose, "legacy-cdp")

    required_image = "${THOTH_IMAGE:?set digest-qualified THOTH_IMAGE}"
    assert api.count(required_image) == 1
    assert worker.count(required_image) == 1
    assert cdp.count(required_image) == 1
    assert 'user: "10001:10001"' in api
    assert 'user: "10001:10001"' in worker
    assert 'user: "10001:10001"' in cdp
    assert '"127.0.0.1:8000:8000"' in api
    assert "ports:" not in worker
    assert "ports:" not in cdp
    assert "THOTH_TEMPORAL_TARGET: temporal:7233" in api
    assert "THOTH_TEMPORAL_TARGET: temporal:7233" in worker
    assert "THOTH_TEMPORAL_NAMESPACE: thoth-stage1" in api
    assert "THOTH_TEMPORAL_NAMESPACE: thoth-stage1" in worker
    assert "THOTH_CDP: http://legacy-cdp:18800" in worker
    approved_mode = (
        "THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: "
        "${THOTH_STAGE1_ACTIVITY_MODE:-python_tiktok_with_legacy_fallback}"
    )
    assert approved_mode in worker
    assert "/opt/thoth/bin/start-legacy-cdp" in cdp
    assert "/json/version" in cdp
    assert "/json" in cdp
    assert "tiktok.com" in cdp
    assert "/artifacts" in api
    assert "/artifacts" in worker
    assert "/browser-profile" in cdp
    assert "/browser-profile" not in api
    assert "/browser-profile" not in worker


def test_local_stage1_compose_requires_digest_qualified_thoth_image() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    assert "latest" not in compose
    assert "sha-1c904a7" not in compose
    assert compose.count("${THOTH_IMAGE:?set digest-qualified THOTH_IMAGE}") == 3


def test_local_stage1_creator_studio_uses_a_separate_editor_database() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    env_example = _repo_text(".env.stage1.local.example")
    dockerfile = _repo_text("Dockerfile")
    api = _service_block(compose, "api")
    editor_postgres = _service_block(compose, "editor-postgresql")

    assert "THOTH_EDITOR_POSTGRES_PASSWORD=replace-with-local-secret" in env_example
    assert "postgres:16.4-bookworm@sha256:" in editor_postgres
    assert (
        "${THOTH_STAGE1_DATA_ROOT:?set THOTH_STAGE1_DATA_ROOT}/editor-postgres" in editor_postgres
    )
    assert "POSTGRES_USER: thoth_editor" in editor_postgres
    assert "POSTGRES_DB: thoth_editor" in editor_postgres
    assert "THOTH_EDITOR_DATABASE_URL:" in api
    assert "editor-postgresql:5432/thoth_editor" in api
    assert "editor-postgresql:" in api
    assert "COPY --chown=thoth:thoth python/migrations/ /opt/thoth/python/migrations/" in dockerfile
    workflow = _repo_text(".github/workflows/container-image.yml")
    assert 'echo "THOTH_EDITOR_POSTGRES_PASSWORD=$(openssl rand -hex 24)"' in workflow
    assert "up -d --wait postgresql editor-postgresql temporal temporal-ui api" in workflow
    assert "thoth-control editor migrate" in workflow


def test_local_stage1_compose_is_validated_by_offline_ci() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    # Blanking both renderer inputs is the whole point: the base stack has to
    # parse for an installation that never renders anything.
    disabled = (
        "THOTH_RENDERER_IMAGE= THOTH_RENDERER_INTERNAL_CREDENTIAL= "
        "docker compose --env-file .env.stage1.local.example "
        "-f compose.stage1.local.yml config --quiet"
    )
    enabled = (
        "docker compose --env-file .env.stage1.local.example "
        f"-f compose.stage1.local.yml -f {RENDERER_OVERLAY} config --quiet"
    )
    assert "Validate local Stage 1 Compose" in workflow
    assert disabled in workflow
    assert enabled in workflow


def test_local_stage1_runbook_keeps_live_and_evidence_actions_operator_gated() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    required = {
        "docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config",
        "docker compose --env-file .env.stage1.local -f compose.stage1.local.yml pull",
        "127.0.0.1:8000/healthz",
        "127.0.0.1:8000/readyz",
        "temporal operator namespace describe --namespace thoth-stage1",
        "python_tiktok_with_legacy_fallback",
        "legacy_scout",
        "s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/observations/",
        "s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/reports/",
        "Do not run `docker compose up` for `legacy-cdp` or `worker` "
        "without explicit live approval.",
        "Do not run `docker compose down -v`",
    }
    assert all(token in runbook for token in required)
    assert "https://www.tiktok.com/@" not in runbook
    assert "THOTH_CONTROL_PLANE_API_KEY=" not in runbook
    assert "THOTH_POSTGRES_PASSWORD=" not in runbook


def test_blueprint_records_local_stage1_orchestration_without_claiming_soak() -> None:
    blueprint = _repo_text("BLUEPRINT.md")
    assert "Stage 1 local Docker orchestration" in blueprint
    assert "PostgreSQL-backed Temporal" in blueprint
    assert "controlled live smoke and operational soak remain pending" in blueprint


def test_local_stage1_live_fixture_never_reaches_a_container() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    runbook = _repo_text("docs/operations/stage1-local-docker.md")

    assert "THOTH_LIVE_TIKTOK_URL" not in compose
    assert (
        "`THOTH_LIVE_TIKTOK_URL` is a host-side pytest variable and is never injected into a "
        "container." in runbook
    )


def test_local_stage1_runbook_never_renders_resolved_secrets() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    marker = "compose.stage1.local.yml config"
    render_commands = [line.strip() for line in runbook.splitlines() if marker in line]

    assert render_commands
    for command in render_commands:
        assert command.endswith(("--quiet", "--images", "--no-interpolate"))


def test_local_stage1_runbook_inspects_topology_without_extra_tooling() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    assert "config --no-interpolate" in runbook


def test_local_stage1_rollback_recreates_the_worker_with_the_selected_mode() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    worker = _service_block(compose, "worker")

    assert "${THOTH_STAGE1_ACTIVITY_MODE:-python_tiktok_with_legacy_fallback}" in worker
    assert "up -d --no-deps --force-recreate worker" in runbook
    assert "printenv THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE" in runbook
    assert "docker compose restart` with the same digest" not in runbook


def test_local_stage1_runbook_verifies_the_deployment_before_any_live_action() -> None:
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    required = {
        "operations stage1-local-preflight --env-file .env.stage1.local --provider-env-file",
        "exec api id -u",
        "exec api test -w /var/lib/thoth/artifacts",
        # `compose port` reports an exposed port as `invalid IP:0` whether or not it is
        # published, so the runbook must read the container's own bindings instead.
        "{{json .NetworkSettings.Ports}}",
        "ps -q legacy-cdp",
        "exec worker id -u",
    }

    assert all(token in runbook for token in required)


def test_local_stage1_runbook_freezes_the_digest_for_the_soak_window() -> None:
    """Nothing in the evidence says which release produced a run.

    The observation schema has no image field, so the evaluator cannot tell two
    releases apart and silently merges them. Only the runbook can bind one digest
    to one window.
    """
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    prose = " ".join(runbook.split())
    assert "the deployed digest is frozen until the window closes" in prose
    assert "restarts the soak window" in prose
    assert "observation record carries no digest" in prose


def test_local_stage1_runbook_explains_the_cdp_seccomp_relaxation() -> None:
    """A committed sandbox relaxation needs its reason and its boundary written down."""
    compose = _repo_text("compose.stage1.local.yml")
    runbook = _repo_text("docs/operations/stage1-local-docker.md")
    prose = " ".join(runbook.split())
    assert compose.count("seccomp:unconfined") == 1
    assert "seccomp:unconfined" in prose
    assert "no other service may relax its sandbox" in prose


def test_provider_override_only_configures_the_worker() -> None:
    """The provider file is a live credential, so only the fallback worker receives it.

    The override is a second `-f` file rather than an edit to the base stack: the
    infrastructure smoke, the API, and the browser must keep starting without any
    provider input at all.
    """
    override = _repo_text("compose.stage1.providers.yml")

    assert re.findall(r"(?m)^  [a-z][a-z0-9-]*:$", override) == ["  worker:"]
    assert "${THOTH_STAGE1_PROVIDER_ENV_FILE:?" in override
    assert "required: true" in override
    for role in (
        "THOTH_SCOUT_PROVIDER",
        "THOTH_SCOUT_CHAT_PROVIDER",
        "THOTH_SCOUT_VISION_PROVIDER",
        "THOTH_SCOUT_EMBED_PROVIDER",
    ):
        assert f"{role}: novita" in override
    assert "ports:" not in override
    assert "image:" not in override


def test_provider_inputs_stay_out_of_git_and_the_build_context() -> None:
    example = _repo_text(".env.stage1.providers.example")
    gitignore = _repo_text(".gitignore")
    dockerignore = _repo_text(".dockerignore")

    assert "THOTH_NOVITA_API_KEY=replace-with-local-secret" in example
    assert "THOTH_SUBTITLE_OCR_MODEL=deepseek/deepseek-ocr" in example
    assert "not a usable provider file" in example
    assert "/stage1.providers.env" in gitignore
    assert "/stage1.providers.env" in dockerignore
    assert "**/.env*" in dockerignore


def _service_env(compose: str, service: str) -> str:
    return _service_block(compose, service)


def _env_file() -> str:
    return _repo_text(".env.stage1.local.example")


def test_prompt_provider_secrets_are_worker_only() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    api_env = _service_env(compose, "api")
    worker_env = _service_env(compose, "worker")
    assert "THOTH_PROMPT_PROVIDER_CATALOG" in api_env
    assert "THOTH_PROMPT_PROVIDER_SECRETS" not in api_env
    assert "THOTH_PROMPT_PROVIDER_SECRETS" in worker_env
    assert "THOTH_EDITOR_DATABASE_URL" in worker_env


def test_prompt_provider_example_values_stay_empty() -> None:
    env = _env_file()
    assert "THOTH_PROMPT_PROVIDER_CATALOG=[]" in env
    assert "THOTH_PROMPT_PROVIDER_SECRETS={}" in env


def test_editor_preview_signing_key_reaches_the_api_only() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    api = _service_block(compose, "api")
    env_example = _env_file()

    assert (
        "THOTH_EDITOR_PREVIEW_SIGNING_KEY: "
        "${THOTH_EDITOR_PREVIEW_SIGNING_KEY:?set THOTH_EDITOR_PREVIEW_SIGNING_KEY}" in api
    )
    # The dashboard is served outside Compose, so every other service is the check.
    for service in (
        "postgresql",
        "editor-postgresql",
        "temporal",
        "temporal-ui",
        "legacy-cdp",
        "worker",
    ):
        assert "THOTH_EDITOR_PREVIEW_SIGNING_KEY" not in _service_block(compose, service)
    assert "THOTH_EDITOR_PREVIEW_SIGNING_KEY" not in _repo_text(RENDERER_OVERLAY)
    assert "THOTH_EDITOR_PREVIEW_SIGNING_KEY=replace-with-local-secret" in env_example
    workflow = _repo_text(".github/workflows/container-image.yml")
    assert 'echo "THOTH_EDITOR_PREVIEW_SIGNING_KEY=$(openssl rand -hex 24)"' in workflow


def test_editor_preview_adds_no_service_port_or_mount() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    api = _service_block(compose, "api")

    assert api.count("target: /var/lib/thoth/artifacts") == 1
    assert api.count("127.0.0.1:8000:8000") == 1
    services = compose.split("\nnetworks:", 1)[0]
    assert re.findall(r"(?m)^  [a-z][a-z0-9-]*:$", services) == [
        "  postgresql:",
        "  editor-postgresql:",
        "  temporal:",
        "  temporal-ui:",
        "  legacy-cdp:",
        "  api:",
        "  worker:",
    ]


#: Everything ``renderer/src/config.ts`` reads, and therefore everything Compose
#: is allowed to hand the renderer. A name outside this set is either ignored by
#: the service or a capability it has no business holding.
RENDERER_ENVIRONMENT = {
    "THOTH_RENDERER_CONTROL_PLANE_URL",
    "THOTH_RENDERER_INTERNAL_CREDENTIAL",
    "THOTH_CONTROL_PLANE_ARTIFACT_ROOT",
    "THOTH_RENDERER_PORT",
    "THOTH_RENDERER_VERSION",
}


def _environment_names(block: str) -> set[str]:
    environment = re.search(
        r"(?ms)^    environment:\n(?P<body>.*?)(?=^    [a-z_]+:|\Z)",
        block,
    )
    assert environment is not None, "service declares no environment"
    return set(re.findall(r"(?m)^      ([A-Z][A-Z0-9_]*):", environment.group("body")))


def test_renderer_is_opt_in_and_the_base_stack_carries_no_renderer_input() -> None:
    """An installation that renders nothing must still parse, start, and serve.

    The control plane already degrades to an unavailable render gateway when the
    settings are absent, but a required ``${...:?}`` fails during interpolation,
    long before that code runs: Compose cannot even read the file. So the base
    stack names no renderer image, URL, or credential at all.
    """
    compose = _repo_text("compose.stage1.local.yml")
    api = _service_block(compose, "api")

    assert "THOTH_RENDERER" not in compose
    assert "remotion-renderer" not in compose
    assert not {name for name in _environment_names(api) if name.startswith("THOTH_RENDERER")}


def test_renderer_overlay_turns_rendering_on_for_both_sides_at_once() -> None:
    """One overlay is the whole switch, so the two sides cannot drift apart."""
    overlay = _repo_text(RENDERER_OVERLAY)
    api = _service_block(overlay, "api")
    renderer = _service_block(overlay, "remotion-renderer")

    assert re.findall(r"(?m)^  [a-z][a-z0-9-]*:$", overlay) == ["  api:", "  remotion-renderer:"]
    assert "THOTH_RENDERER_INTERNAL_URL: http://remotion-renderer:8080" in api
    assert (
        "THOTH_RENDERER_INTERNAL_CREDENTIAL: "
        "${THOTH_RENDERER_INTERNAL_CREDENTIAL:?set THOTH_RENDERER_INTERNAL_CREDENTIAL}" in api
    )
    # The overlay adds a capability; it never restates what the base stack owns.
    assert "image:" not in api
    assert "command:" not in api
    assert "depends_on:" not in api
    assert "${THOTH_RENDERER_IMAGE:?set digest-qualified THOTH_RENDERER_IMAGE}" in renderer


def test_enabling_only_one_half_of_the_renderer_pair_fails_closed() -> None:
    """Compose refuses a half-configured render stack before a container starts.

    Both inputs are required interpolations in the same file, and the URL is a
    literal beside them, so the API can never hold a credential without a
    renderer, nor a renderer answer without the credential to attribute it.
    """
    overlay = _repo_text(RENDERER_OVERLAY)

    assert overlay.count("${THOTH_RENDERER_IMAGE:?") == 1
    assert overlay.count("${THOTH_RENDERER_INTERNAL_CREDENTIAL:?") == 2
    assert "THOTH_RENDERER_INTERNAL_URL: ${" not in overlay
    # A default would let half a pair through as a working-looking stack.
    assert set(re.findall(r"\$\{([A-Z_]+):-", overlay)) == {"THOTH_RENDERER_VERSION"}


def test_renderer_runs_unprivileged_on_a_digest_and_the_private_network_only() -> None:
    overlay = _repo_text(RENDERER_OVERLAY)
    renderer = _service_block(overlay, "remotion-renderer")

    assert "${THOTH_RENDERER_IMAGE:?set digest-qualified THOTH_RENDERER_IMAGE}" in renderer
    assert 'user: "10001:10001"' in renderer
    assert "networks: [stage1-private]" in renderer
    # A render is a browser and an encoder: nothing about it needs a host port,
    # the daemon that started it, or a relaxed sandbox.
    assert "ports:" not in renderer
    assert "docker.sock" not in renderer
    assert "privileged" not in renderer
    assert "seccomp" not in renderer
    assert "cap_add" not in renderer


def test_renderer_receives_its_supported_settings_and_nothing_else() -> None:
    overlay = _repo_text(RENDERER_OVERLAY)
    renderer = _service_block(overlay, "remotion-renderer")

    assert "THOTH_RENDERER_CONTROL_PLANE_URL: http://api:8000" in renderer
    assert (
        "THOTH_RENDERER_INTERNAL_CREDENTIAL: "
        "${THOTH_RENDERER_INTERNAL_CREDENTIAL:?set THOTH_RENDERER_INTERNAL_CREDENTIAL}" in renderer
    )
    assert "THOTH_CONTROL_PLANE_ARTIFACT_ROOT: /var/lib/thoth/artifacts" in renderer
    assert _environment_names(renderer) == RENDERER_ENVIRONMENT


def test_renderer_holds_no_database_provider_or_creator_capability() -> None:
    overlay = _repo_text(RENDERER_OVERLAY)
    renderer = _service_block(overlay, "remotion-renderer")

    for forbidden in (
        "THOTH_EDITOR_DATABASE_URL",
        "THOTH_CONTROL_PLANE_API_KEY",
        "THOTH_EDITOR_PREVIEW_SIGNING_KEY",
        "THOTH_PROMPT_PROVIDER_CATALOG",
        "THOTH_PROMPT_PROVIDER_SECRETS",
        "THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE",
        "THOTH_CDP",
        "THOTH_TEMPORAL_TARGET",
        "THOTH_TEMPORAL_NAMESPACE",
        "POSTGRES_PASSWORD",
        "AMQP",
        "REDIS",
    ):
        assert forbidden not in renderer


def test_renderer_shares_the_one_canonical_artifact_root_and_no_second_output() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    renderer = _service_block(_repo_text(RENDERER_OVERLAY), "remotion-renderer")
    api = _service_block(compose, "api")

    mount = (
        "    volumes:\n"
        "      - type: bind\n"
        "        source: ${THOTH_STAGE1_DATA_ROOT:?set THOTH_STAGE1_DATA_ROOT}/artifacts\n"
        "        target: /var/lib/thoth/artifacts\n"
    )
    assert mount in api
    assert mount in renderer
    assert renderer.count("target:") == 1
    assert renderer.count("/browser-profile") == 0


def test_renderer_health_uses_the_authenticated_health_endpoint_it_already_serves() -> None:
    """``/health`` is Bearer-authenticated like every other renderer route.

    An unauthenticated probe would have to be a second health API, and the whole
    point of this service is that it answers nothing it cannot attribute.
    """
    overlay = _repo_text(RENDERER_OVERLAY)
    renderer = _service_block(overlay, "remotion-renderer")

    assert "healthcheck:" in renderer
    assert "http://127.0.0.1:8080/health" in renderer
    assert "Bearer" in renderer
    assert "THOTH_RENDERER_INTERNAL_CREDENTIAL" in renderer
    assert "/healthz" not in renderer
    assert "/readyz" not in renderer


def test_control_plane_dispatches_over_private_dns_and_the_worker_never_can() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    overlay = _repo_text(RENDERER_OVERLAY)
    api = _service_block(overlay, "api")
    worker = _service_block(compose, "worker")

    assert "THOTH_RENDERER_INTERNAL_URL: http://remotion-renderer:8080" in api
    assert (
        "THOTH_RENDERER_INTERNAL_CREDENTIAL: "
        "${THOTH_RENDERER_INTERNAL_CREDENTIAL:?set THOTH_RENDERER_INTERNAL_CREDENTIAL}" in api
    )
    assert "127.0.0.1:8080" not in api
    assert "localhost" not in api
    # The renderer is dispatched to by the control plane alone, enabled or not.
    assert "worker:" not in overlay
    assert "THOTH_RENDERER_INTERNAL_URL" not in worker
    assert "THOTH_RENDERER_INTERNAL_CREDENTIAL" not in worker


def test_pinned_renderer_version_is_declared_once_on_each_side() -> None:
    overlay = _repo_text(RENDERER_OVERLAY)
    api = _service_block(overlay, "api")
    renderer = _service_block(overlay, "remotion-renderer")

    pinned = "THOTH_RENDERER_VERSION: ${THOTH_RENDERER_VERSION:-remotion-4.0.523}"
    assert api.count(pinned) == 1
    assert renderer.count(pinned) == 1


def test_api_startup_never_waits_on_the_renderer() -> None:
    """A renderer that cannot start must cost the installation its renders, not its API.

    Compose ``depends_on`` would make an unhealthy renderer block the control
    plane, and the control plane already degrades to an unavailable gateway when
    the renderer settings are absent.
    """
    compose = _repo_text("compose.stage1.local.yml")
    overlay = _repo_text(RENDERER_OVERLAY)
    api = _service_block(compose, "api")
    settings = _repo_text("python/src/thoth_control_plane/config.py")

    depends = re.search(r"(?ms)^    depends_on:\n(?P<body>.*?)(?=^    [a-z_]+:|\Z)", api)
    assert depends is not None
    assert "remotion-renderer" not in depends.group("body")
    # Enabling the overlay must not add the wait the base stack refused to take.
    assert "depends_on:" not in _service_block(overlay, "api")
    assert "THOTH_RENDERER_INTERNAL_URL: AnyHttpUrl | None = None" in settings
    assert "THOTH_RENDERER_INTERNAL_CREDENTIAL: SecretStr | None = None" in settings


def test_renderer_inputs_are_placeholders_in_the_example_environment() -> None:
    env_example = _env_file()

    assert (
        "THOTH_RENDERER_IMAGE=ghcr.io/muhfalihr/thoth-remotion-renderer@sha256:" + "0" * 64
        in env_example
    )
    assert "THOTH_RENDERER_INTERNAL_CREDENTIAL=replace-with-local-secret" in env_example
