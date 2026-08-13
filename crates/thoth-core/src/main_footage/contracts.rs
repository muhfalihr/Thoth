use std::path::{Component, Path};

use serde::{Deserialize, Deserializer, Serialize};

pub const MAIN_FOOTAGE_SCHEMA_VERSION: u8 = 1;

fn deserialize_schema_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u8::deserialize(deserializer)?;
    if version == MAIN_FOOTAGE_SCHEMA_VERSION {
        Ok(version)
    } else {
        Err(serde::de::Error::custom("unsupported schema_version"))
    }
}

fn is_remote_artifact_path(path: &str) -> bool {
    let Some((scheme, rest)) = path.split_once("://") else {
        return false;
    };
    !scheme.is_empty()
        && scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
        && !rest.is_empty()
}

fn validate_artifact_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || is_remote_artifact_path(path)
        || path.contains('\\')
    {
        return Err("artifact_path_must_be_relative");
    }
    if Path::new(path)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("path_outside_root");
    }
    Ok(())
}

fn deserialize_artifact_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let path = String::deserialize(deserializer)?;
    validate_artifact_path(&path).map_err(serde::de::Error::custom)?;
    Ok(path)
}

fn deserialize_optional_artifact_path<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?.map_or(Ok(None), |path| {
        validate_artifact_path(&path).map_err(serde::de::Error::custom)?;
        Ok(Some(path))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MainFootageMode {
    Forced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionKind {
    MatchCut,
    CrossDissolve,
    FadeThroughBlack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchLevel {
    Exact,
    TopicOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningMode {
    Vision,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MainFootageErrorCode {
    ForcedMainNoUsableVideo,
    ForcedMainNarrationRequired,
    SourcePackageInvalid,
    NarrationGenerationFailed,
    CutPlanningFailed,
    CutMaterializationExhausted,
    PlanVerificationFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MainFootageWarningCode {
    SourceVideoSkipped,
    PhotoSlideIgnored,
    VisionDegraded,
    ExactSceneReused,
    TopicOnlyMatch,
    TransitionFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OutcomeCode {
    Error(MainFootageErrorCode),
    Warning(MainFootageWarningCode),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceTechnicalMetadata {
    pub container: String,
    pub video_codec: String,
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceVideoV1 {
    pub id: String,
    pub media_index: u32,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub path: String,
    pub checksum: String,
    pub technical: SourceTechnicalMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceOutcomeV1 {
    pub id: String,
    pub media_index: u32,
    pub code: OutcomeCode,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VisualMetricsV1 {
    pub motion_score: f64,
    pub brightness: f64,
    pub scene_change_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneEvidenceV1 {
    pub id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub representative_frame: String,
    pub transcript_evidence: String,
    pub vision_description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_artifact_path")]
    pub embedding_path: Option<String>,
    pub visual_metrics: VisualMetricsV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneIndexV1 {
    pub source_id: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub path: String,
    pub checksum: String,
    pub planning_mode: PlanningMode,
    pub scenes: Vec<SceneEvidenceV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePostV1 {
    pub id: String,
    pub canonical_url: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePackageV1 {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    pub post: SourcePostV1,
    pub analysis_identity: String,
    pub created_at: Option<String>,
    pub fingerprint: Option<String>,
    pub sources: Vec<SourceVideoV1>,
    pub ignored: Vec<SourceOutcomeV1>,
    pub unavailable: Vec<SourceOutcomeV1>,
    pub scene_indexes: Vec<SceneIndexV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NarrationWordV1 {
    pub text: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NarrationTimelineV1 {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub audio_path: String,
    pub audio_checksum: String,
    pub duration_sec: f64,
    pub words: Vec<NarrationWordV1>,
    pub created_at: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransitionV1 {
    pub kind: TransitionKind,
    pub duration_ms: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CutHandlesV1 {
    pub before_ms: u16,
    pub after_ms: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedCutV1 {
    pub id: String,
    pub source_id: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub source_path: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub cut_path: String,
    pub checksum: String,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub output_start_sec: f64,
    pub output_end_sec: f64,
    pub match_level: MatchLevel,
    pub reuse_count: u32,
    pub transition: TransitionV1,
    pub handles: CutHandlesV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanDiagnosticsV1 {
    pub planning_mode: PlanningMode,
    pub candidate_count: u32,
    pub warnings: Vec<MainFootageWarningCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanSummaryV1 {
    pub main_coverage_sec: f64,
    pub main_coverage_ratio: f64,
    pub total_duration_sec: f64,
    pub selected_cut_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainFootagePlanV1 {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub source_package_path: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub narration_timeline_path: String,
    pub source_package_fingerprint: String,
    pub narration_fingerprint: String,
    pub main_coverage_target: f64,
    pub timeline: Vec<PlannedCutV1>,
    pub diagnostics: PlanDiagnosticsV1,
    pub summary: PlanSummaryV1,
    pub warnings: Vec<MainFootageWarningCode>,
    pub created_at: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainFootageDescriptor {
    pub mode: MainFootageMode,
    pub use_input_as_main: bool,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub source_package_path: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub narration_timeline_path: String,
    #[serde(default, deserialize_with = "deserialize_optional_artifact_path")]
    pub plan_path: Option<String>,
    pub main_coverage_target: f64,
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::MainFootagePlanV1;
    use crate::main_footage::paths::resolve_contained;

    #[test]
    fn shared_v1_fixtures_deserialize_and_remote_cut_paths_are_rejected() {
        let plan: MainFootagePlanV1 = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/main-footage/contracts/main-footage-plan.v1.json"
        ))
        .unwrap();
        assert_eq!(plan.schema_version, 1);
        assert!(resolve_contained(Path::new("job"), Path::new("https://cdn.test/a.mp4")).is_err());
    }

    #[test]
    fn unknown_schema_versions_are_rejected_during_deserialization() {
        assert!(serde_json::from_str::<MainFootagePlanV1>(r#"{"schema_version":2}"#).is_err());
    }
}
