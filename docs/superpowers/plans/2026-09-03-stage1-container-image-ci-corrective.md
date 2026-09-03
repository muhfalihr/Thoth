# Stage 1 Container Image and GitHub CI Corrective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Correct the Stage 1 compatibility image so its Linux legacy Scout fallback is actually
operational, and harden its build context, GitHub Actions supply chain, and operator documentation
before any branch push or GHCR publication.

**Architecture:** The existing `ghcr.io/muhfalihr/thoth` image remains the only project image and
continues to default to the Python worker. It gains Linux FFmpeg/FFprobe and a small non-root
launcher so the exact same digest can run as a private headless Chromium CDP sidecar when legacy
fallback is enabled. Static repository contracts enforce the runtime topology and immutable Action
pins; the first real image build remains a GitHub Actions gate after separately authorized push.

**Tech Stack:** Docker BuildKit, Python 3.12 Bookworm slim, uv 0.10.8, Scrapling 0.4.15,
Patchright Chromium, Bun 1.3.14, Debian FFmpeg/FFprobe, POSIX shell, pytest, Ruff, GitHub Actions,
GHCR.

**Spec:** `docs/superpowers/specs/2026-09-03-stage1-container-image-ci-design.md`

## Global Constraints

- Work only on branch `codex/stage1-container-ci`; preserve the completed implementation commits
  through `442f51c5dd36b94542e6632f3cd8523f396c2af9` and both corrective-spec commits.
- Registry name remains exactly `ghcr.io/muhfalihr/thoth` and target platform remains exactly
  `linux/amd64`.
- Keep one project image. Worker, API, and legacy CDP sidecar use the exact same image digest with
  different commands; do not introduce another image repository.
- Preserve `python_tiktok_with_legacy_fallback` as the application default and soak mode.
- Headless Scrapling remains primary, TikWM/CDN remains fallback, and legacy Scout remains only the
  explicit compatibility fallback/rollback path.
- Install Debian Bookworm's `ffmpeg` package and set exactly
  `THOTH_FFMPEG=/usr/bin/ffmpeg` and `THOTH_FFPROBE=/usr/bin/ffprobe`.
- The CDP sidecar command is exactly `/opt/thoth/bin/start-legacy-cdp`, listens only on private
  container port `18800`, uses `/var/lib/thoth/browser-profile`, and starts one TikTok page target.
- Run Chromium as UID/GID `10001:10001` without `--no-sandbox`, `--privileged`, a public host port,
  or public ingress.
- Use `THOTH_CDP=http://legacy-cdp:18800` only while legacy fallback is enabled.
- Persistent artifact and browser-profile mounts must be owned by `10001:10001`, or use an
  equivalent `fsGroup: 10001` or init-ownership mechanism.
- Never add a real TikTok fixture URL, cookie, API key, AWS credential, provider payload, signed
  media URL, workflow evidence, or secret-valued build argument.
- Every third-party GitHub Action must use the full 40-character commit SHA specified in Task 3 and
  retain a human-readable major-version comment.
- Pull requests remain build-only; pushes remain publish-only after quality gates. Do not add AWS
  deployment, a Temporal deployment, live tests, or an automatic soak.
- Use `rtk` for shell commands when it is available. If it is absent from `PATH`, record that fact
  in the final report and run the exact underlying command directly rather than claiming a gate ran.
- Do not push the branch, deploy the image, start the soak, perform the rollback drill, record human
  cutover approval, start Task 10, or change the default mode to `python`.

---

### Task 1: Close the Docker build-context gaps

**Files:**

- Modify: `.dockerignore`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: the existing `patterns: set[str]` contract extracted from the root `.dockerignore`.
- Produces: exact denylist coverage for `data/cookies.txt`, private keys, PNG captures, and partial
  downloads without any negated re-inclusion.

- [ ] **Step 1: Extend the existing build-context test and make it fail**

Add these four exact strings to `required_patterns` inside
`test_dockerignore_excludes_sensitive_and_generated_inputs`:

```python
        "data/cookies.txt",
        "**/*.key",
        "**/*.png",
        "**/*.part",
```

Do not weaken the existing `assert not any(pattern.startswith("!") for pattern in patterns)`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_dockerignore_excludes_sensitive_and_generated_inputs -q
```

Expected: FAIL because all four newly required patterns are absent from `.dockerignore`.

- [ ] **Step 3: Add the exact denylist patterns**

Add these lines under `# Secrets and local configuration`:

