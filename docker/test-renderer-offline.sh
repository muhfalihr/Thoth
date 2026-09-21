#!/usr/bin/env bash
# Prove the isolated render stack on two candidate images, without touching
# anything real: no project revision, no provider, no network egress, no
# operator stack. Everything this harness needs it generates, and everything it
# generates it removes again.
#
#     bash docker/test-renderer-offline.sh IMAGE RENDERER_IMAGE
set -euo pipefail
# Generated credentials never reach another account on the runner.
umask 077

if [ "$#" -ne 2 ]; then
    echo "usage: docker/test-renderer-offline.sh IMAGE RENDERER_IMAGE" >&2
    exit 64
fi

image="$1"
renderer_image="$2"

#: Only projects with this prefix are ever torn down by this harness.
project_prefix=stage1-renderer-smoke
test_project="${project_prefix}-$$-$(date +%s)"
work_root=$(mktemp -d)

#: The happy-path document: two seconds of one synthetic clip.
main_frames=60
main_seconds=2.0
#: The long document used to catch a render mid-flight, and to outlast the
#: deadline below. Two minutes of text rendered in about the deadline itself,
#: which made the deadline phase a race; ten minutes leaves the margin.
long_frames=18000
#: Bounded deadlines. Nothing here ever waits forever.
start_timeout=300
render_timeout=900
active_timeout=600
cancel_timeout=300
deadline_seconds=60
deadline_timeout=420

# A recursive delete needs to be certain of its target before it runs, so the
# only directory this harness will ever remove is one mktemp just handed it.
validate_root() {
    case "$work_root" in
        /*) ;;
        *) return 1 ;;
    esac
    [ -d "$work_root" ] || return 1
    case "${work_root##*/}" in
        tmp.??????????*) ;;
        *) return 1 ;;
    esac
}

validate_root || {
    echo "refusing to run without a validated temporary root" >&2
    exit 1
}
# The container user owns everything it writes below the artifact root, so that
# one directory is group- and world-traversable while its parent stays private.
chmod 711 "$work_root"
mkdir -p "$work_root/artifacts"
chmod 777 "$work_root/artifacts"

compose() {
    docker compose \
        --project-name "$test_project" \
        --env-file "$work_root/harness.env" \
        --file "$work_root/stack.yml" \
        "$@"
}

teardown() {
    # Refuse to tear down a project this harness did not create.
    case "$test_project" in
        "${project_prefix}"-*) ;;
        *)
            echo "refusing to tear down a project this harness does not own" >&2
            return 1
            ;;
    esac
    if [ -f "$work_root/stack.yml" ]; then
        # The renderer writes as its own UID, so its own image removes its work.
        compose run --rm --no-deps --user 0:0 --entrypoint /bin/sh -T api \
            -c 'find /var/lib/thoth/artifacts -mindepth 1 -delete' >/dev/null 2>&1 || true
        compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
    fi
    if validate_root; then
        rm -rf -- "$work_root"
    fi
}
trap teardown EXIT INT TERM

fail() {
    echo "$1=false"
    echo "--- services ---" >&2
    compose ps --all --format '{{.Service}} {{.Status}}' >&2 || true
    # Renderer diagnostics are fixed codes, so they carry no caller payload.
    echo "--- renderer (tail) ---" >&2
    compose logs --no-color --no-log-prefix --tail 40 remotion-renderer >&2 || true
    exit 1
}

# --- a stack made entirely of throwaway inputs -------------------------------
db_password=$(openssl rand -hex 24)
api_key=$(openssl rand -hex 24)
preview_key=$(openssl rand -hex 24)
renderer_credential=$(openssl rand -hex 24)
project_id="proj_$(openssl rand -hex 8)"
document_id="doc_$(openssl rand -hex 8)"
long_document_id="doc_$(openssl rand -hex 8)"
asset_id="asset_$(openssl rand -hex 8)"

{
    echo "SMOKE_IMAGE=${image}"
    echo "SMOKE_RENDERER_IMAGE=${renderer_image}"
    echo "SMOKE_DB_PASSWORD=${db_password}"
    echo "SMOKE_API_KEY=${api_key}"
    echo "SMOKE_PREVIEW_KEY=${preview_key}"
    echo "SMOKE_RENDERER_CREDENTIAL=${renderer_credential}"
    echo "SMOKE_RENDER_MAX_SECONDS=${render_timeout}"
} > "$work_root/harness.env"

