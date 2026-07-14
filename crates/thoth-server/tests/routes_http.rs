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