```dockerignore
data/cookies.txt
**/*.key
```

Add these lines under `# Generated runtime state and media`:

```dockerignore
**/*.png
**/*.part
```

Keep the existing narrower media patterns. Do not add a negated `!` pattern for any directory.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_dockerignore_excludes_sensitive_and_generated_inputs -q
```

Expected: PASS.

- [ ] **Step 5: Check and commit the build-context correction**

Run:

```powershell
rtk uv run --project python ruff check python/tests/deployment/test_container_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_container_contract.py
rtk git diff --check
rtk git add .dockerignore python/tests/deployment/test_container_contract.py
rtk git commit -m "test: harden container build context"
```

Expected: all checks PASS and the commit contains only the two named files.

---

### Task 2: Make Linux legacy fallback container-operational

**Files:**

- Create: `docker/start-legacy-cdp`
- Modify: `Dockerfile`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: Patchright's `sync_playwright().chromium.executable_path`, the browser installed by
  `scrapling install`, and the existing non-root `thoth` runtime identity.
- Produces: `/usr/bin/ffmpeg`, `/usr/bin/ffprobe`, and executable
  `/opt/thoth/bin/start-legacy-cdp [--check]`. Normal launcher mode replaces the shell with one
  headless Chromium process on private port `18800`; `--check` resolves prerequisites without
  opening Chromium or contacting TikTok.

- [ ] **Step 1: Add failing Dockerfile and launcher contracts**

Append these tests to `python/tests/deployment/test_container_contract.py`:

```python
def test_dockerfile_provides_linux_legacy_media_and_cdp_runtime() -> None:
    dockerfile = _repo_text("Dockerfile")
    assert "ca-certificates ffmpeg tini" in dockerfile
    assert "THOTH_FFMPEG=/usr/bin/ffmpeg" in dockerfile
    assert "THOTH_FFPROBE=/usr/bin/ffprobe" in dockerfile
    assert "/var/lib/thoth/browser-profile" in dockerfile
    assert "COPY --chmod=0755 --chown=thoth:thoth docker/start-legacy-cdp" in dockerfile
    assert "/opt/thoth/bin/start-legacy-cdp --check" in dockerfile
    assert "/usr/bin/ffmpeg -version" in dockerfile
    assert "/usr/bin/ffprobe -version" in dockerfile
    assert "EXPOSE 8000 18800" in dockerfile


def test_legacy_cdp_launcher_is_fixed_headless_private_contract() -> None:
    launcher = _repo_text("docker/start-legacy-cdp")
    required = {
        "from patchright.sync_api import sync_playwright",
        "--headless=new",
        "--remote-debugging-address=0.0.0.0",
        "--remote-debugging-port=18800",
        "--user-data-dir=/var/lib/thoth/browser-profile",
        "https://www.tiktok.com/",
    }
    assert all(token in launcher for token in required)
    assert "--check" in launcher
    assert "--no-sandbox" not in launcher
    assert "THOTH_LIVE_TIKTOK_URL" not in launcher
```

The set expression deliberately accepts shell-continuation indentation while still requiring each
exact token to exist in the file.

- [ ] **Step 2: Run the focused contracts and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_dockerfile_provides_linux_legacy_media_and_cdp_runtime python/tests/deployment/test_container_contract.py::test_legacy_cdp_launcher_is_fixed_headless_private_contract -q
```

Expected: both tests FAIL; the Dockerfile lacks the runtime contract and the launcher file does not
exist.

- [ ] **Step 3: Create the non-root CDP launcher**

Create `docker/start-legacy-cdp` with exactly:

```sh
#!/bin/sh
set -eu

python_bin=/opt/thoth/python/.venv/bin/python
profile_dir=/var/lib/thoth/browser-profile

chromium_path="$($python_bin - <<'PY'
from patchright.sync_api import sync_playwright

with sync_playwright() as playwright:
    print(playwright.chromium.executable_path)
PY
)"

if [ ! -x "$chromium_path" ]; then
    echo "legacy CDP Chromium executable is unavailable" >&2
    exit 1
fi

if [ ! -d "$profile_dir" ] || [ ! -w "$profile_dir" ]; then
    echo "legacy CDP profile directory is unavailable" >&2
    exit 1
fi

if [ "${1:-}" = "--check" ]; then
    if [ "$#" -ne 1 ]; then
        echo "usage: start-legacy-cdp [--check]" >&2
        exit 64
    fi
    exit 0
fi

if [ "$#" -ne 0 ]; then
    echo "usage: start-legacy-cdp [--check]" >&2
    exit 64
fi

exec "$chromium_path" \
    --headless=new \
    --remote-debugging-address=0.0.0.0 \
    --remote-debugging-port=18800 \
    --user-data-dir=/var/lib/thoth/browser-profile \
    --no-first-run \
    --no-default-browser-check \
    --disable-dev-shm-usage \
    https://www.tiktok.com/
```

