// Integration test: drives the router in-process via `oneshot` (no socket
// bind — port 8787 may be occupied on this machine). Covers the REST surface:
// auth gating, job creation, listing, artifact traversal guard, SSE tailing.
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use tower::ServiceExt;

use thoth_server::{
    auth::{AppState, CredentialProvider, legacy_output_root, server_db_path, worker_compatible_config_path},
    build_router,
};

/// Deterministic test double: only references in the set are "available".
/// Never resolves anything from the real environment.
struct FakeCredentialProvider(HashSet<String>);

impl CredentialProvider for FakeCredentialProvider {
    fn is_available(&self, reference: &str) -> bool {
        self.0.contains(reference)
    }
}

#[test]
fn server_runtime_paths_are_derived_from_thoth_home() {
    let root = std::env::temp_dir().join(format!("thoth-server-home-{}", uuid::Uuid::new_v4()));
    let home = thoth_jobs::resolve_home(Some(&root)).unwrap();

    assert_eq!(server_db_path(&home), root.join("data").join("thoth.db"));
    assert_eq!(
        legacy_output_root(&home),
        root.join("projects").join("legacy").join("outputs")
    );
}

#[test]
fn legacy_config_path_matches_the_workers_cwd_config() {
    assert_eq!(
        worker_compatible_config_path().unwrap(),
        std::env::current_dir().unwrap().join("config.toml")
    );
}

fn test_home(root: &std::path::Path) -> thoth_jobs::ThothHome {
    thoth_jobs::resolve_home(Some(root)).unwrap()
}

fn test_db_path(root: &std::path::Path) -> PathBuf {
    server_db_path(&test_home(root))
}

fn test_output_root(root: &std::path::Path) -> PathBuf {
    legacy_output_root(&test_home(root))
}

// Returns the router + the Thoth home root so tests that need to seed events
// directly can reopen the same SQLite DB through `test_db_path(&tmp)`.
async fn build_test_app() -> (axum::Router, PathBuf) {
    build_test_app_with_credentials(&[]).await
}

