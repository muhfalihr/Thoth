use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use thoth_core::util::progress::ProgressEvent;

use crate::auth::AppState;
use crate::job::{JobRecord, JobStatus, SseEvent};

/// Live handle for a running job: SSE fan-out + cancellation.
#[derive(Clone)]
pub struct JobHandle {
    pub tx: tokio::sync::broadcast::Sender<SseEvent>,
    pub cancel: CancellationToken,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Build the worker argv from a JobRecord (command + params → flags).
fn worker_args(rec: &JobRecord) -> Vec<String> {
    let mut args = vec![rec.spec.command.clone(), "--progress-json".to_owned()];
    if let Some(u) = &rec.spec.url {
        args.push("--url".to_owned());
        args.push(u.clone());
    }
    if let Some(c) = &rec.spec.content_set {
        args.push("--content".to_owned());
        args.push(c.clone());
    }
    args.push("--output".to_owned());
    args.push(rec.output_dir.clone());
    // Flatten flat string/number params into `--key value`.
    if let Some(map) = rec.spec.params.as_object() {
        for (k, v) in map {
            args.push(format!("--{k}"));
            if let Some(s) = v.as_str() {
                args.push(s.to_owned());
            } else {
                args.push(v.to_string());
            }
        }
    }
    args
}

/// Spawn the worker and drive its lifecycle in a background task.
///
/// Inserts the `JobHandle` into `state.jobs` synchronously before spawning
/// the background task, so that once this function returns, callers (and
/// tests) are guaranteed to find the handle and can subscribe without a
/// subscribe-vs-first-event race.
pub async fn spawn_job(state: AppState, mut rec: JobRecord) {
    let (tx, _rx) = tokio::sync::broadcast::channel::<SseEvent>(256);
    let cancel = CancellationToken::new();
    let handle = JobHandle { tx: tx.clone(), cancel: cancel.clone() };

    state.jobs.lock().await.insert(rec.id.clone(), handle);

    let jobs = state.jobs.clone();
    let store = state.store.clone();
    let worker = state.worker_bin.clone();

    tokio::spawn(async move {
        rec.status = JobStatus::Running;
        rec.updated_at = now();
        let _ = store.put(&rec);

        let mut child = match Command::new(&worker)
            .args(worker_args(&rec))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                fail(&store, &tx, &mut rec, &format!("spawn worker failed: {e}"));
                jobs.lock().await.remove(&rec.id);
                return;
            }
        };

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let mut out_lines = BufReader::new(stdout).lines();
        let mut err_lines = BufReader::new(stderr).lines();

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.start_kill();
                    fail(&store, &tx, &mut rec, "cancelled");
                    break;
                }
                line = out_lines.next_line() => {
                    match line {
                        Ok(Some(l)) => {
                            // stdout = structured progress NDJSON
                            match serde_json::from_str::<ProgressEvent>(&l) {
                                Ok(ev) => {
                                    rec.stage = Some(ev.stage.clone());
                                    rec.pct = ev.pct;
                                    rec.updated_at = now();
                                    let _ = store.put(&rec);
                                    let _ = tx.send(SseEvent {
                                        kind: "progress".into(),
                                        job_id: rec.id.clone(),
                                        stage: Some(ev.stage),
                                        pct: Some(ev.pct),
                                        message: Some(ev.message),
                                        ts: ev.ts,
                                    });
                                }
                                Err(_) => tracing::warn!("bad progress line dropped: {l}"),
                            }
                        }
                        Ok(None) => break, // stdout closed → worker exiting
                        Err(e) => { tracing::warn!("stdout read error: {e}"); break; }
                    }
                }
                line = err_lines.next_line() => {
                    if let Ok(Some(l)) = line {
                        let _ = tx.send(SseEvent {
                            kind: "log".into(),
                            job_id: rec.id.clone(),
                            stage: None, pct: None,
                            message: Some(l), ts: now(),
                        });
                    }
                }
            }
        }

        // Reap and set terminal status (unless cancel already set it).
        if rec.status == JobStatus::Running {
            match child.wait().await {
                Ok(s) if s.success() => {
                    rec.status = JobStatus::Succeeded;
                    rec.pct = 1.0;
                    rec.updated_at = now();
                    let _ = store.put(&rec);
                    let _ = tx.send(SseEvent {
                        kind: "done".into(), job_id: rec.id.clone(),
                        stage: rec.stage.clone(), pct: Some(1.0),
                        message: None, ts: now(),
                    });
                }
                Ok(s) => fail(&store, &tx, &mut rec, &format!("worker exited: {s}")),
                Err(e) => fail(&store, &tx, &mut rec, &format!("wait failed: {e}")),
            }
        }

        jobs.lock().await.remove(&rec.id);
    });
}

fn fail(
    store: &crate::store::JobStore,
    tx: &tokio::sync::broadcast::Sender<SseEvent>,
    rec: &mut JobRecord,
    msg: &str,
) {
    rec.status = JobStatus::Failed;
    rec.error = Some(msg.to_owned());
    rec.updated_at = now();
    let _ = store.put(rec);
    let _ = tx.send(SseEvent {
        kind: "error".into(),
        job_id: rec.id.clone(),
        stage: rec.stage.clone(),
        pct: None,
        message: Some(msg.to_owned()),
        ts: now(),
    });
}
