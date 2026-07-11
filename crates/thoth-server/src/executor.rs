use std::collections::VecDeque;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// How many trailing stderr lines to keep for failure diagnostics.
const STDERR_TAIL_LINES: usize = 20;

use thoth_types::ProgressEvent;

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
///
/// Shapes the argv for `thoth run` exactly as its clap parser expects
/// (`crates/thoth-core/src/cli.rs::RunArgs`): the URL is a POSITIONAL arg (no
/// `--url` flag), the content-set is `--content`, and the output dir is
/// `--output-dir`. Phase 1 drives only `run`; other commands' arg shapes differ.
fn worker_args(rec: &JobRecord) -> Vec<String> {
    let mut args = vec![rec.spec.command.clone(), "--progress-json".to_owned()];
    if let Some(c) = &rec.spec.content_set {
        args.push("--content".to_owned());
        args.push(c.clone());
    }
    args.push("--output-dir".to_owned());
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
    // URL is positional on `thoth run` — push it last, after all flags.
    if let Some(u) = &rec.spec.url {
        args.push(u.clone());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{JobSpec, JobStatus};

    fn rec_with(url: Option<&str>, content: Option<&str>) -> JobRecord {
        JobRecord {
            id: "j".into(),
            spec: JobSpec {
                command: "run".into(),
                url: url.map(str::to_owned),
                content_set: content.map(str::to_owned),
                params: serde_json::json!({}),
            },
            status: JobStatus::Queued,
            stage: None,
            pct: 0.0,
            error: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            output_dir: "out/j".into(),
        }
    }

    #[test]
    fn worker_args_matches_thoth_run_cli_contract() {
        // Regression: url is positional (NOT --url), output is --output-dir.
        // A drift here clap-errors the real worker and fails every run job.
        let args = worker_args(&rec_with(Some("https://x/y"), None));
        assert_eq!(
            args,
            vec![
                "run",
                "--progress-json",
                "--output-dir",
                "out/j",
                "https://x/y", // positional, last
            ]
        );
        assert!(!args.iter().any(|a| a == "--url"), "no --url flag exists");
        assert!(!args.iter().any(|a| a == "--output"), "flag is --output-dir");

        // content-set variant uses --content.
        let c = worker_args(&rec_with(None, Some("set.json")));
        assert_eq!(c, vec!["run", "--progress-json", "--content", "set.json", "--output-dir", "out/j"]);
    }
}

/// Spawn the worker and drive its lifecycle in a background task.
///
/// Inserts the `JobHandle` into `state.jobs` synchronously before spawning
/// the background task, and returns a `broadcast::Receiver` created *before*
/// the task starts. Because tokio `broadcast` does not replay past events,
/// returning this pre-subscribed receiver is what guarantees the caller
/// observes every event — including the terminal `done`/`error` — even for a
/// job that finishes before the caller would otherwise subscribe. Later
/// subscribers (reconnects) use the handle in `state.jobs` plus a `JobStore`
/// snapshot to recover terminal state.
pub async fn spawn_job(
    state: AppState,
    mut rec: JobRecord,
) -> tokio::sync::broadcast::Receiver<SseEvent> {
    let (tx, rx) = tokio::sync::broadcast::channel::<SseEvent>(256);
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

        // Bounded tail of the worker's stderr, surfaced on failure.
        let mut err_tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_LINES);
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut cancelled = false;

        // Drain BOTH streams until EOF so trailing stderr isn't lost before the
        // exit status is read. Each branch is fused off (`if !*_done`) once its
        // stream ends, so a finished stream can't hot-spin the select.
        while !(stdout_done && stderr_done) {
            tokio::select! {
                _ = cancel.cancelled() => {
                    // Kill the whole worker PROCESS TREE, not just thoth.exe —
                    // a run spawns ffmpeg (NVENC), whisper, python, bun as
                    // children that `start_kill` alone would orphan (spec §5.8
                    // "process group"). Windows has no tokio process-group kill,
                    // so shell out to taskkill /T. start_kill is the fallback.
                    // ponytail: Windows-only mechanism; this server runs on the
                    // Windows CUDA box. Add a cfg branch if it ever runs elsewhere.
                    if let Some(pid) = child.id() {
                        let _ = tokio::process::Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()
                            .await;
                    }
                    let _ = child.start_kill();
                    cancelled = true;
                    break;
                }
                line = out_lines.next_line(), if !stdout_done => {
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
                        Ok(None) => stdout_done = true,
                        Err(e) => { tracing::warn!("stdout read error: {e}"); stdout_done = true; }
                    }
                }
                line = err_lines.next_line(), if !stderr_done => {
                    match line {
                        Ok(Some(l)) => {
                            if err_tail.len() == STDERR_TAIL_LINES {
                                err_tail.pop_front();
                            }
                            err_tail.push_back(l.clone());
                            let _ = tx.send(SseEvent {
                                kind: "log".into(),
                                job_id: rec.id.clone(),
                                stage: None, pct: None,
                                message: Some(l), ts: now(),
                            });
                        }
                        Ok(None) => stderr_done = true,
                        Err(e) => { tracing::warn!("stderr read error: {e}"); stderr_done = true; }
                    }
                }
            }
        }

        // Terminal status. Store write always precedes the terminal broadcast,
        // so a subscriber that reads a JobStore snapshot never misses it.
        if cancelled {
            fail(&store, &tx, &mut rec, "cancelled");
        } else {
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
                Ok(s) => {
                    let msg = if err_tail.is_empty() {
                        format!("worker exited: {s}")
                    } else {
                        let tail: Vec<String> = err_tail.into_iter().collect();
                        format!("worker exited: {s}\n--- stderr tail ---\n{}", tail.join("\n"))
                    };
                    fail(&store, &tx, &mut rec, &msg);
                }
                Err(e) => fail(&store, &tx, &mut rec, &format!("wait failed: {e}")),
            }
        }

        jobs.lock().await.remove(&rec.id);
    });

    rx
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
