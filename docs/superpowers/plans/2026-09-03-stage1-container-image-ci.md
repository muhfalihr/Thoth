# Stage 1 Container Image and GitHub CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Produce one Linux AMD64 compatibility image for the Python TikTok Stage 1 worker/API and
publish it safely to `ghcr.io/muhfalihr/thoth` after locked offline gates pass.

**Architecture:** A root multi-stage Dockerfile assembles the locked Python acquisition runtime,
Scrapling Chromium support, Bun, and the active Scout compatibility tree without changing runtime
routing. Static deployment-contract tests pin the security and release invariants. GitHub Actions
separates read-only pull-request image validation from push-only GHCR publication and records the
published digest for the operational change record.

**Tech Stack:** Docker BuildKit/Buildx, Python 3.12 Bookworm slim, uv 0.10.8, Scrapling 0.4.15,
Playwright Chromium, Bun 1.3.14, pytest, Ruff, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-09-03-stage1-container-image-ci-design.md`

## Global Constraints

- Registry name is exactly `ghcr.io/muhfalihr/thoth`.
- Target platform is exactly `linux/amd64`; do not add ARM64 in this plan.
- Preserve `python_tiktok_with_legacy_fallback` as the application default and soak mode.
- The final image must contain Python acquisition, installed Scrapling browser support, Bun, and
  `scout/cli.ts`; do not produce a Python-only image.
- Use only `python/uv.lock` and `scout/bun.lock` for runtime dependency resolution.
- Never add a real TikTok URL, API key, AWS credential, provider payload, workflow evidence, or
  secret-valued build argument.
- Pull requests build but never authenticate to GHCR or request `packages: write`.
- Branch pushes publish a full-Git-SHA tag and normalized branch tag; `master` additionally moves
  `latest`; `v*` Git tags additionally publish the version tag.
- The release identity used for deployment and soak evidence is the OCI digest, never a mutable tag.
- CI publishes only after all non-live Python and Scout acquisition gates pass.
- CI/CD in this plan stops at publishing the image. It does not deploy to AWS or start the soak.
- Do not push the branch from an agent session without separate user authorization.
- Local Docker is not installed on the current workstation. Static and repository gates can run
  locally, but the first real image build must be verified by GitHub Actions after an authorized
  push.

---

### Task 1: Lock down the Docker build context

**Files:**

- Create: `.dockerignore`
- Create: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: repository-root build context and the existing secret/evidence naming conventions.
- Produces: `_repo_text(relative_path: str) -> str` for later deployment-contract tests and a
  build-context denylist that the root Dockerfile relies on.

- [ ] **Step 1: Create the deployment test package and failing `.dockerignore` contract test**

Create `python/tests/deployment/test_container_contract.py` with:

```python
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def _repo_text(relative_path: str) -> str:
    return (REPOSITORY_ROOT / relative_path).read_text(encoding="utf-8")


