//! The persistent warm worker: an independent peer to `thoth-server` that pulls
//! queued jobs from the shared SQLite queue and runs them in-process, so CUDA /
//! Whisper models stay resident between jobs. No parent/child link to the
//! server — they communicate solely through the DB (job rows + `job_events`).

use std::{sync::Arc, time::Duration};

use crate::config::AppConfig;
use crate::execution::{is_cancelled, JobExecutionContext};
use thoth_jobs::{validate_job_spec, JobRecord, JobStatus, JobStore};

/// The claim loop. Runs forever: atomically claim the oldest queued job, run it,
/// repeat. Backs off (250ms → 2s) while the queue is empty so an idle worker
/// isn't hot-spinning the DB.
pub async fn run_worker(db_path: &str) -> anyhow::Result<()> {
    let store = JobStore::connect(db_path).await?;
    let worker_id = uuid::Uuid::new_v4().to_string();
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
    config: AppConfig,
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
    let cancel = context.cancellation_token();
    crate::run_once(args, config, &cancel).await
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

    // Progress sink: every emit_stage → a job_events "progress" row + a progress
    // column update. Fire-and-forget spawns so the pipeline never blocks on the
    // DB. ponytail: global sink is fine — a worker runs one job at a time.
    let s = store.clone();
    let jid = id.clone();
    crate::util::progress::set_sink(Box::new(move |ev| {
        let s = s.clone();
        let jid = jid.clone();
        tokio::spawn(async move {
            let _ = s.update_progress(&jid, &ev.stage, ev.pct).await;
            let _ = s
                .append_event(
                    &jid,
                    "progress",
                    Some(&ev.stage),
                    Some(ev.pct),
                    Some(&ev.message),
                )
                .await;
        });
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
    watcher.abort();
    let _ = watcher.await;
    hb.abort();
    let _ = hb.await;
    context.terminate_all().await;

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

    // Idle the sink between jobs (worker never uses stdout NDJSON).
    crate::util::progress::set_sink(Box::new(|_| {}));
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
    use thoth_jobs::{JobSpec, JobStatus, JobStore};

    async fn store_with_claimed_job() -> (std::path::PathBuf, JobStore, String, JobRecord) {
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
        (dir, store, id, job)
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
        let (dir, store, id, job) = store_with_claimed_job().await;
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

    #[test]
    fn pick_config_prefers_fresh_else_prev() {
        assert_eq!(pick_config::<i32>(Ok(2), &1), 2);
        assert_eq!(pick_config::<i32>(Err(anyhow::anyhow!("boom")), &1), 1);
    }

    #[tokio::test]
    async fn database_cancellation_cancels_live_context() {
        use std::time::{Duration, Instant};
        use tokio::sync::oneshot;

        let (dir, store, id, job) = store_with_claimed_job().await;
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
        let (dir, store, id, job) = store_with_claimed_job().await;

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

        let (dir, store, id, job) = store_with_claimed_job().await;
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
        assert!(store.get(&id).await.unwrap().unwrap().status.is_terminal());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn failed_run_marks_failed_and_emits_one_error() {
        let (dir, store, id, job) = store_with_claimed_job().await;
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
