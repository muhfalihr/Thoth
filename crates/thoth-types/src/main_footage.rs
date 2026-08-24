use std::collections::HashSet;
use std::path::{Component, Path};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

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

fn deserialize_non_blank<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.trim().is_empty() {
        return Err(serde::de::Error::custom("value must not be blank"));
    }
    Ok(value)
}

fn validate_sha256_identity(value: &str) -> Result<(), &'static str> {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return Err("value must be a SHA-256 identity");
    };
    if digest.is_empty() || digest.chars().any(char::is_whitespace) {
        return Err("value must be a SHA-256 identity");
    }
    Ok(())
}

fn deserialize_sha256_identity<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    validate_sha256_identity(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn deserialize_optional_sha256_identity<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?.map_or(Ok(None), |value| {
        validate_sha256_identity(&value).map_err(serde::de::Error::custom)?;
        Ok(Some(value))
    })
}

fn deserialize_positive_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value == 0 {
        return Err(serde::de::Error::custom("value must be greater than zero"));
    }
    Ok(value)
}

fn deserialize_nonnegative_finite<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || value < 0.0 {
        return Err(serde::de::Error::custom(
            "value must be a non-negative finite number",
        ));
    }
    Ok(value)
}

fn deserialize_coverage_target<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = deserialize_nonnegative_finite(deserializer)?;
    if !(0.60..=1.00).contains(&value) {
        return Err(serde::de::Error::custom(
            "main_coverage_target must be within [0.60, 1.00]",
        ));
    }
    Ok(value)
}

fn unique_ids<'a>(
    ids: impl Iterator<Item = &'a str>,
    name: &'static str,
) -> Result<(), &'static str> {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(name);
        }
    }
    Ok(())
}

fn deserialize_unique_sources<'de, D>(deserializer: D) -> Result<Vec<SourceVideoV1>, D::Error>
where
    D: Deserializer<'de>,
{
    let sources = Vec::<SourceVideoV1>::deserialize(deserializer)?;
    if sources.is_empty() {
        return Err(serde::de::Error::custom(
            "source package must contain at least one source",
        ));
    }
    unique_ids(
        sources.iter().map(|source| source.id.as_str()),
        "duplicate source id",
    )
    .map_err(serde::de::Error::custom)?;
    Ok(sources)
}

fn deserialize_unique_scene_indexes<'de, D>(deserializer: D) -> Result<Vec<SceneIndexV1>, D::Error>
where
    D: Deserializer<'de>,
{
    let indexes = Vec::<SceneIndexV1>::deserialize(deserializer)?;
    unique_ids(
        indexes.iter().map(|index| index.source_id.as_str()),
        "duplicate scene index source id",
    )
    .map_err(serde::de::Error::custom)?;
    Ok(indexes)
}

fn deserialize_unique_scenes<'de, D>(deserializer: D) -> Result<Vec<SceneEvidenceV1>, D::Error>
where
    D: Deserializer<'de>,
{
    let scenes = Vec::<SceneEvidenceV1>::deserialize(deserializer)?;
    unique_ids(
        scenes.iter().map(|scene| scene.id.as_str()),
        "duplicate scene id",
    )
    .map_err(serde::de::Error::custom)?;
    Ok(scenes)
}

fn deserialize_unique_cuts<'de, D>(deserializer: D) -> Result<Vec<PlannedCutV1>, D::Error>
where
    D: Deserializer<'de>,
{
    let cuts = Vec::<PlannedCutV1>::deserialize(deserializer)?;
    unique_ids(cuts.iter().map(|cut| cut.id.as_str()), "duplicate cut id")
        .map_err(serde::de::Error::custom)?;
    Ok(cuts)
}

fn fields(value: &Value, names: &[&str]) -> Result<Value, String> {
    let source = value
        .as_object()
        .ok_or_else(|| "fingerprint value must be an object".to_string())?;
    let mut projected = Map::new();
    for name in names {
        let field = source
            .get(*name)
            .ok_or_else(|| format!("missing fingerprint field: {name}"))?;
        projected.insert((*name).to_string(), field.clone());
    }
    Ok(Value::Object(projected))
}