def test_dockerignore_excludes_sensitive_and_generated_inputs() -> None:
    patterns = {
        line.strip()
        for line in _repo_text(".dockerignore").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    required_patterns = {
        ".git",
        ".worktrees",
        ".agents",
        ".claude",
        ".codex",
        ".superpowers",
        "**/.env*",
        "**/node_modules",
        "python/.venv",
        "**/__pycache__",
        "**/.pytest_cache",
        "**/.ruff_cache",
        "**/target",
        "output",
        "scout/output",
        ".thoth-artifacts",
        "*.db*",
        "*.log",
        "*.mp4",
        "*.wav",
        "*.jpg",
        "tiktok-stage1-soak-observations*.jsonl",
        "tiktok-stage1-soak-report.json*",
    }
    assert required_patterns <= patterns
    assert not any(pattern.startswith("!") for pattern in patterns)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from the repository root:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_dockerignore_excludes_sensitive_and_generated_inputs -q
```

Expected: FAIL with `FileNotFoundError` for `.dockerignore`.

- [ ] **Step 3: Add the deny-by-default build-context file**

Create `.dockerignore` with exactly:

```dockerignore
# Version control, worktrees, and agent/editor state
.git
.worktrees
.agents
.claude
.codex
.superpowers
.github
.vscode
.idea

# Secrets and local configuration
**/.env*
**/*_key
**/*_key.txt
**/*.novita_key
**/*.supabase_url
config.toml

# Dependency and language caches
**/node_modules
python/.venv
**/__pycache__
**/*.pyc
**/.pytest_cache
**/.ruff_cache
**/target

# Generated runtime state and media
output
scout/output
.thoth-artifacts
logs
downloads
models
*.db*
*.log
*.mp4
*.wav
*.jpg

# Stage 1 operational evidence must never enter a build context
tiktok-stage1-soak-observations*.jsonl
tiktok-stage1-soak-report.json*

# Product trees not used by this compatibility image
assets
crates
dashboard
docs
test
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_dockerignore_excludes_sensitive_and_generated_inputs -q
```

Expected: PASS.

- [ ] **Step 5: Check formatting and commit the build-context boundary**

Run:

```powershell
rtk uv run --project python ruff check python/tests/deployment/test_container_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_container_contract.py
rtk git diff --check
rtk git add .dockerignore python/tests/deployment/test_container_contract.py
rtk git commit -m "test: lock container build context"
```

Expected: all checks PASS and the commit contains only the two files named above.

---

### Task 2: Build the full Stage 1 compatibility runtime

**Files:**

- Create: `Dockerfile`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: `.dockerignore`, `python/pyproject.toml`, `python/uv.lock`, `python/src/`,
  `scout/package.json`, `scout/bun.lock`, and `scout/`.
- Produces: one non-root image whose default command starts
  `python -m thoth_control_plane.worker` and whose filesystem keeps the adapter's expected
  `/opt/thoth/scout/cli.ts` repository layout.

- [ ] **Step 1: Append failing Dockerfile contract tests**

Append to `python/tests/deployment/test_container_contract.py`:

```python
def test_dockerfile_uses_locked_full_compatibility_runtime() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert "FROM ghcr.io/astral-sh/uv:0.10.8 AS uv-tools" in dockerfile
    assert "FROM oven/bun:1.3.14 AS bun-tools" in dockerfile
    assert "FROM python:3.12-slim-bookworm AS runtime" in dockerfile
    assert "uv sync --frozen --no-dev --extra acquisition" in dockerfile
    assert "bun --cwd=/opt/thoth/scout install --frozen-lockfile --production" in dockerfile
    assert "/opt/thoth/python/.venv/bin/scrapling install" in dockerfile
    assert "COPY . " not in dockerfile


def test_dockerfile_preserves_legacy_adapter_layout_and_non_root_runtime() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert "COPY --chown=thoth:thoth scout/ /opt/thoth/scout/" in dockerfile
    assert "test -f /opt/thoth/scout/cli.ts" in dockerfile
    assert "THOTH_CONTROL_PLANE_ARTIFACT_ROOT=/var/lib/thoth/artifacts" in dockerfile
    assert "USER thoth" in dockerfile
    assert "RUN test -w /var/lib/thoth/artifacts" in dockerfile


def test_dockerfile_default_command_is_worker_and_has_no_secret_arguments() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert (
        'CMD ["/opt/thoth/python/.venv/bin/python", "-m", '
        '"thoth_control_plane.worker"]' in dockerfile
    )
    assert "THOTH_LIVE_TIKTOK_URL" not in dockerfile
    assert "THOTH_CONTROL_PLANE_API_KEY=" not in dockerfile
    assert "ARG THOTH_" not in dockerfile
```

- [ ] **Step 2: Run the Dockerfile tests and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

Expected: the `.dockerignore` test passes and the Dockerfile tests FAIL with `FileNotFoundError`.

- [ ] **Step 3: Add the multi-stage compatibility Dockerfile**

Create root `Dockerfile` with:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv:0.10.8 AS uv-tools
FROM oven/bun:1.3.14 AS bun-tools

FROM python:3.12-slim-bookworm AS runtime

COPY --from=uv-tools /uv /uvx /usr/local/bin/
COPY --from=bun-tools /usr/local/bin/bun /usr/local/bin/bun

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    THOTH_CONTROL_PLANE_ARTIFACT_ROOT=/var/lib/thoth/artifacts \
    PATH=/opt/thoth/python/.venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 thoth \
    && useradd --uid 10001 --gid 10001 --create-home \
        --home-dir /home/thoth --shell /usr/sbin/nologin thoth \
    && mkdir -p /opt/thoth/python /opt/thoth/scout /var/lib/thoth/artifacts /ms-playwright \
    && chown -R thoth:thoth /opt/thoth /var/lib/thoth /home/thoth /ms-playwright

WORKDIR /opt/thoth

COPY --chown=thoth:thoth python/pyproject.toml python/uv.lock /opt/thoth/python/
RUN cd /opt/thoth/python \
    && uv sync --frozen --no-dev --extra acquisition --no-install-project

COPY --chown=thoth:thoth python/src/ /opt/thoth/python/src/
RUN cd /opt/thoth/python \
    && uv sync --frozen --no-dev --extra acquisition

COPY --chown=thoth:thoth scout/package.json scout/bun.lock /opt/thoth/scout/
RUN bun --cwd=/opt/thoth/scout install --frozen-lockfile --production
COPY --chown=thoth:thoth scout/ /opt/thoth/scout/

RUN /opt/thoth/python/.venv/bin/scrapling install \
    && chown -R thoth:thoth /home/thoth /ms-playwright /opt/thoth/python/.venv

RUN /opt/thoth/python/.venv/bin/python -c \
        "import scrapling, thoth_control_plane" \
    && bun --version \
    && test -f /opt/thoth/scout/cli.ts

EXPOSE 8000

USER thoth

RUN test -w /var/lib/thoth/artifacts \
    && test -r /opt/thoth/scout/cli.ts \
    && test -x /opt/thoth/python/.venv/bin/python

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/thoth/python/.venv/bin/python", "-m", "thoth_control_plane.worker"]
```

Do not add a `HEALTHCHECK`: the default worker has no HTTP endpoint.

- [ ] **Step 4: Run the static container tests and verify GREEN**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

Expected: all deployment contract tests PASS.

- [ ] **Step 5: Verify the adapter resolves the copied repository layout**

Run:

```powershell
rtk uv run --project python python -c "from pathlib import Path; from thoth_control_plane.activities.legacy_scout import LegacyScoutActivity; a=LegacyScoutActivity(repository_root=Path('/opt/thoth')); assert a._repository_root == Path('/opt/thoth')"
```

Expected: exit code 0 and no output. This checks path semantics only; it does not invoke Scout or a
live provider.

- [ ] **Step 6: Check formatting and commit the runtime image**

Run:

```powershell
rtk uv run --project python ruff check python/tests/deployment/test_container_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_container_contract.py
rtk git diff --check
rtk git add Dockerfile python/tests/deployment/test_container_contract.py
rtk git commit -m "build: add stage1 compatibility image"
```

Expected: all checks PASS. Do not claim that the image itself built locally because Docker is not
installed on this workstation.

---

### Task 3: Add gated GHCR publication

**Files:**

- Create: `.github/workflows/container-image.yml`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: root `Dockerfile`, locked Python/Scout manifests, existing offline tests, and the
  GitHub-provided `GITHUB_TOKEN`.
- Produces: read-only pull-request build validation and push-only publication to
  `ghcr.io/muhfalihr/thoth`, including a safe digest summary.

- [ ] **Step 1: Append failing workflow contract tests**

Append to `python/tests/deployment/test_container_contract.py`:

```python
def test_container_workflow_separates_pr_validation_from_publication() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    validation = workflow.split("  validate-image:", 1)[1].split("  publish-image:", 1)[0]
    publication = workflow.split("  publish-image:", 1)[1]
    assert "if: github.event_name == 'pull_request'" in validation
    assert "push: false" in validation
    assert "packages: write" not in validation
    assert "if: github.event_name == 'push'" in publication
    assert "packages: write" in publication
    assert "push: true" in publication
    assert workflow.count("packages: write") == 1


def test_container_workflow_pins_gates_tags_platform_and_digest_summary() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    assert "REGISTRY_IMAGE: ghcr.io/muhfalihr/thoth" in workflow
    assert "uv run --project python pytest -m \"not live\" -q" in workflow
    assert "bun --cwd=scout run test:acquisition" in workflow
    assert "bun --cwd scout" not in workflow
    assert "platforms: linux/amd64" in workflow
    assert "type=raw,value=sha-${{ github.sha }}" in workflow
    assert "type=ref,event=branch" in workflow
    assert "type=ref,event=tag" in workflow
    assert "refs/heads/master" in workflow
    assert "provenance: mode=max" in workflow
    assert "sbom: true" in workflow
    assert "steps.build.outputs.digest" in workflow
    assert "secrets." not in workflow
```

- [ ] **Step 2: Run workflow tests and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

Expected: existing tests pass and workflow tests FAIL with `FileNotFoundError`.

- [ ] **Step 3: Create the GitHub Actions workflow**

Create `.github/workflows/container-image.yml` with:

```yaml
name: Container image

on:
  push:
    branches:
      - "**"
    tags:
      - "v*"
  pull_request:

permissions:
  contents: read

concurrency:
  group: container-image-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  REGISTRY_IMAGE: ghcr.io/muhfalihr/thoth

jobs:
  quality:
    name: Offline quality gates
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Set up uv
        uses: astral-sh/setup-uv@v6
        with:
          version: "0.10.8"
          enable-cache: true
          cache-dependency-glob: python/uv.lock

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"

      - name: Install locked Python dependencies
        run: uv sync --project python --frozen --all-groups --extra acquisition

      - name: Run Python non-live tests
        run: uv run --project python pytest -m "not live" -q

      - name: Run Ruff checks
        run: |
          uv run --project python ruff check python/src python/tests
          uv run --project python ruff format --check python/src python/tests

      - name: Install locked Scout dependencies
        run: bun --cwd=scout install --frozen-lockfile

      - name: Run Scout acquisition regressions
        run: bun --cwd=scout run test:acquisition

  validate-image:
    name: Validate image build
    if: github.event_name == 'pull_request'
    needs: quality
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build without publishing
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: false
          cache-from: type=gha,scope=thoth-container
          cache-to: type=gha,mode=max,scope=thoth-container

  publish-image:
    name: Publish image
    if: github.event_name == 'push'
    needs: quality
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ github.token }}

      - name: Generate image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY_IMAGE }}
          flavor: latest=false
          tags: |
            type=raw,value=sha-${{ github.sha }}
            type=ref,event=branch
            type=ref,event=tag
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/master' }}
          labels: |
            org.opencontainers.image.title=Thoth Stage 1 compatibility runtime
            org.opencontainers.image.description=Python TikTok acquisition with temporary Scout fallback
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}

      - name: Build and publish image
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=thoth-container
          cache-to: type=gha,mode=max,scope=thoth-container
          provenance: mode=max
          sbom: true

      - name: Record immutable release identity
        env:
          IMAGE_TAGS: ${{ steps.meta.outputs.tags }}
          IMAGE_DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          {
            echo "## Published container image"
            echo
            echo "- Repository: ${REGISTRY_IMAGE}"
            echo "- Git revision: ${GITHUB_SHA}"
            echo "- Platform: linux/amd64"
            echo "- Digest: ${IMAGE_DIGEST}"
            echo
            echo "### Tags"
            echo '```text'
            printf '%s\n' "${IMAGE_TAGS}"
            echo '```'
          } >> "${GITHUB_STEP_SUMMARY}"
