use thoth_jobs::{JobSpec, JobStatus, JobStore};

// The reaper is the only thing that notices a crashed independent worker.
// Force a stale heartbeat, run the reaper, assert the job is failed.
#[tokio::test]
async fn reaper_fails_stale_running_job() {
    let dir = std::env::temp_dir().join(format!("thoth-reap-{}", uuid::Uuid::new_v4()));
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
    store.claim_next("w1").await.unwrap();
    sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?")
        .bind("2000-01-01T00:00:00+00:00")
        .bind(&id)
        .execute(&store.pool)
        .await
        .unwrap();

    thoth_server::reaper::spawn_reaper(store.clone(), 1, 30);
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    assert_eq!(
        store.get(&id).await.unwrap().unwrap().status,
        JobStatus::Failed
    );
    let _ = std::fs::remove_dir_all(&dir);
}
