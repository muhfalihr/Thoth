use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::analyze::service::AnalyzeResult;
use crate::edit::service::EditResult;
use crate::ingest::content_search::{
    MainContext, OCR_ANALYZER_VERSION, OCR_SCHEMA_VERSION, OcrStatus, validate_main_ocr_for_model,
};
use crate::ingest::service::IngestResult;
use crate::news::model::EnrichResult;
use crate::transcribe::service::TranscribeResult;

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
    #[serde(default)]
    pub ocr: Option<OcrStageResult>,
    pub transcribe: Option<TranscribeResult>,
    pub analyze: Option<AnalyzeResult>,
    /// Stage 4: news + reaction enrichment (None when disabled or not yet run).
    #[serde(default)]
    pub enrich: Option<EnrichResult>,
    pub edit: Option<EditResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrStageResult {
    pub status: OcrStatus,
    pub schema_version: u32,
    pub analyzer_version: String,
    pub model: String,
    pub source_fingerprint: String,
    pub completed_at: DateTime<Utc>,
}

pub(crate) fn ocr_is_fresh(
    stage: Option<&OcrStageResult>,
    source_fingerprint: &str,
    context: Option<&MainContext>,
    expected_model: &str,
) -> bool {
    let (Some(stage), Some(context)) = (stage, context) else {
        return false;
    };

    stage.status == OcrStatus::Analyzed
        && stage.schema_version == OCR_SCHEMA_VERSION
        && stage.analyzer_version == OCR_ANALYZER_VERSION
        && stage.model == expected_model
        && stage.source_fingerprint == source_fingerprint
        && validate_main_ocr_for_model(context, expected_model).is_ok()
}

pub(crate) fn invalidate_after_ocr_rerun(state: &mut PipelineState) {
    state.stages.edit = None;
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

#[cfg(test)]
mod ocr_state_tests {
    use super::*;
    use crate::edit::service::EditResult;
    use crate::ingest::content_search::{
        MainContext, OCR_ANALYZER_VERSION, OCR_SCHEMA_VERSION, OcrMetadata, OcrStatus,
        configured_ocr_model,
    };

    fn analyzed_context() -> MainContext {
        MainContext {
            ocr: OcrMetadata {
                ocr_schema_version: OCR_SCHEMA_VERSION,
                ocr_status: Some(OcrStatus::Analyzed),
                ocr_model: configured_ocr_model(),
                ocr_analyzer_version: OCR_ANALYZER_VERSION.into(),
                ocr_analyzed_at: "2026-07-23T00:00:00Z".into(),
                ocr_requested_frames: 4,
                ocr_valid_frames: 4,
                ocr_outcome: "clean".into(),
            },
            ..MainContext::default()
        }
    }

    fn completed_stage() -> OcrStageResult {
        OcrStageResult {
            status: OcrStatus::Analyzed,
            schema_version: OCR_SCHEMA_VERSION,
            analyzer_version: OCR_ANALYZER_VERSION.into(),
            model: configured_ocr_model(),
            source_fingerprint: "md5:current".into(),
            completed_at: DateTime::parse_from_rfc3339("2026-07-23T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    #[test]
    fn old_state_without_ocr_stage_deserializes_as_not_reusable() {
        let state: PipelineState = serde_json::from_value(serde_json::json!({
            "job_id": "legacy",
            "url": "https://example.test/video",
            "created_at": "2026-07-22T00:00:00Z",
            "updated_at": "2026-07-22T00:00:00Z",
            "stages": {
                "ingest": null,
                "transcribe": null,
                "analyze": null,
                "enrich": null,
                "edit": null
            }
        }))
        .unwrap();

        assert!(state.stages.ocr.is_none());
        assert!(!ocr_is_fresh(
            state.stages.ocr.as_ref(),
            "md5:current",
            Some(&analyzed_context()),
            &configured_ocr_model(),
        ));
    }

    #[test]
    fn matching_stage_and_current_context_are_reusable() {
        assert!(ocr_is_fresh(
            Some(&completed_stage()),
            "md5:current",
            Some(&analyzed_context()),
            &configured_ocr_model(),
        ));
    }

    #[test]
    fn every_stage_identity_mismatch_forces_rerun() {
        let context = analyzed_context();
        let expected_model = configured_ocr_model();

        let mut failed = completed_stage();
        failed.status = OcrStatus::Failed;
        assert!(!ocr_is_fresh(
            Some(&failed),
            "md5:current",
            Some(&context),
            &expected_model,
        ));

        let mut wrong_schema = completed_stage();
        wrong_schema.schema_version += 1;
        assert!(!ocr_is_fresh(
            Some(&wrong_schema),
            "md5:current",
            Some(&context),
            &expected_model,
        ));

        let mut wrong_analyzer = completed_stage();
        wrong_analyzer.analyzer_version = "stale-analyzer".into();
        assert!(!ocr_is_fresh(
            Some(&wrong_analyzer),
            "md5:current",
            Some(&context),
            &expected_model,
        ));

        let mut wrong_model = completed_stage();
        wrong_model.model = "stale/model".into();
        assert!(!ocr_is_fresh(
            Some(&wrong_model),
            "md5:current",
            Some(&context),
            &expected_model,
        ));

        assert!(!ocr_is_fresh(
            Some(&completed_stage()),
            "md5:different-source",
            Some(&context),
            &expected_model,
        ));
    }

    #[test]
    fn missing_failed_or_stale_context_forces_rerun() {
        let stage = completed_stage();
        let expected_model = configured_ocr_model();
        assert!(!ocr_is_fresh(
            Some(&stage),
            "md5:current",
            None,
            &expected_model,
        ));

        let mut failed = analyzed_context();
        failed.ocr.ocr_status = Some(OcrStatus::Failed);
        assert!(!ocr_is_fresh(
            Some(&stage),
            "md5:current",
            Some(&failed),
            &expected_model,
        ));

        let mut wrong_schema = analyzed_context();
        wrong_schema.ocr.ocr_schema_version += 1;
        assert!(!ocr_is_fresh(
            Some(&stage),
            "md5:current",
            Some(&wrong_schema),
            &expected_model,
        ));

        let mut wrong_analyzer = analyzed_context();
        wrong_analyzer.ocr.ocr_analyzer_version = "stale-analyzer".into();
        assert!(!ocr_is_fresh(
            Some(&stage),
            "md5:current",
            Some(&wrong_analyzer),
            &expected_model,
        ));

        let mut wrong_model = analyzed_context();
        wrong_model.ocr.ocr_model = "stale/model".into();
        assert!(!ocr_is_fresh(
            Some(&stage),
            "md5:current",
            Some(&wrong_model),
            &expected_model,
        ));
    }

    #[test]
    fn ocr_rerun_invalidates_a_completed_edit() {
        let mut state = PipelineState::new("job".into(), "https://example.test/video".into());
        state.stages.edit = Some(EditResult {
            output_clips: Vec::new(),
            completed_at: Utc::now(),
        });

        invalidate_after_ocr_rerun(&mut state);

        assert!(state.stages.edit.is_none());
    }
}