```

Do not add a `workflow_dispatch` secret input, AWS credentials, live tests, or deployment job.

- [ ] **Step 4: Run workflow contract tests and verify GREEN**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

Expected: all deployment contract tests PASS.

- [ ] **Step 5: Inspect the YAML-sensitive strings and commit CI**

Run:

```powershell
rtk rg -n "pull_request:|packages: write|push: (true|false)|sha-\$\{\{ github.sha \}\}|steps.build.outputs.digest|bun --cwd" .github/workflows/container-image.yml
rtk git diff --check
rtk git add .github/workflows/container-image.yml python/tests/deployment/test_container_contract.py
rtk git commit -m "ci: publish stage1 image to ghcr"
```

Expected: one `packages: write` match under `publish-image`, exact `--cwd=scout` commands, separate
`push: false` and `push: true`, the full-SHA tag expression, and the digest summary expression.

---

### Task 4: Document digest-pinned operation

**Files:**

- Modify: `docs/python-control-plane.md`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: published-image contract from Task 3 and existing Stage 1 worker/soak runbook.
- Produces: an operator-facing image pull/run contract that never embeds a secret and distinguishes
  local filesystem artifacts from S3 evidence archival.

- [ ] **Step 1: Append a failing documentation contract test**

Append to `python/tests/deployment/test_container_contract.py`:

```python
def test_operations_documentation_requires_digest_pinning_and_runtime_injection() -> None:
    documentation = _repo_text("docs/python-control-plane.md")
    assert "### Stage 1 compatibility container" in documentation
    assert "ghcr.io/muhfalihr/thoth@" in documentation
    assert "Read-Host \"Paste the sha256 digest from the successful workflow summary\"" in documentation
    assert "/var/lib/thoth/artifacts" in documentation
    assert "thoth_control_plane.api.app:create_app" in documentation
    assert "Publishing the image does not deploy it to AWS" in documentation
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_operations_documentation_requires_digest_pinning_and_runtime_injection -q
```

Expected: FAIL because the Stage 1 compatibility-container section is absent.

- [ ] **Step 3: Add the container operations section**

Insert the following section in `docs/python-control-plane.md` immediately after the introductory
TikTok acquisition-worker installation paragraph and before the activity-mode table:

````markdown
### Stage 1 compatibility container

GitHub Actions builds the Linux AMD64 compatibility image at
`ghcr.io/muhfalihr/thoth`. A branch or version tag is only a discovery aid; deployment and the
Stage 1 change record must use the immutable digest printed in the successful **Container image**
workflow summary. In PowerShell, pull the selected build without putting runtime secrets in the
command:

```powershell
$ImageDigest = Read-Host "Paste the sha256 digest from the successful workflow summary"
$Image = "ghcr.io/muhfalihr/thoth@$ImageDigest"
docker pull $Image
docker image inspect $Image --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