Do not add logging of the resolved executable, CDP targets, cookies, profile contents, or page URL
after launch.

- [ ] **Step 4: Add FFmpeg, fixed environment paths, profile ownership, and launcher validation**

Apply these exact Dockerfile changes:

1. Extend the existing `ENV` block with:

   ```dockerfile
       THOTH_FFMPEG=/usr/bin/ffmpeg \
       THOTH_FFPROBE=/usr/bin/ffprobe \
   ```

2. Change the APT package line to:

   ```dockerfile
       && apt-get install --yes --no-install-recommends ca-certificates ffmpeg tini \
   ```

3. Change the directory-creation line to:

   ```dockerfile
       && mkdir -p /opt/thoth/bin /opt/thoth/python /opt/thoth/scout \
           /var/lib/thoth/artifacts /var/lib/thoth/browser-profile /ms-playwright \
   ```

   Keep the following recursive `chown` over `/opt/thoth` and `/var/lib/thoth`, which covers both
   new directories with UID/GID `10001:10001`.

4. Immediately after `WORKDIR /opt/thoth`, add:

   ```dockerfile
   COPY --chmod=0755 --chown=thoth:thoth docker/start-legacy-cdp /opt/thoth/bin/start-legacy-cdp
   ```

5. Replace `EXPOSE 8000` with:

   ```dockerfile
   EXPOSE 8000 18800
   ```

6. Extend the existing non-root `RUN` after `USER thoth` to exactly:

   ```dockerfile
   RUN test -w /var/lib/thoth/artifacts \
       && test -w /var/lib/thoth/browser-profile \
       && test -r /opt/thoth/scout/cli.ts \
       && test -x /opt/thoth/python/.venv/bin/python \
       && test -x /usr/bin/ffmpeg \
       && test -x /usr/bin/ffprobe \
       && /usr/bin/ffmpeg -version >/dev/null 2>&1 \
       && /usr/bin/ffprobe -version >/dev/null 2>&1 \
       && /opt/thoth/bin/start-legacy-cdp --check
   ```

Do not change the worker `ENTRYPOINT` or default `CMD`.

- [ ] **Step 5: Run the deployment contracts and verify GREEN**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

Expected: all deployment contract tests PASS.

- [ ] **Step 6: Check formatting, inspect forbidden flags, and commit the runtime correction**

Run:

```powershell
rtk uv run --project python ruff check python/tests/deployment/test_container_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_container_contract.py
rtk rg -n -- "THOTH_FFMPEG|THOTH_FFPROBE|start-legacy-cdp|remote-debugging|no-sandbox" Dockerfile docker/start-legacy-cdp
rtk git diff --check
rtk git add Dockerfile docker/start-legacy-cdp python/tests/deployment/test_container_contract.py
rtk git commit -m "fix: make legacy fallback container operational"
```

Expected: the search shows the fixed binaries, launcher, and remote-debugging flags; it returns no
`--no-sandbox` occurrence. The commit contains only the three named files.

---

### Task 3: Pin every GitHub Action to an immutable commit

**Files:**

- Modify: `.github/workflows/container-image.yml`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: all third-party `uses:` references in the existing container workflow.
- Produces: the same workflow behavior with eight upstream Actions pinned to verified full commit
  SHAs and readable major-version comments.

- [ ] **Step 1: Add a failing immutable-action-reference contract**

Add `import re` before `from pathlib import Path`, then append:

```python
def test_container_workflow_pins_every_action_to_full_commit_sha() -> None:
    workflow = _repo_text(".github/workflows/container-image.yml")
    expected = {
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262": "# v4",
        "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065": "# v5",
        "astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e": "# v6",
        "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6": "# v2",
        "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f": "# v3",
        "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9": "# v3",
        "docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051": "# v5",
        "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8": "# v6",
    }
    action_lines = [line for line in workflow.splitlines() if "uses:" in line]
    references = {
        line.split("uses:", 1)[1].split("#", 1)[0].strip()
        for line in action_lines
        if not line.split("uses:", 1)[1].strip().startswith("./")
    }
    assert references == set(expected)
    assert all(re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", reference) for reference in references)
    for line in action_lines:
        reference = line.split("uses:", 1)[1].split("#", 1)[0].strip()
        if reference in expected:
            assert line.rstrip().endswith(expected[reference])
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_container_workflow_pins_every_action_to_full_commit_sha -q
```

Expected: FAIL because the workflow still uses mutable `@v2` through `@v6` references.

- [ ] **Step 3: Replace every mutable Action reference**

Use these exact YAML lines for every matching occurrence:

```yaml
uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5
uses: astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e # v6
uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3
uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3
uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051 # v5
uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6
```

There are three checkout occurrences, two Buildx occurrences, and two build-push occurrences; pin
every occurrence. Do not change permissions, events, tags, registry credentials, or publish logic.

- [ ] **Step 4: Run the workflow contracts and verify GREEN**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_container_workflow_pins_every_action_to_full_commit_sha python/tests/deployment/test_container_contract.py::test_container_workflow_separates_pr_validation_from_publication python/tests/deployment/test_container_contract.py::test_container_workflow_pins_gates_tags_platform_and_digest_summary -q
```

Expected: all three tests PASS.

- [ ] **Step 5: Prove no mutable Action reference remains and commit**

Run:

```powershell
rtk rg -n "uses:" .github/workflows/container-image.yml
rtk rg -n "uses: [^#[:space:]]+@v[0-9]" .github/workflows/container-image.yml
rtk uv run --project python ruff check python/tests/deployment/test_container_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_container_contract.py
rtk git diff --check
rtk git add .github/workflows/container-image.yml python/tests/deployment/test_container_contract.py
rtk git commit -m "ci: pin container workflow actions"
```

Expected: the first search lists only full-SHA references with version comments; the second search
returns no matches; all checks PASS.

---

### Task 4: Document the same-digest sidecar and repository status

**Files:**

- Modify: `docs/python-control-plane.md`
- Modify: `BLUEPRINT.md`
- Modify: `python/tests/deployment/test_container_contract.py`

**Interfaces:**

- Consumes: the fixed runtime paths and sidecar topology from Task 2.
- Produces: operator knowledge for private CDP readiness, volume ownership, and current
  pre-publication status without embedding runtime secrets or the live fixture URL.

- [ ] **Step 1: Add failing documentation and blueprint contracts**

Append:

```python
def test_operations_docs_define_private_same_digest_cdp_sidecar() -> None:
    documentation = _repo_text("docs/python-control-plane.md")
    required = {
        "/opt/thoth/bin/start-legacy-cdp",
        "THOTH_CDP=http://legacy-cdp:18800",
        "THOTH_FFMPEG=/usr/bin/ffmpeg",
        "THOTH_FFPROBE=/usr/bin/ffprobe",
        "/var/lib/thoth/browser-profile",
        "10001:10001",
        "GET http://legacy-cdp:18800/json/version",
        "GET http://legacy-cdp:18800/json",
        "must not have public ingress or a host-port mapping",
    }
    assert all(token in documentation for token in required)


def test_blueprint_records_corrected_container_checkpoint() -> None:
    blueprint = _repo_text("BLUEPRINT.md")
    assert "Stage 1 container checkpoint (2026-09-03)" in blueprint
    assert "worker/API/CDP sidecar" in blueprint
    assert "GHCR publication and the operational soak remain pending" in blueprint
```

- [ ] **Step 2: Run the focused documentation tests and verify RED**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py::test_operations_docs_define_private_same_digest_cdp_sidecar python/tests/deployment/test_container_contract.py::test_blueprint_records_corrected_container_checkpoint -q
```

Expected: both tests FAIL because the corrective operational knowledge is absent.

- [ ] **Step 3: Extend the Stage 1 compatibility-container runbook**

In `docs/python-control-plane.md`, after the paragraph describing the worker and API commands, add:

```markdown
While legacy fallback remains enabled, run a third container from the exact same digest with the
command `/opt/thoth/bin/start-legacy-cdp`. Give the sidecar the private service name `legacy-cdp`,
set `THOTH_CDP=http://legacy-cdp:18800` on the worker, and set
`THOTH_FFMPEG=/usr/bin/ffmpeg` plus `THOTH_FFPROBE=/usr/bin/ffprobe` on the worker. Port `18800` is
an unauthenticated browser-control boundary: it must not have public ingress or a host-port mapping,
and network policy must allow only the worker to reach it.

The sidecar mounts its sensitive persistent profile at `/var/lib/thoth/browser-profile`; never
archive that profile as soak evidence. Provision both that mount and `/var/lib/thoth/artifacts` as
UID/GID `10001:10001`, or use an equivalent `fsGroup: 10001` or init-container ownership step.
Do not run either process as root and do not make the mounts world-writable.

Before allowing a legacy-fallback activity, require
`GET http://legacy-cdp:18800/json/version` to return 2xx and
`GET http://legacy-cdp:18800/json` to contain a page target on `tiktok.com`. Restart an unhealthy
sidecar. Treat an authentication or challenge page during the controlled fallback smoke as a
release blocker; do not attempt bypass behavior.
```

Do not add a Compose/Kubernetes deployment manifest in this task; AWS and Temporal deployment
remain outside the container-publication scope.

- [ ] **Step 4: Update the top-level Python control-plane blueprint status**

Under `### Python workflow control plane (2026-08-28)` in `BLUEPRINT.md`, add this bullet after the
existing ownership-split bullet:

```markdown
- **Stage 1 container checkpoint (2026-09-03): locally corrected, publication pending.** One
  immutable `ghcr.io/muhfalihr/thoth` digest serves the worker/API/CDP sidecar roles; the image
  includes Linux FFmpeg/FFprobe and the private headless CDP launcher required by temporary Scout
  fallback. GHCR publication and the operational soak remain pending; publishing an image is not a
  deployment or cutover approval.
```

Also append this exact current-status history entry as the new final line of `BLUEPRINT.md`:

```markdown
*Update: 2026-09-03 — Stage 1 container runtime corrective checkpoint implemented locally. The
single `ghcr.io/muhfalihr/thoth` image now carries Linux FFmpeg/FFprobe and a non-root private
headless CDP launcher, while the worker/API/CDP sidecar roles remain pinned to one digest. GitHub
Actions are commit-SHA pinned and build-context exclusions are hardened. GHCR publication and the
operational soak remain pending; no deployment, live fallback smoke, cutover approval, or default
mode change occurred.*
```

Do not change any unrelated feature percentage or mark Stage 1 soak/cutover complete. The appended
entry is the required latest-date line for this repository's living blueprint.

- [ ] **Step 5: Run contracts and secret-safety searches**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
rtk rg -n -i "AKIA[0-9A-Z]{16}|aws_secret_access_key" Dockerfile .dockerignore docker/start-legacy-cdp .github/workflows/container-image.yml docs/python-control-plane.md BLUEPRINT.md
$NewDocumentation = rtk git diff --unified=0 -- docs/python-control-plane.md BLUEPRINT.md python/tests/deployment/test_container_contract.py
$ForbiddenNewLines = $NewDocumentation | rtk rg '^\+[^+]' | rtk rg -n -i "password:|tiktok\.com/@[^/]+/(video|photo)/"
if ($LASTEXITCODE -eq 0) {
    $ForbiddenNewLines
    throw "new documentation contains a forbidden secret field or live TikTok fixture"
}
```

Expected: deployment contracts PASS. The repository-wide credential search returns no match and
the added documentation/test lines contain no password field or real TikTok post fixture. The diff
scope is intentional because `BLUEPRINT.md` contains historical live-evidence text that predates
this correction and is outside its scope. The public TikTok home URL in the CDP launcher does not
match the forbidden post-fixture expression.

- [ ] **Step 6: Format and commit the operational knowledge**

Run:

```powershell
rtk uv run --project python ruff check python/tests/deployment/test_container_contract.py
rtk uv run --project python ruff format --check python/tests/deployment/test_container_contract.py
rtk git diff --check
rtk git add docs/python-control-plane.md BLUEPRINT.md python/tests/deployment/test_container_contract.py
rtk git commit -m "docs: document stage1 cdp sidecar operations"
```

Expected: all checks PASS and no operational value, secret, live fixture, or evidence file is
committed.

---

### Task 5: Run the complete corrective release gates and stop before publication

**Files:**

- Verify only. Do not intentionally modify repository files.

**Interfaces:**

- Consumes: Tasks 1-4 and all repository-required offline gates.
- Produces: a clean, evidence-backed corrective checkpoint ready for independent review and a
  separately authorized GitHub push. It does not produce a GHCR digest or soak candidate locally.

- [ ] **Step 1: Run every deployment contract**

Run:

```powershell
rtk uv run --project python pytest python/tests/deployment/test_container_contract.py -q
```

Expected: PASS.

- [ ] **Step 2: Run the complete non-live Python suite**

Run:

```powershell
rtk uv run --project python pytest -m "not live" -q
```

Expected: PASS with live tests deselected or skipped and no real provider contacted.

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

- [ ] **Step 5: Run the repository-required CUDA build without committing its log**

Run from PowerShell:

```powershell
$BuildLog = Join-Path $env:TEMP "thoth-stage1-container-corrective-build.log"
rtk cmd /c ".\build_cuda.bat > `"$BuildLog`" 2>&1"
$BuildExit = $LASTEXITCODE
if ($BuildExit -ne 0) {
    Get-Content -Tail 200 -LiteralPath $BuildLog
    exit $BuildExit
}
Write-Output "build_cuda.bat passed"
```