# A private network with no gateway: a render that tried to reach the internet
# would fail here, which is exactly the property under test.
cat > "$work_root/stack.yml" <<'STACK'
services:
  editor-postgresql:
    image: postgres:16.4-bookworm@sha256:e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412
    environment:
      POSTGRES_DB: thoth_editor
      POSTGRES_USER: thoth_editor
      POSTGRES_PASSWORD: ${SMOKE_DB_PASSWORD:?}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U thoth_editor -d thoth_editor"]
      interval: 3s
      timeout: 5s
      retries: 40
      start_period: 10s

  # The control plane refuses to start without a workflow backend, so the
  # harness supplies a throwaway one. Nothing under test ever reaches it.
  temporal-postgresql:
    image: postgres:16.4-bookworm@sha256:e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412
    environment:
      POSTGRES_USER: temporal
      POSTGRES_PASSWORD: ${SMOKE_DB_PASSWORD:?}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U temporal -d temporal"]
      interval: 3s
      timeout: 5s
      retries: 40
      start_period: 10s

  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312
    depends_on:
      temporal-postgresql:
        condition: service_healthy
    environment:
      DB: postgres12
      DB_PORT: "5432"
      POSTGRES_USER: temporal
      POSTGRES_PWD: ${SMOKE_DB_PASSWORD:?}
      POSTGRES_SEEDS: temporal-postgresql
      DYNAMIC_CONFIG_FILE_PATH: config/dynamicconfig/docker.yaml
      DEFAULT_NAMESPACE: thoth-stage1
      DEFAULT_NAMESPACE_RETENTION: 1d
      TEMPORAL_ADDRESS: temporal:7233
      TEMPORAL_CLI_ADDRESS: temporal:7233
    healthcheck:
      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233"]
      interval: 5s
      timeout: 5s
      retries: 60
      start_period: 20s

  api:
    image: ${SMOKE_IMAGE:?}
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
      editor-postgresql:
        condition: service_healthy
      temporal:
        condition: service_healthy
    environment:
      THOTH_CONTROL_PLANE_API_KEY: ${SMOKE_API_KEY:?}
      THOTH_EDITOR_PREVIEW_SIGNING_KEY: ${SMOKE_PREVIEW_KEY:?}
      THOTH_TEMPORAL_TARGET: temporal:7233
      THOTH_TEMPORAL_NAMESPACE: thoth-stage1
      THOTH_EDITOR_DATABASE_URL: "postgresql://thoth_editor:${SMOKE_DB_PASSWORD:?}@editor-postgresql:5432/thoth_editor"
      THOTH_CONTROL_PLANE_ARTIFACT_ROOT: /var/lib/thoth/artifacts
      THOTH_RENDERER_INTERNAL_URL: http://remotion-renderer:8080
      THOTH_RENDERER_INTERNAL_CREDENTIAL: ${SMOKE_RENDERER_CREDENTIAL:?}
      THOTH_RENDER_MAX_SECONDS: "900"
    volumes:
      - type: bind
        source: ${SMOKE_ARTIFACT_ROOT:?}
        target: /var/lib/thoth/artifacts
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          /opt/thoth/python/.venv/bin/python -c "import urllib.request;
          assert urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200"
      interval: 5s
      timeout: 5s
      retries: 40
      start_period: 10s

  remotion-renderer:
    image: ${SMOKE_RENDERER_IMAGE:?}
    user: "10001:10001"
    environment:
      THOTH_RENDERER_CONTROL_PLANE_URL: http://api:8000
      THOTH_RENDERER_INTERNAL_CREDENTIAL: ${SMOKE_RENDERER_CREDENTIAL:?}
      THOTH_CONTROL_PLANE_ARTIFACT_ROOT: /var/lib/thoth/artifacts
      THOTH_RENDERER_PORT: "8080"
      THOTH_RENDER_MAX_SECONDS: ${SMOKE_RENDER_MAX_SECONDS:?}
    volumes:
      - type: bind
        source: ${SMOKE_ARTIFACT_ROOT:?}
        target: /var/lib/thoth/artifacts
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          bun --eval "const response = await fetch('http://127.0.0.1:8080/health',
          { headers: { Authorization: 'Bearer ' + process.env.THOTH_RENDERER_INTERNAL_CREDENTIAL } });
          if (response.status !== 200) { process.exit(1); }"
      interval: 5s
      timeout: 5s
      retries: 40
      start_period: 10s

