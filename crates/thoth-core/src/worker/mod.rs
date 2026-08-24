//! The persistent warm worker: an independent peer to `thoth-server` that pulls
//! queued jobs from the shared SQLite queue and runs them in-process, so CUDA /
//! Whisper models stay resident between jobs. No parent/child link to the
//! server — they communicate solely through the DB (job rows + `job_events`).

use std::{sync::Arc, time::Duration};

use anyhow::Context;

use crate::config::AppConfig;
use crate::execution::{is_cancelled, JobExecutionContext};
use thoth_jobs::{validate_job_spec, JobRecord, JobStatus, JobStore};

/// The claim loop. Runs forever: atomically claim the oldest queued job, run it,
/// repeat. Backs off (250ms → 2s) while the queue is empty so an idle worker
/// isn't hot-spinning the DB.
pub async fn run_worker(db_path: &str) -> anyhow::Result<()> {
    let store = JobStore::connect(db_path).await?;
    let worker_id = uuid::Uuid::new_v4().to_string();
    let worker_config_path = std::env::current_dir()?.join("config.toml");
    let scout_output_config = thoth_jobs::ScoutOutputConfig::new(worker_config_path)?;
    // Config is re-read per job (below) so dashboard edits apply without a
    // worker restart. The warm CUDA/Whisper models live in the process, not in
    // AppConfig, so re-parsing settings each job is cheap.
    let mut config = AppConfig::load()?;
    tracing::info!("worker {worker_id} online, db={db_path}");

    let mut backoff = Duration::from_millis(250);
    loop {
        match store.claim_next(&worker_id).await? {
            None => {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(2));
            }
            Some(job) => {
                backoff = Duration::from_millis(250);
                config = pick_config(AppConfig::load(), &config);
                config.scout.output_dir = scout_output_config.resolve();
                let cfg = config.clone();
                run_one(&store, &worker_id, job, move |j, context| {
                    execute_pipeline((*j).clone(), cfg, context)
                })
                .await;
            }
        }
    }
}

/// Bridge a claimed job to the real pipeline. Rebuilds the same argv a CLI
/// `thoth run` user would type so every `RunArgs` default is populated by clap
/// (no fragile 20-field struct literal that drifts when a flag is added).
async fn execute_pipeline(
    job: JobRecord,
    mut config: AppConfig,
    context: JobExecutionContext,
) -> anyhow::Result<()> {
    use clap::Parser;

    validate_job_spec(&job.spec).map_err(|error| {
        anyhow::anyhow!(
            "invalid job specification at {}: {}",
            error.field,
            error.message
        )
    })?;

    // `run` is the only job kind the queue drives. Fail loudly rather than
    // silently running some other command's job as a `run` (create_job accepts
    // any JobSpec.command string — this is the trust-boundary guard).
    if job.spec.command != "run" {
        anyhow::bail!("unsupported job command: {}", job.spec.command);
    }

    let home = thoth_jobs::resolve_home(None)?;
    apply_runtime_narration_settings(
        &mut config,
        job.resolved_settings_snapshot.as_ref(),
        &job.spec.params,
        &home,
    )?;

    let mut argv: Vec<String> = vec!["thoth-run".into()];
    if let Some(url) = &job.spec.url {
        argv.push(url.clone()); // positional url
    }
    if let Some(cs) = &job.spec.content_set {
        argv.push("--content".into());
        argv.push(cs.clone());
    }
    argv.push("--output-dir".into());
    argv.push(job.output_dir.clone());
    argv.push("--job-id".into());
    argv.push(job.id.clone());
    push_params(&mut argv, &job.spec.params);

    let args = crate::cli::RunArgs::try_parse_from(&argv)?;
    crate::run_once(args, config, &context).await
}

/// Apply only the narration fields that participate in the forced-mode gate.
/// A stored profile snapshot is decoded through the strict typed contract and
/// revalidated before any runtime field is mutated. The unprofiled endpoint has
/// no snapshot, so its already-validated boolean parameter maps to the same
/// field. Missing values preserve the worker's CLI/TOML configuration.
fn apply_runtime_narration_settings(
    config: &mut AppConfig,
    snapshot: Option<&serde_json::Value>,
    params: &serde_json::Value,
    home: &thoth_jobs::ThothHome,
) -> anyhow::Result<()> {
    if let Some(snapshot) = snapshot {
        let resolved = decode_resolved_settings_snapshot(snapshot)?;
        thoth_jobs::validate_resolved_settings(&resolved, home)
            .context("resolved settings snapshot failed validation")?;
        let enabled = resolved.narration.enabled;
        let language = resolved.narration.language;
        config.narration.enabled = enabled;
        if let Some(language) = language {
            config.narration.language = language;
        }
        return Ok(());
    }

    if let Some(enabled) = params
        .get("narration_enabled")
        .and_then(serde_json::Value::as_bool)
    {
        config.narration.enabled = enabled;
    }
    Ok(())
}

