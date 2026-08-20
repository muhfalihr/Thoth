use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};

use thoth_jobs::{JobStore, ScoutOutputConfig, ThothHome};

/// Resolves whether a profile's non-secret `credential_ref` currently points
/// at a usable credential. Never exposes the secret itself — callers only
/// ever see the bool. Injected so tests can supply a deterministic fake.
pub trait CredentialProvider: Send + Sync {
    /// Whether the named non-secret reference resolves to a usable credential.
    fn is_available(&self, reference: &str) -> bool;
}

/// Production `CredentialProvider`: a reference is available iff the
/// environment variable of that exact name is set and non-empty after trim.
pub struct EnvCredentialProvider;

impl CredentialProvider for EnvCredentialProvider {
    fn is_available(&self, reference: &str) -> bool {
        std::env::var(reference).is_ok_and(|value| !value.trim().is_empty())
    }
}

/// The server and worker share this SQLite database by default. `THOTH_DB`
/// remains an explicit compatibility override for existing deployments.
pub fn server_db_path(home: &ThothHome) -> PathBuf {
    home.data_dir().join("thoth.db")
}

/// Compatibility output location for the unprofiled `/api/jobs` endpoint.
/// Typed project jobs use their own `projects/<project-id>/outputs` directory.
pub fn legacy_output_root(home: &ThothHome) -> PathBuf {
    home.project_outputs("legacy")
}

/// `AppConfig::load()` in the independent worker uses
/// `File::with_name("config")`, resolved from its current working directory.
/// Keep raw TOML compatibility reads and writes on that exact file until the
/// typed-profile migration removes the endpoint and dashboard editor together.
pub fn worker_compatible_config_path() -> std::io::Result<PathBuf> {
    std::env::current_dir().map(|directory| directory.join("config.toml"))
}

/// Server-wide config shared with handlers. The server no longer owns any job
/// runtime state (no in-process worker handles) — the `JobStore` (shared SQLite
/// DB) is the entire channel to the independent worker process.
#[derive(Clone)]
pub struct AppState {
    pub api_key: String,
    pub store: JobStore,
    pub output_root: PathBuf,
    /// Application home shared by all server-owned paths.
    pub home: ThothHome,
    /// Exact legacy TOML path the independent worker reads from its CWD.
    pub worker_config_path: PathBuf,
    /// Typed Scout hand-off configuration with the same last-good reload
    /// behavior as the warm worker.
    pub scout_output_config: ScoutOutputConfig,
    /// Single-slot supervisor for the interactive scout discovery pipeline.
    /// In-memory; independent of the render job queue. See scout.rs.
    pub scout: crate::scout::ScoutSupervisor,
    /// Injected credential-availability check for profile-resolved enqueue.
    pub credentials: Arc<dyn CredentialProvider>,
}

impl AppState {
    /// Transitional location used by the legacy raw TOML endpoints. This is
    /// deliberately the worker's CWD config, not a path inside `ThothHome`.
    /// The endpoint is retired by the profile migration task.
    pub fn legacy_config_path(&self) -> &std::path::Path {
        &self.worker_config_path
    }
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
