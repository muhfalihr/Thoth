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
    };
    (build_router(state), tmp)
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
    std::fs::create_dir_all(job.join("clips")).unwrap();
    std::fs::create_dir_all(job.join("analyze")).unwrap();
    std::fs::write(job.join("clips/final_concat.mp4"), b"x").unwrap();
    std::fs::write(job.join("analyze/moments.json"), b"{}").unwrap();

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
    assert!(m.get("narration").is_none()); // absent → omitted
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
