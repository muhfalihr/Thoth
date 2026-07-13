use std::path::PathBuf;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};

use thoth_jobs::JobStore;

/// Server-wide config shared with handlers. The server no longer owns any job
/// runtime state (no in-process worker handles) — the `JobStore` (shared SQLite
/// DB) is the entire channel to the independent worker process.
#[derive(Clone)]
pub struct AppState {
    pub api_key: String,
    pub store: JobStore,
    pub output_root: PathBuf,
    /// Path to config.toml, read/written by the config endpoints. Hardcoded to
    /// cwd-relative `config.toml` to match AppConfig::load()'s `File::with_name`
    /// lookup exactly — the worker ignores any override, so this must not be
    /// env-configurable or a UI edit could land in a file no job ever reads.
    pub config_path: PathBuf,
    /// Single-slot supervisor for the interactive scout discovery pipeline.
    /// In-memory; independent of the render job queue. See scout.rs.
    pub scout: crate::scout::ScoutSupervisor,
}

/// True iff `header` is `Bearer <key>` matching `key`. Shared by the
/// middleware and its test so they can't drift.
pub(crate) fn is_valid_bearer(header: Option<&str>, key: &str) -> bool {
    header
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|k| k == key)
}

/// Reject any request whose `Authorization: Bearer <key>` does not match.
pub async fn require_api_key(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());
    let ok = is_valid_bearer(header, &state.api_key);
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_matching_bearer_and_rejects_others() {
        assert!(is_valid_bearer(Some("Bearer secret"), "secret"));
        assert!(!is_valid_bearer(Some("Bearer wrong"), "secret"));
        assert!(!is_valid_bearer(Some("secret"), "secret")); // missing prefix
        assert!(!is_valid_bearer(None, "secret"));
    }
}
