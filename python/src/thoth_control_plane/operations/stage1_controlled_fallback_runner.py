"""Deterministic, shell-free Docker orchestration for the `f1` controlled fallback gate.

`ControlledFallbackRunner` drives the one-shot lifecycle described by the design spec:
reserve, stage the fixture into a throwaway root-owned helper, start exactly one
detached gate service from the pinned digest, observe it without printing discovery
values, wait once for its terminal status, capture its logs, validate its artifact,
tear everything down, verify postconditions, and finalize the one safe result.

Every Docker interaction goes through the injected `CommandExecutor` as an argument
array with `shell=False` -- there is no string ever built for a shell to parse, so
there is nothing for the fixture value to interpolate into. `preflight()` and
`run_once()` both fail closed: any unexpected state raises `Stage1PreflightError`
before a container exists, and any failure after authorization is consumed is folded
into the safe, value-free result instead of being lost.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from thoth_control_plane.operations.stage1_controlled_fallback import (
    ControlledFallbackAttempt,
    ControlledFallbackFacts,
    PrivateArtifactIntegrity,
    append_index,
    check_controlled_fallback_inputs,
    finalize_attempt,
    reserve_attempt,
)
from thoth_control_plane.operations.stage1_local_preflight import (
    DEFAULT_ACTIVITY_MODE,
    Stage1PreflightError,
)
from thoth_control_plane.operations.tiktok_parity import (
    TikTokParityEvidenceError,
    measure_scout_reference_artifact,
    validate_scout_reference_artifact,
)

GATE_SERVICE = "controlled-fallback"
ALL_SERVICES = ("postgresql", "temporal", "temporal-ui", "legacy-cdp", "api", "worker")
ROLE_SERVICES = ("api", "worker", "legacy-cdp")
HEALTH_REQUIRED_SERVICES = ("postgresql", "temporal", "legacy-cdp", "api")
EXPECTED_ROLE_USER = "10001:10001"
_REVISION_LABEL = "org.opencontainers.image.revision"
_ACTIVITY_MODE_ENV = f"THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE={DEFAULT_ACTIVITY_MODE}"

# Fixed, value-free operations only: no host value is ever interpolated into these.
_STAGE_FIXTURE_SCRIPT = (
    "set -e; "
    "install -d -m 0500 -o 10001 -g 10001 /staging/reference-input; "
    "install -m 0400 -o 10001 -g 10001 /staging/url.txt /staging/reference-input/url"
)
_TEARDOWN_FIXTURE_SCRIPT = "rm -rf /staging/reference-input"

# Reads the CDP endpoint from the worker's own configured environment rather than
# a literal host/port, so no discovery value is ever typed into a host argv.
_PROBE_SCRIPT = (
    "import json,os,urllib.request;"
    "base=os.environ['THOTH_CDP'];"
    "targets=json.load(urllib.request.urlopen(base + '/json', timeout=5));"
    "pages=[t for t in targets if t.get('type')=='page'];"
    "print(json.dumps({'target_present': len(pages) >= 1, 'target_count': len(pages)}))"
)

_EMPTY_INTEGRITY = PrivateArtifactIntegrity(
    report_checksum="sha256:" + "0" * 64,
    media_checksum="sha256:" + "0" * 64,
    media_bytes=0,
)


@dataclass(frozen=True)
class CommandResult:
    """One completed command's outcome. Never logged or printed verbatim."""

    returncode: int
    stdout: bytes
    stderr: bytes


class CommandExecutor(Protocol):
    """The one seam between orchestration and a real process.

    A test double can replay synthetic Docker JSON through this seam without a
    daemon; the real implementation below never runs during this offline round.
    """

    def run(
        self, argv: list[str], *, env: dict[str, str], timeout: float | None = None
    ) -> CommandResult: ...

    def wait_container(self, container_id: str, *, timeout: float) -> CommandResult: ...


