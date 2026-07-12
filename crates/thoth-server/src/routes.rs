use std::{convert::Infallible, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, Sse},
    Json,
};
use futures_util::stream::Stream;
use serde::Deserialize;

use crate::auth::AppState;
use thoth_jobs::{JobRecord, JobSpec, JobStatus};

#[derive(Deserialize)]
pub struct StreamQuery {
    pub token: String,
    /// Explicit resume cursor for non-EventSource clients (EventSource uses the
    /// `Last-Event-ID` header, which wins over this).
    #[serde(default)]
    pub after: Option<i64>,
}

pub async fn create_job(
    State(state): State<AppState>,
    Json(spec): Json<JobSpec>,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    // The worker creates the output dir when it actually runs the job; the
    // server only records intent. output_dir is `output_root/<job_id>` so the
    // artifact route (which serves `output_root/<id>`) and the worker agree.
    let job_id = uuid::Uuid::new_v4().to_string();
    let out = state.output_root.join(&job_id);
    state
        .store
        .enqueue(&job_id, &spec, &out.to_string_lossy())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "job_id": job_id }))))
}

pub async fn list_jobs(State(state): State<AppState>) -> Result<Json<Vec<JobRecord>>, StatusCode> {
    state
        .store
        .list()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<JobRecord>, StatusCode> {
    state
        .store
        .get(&id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Cancel a job. A queued job is finished immediately (it never started);
/// a running job gets a cooperative cancel flag the worker polls (there is no
/// process to signal — the worker is an independent peer). Terminal jobs 409.
pub async fn cancel_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let job = state
        .store
        .get(&id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    match job.status {
        JobStatus::Queued => {
            state
                .store
                .finish(&id, JobStatus::Cancelled, Some("cancelled before start"))
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            state
                .store
                .append_event(&id, "error", None, None, Some("cancelled"))
                .await
                .ok();
        }
        JobStatus::Running => {
            state
                .store
                .request_cancel(&id)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        _ => return Err(StatusCode::CONFLICT),
    }
    Ok(StatusCode::ACCEPTED)
}

/// SSE relay: tail `job_events` by autoincrement `seq`. This is the entire
/// progress channel now — the server has no in-process handle to the worker, so
/// it polls the shared DB. `Last-Event-ID` (or `?after=`) resumes after a drop;
/// the stream closes once a `done`/`error` event lands.
///
/// Mounted OUTSIDE the bearer layer (EventSource can't send headers) — it
/// self-authenticates via `?token=<api_key>`.
pub async fn stream_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<StreamQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    if q.token != state.api_key {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if state
        .store
        .get(&id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_none()
    {
        return Err(StatusCode::NOT_FOUND);
    }

    // Resume cursor: Last-Event-ID header (set automatically by EventSource on
    // reconnect) wins; `?after=` is the explicit fallback for manual clients.
    let mut last_seq: i64 = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .or(q.after)
        .unwrap_or(0);

    let store = state.store.clone();
    let stream = async_stream::stream! {
        loop {
            let Ok(events) = store.events_since(&id, last_seq).await else {
                break;
            };
            let mut terminal = false;
            for ev in events {
                last_seq = ev.seq;
                if ev.kind == "done" || ev.kind == "error" {
                    terminal = true;
                }
                let data = serde_json::to_string(&ev).unwrap_or_default();
                yield Ok(Event::default().id(ev.seq.to_string()).data(data));
                if terminal {
                    break;
                }
            }
            if terminal {
                break;
            }
            // SQLite has no LISTEN/NOTIFY — poll. ~400ms is the SSE progress
            // granularity the fully-decoupled design trades for independence.
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    };
    Ok(Sse::new(stream))
}

/// Extension → content-type. Not exhaustive — just the artifact kinds Thoth
/// produces (video, images, subtitle/metadata sidecars). Falls back to
/// octet-stream, which every browser handles as a download.
fn guess_content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "json" => "application/json",
        "srt" | "vtt" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub async fn get_artifact(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
) -> Result<([(axum::http::HeaderName, &'static str); 1], Vec<u8>), StatusCode> {
    // Only plain filename components may compose the served path. This rejects
    // `..` (ParentDir), backslash-as-separator traversal, and absolute/prefix
    // forms (`C:\`, `/`) — all of which would otherwise escape output_root on
    // Windows. A `/`-only string check does not, so build the relative path and
    // require every component (of both `id` and `path`) to be Normal.
    let rel = std::path::Path::new(&id).join(&path);
    if rel
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let full = state.output_root.join(&rel);
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let content_type = guess_content_type(&full);
    Ok((
        [(axum::http::header::CONTENT_TYPE, content_type)],
        bytes,
    ))
}
