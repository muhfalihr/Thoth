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
use crate::scout::{self, DiscoverReq, RunReq, ScoutKind, ValidateReq};
use thoth_jobs::{CancelRequestOutcome, JobRecord, JobSpec};

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

/// Cancel a job. A queued job is cancelled atomically (it never started); a
/// running job gets a cooperative cancel flag the worker polls (there is no
/// process to signal — the worker is an independent peer). Terminal jobs 409.
pub async fn cancel_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    match state
        .store
        .request_cancel(&id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        CancelRequestOutcome::QueuedCancelled
        | CancelRequestOutcome::RunningRequested
        | CancelRequestOutcome::AlreadyRequested => Ok(StatusCode::ACCEPTED),
        CancelRequestOutcome::Terminal(_) => Err(StatusCode::CONFLICT),
        CancelRequestOutcome::NotFound => Err(StatusCode::NOT_FOUND),
    }
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

#[derive(Deserialize)]
pub struct ScoutStreamQuery {
    pub token: String,
    #[serde(default)]
    pub since: u64,
}

/// Query auth for the image route: `<img>` cannot send the bearer header, so this
/// route self-authenticates via `?token=` (mirrors `ScoutStreamQuery`). `token` is
/// optional so a request with NO query string reaches the handler (→ 401) instead of
/// being rejected as a 400 by the extractor before auth runs.
#[derive(Deserialize)]
pub struct ImgToken {
    #[serde(default)]
    pub token: Option<String>,
}

/// SSE relay for the in-memory scout run log. Same shape as `stream_job` but
/// polls `state.scout` (a live process's stdout lines) instead of the SQLite
/// job-events table — there's no DB row for scout runs, just the supervisor's
/// `Vec<LogLine>`.
///
/// Mounted OUTSIDE the bearer layer (EventSource can't send headers); it
/// self-authenticates via `?token=<api_key>`.
pub async fn scout_stream(
    State(state): State<AppState>,
    Query(q): Query<ScoutStreamQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    if q.token != state.api_key {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let mut next = q.since;
    let scout = state.scout.clone();
    let stream = async_stream::stream! {
        loop {
            let (batch, terminal) = {
                let run = scout.lock().await;
                let batch: Vec<_> = run.lines.iter().filter(|l| l.seq >= next).cloned().collect();
                let terminal = matches!(run.status, scout::ScoutStatus::Done | scout::ScoutStatus::Failed);
                (batch, terminal)
            };
            let empty = batch.is_empty();
            for line in batch {
                next = line.seq + 1;
                let data = serde_json::to_string(&line).unwrap_or_default();
                yield Ok(Event::default().id(line.seq.to_string()).data(data));
            }
            if terminal && empty {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
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

/// Relpaths (relative to `output_root/<id>`) of review artifacts that exist for
/// a finished job. Every field is `None` until the file is produced, so an
/// unfinished/absent job yields `{}`. Fetch each via `/api/artifacts/:id/<rel>`.
#[derive(serde::Serialize, Default)]
pub struct Manifest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moments: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub narration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
}

// ponytail: this mirrors the thoth-core JobPaths sub-layout (clips/ analyze/
// narration/ transcribe/). The server has no dep on thoth-core, so nothing
// forces them in sync — the integration test below guards against drift.
pub async fn get_manifest(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<Manifest> {
    // Same trust boundary as get_artifact: the `:id` segment must be a single
    // plain component. Reject `..`/backslash/absolute forms (incl. percent-
    // encoded) so a crafted id can't probe files outside output_root. Invalid
    // id → empty manifest (contract is always-200, absent job → {}).
    if std::path::Path::new(&id)
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Json(Manifest::default());
    }
    let root = state.output_root.join(&id);
    let rel = |p: &str| -> Option<String> {
        root.join(p).is_file().then(|| p.to_string())
    };

    // Prefer the multi-clip concat; else newest single clip.
    let video = rel("clips/final_concat.mp4").or_else(|| newest_clip(&root));
    // Thumbnail shares the video's basename with a `.jpg` extension.
    let thumbnail = video.as_deref().and_then(|v| {
        let t = format!("{}.jpg", v.strip_suffix(".mp4")?);
        root.join(&t).is_file().then_some(t)
    });

    Json(Manifest {
        video,
        thumbnail,
        moments: rel("analyze/moments.json"),
        narration: rel("narration/narration.mp3"),
        transcript: rel("transcribe/transcript.json"),
    })
}

/// Newest `clips/clip_*.mp4` as a relpath (single-clip runs have no concat).
fn newest_clip(root: &std::path::Path) -> Option<String> {
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in std::fs::read_dir(root.join("clips")).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("clip_") && name.ends_with(".mp4") {
            if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                if best.as_ref().map_or(true, |(t, _)| mtime > *t) {
                    best = Some((mtime, format!("clips/{name}")));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

#[derive(serde::Deserialize)]
pub struct ConfigBody {
    pub text: String,
}

/// Raw config.toml text (empty string if the file is absent).
pub async fn get_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let text = std::fs::read_to_string(&state.config_path).unwrap_or_default();
    Json(serde_json::json!({ "text": text }))
}

/// Validate as TOML, then overwrite config.toml. Invalid TOML → 400, no write.
pub async fn put_config(
    State(state): State<AppState>,
    Json(body): Json<ConfigBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(e) = toml::from_str::<toml::Value>(&body.text) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e.to_string() })),
        );
    }
    match std::fs::write(&state.config_path, &body.text) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ),
    }
}