The image defaults to `/opt/thoth/python/.venv/bin/python -m thoth_control_plane.worker`. Run the
FastAPI process from the exact same digest by overriding the command with
`/opt/thoth/python/.venv/bin/uvicorn thoth_control_plane.api.app:create_app --factory --host
0.0.0.0 --port 8000`.

Both services must receive `THOTH_CONTROL_PLANE_API_KEY`, `THOTH_TEMPORAL_TARGET`,
`THOTH_TEMPORAL_NAMESPACE`, `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`, and the deployment-owned activity
mode at runtime through the approved environment or secret manager. During the soak the activity
mode remains `python_tiktok_with_legacy_fallback`. Never bake these values or
`THOTH_LIVE_TIKTOK_URL` into an image, build argument, workflow, or command history.

Mount persistent storage at `/var/lib/thoth/artifacts` and set
`THOTH_CONTROL_PLANE_ARTIFACT_ROOT=/var/lib/thoth/artifacts` for both API and worker. This runtime
volume contains workflow artifacts; it is distinct from the approved external S3 prefixes used to
archive sensitive observation JSONL and the finished aggregate report.

Publishing the image does not deploy it to AWS, restart a worker, configure Temporal, start the
soak window, or approve the Python-only cutover. The soak begins only after the recorded digest is
deployed and a controlled canary passes.
````

