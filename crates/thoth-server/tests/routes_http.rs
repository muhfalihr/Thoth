// Integration test: drives the router in-process via `oneshot` (no socket
// bind — port 8787 may be occupied on this machine). Covers the REST surface:
// auth gating, job creation, listing, artifact traversal guard, SSE tailing.
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use thoth_server::{auth::AppState, build_router};

// Returns the router + the temp dir (which holds the SQLite DB) so tests that
// need to seed events directly can reopen the same DB via `tmp.join("t.db")`.
async fn build_test_app() -> (axum::Router, PathBuf) {
    let tmp = std::env::temp_dir().join(format!("thoth-routes-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let store = thoth_jobs::JobStore::connect(tmp.join("t.db").to_str().unwrap())
        .await
        .unwrap();
    let state = AppState {
        api_key: "test-key".into(),
        store,
        output_root: tmp.clone(),
        config_path: tmp.join("config.toml"),
        scout: thoth_server::scout::new_supervisor(),
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
async fn cancel_job_queued_is_accepted_and_emits_one_cancelled_event() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(tmp.join("t.db").to_str().unwrap())
        .await
        .unwrap();
    enqueue_test_job(&store, "queued-job").await;

    let res = app.oneshot(cancel_job_request("queued-job")).await.unwrap();

    assert_eq!(res.status(), StatusCode::ACCEPTED);
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
async fn cancel_job_running_is_accepted_and_sets_flag() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(tmp.join("t.db").to_str().unwrap())
        .await
        .unwrap();
    enqueue_test_job(&store, "running-job").await;
    store.claim_next("worker-1").await.unwrap().unwrap();

    let res = app.oneshot(cancel_job_request("running-job")).await.unwrap();

    assert_eq!(res.status(), StatusCode::ACCEPTED);
    let job = store.get("running-job").await.unwrap().unwrap();
    assert_eq!(job.status, thoth_jobs::JobStatus::Running);
    assert!(job.cancel_requested);
    assert!(store.events_since("running-job", 0).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancel_job_repeated_running_request_is_accepted() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(tmp.join("t.db").to_str().unwrap())
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

    assert_eq!(first.status(), StatusCode::ACCEPTED);
    assert_eq!(second.status(), StatusCode::ACCEPTED);
    let job = store.get("repeated-job").await.unwrap().unwrap();
    assert_eq!(job.status, thoth_jobs::JobStatus::Running);
    assert!(job.cancel_requested);
    assert!(store.events_since("repeated-job", 0).await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn cancel_job_terminal_returns_conflict() {
    let (app, tmp) = build_test_app().await;
    let store = thoth_jobs::JobStore::connect(tmp.join("t.db").to_str().unwrap())
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
    let store = thoth_jobs::JobStore::connect(tmp.join("t.db").to_str().unwrap())
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
    let job = tmp.join(id);
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
    let job = tmp.join(id);
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
    let store = thoth_jobs::JobStore::connect(tmp.join("t.db").to_str().unwrap())
        .await
        .unwrap();
    let scout = thoth_server::scout::new_supervisor();
    scout.lock().await.last_content_set = Some(cs);
    let state = AppState {
        api_key: "test-key".into(),
        store,
        output_root: tmp.clone(),
        config_path: tmp.join("config.toml"),
        scout,
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
