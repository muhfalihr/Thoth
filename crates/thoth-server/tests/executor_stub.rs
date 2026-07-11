// Integration test: no GPU. A stub "worker" is a small batch script emitting
// canned NDJSON on stdout, exercising the executor's parse+fan-out.
use std::path::PathBuf;

use thoth_server::{
    auth::AppState,
    executor,
    job::{JobRecord, JobSpec, JobStatus},
    store::JobStore,
};

fn write_stub_worker(dir: &std::path::Path) -> PathBuf {
    // A batch file on Windows that prints two progress lines then exits 0.
    let p = dir.join("stub_worker.bat");
    std::fs::write(
        &p,
        concat!(
            "@echo off\r\n",
            "echo {\"stage\":\"ingest\",\"pct\":0.2,\"message\":\"a\",\"ts\":\"t\"}\r\n",
            "echo {\"stage\":\"edit\",\"pct\":0.9,\"message\":\"b\",\"ts\":\"t\"}\r\n",
            "exit /b 0\r\n",
        ),
    )
    .unwrap();
    p
}

#[tokio::test]
async fn executor_emits_progress_then_done() {
    let tmp = std::env::temp_dir().join(format!("thoth-exec-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let worker = write_stub_worker(&tmp);
    let store = JobStore::open(&tmp.join("jobs.redb")).unwrap();

    let state = AppState {
        api_key: "k".into(),
        store: store.clone(),
        jobs: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        worker_bin: worker,
        output_root: tmp.clone(),
    };

    let rec = JobRecord {
        id: "job1".into(),
        spec: JobSpec {
            command: "run".into(),
            url: Some("x".into()),
            content_set: None,
            params: serde_json::Value::Null,
        },
        status: JobStatus::Queued,
        stage: None,
        pct: 0.0,
        error: None,
        created_at: "t".into(),
        updated_at: "t".into(),
        output_dir: tmp.to_string_lossy().into_owned(),
    };
    store.put(&rec).unwrap();

    // spawn_job inserts the JobHandle into state.jobs synchronously before
    // spawning the background task, so once the await returns, the handle
    // is guaranteed present — no poll loop needed.
    executor::spawn_job(state.clone(), rec.clone()).await;

    let mut rx = state.jobs.lock().await.get("job1").unwrap().tx.subscribe();

    let mut kinds = Vec::new();
    while let Ok(ev) = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await {
        if let Ok(ev) = ev {
            let done = ev.kind == "done";
            kinds.push(ev.kind);
            if done {
                break;
            }
        } else {
            break;
        }
    }
    assert!(kinds.contains(&"progress".to_string()), "saw: {kinds:?}");
    assert!(kinds.contains(&"done".to_string()), "saw: {kinds:?}");

    let final_rec = store.get("job1").unwrap().unwrap();
    assert_eq!(final_rec.status, JobStatus::Succeeded);
    let _ = std::fs::remove_dir_all(&tmp);
}