fn decode_resolved_settings_snapshot(
    snapshot: &serde_json::Value,
) -> anyhow::Result<thoth_jobs::ResolvedSettings> {
    let mut settings = snapshot.clone();
    let object = settings
        .as_object_mut()
        .context("resolved settings snapshot is invalid")?;
    if let Some(credential_ref) = object.remove("credential_ref") {
        let _: Option<String> = serde_json::from_value(credential_ref)
            .context("resolved settings snapshot credential reference is invalid")?;
    }
    serde_json::from_value(settings).context("resolved settings snapshot is invalid")
}

/// One claim's lifecycle: install a DB progress sink, run `run_fn`, record the
/// terminal state + a closing event. `run_fn` is injected so tests can stub the
/// pipeline. This is where all the DB bookkeeping the fully-decoupled design
/// needs (progress rows, heartbeat, terminal status) lives.
pub async fn run_one<F, Fut>(store: &JobStore, _worker_id: &str, job: JobRecord, run_fn: F)
where
    F: FnOnce(Arc<JobRecord>, JobExecutionContext) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let id = job.id.clone();
    let context = JobExecutionContext::new();
    let cancellation = context.cancellation_token();

    // Progress sink: every emit_stage is synchronously enqueued, then one
    // per-job writer persists the progress column and event row in emission
    // order. The worker runs one job at a time, so the global sink remains a
    // single-slot bridge without making pipeline stages wait on SQLite.
    let s = store.clone();
    let jid = id.clone();
    let (progress_tx, mut progress_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::util::progress::ProgressEvent>();
    let progress_writer = tokio::spawn(async move {
        while let Some(ev) = progress_rx.recv().await {
            if let Err(error) = s.update_progress(&jid, &ev.stage, ev.pct).await {
                tracing::error!(job_id = %jid, %error, "progress update failed");
            }
            if let Err(error) = s
                .append_event(
                    &jid,
                    "progress",
                    Some(&ev.stage),
                    Some(ev.pct),
                    Some(&ev.message),
                )
                .await
            {
                tracing::error!(job_id = %jid, %error, "progress event append failed");
            }
        }
    });
    crate::util::progress::set_sink(Box::new(move |ev| {
        let _ = progress_tx.send(ev);
    }));

    // Heartbeat while running — the reaper fails jobs whose worker went silent.
    let hb_store = store.clone();
    let hb_id = id.clone();
    let hb = tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(5));
        loop {
            t.tick().await;
            let _ = hb_store.heartbeat(&hb_id).await;
        }
    });

    // The database is the worker's control plane. Poll it independently from
    // the pipeline so a request issued by another process reaches this job's
    // live cancellation token without requiring the pipeline to touch SQLite.
    let watch_store = store.clone();
    let watch_id = id.clone();
    let watch_token = cancellation.clone();
    let watcher = tokio::spawn(async move {
        loop {
            match watch_store.is_cancel_requested(&watch_id).await {
                Ok(true) => {
                    watch_token.cancel();
                    break;
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(job_id = %watch_id, %error, "cancellation watcher query failed");
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });

    let result = run_fn(Arc::new(job), context.clone()).await;
    // Closing the only sender lets the writer drain every stage already
    // emitted. No progress event can be accepted after this job completes.
    crate::util::progress::set_sink(Box::new(|_| {}));
    watcher.abort();
    let _ = watcher.await;

    // This final read linearizes cancellation against pipeline completion: a
    // `RunningRequested` committed before it is observed wins and cancels this
    // context. A request committed later competes with `finish_running`'s
    // terminal CAS under the store's normal semantics.
    match store.is_cancel_requested(&id).await {
        Ok(true) => context.cancel(),
        Ok(false) => {}
        Err(error) => {
            tracing::error!(job_id = %id, %error, "final cancellation observation failed");
        }
    }

    hb.abort();
    let _ = hb.await;
    context.terminate_all().await;
    if let Err(error) = progress_writer.await {
        tracing::error!(job_id = %id, %error, "progress writer failed");
    }

    let (status, event_kind, detail) = match result {
        Ok(()) if cancellation.is_cancelled() => (JobStatus::Cancelled, "cancelled", None),
        Ok(()) => (JobStatus::Succeeded, "done", None),
        Err(error) if is_cancelled(&error) || cancellation.is_cancelled() => {
            (JobStatus::Cancelled, "cancelled", None)
        }
        Err(e) => (JobStatus::Failed, "error", Some(e.to_string())),
    };
    match store
        .finish_running(
            &id,
            status,
            detail.as_deref(),
            event_kind,
            detail.as_deref(),
        )
        .await
    {
        Ok(true) => {}
        Ok(false) => tracing::warn!(job_id = %id, "job finalization lost status race"),
        Err(error) => tracing::error!(job_id = %id, %error, "job finalization failed"),
    }
}

/// Translate a job's `spec.params` JSON into `thoth run` CLI flags, appended to
/// `argv`. Only known keys are mapped (unknown ignored — forward-compat); the
/// `extra_args` array is appended verbatim as an escape hatch for any flag not
/// surfaced here. Flag names MUST match `RunArgs` (cli.rs) — the unit test
/// round-trips through `RunArgs::try_parse_from` to catch drift.
fn push_params(argv: &mut Vec<String>, params: &serde_json::Value) {
    let scalar = |v: &serde_json::Value| -> Option<String> {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_i64().map(|n| n.to_string()))
            .or_else(|| v.as_f64().map(|n| n.to_string()))
    };
    if let Some(object) = params.as_object() {
        for (key, value) in object {
            if let (Some(flag), Some(value)) = (thoth_jobs::scalar_param_flag(key), scalar(value)) {
                if !value.is_empty() {
                    argv.push(flag.to_string());
                    argv.push(value);
                }
            }
        }
    }
    // keywords: string[] → repeated --keywords <value>
    if let Some(arr) = params.get("keywords").and_then(|v| v.as_array()) {
        for keyword in arr.iter().filter_map(|v| v.as_str()) {
            if !keyword.is_empty() {
                argv.push("--keywords".to_string());
                argv.push(keyword.to_string());
            }
        }
    }
    // extra_args: string[] appended verbatim (escape hatch for any other flag).
    if let Some(arr) = params.get("extra_args").and_then(|v| v.as_array()) {
        for a in arr.iter().filter_map(|v| v.as_str()) {
            argv.push(a.to_string());
        }
    }
}

/// Pick the config for the next job: prefer a fresh load, else fall back to the
/// last good config (never fail a job because the operator saved a mid-edit
/// config.toml). Generic so the fallback branch is unit-testable without
/// constructing an AppConfig.
fn pick_config<T: Clone>(loaded: anyhow::Result<T>, prev: &T) -> T {
    match loaded {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!("config reload failed, using last good config: {e}");
            prev.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use thoth_jobs::{EnqueueRequest, JobSpec, JobStatus, JobStore, ResolvedSettings};

    fn runtime_config() -> AppConfig {
        AppConfig::load().expect("runtime config")
    }

    fn settings_home() -> thoth_jobs::ThothHome {
        let root = std::env::temp_dir().join(format!("thoth-worker-home-{}", uuid::Uuid::new_v4()));
        thoth_jobs::resolve_home(Some(&root)).expect("test home")
    }

    /// Production mutation caught: ignoring the enqueue-time snapshot would let
    /// the worker's mutable config disagree with the forced-mode narration gate.
    #[test]
    fn resolved_snapshot_wins_and_applies_narration_language_before_execution() {
        let mut config = runtime_config();
        config.narration.enabled = false;
        config.narration.language = "id".into();
        let mut snapshot = ResolvedSettings::default();
        snapshot.narration.enabled = true;
        snapshot.narration.language = Some("en-US".into());

        apply_runtime_narration_settings(
            &mut config,
            Some(&serde_json::to_value(snapshot).unwrap()),
            &serde_json::json!({ "narration_enabled": false }),
            &settings_home(),
        )
        .unwrap();

        assert!(config.narration.enabled);
        assert_eq!(config.narration.language, "en-US");
    }

    #[tokio::test]
    async fn enqueued_resolved_snapshot_applies_runtime_narration_settings() {
        let dir = std::env::temp_dir().join(format!(
            "thoth-worker-resolved-snapshot-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = JobStore::connect(dir.join("jobs.db").to_str().unwrap())
            .await
            .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut settings = ResolvedSettings::default();
        settings.narration.enabled = true;
        settings.narration.language = Some("en-US".into());
        store
            .enqueue_resolved(
                &id,
                &EnqueueRequest {
                    spec: JobSpec {
                        command: "run".into(),
                        url: Some("https://example.invalid/video".into()),
                        content_set: None,
                        params: serde_json::json!({}),
                    },
                    project_id: "project-1".into(),
                    profile_id: Some("profile-1".into()),
                    profile_revision: Some(1),
                    override_summary: None,
                    resolved_settings: settings,
                },
                "job-output",
            )
            .await
            .unwrap();

        let claimed = store.claim_next("worker-1").await.unwrap().unwrap();
        let snapshot = claimed.resolved_settings_snapshot.unwrap();
        assert!(snapshot.get("credential_ref").is_some());
        let mut config = runtime_config();
        config.narration.enabled = false;
        config.narration.language = "id".into();

        apply_runtime_narration_settings(
            &mut config,
            Some(&snapshot),
            &claimed.spec.params,
            &settings_home(),
        )
        .unwrap();

        assert!(config.narration.enabled);
        assert_eq!(config.narration.language, "en-US");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Production mutation caught: the profile-less endpoint validates this
    /// boolean, so dropping it in the worker would pass enqueue and fail runtime.
    #[test]
    fn profile_less_narration_parameter_maps_to_the_same_runtime_field() {
        let mut config = runtime_config();
        config.narration.enabled = false;

        apply_runtime_narration_settings(
            &mut config,
            None,
            &serde_json::json!({ "narration_enabled": true }),
            &settings_home(),
        )
        .unwrap();

        assert!(config.narration.enabled);
    }

    #[test]
    fn absent_snapshot_and_parameter_preserve_legacy_runtime_configuration() {
        let mut config = runtime_config();
        config.narration.enabled = false;
        config.narration.language = "jv".into();

        apply_runtime_narration_settings(
            &mut config,
            None,
            &serde_json::json!({}),
            &settings_home(),
        )
        .unwrap();

        assert!(!config.narration.enabled);
        assert_eq!(config.narration.language, "jv");
    }

    #[test]
    fn malformed_or_unvalidated_snapshot_is_rejected_without_partial_application() {
        let mut config = runtime_config();
        config.narration.enabled = false;
        let invalid = serde_json::json!({
            "narration": { "enabled": true },
            "analysis": { "max_clips": 0 }
        });

        assert!(
            apply_runtime_narration_settings(
                &mut config,
                Some(&invalid),
                &serde_json::json!({}),
                &settings_home(),
            )
            .is_err()
        );
        assert!(!config.narration.enabled);
    }

    /// Every caller drives `run_one`, which installs the process-wide progress
    /// sink. Handing back the sink guard makes that serialization impossible to
    /// forget: without it a concurrent `pipeline` test replaces the sink
    /// mid-run and this job's stages are persisted nowhere.
    async fn store_with_claimed_job() -> (
        std::sync::MutexGuard<'static, ()>,
        std::path::PathBuf,
        JobStore,
        String,
        JobRecord,
    ) {
        let sink_guard = crate::util::progress::lock_sink_for_test();
        let dir = std::env::temp_dir().join(format!("thoth-wrk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = JobStore::connect(dir.join("t.db").to_str().unwrap())
            .await
            .unwrap();
        let spec = JobSpec {
            command: "run".into(),
            url: Some("u".into()),
            content_set: None,
            params: serde_json::json!({}),
        };
        let id = uuid::Uuid::new_v4().to_string();
        store.enqueue(&id, &spec, "out/j").await.unwrap();
        let job = store.claim_next("w1").await.unwrap().unwrap();
        (sink_guard, dir, store, id, job)
    }

    #[test]
    fn push_params_maps_known_keys_and_parses() {
        use clap::Parser;
        let params = serde_json::json!({
            "provider": "novita",
            "max_clips": 3,
            "layout": "vertical",
            "keywords": ["prabowo", "AI"],
            "bgm_volume": 0.2,
            "style_profile": "tiktok_id_2025",
            "extra_args": ["--social-icon", "x.png"]
        });
        let mut argv = vec![
            "thoth-run".to_string(),
            "https://x.test".to_string(),
            "--output-dir".to_string(),
            "out".to_string(),
            "--job-id".to_string(),
            "id1".to_string(),
        ];
        push_params(&mut argv, &params);
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--provider" && w[1] == "novita"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--max-clips" && w[1] == "3"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--layout" && w[1] == "vertical"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--keywords" && w[1] == "prabowo"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--keywords" && w[1] == "AI"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--style-profile" && w[1] == "tiktok_id_2025"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--social-icon" && w[1] == "x.png"));
        // The whole argv must still parse as RunArgs — guards flag-name drift.
        crate::cli::RunArgs::try_parse_from(&argv).expect("params argv must parse as RunArgs");
    }

    #[tokio::test]
    async fn claim_run_marks_succeeded_and_emits_done() {
        let (_sink_guard, dir, store, id, job) = store_with_claimed_job().await;
        run_one(&store, "w1", job, |_j, _ctx| async { Ok(()) }).await; // stub pipeline

        assert_eq!(
            store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Succeeded
        );
        let events = store.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "done");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn production_progress_is_persisted_in_order_before_the_terminal_event() {
        let (_sink_guard, dir, store, id, job) = store_with_claimed_job().await;
        let vocabulary = [
            "importing_sources",
            "validating_scene_index",
            "generating_narration",
            "planning_cuts",
            "materializing_cuts",
            "verifying_plan",
            "rendering",
        ];
        let expected: Vec<String> = (0..64)
            .map(|index| vocabulary[index % vocabulary.len()].to_owned())
            .collect();
        let emitted = expected.clone();

        run_one(&store, "w1", job, move |_j, _ctx| async move {
            for (index, stage) in emitted.iter().enumerate() {
                crate::util::progress::emit_stage(
                    stage,
                    index as f32 / emitted.len() as f32,
                    "safe progress",
                );
            }
            Ok(())
        })
        .await;

        let at_return = store.events_since(&id, 0).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let after_settle = store.events_since(&id, 0).await.unwrap();
        assert_eq!(
            after_settle.len(),
            at_return.len(),
            "writes continued after run_one returned"
        );
        assert_eq!(after_settle.last().unwrap().kind, "done");
        assert_eq!(
            after_settle
                .iter()
                .filter(|event| event.kind == "progress")
                .filter_map(|event| event.stage.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(after_settle.len(), expected.len() + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pick_config_prefers_fresh_else_prev() {
        assert_eq!(pick_config::<i32>(Ok(2), &1), 2);
        assert_eq!(pick_config::<i32>(Err(anyhow::anyhow!("boom")), &1), 1);
    }

    #[tokio::test]
    async fn database_cancellation_cancels_live_context() {
        use std::time::{Duration, Instant};
        use tokio::sync::oneshot;

        let (_sink_guard, dir, store, id, job) = store_with_claimed_job().await;
        let cancelling_store = JobStore::connect(dir.join("t.db").to_str().unwrap())
            .await
            .unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let cancelling_id = id.clone();
        let cancel = tokio::spawn(async move {
            started_rx.await.unwrap();
            cancelling_store
                .request_cancel(&cancelling_id)
                .await
                .unwrap();
        });

        let started = Instant::now();
        run_one(&store, "w1", job, move |_j, ctx| async move {
            started_tx.send(()).unwrap();
            ctx.cancellation_token().cancelled().await;
            ctx.check_cancelled()
        })
        .await;
        cancel.await.unwrap();

        assert_eq!(
            store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Cancelled
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let events = store.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "cancelled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancellation_text_without_a_cancelled_context_marks_failed() {
        let (_sink_guard, dir, store, id, job) = store_with_claimed_job().await;

        run_one(&store, "w1", job, |_j, _ctx| async {
            anyhow::bail!("cancelled by upstream text")
        })
        .await;

        assert_eq!(
            store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Failed
        );
        let events = store.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn completion_and_cancellation_race_emits_one_terminal_event() {
        use thoth_jobs::CancelRequestOutcome;
        use tokio::sync::oneshot;

        let (_sink_guard, dir, store, id, job) = store_with_claimed_job().await;
        let cancelling_store = JobStore::connect(dir.join("t.db").to_str().unwrap())
            .await
            .unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let cancelling_id = id.clone();
        let cancel = tokio::spawn(async move {
            started_rx.await.unwrap();
            let outcome = cancelling_store
                .request_cancel(&cancelling_id)
                .await
                .unwrap();
            assert_eq!(outcome, CancelRequestOutcome::RunningRequested);
            finish_tx.send(()).unwrap();
        });

        run_one(&store, "w1", job, move |_j, _ctx| async move {
            started_tx.send(()).unwrap();
            finish_rx.await.unwrap();
            Ok(())
        })
        .await;
        cancel.await.unwrap();

        let events = store.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Cancelled
        );
        assert_eq!(events[0].kind, "cancelled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn failed_run_marks_failed_and_emits_one_error() {
        let (_sink_guard, dir, store, id, job) = store_with_claimed_job().await;
        run_one(&store, "w1", job, |_j, _ctx| async {
            anyhow::bail!("pipeline failed")
        })
        .await;

        assert_eq!(
            store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Failed
        );
        let events = store.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "error");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
