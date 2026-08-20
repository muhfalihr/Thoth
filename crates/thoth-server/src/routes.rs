use std::{
    convert::Infallible,
    fs,
    path::{Path as FsPath, PathBuf},
    time::Duration,
};

use axum::{
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response, sse::{Event, Sse}},
    Json,
};
use futures_util::stream::Stream;
use serde::Deserialize;

use crate::auth::AppState;
use crate::scout::{self, DiscoverReq, RunReq, ScoutKind, ValidateReq};
use thoth_jobs::{
    CancelRequestOutcome, EnqueueRequest, JobRecord, JobSpec, JobStore, ProfileRecord,
    ProfileSettings, ResolvedSettings, ResourceError, RunOverrides, ScoutOutputConfig,
    resolve_settings, validate_job_spec, validate_settings,
};
use thoth_types::main_footage::{MainFootageDescriptor, SourcePackageV1};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateProjectBody {
    pub name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateProjectBody {
    pub name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateProfileBody {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub settings: ProfileSettings,
    #[serde(default)]
    pub credential_ref: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateProfileBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub settings: Option<ProfileSettings>,
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub credential_ref: Option<Option<String>>,
}

fn deserialize_present_option<'de, D, T>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DuplicateProfileBody {
    pub name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidateProfileBody {
    #[serde(default)]
    pub settings: Option<ProfileSettings>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateProjectJobBody {
    pub profile_id: String,
    #[serde(default)]
    pub overrides: RunOverrides,
}

fn resource_error_response(error: ResourceError) -> Response {
    match error {
        ResourceError::NotFound => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not_found" })),
        )
            .into_response(),
        ResourceError::DuplicateName => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "duplicate_name" })),
        )
            .into_response(),
        ResourceError::Validation { message } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": "validation_failed",
                "message": message,
            })),
        )
            .into_response(),
        ResourceError::ActiveJobs => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "active_jobs" })),
        )
            .into_response(),
        ResourceError::Storage(source) => {
            tracing::error!(error = ?source, "project/profile storage operation failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal_error" })),
            )
                .into_response()
        }
    }
}

fn request_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    match body {
        Ok(Json(body)) => Ok(body),
        Err(_) => Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": "invalid_request" })),
        )
            .into_response()),
    }
}

fn validation_error_response(error: anyhow::Error) -> Response {
    resource_error_response(ResourceError::Validation {
        message: error.to_string(),
    })
}

#[derive(Debug)]
struct ValidationError {
    code: &'static str,
}

impl ValidationError {
    fn source_package_invalid() -> Self {
        Self {
            code: "source_package_invalid",
        }
    }
}

fn coded_validation(status: StatusCode, code: &'static str) -> Response {
    (status, Json(serde_json::json!({ "error": { "code": code } }))).into_response()
}

fn canonical_scout_output_root(config: &ScoutOutputConfig) -> Result<PathBuf, ValidationError> {
    let cwd = std::env::current_dir().map_err(|_| ValidationError::source_package_invalid())?;
    let configured = config.resolve();
    let configured = if configured.is_absolute() {
        configured
    } else {
        cwd.join(configured)
    };
    fs::canonicalize(configured).map_err(|_| ValidationError::source_package_invalid())
}

