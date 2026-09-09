#!/usr/bin/env bash
# Prove that a sibling container can reach the browser, and that the browser cannot be
# reached from anywhere else. Builds nothing: the image to test is the only argument,
# a local candidate tag locally and the published digest in CI.
#
# Everything this creates is owned by one disposable project name and removed on exit.
# It never touches a production Compose file and never signals a process on the host.
set -euo pipefail

project_prefix=stage1-cdp-smoke
compose_file=compose.stage1.cdp-smoke.yml
readiness_timeout=120
shutdown_grace=30

if [ "$#" -ne 1 ]; then
    echo "usage: docker/test-cdp-offline.sh IMAGE" >&2
    exit 64
fi

THOTH_TEST_IMAGE="$1"
export THOTH_TEST_IMAGE

cd "$(dirname -- "$0")/.."
test_project="${project_prefix}-$$-$(date +%s)"

compose() {
    docker compose -p "$test_project" -f "$compose_file" "$@"
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
}
trap teardown EXIT

fail() {
    # Service state and the harness's own codes only: container logs carry browser
    # payload and environment.
    echo "$1=false"
    compose ps --all --format '{{.Service}} {{.Status}}' >&2
    exit 1
}

compose up -d --wait --wait-timeout "$readiness_timeout" browser >/dev/null || fail browser_ready
browser_container=$(compose ps -q browser)

# `compose port` reports an exposed port as `invalid IP:0` whether or not it is
# published, so the container's own host bindings are the evidence instead: an
# unpublished port maps to null and a published one carries a HostPort.
bindings=$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$browser_container")
case "$bindings" in
    *HostPort*) fail browser_host_binding_absent ;;
esac
echo "browser_host_binding_absent=true"

compose run --rm --no-deps -T probe || fail probe_transport

# Exercise the production legacy-fallback supervisor from the sibling probe.  The
# executable keeps target IDs and URLs in memory and emits only this fixed verdict.
isolation_output=$(compose run --rm --no-deps -T probe \
    bun scout/runtime/legacy_fallback_harness.ts) || fail fallback_target_isolation
expected_isolation='{"initial_target_preserved":true,"temporary_target_observed":true,"success_target_removed":true,"failure_target_removed":true}'
[ "$isolation_output" = "$expected_isolation" ] || fail fallback_target_isolation
echo "initial_target_preserved=true"
echo "temporary_target_observed=true"
echo "success_target_removed=true"
echo "failure_target_removed=true"

# Second lifecycle phase: the browser and its relay are one failure domain, so killing
# Chromium inside the test container must take the container down rather than leave a
# reachable relay with no browser behind it.
compose exec -T browser /opt/thoth/python/.venv/bin/python -c "
import os
import signal

for entry in os.listdir('/proc'):
    if not entry.isdigit():
        continue
    try:
        with open(f'/proc/{entry}/cmdline', 'rb') as handle:
            arguments = handle.read().split(b'\x00')
            executable = arguments[0].decode()
    except OSError:
        continue
    if executable.endswith('/chrome') and not any(arg.startswith(b'--type=') for arg in arguments):
        os.kill(int(entry), signal.SIGKILL)
        break
else:
    raise SystemExit('chromium_not_found')
" >/dev/null || fail chromium_signalled

deadline=$((SECONDS + shutdown_grace))
supervisor_stopped=false
while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$browser_container" 2>/dev/null || echo false)" != "true" ]; then
        supervisor_stopped=true
        break
    fi
    sleep 1
done
[ "$supervisor_stopped" = true ] || fail supervisor_exits_with_browser
echo "supervisor_exits_with_browser=true"

teardown
trap - EXIT
survivors=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
networks=$(docker network ls --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
if [ "$survivors" -ne 0 ] || [ "$networks" -ne 0 ]; then
    echo "teardown_leaves_nothing=false"
    exit 1
fi
echo "teardown_leaves_nothing=true"
