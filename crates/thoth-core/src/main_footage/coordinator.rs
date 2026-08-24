//! Supervised planning and verified-active resume coordination.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::Command;

use thoth_types::main_footage::{
    MainFootageActiveV1, MainFootageErrorCode, NarrationTimelineV1, fingerprint_canonical,
};

use crate::execution::JobExecutionContext;
use crate::main_footage::verify::{
    MediaProbe, SupervisedFfprobe, VerifiedMainFootagePlan, verify_plan_with_probe,
};
use crate::main_footage::{ImportedSourcePackage, MainFootageError};
use crate::pipeline::job::JobContext;
use crate::util::progress::{emit_main_footage_progress, parse_planner_progress_line};

#[derive(Clone, Copy)]
pub struct MainFootagePrepareInput<'a> {
    pub imported: &'a ImportedSourcePackage,
    pub coverage_target: f64,
}

pub struct MainFootageCoordinator;

#[async_trait]
pub(crate) trait PlannerPort: Sync {
    async fn plan(
        &self,
        job: &JobContext,
        package_path: &str,
        narration_path: &str,
        coverage_target: f64,
        execution: &JobExecutionContext,
    ) -> Result<()>;
}

struct ScoutPlanner;

#[async_trait]
impl PlannerPort for ScoutPlanner {
    async fn plan(
        &self,
        job: &JobContext,
        package_path: &str,
        narration_path: &str,
        coverage_target: f64,
        execution: &JobExecutionContext,
    ) -> Result<()> {
        invoke_scout_planner(
            job,
            package_path,
            narration_path,
            coverage_target,
            execution,
        )
        .await
    }
}

/// Explicit test composition for the cross-runtime acceptance harness. Production
/// callers use `ScoutPlanner`, which always launches `scout/cli.ts`.
struct TestOnlyScoutPlanner<'a> {
    script_path: &'a Path,
}

#[async_trait]
impl PlannerPort for TestOnlyScoutPlanner<'_> {
    async fn plan(
        &self,
        job: &JobContext,
        package_path: &str,
        narration_path: &str,
        coverage_target: f64,
        execution: &JobExecutionContext,
    ) -> Result<()> {
        invoke_test_only_scout_planner(
            job,
            package_path,
            narration_path,
            coverage_target,
            execution,
            self.script_path,
        )
        .await
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlannerTerminalWire {
    stage: String,
    pct: f32,
    message: String,
    warning: String,
}

fn terminal_code(value: &str) -> Option<MainFootageErrorCode> {
    match value {
        "forced_main_no_usable_video" => Some(MainFootageErrorCode::ForcedMainNoUsableVideo),
        "forced_main_narration_required" => Some(MainFootageErrorCode::ForcedMainNarrationRequired),
        "source_package_invalid" => Some(MainFootageErrorCode::SourcePackageInvalid),
        "narration_generation_failed" => Some(MainFootageErrorCode::NarrationGenerationFailed),
        "cut_planning_failed" => Some(MainFootageErrorCode::CutPlanningFailed),
        "cut_materialization_exhausted" => Some(MainFootageErrorCode::CutMaterializationExhausted),
        "plan_verification_failed" => Some(MainFootageErrorCode::PlanVerificationFailed),
        _ => None,
    }
}

fn terminal_code_from_line(line: &str) -> Option<MainFootageErrorCode> {
    let wire: PlannerTerminalWire = serde_json::from_str(line).ok()?;
    if wire.stage != "planning_cuts" || wire.pct != 0.0 || wire.message != wire.warning {
        return None;
    }
    terminal_code(&wire.warning)
}

fn terminal_code_from_stderr_lines<I, S>(lines: I) -> MainFootageErrorCode
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    lines
        .into_iter()
        .find_map(|line| terminal_code_from_line(line.as_ref()))
        .unwrap_or(MainFootageErrorCode::CutPlanningFailed)
}

fn planner_process_error(error: anyhow::Error) -> anyhow::Error {
    if crate::execution::is_cancelled(&error) {
        error
    } else {
        MainFootageError::new(
            MainFootageErrorCode::CutPlanningFailed,
            "planner_process_failed",
        )
        .into()
    }
}