fn projected_array(value: &Value, names: &[&str]) -> Result<Value, String> {
    let array = value
        .as_array()
        .ok_or_else(|| "fingerprint value must be an array".to_string())?;
    array
        .iter()
        .map(|entry| fields(entry, names))
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn normalized_word(word: &Value) -> Result<Value, String> {
    let object = word
        .as_object()
        .ok_or_else(|| "word must be an object".to_string())?;
    let text = object
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "word text must be a string".to_string())?
        .nfc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut projected = Map::new();
    projected.insert("text".to_string(), Value::String(text));
    for name in ["start_sec", "end_sec"] {
        let value = object
            .get(name)
            .ok_or_else(|| format!("missing fingerprint field: {name}"))?;
        projected.insert(name.to_string(), value.clone());
    }
    Ok(Value::Object(projected))
}

fn fingerprint_projection(value: &Value) -> Result<Value, String> {
    let object = match value.as_object() {
        Some(object) => object,
        None => return Ok(value.clone()),
    };
    if object.contains_key("sources")
        && object.contains_key("scene_indexes")
        && object.contains_key("post")
    {
        let mut projected = Map::new();
        for name in ["schema_version", "post", "analysis_identity"] {
            let field = object
                .get(name)
                .ok_or_else(|| format!("missing fingerprint field: {name}"))?;
            projected.insert(name.to_string(), field.clone());
        }
        projected.insert(
            "sources".to_string(),
            projected_array(
                object
                    .get("sources")
                    .ok_or_else(|| "missing fingerprint field: sources".to_string())?,
                &["id", "media_index", "checksum", "technical"],
            )?,
        );
        projected.insert(
            "scene_indexes".to_string(),
            projected_array(
                object
                    .get("scene_indexes")
                    .ok_or_else(|| "missing fingerprint field: scene_indexes".to_string())?,
                &["source_id", "checksum"],
            )?,
        );
        for name in ["ignored", "unavailable"] {
            projected.insert(
                name.to_string(),
                projected_array(
                    object
                        .get(name)
                        .ok_or_else(|| format!("missing fingerprint field: {name}"))?,
                    &["id", "media_index", "code"],
                )?,
            );
        }
        return Ok(Value::Object(projected));
    }
    if object.contains_key("audio_checksum") && object.contains_key("words") {
        let words = object
            .get("words")
            .and_then(Value::as_array)
            .ok_or_else(|| "words must be an array".to_string())?
            .iter()
            .map(normalized_word)
            .collect::<Result<Vec<_>, _>>()?;
        let mut projected = Map::new();
        for name in ["schema_version", "audio_checksum"] {
            let field = object
                .get(name)
                .ok_or_else(|| format!("missing fingerprint field: {name}"))?;
            projected.insert(name.to_string(), field.clone());
        }
        projected.insert("words".to_string(), Value::Array(words));
        return Ok(Value::Object(projected));
    }
    let mut projected = object.clone();
    for name in ["created_at", "fingerprint", "message"] {
        projected.remove(name);
    }
    Ok(Value::Object(projected))
}

/// Prints a number with ECMAScript's `Number::toString` algorithm.
///
/// Canonical bytes cross the Scout (JavaScript) ↔ Rust protocol boundary, so use
/// an implementation of ECMAScript's formatter rather than approximating its
/// thresholds with Rust's general-purpose number serialization.
fn canonical_number(number: &serde_json::Number) -> String {
    if !number.is_f64() {
        return number.to_string();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer
        .format(number.as_f64().expect("f64 number"))
        .to_string()
}

fn canonical_json(value: &Value) -> Result<String, String> {
    match value {
        Value::Number(number) => Ok(canonical_number(number)),
        Value::Null | Value::Bool(_) | Value::String(_) => {
            serde_json::to_string(value).map_err(|error| error.to_string())
        }
        Value::Array(values) => values
            .iter()
            .map(canonical_json)
            .collect::<Result<Vec<_>, _>>()
            .map(|values| format!("[{}]", values.join(","))),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut parts = Vec::with_capacity(keys.len());
            for key in keys {
                let encoded_key = serde_json::to_string(key).map_err(|error| error.to_string())?;
                let encoded_value = canonical_json(
                    values
                        .get(key)
                        .ok_or_else(|| "canonical key disappeared".to_string())?,
                )?;
                parts.push(format!("{encoded_key}:{encoded_value}"));
            }
            Ok(format!("{{{}}}", parts.join(",")))
        }
    }
}