- [ ] **Step 4: Run the documentation contract and safety searches**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
rtk rg -n -i "https://(www\.)?tiktok\.com|AKIA[0-9A-Z]{16}|aws_secret_access_key|password:" Dockerfile .dockerignore .github/workflows/container-image.yml docs/python-control-plane.md
```

Expected: tests PASS. The safety search returns no real TikTok URL, AWS access key, AWS secret
assignment, or registry password literal. The workflow's `${{ github.token }}` expression is not a
literal secret and is allowed.

- [ ] **Step 5: Format and commit the operations knowledge**

Run:

```powershell
rtk uv run --project python ruff check python/tests/deployment/test_container_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_container_contract.py
rtk git diff --check
rtk git add docs/python-control-plane.md python/tests/deployment/test_container_contract.py
rtk git commit -m "docs: add stage1 container operations"
```

Expected: all checks PASS and no operational value or evidence is committed.

---

### Task 5: Run the complete local release gates and prepare CI handoff

**Files:**

- Verify only; no repository file should change.

**Interfaces:**

- Consumes: Tasks 1-4 and the Stage 1 regression suites.
- Produces: a clean locally verified branch ready for an explicitly authorized push and the first
  GitHub-hosted image build.

- [ ] **Step 1: Run every deployment contract test**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

Expected: PASS.

- [ ] **Step 2: Run all non-live Python tests**

Run:

```powershell
rtk uv run --project python pytest -m "not live" -q
```

Expected: PASS with live tests deselected or skipped; no provider is contacted.

- [ ] **Step 3: Run Python lint and format gates**

Run:

```powershell
rtk uv run --project python ruff check python/src python/tests
rtk uv run --project python ruff format --check python/src python/tests
```

Expected: both commands PASS.

- [ ] **Step 4: Run the exact Scout acquisition regression gate**

Run:

```powershell
rtk bun --cwd=scout install --frozen-lockfile
rtk bun --cwd=scout run test:acquisition
```

Expected: PASS. Never replace `--cwd=scout` with the whitespace form.

- [ ] **Step 5: Record the local Docker limitation without manufacturing evidence**

Run:

```powershell
if (Get-Command docker -ErrorAction SilentlyContinue) {
    rtk docker build --platform linux/amd64 --tag thoth-stage1:local .
} else {
    Write-Output "docker unavailable: image build requires GitHub Actions"
}
```

Expected on the current workstation: exactly
`docker unavailable: image build requires GitHub Actions`. This is a known verification deferral,
not a passing image-build result.

- [ ] **Step 6: Verify release metadata, diff hygiene, and branch state**

Run:

```powershell
rtk git diff --check
rtk git status --short --branch
rtk git log --oneline --decorate -6
rtk rg -n "ghcr.io/muhfalihr/thoth|sha-\$\{\{ github.sha \}\}|steps.build.outputs.digest" .github/workflows/container-image.yml docs/python-control-plane.md
```

Expected: no diff errors, a clean `codex/stage1-container-ci` worktree, and references to the exact
registry, full-SHA tag, and digest output.

- [ ] **Step 7: Stop before external publication and report the handoff**

Report:

- all local gate results;
- the four implementation commit SHAs after the spec commit;
- that Docker was unavailable locally;
- that no branch was pushed and no GHCR image exists yet; and
- the exact next action requiring user authorization: push `codex/stage1-container-ci` to GitHub,
  observe the **Container image** workflow, and capture its reported OCI digest.

Do not update the operational checklist's artifact/image digest until the GitHub publishing job
actually succeeds. Do not start the soak from a locally inferred tag or commit.