fn inspect_main_footage_descriptor(
    content_set_path: &FsPath,
    scout_output_root: &FsPath,
) -> Result<Option<MainFootageDescriptor>, ValidationError> {
    let bytes = fs::read(content_set_path).map_err(|_| ValidationError::source_package_invalid())?;
    let content_set: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| ValidationError::source_package_invalid())?;
    let Some(descriptor_value) = content_set.get("main_footage") else {
        return Ok(None);
    };
    let descriptor: MainFootageDescriptor = serde_json::from_value(descriptor_value.clone())
        .map_err(|_| ValidationError::source_package_invalid())?;

    let content_set_parent = content_set_path
        .parent()
        .ok_or_else(ValidationError::source_package_invalid)?;
    let package_path = fs::canonicalize(content_set_parent.join(&descriptor.package_manifest))
        .map_err(|_| ValidationError::source_package_invalid())?;
    if !package_path.starts_with(scout_output_root) {
        return Err(ValidationError::source_package_invalid());
    }

    let source_package: SourcePackageV1 = serde_json::from_slice(
        &fs::read(package_path).map_err(|_| ValidationError::source_package_invalid())?,
    )
    .map_err(|_| ValidationError::source_package_invalid())?;
    let main_url = content_set
        .get("main")
        .and_then(|main| main.get("url"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(ValidationError::source_package_invalid)?;
    if source_package.post.canonical_url != main_url {
        return Err(ValidationError::source_package_invalid());
    }
    Ok(Some(descriptor))
}

fn validate_forced_main_profile(
    content_set_path: &FsPath,
    resolved_settings: &ResolvedSettings,
    scout_output_root: &FsPath,
) -> Result<(), ValidationError> {
    if inspect_main_footage_descriptor(content_set_path, scout_output_root)?.is_some()
        && !resolved_settings.narration.enabled
    {
        return Err(ValidationError {
            code: "forced_main_narration_required",
        });
    }
    Ok(())
}

async fn scoped_profile(
    store: &JobStore,
    project_id: &str,
    profile_id: &str,
) -> Result<ProfileRecord, ResourceError> {
    let profile = store
        .get_profile(profile_id)
        .await?
        .ok_or(ResourceError::NotFound)?;
    if profile.project_id != project_id {
        return Err(ResourceError::NotFound);
    }
    Ok(profile)
}

pub async fn create_project(
    State(state): State<AppState>,
    body: Result<Json<CreateProjectBody>, JsonRejection>,
) -> Response {
    let body = match request_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match state.store.create_project(&body.name).await {
        Ok(project) => (StatusCode::CREATED, Json(project)).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn list_projects(State(state): State<AppState>) -> Response {
    match state.store.list_projects().await {
        Ok(projects) => Json(projects).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn get_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Response {
    match state.store.get_project(&project_id).await {
        Ok(project) => Json(project).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn update_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<UpdateProjectBody>, JsonRejection>,
) -> Response {
    let body = match request_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    match state.store.update_project(&project_id, &body.name).await {
        Ok(project) => Json(project).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn delete_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Response {
    match state.store.delete_project(&project_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn create_profile(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<CreateProfileBody>, JsonRejection>,
) -> Response {
    let body = match request_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(error) = state.store.get_project(&project_id).await {
        return resource_error_response(error);
    }
    match state
        .store
        .create_profile(
            &project_id,
            &body.name,
            &body.description,
            body.settings,
            body.credential_ref.as_deref(),
        )
        .await
    {
        Ok(profile) => (StatusCode::CREATED, Json(profile)).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn list_profiles(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Response {
    if let Err(error) = state.store.get_project(&project_id).await {
        return resource_error_response(error);
    }
    match state.store.list_profiles(&project_id).await {
        Ok(profiles) => Json(profiles).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn get_profile(
    State(state): State<AppState>,
    Path((project_id, profile_id)): Path<(String, String)>,
) -> Response {
    match scoped_profile(&state.store, &project_id, &profile_id).await {
        Ok(profile) => Json(profile).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn update_profile(
    State(state): State<AppState>,
    Path((project_id, profile_id)): Path<(String, String)>,
    body: Result<Json<UpdateProfileBody>, JsonRejection>,
) -> Response {
    let body = match request_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let current = match scoped_profile(&state.store, &project_id, &profile_id).await {
        Ok(profile) => profile,
        Err(error) => return resource_error_response(error),
    };
    if body.name.is_none()
        && body.description.is_none()
        && body.settings.is_none()
        && body.credential_ref.is_none()
    {
        return validation_error_response(anyhow::anyhow!(
            "profile update must include at least one field"
        ));
    }

    let name = body.name.unwrap_or(current.name);
    let description = body.description.unwrap_or(current.description);
    let settings = body.settings.unwrap_or(current.settings);
    let credential_ref = match body.credential_ref {
        None => current.credential_ref,
        Some(None) => None,
        Some(Some(reference)) => Some(reference.trim().to_owned()),
    };
    match state
        .store
        .update_profile(
            &profile_id,
            &name,
            &description,
            settings,
            credential_ref.as_deref(),
        )
        .await
    {
        Ok(profile) => Json(profile).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn delete_profile(
    State(state): State<AppState>,
    Path((project_id, profile_id)): Path<(String, String)>,
) -> Response {
    match state.store.delete_profile(&project_id, &profile_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn duplicate_profile(
    State(state): State<AppState>,
    Path((project_id, profile_id)): Path<(String, String)>,
    body: Result<Json<DuplicateProfileBody>, JsonRejection>,
) -> Response {
    let body = match request_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let source = match scoped_profile(&state.store, &project_id, &profile_id).await {
        Ok(profile) => profile,
        Err(error) => return resource_error_response(error),
    };
    match state
        .store
        .create_profile(
            &project_id,
            &body.name,
            &source.description,
            source.settings,
            source.credential_ref.as_deref(),
        )
        .await
    {
        Ok(profile) => (StatusCode::CREATED, Json(profile)).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn list_profile_revisions(
    State(state): State<AppState>,
    Path((project_id, profile_id)): Path<(String, String)>,
) -> Response {
    if let Err(error) = scoped_profile(&state.store, &project_id, &profile_id).await {
        return resource_error_response(error);
    }
    match state.store.list_profile_revisions(&profile_id).await {
        Ok(revisions) => Json(revisions).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn restore_profile_revision(
    State(state): State<AppState>,
    Path((project_id, profile_id, revision_id)): Path<(String, String, String)>,
) -> Response {
    if let Err(error) = scoped_profile(&state.store, &project_id, &profile_id).await {
        return resource_error_response(error);
    }
    match state
        .store
        .restore_profile_revision(&profile_id, &revision_id)
        .await
    {
        Ok(profile) => Json(profile).into_response(),
        Err(error) => resource_error_response(error),
    }
}

pub async fn validate_profile(
    State(state): State<AppState>,
    Path((project_id, profile_id)): Path<(String, String)>,
    body: Result<Json<ValidateProfileBody>, JsonRejection>,
) -> Response {
    let body = match request_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let profile = match scoped_profile(&state.store, &project_id, &profile_id).await {
        Ok(profile) => profile,
        Err(error) => return resource_error_response(error),
    };
    let settings = body.settings.unwrap_or(profile.settings);
    match validate_settings(&settings, &state.home) {
        Ok(()) => Json(serde_json::json!({ "valid": true })).into_response(),
        Err(error) => validation_error_response(error),
    }
}

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
) -> Response {
    if let Err(error) = validate_job_spec(&spec) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response();
    }
    if let Some(content_set) = spec.content_set.as_deref() {
        let scout_root = match canonical_scout_output_root(&state.scout_output_config) {
            Ok(root) => root,
            Err(error) => {
                return coded_validation(StatusCode::UNPROCESSABLE_ENTITY, error.code);
            }
        };
        match inspect_main_footage_descriptor(FsPath::new(content_set), &scout_root) {
            Ok(Some(_))
                if spec
                    .params
                    .get("narration_enabled")
                    .and_then(serde_json::Value::as_bool)
                    != Some(true) =>
            {
                return coded_validation(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "forced_main_narration_required",
                );
            }
            Ok(_) => {}
            Err(error) => {
                return coded_validation(StatusCode::UNPROCESSABLE_ENTITY, error.code);
            }
        }
    }

    // The worker creates the output dir when it actually runs the job; the
    // server only records intent. output_dir is `output_root/<job_id>` so the
    // artifact route (which serves `output_root/<id>`) and the worker agree.
    let job_id = uuid::Uuid::new_v4().to_string();
    let out = state.output_root.join(&job_id);
    if state
        .store
        .enqueue(&job_id, &spec, &out.to_string_lossy())
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::CREATED, Json(serde_json::json!({ "job_id": job_id }))).into_response()
}

/// Compact JSON of only the override fields a run actually set, for auditing
/// which knobs were changed. Returns `None` when nothing was overridden.
/// `RunOverrides` has no credential field, so this can never carry a secret.
fn override_summary(overrides: &RunOverrides) -> Option<String> {
    let value = serde_json::to_value(overrides).ok()?;
    let set: serde_json::Map<_, _> = value
        .as_object()?
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if set.is_empty() {
        return None;
    }
    serde_json::to_string(&serde_json::Value::Object(set)).ok()
}

/// Enqueue a job from a project-scoped profile plus typed one-off overrides.
/// The stored settings snapshot is the fully resolved, redacted result —
/// immune to later edits of the selected profile.
pub async fn create_project_job(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    body: Result<Json<CreateProjectJobBody>, JsonRejection>,
) -> Response {
    let body = match request_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };

    if let Err(error) = state.store.get_project(&project_id).await {
        return resource_error_response(error);
    }
    let profile = match scoped_profile(&state.store, &project_id, &body.profile_id).await {
        Ok(profile) => profile,
        Err(error) => return resource_error_response(error),
    };

    if let Some(reference) = &profile.credential_ref {
        if !state.credentials.is_available(reference) {
            // Deliberately generic: the reference name is never echoed (see
            // `project_job_rejects_when_credential_reference_is_unavailable`).
            return resource_error_response(ResourceError::Validation {
                message: "required credential is unavailable".to_owned(),
            });
        }
    }

    let resolved = match resolve_settings(&profile.settings, &body.overrides, &state.home) {
        Ok(resolved) => resolved,
        Err(error) => return validation_error_response(error),
    };

    if let Some(content_set) = resolved.ingest_source.content_set.as_deref() {
        let scout_root = match canonical_scout_output_root(&state.scout_output_config) {
            Ok(root) => root,
            Err(error) => {
                return coded_validation(StatusCode::UNPROCESSABLE_ENTITY, error.code);
            }
        };
        if let Err(error) = validate_forced_main_profile(content_set, &resolved, &scout_root) {
            return coded_validation(StatusCode::UNPROCESSABLE_ENTITY, error.code);
        }
    }

    let job_id = uuid::Uuid::new_v4().to_string();
    let output_dir = state.home.project_outputs(&project_id).join(&job_id);
    let spec = JobSpec {
        command: "run".to_owned(),
        url: resolved.ingest_source.source.clone(),
        content_set: resolved
            .ingest_source
            .content_set
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        params: serde_json::json!({}),
    };
    if let Err(error) = validate_job_spec(&spec) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response();
    }
    // Record which profile version + which fields this run overrode, for audit.
    // The revision is read right after the profile fetch above; a concurrent
    // profile edit is an inherent TOCTOU that equally affects `resolved`.
    let profile_revision = state.store.current_profile_revision(&profile.id).await.ok();
    let request = EnqueueRequest {
        spec,
        project_id: project_id.clone(),
        profile_id: Some(profile.id.clone()),
        profile_revision,
        override_summary: override_summary(&body.overrides),
        resolved_settings: resolved,
    };
    if state
        .store
        .enqueue_resolved(&job_id, &request, &output_dir.to_string_lossy())
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "job_id": job_id })),
    )
        .into_response()
}

/// Redacted, immutable settings snapshot resolved at enqueue time. Never
/// includes the profile's credential reference or any secret value.
pub async fn get_effective_settings(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Response {
    let job = match state.store.get(&job_id).await {
        Ok(Some(job)) => job,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut settings = match job.resolved_settings_snapshot {
        Some(settings) => settings,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if let Some(object) = settings.as_object_mut() {
        object.remove("credential_ref");
    }
    Json(serde_json::json!({ "settings": settings })).into_response()
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
) -> Response {
    let outcome = match state
        .store
        .request_cancel(&id)
        .await
    {
        Ok(outcome) => outcome,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match outcome {
        CancelRequestOutcome::QueuedCancelled
        | CancelRequestOutcome::RunningRequested
        | CancelRequestOutcome::AlreadyRequested => match state.store.get(&id).await {
            Ok(Some(job)) => Json(job).into_response(),
            Ok(None) | Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        CancelRequestOutcome::Terminal(_) => StatusCode::CONFLICT.into_response(),
        CancelRequestOutcome::NotFound => StatusCode::NOT_FOUND.into_response(),
    }
}

/// SSE relay: tail `job_events` by autoincrement `seq`. This is the entire
/// progress channel now — the server has no in-process handle to the worker, so
/// it polls the shared DB. `Last-Event-ID` (or `?after=`) resumes after a drop;
/// the stream closes once a `done`, `error`, or `cancelled` event lands.
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
                if ev.kind == "done" || ev.kind == "error" || ev.kind == "cancelled" {
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

/// One-way import of the legacy `config.toml` into project `Imported` /
/// profile `Default`. Missing file → 404 (no path/contents leaked); a
/// second call is idempotent (`imported: false`, see `migration.rs`).
pub async fn migrate_config_toml(State(state): State<AppState>) -> Response {
    let config_path = state.legacy_config_path();
    if std::fs::metadata(config_path).is_err() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "config_not_found" })),
        )
            .into_response();
    }
    match crate::migration::import_legacy_config(&state.store, config_path).await {
        Ok(report) => (StatusCode::OK, Json(report)).into_response(),
        Err(error) => {
            tracing::error!(error = ?error, "config.toml import failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "internal_error" })),
            )
                .into_response()
        }
    }
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
    let args = scout::build_scout_args(ScoutKind::Browser, None, None, None);
    match scout::start(&state.scout, ScoutKind::Browser, args).await {
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
    match scout::start(&state.scout, ScoutKind::Discover, args).await {
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
    if let Some(coverage) = req.main_coverage_target {
        if !coverage.is_finite() || !(0.60..=1.00).contains(&coverage) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid_main_coverage_target" })),
            );
        }
    }
    // Remember where this run writes its content-set BEFORE spawning.
    let cs = scout::resolve_content_set(req.out.as_deref());
    let args = scout::build_scout_args(ScoutKind::Run, None, Some(&req), None);
    let kind = state.scout.lock().await.kind;
    match scout::start(&state.scout, ScoutKind::Run, args).await {
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
    match scout::start(&state.scout, ScoutKind::Validate, args).await {
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
    method: Method,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
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
    let content_type = guess_content_type(&full);
    crate::artifact::serve_file(&method, &headers, &full, content_type).await
}

/// GET /api/scout/output/*path — serve a local scout artifact (crop PNGs, post-crop
/// images) to the browser. Token-guarded via `?token=`; path is confined to
/// `scout/output/` by a `Component::Normal` traversal guard (mirrors `get_artifact`).
/// `<img>` cannot send the bearer header, so this route mounts OUTSIDE the bearer layer.
pub async fn scout_output_file(
    State(state): State<AppState>,
    Path(rel): Path<String>,
    Query(q): Query<ImgToken>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
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
    let content_type = guess_content_type(&full);
    crate::artifact::serve_file(&method, &headers, &full, content_type).await
}