async fn consume_planner_stdout<R: AsyncBufRead + Unpin>(
    reader: R,
    execution: &JobExecutionContext,
) -> Result<()> {
    let mut lines = reader.lines();
    while let Some(line) = lines.next_line().await.map_err(|_| {
        MainFootageError::new(
            MainFootageErrorCode::CutPlanningFailed,
            "planner_stdout_failed",
        )
    })? {
        execution.check_cancelled()?;
        let progress = parse_planner_progress_line(&line).map_err(|_| {
            MainFootageError::new(
                MainFootageErrorCode::CutPlanningFailed,
                "planner_progress_invalid",
            )
        })?;
        emit_main_footage_progress(&progress);
        execution.check_cancelled()?;
    }
    Ok(())
}

async fn consume_planner_stderr<R: AsyncBufRead + Unpin>(reader: R) -> MainFootageErrorCode {
    let mut lines = reader.lines();
    let mut selected = None;
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if selected.is_none() {
                    selected = terminal_code_from_line(&line);
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    selected.unwrap_or(MainFootageErrorCode::CutPlanningFailed)
}

async fn invoke_scout_planner(
    job: &JobContext,
    package_path: &str,
    narration_path: &str,
    coverage_target: f64,
    execution: &JobExecutionContext,
) -> Result<()> {
    execution.check_cancelled()?;
    let runtime = crate::pipeline::ocr::resolve_scout_runtime().map_err(|_| {
        MainFootageError::new(
            MainFootageErrorCode::CutPlanningFailed,
            "planner_runtime_unavailable",
        )
    })?;
    invoke_scout_planner_script(
        job,
        package_path,
        narration_path,
        coverage_target,
        execution,
        &runtime,
        &runtime.cli_ts,
        Some("plan-main-footage"),
    )
    .await
}

async fn invoke_test_only_scout_planner(
    job: &JobContext,
    package_path: &str,
    narration_path: &str,
    coverage_target: f64,
    execution: &JobExecutionContext,
    script_path: &Path,
) -> Result<()> {
    execution.check_cancelled()?;
    let runtime = crate::pipeline::ocr::resolve_scout_runtime().map_err(|_| {
        MainFootageError::new(
            MainFootageErrorCode::CutPlanningFailed,
            "planner_runtime_unavailable",
        )
    })?;
    invoke_scout_planner_script(
        job,
        package_path,
        narration_path,
        coverage_target,
        execution,
        &runtime,
        script_path,
        None,
    )
    .await
}

async fn invoke_scout_planner_script(
    job: &JobContext,
    package_path: &str,
    narration_path: &str,
    coverage_target: f64,
    execution: &JobExecutionContext,
    runtime: &crate::pipeline::ocr::ScoutRuntime,
    script_path: &Path,
    command_name: Option<&str>,
) -> Result<()> {
    let root = canonical_job_root(job)?;
    let mut command = Command::new(&runtime.bun);
    command.arg(script_path);
    if let Some(command_name) = command_name {
        command.arg(command_name);
    }
    command
        .arg("--job-root")
        .arg(&root)
        .arg("--package")
        .arg(package_path)
        .arg("--narration")
        .arg(narration_path)
        .arg("--coverage-target")
        .arg(coverage_target.to_string())
        .current_dir(&runtime.scout_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match execution.spawn(&mut command) {
        Ok(child) => child,
        Err(error) if crate::execution::is_cancelled(&error) => return Err(error),
        Err(_) => {
            return Err(MainFootageError::new(
                MainFootageErrorCode::CutPlanningFailed,
                "planner_process_failed",
            )
            .into());
        }
    };
    let stdout = child.take_stdout().ok_or_else(|| {
        MainFootageError::new(
            MainFootageErrorCode::CutPlanningFailed,
            "planner_stdout_unavailable",
        )
    })?;
    let stderr = child.take_stderr().ok_or_else(|| {
        MainFootageError::new(
            MainFootageErrorCode::CutPlanningFailed,
            "planner_stderr_unavailable",
        )
    })?;
    let (status, stdout_result, terminal) = tokio::join!(
        child.wait(),
        consume_planner_stdout(BufReader::new(stdout), execution),
        consume_planner_stderr(BufReader::new(stderr)),
    );
    let status = status.map_err(planner_process_error)?;
    stdout_result?;
    execution.check_cancelled()?;
    if !status.success() {
        return Err(MainFootageError::new(terminal, "planner_subprocess_failed").into());
    }
    Ok(())
}

fn verification_failed(detail: &'static str) -> anyhow::Error {
    MainFootageError::new(MainFootageErrorCode::PlanVerificationFailed, detail).into()
}

fn canonical_job_root(job: &JobContext) -> Result<PathBuf> {
    fs::canonicalize(job.root()).map_err(|_| verification_failed("job_root_unreadable"))
}

fn read_active(job: &JobContext, root: &Path) -> Result<Option<MainFootageActiveV1>> {
    let path = job.plans_dir().join("active.json");
    if !path.exists() {
        return Ok(None);
    }
    let canonical =
        fs::canonicalize(&path).map_err(|_| verification_failed("active_pointer_unreadable"))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(verification_failed("active_pointer_outside_job_root"));
    }
    let bytes =
        fs::read(canonical).map_err(|_| verification_failed("active_pointer_unreadable"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| verification_failed("active_pointer_rejected"))
}

fn narration_fingerprint(narration: &NarrationTimelineV1) -> Result<String> {
    let value = serde_json::to_value(narration)
        .map_err(|_| verification_failed("narration_timeline_rejected"))?;
    let fingerprint = fingerprint_canonical(&value)
        .map_err(|_| verification_failed("narration_fingerprint_failed"))?;
    if narration.fingerprint.as_deref() != Some(fingerprint.as_str()) {
        return Err(verification_failed("narration_fingerprint_mismatch"));
    }
    Ok(fingerprint)
}

impl MainFootageCoordinator {
    pub async fn prepare(
        job: &JobContext,
        input: MainFootagePrepareInput<'_>,
        narration: &NarrationTimelineV1,
        execution: &JobExecutionContext,
    ) -> Result<VerifiedMainFootagePlan> {
        Self::prepare_with(
            job,
            input,
            narration,
            execution,
            &ScoutPlanner,
            &SupervisedFfprobe::new(execution),
        )
        .await
    }

    /// Test-only entry/provider composition for the real cross-runtime acceptance
    /// harness. It is deliberately explicit: no process environment value can select it.
    #[doc(hidden)]
    pub async fn prepare_with_test_only_planner_script(
        job: &JobContext,
        input: MainFootagePrepareInput<'_>,
        narration: &NarrationTimelineV1,
        execution: &JobExecutionContext,
        script_path: &Path,
    ) -> Result<VerifiedMainFootagePlan> {
        Self::prepare_with(
            job,
            input,
            narration,
            execution,
            &TestOnlyScoutPlanner { script_path },
            &SupervisedFfprobe::new(execution),
        )
        .await
    }

    pub(crate) async fn prepare_with<P: PlannerPort, M: MediaProbe>(
        job: &JobContext,
        input: MainFootagePrepareInput<'_>,
        narration: &NarrationTimelineV1,
        execution: &JobExecutionContext,
        planner: &P,
        probe: &M,
    ) -> Result<VerifiedMainFootagePlan> {
        execution.check_cancelled()?;
        if !input.coverage_target.is_finite() || !(0.60..=1.0).contains(&input.coverage_target) {
            return Err(verification_failed("coverage_target_invalid"));
        }
        let root = canonical_job_root(job)?;
        let narration_fingerprint = narration_fingerprint(narration)?;
        if let Some(active) = read_active(job, &root)? {
            if active.source_package_fingerprint == input.imported.fingerprint
                && active.narration_fingerprint == narration_fingerprint
            {
                let plan_path = root.join(&active.plan_path);
                let verified =
                    verify_plan_with_probe(job, input.imported, narration, &plan_path, probe)
                        .await?;
                if (verified.metrics().coverage_target - input.coverage_target).abs() <= 1e-9 {
                    execution.check_cancelled()?;
                    return Ok(verified);
                }
            }
        }

        planner
            .plan(
                job,
                "main-footage/source-package.json",
                "narration/timeline.json",
                input.coverage_target,
                execution,
            )
            .await?;
        execution.check_cancelled()?;
        let active = read_active(job, &root)?
            .ok_or_else(|| verification_failed("verified_active_pointer_missing"))?;
        if active.source_package_fingerprint != input.imported.fingerprint
            || active.narration_fingerprint != narration_fingerprint
        {
            return Err(verification_failed("active_identity_mismatch"));
        }
        let verified = verify_plan_with_probe(
            job,
            input.imported,
            narration,
            &root.join(&active.plan_path),
            probe,
        )
        .await?;
        if (verified.metrics().coverage_target - input.coverage_target).abs() > 1e-9 {
            return Err(verification_failed("coverage_target_mismatch"));
        }
        execution.check_cancelled()?;
        Ok(verified)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;

    use super::{
        MainFootageCoordinator, MainFootagePrepareInput, PlannerPort, planner_process_error,
        terminal_code_from_stderr_lines,
    };
    use crate::execution::JobExecutionContext;
    use crate::execution::is_cancelled;
    use crate::main_footage::fingerprint_canonical;
    use crate::main_footage::verify::tests::fixture;
    use serde_json::{Value, json};

    #[derive(Default)]
    struct FakePlanner {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl PlannerPort for FakePlanner {
        async fn plan(
            &self,
            _job: &crate::pipeline::job::JobContext,
            _package_path: &str,
            _narration_path: &str,
            _coverage_target: f64,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct PublishingPlanner {
        calls: AtomicUsize,
        narration_fingerprint: String,
    }

    #[async_trait]
    impl PlannerPort for PublishingPlanner {
        async fn plan(
            &self,
            job: &crate::pipeline::job::JobContext,
            _package_path: &str,
            _narration_path: &str,
            _coverage_target: f64,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let root = job.root();
            let v1_path = root.join("plans/v001/main-footage-plan.json");
            let mut plan: Value = serde_json::from_slice(&fs::read(v1_path)?)?;
            plan["narration_fingerprint"] = Value::String(self.narration_fingerprint.clone());
            for index in 0..plan["timeline"].as_array().unwrap().len() {
                let old = plan["timeline"][index]["cut_path"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                let new = old.replace("cuts/v001/", "cuts/v002/");
                let source = root.join(&old);
                let destination = root.join(&new);
                fs::create_dir_all(destination.parent().unwrap())?;
                fs::copy(source, destination)?;
                plan["timeline"][index]["cut_path"] = Value::String(new);
            }
            let plan_fingerprint = fingerprint_canonical(&plan).unwrap();
            plan["fingerprint"] = Value::String(plan_fingerprint.clone());
            let v2_path = root.join("plans/v002/main-footage-plan.json");
            fs::create_dir_all(v2_path.parent().unwrap())?;
            fs::write(&v2_path, serde_json::to_vec_pretty(&plan)?)?;
            fs::write(
                root.join("plans/active.json"),
                serde_json::to_vec_pretty(&json!({
                    "schema_version": 1,
                    "status": "verified",
                    "version": "v002",
                    "plan_path": "plans/v002/main-footage-plan.json",
                    "source_package_fingerprint": plan["source_package_fingerprint"],
                    "narration_fingerprint": plan["narration_fingerprint"],
                    "plan_fingerprint": plan_fingerprint
                }))?,
            )?;
            Ok(())
        }
    }

    struct CancellingPlanner;

    #[async_trait]
    impl PlannerPort for CancellingPlanner {
        async fn plan(
            &self,
            job: &crate::pipeline::job::JobContext,
            _package_path: &str,
            _narration_path: &str,
            _coverage_target: f64,
            execution: &JobExecutionContext,
        ) -> anyhow::Result<()> {
            let partial = job.root().join("cuts/v002/partial.mp4");
            fs::create_dir_all(partial.parent().unwrap())?;
            fs::write(partial, b"atomically published checkpoint")?;
            execution.cancel();
            Ok(())
        }
    }

    /// Production mutation caught: invoking Scout before checking the verified
    /// active artifact would make a matching resume provider-dependent.
    #[tokio::test]
    async fn matching_verified_active_plan_reuses_without_invoking_planner() {
        let fixture = fixture();
        let planner = FakePlanner::default();
        let execution = JobExecutionContext::new();

        let verified = MainFootageCoordinator::prepare_with(
            &fixture.job,
            MainFootagePrepareInput {
                imported: &fixture.imported,
                coverage_target: 0.6,
            },
            &fixture.narration,
            &execution,
            &planner,
            &fixture.probe,
        )
        .await
        .unwrap();

        assert_eq!(verified.version(), "v001");
        assert_eq!(planner.calls.load(Ordering::SeqCst), 0);
    }

    /// Production mutation caught: overwriting `v001` or verifying the stale
    /// pointer after narration changes would destroy deterministic resume history.
    #[tokio::test]
    async fn narration_change_publishes_and_verifies_next_version_without_touching_v1() {
        let mut fixture = fixture();
        let v1_before = fs::read(&fixture.plan_path).unwrap();
        let mut narration: Value =
            serde_json::from_slice(&fs::read(fixture.job.narration_timeline()).unwrap()).unwrap();
        narration["words"][0]["text"] = json!("changed");
        let narration_fingerprint = fingerprint_canonical(&narration).unwrap();
        narration["fingerprint"] = Value::String(narration_fingerprint.clone());
        fs::write(
            fixture.job.narration_timeline(),
            serde_json::to_vec_pretty(&narration).unwrap(),
        )
        .unwrap();
        fixture.narration = serde_json::from_value(narration).unwrap();
        let planner = PublishingPlanner {
            calls: AtomicUsize::new(0),
            narration_fingerprint,
        };

        let verified = MainFootageCoordinator::prepare_with(
            &fixture.job,
            MainFootagePrepareInput {
                imported: &fixture.imported,
                coverage_target: 0.6,
            },
            &fixture.narration,
            &JobExecutionContext::new(),
            &planner,
            &fixture.probe,
        )
        .await
        .unwrap();

        assert_eq!(verified.version(), "v002");
        assert_eq!(planner.calls.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read(&fixture.plan_path).unwrap(), v1_before);
    }

    /// Production mutation caught: checking cancellation only before the planner
    /// would let a cancelled run read or record a partial/unverified active plan.
    #[tokio::test]
    async fn cancelled_planning_retains_checkpoints_without_recording_active() {
        let fixture = fixture();
        fs::remove_file(fixture.root.join("plans/active.json")).unwrap();
        let execution = JobExecutionContext::new();

        let error = MainFootageCoordinator::prepare_with(
            &fixture.job,
            MainFootagePrepareInput {
                imported: &fixture.imported,
                coverage_target: 0.6,
            },
            &fixture.narration,
            &execution,
            &CancellingPlanner,
            &fixture.probe,
        )
        .await
        .expect_err("cancellation after a checkpoint must stop before active verification");

        assert!(is_cancelled(&error));
        assert!(fixture.root.join("cuts/v002/partial.mp4").exists());
        assert!(!fixture.root.join("plans/active.json").exists());
    }

    /// Production mutation caught: relaying arbitrary stderr/provider text or
    /// accepting extra terminal strings would leak secrets and destabilize APIs.
    #[test]
    fn planner_stderr_maps_only_the_seven_stable_terminal_codes() {
        use thoth_types::main_footage::MainFootageErrorCode;

        for (wire, expected) in [
            (
                "forced_main_no_usable_video",
                MainFootageErrorCode::ForcedMainNoUsableVideo,
            ),
            (
                "forced_main_narration_required",
                MainFootageErrorCode::ForcedMainNarrationRequired,
            ),
            (
                "source_package_invalid",
                MainFootageErrorCode::SourcePackageInvalid,
            ),
            (
                "narration_generation_failed",
                MainFootageErrorCode::NarrationGenerationFailed,
            ),
            (
                "cut_planning_failed",
                MainFootageErrorCode::CutPlanningFailed,
            ),
            (
                "cut_materialization_exhausted",
                MainFootageErrorCode::CutMaterializationExhausted,
            ),
            (
                "plan_verification_failed",
                MainFootageErrorCode::PlanVerificationFailed,
            ),
        ] {
            let line = json!({
                "stage": "planning_cuts",
                "pct": 0,
                "message": wire,
                "warning": wire
            })
            .to_string();
            assert_eq!(terminal_code_from_stderr_lines([line.as_str()]), expected);
        }

        for line in [
            r#"{"stage":"planning_cuts","pct":0,"message":"Bearer secret","warning":"provider_secret"}"#,
            r#"{"stage":"planning_cuts","pct":0,"message":"cut_planning_failed","warning":"cut_planning_failed","extra":"secret"}"#,
            "https://private.test/?token=secret",
        ] {
            assert_eq!(
                terminal_code_from_stderr_lines([line]),
                MainFootageErrorCode::CutPlanningFailed
            );
        }
    }

    #[test]
    fn planner_wait_errors_preserve_cancellation_and_redact_process_details() {
        let cancelled = planner_process_error(crate::execution::Cancelled.into());
        assert!(is_cancelled(&cancelled));

        let mapped = planner_process_error(anyhow::anyhow!(
            "provider secret at C:/private/signed-response.json"
        ));
        let mapped = mapped
            .downcast_ref::<crate::main_footage::MainFootageError>()
            .expect("non-cancellation process errors must use a stable terminal error");
        assert_eq!(
            mapped.code,
            thoth_types::main_footage::MainFootageErrorCode::CutPlanningFailed
        );
        assert_eq!(mapped.detail, "planner_process_failed");
    }
}
