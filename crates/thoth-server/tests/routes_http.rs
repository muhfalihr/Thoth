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
    let state = AppState {
        api_key: "test-key".into(),
        store,
        output_root: legacy_output_root(&home),
        home,
        worker_config_path: tmp.join("config.toml"),
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
async fn config_get_put_roundtrip_and_validation() {
    let (app, tmp) = build_test_app().await;
    let cfg = tmp.join("config.toml");
    std::fs::write(&cfg, "[llm]\nprovider = \"novita\"\n").unwrap();

    // GET returns the seeded text.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/config")
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["text"].as_str().unwrap().contains("novita"), "body: {v}");

    // PUT invalid TOML → 400, file unchanged.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/config")
                .header("authorization", "Bearer test-key")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"this = = broken"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert!(std::fs::read_to_string(&cfg).unwrap().contains("novita"));

    // PUT valid TOML → 200, file updated.
    let res = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/config")
                .header("authorization", "Bearer test-key")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"[llm]\nprovider = \"groq\"\n"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(std::fs::read_to_string(&cfg).unwrap().contains("groq"));
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

#[tokio::test]
async fn style_profiles_lists_names() {
    let (app, tmp) = build_test_app().await;
    std::fs::write(
        tmp.join("config.toml"),
        "[styles.profiles.tiktok_id_2025]\nx = 1\n[styles.profiles.drama]\ny = 2\n",
    )
    .unwrap();
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/style-profiles")
                .header("authorization", "Bearer test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let names: Vec<String> = serde_json::from_slice(&body).unwrap();
    assert!(names.contains(&"tiktok_id_2025".to_string()), "names: {names:?}");
    assert!(names.contains(&"drama".to_string()), "names: {names:?}");
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
    let state = AppState {
        api_key: "test-key".into(),
        store,
        output_root: legacy_output_root(&home),
        home,
        worker_config_path: tmp.join("config.toml"),
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