class SubprocessCommandExecutor:
    """The real Docker executor: argument arrays only, `shell=False` always.

    `env` holds overrides only; the child always also inherits the parent
    process environment so `docker`/`git` keep resolving normally on `PATH`.
    """

    def run(
        self, argv: list[str], *, env: dict[str, str], timeout: float | None = None
    ) -> CommandResult:
        merged_env = {**os.environ, **env}
        try:
            completed = subprocess.run(
                list(argv), env=merged_env, timeout=timeout, capture_output=True, check=False
            )
        except subprocess.TimeoutExpired as error:
            raise TimeoutError(
                "controlled fallback command exceeded its bounded timeout"
            ) from error
        return CommandResult(completed.returncode, completed.stdout, completed.stderr)

    def wait_container(self, container_id: str, *, timeout: float) -> CommandResult:
        result = self.run(["docker", "wait", container_id], env={}, timeout=timeout)
        if result.returncode != 0:
            raise RuntimeError("controlled fallback container wait failed")
        try:
            code = int(result.stdout.decode("utf-8", "strict").strip())
        except ValueError as error:
            raise RuntimeError(
                "controlled fallback container wait returned a non-numeric status"
            ) from error
        return CommandResult(code, result.stdout, result.stderr)


@dataclass(frozen=True)
class ControlledFallbackRunConfig:
    """Every host input one `f1` attempt needs. Paths, pinned identity, time budgets only."""

    repository_root: Path
    sample: Path
    provider: Path
    data_root: Path
    parity_root: Path
    digest: str
    acquisition_revision: str
    harness_revision: str
    base_compose_file: Path
    gate_compose_file: Path
    command_timeout: float = 30.0
    wait_timeout: float = 300.0


@dataclass
class _MutableFacts:
    """`ControlledFallbackFacts` under construction across the one-shot lifecycle.

    Health/target/restart fields default optimistic (nothing observed to
    contradict them yet); artifact fields default pessimistic (nothing proven
    yet). Both defaults are overwritten by what the run actually observes.
    """

    supervisor_exit_code: int | None = None
    artifact_present: bool = False
    artifact_validated: bool = False
    temporary_target_observed: bool = False
    health_target_preserved: bool = True
    target_count_restored: bool = True
    cdp_healthy_after: bool = True
    api_healthy_after: bool = True
    restart_counts_unchanged: bool = True
    cleanup_passed: bool = True
    teardown_leaves_nothing: bool = True

    def to_facts(self) -> ControlledFallbackFacts:
        return ControlledFallbackFacts(**asdict(self))