/// Names of the `[styles.profiles.*]` tables, for the dashboard dropdown.
/// Parse error / missing section → empty list.
pub async fn get_style_profiles(State(state): State<AppState>) -> Json<Vec<String>> {
    let text = std::fs::read_to_string(&state.config_path).unwrap_or_default();
    let names = toml::from_str::<toml::Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("styles")?
                .get("profiles")?
                .as_table()
                .map(|t| t.keys().cloned().collect::<Vec<_>>())
        })
        .unwrap_or_default();
    Json(names)
}

pub async fn scout_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let attached = scout::cdp_attached().await;
    let run = state.scout.lock().await.status_dto();
    Json(serde_json::json!({
        "browser_attached": attached,
        "cdp_base": scout::cdp_base(),
        "run": run,
    }))
}

fn busy(kind: Option<ScoutKind>) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({ "error": "a scout command is already running", "busy_kind": kind })),
    )
}

fn accepted() -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::ACCEPTED, Json(serde_json::json!({ "ok": true })))
}

pub async fn scout_browser_start(
    State(state): State<AppState>,
) -> (StatusCode, Json<serde_json::Value>) {
    let kind = state.scout.lock().await.kind;
    match scout::start(&state.scout, ScoutKind::Browser, vec![]).await {
        Ok(()) => accepted(),
        Err(()) => busy(kind),
    }
}

pub async fn scout_discover(
    State(state): State<AppState>,
    Json(req): Json<DiscoverReq>,
) -> (StatusCode, Json<serde_json::Value>) {
    let args = scout::build_scout_args(ScoutKind::Discover, Some(&req), None, None);
    let kind = state.scout.lock().await.kind;
    match scout::start(&state.scout, ScoutKind::Discover, args[1..].to_vec()).await {
        Ok(()) => accepted(),
        Err(()) => busy(kind),
    }
}

pub async fn scout_run(
    State(state): State<AppState>,
    Json(req): Json<RunReq>,
) -> (StatusCode, Json<serde_json::Value>) {
    if req.url.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "url required" })),
        );
    }
    // Remember where this run writes its content-set BEFORE spawning.
    let cs = scout::resolve_content_set(req.out.as_deref());
    let args = scout::build_scout_args(ScoutKind::Run, None, Some(&req), None);
    let kind = state.scout.lock().await.kind;
    match scout::start(&state.scout, ScoutKind::Run, args[1..].to_vec()).await {
        Ok(()) => {
            state.scout.lock().await.last_content_set = Some(cs);
            accepted()
        }
        Err(()) => busy(kind),
    }
}

pub async fn scout_validate(
    State(state): State<AppState>,
    Json(req): Json<ValidateReq>,
) -> (StatusCode, Json<serde_json::Value>) {
    if req.set.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "set required" })),
        );
    }
    let args = scout::build_scout_args(ScoutKind::Validate, None, None, Some(&req));
    let kind = state.scout.lock().await.kind;
    match scout::start(&state.scout, ScoutKind::Validate, args[1..].to_vec()).await {
        Ok(()) => accepted(),
        Err(()) => busy(kind),
    }
}

pub async fn scout_cancel(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    if scout::cancel(&state.scout).await {
        accepted()
    } else {
        (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "no scout command running" })),
        )
    }
}