// Same as `build_test_app`, but with a deterministic fake `CredentialProvider`
// that treats exactly the given references as available. Tests exercising the
// enqueue-from-profile credential gate use this to avoid touching real env vars.
async fn build_test_app_with_credentials(available: &[&str]) -> (axum::Router, PathBuf) {
    let tmp = std::env::temp_dir().join(format!("thoth-routes-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let home = test_home(&tmp);
    home.ensure_project_layout("legacy").unwrap();
    let db_path = server_db_path(&home);
    let store = thoth_jobs::JobStore::connect_with_home(db_path.to_str().unwrap(), home.clone())
        .await
        .unwrap();
    let credentials: HashSet<String> = available.iter().map(|s| s.to_string()).collect();
    let worker_config_path = tmp.join("config.toml");
    let state = AppState {
        api_key: "test-key".into(),
        store,
        output_root: legacy_output_root(&home),
        home,
        scout_output_config: thoth_jobs::ScoutOutputConfig::new(worker_config_path.clone())
            .unwrap(),
        worker_config_path,
        scout: thoth_server::scout::new_supervisor(),
        credentials: Arc::new(FakeCredentialProvider(credentials)),
    };
    (build_router(state), tmp)
}

fn cancel_job_request(id: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/api/jobs/{id}/cancel"))
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap()
}

async fn enqueue_test_job(store: &thoth_jobs::JobStore, id: &str) {
    let spec = thoth_jobs::JobSpec {
        command: "run".into(),
        url: Some("https://x.test".into()),
        content_set: None,
        params: serde_json::json!({}),
    };
    store.enqueue(id, &spec, "out/job").await.unwrap();
}

async fn response_bytes(response: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

fn artifact_request(method: &str, path: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(format!("/api/artifacts/job1/{path}"))
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap()
}

fn create_job_request(spec: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/jobs")
        .header("content-type", "application/json")
        .header("authorization", "Bearer test-key")
        .body(Body::from(spec.to_string()))
        .unwrap()
}

fn list_jobs_request() -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri("/api/jobs")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap()
}

fn scout_output_request(method: &str, path: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(format!("/api/scout/output/{path}?token=test-key"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn create_job_without_key_is_unauthorized() {
    let (app, tmp) = build_test_app().await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/jobs")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"command":"run","url":"https://x.test","params":{}}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn create_job_with_key_returns_201_and_job_id() {
    let (app, tmp) = build_test_app().await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/jobs")
        .header("content-type", "application/json")
        .header("authorization", "Bearer test-key")
        .body(Body::from(
            r#"{"command":"run","url":"https://x.test","params":{}}"#,
        ))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["job_id"].is_string(), "body: {json}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancel_job_queued_returns_current_job_and_emits_one_cancelled_event() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();
    enqueue_test_job(&store, "queued-job").await;

    let res = app.oneshot(cancel_job_request("queued-job")).await.unwrap();

    assert_eq!(res.status(), StatusCode::OK);
    let job: thoth_jobs::JobRecord = serde_json::from_slice(&response_bytes(res).await).unwrap();
    assert_eq!(job.status, thoth_jobs::JobStatus::Cancelled);
    assert_eq!(
        store.get("queued-job").await.unwrap().unwrap().status,
        thoth_jobs::JobStatus::Cancelled
    );
    let events = store.events_since("queued-job", 0).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "cancelled");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancel_job_running_returns_current_job_and_sets_flag() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();
    enqueue_test_job(&store, "running-job").await;
    store.claim_next("worker-1").await.unwrap().unwrap();

    let res = app.oneshot(cancel_job_request("running-job")).await.unwrap();

    assert_eq!(res.status(), StatusCode::OK);
    let response_job: thoth_jobs::JobRecord =
        serde_json::from_slice(&response_bytes(res).await).unwrap();
    assert_eq!(response_job.status, thoth_jobs::JobStatus::Running);
    assert!(response_job.cancel_requested);
    let job = store.get("running-job").await.unwrap().unwrap();
    assert_eq!(job.status, thoth_jobs::JobStatus::Running);
    assert!(job.cancel_requested);
    assert!(store.events_since("running-job", 0).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancel_job_repeated_running_request_returns_current_job() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();
    enqueue_test_job(&store, "repeated-job").await;
    store.claim_next("worker-1").await.unwrap().unwrap();

    let first = app
        .clone()
        .oneshot(cancel_job_request("repeated-job"))
        .await
        .unwrap();
    let second = app.oneshot(cancel_job_request("repeated-job")).await.unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    let job = store.get("repeated-job").await.unwrap().unwrap();
    assert_eq!(job.status, thoth_jobs::JobStatus::Running);
    assert!(job.cancel_requested);
    assert!(store.events_since("repeated-job", 0).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancel_job_terminal_returns_conflict() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();
    enqueue_test_job(&store, "terminal-job").await;
    store.claim_next("worker-1").await.unwrap().unwrap();
    store
        .finish_running(
            "terminal-job",
            thoth_jobs::JobStatus::Succeeded,
            None,
            "done",
            None,
        )
        .await
        .unwrap();

    let res = app.oneshot(cancel_job_request("terminal-job")).await.unwrap();

    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(store.events_since("terminal-job", 0).await.unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancel_job_missing_returns_not_found() {
    let (app, tmp) = build_test_app().await;

    let res = app.oneshot(cancel_job_request("missing-job")).await.unwrap();

    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancelled_event_is_terminal_and_closes_the_job_sse_stream() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();
    enqueue_test_job(&store, "cancelled-stream-job").await;
    store
        .append_event(
            "cancelled-stream-job",
            "cancelled",
            None,
            None,
            None,
        )
        .await
        .unwrap();

    let request = Request::builder()
        .method("GET")
        .uri("/api/jobs/cancelled-stream-job/stream?token=test-key")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = tokio::time::timeout(
        Duration::from_secs(1),
        axum::body::to_bytes(response.into_body(), usize::MAX),
    )
    .await
    .expect("cancelled event must close the stream")
    .unwrap();
    assert!(
        std::str::from_utf8(&body)
            .unwrap()
            .contains(r#""type":"cancelled""#),
        "body: {}",
        String::from_utf8_lossy(&body)
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn artifact_backslash_traversal_is_rejected() {
    // Regression: the old `/`-only `".."` split let `..\..\` through on Windows.
    // %5C decodes to `\`, which Path treats as a separator → ParentDir component.
    let (app, tmp) = build_test_app().await;
    let req = Request::builder()
        .method("GET")
        .uri("/api/artifacts/job1/..%5C..%5C..%5C..%5CWindows%5CSystem32%5Cdrivers%5Cetc%5Chosts")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST, "traversal must be 400");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn job_artifact_get_head_and_ranges_stream_the_http_representation() {
    let (app, tmp) = build_test_app().await;
    let job_dir = test_output_root(&tmp).join("job1");
    std::fs::create_dir_all(&job_dir).unwrap();
    std::fs::write(job_dir.join("artifact.txt"), b"0123456789").unwrap();

    let get = app
        .clone()
        .oneshot(artifact_request("GET", "artifact.txt"))
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(get.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(get.headers()[header::CONTENT_LENGTH], "10");
    assert_eq!(get.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(response_bytes(get).await, b"0123456789");

    let head = app
        .clone()
        .oneshot(artifact_request("HEAD", "artifact.txt"))
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
    assert_eq!(head.headers()[header::ACCEPT_RANGES], "bytes");
    assert!(response_bytes(head).await.is_empty());

    for (value, expected_range, expected_body) in [
        ("bytes=0-3", "bytes 0-3/10", b"0123".as_slice()),
        ("bytes=-4", "bytes 6-9/10", b"6789".as_slice()),
        ("bytes=4-", "bytes 4-9/10", b"456789".as_slice()),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/artifacts/job1/artifact.txt")
                    .header("authorization", "Bearer test-key")
                    .header(header::RANGE, value)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{value}");
        assert_eq!(response.headers()[header::CONTENT_RANGE], expected_range);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], expected_body.len().to_string());
        assert_eq!(response_bytes(response).await, expected_body);
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

/// Release-readiness smoke test for the HTTP runtime contract. This stays in
/// `thoth-server`: the spawned worker models the SQLite polling boundary that
/// a real worker uses, without introducing a `thoth-core` dependency here.
#[tokio::test]
async fn runtime_contract_http_smoke() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();

    let invalid = app
        .clone()
        .oneshot(create_job_request(serde_json::json!({
            "command": "unsupported",
            "url": "https://x.test",
            "params": {},
        })))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(store.list().await.unwrap().is_empty(), "422 must not enqueue");

    let job_id = "runtime-smoke-job";
    enqueue_test_job(&store, job_id).await;
    let claimed = store.claim_next("smoke-worker").await.unwrap().unwrap();
    assert_eq!(claimed.id, job_id);

    let worker_store = store.clone();
    let worker_id = job_id.to_owned();
    let (initial_poll_tx, initial_poll_rx) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let initially_cancelled = worker_store.is_cancel_requested(&worker_id).await.unwrap();
        assert!(
            !initially_cancelled,
            "worker must observe the claimed job running before cancellation"
        );
        initial_poll_tx
            .send(())
            .expect("test must await the worker's initial SQLite poll");
        loop {
            if worker_store.is_cancel_requested(&worker_id).await.unwrap() {
                return worker_store
                    .finish_running(
                        &worker_id,
                        thoth_jobs::JobStatus::Cancelled,
                        None,
                        "cancelled",
                        None,
                    )
                    .await;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });

    initial_poll_rx
        .await
        .expect("worker must poll SQLite before the cancellation request");

    let cancellation_started = Instant::now();
    let cancelled = app
        .clone()
        .oneshot(cancel_job_request(job_id))
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::OK);
    let transitioned = tokio::time::timeout(Duration::from_secs(2), worker)
        .await
        .expect("SQLite cancellation must be observed within two seconds")
        .expect("worker task must not panic")
        .expect("worker polling must finish cleanly");
    assert!(transitioned, "only the claimed job may become terminal");
    let cancellation_latency = cancellation_started.elapsed();
    assert!(
        cancellation_latency < Duration::from_secs(2),
        "cancellation took {cancellation_latency:?}"
    );
    println!("runtime smoke SQLite cancellation latency: {cancellation_latency:?}");
    assert_eq!(
        store.get(job_id).await.unwrap().unwrap().status,
        thoth_jobs::JobStatus::Cancelled
    );

    let job_dir = test_output_root(&tmp).join(job_id);
    std::fs::create_dir_all(&job_dir).unwrap();
    std::fs::write(job_dir.join("artifact.txt"), b"0123456789").unwrap();

    let head = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri(format!("/api/artifacts/{job_id}/artifact.txt"))
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
    assert!(response_bytes(head).await.is_empty());

    let full = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/artifacts/{job_id}/artifact.txt"))
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(full.status(), StatusCode::OK);
    assert_eq!(response_bytes(full).await, b"0123456789");

    let partial = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/artifacts/{job_id}/artifact.txt"))
                .header("authorization", "Bearer test-key")
                .header(header::RANGE, "bytes=2-5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
    assert_eq!(response_bytes(partial).await, b"2345");

    let malformed = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/artifacts/{job_id}/artifact.txt"))
                .header("authorization", "Bearer test-key")
                .header(header::RANGE, "bytes=not-a-range")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(malformed.headers()[header::CONTENT_RANGE], "bytes */10");

    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn invalid_job_requests_return_structured_422_without_enqueuing() {
    let (app, tmp) = build_test_app().await;
    let cases = [
        (serde_json::json!({ "command": "analyze", "url": "https://x.test", "params": {} }), "command", "unsupported_command"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "content_set": "set.json", "params": {} }), "source", "invalid_source"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": [] }), "params", "invalid_params"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "unknown": true } }), "params.unknown", "unknown_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "language": "  " } }), "params.language", "invalid_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "provider": "invalid" } }), "params.provider", "invalid_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "max_clips": 0 } }), "params.max_clips", "invalid_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "bgm_volume": 2 } }), "params.bgm_volume", "invalid_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "headline_dur": 0 } }), "params.headline_dur", "invalid_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "keywords": ["ok", ""] } }), "params.keywords", "invalid_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "extra_args": ["--safe", ""] } }), "params.extra_args", "invalid_parameter"),
        (serde_json::json!({ "command": "run", "url": "https://x.test", "params": { "extra_args": ["--output-dir=elsewhere"] } }), "params.extra_args[0]", "protected_argument"),
    ];

    for (spec, field, code) in cases {
        let before = app.clone().oneshot(list_jobs_request()).await.unwrap();
        let before: serde_json::Value = serde_json::from_slice(&response_bytes(before).await).unwrap();

        let response = app.clone().oneshot(create_job_request(spec)).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body: serde_json::Value = serde_json::from_slice(&response_bytes(response).await).unwrap();
        let error = body.get("error").and_then(serde_json::Value::as_object).unwrap();
        assert_eq!(body.as_object().unwrap().len(), 1, "body: {body}");
        assert_eq!(error.len(), 3, "body: {body}");
        assert_eq!(error.get("field"), Some(&serde_json::json!(field)));
        assert_eq!(error.get("code"), Some(&serde_json::json!(code)));
        assert!(error.get("message").and_then(serde_json::Value::as_str).is_some());

        let after = app.clone().oneshot(list_jobs_request()).await.unwrap();
        let after: serde_json::Value = serde_json::from_slice(&response_bytes(after).await).unwrap();
        assert_eq!(after, before, "invalid {field} request enqueued a job");
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn job_artifact_rejects_bad_ranges_and_missing_or_directory_files() {
    let (app, tmp) = build_test_app().await;
    let job_dir = test_output_root(&tmp).join("job1");
    std::fs::create_dir_all(job_dir.join("directory")).unwrap();
    std::fs::write(job_dir.join("artifact.txt"), b"0123456789").unwrap();

    for value in ["bytes=garbage", "bytes=10-", "bytes=0-1,4-5"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/artifacts/job1/artifact.txt")
                    .header("authorization", "Bearer test-key")
                    .header(header::RANGE, value)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE, "{value}");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        assert!(response_bytes(response).await.is_empty());
    }

    for path in ["missing.txt", "directory"] {
        let response = app
            .clone()
            .oneshot(artifact_request("GET", path))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn job_artifact_serves_zero_byte_get_and_head_but_rejects_ranges() {
    let (app, tmp) = build_test_app().await;
    let job_dir = test_output_root(&tmp).join("job1");
    std::fs::create_dir_all(&job_dir).unwrap();
    std::fs::write(job_dir.join("empty.txt"), b"").unwrap();

    for method in ["GET", "HEAD"] {
        let response = app
            .clone()
            .oneshot(artifact_request(method, "empty.txt"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{method}");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
        assert!(response_bytes(response).await.is_empty());
    }

    let response = app
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri("/api/artifacts/job1/empty.txt")
                .header("authorization", "Bearer test-key")
                .header(header::RANGE, "bytes=0-0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */0");
    assert!(response_bytes(response).await.is_empty());

    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_output_token_route_supports_get_head_and_ranges() {
    let (app, tmp) = build_test_app().await;
    let name = format!("routes-http-{}.txt", uuid::Uuid::new_v4());
    let path = std::path::Path::new(thoth_server::scout::SCOUT_OUTPUT_DIR).join(&name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"0123456789").unwrap();

    let get = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/scout/output/{name}?token=test-key"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    assert_eq!(get.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(get.headers()[header::CONTENT_LENGTH], "10");
    assert_eq!(get.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(response_bytes(get).await, b"0123456789");

    let head = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri(format!("/api/scout/output/{name}?token=test-key"))
                .header(header::RANGE, "bytes=-4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(head.headers()[header::CONTENT_RANGE], "bytes 6-9/10");
    assert_eq!(head.headers()[header::CONTENT_LENGTH], "4");
    assert!(response_bytes(head).await.is_empty());

    let get_range = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/scout/output/{name}?token=test-key"))
                .header(header::RANGE, "bytes=4-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(get_range.headers()[header::CONTENT_RANGE], "bytes 4-9/10");
    assert_eq!(response_bytes(get_range).await, b"456789");

    std::fs::remove_file(&path).unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_output_token_route_serves_zero_byte_get_and_head_but_rejects_ranges() {
    let (app, tmp) = build_test_app().await;
    let name = format!("routes-http-empty-{}.txt", uuid::Uuid::new_v4());
    let path = std::path::Path::new(thoth_server::scout::SCOUT_OUTPUT_DIR).join(&name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"").unwrap();

    for method in ["GET", "HEAD"] {
        let response = app
            .clone()
            .oneshot(scout_output_request(method, &name))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{method}");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
        assert!(response_bytes(response).await.is_empty());
    }

    let response = app
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri(format!("/api/scout/output/{name}?token=test-key"))
                .header(header::RANGE, "bytes=0-0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */0");
    assert!(response_bytes(response).await.is_empty());

    std::fs::remove_file(&path).unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_output_token_route_rejects_bad_ranges_and_directories() {
    let (app, tmp) = build_test_app().await;
    let directory = format!("routes-http-directory-{}", uuid::Uuid::new_v4());
    let name = format!("routes-http-range-{}.txt", uuid::Uuid::new_v4());
    let output_dir = std::path::Path::new(thoth_server::scout::SCOUT_OUTPUT_DIR);
    std::fs::create_dir_all(output_dir.join(&directory)).unwrap();
    std::fs::write(output_dir.join(&name), b"0123456789").unwrap();

    for value in ["bytes=garbage", "bytes=10-", "bytes=0-1,4-5"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/scout/output/{name}?token=test-key"))
                    .header(header::RANGE, value)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE, "{value}");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        assert!(response_bytes(response).await.is_empty());
    }

    let response = app
        .oneshot(scout_output_request("GET", &directory))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    std::fs::remove_file(output_dir.join(&name)).unwrap();
    std::fs::remove_dir_all(output_dir.join(&directory)).unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_output_token_route_rejects_traversal() {
    let (app, tmp) = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/scout/output/..%2Foutside.txt?token=test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn list_jobs_contains_created_job() {
    let (app, tmp) = build_test_app().await;

    let create_req = Request::builder()
        .method("POST")
        .uri("/api/jobs")
        .header("content-type", "application/json")
        .header("authorization", "Bearer test-key")
        .body(Body::from(
            r#"{"command":"run","url":"https://x.test","params":{}}"#,
        ))
        .unwrap();
    let create_res = app.clone().oneshot(create_req).await.unwrap();
    assert_eq!(create_res.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(create_res.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let job_id = created["job_id"].as_str().unwrap().to_owned();

    let list_req = Request::builder()
        .method("GET")
        .uri("/api/jobs")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let list_res = app.oneshot(list_req).await.unwrap();
    assert_eq!(list_res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(list_res.into_body(), usize::MAX)
        .await
        .unwrap();
    let jobs: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = jobs
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&job_id.as_str()), "ids: {ids:?}");

    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn sse_tails_events_and_resumes() {
    let (app, tmp) = build_test_app().await;
    // enqueue via API to get an id
    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/jobs")
                .header("authorization", "Bearer test-key")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"command":"run","url":"u"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(create.into_body(), 1 << 20).await.unwrap();
    let id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["job_id"]
        .as_str()
        .unwrap()
        .to_string();

    // seed a progress then a done event directly through the store (reopen same db)
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();
    store
        .append_event(&id, "progress", Some("ingest"), Some(0.2), None)
        .await
        .unwrap();
    store
        .append_event(&id, "done", None, Some(1.0), None)
        .await
        .unwrap();

    let res = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/jobs/{id}/stream?token=test-key"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    // The stream must close after the `done` event so to_bytes returns.
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("\"type\":\"progress\""), "got: {text}");
    assert!(text.contains("\"type\":\"done\""), "got: {text}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn manifest_resolves_existing_artifacts() {
    let (app, tmp) = build_test_app().await;
    let id = "job-abc";
    let job = test_output_root(&tmp).join(id);
    // Cover every sub-layout the handler mirrors from thoth-core — this test IS
    // the drift guard for that coupling (spec §3b), so exercise all paths, not
    // just video+moments.
    std::fs::create_dir_all(job.join("clips")).unwrap();
    std::fs::create_dir_all(job.join("analyze")).unwrap();
    std::fs::create_dir_all(job.join("narration")).unwrap();
    std::fs::create_dir_all(job.join("transcribe")).unwrap();
    std::fs::write(job.join("clips/final_concat.mp4"), b"x").unwrap();
    std::fs::write(job.join("analyze/moments.json"), b"{}").unwrap();
    std::fs::write(job.join("narration/narration.mp3"), b"x").unwrap();
    std::fs::write(job.join("transcribe/transcript.json"), b"{}").unwrap();

    let req = Request::builder()
        .uri(format!("/api/jobs/{id}/manifest"))
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let m: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(m["video"], "clips/final_concat.mp4");
    assert_eq!(m["moments"], "analyze/moments.json");
    assert_eq!(m["narration"], "narration/narration.mp3");
    assert_eq!(m["transcript"], "transcribe/transcript.json");
    assert!(m.get("thumbnail").is_none()); // absent → omitted
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn manifest_video_falls_back_to_newest_clip() {
    let (app, tmp) = build_test_app().await;
    let id = "job-fallback";
    let job = test_output_root(&tmp).join(id);
    std::fs::create_dir_all(job.join("clips")).unwrap();
    // No final_concat.mp4 → handler must fall back to the newest clip_*.mp4.
    std::fs::write(job.join("clips/clip_000.mp4"), b"x").unwrap();
    std::fs::write(job.join("clips/clip_001.mp4"), b"x").unwrap();

    let req = Request::builder()
        .uri(format!("/api/jobs/{id}/manifest"))
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let m: serde_json::Value = serde_json::from_slice(&body).unwrap();
    // Some clip resolved (newest by mtime); relpath stays under clips/.
    let v = m["video"].as_str().expect("video should resolve to a clip");
    assert!(v.starts_with("clips/clip_") && v.ends_with(".mp4"), "got {v}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn manifest_rejects_traversal_id() {
    let (app, tmp) = build_test_app().await;
    // Percent-encoded `..` in the id segment must not escape output_root; the
    // handler returns an empty manifest rather than probing outside the root.
    let req = Request::builder()
        .uri("/api/jobs/%2e%2e/manifest")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    assert_eq!(&body[..], b"{}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn manifest_empty_for_unknown_job() {
    let (app, tmp) = build_test_app().await;
    let req = Request::builder()
        .uri("/api/jobs/nope/manifest")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    assert_eq!(&body[..], b"{}"); // all fields omitted
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn legacy_config_endpoints_are_retired() {
    // Experience Tasks 1 & 3 own removing the dashboard callers; the server
    // side of that retirement is these three routes now returning 404.
    let (app, tmp) = build_test_app().await;
    for (method, uri) in [
        ("GET", "/api/config"),
        ("PUT", "/api/config"),
        ("GET", "/api/style-profiles"),
    ] {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", "Bearer test-key")
            .header("content-type", "application/json")
            .body(Body::from(if method == "PUT" { r#"{"text":""}"# } else { "" }))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{method} {uri}");
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn migrate_config_toml_missing_file_is_404() {
    let (app, tmp) = build_test_app().await; // no config.toml seeded
    let req = Request::builder()
        .method("POST")
        .uri("/api/migrations/config-toml")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn migrate_config_toml_endpoint_imports_then_is_idempotent() {
    let (app, tmp) = build_test_app().await;
    std::fs::write(
        tmp.join("config.toml"),
        "[styles.profiles.default]\nlayout = \"vertical\"\nsubtitle_style = \"bold\"\n",
    )
    .unwrap();

    let req = || {
        Request::builder()
            .method("POST")
            .uri("/api/migrations/config-toml")
            .header("authorization", "Bearer test-key")
            .body(Body::empty())
            .unwrap()
    };

    let res = app.clone().oneshot(req()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res).await;
    assert_eq!(body["imported"], true, "body: {body}");
    let warnings = body["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|w| w.as_str().unwrap().contains("subtitle_style")),
        "warnings: {warnings:?}"
    );

    let res = app.oneshot(req()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res).await;
    assert_eq!(body["imported"], false, "body: {body}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_status_idle_shape() {
    let (app, tmp) = build_test_app().await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/scout/status")
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["browser_attached"].is_boolean(), "body: {v}");
    assert!(v["cdp_base"].as_str().unwrap().contains("18800"), "body: {v}");
    assert!(v["run"].is_null(), "body: {v}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_run_missing_url_is_400() {
    let (app, tmp) = build_test_app().await;
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/scout/run")
                .header("authorization", "Bearer test-key")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_run_rejects_invalid_main_coverage_before_starting() {
    let (app, tmp) = build_test_app().await;
    for target in ["0.59", "1.01", "1e999"] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/scout/run")
                    .header("authorization", "Bearer test-key")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"url":"https://www.instagram.com/p/ABC/","main_coverage_target":{target}}}"#,
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            matches!(res.status(), StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY),
            "{target}: {}",
            res.status(),
        );
    }
    let status = app
        .oneshot(
            Request::builder()
                .uri("/api/scout/status")
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(status.into_body(), 1 << 20).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(json["run"].is_null(), "invalid target started Scout: {json}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_cancel_when_idle_is_409() {
    let (app, tmp) = build_test_app().await;
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/scout/cancel")
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_topics_absent_is_empty_array() {
    let (app, tmp) = build_test_app().await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/scout/topics")
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v.is_array(), "body: {v}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn scout_stream_wrong_token_is_401() {
    // Only the immediate-rejection path is safe to test here: a valid token
    // against an idle/running run would block on the SSE loop under oneshot.
    let (app, tmp) = build_test_app().await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/scout/stream?token=wrong")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(&tmp);
}

// --- content-set editor (sub-project C) test harness -------------------------
async fn app_with_content_set(cs: std::path::PathBuf) -> axum::Router {
    let tmp = std::env::temp_dir().join(format!("thoth-cs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let home = test_home(&tmp);
    home.ensure_project_layout("legacy").unwrap();
    let store = thoth_jobs::JobStore::connect_with_home(
        server_db_path(&home).to_str().unwrap(),
        home.clone(),
    )
    .await
    .unwrap();
    let scout = thoth_server::scout::new_supervisor();
    scout.lock().await.last_content_set = Some(cs);
    let worker_config_path = tmp.join("config.toml");
    let state = AppState {
        api_key: "test-key".into(),
        store,
        output_root: legacy_output_root(&home),
        home,
        scout_output_config: thoth_jobs::ScoutOutputConfig::new(worker_config_path.clone())
            .unwrap(),
        worker_config_path,
        scout,
        credentials: Arc::new(FakeCredentialProvider(HashSet::new())),
    };
    build_router(state)
}

async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn tmp_json_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("cs-{}.json", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn content_set_data_missing_reports_not_exists() {
    let app = app_with_content_set(tmp_json_path()).await; // path never created
    let req = Request::builder()
        .method("GET")
        .uri("/api/scout/content-set/data")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["exists"], false);
    assert!(v["content"].is_null());
    assert!(v["error"].is_null());
}

#[tokio::test]
async fn content_set_data_exists_returns_verbatim_content() {
    let p = tmp_json_path();
    std::fs::write(&p, r#"{"main":{"title":"T"},"footage":[],"discourse":{"themes":["x"]}}"#).unwrap();
    let app = app_with_content_set(p).await;
    let req = Request::builder()
        .method("GET")
        .uri("/api/scout/content-set/data")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let v = body_json(app.oneshot(req).await.unwrap()).await;
    assert_eq!(v["exists"], true);
    assert_eq!(v["content"]["main"]["title"], "T");
    assert_eq!(v["content"]["discourse"]["themes"][0], "x");
}

#[tokio::test]
async fn content_set_data_malformed_flags_error() {
    let p = tmp_json_path();
    std::fs::write(&p, "{ not json").unwrap();
    let app = app_with_content_set(p).await;
    let req = Request::builder()
        .method("GET")
        .uri("/api/scout/content-set/data")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();
    let v = body_json(app.oneshot(req).await.unwrap()).await;
    assert_eq!(v["exists"], true);
    assert!(v["content"].is_null());
    assert_eq!(v["error"], "malformed");
}

#[tokio::test]
async fn content_set_put_round_trips_losslessly() {
    let p = tmp_json_path();
    std::fs::write(&p, "{}").unwrap(); // pre-existing file to overwrite
    let app = app_with_content_set(p.clone()).await;
    // Body carries a field the Rust side never models (discourse) + unknown key.
    let payload =
        r#"{"main":{"title":"Hi","description":"D"},"footage":[{"url":"u","relevance":9}],"comments":[],"figures":[],"references":[],"discourse":{"themes":["a"]},"unknown_future":true}"#;
    let req = Request::builder()
        .method("PUT")
        .uri("/api/scout/content-set")
        .header("authorization", "Bearer test-key")
        .header("content-type", "application/json")
        .body(Body::from(payload))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    // File on disk equals the input byte-for-byte (no field drop, no reformat).
    let on_disk = std::fs::read_to_string(&p).unwrap();
    assert_eq!(on_disk, payload);
}

#[tokio::test]
async fn content_set_put_rejects_non_object() {
    let app = app_with_content_set(tmp_json_path()).await;
    let req = Request::builder()
        .method("PUT")
        .uri("/api/scout/content-set")
        .header("authorization", "Bearer test-key")
        .header("content-type", "application/json")
        .body(Body::from("[1,2,3]"))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn content_set_put_rejects_missing_main_or_bad_array() {
    // missing `main`
    let app = app_with_content_set(tmp_json_path()).await;
    let req = Request::builder()
        .method("PUT")
        .uri("/api/scout/content-set")
        .header("authorization", "Bearer test-key")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"footage":[]}"#))
        .unwrap();
    assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::BAD_REQUEST);

    // `footage` present but not an array
    let app2 = app_with_content_set(tmp_json_path()).await;
    let req2 = Request::builder()
        .method("PUT")
        .uri("/api/scout/content-set")
        .header("authorization", "Bearer test-key")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"main":{},"footage":"nope"}"#))
        .unwrap();
    assert_eq!(app2.oneshot(req2).await.unwrap().status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn scout_output_requires_token() {
    let app = app_with_content_set(tmp_json_path()).await;
    let req = Request::builder()
        .method("GET")
        .uri("/api/scout/output/crops/x.png") // no ?token=
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn scout_output_wrong_token_is_401() {
    let app = app_with_content_set(tmp_json_path()).await;
    let req = Request::builder()
        .method("GET")
        .uri("/api/scout/output/crops/x.png?token=nope")
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn scout_output_valid_token_missing_file_is_404() {
    // Valid token passes auth + traversal guard, then the read misses -> 404.
    // (Proves the happy path reaches the filesystem; real serving is covered in
    // the manual-integration doc.)
    let app = app_with_content_set(tmp_json_path()).await;
    let req = Request::builder()
        .method("GET")
        .uri("/api/scout/output/crops/does-not-exist.png?token=test-key")
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::NOT_FOUND);
}

fn project_api_request(
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", "Bearer test-key");
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    builder
        .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .unwrap()
}

async fn project_api_json(
    app: axum::Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
    expected_status: StatusCode,
) -> serde_json::Value {
    let response = app
        .oneshot(project_api_request(method, uri, body))
        .await
        .unwrap();
    assert_eq!(response.status(), expected_status);
    body_json(response).await
}

fn write_forced_main_fixture(root: &std::path::Path) -> PathBuf {
    std::fs::create_dir_all(root).unwrap();
    let post_url = "https://www.instagram.com/reel/post-123/";
    std::fs::write(
        root.join("source-package.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "post": {
                "id": "post-123",
                "canonical_url": post_url,
                "platform": "instagram"
            },
            "analysis_identity": "analysis-2026-08-14",
            "created_at": "2026-08-14T12:00:00Z",
            "fingerprint": null,
            "sources": [{
                "id": "source-0",
                "media_index": 0,
                "path": "sources/source-0.mp4",
                "checksum": "sha256:source0",
                "technical": {
                    "container": "mp4",
                    "video_codec": "h264",
                    "duration_sec": 12.5,
                    "width": 1080,
                    "height": 1920,
                    "has_audio": true
                }
            }],
            "ignored": [],
            "unavailable": [],
            "scene_indexes": []
        }))
        .unwrap(),
    )
    .unwrap();
    let content_set = root.join("content-set.json");
    std::fs::write(
        &content_set,
        serde_json::to_vec_pretty(&serde_json::json!({
            "main": { "url": post_url },
            "main_footage": {
                "mode": "forced_url_pool",
                "package_manifest": "source-package.json",
                "coverage_target": 0.60
            }
        }))
        .unwrap(),
    )
    .unwrap();
    content_set
}

async fn create_profile_for_content_set(
    app: axum::Router,
    content_set: &std::path::Path,
    narration_enabled: bool,
) -> (String, String) {
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": format!("P-{}", uuid::Uuid::new_v4()) })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let profile = project_api_json(
        app,
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "settings": {
                "narration": { "enabled": narration_enabled },
                "ingest_source": { "content_set": content_set }
            }
        })),
        StatusCode::CREATED,
    )
    .await;
    (project_id, profile["id"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn forced_main_profile_requires_narration_before_job_or_output_creation() {
    let (app, tmp) = build_test_app().await;
    let fixture_root = std::env::current_dir()
        .unwrap()
        .join("scout/output")
        .join(format!("task-3-{}", uuid::Uuid::new_v4()));
    let content_set = write_forced_main_fixture(&fixture_root);
    let (project_id, profile_id) =
        create_profile_for_content_set(app.clone(), &content_set, false).await;
    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();

    let response = app
        .oneshot(project_api_request(
            "POST",
            &format!("/api/projects/{project_id}/jobs"),
            Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert_eq!(body["error"]["code"], "forced_main_narration_required");
    assert!(store.list().await.unwrap().is_empty());
    assert!(
        std::fs::read_dir(test_home(&tmp).project_outputs(&project_id))
            .unwrap()
            .next()
            .is_none()
    );
    let _ = std::fs::remove_dir_all(fixture_root);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn forced_main_profile_with_narration_enabled_enqueues() {
    let (app, tmp) = build_test_app().await;
    let fixture_root = std::env::current_dir()
        .unwrap()
        .join("scout/output")
        .join(format!("task-3-{}", uuid::Uuid::new_v4()));
    let content_set = write_forced_main_fixture(&fixture_root);
    let (project_id, profile_id) =
        create_profile_for_content_set(app.clone(), &content_set, true).await;

    let created = project_api_json(
        app,
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
        StatusCode::CREATED,
    )
    .await;

    assert!(created["job_id"].is_string());
    let _ = std::fs::remove_dir_all(fixture_root);
    let _ = std::fs::remove_dir_all(tmp);
}

/// Production mutation caught: resolving enqueue containment against the
/// historical `scout/output` constant makes the server disagree with the core
/// importer whenever `[scout].output_dir` is customized.
#[tokio::test]
async fn forced_main_enqueue_honors_the_worker_configured_scout_output_root() {
    let (app, tmp) = build_test_app().await;
    let configured_root = tmp.join("configured-scout-root");
    let content_set = write_forced_main_fixture(&configured_root);
    std::fs::write(
        tmp.join("config.toml"),
        format!(
            "[scout]\noutput_dir = '{}'\n",
            configured_root.to_string_lossy()
        ),
    )
    .unwrap();
    let (project_id, profile_id) =
        create_profile_for_content_set(app.clone(), &content_set, true).await;

    let created = project_api_json(
        app,
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
        StatusCode::CREATED,
    )
    .await;

    assert!(created["job_id"].is_string());
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn forced_main_enqueue_honors_the_worker_scout_output_environment_override() {
    const CHILD: &str = "THOTH_SCOUT_ROUTE_CONFIG_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let configured_root = std::env::temp_dir().join(format!(
            "thoth-route-environment-scout-{}",
            uuid::Uuid::new_v4()
        ));
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("forced_main_enqueue_honors_the_worker_scout_output_environment_override")
            .env(CHILD, "1")
            .env("THOTH_SCOUT_OUTPUT_DIR", &configured_root)
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(configured_root);
        assert!(status.success());
        return;
    }

    let (app, tmp) = build_test_app().await;
    let configured_root = PathBuf::from(std::env::var_os("THOTH_SCOUT_OUTPUT_DIR").unwrap());
    let content_set = write_forced_main_fixture(&configured_root);
    let (project_id, profile_id) =
        create_profile_for_content_set(app.clone(), &content_set, true).await;

    let created = project_api_json(
        app,
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
        StatusCode::CREATED,
    )
    .await;

    assert!(created["job_id"].is_string());
    let _ = std::fs::remove_dir_all(configured_root);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn forced_main_enqueue_retains_the_last_good_scout_root_when_config_reload_fails() {
    let (app, tmp) = build_test_app().await;
    let configured_root = tmp.join("last-good-scout-root");
    let content_set = write_forced_main_fixture(&configured_root);
    std::fs::write(
        tmp.join("config.toml"),
        format!(
            "[scout]\noutput_dir = '{}'\n",
            configured_root.to_string_lossy()
        ),
    )
    .unwrap();
    let (project_id, profile_id) =
        create_profile_for_content_set(app.clone(), &content_set, true).await;
    let body = serde_json::json!({ "profile_id": profile_id, "overrides": {} });

    let first = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(body.clone()),
        StatusCode::CREATED,
    )
    .await;
    assert!(first["job_id"].is_string());
    std::fs::write(tmp.join("config.toml"), "[scout\nmalformed = true").unwrap();

    let second = project_api_json(
        app,
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(body),
        StatusCode::CREATED,
    )
    .await;

    assert!(second["job_id"].is_string());
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn forced_main_gate_does_not_reject_legacy_sets_with_narration_disabled() {
    let (app, tmp) = build_test_app().await;
    let content_set = tmp.join("legacy-content-set.json");
    std::fs::write(
        &content_set,
        r#"{ "main": { "url": "https://x.test/legacy" } }"#,
    )
    .unwrap();
    let (project_id, profile_id) =
        create_profile_for_content_set(app.clone(), &content_set, false).await;

    let created = project_api_json(
        app,
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
        StatusCode::CREATED,
    )
    .await;

    assert!(created["job_id"].is_string());
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn forced_main_package_outside_scout_output_is_rejected() {
    let (app, tmp) = build_test_app().await;
    let content_set = write_forced_main_fixture(&tmp.join("outside-scout-output"));
    let (project_id, profile_id) =
        create_profile_for_content_set(app.clone(), &content_set, true).await;

    let response = app
        .oneshot(project_api_request(
            "POST",
            &format!("/api/projects/{project_id}/jobs"),
            Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert_eq!(body["error"]["code"], "source_package_invalid");
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn forced_main_rejects_packages_with_invalid_nested_scenes_or_duplicate_sources() {
    for corruption in ["invalid_scene", "duplicate_source"] {
        let (app, tmp) = build_test_app().await;
        let fixture_root = std::env::current_dir()
            .unwrap()
            .join("scout/output")
            .join(format!("task-3-{}", uuid::Uuid::new_v4()));
        let content_set = write_forced_main_fixture(&fixture_root);
        let package_path = fixture_root.join("source-package.json");
        let mut package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&package_path).unwrap()).unwrap();
        if corruption == "invalid_scene" {
            package["scene_indexes"] = serde_json::json!([{
                "source_id": "source-0",
                "path": "indexes/source-0.json",
                "checksum": "sha256:index0",
                "planning_mode": "vision",
                "scenes": [{
                    "id": "scene-0",
                    "start_sec": 0.0,
                    "end_sec": 0.0,
                    "representative_frame": "frames/scene-0.jpg",
                    "transcript_evidence": "evidence",
                    "vision_description": null,
                    "embedding_path": null,
                    "visual_metrics": {
                        "motion_score": 0.5,
                        "brightness": 0.5,
                        "scene_change_score": 0.5
                    }
                }]
            }]);
        } else {
            let duplicate = package["sources"][0].clone();
            package["sources"].as_array_mut().unwrap().push(duplicate);
        }
        std::fs::write(&package_path, serde_json::to_vec_pretty(&package).unwrap()).unwrap();
        let (project_id, profile_id) =
            create_profile_for_content_set(app.clone(), &content_set, true).await;

        let response = app
            .oneshot(project_api_request(
                "POST",
                &format!("/api/projects/{project_id}/jobs"),
                Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
            ))
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{corruption}"
        );
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "source_package_invalid");
        let _ = std::fs::remove_dir_all(fixture_root);
        let _ = std::fs::remove_dir_all(tmp);
    }
}

#[tokio::test]
async fn forced_main_rejects_matching_empty_or_blank_package_before_enqueue() {
    for corruption in ["empty_sources", "blank_analysis_identity"] {
        let (app, tmp) = build_test_app().await;
        let fixture_root = std::env::current_dir()
            .unwrap()
            .join("scout/output")
            .join(format!("task-3-{}", uuid::Uuid::new_v4()));
        let content_set = write_forced_main_fixture(&fixture_root);
        let package_path = fixture_root.join("source-package.json");
        let mut package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&package_path).unwrap()).unwrap();
        if corruption == "empty_sources" {
            package["sources"] = serde_json::json!([]);
        } else {
            package["analysis_identity"] = serde_json::json!(" \t");
        }
        std::fs::write(&package_path, serde_json::to_vec_pretty(&package).unwrap()).unwrap();
        let (project_id, profile_id) =
            create_profile_for_content_set(app.clone(), &content_set, true).await;

        let response = app
            .clone()
            .oneshot(project_api_request(
                "POST",
                &format!("/api/projects/{project_id}/jobs"),
                Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
            ))
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{corruption}"
        );
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "source_package_invalid");
        let jobs = app.oneshot(list_jobs_request()).await.unwrap();
        assert_eq!(body_json(jobs).await, serde_json::json!([]));
        let _ = std::fs::remove_dir_all(fixture_root);
        let _ = std::fs::remove_dir_all(tmp);
    }
}

#[tokio::test]
async fn forced_main_legacy_route_requires_explicit_narration_enablement() {
    for params in [serde_json::json!({}), serde_json::json!({ "narration_enabled": false })] {
        let (app, tmp) = build_test_app().await;
        let fixture_root = std::env::current_dir()
            .unwrap()
            .join("scout/output")
            .join(format!("task-3-{}", uuid::Uuid::new_v4()));
        let content_set = write_forced_main_fixture(&fixture_root);

        let response = app
            .clone()
            .oneshot(create_job_request(serde_json::json!({
                "command": "run",
                "content_set": content_set,
                "params": params
            })))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "forced_main_narration_required");
        let jobs = app.oneshot(list_jobs_request()).await.unwrap();
        let jobs = body_json(jobs).await;
        assert_eq!(jobs, serde_json::json!([]));
        let _ = std::fs::remove_dir_all(fixture_root);
        let _ = std::fs::remove_dir_all(tmp);
    }
}

#[tokio::test]
async fn forced_main_legacy_route_enqueues_with_explicit_narration_enablement() {
    let (app, tmp) = build_test_app().await;
    let fixture_root = std::env::current_dir()
        .unwrap()
        .join("scout/output")
        .join(format!("task-3-{}", uuid::Uuid::new_v4()));
    let content_set = write_forced_main_fixture(&fixture_root);

    let response = app
        .oneshot(create_job_request(serde_json::json!({
            "command": "run",
            "content_set": content_set,
            "params": { "narration_enabled": true }
        })))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let _ = std::fs::remove_dir_all(fixture_root);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_resources_require_bearer_authentication() {
    let (app, tmp) = build_test_app().await;
    let request = Request::builder()
        .method("GET")
        .uri("/api/projects")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_resources_create_list_detail_update_and_preserve_workspace_on_delete() {
    let (app, tmp) = build_test_app().await;
    let created = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": " Demo " })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = created["id"].as_str().unwrap();
    let workspace = PathBuf::from(created["workspace_path"].as_str().unwrap());
    assert_eq!(created["name"], "Demo");
    assert!(workspace.is_dir());

    let listed = project_api_json(
        app.clone(),
        "GET",
        "/api/projects",
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], project_id);

    let detail_uri = format!("/api/projects/{project_id}");
    let detail = project_api_json(
        app.clone(),
        "GET",
        &detail_uri,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(detail["id"], project_id);
    let updated = project_api_json(
        app.clone(),
        "PATCH",
        &detail_uri,
        Some(serde_json::json!({ "name": "Renamed" })),
        StatusCode::OK,
    )
    .await;
    assert_eq!(updated["name"], "Renamed");

    let response = app
        .clone()
        .oneshot(project_api_request("DELETE", &detail_uri, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(workspace.is_dir(), "metadata deletion must not remove files");
    let missing = app
        .oneshot(project_api_request("GET", &detail_uri, None))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn profile_is_visible_only_in_its_project() {
    let (app, tmp) = build_test_app().await;
    let first = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "First" })),
        StatusCode::CREATED,
    )
    .await;
    let second = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Second" })),
        StatusCode::CREATED,
    )
    .await;
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{first_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "Safe typed defaults",
            "settings": {},
            "credential_ref": "openai-production"
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();
    assert_eq!(profile["project_id"], first_id);
    assert_eq!(profile["credential_ref"], "openai-production");
    assert!(profile.get("credential_value").is_none());

    let own_uri = format!("/api/projects/{first_id}/profiles/{profile_id}");
    let own = project_api_json(app.clone(), "GET", &own_uri, None, StatusCode::OK).await;
    assert_eq!(own["id"], profile_id);
    let listed = project_api_json(
        app.clone(),
        "GET",
        &format!("/api/projects/{first_id}/profiles"),
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);

    let foreign_uri = format!("/api/projects/{second_id}/profiles/{profile_id}");
    let foreign = app
        .oneshot(project_api_request("GET", &foreign_uri, None))
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn duplicate_resource_names_return_conflict() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Project" })),
        StatusCode::CREATED,
    )
    .await;
    let duplicate_project = app
        .clone()
        .oneshot(project_api_request(
            "POST",
            "/api/projects",
            Some(serde_json::json!({ "name": " Project " })),
        ))
        .await
        .unwrap();
    assert_eq!(duplicate_project.status(), StatusCode::CONFLICT);

    let profiles_uri = format!("/api/projects/{}/profiles", project["id"].as_str().unwrap());
    project_api_json(
        app.clone(),
        "POST",
        &profiles_uri,
        Some(serde_json::json!({ "name": "Default", "settings": {} })),
        StatusCode::CREATED,
    )
    .await;
    let duplicate_profile = app
        .oneshot(project_api_request(
            "POST",
            &profiles_uri,
            Some(serde_json::json!({ "name": "Default", "settings": {} })),
        ))
        .await
        .unwrap();
    assert_eq!(duplicate_profile.status(), StatusCode::CONFLICT);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_profile_payloads_reject_unknown_fields_and_invalid_settings() {
    let (app, tmp) = build_test_app().await;
    let unknown_project_field = app
        .clone()
        .oneshot(project_api_request(
            "POST",
            "/api/projects",
            Some(serde_json::json!({ "name": "Project", "unknown": true })),
        ))
        .await
        .unwrap();
    assert_eq!(unknown_project_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        unknown_project_field.headers()[header::CONTENT_TYPE],
        "application/json"
    );
    assert_eq!(body_json(unknown_project_field).await["error"], "invalid_request");

    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Project" })),
        StatusCode::CREATED,
    )
    .await;
    let profiles_uri = format!("/api/projects/{}/profiles", project["id"].as_str().unwrap());
    let unknown_setting = app
        .clone()
        .oneshot(project_api_request(
            "POST",
            &profiles_uri,
            Some(serde_json::json!({
                "name": "Unknown",
                "settings": { "unknown": true }
            })),
        ))
        .await
        .unwrap();
    assert_eq!(unknown_setting.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let invalid_setting = app
        .oneshot(project_api_request(
            "POST",
            &profiles_uri,
            Some(serde_json::json!({
                "name": "Invalid",
                "settings": { "analysis": { "provider": "unsupported" } }
            })),
        ))
        .await
        .unwrap();
    assert_eq!(invalid_setting.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let error = body_json(invalid_setting).await;
    assert_eq!(error["error"], "validation_failed");
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn profile_duplicate_update_revision_and_restore_are_project_scoped() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Project" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profiles_uri = format!("/api/projects/{project_id}/profiles");
    let profile = project_api_json(
        app.clone(),
        "POST",
        &profiles_uri,
        Some(serde_json::json!({
            "name": "Default",
            "description": "Before",
            "settings": { "analysis": { "max_clips": 3 } }
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();
    let profile_uri = format!("{profiles_uri}/{profile_id}");
    let duplicate = project_api_json(
        app.clone(),
        "POST",
        &format!("{profile_uri}/duplicate"),
        Some(serde_json::json!({ "name": "Copy" })),
        StatusCode::CREATED,
    )
    .await;
    assert_ne!(duplicate["id"], profile_id);
    assert_eq!(duplicate["settings"], profile["settings"]);

    let updated = project_api_json(
        app.clone(),
        "PATCH",
        &profile_uri,
        Some(serde_json::json!({
            "description": "After",
            "settings": { "analysis": { "max_clips": 5 } }
        })),
        StatusCode::OK,
    )
    .await;
    assert_eq!(updated["name"], "Default", "omitted PATCH fields are retained");
    assert_eq!(updated["description"], "After");
    assert_eq!(updated["settings"]["analysis"]["max_clips"], 5);

    let revisions = project_api_json(
        app.clone(),
        "GET",
        &format!("{profile_uri}/revisions"),
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(revisions.as_array().unwrap().len(), 1);
    assert_eq!(revisions[0]["description"], "Before");
    let revision_id = revisions[0]["id"].as_str().unwrap();
    let restored = project_api_json(
        app.clone(),
        "POST",
        &format!("{profile_uri}/revisions/{revision_id}/restore"),
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(restored["description"], "Before");
    assert_eq!(restored["settings"]["analysis"]["max_clips"], 3);
    let history = project_api_json(
        app,
        "GET",
        &format!("{profile_uri}/revisions"),
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(history.as_array().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn profile_validate_checks_candidate_without_mutating_the_profile() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Project" })),
        StatusCode::CREATED,
    )
    .await;
    let profiles_uri = format!("/api/projects/{}/profiles", project["id"].as_str().unwrap());
    let profile = project_api_json(
        app.clone(),
        "POST",
        &profiles_uri,
        Some(serde_json::json!({ "name": "Default", "settings": {} })),
        StatusCode::CREATED,
    )
    .await;
    let profile_uri = format!("{profiles_uri}/{}", profile["id"].as_str().unwrap());
    let valid = project_api_json(
        app.clone(),
        "POST",
        &format!("{profile_uri}/validate"),
        Some(serde_json::json!({ "settings": { "analysis": { "max_clips": 7 } } })),
        StatusCode::OK,
    )
    .await;
    assert_eq!(valid["valid"], true);

    let invalid = app
        .clone()
        .oneshot(project_api_request(
            "POST",
            &format!("{profile_uri}/validate"),
            Some(serde_json::json!({ "settings": { "analysis": { "max_clips": 0 } } })),
        ))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let current = project_api_json(app, "GET", &profile_uri, None, StatusCode::OK).await;
    assert_eq!(current["settings"]["analysis"]["max_clips"], 3);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn profile_patch_distinguishes_omitted_credential_from_explicit_null() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Project" })),
        StatusCode::CREATED,
    )
    .await;
    let profiles_uri = format!("/api/projects/{}/profiles", project["id"].as_str().unwrap());
    let profile = project_api_json(
        app.clone(),
        "POST",
        &profiles_uri,
        Some(serde_json::json!({
            "name": "Default",
            "settings": {},
            "credential_ref": "openai-production"
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_uri = format!("{profiles_uri}/{}", profile["id"].as_str().unwrap());
    assert_eq!(profile["credential_ref"], "openai-production");

    let omitted = project_api_json(
        app.clone(),
        "PATCH",
        &profile_uri,
        Some(serde_json::json!({ "description": "Credential retained" })),
        StatusCode::OK,
    )
    .await;
    assert_eq!(omitted["credential_ref"], "openai-production");

    let cleared = project_api_json(
        app.clone(),
        "PATCH",
        &profile_uri,
        Some(serde_json::json!({ "credential_ref": null })),
        StatusCode::OK,
    )
    .await;
    assert!(cleared["credential_ref"].is_null());

    let persisted = project_api_json(app.clone(), "GET", &profile_uri, None, StatusCode::OK).await;
    assert!(persisted["credential_ref"].is_null());

    let set = project_api_json(
        app.clone(),
        "PATCH",
        &profile_uri,
        Some(serde_json::json!({ "credential_ref": "  openai-secondary  " })),
        StatusCode::OK,
    )
    .await;
    assert_eq!(set["credential_ref"], "openai-secondary");
    let persisted = project_api_json(app, "GET", &profile_uri, None, StatusCode::OK).await;
    assert_eq!(persisted["credential_ref"], "openai-secondary");
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn delete_resources_are_scoped_and_project_delete_rejects_active_jobs() {
    let (app, tmp) = build_test_app().await;
    let owner = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Owner" })),
        StatusCode::CREATED,
    )
    .await;
    let other = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Other" })),
        StatusCode::CREATED,
    )
    .await;
    let owner_id = owner["id"].as_str().unwrap();
    let other_id = other["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{owner_id}/profiles"),
        Some(serde_json::json!({ "name": "Default", "settings": {} })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();
    let wrong_scope = app
        .clone()
        .oneshot(project_api_request(
            "DELETE",
            &format!("/api/projects/{other_id}/profiles/{profile_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(wrong_scope.status(), StatusCode::NOT_FOUND);

    let store = thoth_jobs::JobStore::connect(test_db_path(&tmp).to_str().unwrap())
        .await
        .unwrap();
    store
        .enqueue_resolved(
            "active-job",
            &thoth_jobs::EnqueueRequest {
                spec: thoth_jobs::JobSpec {
                    command: "run".into(),
                    url: Some("https://x.test".into()),
                    content_set: None,
                    params: serde_json::json!({}),
                },
                project_id: owner_id.to_owned(),
                profile_id: Some(profile_id.to_owned()),
                profile_revision: None,
                override_summary: None,
                resolved_settings: thoth_jobs::ResolvedSettings::default(),
            },
            "out/active-job",
        )
        .await
        .unwrap();
    let active_delete = app
        .clone()
        .oneshot(project_api_request(
            "DELETE",
            &format!("/api/projects/{owner_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(active_delete.status(), StatusCode::CONFLICT);

    let profile_delete = app
        .clone()
        .oneshot(project_api_request(
            "DELETE",
            &format!("/api/projects/{owner_id}/profiles/{profile_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(profile_delete.status(), StatusCode::NO_CONTENT);
    let deleted_profile = app
        .oneshot(project_api_request(
            "GET",
            &format!("/api/projects/{owner_id}/profiles/{profile_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(deleted_profile.status(), StatusCode::NOT_FOUND);
    assert!(store.get("active-job").await.unwrap().is_some());
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn profile_storage_errors_return_safe_internal_error() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Project" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({ "name": "Default", "settings": {} })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();
    let database_url = format!("sqlite://{}", test_db_path(&tmp).to_string_lossy());
    let pool = sqlx::SqlitePool::connect(&database_url).await.unwrap();
    sqlx::query("UPDATE profiles SET settings_json = ? WHERE id = ?")
        .bind(r#"{"secret":"must-not-leak"}"#)
        .bind(profile_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let response = app
        .oneshot(project_api_request(
            "GET",
            &format!("/api/projects/{project_id}/profiles/{profile_id}"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let text = String::from_utf8(response_bytes(response).await).unwrap();
    assert_eq!(text, r#"{"error":"internal_error"}"#);
    assert!(!text.contains("secret"));
    assert!(!text.to_ascii_lowercase().contains("sql"));
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_from_profile_resolves_overrides_and_effective_settings() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": null
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let created = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({
            "profile_id": profile_id,
            "overrides": { "analysis_max_clips": 5, "ingest_source_source": "https://x.test/v" }
        })),
        StatusCode::CREATED,
    )
    .await;
    let job_id = created["job_id"].as_str().unwrap();

    let settings = project_api_json(
        app.clone(),
        "GET",
        &format!("/api/jobs/{job_id}/effective-settings"),
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(settings["settings"]["analysis"]["max_clips"], 5);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_records_profile_revision_and_override_summary() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": null
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();
    let created = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({
            "profile_id": profile_id,
            "overrides": { "analysis_max_clips": 7, "ingest_source_source": "https://x.test/v" }
        })),
        StatusCode::CREATED,
    )
    .await;
    let job_id = created["job_id"].as_str().unwrap();

    // The job pins the profile version (1 = never edited) and a redacted summary
    // of exactly the overridden fields. RunOverrides has no credential field, so
    // the summary can never carry a secret.
    let job = project_api_json(
        app.clone(),
        "GET",
        &format!("/api/jobs/{job_id}"),
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(job["profile_revision"], 1);
    assert_eq!(job["override_summary"]["analysis_max_clips"], 7);
    assert_eq!(job["override_summary"]["ingest_source_source"], "https://x.test/v");
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_rejects_profile_from_another_project() {
    let (app, tmp) = build_test_app().await;
    let first = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "First" })),
        StatusCode::CREATED,
    )
    .await;
    let second = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "Second" })),
        StatusCode::CREATED,
    )
    .await;
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{first_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": null
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let response = app
        .oneshot(project_api_request(
            "POST",
            &format!("/api/projects/{second_id}/jobs"),
            Some(serde_json::json!({
                "profile_id": profile_id,
                "overrides": {}
            })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_rejects_invalid_overrides() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": null
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    // "widescreen" is not one of the allowed visual_edit.layout values.
    let response = app
        .oneshot(project_api_request(
            "POST",
            &format!("/api/projects/{project_id}/jobs"),
            Some(serde_json::json!({
                "profile_id": profile_id,
                "overrides": { "visual_edit_layout": "widescreen" }
            })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_rejects_when_credential_reference_is_unavailable() {
    // Deliberately empty fake credential set: "openai-production" resolves to nothing.
    let (app, tmp) = build_test_app_with_credentials(&[]).await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": "openai-production"
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let response = app
        .oneshot(project_api_request(
            "POST",
            &format!("/api/projects/{project_id}/jobs"),
            Some(serde_json::json!({
                "profile_id": profile_id,
                "overrides": {}
            })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    let text = body.to_string();
    // The error must never leak the reference name or imply a secret value.
    assert!(!text.contains("openai-production"));
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_succeeds_when_credential_reference_is_available() {
    let (app, tmp) = build_test_app_with_credentials(&["openai-production"]).await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": "openai-production"
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let created = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({
            "profile_id": profile_id,
            "overrides": { "ingest_source_source": "https://x.test/v" }
        })),
        StatusCode::CREATED,
    )
    .await;
    assert!(created["job_id"].as_str().is_some());
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_rejects_unknown_body_fields_as_safe_json() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();

    let response = app
        .oneshot(project_api_request(
            "POST",
            &format!("/api/projects/{project_id}/jobs"),
            Some(serde_json::json!({
                "profile_id": "does-not-matter",
                "overrides": {},
                "unexpected_field": true
            })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = body_json(response).await;
    assert_eq!(body["error"], "invalid_request");
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn effective_settings_snapshot_is_immutable_after_profile_edit() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": { "analysis": { "provider": "novita", "model": "medium", "max_clips": 3, "keywords": [] } },
            "credential_ref": null
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let created = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({
            "profile_id": profile_id,
            "overrides": { "ingest_source_source": "https://x.test/v" }
        })),
        StatusCode::CREATED,
    )
    .await;
    let job_id = created["job_id"].as_str().unwrap();

    // Edit the profile after enqueue — the stored snapshot must not move.
    let _ = project_api_json(
        app.clone(),
        "PATCH",
        &format!("/api/projects/{project_id}/profiles/{profile_id}"),
        Some(serde_json::json!({
            "settings": { "analysis": { "provider": "novita", "model": "medium", "max_clips": 99, "keywords": [] } }
        })),
        StatusCode::OK,
    )
    .await;

    let settings = project_api_json(
        app.clone(),
        "GET",
        &format!("/api/jobs/{job_id}/effective-settings"),
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(settings["settings"]["analysis"]["max_clips"], 3);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_output_dir_is_under_projects_outputs_job_id() {
    let (app, tmp) = build_test_app().await;
    let home = test_home(&tmp);
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default", "description": "", "settings": {}, "credential_ref": null
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let created = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({
            "profile_id": profile_id,
            "overrides": { "ingest_source_source": "https://x.test/v" }
        })),
        StatusCode::CREATED,
    )
    .await;
    let job_id = created["job_id"].as_str().unwrap();

    let job = project_api_json(
        app.clone(),
        "GET",
        &format!("/api/jobs/{job_id}"),
        None,
        StatusCode::OK,
    )
    .await;
    let expected = home
        .project_outputs(&project_id)
        .join(job_id)
        .to_string_lossy()
        .into_owned();
    assert_eq!(job["output_dir"], expected);
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn effective_settings_redacts_credential_reference() {
    let (app, tmp) = build_test_app_with_credentials(&["openai-production"]).await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": "openai-production"
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let created = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/jobs"),
        Some(serde_json::json!({
            "profile_id": profile_id,
            "overrides": { "ingest_source_source": "https://x.test/v" }
        })),
        StatusCode::CREATED,
    )
    .await;
    let job_id = created["job_id"].as_str().unwrap();

    let settings = project_api_json(
        app.clone(),
        "GET",
        &format!("/api/jobs/{job_id}/effective-settings"),
        None,
        StatusCode::OK,
    )
    .await;
    assert!(settings["settings"].get("credential_ref").is_none());
    let text = settings.to_string();
    assert!(!text.contains("openai-production"));
    let _ = std::fs::remove_dir_all(tmp);
}

#[tokio::test]
async fn project_job_rejects_profile_with_no_ingest_source() {
    let (app, tmp) = build_test_app().await;
    let project = project_api_json(
        app.clone(),
        "POST",
        "/api/projects",
        Some(serde_json::json!({ "name": "P" })),
        StatusCode::CREATED,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    // Default settings: ingest_source.source and .content_set are both None.
    let profile = project_api_json(
        app.clone(),
        "POST",
        &format!("/api/projects/{project_id}/profiles"),
        Some(serde_json::json!({
            "name": "Default",
            "description": "",
            "settings": {},
            "credential_ref": null
        })),
        StatusCode::CREATED,
    )
    .await;
    let profile_id = profile["id"].as_str().unwrap();

    let response = app
        .oneshot(project_api_request(
            "POST",
            &format!("/api/projects/{project_id}/jobs"),
            Some(serde_json::json!({ "profile_id": profile_id, "overrides": {} })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let _ = std::fs::remove_dir_all(tmp);
}

// --- legacy config.toml migration (Server Task 4) ----------------------------

async fn store_with_home(tmp: &std::path::Path) -> thoth_jobs::JobStore {
    let home = test_home(tmp);
    home.ensure_layout().unwrap();
    let db_path = server_db_path(&home);
    thoth_jobs::JobStore::connect_with_home(db_path.to_str().unwrap(), home)
        .await
        .unwrap()
}

#[tokio::test]
async fn import_is_idempotent_and_preserves_original_file() {
    let tmp = std::env::temp_dir().join(format!("thoth-migrate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let store = store_with_home(&tmp).await;
    let cfg = tmp.join("legacy-config.toml");
    let original = "[styles.profiles.default]\nlayout = \"vertical\"\nclip_style = \"fade\"\n";
    std::fs::write(&cfg, original).unwrap();

    let first = thoth_server::migration::import_legacy_config(&store, &cfg)
        .await
        .unwrap();
    assert!(first.imported, "first import: {first:?}");

    let second = thoth_server::migration::import_legacy_config(&store, &cfg)
        .await
        .unwrap();
    assert!(!second.imported, "second import: {second:?}");
    assert!(second.warnings.is_empty(), "second import: {second:?}");

    assert_eq!(std::fs::read_to_string(&cfg).unwrap(), original);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn import_maps_recognized_visual_edit_fields() {
    let tmp = std::env::temp_dir().join(format!("thoth-migrate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let store = store_with_home(&tmp).await;
    let cfg = tmp.join("config.toml");
    std::fs::write(
        &cfg,
        "[styles.profiles.default]\nlayout = \"vertical\"\nclip_style = \"fade\"\n",
    )
    .unwrap();

    let report = thoth_server::migration::import_legacy_config(&store, &cfg)
        .await
        .unwrap();
    assert!(report.imported, "report: {report:?}");

    let projects = store.list_projects().await.unwrap();
    let project = projects.iter().find(|p| p.name == "Imported").unwrap();
    let profiles = store.list_profiles(&project.id).await.unwrap();
    let profile = profiles.iter().find(|p| p.name == "Default").unwrap();
    assert_eq!(profile.settings.visual_edit.layout, "vertical");
    assert_eq!(profile.settings.visual_edit.clip_style, "fade");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn import_reports_warning_for_unmapped_legacy_key_and_does_not_store_it() {
    let tmp = std::env::temp_dir().join(format!("thoth-migrate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let store = store_with_home(&tmp).await;
    let cfg = tmp.join("config.toml");
    std::fs::write(
        &cfg,
        "[styles.profiles.default]\nlayout = \"vertical\"\nsubtitle_style = \"bold\"\nbgm_vibe = \"chill\"\n",
    )
    .unwrap();

    let report = thoth_server::migration::import_legacy_config(&store, &cfg)
        .await
        .unwrap();
    assert!(report.imported, "report: {report:?}");
    assert!(
        report.warnings.iter().any(|w| w.contains("subtitle_style")),
        "warnings: {:?}",
        report.warnings
    );
    assert!(
        report.warnings.iter().any(|w| w.contains("bgm_vibe")),
        "warnings: {:?}",
        report.warnings
    );

    // Unmapped keys have no field in ProfileSettings — this is a structural
    // guarantee, not just an absence check. Confirm the recognized sibling
    // field still landed, proving the mapped/unmapped split actually ran.
    let projects = store.list_projects().await.unwrap();
    let project = projects.iter().find(|p| p.name == "Imported").unwrap();
    let profiles = store.list_profiles(&project.id).await.unwrap();
    let profile = profiles.iter().find(|p| p.name == "Default").unwrap();
    assert_eq!(profile.settings.visual_edit.layout, "vertical");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn import_rejects_malformed_toml_without_consuming_the_one_time_import() {
    let tmp = std::env::temp_dir().join(format!("thoth-migrate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let store = store_with_home(&tmp).await;
    let cfg = tmp.join("config.toml");
    std::fs::write(&cfg, "[styles.profiles.default]\nlayout = = broken\n").unwrap();

    // A malformed file must fail loudly, not be silently coerced into an empty
    // import that reports imported:true.
    let _error = thoth_server::migration::import_legacy_config(&store, &cfg)
        .await
        .unwrap_err();

    // Critically, the failed import must NOT have consumed the one-time slot:
    // the `Imported` project must not exist, so a retry after fixing the file
    // still works. (Idempotency is keyed on that project's existence.)
    assert!(
        store
            .list_projects()
            .await
            .unwrap()
            .iter()
            .all(|p| p.name != "Imported"),
        "a malformed import must not create the Imported project"
    );

    std::fs::write(&cfg, "[styles.profiles.default]\nlayout = \"square\"\n").unwrap();
    let report = thoth_server::migration::import_legacy_config(&store, &cfg)
        .await
        .unwrap();
    assert!(report.imported, "retry after fixing the file must import: {report:?}");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn wrong_method_on_live_api_route_is_405_not_404() {
    // Pins the new `/api` 404 fallback: it must fire only on a true path miss.
    // A matched path hit with an unsupported method is still answered 405 by
    // that route's own method router, not swallowed into 404 by the fallback.
    let (app, tmp) = build_test_app().await;
    let request = Request::builder()
        .method("DELETE")
        .uri("/api/jobs")
        .header("authorization", "Bearer test-key")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    let _ = std::fs::remove_dir_all(tmp);
}

// ── Task 14: main-footage package facts, job facts, and explicit cleanup ─────
//
// Every test below carries `main_footage` in its name so the focused filter
// `cargo test -p thoth-server --test routes_http main_footage` selects it.

struct MainFootageApp {
    app: axum::Router,
    /// Thoth home root for this test (also the temp dir to remove).
    home_root: PathBuf,
    /// Canonical-parent root the package cleanup/summary routes resolve under.
    scout_root: PathBuf,
    /// `output_root/<job_id>` is where legacy job artifacts live.
    output_root: PathBuf,
    scout: thoth_server::scout::ScoutSupervisor,
    store: thoth_jobs::JobStore,
}

impl MainFootageApp {
    fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.home_root);
    }
}

/// Router whose worker config pins `[scout].output_dir` inside the test's own
/// temp tree, so nothing here can touch the repository's real `scout/output`.
async fn build_main_footage_app() -> MainFootageApp {
    let tmp = std::env::temp_dir().join(format!("thoth-mf-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let home = test_home(&tmp);
    home.ensure_project_layout("legacy").unwrap();
    let store = thoth_jobs::JobStore::connect_with_home(
        server_db_path(&home).to_str().unwrap(),
        home.clone(),
    )
    .await
    .unwrap();
    let scout_root = tmp.join("scout-output");
    std::fs::create_dir_all(scout_root.join("main-footage")).unwrap();
    let worker_config_path = tmp.join("config.toml");
    std::fs::write(
        &worker_config_path,
        // TOML literal string: Windows backslashes must not be escape-processed.
        format!("[scout]\noutput_dir = '{}'\n", scout_root.to_string_lossy()),
    )
    .unwrap();
    let scout = thoth_server::scout::new_supervisor();
    let output_root = legacy_output_root(&home);
    let state = AppState {
        api_key: "test-key".into(),
        store: store.clone(),
        output_root: output_root.clone(),
        home,
        scout_output_config: thoth_jobs::ScoutOutputConfig::new(worker_config_path.clone()).unwrap(),
        worker_config_path,
        scout: scout.clone(),
        credentials: Arc::new(FakeCredentialProvider(HashSet::new())),
    };
    MainFootageApp {
        app: build_router(state),
        home_root: tmp,
        scout_root,
        output_root,
        scout,
        store,
    }
}

/// A Scout main-footage package generation (`<scout_root>/main-footage/vNNN`).
/// The manifest deliberately carries the `bytes` / `acquisition` members Scout
/// really writes (`scout/main_footage/source_package.ts`) — the summary route
/// must read it leniently, not through a `deny_unknown_fields` decode.
fn write_main_footage_package(scout_root: &std::path::Path, package_id: &str) -> PathBuf {
    let root = scout_root.join("main-footage").join(package_id);
    std::fs::create_dir_all(root.join("sources")).unwrap();
    std::fs::create_dir_all(root.join("scene-index")).unwrap();
    std::fs::write(root.join("sources/source-0.mp4"), vec![7u8; 2048]).unwrap();
    std::fs::write(root.join("sources/source-1.mp4"), vec![9u8; 1024]).unwrap();
    std::fs::write(root.join("scene-index/source-0.json"), b"{\"scenes\":[]}").unwrap();
    std::fs::write(
        root.join("package.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "post": {
                "id": "post-123",
                "canonical_url": "https://www.instagram.com/reel/post-123/",
                "platform": "instagram"
            },
            "analysis_identity": "analysis-2026-08-14",
            "created_at": "2026-08-14T12:00:00Z",
            "fingerprint": "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            "sources": [
                {
                    "id": "source-0",
                    "media_index": 0,
                    "path": "sources/source-0.mp4",
                    "checksum": "sha256:source0",
                    "bytes": 2048,
                    "acquisition": { "source": "ytdlp", "attempts": 1, "elapsed_ms": 120 },
                    "technical": {
                        "container": "mp4", "video_codec": "h264", "duration_sec": 12.5,
                        "width": 1080, "height": 1920, "has_audio": true
                    }
                },
                {
                    "id": "source-1",
                    "media_index": 1,
                    "path": "sources/source-1.mp4",
                    "checksum": "sha256:source1",
                    "bytes": 1024,
                    "acquisition": { "source": "ytdlp", "attempts": 2, "elapsed_ms": 340 },
                    "technical": {
                        "container": "mp4", "video_codec": "h264", "duration_sec": 7.5,
                        "width": 1080, "height": 1920, "has_audio": false
                    }
                }
            ],
            "ignored": [
                { "id": "media-2", "media_index": 2, "code": "photo_slide_ignored", "message": null }
            ],
            "unavailable": [
                { "id": "media-3", "media_index": 3, "code": "source_video_skipped", "message": null }
            ],
            "scene_indexes": [
                {
                    "source_id": "source-0",
                    "path": "scene-index/source-0.json",
                    "checksum": "sha256:index0",
                    "planning_mode": "degraded",
                    "scenes": []
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    root
}

/// Post-plan job artifacts as the pipeline lays them out (`pipeline/job.rs`).
fn write_main_footage_job_artifacts(root: &std::path::Path) {
    for dir in ["clips", "narration", "main-footage", "plans/v002", "cuts/v002"] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    std::fs::write(root.join("clips/final_concat.mp4"), vec![1u8; 512]).unwrap();
    std::fs::write(root.join("narration/narration.mp3"), vec![2u8; 256]).unwrap();
    std::fs::write(root.join("cuts/v002/cut-0.mp4"), vec![3u8; 128]).unwrap();
    std::fs::write(root.join("main-footage/source-package.json"), b"{}").unwrap();
    std::fs::write(
        root.join("narration/timeline.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "beats": [
                { "id": "b0", "start_sec": 0.0, "end_sec": 3.0 },
                { "id": "b1", "start_sec": 3.0, "end_sec": 6.0 },
                { "id": "b2", "start_sec": 6.0, "end_sec": 9.0 }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("plans/active.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "status": "verified",
            "version": "v002",
            "plan_path": "plans/v002/main-footage-plan.json"
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("plans/v002/main-footage-plan.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "timeline": [
                { "id": "cut-0", "reuse_count": 1 },
                { "id": "cut-1", "reuse_count": 0 }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("state.json"),
        serde_json::to_vec(&serde_json::json!({
            "job_id": "job-mf",
            "url": "https://www.instagram.com/reel/post-123/",
            "created_at": "2026-08-14T12:00:00Z",
            "updated_at": "2026-08-14T12:30:00Z",
            "stages": {
                "main_footage": {
                    "source_package_fingerprint": "sha256:aaa",
                    "narration_fingerprint": "sha256:bbb",
                    "plan_fingerprint": "sha256:ccc",
                    "active_version": "v002",
                    "planning_mode": "degraded",
                    "coverage_target": 0.6,
                    "main_coverage_sec": 18.0,
                    "main_coverage_ratio": 0.72,
                    "total_duration_sec": 25.0,
                    "selected_cut_count": 2,
                    "candidate_count": 9,
                    "transition_distribution": { "match_cut": 1, "cross_dissolve": 1 },
                    "warnings": ["exact_scene_reused", "transition_fallback"],
                    "retained_bytes": 4096,
                    "completed_at": "2026-08-14T12:30:00Z"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

/// Leak guard: no string anywhere in an operational summary may be a filesystem
/// absolute path, may contain one of the private roots, or may carry a
/// signed-URL credential. Applied to whole response bodies, not to a hand-picked
/// field, so a future field cannot quietly reintroduce the leak.
fn assert_no_private_paths(value: &serde_json::Value, forbidden: &[&std::path::Path]) {
    match value {
        serde_json::Value::String(text) => {
            assert!(
                !std::path::Path::new(text).is_absolute(),
                "summary leaked an absolute path: {text}"
            );
            for root in forbidden {
                let root = root.to_string_lossy().replace('\\', "/");
                assert!(
                    !text.replace('\\', "/").contains(root.as_str()),
                    "summary leaked a private root: {text}"
                );
            }
            for credential in ["token=", "signature=", "X-Amz-", "Expires="] {
                assert!(
                    !text.contains(credential),
                    "summary leaked a signed-URL credential ({credential}): {text}"
                );
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                assert_no_private_paths(item, forbidden);
            }
        }
        serde_json::Value::Object(fields) => {
            for item in fields.values() {
                assert_no_private_paths(item, forbidden);
            }
        }
        _ => {}
    }
}

/// Recursive file count + byte total, used by tests to prove cleanup emptied
/// exactly one tree and left its siblings untouched.
fn tree_inventory(root: &std::path::Path) -> (u64, u64) {
    let mut files = 0;
    let mut bytes = 0;
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let (nested_files, nested_bytes) = tree_inventory(&entry.path());
            files += nested_files;
            bytes += nested_bytes;
        } else {
            files += 1;
            bytes += meta.len();
        }
    }
    (files, bytes)
}

/// Directory link that `fs::canonicalize` follows. Windows symlinks need a
/// privilege this machine lacks; junctions do not. Either way the test HARD
/// FAILS rather than skipping if the link cannot be made — an escape guard no
/// test ever exercises has zero coverage however green the suite is.
fn link_dir(target: &std::path::Path, link: &std::path::Path) {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).expect("link parent must exist before linking");
    }
    #[cfg(windows)]
    {
        // `cmd` reads a leading `/` as a switch, so a path joined with forward
        // slashes ("…/escaped") makes mklink fail with `Invalid switch`.
        // Re-collecting the components rewrites them with the platform separator.
        let link: std::path::PathBuf = link.components().collect();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(target)
            .output()
            .expect("mklink must be runnable to test link escapes");
        assert!(
            output.status.success(),
            "could not create a directory junction at {link:?} — the escape guard is untested\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link)
            .expect("could not create a directory symlink — the escape guard is untested");
    }
}

fn api_request(method: &str, uri: &str, body: Option<serde_json::Value>) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", "Bearer test-key")
        .header("content-type", "application/json");
    match body {
        Some(body) => builder.body(Body::from(body.to_string())).unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

// --- package facts -----------------------------------------------------------

#[tokio::test]
async fn main_footage_package_summary_reports_counts_duration_and_bytes() {
    let harness = build_main_footage_app().await;
    write_main_footage_package(&harness.scout_root, "v001");

    let response = harness
        .app
        .clone()
        .oneshot(api_request("GET", "/api/scout/packages/v001/summary", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;

    assert_eq!(body["package_id"], "v001");
    assert_eq!(body["platform"], "instagram");
    assert_eq!(
        body["canonical_url"],
        "https://www.instagram.com/reel/post-123/"
    );
    assert_eq!(body["analysis_mode"], "degraded");
    assert_eq!(
        body["fingerprint"],
        "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
    );
    assert_eq!(body["usable_count"], 2);
    assert_eq!(body["skipped_count"], 1);
    assert_eq!(body["ignored_count"], 1);
    assert_eq!(body["total_duration_sec"], 20.0);
    assert_eq!(body["file_count"], 4);
    assert!(
        body["total_bytes"].as_u64().unwrap() >= 3072,
        "total_bytes must account for the on-disk sources: {body}"
    );
    assert_eq!(
        body["warnings"],
        serde_json::json!(["photo_slide_ignored", "source_video_skipped", "vision_degraded"])
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_summary_exposes_no_private_paths() {
    let harness = build_main_footage_app().await;
    write_main_footage_package(&harness.scout_root, "v001");

    let response = harness
        .app
        .clone()
        .oneshot(api_request("GET", "/api/scout/packages/v001/summary", None))
        .await
        .unwrap();
    let body = body_json(response).await;

    assert_no_private_paths(&body, &[&harness.scout_root, &harness.home_root]);
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_summary_rejects_unknown_package_id() {
    let harness = build_main_footage_app().await;

    let response = harness
        .app
        .clone()
        .oneshot(api_request("GET", "/api/scout/packages/v404/summary", None))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "package_not_found"
    );
    harness.cleanup();
}

// --- job facts ---------------------------------------------------------------

#[tokio::test]
async fn main_footage_job_manifest_reports_plan_facts_and_relative_artifacts() {
    let harness = build_main_footage_app().await;
    let job_root = harness.output_root.join("job-mf");
    write_main_footage_job_artifacts(&job_root);

    let response = harness
        .app
        .clone()
        .oneshot(api_request("GET", "/api/jobs/job-mf/manifest", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;

    assert_eq!(body["narration_timeline"], "narration/timeline.json");
    assert_eq!(body["source_package"], "main-footage/source-package.json");
    assert_eq!(body["active_plan"], "plans/v002/main-footage-plan.json");
    assert_eq!(body["cuts"], "cuts/v002");

    let facts = &body["main_footage"];
    assert_eq!(facts["active_plan_version"], "v002");
    assert_eq!(facts["planning_mode"], "degraded");
    assert_eq!(facts["coverage_target"], 0.6);
    assert_eq!(facts["coverage_actual"], 0.72);
    assert_eq!(facts["coverage_sec"], 18.0);
    assert_eq!(facts["total_duration_sec"], 25.0);
    assert_eq!(facts["beat_count"], 3);
    assert_eq!(facts["cut_count"], 2);
    assert_eq!(facts["reuse_count"], 1);
    assert_eq!(facts["candidate_count"], 9);
    assert_eq!(
        facts["transitions"],
        serde_json::json!({ "cross_dissolve": 1, "match_cut": 1 })
    );
    assert_eq!(
        facts["warnings"],
        serde_json::json!(["exact_scene_reused", "transition_fallback"])
    );
    assert_eq!(facts["retained_bytes"], 4096);

    assert_no_private_paths(&body, &[&harness.scout_root, &harness.home_root]);
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_job_manifest_omits_plan_facts_when_artifacts_are_absent() {
    let harness = build_main_footage_app().await;
    let job_root = harness.output_root.join("plain-job");
    std::fs::create_dir_all(job_root.join("clips")).unwrap();
    std::fs::write(job_root.join("clips/final_concat.mp4"), b"v").unwrap();

    let response = harness
        .app
        .clone()
        .oneshot(api_request("GET", "/api/jobs/plain-job/manifest", None))
        .await
        .unwrap();
    let body = body_json(response).await;

    assert_eq!(body["video"], "clips/final_concat.mp4");
    for absent in [
        "narration_timeline",
        "source_package",
        "active_plan",
        "cuts",
        "main_footage",
    ] {
        assert!(
            body.get(absent).is_none(),
            "`{absent}` must be omitted when the artifact does not exist: {body}"
        );
    }
    harness.cleanup();
}

// --- package cleanup: the confirmation IS the feature ------------------------

#[tokio::test]
async fn main_footage_package_cleanup_requires_confirmation() {
    let harness = build_main_footage_app().await;
    let package = write_main_footage_package(&harness.scout_root, "v001");

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/v001/cleanup",
            Some(serde_json::json!({})),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "cleanup_confirmation_required"
    );
    assert!(
        package.join("package.json").is_file(),
        "nothing may be deleted without a confirmation"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_rejects_mismatched_confirmation() {
    let harness = build_main_footage_app().await;
    let package = write_main_footage_package(&harness.scout_root, "v001");

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/v001/cleanup",
            Some(serde_json::json!({ "confirm": "v002" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "cleanup_confirmation_mismatch"
    );
    assert!(
        package.join("package.json").is_file(),
        "a confirmation naming another package may not delete this one"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_rejects_parent_traversal_id() {
    let harness = build_main_footage_app().await;
    write_main_footage_package(&harness.scout_root, "v001");

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/%2e%2e/cleanup",
            Some(serde_json::json!({ "confirm": ".." })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "invalid_package_id"
    );
    assert!(
        harness
            .scout_root
            .join("main-footage/v001/package.json")
            .is_file()
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_rejects_encoded_traversal_id() {
    let harness = build_main_footage_app().await;
    write_main_footage_package(&harness.scout_root, "v001");

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/%2e%2e%2fv001/cleanup",
            Some(serde_json::json!({ "confirm": "../v001" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "invalid_package_id"
    );
    assert!(
        harness
            .scout_root
            .join("main-footage/v001/package.json")
            .is_file()
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_rejects_path_separators_in_id() {
    let harness = build_main_footage_app().await;
    write_main_footage_package(&harness.scout_root, "v001");

    for (encoded, confirm) in [
        ("v001%2Fsources", "v001/sources"),
        ("v001%5Csources", "v001\\sources"),
    ] {
        let response = harness
            .app
            .clone()
            .oneshot(api_request(
                "POST",
                &format!("/api/scout/packages/{encoded}/cleanup"),
                Some(serde_json::json!({ "confirm": confirm })),
            ))
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "separator id `{confirm}` must be refused"
        );
        assert_eq!(
            body_json(response).await["error"]["code"],
            "invalid_package_id"
        );
    }
    assert!(
        harness
            .scout_root
            .join("main-footage/v001/sources/source-0.mp4")
            .is_file()
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_rejects_a_link_escaping_the_scout_root() {
    let harness = build_main_footage_app().await;
    let outside = harness.home_root.join("outside-package");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("precious.json"), b"{}").unwrap();
    link_dir(&outside, &harness.scout_root.join("main-footage/escaped"));

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/escaped/cleanup",
            Some(serde_json::json!({ "confirm": "escaped" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "invalid_package_id"
    );
    assert!(
        outside.join("precious.json").is_file(),
        "a link escaping the Scout root must never be followed into a delete"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_rejects_unknown_package_id() {
    let harness = build_main_footage_app().await;

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/v404/cleanup",
            Some(serde_json::json!({ "confirm": "v404" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "package_not_found"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_is_refused_while_scout_is_running() {
    let harness = build_main_footage_app().await;
    let package = write_main_footage_package(&harness.scout_root, "v001");
    {
        let mut run = harness.scout.lock().await;
        run.kind = Some(thoth_server::scout::ScoutKind::Run);
        run.status = thoth_server::scout::ScoutStatus::Running;
    }

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/v001/cleanup",
            Some(serde_json::json!({ "confirm": "v001" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(response).await["error"]["code"], "scout_busy");
    assert!(
        package.join("package.json").is_file(),
        "a package a running Scout command may still be writing must not be deleted"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_package_cleanup_removes_only_the_named_package() {
    let harness = build_main_footage_app().await;
    let doomed = write_main_footage_package(&harness.scout_root, "v001");
    let sibling = write_main_footage_package(&harness.scout_root, "v002");

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/scout/packages/v001/cleanup",
            Some(serde_json::json!({ "confirm": "v001" })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let report = body_json(response).await;

    assert_eq!(report["removed_files"], 4);
    assert!(report["removed_bytes"].as_u64().unwrap() >= 3072);
    assert_eq!(report["recoverable"], false);
    assert!(!doomed.exists(), "the named package must be gone");
    assert_eq!(
        tree_inventory(&sibling).0,
        4,
        "a sibling generation must survive"
    );
    assert!(
        harness.scout_root.join("main-footage").is_dir(),
        "cleanup must not remove the generations root itself"
    );
    harness.cleanup();
}

// --- job cleanup: artifacts go, the audit row stays --------------------------

async fn enqueue_running_job(harness: &MainFootageApp, id: &str) -> PathBuf {
    let root = harness.output_root.join(id);
    let spec = thoth_jobs::JobSpec {
        command: "run".into(),
        url: Some("https://www.instagram.com/reel/post-123/".into()),
        content_set: None,
        params: serde_json::json!({}),
    };
    harness
        .store
        .enqueue(id, &spec, &root.to_string_lossy())
        .await
        .unwrap();
    let claimed = harness
        .store
        .claim_next("test-worker")
        .await
        .unwrap()
        .expect("the freshly enqueued job must be claimable");
    assert_eq!(claimed.id, id, "claim_next must hand back the job under test");
    root
}

async fn enqueue_terminal_job(harness: &MainFootageApp, id: &str) -> PathBuf {
    let root = enqueue_running_job(harness, id).await;
    harness
        .store
        .finish_running(id, thoth_jobs::JobStatus::Succeeded, None, "done", None)
        .await
        .unwrap();
    root
}

#[tokio::test]
async fn main_footage_job_cleanup_requires_confirmation() {
    let harness = build_main_footage_app().await;
    let root = enqueue_terminal_job(&harness, "job-a").await;
    write_main_footage_job_artifacts(&root);

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/jobs/job-a/cleanup",
            Some(serde_json::json!({})),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "cleanup_confirmation_required"
    );
    assert!(
        root.join("state.json").is_file(),
        "nothing may be deleted without a confirmation"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_job_cleanup_rejects_mismatched_confirmation() {
    let harness = build_main_footage_app().await;
    let root = enqueue_terminal_job(&harness, "job-a").await;
    write_main_footage_job_artifacts(&root);

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/jobs/job-a/cleanup",
            Some(serde_json::json!({ "confirm": "job-b" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "cleanup_confirmation_mismatch"
    );
    assert!(
        root.join("state.json").is_file(),
        "a confirmation naming another job may not delete this one"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_job_cleanup_rejects_traversal_job_id() {
    let harness = build_main_footage_app().await;
    let root = enqueue_terminal_job(&harness, "job-a").await;
    write_main_footage_job_artifacts(&root);

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/jobs/%2e%2e/cleanup",
            Some(serde_json::json!({ "confirm": ".." })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(response).await["error"]["code"], "invalid_job_id");
    assert!(root.join("state.json").is_file());
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_job_cleanup_rejects_unknown_job_id() {
    let harness = build_main_footage_app().await;

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/jobs/job-missing/cleanup",
            Some(serde_json::json!({ "confirm": "job-missing" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(response).await["error"]["code"], "job_not_found");
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_job_cleanup_is_refused_while_the_job_is_not_terminal() {
    let harness = build_main_footage_app().await;
    let root = enqueue_running_job(&harness, "job-live").await;
    write_main_footage_job_artifacts(&root);

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/jobs/job-live/cleanup",
            Some(serde_json::json!({ "confirm": "job-live" })),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(response).await["error"]["code"],
        "job_not_terminal"
    );
    assert!(
        root.join("state.json").is_file(),
        "a live job's artifacts must survive"
    );
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_job_cleanup_removes_artifacts_but_retains_the_audit_row() {
    let harness = build_main_footage_app().await;
    let doomed = enqueue_terminal_job(&harness, "job-a").await;
    let sibling = enqueue_terminal_job(&harness, "job-b").await;
    write_main_footage_job_artifacts(&doomed);
    write_main_footage_job_artifacts(&sibling);
    let (expected_files, expected_bytes) = tree_inventory(&doomed);

    let response = harness
        .app
        .clone()
        .oneshot(api_request(
            "POST",
            "/api/jobs/job-a/cleanup",
            Some(serde_json::json!({ "confirm": "job-a" })),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let report = body_json(response).await;

    assert_eq!(report["removed_files"], expected_files);
    assert_eq!(report["removed_bytes"], expected_bytes);
    assert_eq!(report["recoverable"], false);
    assert!(!doomed.exists(), "the job artifact root must be gone");
    assert_eq!(
        tree_inventory(&sibling),
        (expected_files, expected_bytes),
        "a sibling job's artifacts must be untouched"
    );

    // The audit row survives with its terminal status, and the artifact
    // manifest is now empty — cleanup deletes files, never the record of the run.
    let job = harness
        .app
        .clone()
        .oneshot(api_request("GET", "/api/jobs/job-a", None))
        .await
        .unwrap();
    assert_eq!(job.status(), StatusCode::OK);
    assert_eq!(body_json(job).await["status"], "succeeded");
    assert_eq!(
        harness.store.get("job-a").await.unwrap().unwrap().status,
        thoth_jobs::JobStatus::Succeeded
    );
    assert!(
        !harness.store.events_since("job-a", 0).await.unwrap().is_empty(),
        "the job's event audit trail must survive artifact cleanup"
    );

    let manifest = harness
        .app
        .clone()
        .oneshot(api_request("GET", "/api/jobs/job-a/manifest", None))
        .await
        .unwrap();
    assert_eq!(&response_bytes(manifest).await[..], b"{}");
    harness.cleanup();
}

#[tokio::test]
async fn main_footage_cleanup_has_no_background_or_age_based_path() {
    // Retained main footage is expensive, which is exactly the pressure that
    // grows an "expire after N days" timer. There must be none: artifacts
    // stamped at the epoch survive the server's only background task (the
    // stale-job reaper), and only an explicit confirmed call removes them.
    let harness = build_main_footage_app().await;
    let job_root = enqueue_terminal_job(&harness, "job-old").await;
    write_main_footage_job_artifacts(&job_root);
    let package = write_main_footage_package(&harness.scout_root, "v001");
    for stamped in [job_root.join("state.json"), package.join("package.json")] {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&stamped)
            .unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
            .unwrap();
    }

    thoth_server::reaper::spawn_reaper(harness.store.clone(), 1, 0);
    tokio::time::sleep(Duration::from_millis(1300)).await;

    assert!(
        job_root.join("state.json").is_file(),
        "no background pass may delete job artifacts by age"
    );
    assert_eq!(
        tree_inventory(&job_root).0,
        8,
        "no background pass may thin the job artifact tree"
    );
    assert_eq!(
        tree_inventory(&package).0,
        4,
        "no background pass may delete Scout package files by age"
    );
    harness.cleanup();
}
