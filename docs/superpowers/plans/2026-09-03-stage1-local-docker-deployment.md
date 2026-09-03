# Stage 1 Local Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, Docker-only local Stage 1 topology for PostgreSQL-backed Temporal, Temporal UI, THOTH API, THOTH worker, and a private legacy CDP sidecar without starting a live TikTok gate.

**Architecture:** One Compose project owns six services on one bridge network. PostgreSQL and THOTH state use operator-selected bind mounts outside the repository; API and UI bind only to loopback, while Temporal gRPC, PostgreSQL, and CDP remain un-published. API, worker, and CDP interpolate one required digest-qualified THOTH image reference.

**Tech Stack:** Docker Compose v2, PostgreSQL 16.4, Temporal Server 1.29.1, Temporal UI 2.34.0, Python 3.12 contract tests, GitHub Actions, Markdown operations runbook.

**Spec:** `docs/superpowers/specs/2026-09-03-stage1-local-docker-deployment-design.md`

## Global Constraints

- Use Docker and Docker Compose exclusively for local container commands and documentation.
- Infrastructure images use the exact tag-plus-digest references from the spec.
- `THOTH_IMAGE` is required and must be a `ghcr.io/muhfalihr/thoth@sha256:<64 lowercase hex>` reference.
- API binds only to `127.0.0.1:8000`; Temporal UI binds only to `127.0.0.1:8080`.
- PostgreSQL `5432`, Temporal `7233`, and CDP `18800` have no host `ports` mapping.
- API, worker, and CDP use the same `THOTH_IMAGE` value and run as `10001:10001`.
- Worker mode remains `python_tiktok_with_legacy_fallback`; Python headless remains primary and TikWM/CDN remains fallback.
- Runtime secrets, real fixture URLs, browser profile data, observations, and reports remain outside Git.
- Starting `/opt/thoth/bin/start-legacy-cdp` normal mode is a live TikTok action and is outside this implementation session.
- Do not push, publish a new image, upload to S3, start the soak, run a rollback drill, record human approval, execute Task 10, or change the default mode to `python`.
- Use exact `bun --cwd=scout ...` syntax. If `rtk` is unavailable, run the underlying command and report that fallback explicitly.

## File Map

- Create `compose.stage1.local.yml`: declarative six-service topology and health dependencies.
- Create `.env.stage1.local.example`: safe, non-secret interpolation fixture and operator variable index.
- Create `python/tests/deployment/test_local_stage1_compose_contract.py`: repository-level deployment and documentation contracts.
- Create `docs/operations/stage1-local-docker.md`: operator bootstrap, verification, restart, evidence export, and rollback-preparation runbook.
- Modify `.gitignore`: exclude the real local env file and Stage 1 local evidence paths.
- Modify `.github/workflows/container-image.yml`: validate Compose rendering during the offline quality job.
- Modify `BLUEPRINT.md`: record that local orchestration is implemented but deployment, controlled live smoke, and soak remain pending.

---

### Task 1: Local Input and Secret Boundary

**Files:**
- Create: `.env.stage1.local.example`
- Create: `python/tests/deployment/test_local_stage1_compose_contract.py`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the spec's required variable names and existing repository ignore policy.
- Produces: `_repo_text(relative_path: str) -> str`, `_service_block(compose: str, service: str) -> str`, and a safe env fixture used by later tasks and CI.

- [ ] **Step 1: Write the failing ignore and env contract**

Create `python/tests/deployment/test_local_stage1_compose_contract.py` with:

```python
import re
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


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
    assert "THOTH_LIVE_TIKTOK_URL=replace-with-approved-public-fixture" in env_example
    assert "https://www.tiktok.com/" not in env_example
    assert "4630917242bd9e3483c8f89ae4017438cadc23a1f699f5e516c2dc610beb18b1" not in env_example
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py -q
```

Expected: FAIL because `.env.stage1.local.example` and the new ignore entries do not exist.

- [ ] **Step 3: Create the safe env example**

Create `.env.stage1.local.example` exactly as:

