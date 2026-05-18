use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ingest::service::IngestResult;
use crate::transcribe::service::TranscribeResult;
use crate::analyze::service::AnalyzeResult;
use crate::edit::service::EditResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineState {
    pub job_id: String,
    pub url: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub stages: StageResults,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StageResults {
    pub ingest: Option<IngestResult>,
    pub transcribe: Option<TranscribeResult>,
    pub analyze: Option<AnalyzeResult>,
    pub edit: Option<EditResult>,
}

impl PipelineState {
    pub fn new(job_id: String, url: String) -> Self {
        let now = Utc::now();
        Self {
            job_id,
            url,
            created_at: now,
            updated_at: now,
            stages: StageResults::default(),
        }
    }

    pub fn save(&mut self, path: &Path) -> Result<()> {
        self.updated_at = Utc::now();
        let json = serde_json::to_string_pretty(self).context("failed to serialize state")?;
        std::fs::write(path, json).context("failed to write state.json")?;
        Ok(())
    }

    pub fn load(path: &Path) -> Result<Self> {
        let json = std::fs::read_to_string(path).context("failed to read state.json")?;
        serde_json::from_str(&json).context("failed to parse state.json")
    }
}
