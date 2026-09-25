#!/usr/bin/env bash
# Prove the `f1` controlled fallback gate's container contract offline. Builds nothing:
# the image to test is the only argument, a local candidate tag locally and the
# published digest in CI.
#
# The staging, reclaim, and teardown helpers are the runner's own scripts, byte for
# byte, run as the runner runs them. The one-shot gate service then runs the
# production supervisor's offline-smoke path against a synthetic `about:blank` browser
# on an internal network. No fixture URL, provider file, or deployment project is
# involved, and everything created here is owned by one disposable project and one
# temporary directory, both removed on exit.
set -euo pipefail

project_prefix=stage1-fallback-smoke
compose_file=compose.stage1.controlled-fallback-smoke.yml
readiness_timeout=120
run_timeout=60

# Keep byte-identical to the constants in stage1_controlled_fallback_runner.py.
stage_script='set -e; install -d -m 0500 -o 10001 -g 10001 /staging/reference-input; install -m 0400 -o 10001 -g 10001 /staging/url.txt /staging/reference-input/url; mkdir -m 0700 /staging/output; chown 10001:10001 /staging/output'
reclaim_script='set -e; test -d /staging/output || exit 0; chown -R "$(stat -c %u:%g /staging)" /staging/output; chmod -R u=rwX,go= /staging/output'
teardown_script='rm -rf /staging/reference-input'

if [ "$#" -ne 1 ]; then
    echo "usage: docker/test-controlled-fallback-offline.sh IMAGE" >&2
    exit 64
fi

THOTH_TEST_IMAGE="$1"
export THOTH_TEST_IMAGE

cd "$(dirname -- "$0")/.."
test_project="${project_prefix}-$$-$(date +%s)"
workdir=$(mktemp -d)
sample="$workdir/f1"
THOTH_CONTROLLED_FALLBACK_SAMPLE_DIR="$sample"
export THOTH_CONTROLLED_FALLBACK_SAMPLE_DIR

compose() {
    docker compose -p "$test_project" -f "$compose_file" "$@"
}

helper() {
    docker run --rm --network none --user 0:0 -v "$sample:/staging" "$THOTH_TEST_IMAGE" \
        /bin/sh -c "$1"
}

teardown() {
    case "$test_project" in
        "${project_prefix}"-*) ;;
        *)
            echo "refusing to tear down a project this harness does not own" >&2
            return 1
            ;;
    esac
    compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
    # Staged entries belong to 10001 or root, so only the helper can release them.
    if [ -d "$sample" ]; then
        helper "$teardown_script" >/dev/null 2>&1 || true
        helper "$reclaim_script" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$workdir"
}
trap teardown EXIT

fail() {
    # Service state and the harness's own codes only: container logs carry browser
    # payload and environment.
    echo "$1=false"
    compose ps --all --format '{{.Service}} {{.Status}}' >&2
    exit 1
}

# Prints "<page targets> <about:blank pages>" and nothing that identifies a target.
page_counts() {
    compose exec -T legacy-cdp /opt/thoth/python/.venv/bin/python -c "
import json, urllib.request
targets = json.load(urllib.request.urlopen('http://127.0.0.1:18800/json', timeout=2))
pages = [t for t in targets if t.get('type') == 'page']
print(len(pages), sum(1 for t in pages if t.get('url') == 'about:blank'))
"
}

mkdir -m 0700 "$sample"
# A placeholder, not a URL: the offline-smoke path never reads it into a request.
(umask 077 && printf 'offline-smoke-placeholder\n' >"$sample/url.txt")

compose up -d --wait --wait-timeout "$readiness_timeout" legacy-cdp >/dev/null || fail legacy_cdp_ready
cdp_container=$(compose ps -q legacy-cdp)
case "$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$cdp_container")" in
    *HostPort*) fail preflight_contract ;;
esac
[ "$(page_counts)" = "1 1" ] || fail preflight_contract
helper "$stage_script" >/dev/null || fail preflight_contract
staged=$(helper 'stat -c %u:%g:%a /staging/reference-input /staging/reference-input/url /staging/output' | tr '\n' ' ')
[ "$staged" = "10001:10001:500 10001:10001:400 10001:10001:700 " ] || fail preflight_contract
echo "preflight_contract=true"

observed_everywhere=true
run_gate() {
    local mode=$1 expected=$2 label=$3 container status observed=false
    THOTH_CONTROLLED_FALLBACK_SMOKE_MODE="$mode" \
        compose up -d --no-deps controlled-fallback >/dev/null || fail "${label}_gate_started"
    container=$(compose ps -q --all controlled-fallback)
    for _ in $(seq 1 30); do
        if [ "$(page_counts | cut -d' ' -f1)" -gt 1 ]; then
            observed=true
            break
        fi
        [ "$(docker inspect -f '{{.State.Running}}' "$container")" = "true" ] || break
        sleep 0.1
    done
    status=$(timeout "$run_timeout" docker wait "$container") || fail "${label}_gate_exited"
    docker rm -f "$container" >/dev/null || fail "${label}_gate_removed"
    [ "$status" = "$expected" ] || fail "${label}_exit_status"
    [ "$observed" = true ] || observed_everywhere=false
    [ "$(page_counts)" = "1 1" ] || fail "${label}_target_removed"
}

run_gate --offline-smoke 0 success
echo "success_target_removed=true"
run_gate --offline-smoke-failure 17 failure
echo "failure_target_removed=true"
[ "$observed_everywhere" = true ] || fail temporary_target_observed
echo "temporary_target_observed=true"

[ "$(docker inspect -f '{{.State.Health.Status}}' "$cdp_container")" = "healthy" ] \
    || fail health_target_preserved
[ "$(page_counts)" = "1 1" ] || fail health_target_preserved
echo "health_target_preserved=true"

helper "$reclaim_script" >/dev/null || fail staged_output_reclaimed
helper "$teardown_script" >/dev/null || fail staged_output_reclaimed
[ -O "$sample/output/write-probe" ] || fail staged_output_reclaimed
[ "$(stat -c %a "$sample/output" "$sample/output/write-probe" | tr '\n' ' ')" = "700 600 " ] \
    || fail staged_output_reclaimed
[ ! -e "$sample/reference-input" ] || fail staged_output_reclaimed
echo "staged_output_reclaimed=true"
# Scout's media lands under its fixed output root; it must survive the container in the gate directory.
[ -O "$sample/output/media-probe" ] || fail scout_output_retained
echo "scout_output_retained=true"

teardown
trap - EXIT
survivors=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
networks=$(docker network ls --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
if [ "$survivors" -ne 0 ] || [ "$networks" -ne 0 ] || [ -e "$workdir" ]; then
    echo "teardown_leaves_nothing=false"
    exit 1
fi
echo "teardown_leaves_nothing=true"