/// Hashes versioned contract values using sorted JSON object keys and significant array order.
pub fn fingerprint_canonical(value: &Value) -> Result<String, String> {
    let canonical = canonical_json(&fingerprint_projection(value)?)?;
    let mut hash = Sha256::new();
    hash.update(canonical.as_bytes());
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MainFootageMode {
    ForcedUrlPool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    #[default]
    MainCut,
    ExternalCut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningMode {
    Vision,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MainFootagePlanStatus {
    Verified,
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
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub container: String,
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub video_codec: String,
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub duration_sec: f64,
    #[serde(deserialize_with = "deserialize_positive_u32")]
    pub width: u32,
    #[serde(deserialize_with = "deserialize_positive_u32")]
    pub height: u32,
    pub has_audio: bool,
}

/// How Scout obtained one source. Provenance only — nothing downstream plans
/// against it, but it is written on every source Scout emits, so the strict
/// decoder has to know about it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceAcquisitionV1 {
    /// Free-form because Scout's `AcquisitionSource` union is kebab-case
    /// (`public-metadata`, `gallery-dl`, `yt-dlp`, `direct-http`) and grows on
    /// the Scout side; mirroring it as a Rust enum would re-create the very
    /// drift this field exists to close.
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub source: String,
    pub attempts: u32,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceVideoV1 {
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub id: String,
    pub media_index: u32,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub path: String,
    #[serde(deserialize_with = "deserialize_sha256_identity")]
    pub checksum: String,
    /// Size of the published source file. Optional in
    /// `scout/main_footage/contracts.ts`, so a package written before Scout
    /// emitted it still decodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub technical: SourceTechnicalMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquisition: Option<SourceAcquisitionV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceOutcomeV1 {
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub id: String,
    pub media_index: u32,
    pub code: OutcomeCode,
    // Absent, never null: Rust republishes this manifest into the job and Scout's
    // planner decodes that copy, and Scout's decoder reads optionals as
    // "`undefined` or a valid value" (`contracts.ts::outcome`). Serializing `None`
    // as `null` made every mixed carousel — the case this feature exists for — die
    // in the planner with `cut_planning_failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VisualMetricsV1 {
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub motion_score: f64,
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub brightness: f64,
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub scene_change_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "SceneEvidenceWire")]
pub struct SceneEvidenceV1 {
    pub id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub representative_frame: String,
    pub transcript_evidence: String,
    // Absent, never null — see `SourceOutcomeV1::message`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision_description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_artifact_path"
    )]
    pub embedding_path: Option<String>,
    pub visual_metrics: VisualMetricsV1,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneEvidenceWire {
    #[serde(deserialize_with = "deserialize_non_blank")]
    id: String,
    start_sec: f64,
    end_sec: f64,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    representative_frame: String,
    transcript_evidence: String,
    vision_description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_artifact_path")]
    embedding_path: Option<String>,
    visual_metrics: VisualMetricsV1,
}

impl TryFrom<SceneEvidenceWire> for SceneEvidenceV1 {
    type Error = &'static str;

    fn try_from(value: SceneEvidenceWire) -> Result<Self, Self::Error> {
        if !value.start_sec.is_finite()
            || !value.end_sec.is_finite()
            || value.start_sec < 0.0
            || value.end_sec <= value.start_sec
        {
            return Err("scene has an invalid time range");
        }
        Ok(Self {
            id: value.id,
            start_sec: value.start_sec,
            end_sec: value.end_sec,
            representative_frame: value.representative_frame,
            transcript_evidence: value.transcript_evidence,
            vision_description: value.vision_description,
            embedding_path: value.embedding_path,
            visual_metrics: value.visual_metrics,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneIndexV1 {
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub source_id: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub path: String,
    #[serde(deserialize_with = "deserialize_sha256_identity")]
    pub checksum: String,
    pub planning_mode: PlanningMode,
    #[serde(deserialize_with = "deserialize_unique_scenes")]
    pub scenes: Vec<SceneEvidenceV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePostV1 {
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub id: String,
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub canonical_url: String,
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePackageV1 {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    pub post: SourcePostV1,
    #[serde(deserialize_with = "deserialize_non_blank")]
    pub analysis_identity: String,
    // Absent, never null — see `SourceOutcomeV1::message`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_sha256_identity")]
    pub fingerprint: Option<String>,
    #[serde(deserialize_with = "deserialize_unique_sources")]
    pub sources: Vec<SourceVideoV1>,
    pub ignored: Vec<SourceOutcomeV1>,
    pub unavailable: Vec<SourceOutcomeV1>,
    #[serde(deserialize_with = "deserialize_unique_scene_indexes")]
    pub scene_indexes: Vec<SceneIndexV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "NarrationWordWire")]
pub struct NarrationWordV1 {
    pub text: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NarrationWordWire {
    text: String,
    start_sec: f64,
    end_sec: f64,
}

impl TryFrom<NarrationWordWire> for NarrationWordV1 {
    type Error = &'static str;

    fn try_from(value: NarrationWordWire) -> Result<Self, Self::Error> {
        if !value.start_sec.is_finite()
            || !value.end_sec.is_finite()
            || value.start_sec < 0.0
            || value.end_sec <= value.start_sec
        {
            return Err("word has an invalid time range");
        }
        Ok(Self {
            text: value.text,
            start_sec: value.start_sec,
            end_sec: value.end_sec,
        })
    }
}

/// One contiguous narration span the cut planner allocates footage against.
/// Beats are derived from `words`, so they are deliberately excluded from the
/// timeline fingerprint — see `fingerprint_projection`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "NarrationBeatWire")]
pub struct NarrationBeatV1 {
    pub id: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NarrationBeatWire {
    #[serde(deserialize_with = "deserialize_non_blank")]
    id: String,
    start_sec: f64,
    end_sec: f64,
    text: String,
}

impl TryFrom<NarrationBeatWire> for NarrationBeatV1 {
    type Error = &'static str;

    fn try_from(value: NarrationBeatWire) -> Result<Self, Self::Error> {
        if !value.start_sec.is_finite()
            || !value.end_sec.is_finite()
            || value.start_sec < 0.0
            || value.end_sec <= value.start_sec
        {
            return Err("beat has an invalid time range");
        }
        Ok(Self {
            id: value.id,
            start_sec: value.start_sec,
            end_sec: value.end_sec,
            text: value.text,
        })
    }
}

fn deserialize_contiguous_beats<'de, D>(deserializer: D) -> Result<Vec<NarrationBeatV1>, D::Error>
where
    D: Deserializer<'de>,
{
    let beats = Vec::<NarrationBeatV1>::deserialize(deserializer)?;
    unique_ids(beats.iter().map(|beat| beat.id.as_str()), "duplicate beat id")
        .map_err(serde::de::Error::custom)?;
    if let Some(first) = beats.first() {
        if first.start_sec != 0.0 {
            return Err(serde::de::Error::custom("beats must start at 0"));
        }
    }
    if beats
        .windows(2)
        .any(|pair| pair[0].end_sec != pair[1].start_sec)
    {
        return Err(serde::de::Error::custom("beats must be contiguous"));
    }
    Ok(beats)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NarrationTimelineV1 {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub audio_path: String,
    pub audio_checksum: String,
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub duration_sec: f64,
    pub words: Vec<NarrationWordV1>,
    /// Derived beat segmentation. Absent in a words-only timeline.
    #[serde(default, deserialize_with = "deserialize_contiguous_beats")]
    pub beats: Vec<NarrationBeatV1>,
    // Absent, never null — see `SourceOutcomeV1::message`. Rust publishes this file
    // and the Scout planner decodes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
#[serde(try_from = "PlannedCutWire")]
pub struct PlannedCutV1 {
    pub id: String,
    pub asset_kind: AssetKind,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlannedCutWire {
    id: String,
    #[serde(default)]
    asset_kind: AssetKind,
    source_id: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    source_path: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    cut_path: String,
    checksum: String,
    source_start_sec: f64,
    source_end_sec: f64,
    output_start_sec: f64,
    output_end_sec: f64,
    match_level: MatchLevel,
    reuse_count: u32,
    transition: TransitionV1,
    handles: CutHandlesV1,
}

impl TryFrom<PlannedCutWire> for PlannedCutV1 {
    type Error = &'static str;

    fn try_from(value: PlannedCutWire) -> Result<Self, Self::Error> {
        let source_range_valid = value.source_start_sec.is_finite()
            && value.source_end_sec.is_finite()
            && value.source_start_sec >= 0.0
            && value.source_end_sec > value.source_start_sec;
        let output_range_valid = value.output_start_sec.is_finite()
            && value.output_end_sec.is_finite()
            && value.output_start_sec >= 0.0
            && value.output_end_sec > value.output_start_sec;
        if !source_range_valid || !output_range_valid {
            return Err("cut has an invalid time range");
        }
        if !(120..=300).contains(&value.transition.duration_ms) {
            return Err("transition.duration_ms must be within [120, 300]");
        }
        Ok(Self {
            id: value.id,
            asset_kind: value.asset_kind,
            source_id: value.source_id,
            source_path: value.source_path,
            cut_path: value.cut_path,
            checksum: value.checksum,
            source_start_sec: value.source_start_sec,
            source_end_sec: value.source_end_sec,
            output_start_sec: value.output_start_sec,
            output_end_sec: value.output_end_sec,
            match_level: value.match_level,
            reuse_count: value.reuse_count,
            transition: value.transition,
            handles: value.handles,
        })
    }
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
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub main_coverage_sec: f64,
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub main_coverage_ratio: f64,
    #[serde(deserialize_with = "deserialize_nonnegative_finite")]
    pub total_duration_sec: f64,
    pub selected_cut_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainFootagePlanV1 {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    pub status: MainFootagePlanStatus,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub source_package_path: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub narration_timeline_path: String,
    pub source_package_fingerprint: String,
    pub narration_fingerprint: String,
    #[serde(deserialize_with = "deserialize_coverage_target")]
    pub main_coverage_target: f64,
    #[serde(deserialize_with = "deserialize_unique_cuts")]
    pub timeline: Vec<PlannedCutV1>,
    pub diagnostics: PlanDiagnosticsV1,
    pub summary: PlanSummaryV1,
    pub warnings: Vec<MainFootageWarningCode>,
    pub created_at: Option<String>,
    pub fingerprint: Option<String>,
}

fn deserialize_plan_version<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let digits = value.strip_prefix('v').unwrap_or_default();
    if digits.len() < 3 || !digits.chars().all(|character| character.is_ascii_digit()) {
        return Err(serde::de::Error::custom("version is invalid"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(try_from = "MainFootageActiveWire")]
pub struct MainFootageActiveV1 {
    pub schema_version: u8,
    pub status: MainFootagePlanStatus,
    pub version: String,
    pub plan_path: String,
    pub source_package_fingerprint: String,
    pub narration_fingerprint: String,
    pub plan_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MainFootageActiveWire {
    #[serde(deserialize_with = "deserialize_schema_version")]
    schema_version: u8,
    status: MainFootagePlanStatus,
    #[serde(deserialize_with = "deserialize_plan_version")]
    version: String,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    plan_path: String,
    #[serde(deserialize_with = "deserialize_sha256_identity")]
    source_package_fingerprint: String,
    #[serde(deserialize_with = "deserialize_sha256_identity")]
    narration_fingerprint: String,
    #[serde(deserialize_with = "deserialize_sha256_identity")]
    plan_fingerprint: String,
}

impl TryFrom<MainFootageActiveWire> for MainFootageActiveV1 {
    type Error = &'static str;

    fn try_from(value: MainFootageActiveWire) -> Result<Self, Self::Error> {
        let expected = format!("plans/{}/main-footage-plan.json", value.version);
        if value.plan_path != expected {
            return Err("plan_path does not match version");
        }
        Ok(Self {
            schema_version: value.schema_version,
            status: value.status,
            version: value.version,
            plan_path: value.plan_path,
            source_package_fingerprint: value.source_package_fingerprint,
            narration_fingerprint: value.narration_fingerprint,
            plan_fingerprint: value.plan_fingerprint,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainFootageDescriptor {
    pub mode: MainFootageMode,
    #[serde(deserialize_with = "deserialize_artifact_path")]
    pub package_manifest: String,
    #[serde(default, deserialize_with = "deserialize_optional_artifact_path")]
    pub external_sources_manifest: Option<String>,
    #[serde(deserialize_with = "deserialize_coverage_target")]
    pub coverage_target: f64,
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        AssetKind, MainFootageActiveV1, MainFootageDescriptor, MainFootageMode, MainFootagePlanV1,
        NarrationTimelineV1, SourcePackageV1, fingerprint_canonical,
    };

    // Production mutation caught: a permissive Rust mirror could resume an unverified
    // pointer or open a plan outside the job artifact root.
    #[test]
    fn active_plan_pointer_requires_verified_versioned_relative_artifact() {
        let active = json!({
            "schema_version": 1,
            "status": "verified",
            "version": "v001",
            "plan_path": "plans/v001/main-footage-plan.json",
            "source_package_fingerprint": "sha256:package",
            "narration_fingerprint": "sha256:narration",
            "plan_fingerprint": "sha256:plan"
        });
        assert!(serde_json::from_value::<MainFootageActiveV1>(active.clone()).is_ok());
        let mut pending = active.clone();
        pending["status"] = json!("pending");
        assert!(serde_json::from_value::<MainFootageActiveV1>(pending).is_err());
        let mut escaping = active;
        escaping["plan_path"] = json!("../partial.json");
        assert!(serde_json::from_value::<MainFootageActiveV1>(escaping).is_err());

        let mismatched = json!({
            "schema_version": 1,
            "status": "verified",
            "version": "v001",
            "plan_path": "plans/v002/main-footage-plan.json",
            "source_package_fingerprint": "sha256:package",
            "narration_fingerprint": "sha256:narration",
            "plan_fingerprint": "sha256:plan"
        });
        assert!(serde_json::from_value::<MainFootageActiveV1>(mismatched).is_err());
    }

    #[test]
    fn shared_v1_fixtures_deserialize() {
        let plan: MainFootagePlanV1 = serde_json::from_str(include_str!(
            "../../../tests/fixtures/main-footage/contracts/main-footage-plan.v1.json"
        ))
        .unwrap();
        assert_eq!(plan.schema_version, 1);
    }

    #[test]
    fn unknown_schema_versions_are_rejected_during_deserialization() {
        assert!(serde_json::from_str::<MainFootagePlanV1>(r#"{"schema_version":2}"#).is_err());
    }

    #[test]
    fn descriptor_accepts_only_forced_url_pool_contract() {
        let descriptor: MainFootageDescriptor = serde_json::from_value(json!({
            "mode": "forced_url_pool",
            "package_manifest": "packages/source-package.json",
            "external_sources_manifest": "external-footage/v001/manifest.json",
            "coverage_target": 0.6
        }))
        .unwrap();
        assert_eq!(descriptor.mode, MainFootageMode::ForcedUrlPool);
        assert_eq!(
            descriptor.external_sources_manifest.as_deref(),
            Some("external-footage/v001/manifest.json")
        );
        assert!(serde_json::from_value::<MainFootageDescriptor>(json!({
            "mode": "forced",
            "source_package_path": "sources.json",
            "narration_timeline_path": "narration.json",
            "main_coverage_target": 0.6
        }))
        .is_err());
    }

    fn source_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/main-footage/contracts/source-package.v1.json"
        ))
        .unwrap()
    }

    fn narration_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/main-footage/contracts/narration-timeline.v1.json"
        ))
        .unwrap()
    }

    fn plan_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/main-footage/contracts/main-footage-plan.v1.json"
        ))
        .unwrap()
    }

    #[test]
    fn planned_cuts_preserve_their_asset_kind_and_reject_unknown_kinds() {
        let mut external = plan_fixture();
        external["timeline"][0]["asset_kind"] = json!("external_cut");
        let decoded: MainFootagePlanV1 = serde_json::from_value(external).unwrap();
        assert_eq!(decoded.timeline[0].asset_kind, AssetKind::ExternalCut);

        let mut invalid = plan_fixture();
        invalid["timeline"][0]["asset_kind"] = json!("remote_cut");
        assert!(serde_json::from_value::<MainFootagePlanV1>(invalid).is_err());
    }

    #[test]
    fn source_packages_reject_invalid_durations_ranges_and_duplicate_ids() {
        let mut negative_duration = source_fixture();
        negative_duration["sources"][0]["technical"]["duration_sec"] = json!(-1.0);
        assert!(serde_json::from_value::<SourcePackageV1>(negative_duration).is_err());

        let mut zero_scene_range = source_fixture();
        zero_scene_range["scene_indexes"][0]["scenes"][0]["end_sec"] = json!(0.0);
        assert!(serde_json::from_value::<SourcePackageV1>(zero_scene_range).is_err());

        let mut duplicate_source_ids = source_fixture();
        let duplicate = duplicate_source_ids["sources"][0].clone();
        duplicate_source_ids["sources"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(serde_json::from_value::<SourcePackageV1>(duplicate_source_ids).is_err());

        let mut duplicate_scene_ids = source_fixture();
        let duplicate = duplicate_scene_ids["scene_indexes"][0]["scenes"][0].clone();
        duplicate_scene_ids["scene_indexes"][0]["scenes"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(serde_json::from_value::<SourcePackageV1>(duplicate_scene_ids).is_err());
    }

    #[test]
    fn source_packages_require_at_least_one_usable_source() {
        let mut empty_sources = source_fixture();
        empty_sources["sources"] = json!([]);

        assert!(serde_json::from_value::<SourcePackageV1>(empty_sources).is_err());
    }

    #[test]
    fn source_packages_reject_blank_package_identities() {
        for pointer in [
            "/post/id",
            "/post/canonical_url",
            "/post/platform",
            "/analysis_identity",
        ] {
            let mut package = source_fixture();
            *package.pointer_mut(pointer).unwrap() = json!(" \t");
            assert!(
                serde_json::from_value::<SourcePackageV1>(package).is_err(),
                "accepted blank {pointer}"
            );
        }

        let mut blank_fingerprint = source_fixture();
        blank_fingerprint["fingerprint"] = json!(" ");
        assert!(serde_json::from_value::<SourcePackageV1>(blank_fingerprint).is_err());
    }

    #[test]
    fn source_packages_reject_blank_source_and_scene_identities() {
        for pointer in [
            "/sources/0/id",
            "/sources/0/checksum",
            "/sources/0/technical/container",
            "/sources/0/technical/video_codec",
            "/ignored/0/id",
            "/scene_indexes/0/source_id",
            "/scene_indexes/0/checksum",
            "/scene_indexes/0/planning_mode",
            "/scene_indexes/0/scenes/0/id",
        ] {
            let mut package = source_fixture();
            *package.pointer_mut(pointer).unwrap() = json!(" \t");
            assert!(
                serde_json::from_value::<SourcePackageV1>(package).is_err(),
                "accepted blank {pointer}"
            );
        }
    }

    #[test]
    fn source_packages_require_sha256_identities() {
        for pointer in ["/sources/0/checksum", "/scene_indexes/0/checksum"] {
            let mut package = source_fixture();
            *package.pointer_mut(pointer).unwrap() = json!("md5:not-sha256");
            assert!(
                serde_json::from_value::<SourcePackageV1>(package).is_err(),
                "accepted non-SHA-256 {pointer}"
            );
        }

        let mut package = source_fixture();
        package["fingerprint"] = json!("md5:not-sha256");
        assert!(serde_json::from_value::<SourcePackageV1>(package).is_err());
    }

    #[test]
    fn source_packages_require_nonzero_source_dimensions() {
        for pointer in [
            "/sources/0/technical/width",
            "/sources/0/technical/height",
        ] {
            let mut package = source_fixture();
            *package.pointer_mut(pointer).unwrap() = json!(0);
            assert!(
                serde_json::from_value::<SourcePackageV1>(package).is_err(),
                "accepted zero {pointer}"
            );
        }
    }

    #[test]
    fn narration_timelines_reject_non_finite_negative_and_reversed_timings() {
        assert!(serde_json::from_str::<NarrationTimelineV1>(
            r#"{"schema_version":1,"audio_path":"narration/audio.mp3","audio_checksum":"x","duration_sec":1e999,"words":[]}"#
        )
        .is_err());

        let mut negative_duration = narration_fixture();
        negative_duration["duration_sec"] = json!(-1.0);
        assert!(serde_json::from_value::<NarrationTimelineV1>(negative_duration).is_err());

        let mut reversed_word = narration_fixture();
        reversed_word["words"][0]["end_sec"] = json!(0.0);
        assert!(serde_json::from_value::<NarrationTimelineV1>(reversed_word).is_err());
    }

    #[test]
    fn plans_reject_invalid_ranges_coverage_and_duplicate_cut_ids() {
        let mut low_coverage = plan_fixture();
        low_coverage["main_coverage_target"] = json!(0.59);
        assert!(serde_json::from_value::<MainFootagePlanV1>(low_coverage).is_err());

        let mut high_coverage = plan_fixture();
        high_coverage["main_coverage_target"] = json!(1.01);
        assert!(serde_json::from_value::<MainFootagePlanV1>(high_coverage).is_err());

        let mut zero_source_range = plan_fixture();
        zero_source_range["timeline"][0]["source_end_sec"] = json!(0.0);
        assert!(serde_json::from_value::<MainFootagePlanV1>(zero_source_range).is_err());

        let mut reversed_output_range = plan_fixture();
        reversed_output_range["timeline"][0]["output_end_sec"] = json!(-1.0);
        assert!(serde_json::from_value::<MainFootagePlanV1>(reversed_output_range).is_err());

        let mut duplicate_cut_ids = plan_fixture();
        let duplicate = duplicate_cut_ids["timeline"][0].clone();
        duplicate_cut_ids["timeline"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(serde_json::from_value::<MainFootagePlanV1>(duplicate_cut_ids).is_err());
    }

    #[test]
    fn canonical_fingerprints_sort_object_keys_preserve_arrays_and_project_sources() {
        assert_eq!(
            fingerprint_canonical(&json!({"b": 2, "a": 1})).unwrap(),
            fingerprint_canonical(&json!({"a": 1, "b": 2})).unwrap(),
        );
        assert_ne!(
            fingerprint_canonical(&json!({"a": [1, 2]})).unwrap(),
            fingerprint_canonical(&json!({"a": [2, 1]})).unwrap(),
        );

        let source = source_fixture();
        let mut excluded_fields_changed = source.clone();
        excluded_fields_changed["created_at"] = json!("2099-01-01T00:00:00Z");
        excluded_fields_changed["fingerprint"] = json!("sha256:stored");
        excluded_fields_changed["sources"][0]["path"] = json!("sources/relocated.mp4");
        excluded_fields_changed["scene_indexes"][0]["path"] = json!("indexes/relocated.json");
        excluded_fields_changed["ignored"][0]["message"] = json!("human-only detail");
        assert_eq!(
            fingerprint_canonical(&source).unwrap(),
            fingerprint_canonical(&excluded_fields_changed).unwrap(),
        );

        let mut accepted_metadata_changed = source;
        accepted_metadata_changed["sources"][0]["technical"]["duration_sec"] = json!(99.0);
        assert_ne!(
            fingerprint_canonical(&excluded_fields_changed).unwrap(),
            fingerprint_canonical(&accepted_metadata_changed).unwrap(),
        );
    }

    #[test]
    fn canonical_json_numbers_match_json_stringify_at_ecmascript_boundaries() {
        // These are literal JSON.stringify outputs, not values produced by Rust's
        // formatter. Each catches a real cross-runtime fingerprint divergence.
        for (input, expected) in [
            ("-0", "0"),
            ("1e-7", "1e-7"),
            ("0.000001", "0.000001"),
            ("1e-6", "0.000001"),
            ("1e20", "100000000000000000000"),
            ("1e21", "1e+21"),
            ("-1e21", "-1e+21"),
        ] {
            let value: Value = serde_json::from_str(input).unwrap();
            assert_eq!(super::canonical_json(&value).unwrap(), expected, "{input}");
        }
    }

    #[test]
    fn narration_fingerprints_normalize_composed_and_decomposed_unicode_like_typescript() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/main-footage/contracts/narration-unicode-equivalence.v1.json"
        ))
        .unwrap();
        assert_eq!(
            fingerprint_canonical(&fixture["composed"]).unwrap(),
            fingerprint_canonical(&fixture["decomposed"]).unwrap(),
        );
    }
}