```dotenv
COMPOSE_PROJECT_NAME=thoth-stage1-local
THOTH_IMAGE=ghcr.io/muhfalihr/thoth@sha256:0000000000000000000000000000000000000000000000000000000000000000
THOTH_STAGE1_DATA_ROOT=/absolute/path/outside/repository/thoth-stage1
THOTH_CONTROL_PLANE_API_KEY=replace-with-local-secret
THOTH_POSTGRES_PASSWORD=replace-with-local-secret
THOTH_LIVE_TIKTOK_URL=replace-with-approved-public-fixture
```

- [ ] **Step 4: Extend `.gitignore` without broadening tracked-file exclusions**

Append:

```gitignore

# ── Stage 1 local Docker deployment ──────────────────────────────────────────
.env.stage1.local
stage1-local-observations*.jsonl
stage1-local-reports/
```

Do not ignore `.env.stage1.local.example`, `compose.stage1.local.yml`, or the operations runbook.

- [ ] **Step 5: Run the focused contract and verify GREEN**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py -q
rtk uv run --project python ruff check python/tests/deployment/test_local_stage1_compose_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_local_stage1_compose_contract.py
```

Expected: 1 test passes; Ruff commands exit 0.

- [ ] **Step 6: Commit Task 1**

```powershell
rtk git add .gitignore .env.stage1.local.example python/tests/deployment/test_local_stage1_compose_contract.py
rtk git commit -m "test: define local stage1 deployment boundary"
```

---

### Task 2: Persistent Temporal Infrastructure

**Files:**
- Create: `compose.stage1.local.yml`
- Modify: `python/tests/deployment/test_local_stage1_compose_contract.py`

**Interfaces:**
- Consumes: `THOTH_STAGE1_DATA_ROOT` and `THOTH_POSTGRES_PASSWORD` from Task 1.
- Produces: healthy `postgresql`, `temporal`, and `temporal-ui` services; namespace `thoth-stage1`; Compose network `stage1-private`.

- [ ] **Step 1: Add failing infrastructure contracts**

Append these tests:

```python
def test_local_stage1_infrastructure_is_pinned_persistent_and_private() -> None:
    compose = _repo_text("compose.stage1.local.yml")
    postgres = _service_block(compose, "postgresql")
    temporal = _service_block(compose, "temporal")
    temporal_ui = _service_block(compose, "temporal-ui")

    assert (
        "postgres:16.4-bookworm@sha256:"
        "e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412"
        in postgres
    )
    assert (
        "temporalio/auto-setup:1.29.1@sha256:"
        "5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312"
        in temporal
    )
    assert (
        "temporalio/ui:2.34.0@sha256:"
        "cb17ea423d76a8a19a269d0bcd81fc12eee1f6365acd2a56b590dafb35696a95"
        in temporal_ui
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
```

- [ ] **Step 2: Run the infrastructure contract and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py::test_local_stage1_infrastructure_is_pinned_persistent_and_private -q
```

Expected: FAIL because `compose.stage1.local.yml` does not exist.

- [ ] **Step 3: Create the infrastructure Compose services**

Create `compose.stage1.local.yml` beginning with:

```yaml
name: thoth-stage1-local

services:
  postgresql:
    image: postgres:16.4-bookworm@sha256:e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: ${THOTH_POSTGRES_PASSWORD:?set THOTH_POSTGRES_PASSWORD}
    volumes:
      - type: bind
        source: ${THOTH_STAGE1_DATA_ROOT:?set THOTH_STAGE1_DATA_ROOT}/postgres
        target: /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U temporal -d temporal"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 10s
    restart: unless-stopped
    networks: [stage1-private]

  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312
    depends_on:
      postgresql:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: "5432"
      POSTGRES_USER: temporal
      POSTGRES_PWD: ${THOTH_POSTGRES_PASSWORD:?set THOTH_POSTGRES_PASSWORD}
      POSTGRES_SEEDS: postgresql
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/development-sql.yaml
      DEFAULT_NAMESPACE: thoth-stage1
      DEFAULT_NAMESPACE_RETENTION: 30d
      TEMPORAL_ADDRESS: temporal:7233
      TEMPORAL_CLI_ADDRESS: temporal:7233
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 20s
    restart: unless-stopped
    networks: [stage1-private]

  temporal-ui:
    image: temporalio/ui:2.34.0@sha256:cb17ea423d76a8a19a269d0bcd81fc12eee1f6365acd2a56b590dafb35696a95
    depends_on:
      temporal:
        condition: service_healthy
    environment:
      TEMPORAL_ADDRESS: temporal:7233
      TEMPORAL_CORS_ORIGINS: http://127.0.0.1:8080
    ports:
      - "127.0.0.1:8080:8080"
    restart: unless-stopped
    networks: [stage1-private]

networks:
  stage1-private:
    driver: bridge
```

- [ ] **Step 4: Render Compose using only the safe fixture**

Run:

```powershell
rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
```

Expected: exit 0. Do not run `up`; Task 2 has no THOTH services and does not need infrastructure startup.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py -q
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit Task 2**

```powershell
rtk git add compose.stage1.local.yml python/tests/deployment/test_local_stage1_compose_contract.py
rtk git commit -m "feat: add persistent local temporal topology"
```

---

### Task 3: THOTH API, Worker, and Private CDP Roles

**Files:**
- Modify: `compose.stage1.local.yml`
- Modify: `python/tests/deployment/test_local_stage1_compose_contract.py`

**Interfaces:**
- Consumes: healthy `temporal`, network `stage1-private`, external data-root paths, and required `THOTH_IMAGE`.
- Produces: loopback API at `127.0.0.1:8000`, worker connected to `temporal:7233`, and internal-only `legacy-cdp:18800`.

- [ ] **Step 1: Add failing THOTH topology contracts**

Append:

```python
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
    assert "THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: python_tiktok_with_legacy_fallback" in worker
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
```

- [ ] **Step 2: Run the THOTH contract and verify RED**

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py -k "thoth_roles or digest_qualified" -q
```

Expected: FAIL because the three THOTH services do not exist.

- [ ] **Step 3: Add `legacy-cdp` before `networks`**

Use the existing THOTH Python interpreter for a two-endpoint health check; do not add a host port:

```yaml
  legacy-cdp:
    image: ${THOTH_IMAGE:?set digest-qualified THOTH_IMAGE}
    user: "10001:10001"
    command: ["/opt/thoth/bin/start-legacy-cdp"]
    volumes:
      - type: bind
        source: ${THOTH_STAGE1_DATA_ROOT:?set THOTH_STAGE1_DATA_ROOT}/browser-profile
        target: /var/lib/thoth/browser-profile
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          /opt/thoth/python/.venv/bin/python -c "import json, urllib.request;
          version = urllib.request.urlopen('http://127.0.0.1:18800/json/version', timeout=2);
          assert 200 <= version.status < 300;
          targets = json.load(urllib.request.urlopen('http://127.0.0.1:18800/json', timeout=2));
          assert any(target.get('type') == 'page' and 'tiktok.com' in target.get('url', '') for target in targets)"
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    restart: unless-stopped
    networks: [stage1-private]
```

- [ ] **Step 4: Add the API role**

```yaml
  api:
    image: ${THOTH_IMAGE:?set digest-qualified THOTH_IMAGE}
    user: "10001:10001"
    command:
      - /opt/thoth/python/.venv/bin/uvicorn
      - thoth_control_plane.api.app:create_app
      - --factory
      - --host
      - 0.0.0.0
      - --port
      - "8000"
    depends_on:
      temporal:
        condition: service_healthy
    environment:
      THOTH_CONTROL_PLANE_API_KEY: ${THOTH_CONTROL_PLANE_API_KEY:?set THOTH_CONTROL_PLANE_API_KEY}
      THOTH_TEMPORAL_TARGET: temporal:7233
      THOTH_TEMPORAL_NAMESPACE: thoth-stage1
      THOTH_CONTROL_PLANE_ARTIFACT_ROOT: /var/lib/thoth/artifacts
      THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: python_tiktok_with_legacy_fallback
    volumes:
      - type: bind
        source: ${THOTH_STAGE1_DATA_ROOT:?set THOTH_STAGE1_DATA_ROOT}/artifacts
        target: /var/lib/thoth/artifacts
    ports:
      - "127.0.0.1:8000:8000"
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          /opt/thoth/python/.venv/bin/python -c "import urllib.request;
          assert urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200;
          assert urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=2).status == 200"
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 15s
    restart: unless-stopped
    networks: [stage1-private]