/// Raw parse of `reel_topics.json`; `[]` if absent, unreadable, or not a JSON array.
pub async fn scout_topics() -> Json<serde_json::Value> {
    let text = std::fs::read_to_string(scout::TOPICS_FILE).unwrap_or_default();
    let v = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .filter(|v| v.is_array())
        .unwrap_or_else(|| serde_json::json!([]));
    Json(v)
}

pub async fn scout_content_set(State(state): State<AppState>) -> Json<serde_json::Value> {
    let path = state
        .scout
        .lock()
        .await
        .last_content_set
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from(scout::DEFAULT_CONTENT_SET));
    let exists = path.exists();
    Json(serde_json::json!({ "path": path.to_string_lossy(), "exists": exists }))
}

/// Resolve the content-set path the operator is working on: the last one a scout
/// command produced (`last_content_set`), else the canonical default. Shared by the
/// data + save handlers so they always agree on which file is "current".
async fn current_content_set_path(state: &AppState) -> std::path::PathBuf {
    state
        .scout
        .lock()
        .await
        .last_content_set
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from(scout::DEFAULT_CONTENT_SET))
}

/// GET /api/scout/content-set/data — read the current content-set for editing.
/// Returns the verbatim parsed JSON (`content`) plus `output_root` so the client can
/// turn absolute local `image_path`s into servable URLs. `content` is null with
/// `error="malformed"` when the file exists but is not valid JSON; `exists=false`
/// when it is absent (not an error).
pub async fn scout_content_set_data(State(state): State<AppState>) -> Json<serde_json::Value> {
    let path = current_content_set_path(&state).await;
    let path_str = path.to_string_lossy().into_owned();
    let output_root = std::env::current_dir()
        .map(|d| d.join(scout::SCOUT_OUTPUT_DIR).to_string_lossy().into_owned())
        .unwrap_or_else(|_| scout::SCOUT_OUTPUT_DIR.to_string());
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(content) => Json(serde_json::json!({
                "path": path_str, "exists": true, "output_root": output_root,
                "content": content, "error": serde_json::Value::Null,
            })),
            Err(_) => Json(serde_json::json!({
                "path": path_str, "exists": true, "output_root": output_root,
                "content": serde_json::Value::Null, "error": "malformed",
            })),
        },
        Err(_) => Json(serde_json::json!({
            "path": path_str, "exists": false, "output_root": output_root,
            "content": serde_json::Value::Null, "error": serde_json::Value::Null,
        })),
    }
}

/// PUT /api/scout/content-set — overwrite the current content-set in place.
/// Parses a COPY of the body only to shape-guard it, then persists the received
/// bytes verbatim (no re-serialize) so formatting, key order, and any field the
/// Rust side does not model all survive. Renderability is confirmed separately by
/// the client re-running `scout validate` after a successful save.
pub async fn scout_content_set_save(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let bad = |m: &str| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m })),
        )
    };
    let v: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| bad(&format!("invalid JSON: {e}")))?;
    let obj = v
        .as_object()
        .ok_or_else(|| bad("content-set must be a JSON object"))?;
    if !obj.contains_key("main") {
        return Err(bad("content-set is missing `main`"));
    }
    for key in ["footage", "comments", "figures", "references"] {
        if let Some(field) = obj.get(key) {
            if !field.is_array() {
                return Err(bad(&format!("`{key}` must be an array")));
            }
        }
    }
    let path = current_content_set_path(&state).await;
    tokio::fs::write(&path, &body).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("write failed: {e}") })),
        )
    })?;
    Ok(Json(serde_json::json!({
        "ok": true, "path": path.to_string_lossy(),
    })))
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

/// GET /api/scout/output/*path — serve a local scout artifact (crop PNGs, post-crop
/// images) to the browser. Token-guarded via `?token=`; path is confined to
/// `scout/output/` by a `Component::Normal` traversal guard (mirrors `get_artifact`).
/// `<img>` cannot send the bearer header, so this route mounts OUTSIDE the bearer layer.
pub async fn scout_output_file(
    State(state): State<AppState>,
    Path(rel): Path<String>,
    Query(q): Query<ImgToken>,
) -> Result<([(axum::http::HeaderName, &'static str); 1], Vec<u8>), StatusCode> {
    if q.token.as_deref() != Some(state.api_key.as_str()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let rel_path = std::path::Path::new(&rel);
    if rel_path
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let full = std::path::Path::new(scout::SCOUT_OUTPUT_DIR).join(rel_path);
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let content_type = guess_content_type(&full);
    Ok(([(axum::http::header::CONTENT_TYPE, content_type)], bytes))
}
