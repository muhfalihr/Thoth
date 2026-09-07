#!/usr/bin/env bash
# Prove that a parity reference owns its browser: it starts one, drives it, never
# reaches the relay authority a deployment sidecar answers on, gets a profile that
# was never used before, and dies with its browser. Builds nothing: the image to
# test is the only argument, a local candidate tag locally and the published digest
# in CI.
#
# Everything this creates is owned by one disposable project name and removed on
# exit. It never touches a deployment or operator Compose file, never signals a
# process on the host, and never makes a provider or site request.
set -euo pipefail

project_prefix=stage1-parity-smoke
compose_file=compose.stage1.parity-smoke.yml
readiness_timeout=120
browser_timeout=60
exit_timeout=60

if [ "$#" -ne 1 ]; then
    echo "usage: docker/test-parity-offline.sh IMAGE" >&2
    exit 64
fi

THOTH_TEST_IMAGE="$1"
export THOTH_TEST_IMAGE

cd "$(dirname -- "$0")/.."
test_project="${project_prefix}-$$-$(date +%s)"
artifact_dir=$(mktemp -d)
chmod 700 "$artifact_dir"

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
    rmdir "$artifact_dir" 2>/dev/null || true
}
trap teardown EXIT INT TERM

fail() {
    # Service state and the harness's own codes only: container output carries the
    # browser payload, the environment, and the reference's own evidence.
    echo "$1=false"
    compose ps --all --format '{{.Service}} {{.Status}}' >&2
    for container in $(compose ps --all --quiet); do
        docker cp "$container:/opt/thoth/scout/output" "$artifact_dir/$container" >/dev/null 2>&1 || true
    done
    if [ -n "$(ls -A "$artifact_dir" 2>/dev/null)" ]; then
        echo "failure_artifacts=$artifact_dir" >&2
    fi
    exit 1
}

# The sentinel's own view of itself. Reading it is uncounted, so asking the
# question cannot change the answer.
sentinel_state() {
    compose exec -T sentinel /opt/thoth/python/.venv/bin/python -c "
import json, urllib.request
state = json.load(urllib.request.urlopen('http://127.0.0.1:18800/__identity', timeout=2))
print(state['identity'], state['health'], state['requests'])
"
}

# Chromium's parent only: a renderer dying is not the failure domain under test.
kill_browser_parent() {
    docker exec "$1" /opt/thoth/python/.venv/bin/python -c "
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
"
}

# Poll until Chromium exists, then kill it in the same call: there is no separate
# readiness signal for the browser a reference started for itself.
signal_browser_when_ready() {
    local deadline=$((SECONDS + browser_timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if kill_browser_parent "$1" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

compose up -d --wait --wait-timeout "$readiness_timeout" sentinel >/dev/null || fail sentinel_ready
before=$(sentinel_state) || fail sentinel_readable
[ "$before" = "stage1-parity-sentinel sentinel-untouched 0" ] || fail sentinel_starts_untouched

# First phase: a reference must start its own browser, drive it with the real
# Scout client, and find an empty profile. The probe serves its own page, so a
# pass is transport evidence and nothing more.
compose run --no-deps -T reference >/dev/null || fail reference_owns_browser
echo "reference_owns_browser=true"

after=$(sentinel_state) || fail sentinel_readable
[ "$after" = "$before" ] || fail sentinel_untouched
echo "sentinel_untouched=true"

# Second phase: a second container must find the profile empty again. The probe
# marks the profile it was given, so a reused profile fails here.
compose run --no-deps -T reference >/dev/null || fail profile_not_reused
echo "profile_not_reused=true"

# Third phase: the reference and its browser are one failure domain. Killing
# Chromium must fail the reference rather than leave a supervisor with no browser.
dying=$(compose run -d --no-deps reference) || fail forced_death_started
signal_browser_when_ready "$dying" || fail browser_signalled
if [ "$(docker wait "$dying")" -eq 0 ]; then
    fail supervisor_fails_on_browser_death
fi
echo "supervisor_fails_on_browser_death=true"

# Fourth phase: a cancelled reference must stop on request and still tear down.
cancelled=$(compose run -d --no-deps reference) || fail cancellation_started
docker stop --timeout 10 "$cancelled" >/dev/null || fail cancellation_signalled
if [ "$(docker wait "$cancelled")" -eq 0 ]; then
    fail cancelled_reference_reports_failure
fi
echo "cancelled_reference_reports_failure=true"

teardown
trap - EXIT INT TERM
survivors=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
networks=$(docker network ls --quiet --filter "label=com.docker.compose.project=$test_project" | wc -l)
if [ "$survivors" -ne 0 ] || [ "$networks" -ne 0 ]; then
    echo "teardown_leaves_nothing=false"
    exit 1
fi
echo "teardown_leaves_nothing=true"