```

- [ ] **Step 5: Add the worker role**

```yaml
  worker:
    image: ${THOTH_IMAGE:?set digest-qualified THOTH_IMAGE}
    user: "10001:10001"
    depends_on:
      temporal:
        condition: service_healthy
      legacy-cdp:
        condition: service_healthy
    environment:
      THOTH_CONTROL_PLANE_API_KEY: ${THOTH_CONTROL_PLANE_API_KEY:?set THOTH_CONTROL_PLANE_API_KEY}
      THOTH_TEMPORAL_TARGET: temporal:7233
      THOTH_TEMPORAL_NAMESPACE: thoth-stage1
      THOTH_CONTROL_PLANE_ARTIFACT_ROOT: /var/lib/thoth/artifacts
      THOTH_FFMPEG: /usr/bin/ffmpeg
      THOTH_FFPROBE: /usr/bin/ffprobe
      THOTH_CDP: http://legacy-cdp:18800
      THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE: python_tiktok_with_legacy_fallback
      THOTH_LIVE_TIKTOK_URL: ${THOTH_LIVE_TIKTOK_URL:?set approved fixture reference locally}
    volumes:
      - type: bind
        source: ${THOTH_STAGE1_DATA_ROOT:?set THOTH_STAGE1_DATA_ROOT}/artifacts
        target: /var/lib/thoth/artifacts
    restart: unless-stopped
    networks: [stage1-private]
