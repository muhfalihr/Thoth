// ponytail: types produced here, consumed by the Task 5 executor / Task 6 SSE
// route — not yet wired into main.rs, so cargo's dead_code lint doesn't see
// the future callers.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// What the browser asks the server to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSpec {
    /// e.g. "run", "scout", "analyze".
    pub command: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub content_set: Option<String>,
    /// Extra CLI params, forwarded as flags (provider, max_clips, layout, …).
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
}

/// Persisted job metadata (redb value).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub spec: JobSpec,
    pub status: JobStatus,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub pct: f32,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub output_dir: String,
}

/// Server → browser SSE payload (one JSON per `data:` line).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseEvent {
    /// "progress" | "log" | "done" | "error"
    #[serde(rename = "type")]
    pub kind: String,
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pct: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub ts: String,
}