networks:
  default:
    internal: true
STACK

echo "SMOKE_ARTIFACT_ROOT=${work_root}/artifacts" >> "$work_root/harness.env"

# The whole control-plane conversation happens inside the API container, so no
# credential and no payload ever crosses the host boundary.
cat > "$work_root/driver.py" <<'PYTHON_DRIVER'
"""Synthetic control-plane driver for the offline render-stack smoke.

Every value here is generated by the harness. Nothing is read from an operator
environment, a real project, or a real asset. Output is one bounded token per
command so a log can never carry a payload.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from thoth_control_plane.domain.edit_document_v2 import EditDocumentV2

BASE = "http://127.0.0.1:8000/api/v1"
ROOT = Path("/var/lib/thoth/artifacts")
API_KEY = os.environ["THOTH_CONTROL_PLANE_API_KEY"]
DATABASE_URL = os.environ["THOTH_EDITOR_DATABASE_URL"]
PROJECT_ID = os.environ["SMOKE_PROJECT_ID"]
ASSET_ID = os.environ["SMOKE_ASSET_ID"]
#: Statuses the render contract knows about. Anything else is a waiting row.
KNOWN_STATUSES = {"preparing", "rendering", "finalizing", "completed", "failed", "cancelled"}


def call(method, path, body=None, idempotency_key=None):
    request = urllib.request.Request(BASE + path, method=method)
    request.add_header("Authorization", "Bearer " + API_KEY)
    payload = None
    if idempotency_key is not None:
        request.add_header("Idempotency-Key", idempotency_key)
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, payload, timeout=30) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def document(document_id, frames, asset_frames=None):
    """One minimal valid saved revision: either one clip of media, or one card."""
    scene = {
        "scene_id": "sc_only",
        "role": "source",
        "start_frame": 0,
        "duration_in_frames": frames,
        "clip_ids": ["cl_only"],
    }
    if asset_frames is None:
        track = {"track_id": "tr_only", "kind": "overlay", "label": "Card", "order": 0}
        clip = {
            "kind": "text",
            "heading": "synthetic smoke",
            "body": "generated by the offline render-stack harness",
            "style_slot": "body_default",
        }
        assets = []
    else:
        track = {"track_id": "tr_only", "kind": "main_video", "label": "Main", "order": 0}
        clip = {"kind": "video", "asset_id": ASSET_ID, "source_from_frame": 0}
        assets = [
            {
                "asset_id": ASSET_ID,
                "project_id": PROJECT_ID,
                "kind": "video",
                "duration_in_frames": asset_frames,
                "width": 1080,
                "height": 1920,
                "fps": 30.0,
                "has_audio": True,
                "validation_state": "ready",
                "checksum": checksum_of(ROOT / "media" / f"{ASSET_ID}.mp4"),
            }
        ]
    track["clip_ids"] = ["cl_only"]
    clip |= {
        "clip_id": "cl_only",
        "track_id": "tr_only",
        "scene_id": "sc_only",
        "from_frame": 0,
        "duration_in_frames": frames,
        "ownership": "ai_managed",
    }
    return EditDocumentV2.model_validate(
        {
            "schema_version": 2,
            "document_id": document_id,
            "project_id": PROJECT_ID,
            "revision": 1,
            "template": {"template_id": "vertical_text_story", "version": 1},
            "canvas": {"width": 1080, "height": 1920, "fps": 30, "duration_in_frames": frames},
            "scenes": [scene],
            "tracks": [track],
            "clips": [clip],
            "asset_refs": assets,
        }
    )


def checksum_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def seed(document_id, frames, asset_frames):
    saved = document(document_id, frames, asset_frames)
    with psycopg.connect(DATABASE_URL) as connection:
        cursor = connection.cursor()
        if asset_frames is not None:
            source = ROOT / "media" / f"{ASSET_ID}.mp4"
            cursor.execute(
                """
                INSERT INTO editor_assets
                    (project_id, asset_id, kind, media_type, artifact_location,
                     duration_in_frames, width, height, fps, has_audio,
                     validation_state, checksum, provenance)
                VALUES (%s, %s, 'video', 'video/mp4', %s, %s, 1080, 1920, 30.0, true,
                        'ready', %s, 'offline render smoke')
                ON CONFLICT DO NOTHING
                """,
                (
                    PROJECT_ID,
                    ASSET_ID,
                    f"media/{ASSET_ID}.mp4",
                    asset_frames,
                    checksum_of(source),
                ),
            )
        cursor.execute(
            """
            INSERT INTO edit_document_revisions
                (project_id, document_id, revision, document_json)
            VALUES (%s, %s, 1, %s)
            """,
            (PROJECT_ID, document_id, Jsonb(saved.model_dump(mode="json"))),
        )
    print("ok")


def create(document_id):
    status, body = call(
        "POST",
        f"/projects/{PROJECT_ID}/render-jobs",
        {"document_id": document_id, "document_revision": 1},
        idempotency_key=hashlib.sha256(os.urandom(16)).hexdigest(),
    )
    if status != 201:
        raise SystemExit(f"create returned {status} {body.get('detail', {})}")
    print(body["render_job_id"])


def busy(document_id):
    status, body = call(
        "POST",
        f"/projects/{PROJECT_ID}/render-jobs",
        {"document_id": document_id, "document_revision": 1},
        idempotency_key=hashlib.sha256(os.urandom(16)).hexdigest(),
    )
    detail = body.get("detail", {})
    code = detail.get("code") if isinstance(detail, dict) else None
    if status != 409 or code != "render_busy":
        raise SystemExit(f"second create returned {status} {code}")
    print("ok")


def read(render_job_id):
    status, body = call("GET", f"/projects/{PROJECT_ID}/render-jobs/{render_job_id}")
    if status != 200:
        raise SystemExit(f"read returned {status}")
    return body


def await_status(render_job_id, timeout, targets):
    limit = time.monotonic() + float(timeout)
    last = ""
    while time.monotonic() < limit:
        last = read(render_job_id)["status"]
        if last in targets:
            print(last)
            return
        time.sleep(2.0)
    raise SystemExit(f"timed out waiting for {'/'.join(targets)}, last was {last}")


def cancel(render_job_id):
    status, _ = call("POST", f"/projects/{PROJECT_ID}/render-jobs/{render_job_id}/cancel")
    if status != 200:
        raise SystemExit(f"cancel returned {status}")
    print("ok")


def history(expected):
    status, body = call("GET", f"/projects/{PROJECT_ID}/render-jobs?limit=50")
    if status != 200:
        raise SystemExit(f"list returned {status}")
    jobs = body["jobs"]
    unknown = sorted({job["status"] for job in jobs} - KNOWN_STATUSES)
    if unknown:
        raise SystemExit(f"unexpected statuses {unknown}")
    if len(jobs) != int(expected):
        raise SystemExit(f"history holds {len(jobs)} jobs, expected {expected}")
    print("ok")


def published(render_job_id):
    return ROOT / "renders" / render_job_id / "output.mp4"


def verify(render_job_id, expected_seconds):
    """Cross-check the encoder, the recorded facts, and the bytes on disk."""
    probe = json.loads(os.environ["SMOKE_PROBE"])
    job = read(render_job_id)
    output = job["output"]
    path = published(render_job_id)
    root = ROOT.resolve(strict=True)
    if not path.resolve(strict=True).is_relative_to(root):
        raise SystemExit("published output escaped the artifact root")

    container = probe["format"]["format_name"]
    if "mp4" not in container.split(","):
        raise SystemExit(f"container is {container}")
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    audio = [s for s in probe["streams"] if s["codec_type"] == "audio"]
    if video["codec_name"] != "h264":
        raise SystemExit(f"video codec is {video['codec_name']}")
    measured = (video["width"], video["height"])
    if measured != (output["width"], output["height"]) or measured != (1080, 1920):
        raise SystemExit("dimensions disagree")
    if video["r_frame_rate"] != "30/1" or output["fps"] != 30.0:
        raise SystemExit("frame rate disagrees")
    if not audio or not output["has_audio"]:
        raise SystemExit("audio presence disagrees")
    if abs(float(probe["format"]["duration"]) - float(expected_seconds)) > 0.35:
        raise SystemExit("duration is outside tolerance")

    size = int(probe["format"]["size"])
    if size <= 0 or size != output["size_bytes"] or size != path.stat().st_size:
        raise SystemExit("size disagrees")
    if not output["checksum"] or checksum_of(path) != output["checksum"]:
        raise SystemExit("checksum disagrees")
    print("ok")


def absent(render_job_id):
    """A cancelled or timed-out render publishes nothing and keeps no half-render."""
    leftovers = [published(render_job_id), ROOT / "temp" / render_job_id / "output.mp4"]
    present = [path for path in leftovers if path.exists()]
    if present:
        raise SystemExit(f"left {len(present)} outputs behind")
    print("ok")


COMMANDS = {
    "seed": lambda d, f, a: seed(d, int(f), None if a == "none" else int(a)),
    "create": create,
    "busy": busy,
    "await": lambda j, t, *s: await_status(j, t, set(s)),
    "cancel": cancel,
    "history": history,
    "verify": verify,
    "absent": absent,
}

if __name__ == "__main__":
    COMMANDS[sys.argv[1]](*sys.argv[2:])
PYTHON_DRIVER

#: Only ``verify`` reads this, and only right after ffprobe has filled it.
probe='{}'

driver() {
    compose exec -T \
        --env SMOKE_PROJECT_ID="$project_id" \
        --env SMOKE_ASSET_ID="$asset_id" \
        --env SMOKE_PROBE="$probe" \
        api /opt/thoth/python/.venv/bin/python - "$@" < "$work_root/driver.py"
}

# --- bring up only what a render needs ---------------------------------------
compose up --detach --wait --wait-timeout "$start_timeout" editor-postgresql temporal >/dev/null 2>&1 \
    || fail renderer_runs_unprivileged
# The schema exists before the control plane does, exactly as a deployment does it.
compose run --rm --no-deps -T api thoth-control editor migrate >/dev/null \
    || fail renderer_runs_unprivileged
compose up --detach --wait --wait-timeout "$start_timeout" api remotion-renderer >/dev/null 2>&1 \
    || fail renderer_runs_unprivileged

# --- what the renderer is, and is not ----------------------------------------
renderer_container=$(compose ps --quiet remotion-renderer)
identity=$(compose exec -T remotion-renderer sh -c 'id -u; id -g' | tr '\n' ':')
[ "$identity" = "10001:10001:" ] || fail renderer_runs_unprivileged
echo renderer_runs_unprivileged=true

bindings=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$renderer_container")
case "$bindings" in
    *HostPort*) fail renderer_host_binding_absent ;;
esac
echo renderer_host_binding_absent=true

mounts=$(docker inspect --format '{{range .Mounts}}{{.Destination}};{{end}}' "$renderer_container")
[ "$mounts" = "/var/lib/thoth/artifacts;" ] || fail renderer_holds_no_control_plane_capability
capabilities=$(compose exec -T remotion-renderer sh -c 'printenv | cut -d= -f1 | sort')
case "$capabilities" in
    *THOTH_EDITOR_DATABASE_URL* | *THOTH_CONTROL_PLANE_API_KEY* | *THOTH_PROMPT_PROVIDER* \
        | *THOTH_EDITOR_PREVIEW_SIGNING_KEY* | *DOCKER_HOST* | *THOTH_CDP* | *POSTGRES*)
        fail renderer_holds_no_control_plane_capability
        ;;
esac
compose exec -T remotion-renderer sh -c '
    test ! -e /var/run/docker.sock &&
    test ! -e /usr/bin/psql &&
    test ! -e /usr/bin/python3 &&
    test ! -e /var/lib/thoth/browser-profile &&
    test ! -e /opt/thoth/python' || fail renderer_holds_no_control_plane_capability
echo renderer_holds_no_control_plane_capability=true

# --- one synthetic render, end to end ----------------------------------------
compose exec -T remotion-renderer sh -c 'mkdir -p /var/lib/thoth/artifacts/media'
compose exec -T remotion-renderer /usr/bin/ffmpeg -nostdin -loglevel error -y \
    -f lavfi -i "testsrc=size=1080x1920:rate=30:duration=4" \
    -f lavfi -i "sine=frequency=440:duration=4" \
    -c:v libx264 -pix_fmt yuv420p -preset ultrafast -c:a aac -shortest \
    "/var/lib/thoth/artifacts/media/${asset_id}.mp4" >/dev/null 2>&1 \
    || fail render_output_is_h264_mp4

driver seed "$document_id" "$main_frames" 120 >/dev/null || fail render_output_is_h264_mp4
job=$(driver create "$document_id") || fail render_output_is_h264_mp4
reached=$(driver await "$job" "$render_timeout" completed failed cancelled) \
    || fail render_output_is_h264_mp4
[ "$reached" = "completed" ] || fail render_output_is_h264_mp4

probe=$(compose exec -T remotion-renderer /usr/bin/ffprobe -v error -of json \
    -show_entries "format=format_name,duration,size:stream=codec_type,codec_name,width,height,r_frame_rate" \
    "/var/lib/thoth/artifacts/renders/${job}/output.mp4") || fail render_output_is_h264_mp4
driver verify "$job" "$main_seconds" >/dev/null || fail render_output_is_h264_mp4
# The verdict is an equality test, so the facts it agreed with are printed once
# for the audit record instead of being inferred from the verdict holding.
echo "render_output_facts=$(printf '%s' "$probe" | tr -d ' \n')"
echo "render_output_sha256=$(sha256sum "${work_root}/artifacts/renders/${job}/output.mp4" | cut -d' ' -f1)"
probe='{}'
echo render_output_is_h264_mp4=true
echo render_output_checksum_matches=true

# The published bytes exist in the one temporary root this harness created, and
# nothing was written beside it.
[ -f "${work_root}/artifacts/renders/${job}/output.mp4" ] || fail render_output_inside_artifact_root
strays=$(find "${work_root}/artifacts" -mindepth 1 -maxdepth 1 -printf '%f\n' \
    | grep -cvxE 'media|work|temp|renders' || true)
[ "$strays" -eq 0 ] || fail render_output_inside_artifact_root
echo render_output_inside_artifact_root=true

# --- one active render at a time, and cancellation ---------------------------
driver seed "$long_document_id" "$long_frames" none >/dev/null || fail second_render_is_refused
long_job=$(driver create "$long_document_id") || fail second_render_is_refused
reached=$(driver await "$long_job" "$active_timeout" rendering failed cancelled completed) \
    || fail second_render_is_refused
[ "$reached" = "rendering" ] || fail second_render_is_refused
driver busy "$long_document_id" >/dev/null || fail second_render_is_refused
echo second_render_is_refused=true

# A refused create must leave no row at all: the history still holds exactly the
# finished render and the active one.
driver history 2 >/dev/null || fail no_waiting_row_was_created
echo no_waiting_row_was_created=true

driver cancel "$long_job" >/dev/null || fail cancel_leaves_no_published_output
reached=$(driver await "$long_job" "$cancel_timeout" cancelled failed completed) \
    || fail cancel_leaves_no_published_output
[ "$reached" = "cancelled" ] || fail cancel_leaves_no_published_output
driver absent "$long_job" >/dev/null || fail cancel_leaves_no_published_output
echo cancel_leaves_no_published_output=true

# --- a render that runs past its deadline ------------------------------------
sed -i "s/^SMOKE_RENDER_MAX_SECONDS=.*/SMOKE_RENDER_MAX_SECONDS=${deadline_seconds}/" \
    "$work_root/harness.env"
compose up --detach --wait --wait-timeout "$start_timeout" --no-deps --force-recreate \
    remotion-renderer >/dev/null 2>&1 || fail deadline_fails_without_publishing

deadline_job=$(driver create "$long_document_id") || fail deadline_fails_without_publishing
reached=$(driver await "$deadline_job" "$deadline_timeout" failed cancelled completed) \
    || fail deadline_fails_without_publishing
[ "$reached" = "failed" ] || fail deadline_fails_without_publishing
driver absent "$deadline_job" >/dev/null || fail deadline_fails_without_publishing
echo deadline_fails_without_publishing=true

# --- give back exactly what was taken ----------------------------------------
teardown
survivors=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
networks=$(docker network ls --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
volumes=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
if [ "$survivors" -ne 0 ] || [ "$networks" -ne 0 ] || [ "$volumes" -ne 0 ] || [ -e "$work_root" ]; then
    echo "teardown_leaves_nothing=false"
    exit 1
fi
echo teardown_leaves_nothing=true
