//! The persistent warm worker: an independent peer to `thoth-server` that pulls
//! queued jobs from the shared SQLite queue and runs them in-process, so CUDA /
//! Whisper models stay resident between jobs. No parent/child link to the
//! server — they communicate solely through the DB (job rows + `job_events`).

use std::time::Duration;

use crate::config::AppConfig;
use thoth_jobs::{JobRecord, JobStatus, JobStore};
use tokio_util::sync::CancellationToken;

/// The claim loop. Runs forever: atomically claim the oldest queued job, run it,
/// repeat. Backs off (250ms → 2s) while the queue is empty so an idle worker
/// isn't hot-spinning the DB.
pub async fn run_worker(db_path: &str) -> anyhow::Result<()> {
    let store = JobStore::connect(db_path).await?;
    let worker_id = uuid::Uuid::new_v4().to_string();
    // Config is loaded once and cloned per job — models/warm state live in the
    // process, not in AppConfig (which is just parsed settings).
    let config = AppConfig::load()?;
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
                let cfg = config.clone();
                // Clone the job into the future so nothing borrowed from `&job`
                // has to outlive the closure (the FnOnce(&JobRecord)->Fut seam
                // can't express a borrowing future via a single Fut type param).
                run_one(&store, &worker_id, job, move |j| {
                    execute_pipeline((*j).clone(), cfg)
                })
                .await;
            }
        }
    }
}

/// Bridge a claimed job to the real pipeline. Rebuilds the same argv a CLI
/// `thoth run` user would type so every `RunArgs` default is populated by clap
/// (no fragile 20-field struct literal that drifts when a flag is added).
async fn execute_pipeline(job: JobRecord, config: AppConfig) -> anyhow::Result<()> {
    use clap::Parser;

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
    // ponytail: spec.params is always {} from the server today; map its keys to
    // flags here if/when the REST API grows typed run knobs.

    let args = crate::cli::RunArgs::try_parse_from(&argv)?;
    let cancel = CancellationToken::new();
    crate::run_once(args, config, &cancel).await
}

/// One claim's lifecycle: install a DB progress sink, run `run_fn`, record the
/// terminal state + a closing event. `run_fn` is injected so tests can stub the
/// pipeline. This is where all the DB bookkeeping the fully-decoupled design
/// needs (progress rows, heartbeat, terminal status) lives.
pub async fn run_one<F, Fut>(store: &JobStore, _worker_id: &str, job: JobRecord, run_fn: F)
where
    F: FnOnce(&JobRecord) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let id = job.id.clone();

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
                .append_event(&jid, "progress", Some(&ev.stage), Some(ev.pct), Some(&ev.message))
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

    let result = run_fn(&job).await;
    hb.abort();

    match result {
        Ok(()) => {
            let _ = store.finish(&id, JobStatus::Succeeded, None).await;
            let _ = store.append_event(&id, "done", None, Some(1.0), None).await;
        }
        Err(e)
            if store.is_cancel_requested(&id).await.unwrap_or(false)
                || e.to_string().contains("cancelled") =>
        {
            let _ = store.finish(&id, JobStatus::Cancelled, Some("cancelled")).await;
            let _ = store.append_event(&id, "error", None, None, Some("cancelled")).await;
        }
        Err(e) => {
            let msg = e.to_string();
            let _ = store.finish(&id, JobStatus::Failed, Some(&msg)).await;
            let _ = store.append_event(&id, "error", None, None, Some(&msg)).await;
        }
    }

    // Idle the sink between jobs (worker never uses stdout NDJSON).
    crate::util::progress::set_sink(Box::new(|_| {}));
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

    #[tokio::test]
    async fn claim_run_marks_succeeded_and_emits_done() {
        let (dir, store, id, job) = store_with_claimed_job().await;
        run_one(&store, "w1", job, |_j| async { Ok(()) }).await; // stub pipeline

        assert_eq!(store.get(&id).await.unwrap().unwrap().status, JobStatus::Succeeded);
        assert!(store
            .events_since(&id, 0)
            .await
            .unwrap()
            .iter()
            .any(|e| e.kind == "done"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_flag_ends_cancelled() {
        let (dir, store, id, job) = store_with_claimed_job().await;
        store.request_cancel(&id).await.unwrap();
        // Stub runner errors "cancelled" as the real pipeline would on the token.
        run_one(&store, "w1", job, |_j| async { anyhow::bail!("cancelled") }).await;

        assert_eq!(store.get(&id).await.unwrap().unwrap().status, JobStatus::Cancelled);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
