use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus { Queued, Running, Succeeded, Failed, Cancelled }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelRequestOutcome {
    QueuedCancelled,
    RunningRequested,
    AlreadyRequested,
    Terminal(JobStatus),
    NotFound,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Succeeded => "succeeded",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        }
    }
    pub fn is_terminal(self) -> bool {
        matches!(self, JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled)
    }
}

impl FromStr for JobStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "queued" => Ok(JobStatus::Queued),
            "running" => Ok(JobStatus::Running),
            "succeeded" => Ok(JobStatus::Succeeded),
            "failed" => Ok(JobStatus::Failed),
            "cancelled" => Ok(JobStatus::Cancelled),
            other => Err(format!("unknown JobStatus: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSpec {
    pub command: String,
    #[serde(default)] pub url: Option<String>,
    #[serde(default)] pub content_set: Option<String>,
    #[serde(default)] pub params: serde_json::Value,
}

/// A fully resolved, safe-to-persist job request. The caller owns the job ID
/// and output directory so this store does not infer any filesystem policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnqueueRequest {
    pub spec: JobSpec,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_revision: Option<i64>,
    /// Redacted, human-auditable summary of which fields this run overrode
    /// (JSON of the set override fields; never contains a secret value). `None`
    /// when the run used the profile unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_summary: Option<String>,
    pub resolved_settings: crate::ResolvedSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub spec: JobSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_settings_snapshot: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_summary: Option<serde_json::Value>,
    pub status: JobStatus,
    pub stage: Option<String>,
    pub pct: f32,
    pub error: Option<String>,
    pub output_dir: String,
    pub worker_id: Option<String>,
    pub cancel_requested: bool,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub heartbeat_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobEvent {
    pub seq: i64,
    pub job_id: String,
    #[serde(rename = "type")] pub kind: String,
    pub stage: Option<String>,
    pub pct: Option<f32>,
    pub message: Option<String>,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseEvent {
    #[serde(rename = "type")] pub kind: String,
    pub job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub pct: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub message: Option<String>,
    pub ts: String,
}