```

- [ ] **Step 6: Render Compose and verify GREEN without starting services**

```powershell
rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py -q
```

Expected: Compose exits 0; 4 contract tests pass. Do not run `docker compose up`, because normal CDP startup contacts TikTok.

- [ ] **Step 7: Commit Task 3**

```powershell
rtk git add compose.stage1.local.yml python/tests/deployment/test_local_stage1_compose_contract.py
rtk git commit -m "feat: add local stage1 thoth roles"
```

---

### Task 4: CI Validation, Runbook, and Blueprint Status

**Files:**
- Modify: `.github/workflows/container-image.yml`
- Create: `docs/operations/stage1-local-docker.md`
- Modify: `BLUEPRINT.md`
- Modify: `python/tests/deployment/test_local_stage1_compose_contract.py`

**Interfaces:**
- Consumes: the complete Compose file and safe env example.
- Produces: offline CI syntax/interpolation gate and an operator-facing runbook with explicit hard stops.

- [ ] **Step 1: Add failing CI and documentation contracts**

Append:

```python
def test_local_stage1_compose_is_validated_by_offline_ci() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    command = (
        "docker compose --env-file .env.stage1.local.example "
        "-f compose.stage1.local.yml config --quiet"
    )
    assert "Validate local Stage 1 Compose" in workflow
    assert command in workflow


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
        "Do not run `docker compose up` for `legacy-cdp` or `worker` without explicit live approval.",
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
```

- [ ] **Step 2: Run the new contracts and verify RED**

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py -k "offline_ci or runbook or blueprint" -q
```

Expected: FAIL because the workflow step, runbook, and Blueprint entry are absent.

- [ ] **Step 3: Add the offline CI Compose gate**

In the `quality` job, after Ruff and before Scout dependency installation, add:

```yaml
      - name: Validate local Stage 1 Compose
        run: >-
          docker compose --env-file .env.stage1.local.example
          -f compose.stage1.local.yml config --quiet
```

This step renders only the safe example. It does not pull images, start containers, access TikTok,
or receive secrets.

- [ ] **Step 4: Write the operations runbook**

Create `docs/operations/stage1-local-docker.md` with these sections and commands:

