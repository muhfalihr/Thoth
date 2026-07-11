use serde::{Deserialize, Serialize};

/// One machine-readable progress record on the worker's stdout (NDJSON).
/// job_id and event `type` are added by the server, not the worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub stage: String,
    pub pct: f32,
    pub message: String,
    pub ts: String,
}
