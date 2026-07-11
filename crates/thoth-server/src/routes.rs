use std::convert::Infallible;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::sse::{Event, Sse},
    Json,
};
use futures_util::stream::Stream;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::AppState;
use crate::executor;
use crate::job::{JobRecord, JobSpec, JobStatus, SseEvent};

pub async fn create_job(
    State(state): State<AppState>,
    Json(spec): Json<JobSpec>,
) -> Result<(StatusCode, Json<serde_json::Value>), StatusCode> {
    let id = uuid::Uuid::new_v4().to_string();
    let out = state.output_root.join(&id);
    if std::fs::create_dir_all(&out).is_err() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let rec = JobRecord {
        id: id.clone(),
        spec,
        status: JobStatus::Queued,
        stage: None,
        pct: 0.0,
        error: None,
        created_at: now.clone(),
        updated_at: now,
        output_dir: out.to_string_lossy().into_owned(),
    };
    state
        .store
        .put(&rec)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // POST doesn't stream — the client opens GET /jobs/:id/stream separately.
    // Bind-and-drop keeps this a zero-warning build (the receiver is unused).
    let _ = executor::spawn_job(state.clone(), rec).await;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "job_id": id }))))
}

pub async fn list_jobs(State(state): State<AppState>) -> Json<Vec<JobRecord>> {
    Json(state.store.list().unwrap_or_default())
}

pub async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<JobRecord>, StatusCode> {
    state
        .store
        .get(&id)
        .ok()
        .flatten()
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

pub async fn cancel_job(State(state): State<AppState>, Path(id): Path<String>) -> StatusCode {
    if let Some(h) = state.jobs.lock().await.get(&id) {
        h.cancel.cancel();
        StatusCode::ACCEPTED
    } else {
        StatusCode::NOT_FOUND
    }
}

#[derive(Deserialize)]
pub struct StreamAuth {
    pub token: String,
}

/// Terminal `SseEvent` derived from a stored `JobRecord` snapshot — used both
/// when a client streams an already-finished job, and when the live handle
/// vanished between our snapshot read and the jobs-map lock (the job
/// finished in that window; `executor::spawn_job` always writes the terminal
/// store record before removing the handle, so the store is authoritative).
fn terminal_event(rec: &JobRecord) -> SseEvent {
    let failed = rec.status == JobStatus::Failed;
    SseEvent {
        kind: if failed { "error" } else { "done" }.into(),
        job_id: rec.id.clone(),
        stage: rec.stage.clone(),
        pct: if failed { None } else { Some(rec.pct) },
        message: rec.error.clone(),
        ts: rec.updated_at.clone(),
    }
}

pub async fn stream_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<StreamAuth>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    // EventSource can't set headers → authenticate via query-param token.
    if q.token != state.api_key {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let snapshot = state
        .store
        .get(&id)
        .ok()
        .flatten()
        .ok_or(StatusCode::NOT_FOUND)?;
    let terminal = matches!(snapshot.status, JobStatus::Succeeded | JobStatus::Failed);

    // Only subscribe if the job might still be live. `resolved` defaults to
    // the snapshot we already have; if the handle vanished under us we
    // re-read the store for the freshest terminal record instead.
    let mut live_rx = None;
    let mut resolved = snapshot.clone();
    if !terminal {
        let jobs = state.jobs.lock().await;
        match jobs.get(&id) {
            Some(h) => live_rx = Some(h.tx.subscribe()),
            None => {
                resolved = state.store.get(&id).ok().flatten().unwrap_or(resolved);
            }
        }
    }

    let snapshot_json = serde_json::to_string(&snapshot).unwrap_or_default();
    let stream = async_stream::stream! {
        yield Ok(Event::default().event("snapshot").data(snapshot_json));

        match live_rx {
            Some(mut rx) => loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let is_terminal = ev.kind == "done" || ev.kind == "error";
                        let data = serde_json::to_string(&ev).unwrap_or_default();
                        yield Ok(Event::default().data(data));
                        if is_terminal {
                            break;
                        }
                    }
                    // Lagged = we fell behind the broadcast buffer, NOT the
                    // end of the job — a live job's stream must not
                    // truncate here.
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            },
            None => {
                let ev = terminal_event(&resolved);
                let data = serde_json::to_string(&ev).unwrap_or_default();
                yield Ok(Event::default().data(data));
            }
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
    if path.split('/').any(|seg| seg == "..") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let full = state.output_root.join(&id).join(&path);
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let content_type = guess_content_type(&full);
    Ok((
        [(axum::http::header::CONTENT_TYPE, content_type)],
        bytes,
    ))
}