Expected: output ends with `build_cuda.bat passed`; the repository contains no build log. If `rtk`
cannot proxy `cmd`, record that limitation and run the same `cmd /c` invocation directly.

- [ ] **Step 6: Refresh the repository knowledge graph**

If `graphify-out/graph.json` exists, run:

```powershell
rtk graphify update .
rtk git status --short
```

Expected: graph refresh succeeds. If tracked graph files change, inspect them, stage only generated
`graphify-out/` changes, and commit them with:

```powershell
rtk git add graphify-out
rtk git commit -m "docs: refresh repository knowledge graph"
```

If the graph command is unavailable, record the exact missing-tool result in the final report; do
not claim the graph is current.

- [ ] **Step 7: Run a local image build only when Docker is available**

Run:

```powershell
if (Get-Command docker -ErrorAction SilentlyContinue) {
    rtk docker build --platform linux/amd64 --tag thoth-stage1:corrective .
    rtk docker run --rm --entrypoint /opt/thoth/bin/start-legacy-cdp thoth-stage1:corrective --check
    rtk docker run --rm --entrypoint /usr/bin/ffmpeg thoth-stage1:corrective -version
    rtk docker run --rm --entrypoint /usr/bin/ffprobe thoth-stage1:corrective -version
} else {
    Write-Output "docker unavailable: image build and runtime checks require GitHub Actions"
}
```

Expected on the current workstation: the explicit Docker-unavailable message. If Docker exists,
all four commands PASS. Do not start the launcher's normal mode here because it opens TikTok and
belongs to the separately approved controlled fallback smoke.

- [ ] **Step 8: Verify final diff hygiene and branch state**

Run:

```powershell
rtk git diff --check
rtk git status --short --branch
rtk git log --oneline --decorate -12
rtk rg -n -- "THOTH_FFMPEG|THOTH_FFPROBE|start-legacy-cdp|THOTH_CDP=http://legacy-cdp:18800|uses:" Dockerfile docker/start-legacy-cdp .github/workflows/container-image.yml docs/python-control-plane.md BLUEPRINT.md
```

Expected: no diff errors, a clean `codex/stage1-container-ci` worktree, four corrective
implementation commits after the approved spec/plan commits (plus a graph refresh commit only if
generated files changed), fixed runtime references, and only full-SHA Action pins.

- [ ] **Step 9: Stop and report the corrective checkpoint**

Report all of the following without exposing secrets or live evidence:

- the new full `HEAD` commit SHA and the four corrective implementation commit SHAs;
- deployment-test, full non-live Python, Ruff, Scout, CUDA build, and graph-refresh results;
- Docker build/runtime-check results or the exact Docker-unavailable deferral;
- that normal CDP mode, a live TikTok fixture, AWS, Temporal deployment, and soak evidence were not
  touched;
- that the branch was not pushed and no GHCR digest was created; and
- that an independent review must return GO before requesting separate authorization to push.

Do not call `git push`, create a release, update the operational checklist with an inferred digest,
or describe the new commit as `evaluated_commit`. Only a successful GitHub Actions publication can
produce the immutable digest, and the soak window starts only after that exact digest is deployed
and passes the controlled canary.