class ControlledFallbackRunner:
    """Drives one `f1` attempt: `preflight()` alone, or the full `run_once()` lifecycle."""

    def __init__(self, config: ControlledFallbackRunConfig, executor: CommandExecutor) -> None:
        self._config = config
        self._executor = executor
        self._baseline_target_count: int | None = None
        self._baseline_restart_counts: dict[str, int] = {}
        self._service_names: dict[str, str] = {}

    # -- Preflight: fail closed before any container is created -----------------

    def preflight(self) -> None:
        """Validate every gate input and the live deployment, or raise.

        Local, no-I/O checks run first; Docker-based deployment checks run only
        once those already hold. Authorization is never consumed here.
        """
        config = self._config
        check_controlled_fallback_inputs(
            image=f"ghcr.io/muhfalihr/thoth@{config.digest}",
            sample=config.sample,
            provider=config.provider,
            repository_root=config.repository_root,
            data_root=config.data_root,
            parity_root=config.parity_root,
        )
        self._check_repository_clean()
        self._capture_baseline()

    def _capture_baseline(self) -> None:
        self._check_compose_config()
        self._check_compose_images()
        rows = self._compose_ps()
        self._check_services_healthy(rows)
        self._baseline_restart_counts, self._service_names = self._inspect_services(rows)
        present, count = self._probe_target()
        if not (present and count == 1):
            raise Stage1PreflightError(
                "the shared legacy CDP sidecar must be in its steady one-target "
                "state before an f1 attempt may begin"
            )
        self._baseline_target_count = count

    def _check_repository_clean(self) -> None:
        result = self._executor.run(
            ["git", "-C", str(self._config.repository_root), "status", "--porcelain"],
            env={},
            timeout=self._config.command_timeout,
        )
        if result.returncode != 0 or result.stdout.strip():
            raise Stage1PreflightError(
                "the controlled fallback deployment baseline must be an exact, clean checkout"
            )

    def _compose_argv(self, *args: str) -> list[str]:
        config = self._config
        return [
            "docker",
            "compose",
            "-f",
            str(config.base_compose_file),
            "-f",
            str(config.gate_compose_file),
            *args,
        ]

    def _check_compose_config(self) -> None:
        result = self._executor.run(
            self._compose_argv("config", "--quiet"), env={}, timeout=self._config.command_timeout
        )
        if result.returncode != 0:
            raise Stage1PreflightError(
                "the controlled fallback compose overlay does not produce a valid configuration"
            )

    def _check_compose_images(self) -> None:
        expected = f"ghcr.io/muhfalihr/thoth@{self._config.digest}"
        result = self._executor.run(
            self._compose_argv("config", "--images"), env={}, timeout=self._config.command_timeout
        )
        images = {
            line.strip()
            for line in result.stdout.decode("utf-8", "replace").splitlines()
            if line.strip()
        }
        if expected not in images:
            raise Stage1PreflightError(
                "the controlled fallback compose overlay must resolve the authorized digest"
            )

    def _compose_ps(self) -> list[dict]:
        result = self._executor.run(
            self._compose_argv("ps", "--format", "json"),
            env={},
            timeout=self._config.command_timeout,
        )
        rows = []
        for line in result.stdout.decode("utf-8", "replace").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except ValueError as error:
                raise Stage1PreflightError(
                    "the controlled fallback deployment status did not return valid json"
                ) from error
        return rows

    def _check_services_healthy(self, rows: list[dict]) -> None:
        by_service = {row.get("Service"): row for row in rows}
        for service in ALL_SERVICES:
            row = by_service.get(service)
            if row is None or row.get("State") != "running":
                raise Stage1PreflightError(
                    "every controlled fallback deployment service must be running"
                )
            if service in HEALTH_REQUIRED_SERVICES and row.get("Health") != "healthy":
                raise Stage1PreflightError(
                    "every health-checked controlled fallback deployment service "
                    "must report healthy"
                )

    def _inspect(self, name: str) -> dict:
        result = self._executor.run(
            ["docker", "inspect", name], env={}, timeout=self._config.command_timeout
        )
        try:
            payload = json.loads(result.stdout)
        except ValueError as error:
            raise Stage1PreflightError(
                "controlled fallback deployment inspection did not return valid json"
            ) from error
        if not isinstance(payload, list) or not payload:
            raise Stage1PreflightError(
                "controlled fallback deployment inspection returned no container"
            )
        return payload[0]

    def _inspect_services(self, rows: list[dict]) -> tuple[dict[str, int], dict[str, str]]:
        by_service = {row.get("Service"): row for row in rows}
        restart_counts: dict[str, int] = {}
        service_names: dict[str, str] = {}
        for service in ALL_SERVICES:
            name = by_service[service]["Name"]
            service_names[service] = name
            payload = self._inspect(name)
            restart_counts[service] = int(payload.get("RestartCount", 0))
            if service in ROLE_SERVICES:
                self._check_role_identity(service, payload)
        return restart_counts, service_names

    def _check_role_identity(self, service: str, payload: dict) -> None:
        config = self._config
        docker_config = payload.get("Config") or {}
        if docker_config.get("Image") != config.digest:
            raise Stage1PreflightError(f"the {service} role must run the exact authorized digest")
        if docker_config.get("User") != EXPECTED_ROLE_USER:
            raise Stage1PreflightError(f"the {service} role must run as an unprivileged fixed uid")
        labels = docker_config.get("Labels") or {}
        if labels.get(_REVISION_LABEL) != config.acquisition_revision:
            raise Stage1PreflightError(f"the {service} role must carry the authorized OCI revision")
        if service == "worker" and _ACTIVITY_MODE_ENV not in (docker_config.get("Env") or []):
            raise Stage1PreflightError(
                "the worker role must run in the approved fallback activity mode"
            )
        if service == "legacy-cdp":
            ports = ((payload.get("NetworkSettings") or {}).get("Ports")) or {}
            if ports.get("18800/tcp"):
                raise Stage1PreflightError("the legacy CDP sidecar must not publish a host port")

    def _probe_target(self) -> tuple[bool, int]:
        argv = self._compose_argv(
            "exec", "-T", "worker", "/opt/thoth/python/.venv/bin/python", "-c", _PROBE_SCRIPT
        )
        result = self._executor.run(argv, env={}, timeout=self._config.command_timeout)
        try:
            payload = json.loads(result.stdout)
        except ValueError as error:
            raise Stage1PreflightError(
                "the controlled fallback CDP probe did not return valid json"
            ) from error
        return bool(payload.get("target_present")), int(payload.get("target_count", 0))

    # -- One-shot lifecycle: reserve, run, always clean up, always finalize -----

    def run_once(self) -> ControlledFallbackAttempt:
        config = self._config
        reserve_attempt(
            config.sample,
            digest=config.digest,
            acquisition_revision=config.acquisition_revision,
            harness_revision=config.harness_revision,
            occurred_at=datetime.now(UTC),
        )

        facts = _MutableFacts()
        container_id: str | None = None
        try:
            # Gate-input and repository-clean checks are the operator's separate,
            # already-completed `preflight()` step: `reserve_attempt()` just wrote
            # the pending record itself, so re-running `check_controlled_fallback_inputs`
            # here would always reject it as prior evidence. Only the Docker-based
            # baseline this lifecycle needs for its own postcondition comparisons
            # is captured here.
            self._capture_baseline()
            self._run_staging_helper(_STAGE_FIXTURE_SCRIPT)
            container_id = self._start_gate_service()
            try:
                _, observed_count = self._probe_target()
                facts.temporary_target_observed = observed_count > (
                    self._baseline_target_count or 0
                )
            except Exception:
                pass
            try:
                result = self._executor.wait_container(container_id, timeout=config.wait_timeout)
                facts.supervisor_exit_code = result.returncode
            except Exception:
                facts.supervisor_exit_code = None
        except Stage1PreflightError:
            pass
        except Exception:
            pass

        # Steps 7-10 always run, bounded, regardless of what happened above.
        if not self._capture_logs(container_id):
            facts.cleanup_passed = False

        integrity = self._validate_and_measure(facts)

        if not self._teardown(container_id):
            facts.cleanup_passed = False

        self._apply_postcondition_facts(facts)

        attempt = finalize_attempt(config.sample, facts.to_facts(), integrity)
        append_index(config.sample.parent, attempt)
        return attempt

    def _run_staging_helper(self, script: str) -> None:
        config = self._config
        argv = [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            "0:0",
            "-v",
            f"{config.sample}:/staging",
            f"ghcr.io/muhfalihr/thoth@{config.digest}",
            "/bin/sh",
            "-c",
            script,
        ]
        result = self._executor.run(argv, env={}, timeout=config.command_timeout)
        if result.returncode != 0:
            raise RuntimeError("controlled fallback staging helper failed")

    def _start_gate_service(self) -> str:
        config = self._config
        # The gate overlay's own `env_file:` stanza resolves the restricted provider
        # path through `${THOTH_STAGE1_PROVIDER_ENV_FILE}` -- the same indirection
        # `compose.stage1.providers.yml` uses for the worker -- so only the path
        # itself, never its contents, needs to reach this process environment.
        up = self._executor.run(
            self._compose_argv("up", "-d", GATE_SERVICE),
            env={"THOTH_STAGE1_PROVIDER_ENV_FILE": str(config.provider)},
            timeout=config.command_timeout,
        )
        if up.returncode != 0:
            raise RuntimeError("controlled fallback gate service failed to start")
        located = self._executor.run(
            self._compose_argv("ps", "-q", GATE_SERVICE), env={}, timeout=config.command_timeout
        )
        container_id = located.stdout.decode("utf-8", "replace").strip()
        if not container_id:
            raise RuntimeError("controlled fallback gate container id was not reported")
        return container_id

    def _capture_logs(self, container_id: str | None) -> bool:
        if container_id is None:
            return True
        config = self._config
        try:
            result = self._executor.run(
                ["docker", "logs", container_id], env={}, timeout=config.command_timeout
            )
            self._write_restricted(config.sample / "supervisor.stdout.log", result.stdout)
            self._write_restricted(config.sample / "supervisor.stderr.log", result.stderr)
        except (OSError, Exception):
            return False
        return True

    @staticmethod
    def _write_restricted(path: Path, data: bytes) -> None:
        descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        try:
            os.write(descriptor, data)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _validate_and_measure(self, facts: _MutableFacts) -> PrivateArtifactIntegrity:
        output_dir = self._config.sample / "output"
        report_path = output_dir / "source-report.json"
        facts.artifact_present = report_path.is_file()
        if not facts.artifact_present:
            facts.artifact_validated = False
            return _EMPTY_INTEGRITY
        try:
            measurement = measure_scout_reference_artifact(report_path, output_dir)
            integrity = validate_scout_reference_artifact(report_path, output_dir, measurement)
        except TikTokParityEvidenceError:
            facts.artifact_validated = False
            return _EMPTY_INTEGRITY
        facts.artifact_validated = integrity.passed
        return PrivateArtifactIntegrity(
            report_checksum=measurement.report_checksum,
            media_checksum=measurement.media_checksum,
            media_bytes=measurement.media_bytes,
        )

    def _teardown(self, container_id: str | None) -> bool:
        ok = True
        try:
            self._run_staging_helper(_TEARDOWN_FIXTURE_SCRIPT)
        except Exception:
            ok = False
        if container_id is not None:
            try:
                result = self._executor.run(
                    ["docker", "rm", "-f", container_id],
                    env={},
                    timeout=self._config.command_timeout,
                )
                if result.returncode != 0:
                    ok = False
            except Exception:
                ok = False
        return ok

    def _apply_postcondition_facts(self, facts: _MutableFacts) -> None:
        if self._baseline_target_count is None:
            # preflight never completed inside this attempt; the artifact tier
            # has already failed the verdict, so the optimistic defaults here
            # are never mistaken for activation credit.
            return
        try:
            present, count = self._probe_target()
            facts.health_target_preserved = present
            facts.target_count_restored = count == self._baseline_target_count
        except Exception:
            facts.health_target_preserved = False
            facts.target_count_restored = False

        try:
            rows = self._compose_ps()
            health_by_service = {row.get("Service"): row.get("Health") for row in rows}
            facts.cdp_healthy_after = health_by_service.get("legacy-cdp") == "healthy"
            facts.api_healthy_after = health_by_service.get("api") == "healthy"
        except Exception:
            facts.cdp_healthy_after = False
            facts.api_healthy_after = False

        try:
            restart_counts = {
                service: self._inspect(name).get("RestartCount", 0)
                for service, name in self._service_names.items()
            }
            facts.restart_counts_unchanged = restart_counts == self._baseline_restart_counts
        except Exception:
            facts.restart_counts_unchanged = False

        try:
            result = self._executor.run(
                self._compose_argv("ps", "-q", GATE_SERVICE),
                env={},
                timeout=self._config.command_timeout,
            )
            facts.teardown_leaves_nothing = result.stdout.decode("utf-8", "replace").strip() == ""
        except Exception:
            facts.teardown_leaves_nothing = False