```markdown
# Stage 1 Local Docker Operations

## Release identity

Record the final implementation commit and the OCI index digest from the successful GitHub Actions
summary. Set `THOTH_IMAGE` in the untracked `.env.stage1.local` to the digest-qualified reference.
Never deploy a branch, `latest`, or `sha-*` tag.

## Prepare persistent storage

Create `postgres`, `artifacts`, `browser-profile`, `observations`, and `reports` below the absolute
`THOTH_STAGE1_DATA_ROOT` outside this repository. Initialize `artifacts` and `browser-profile` as
UID/GID `10001:10001`; keep the browser profile out of evidence and support output.

## Render and pull

```powershell
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml config
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml pull
```

## Non-live infrastructure preflight

Start only PostgreSQL, Temporal, Temporal UI, and API. Do not run `docker compose up` for
`legacy-cdp` or `worker` without explicit live approval.

Verify `http://127.0.0.1:8000/healthz`, `http://127.0.0.1:8000/readyz`, and namespace state with:

```powershell
docker compose --env-file .env.stage1.local -f compose.stage1.local.yml exec temporal temporal operator namespace describe --namespace thoth-stage1 --address temporal:7233
```

## Controlled live gate

The approved mode is `python_tiktok_with_legacy_fallback`. Starting the CDP sidecar opens TikTok and
requires explicit operator approval plus the locally supplied fixture. Stop on authentication wall,
challenge, unexpected routing, redaction failure, or cleanup failure.

## Evidence export

Use host AWS authentication to sync observation JSONL and aggregate reports separately to:

- `s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/observations/`
- `s3://clipper-stage1-soak-evidence-20260903-a1d22394/stage1/reports/`

Never upload browser-profile data. Upload is a separate operator action and is not performed by
Compose.

## Restart and rollback preparation

Use `docker compose restart` with the same digest. The rollback mode is `legacy_scout` and may be
applied only during the approved rollback drill. Do not run `docker compose down -v` and do not
delete `THOTH_STAGE1_DATA_ROOT` during restart or rollback.
```

Expand each section with exact safe checks from the spec. Keep all real secret values, fixture URLs,
workflow IDs, and observation payloads out of the document.

- [ ] **Step 5: Update `BLUEPRINT.md` truthfully**

Add this bullet under the Python workflow control-plane status:

```markdown
- **Stage 1 local Docker orchestration (2026-09-03): implemented, activation pending.** The
  six-service local topology provides PostgreSQL-backed Temporal, loopback API/UI, persistent
  artifacts/profile storage, and a private same-digest CDP sidecar. Final digest deployment,
  controlled live smoke and operational soak remain pending.
```

Do not increase the existing Stage 1 percentage to 100%.

- [ ] **Step 6: Run focused documentation and workflow contracts**

```powershell
rtk uv run --project python pytest python/tests/deployment/test_local_stage1_compose_contract.py -q
rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
```

Expected: all local deployment contracts pass and Compose exits 0.

- [ ] **Step 7: Commit Task 4**

```powershell
rtk git add .github/workflows/container-image.yml docs/operations/stage1-local-docker.md BLUEPRINT.md python/tests/deployment/test_local_stage1_compose_contract.py
rtk git commit -m "docs: add local stage1 docker operations"
```

---

## Final Non-Live Verification

Run these commands after Task 4 and record exact exit codes:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py python/tests/deployment/test_local_stage1_compose_contract.py -q
rtk uv run --project python pytest python/tests -m "not live" -q
rtk uv run --project python ruff check python
rtk uv run --project python ruff format --check python
rtk bun --cwd=scout run test:acquisition
rtk docker compose --env-file .env.stage1.local.example -f compose.stage1.local.yml config --quiet
rtk git diff --check
rtk graphify update .
rtk git status --short --branch
```

If `rtk` or `graphify` is unavailable, run the underlying verification command where possible and
report the unavailable tool accurately. The final worktree must be clean after the planned commits.

Do not run normal-mode `legacy-cdp`, start `worker`, contact TikTok, upload to S3, push commits, or
start an operational soak as part of this plan. Those actions require the next operator checkpoint.

## Implementation Review Gate

After all tasks and final non-live verification:

1. Review the fixed-point diff from the plan baseline to final implementation commit against every
   acceptance criterion in the spec.
2. Run an independent standards review of Compose security, health semantics, digest pinning,
   persistence, secret boundaries, and the no-live hard stop.
3. Return **GO** only if both reviews have no blocking findings.
4. Record the final implementation commit, but do not call its image the soak candidate until a
   successful GitHub Actions run publishes and reports the digest built from that exact commit.
