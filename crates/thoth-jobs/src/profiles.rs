use std::{
    fs, io,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ThothHome;

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// A project and its workspace owned below `ThothHome`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub workspace_path: PathBuf,
    pub created_at: String,
    pub updated_at: String,
}

/// The current validated settings of one project-scoped profile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProfileRecord {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub settings: ProfileSettings,
    pub credential_ref: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// An immutable former state of a profile, retained before each update.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProfileRevision {
    pub id: String,
    pub profile_id: String,
    pub revision: i64,
    pub name: String,
    pub description: String,
    pub settings: ProfileSettings,
    pub credential_ref: Option<String>,
    pub created_at: String,
}

const PROVIDERS: &[&str] = &[
    "groq",
    "openai",
    "claude",
    "gemini",
    "vllm",
    "ollama",
    "novita",
    "together",
    "fireworks",
];
const MODELS: &[&str] = &["tiny", "base", "small", "medium", "large-v3"];
const LAYOUTS: &[&str] = &["vertical", "horizontal", "square"];
const CLIP_STYLES: &[&str] = &["fade", "flash", "zoom", "smooth", "none"];

/// Safe narration defaults that can be stored in a project profile.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NarrationSettings {
    pub language: Option<String>,
}

/// Existing visual and edit CLI knobs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct VisualEditSettings {
    pub layout: String,
    pub clip_style: String,
    pub style_profile: String,
    pub social: String,
    pub bgm: Option<PathBuf>,
    pub bgm_volume: f64,
    pub sfx_intro: Option<PathBuf>,
    pub headline_dur: f64,
}

impl Default for VisualEditSettings {
    fn default() -> Self {
        Self {
            layout: "vertical".to_owned(),
            clip_style: "fade".to_owned(),
            style_profile: "auto".to_owned(),
            social: String::new(),
            bgm: None,
            bgm_volume: 0.12,
            sfx_intro: None,
            headline_dur: 4.0,
        }
    }
}

/// Existing analysis CLI knobs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AnalysisSettings {
    pub provider: String,
    pub model: String,
    pub max_clips: usize,
    pub keywords: Vec<String>,
}

impl Default for AnalysisSettings {
    fn default() -> Self {
        Self {
            provider: "novita".to_owned(),
            model: "medium".to_owned(),
            max_clips: 3,
            keywords: Vec::new(),
        }
    }
}

/// A profile's optional default input. It remains external to `ThothHome`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IngestSourceSettings {
    pub source: Option<String>,
    pub content_set: Option<PathBuf>,
}

/// The optional output directory is managed by Thoth and must stay inside its home.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OutputSettings {
    pub directory: Option<PathBuf>,
}

/// Reserved typed section for later supported knobs; schema v1 intentionally has none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AdvancedSettings {}

/// Versioned, validated defaults owned by one project profile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProfileSettings {
    pub schema_version: u32,
    pub narration: NarrationSettings,
    pub visual_edit: VisualEditSettings,
    pub analysis: AnalysisSettings,
    pub ingest_source: IngestSourceSettings,
    pub output: OutputSettings,
    pub advanced: AdvancedSettings,
}

impl Default for ProfileSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            narration: NarrationSettings::default(),
            visual_edit: VisualEditSettings::default(),
            analysis: AnalysisSettings::default(),
            ingest_source: IngestSourceSettings::default(),
            output: OutputSettings::default(),
            advanced: AdvancedSettings::default(),
        }
    }
}

/// Typed one-off settings. `None` means retain the selected profile's value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RunOverrides {
    pub narration_language: Option<Option<String>>,
    pub visual_edit_layout: Option<String>,
    pub visual_edit_clip_style: Option<String>,
    pub visual_edit_style_profile: Option<String>,
    pub visual_edit_social: Option<String>,
    pub visual_edit_bgm: Option<Option<PathBuf>>,
    pub visual_edit_bgm_volume: Option<f64>,
    pub visual_edit_sfx_intro: Option<Option<PathBuf>>,
    pub visual_edit_headline_dur: Option<f64>,
    pub analysis_provider: Option<String>,
    pub analysis_model: Option<String>,
    pub analysis_max_clips: Option<usize>,
    pub analysis_keywords: Option<Vec<String>>,
    pub ingest_source_source: Option<Option<String>>,
    pub ingest_source_content_set: Option<Option<PathBuf>>,
    pub output_directory: Option<Option<PathBuf>>,
}

/// The complete settings used by a single job after its profile and overrides resolve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ResolvedSettings {
    pub schema_version: u32,
    pub narration: NarrationSettings,
    pub visual_edit: VisualEditSettings,
    pub analysis: AnalysisSettings,
    pub ingest_source: IngestSourceSettings,
    pub output: OutputSettings,
    pub advanced: AdvancedSettings,
}

impl Default for ResolvedSettings {
    fn default() -> Self {
        Self::from(ProfileSettings::default())
    }
}

impl From<ProfileSettings> for ResolvedSettings {
    fn from(settings: ProfileSettings) -> Self {
        Self {
            schema_version: settings.schema_version,
            narration: settings.narration,
            visual_edit: settings.visual_edit,
            analysis: settings.analysis,
            ingest_source: settings.ingest_source,
            output: settings.output,
            advanced: settings.advanced,
        }
    }
}

/// Resolves typed overrides without ever mutating the selected profile.
pub fn resolve_settings(
    profile: &ProfileSettings,
    overrides: &RunOverrides,
    home: &ThothHome,
) -> Result<ResolvedSettings> {
    let mut resolved = ResolvedSettings::from(profile.clone());

    if let Some(value) = &overrides.narration_language {
        resolved.narration.language = value.clone();
    }
    if let Some(value) = &overrides.visual_edit_layout {
        resolved.visual_edit.layout = value.clone();
    }
    if let Some(value) = &overrides.visual_edit_clip_style {
        resolved.visual_edit.clip_style = value.clone();
    }
    if let Some(value) = &overrides.visual_edit_style_profile {
        resolved.visual_edit.style_profile = value.clone();
    }
    if let Some(value) = &overrides.visual_edit_social {
        resolved.visual_edit.social = value.clone();
    }
    if let Some(value) = &overrides.visual_edit_bgm {
        resolved.visual_edit.bgm = value.clone();
    }
    if let Some(value) = overrides.visual_edit_bgm_volume {
        resolved.visual_edit.bgm_volume = value;
    }
    if let Some(value) = &overrides.visual_edit_sfx_intro {
        resolved.visual_edit.sfx_intro = value.clone();
    }
    if let Some(value) = overrides.visual_edit_headline_dur {
        resolved.visual_edit.headline_dur = value;
    }
    if let Some(value) = &overrides.analysis_provider {
        resolved.analysis.provider = value.clone();
    }
    if let Some(value) = &overrides.analysis_model {
        resolved.analysis.model = value.clone();
    }
    if let Some(value) = overrides.analysis_max_clips {
        resolved.analysis.max_clips = value;
    }
    if let Some(value) = &overrides.analysis_keywords {
        resolved.analysis.keywords = value.clone();
    }
    if let Some(value) = &overrides.ingest_source_source {
        resolved.ingest_source.source = value.clone();
    }
    if let Some(value) = &overrides.ingest_source_content_set {
        resolved.ingest_source.content_set = value.clone();
    }
    if let Some(value) = &overrides.output_directory {
        resolved.output.directory = value.clone();
    }

    validate_resolved_settings(&resolved, home)?;
    Ok(resolved)
}

/// Validates a stored profile before it can be selected for a run.
pub fn validate_settings(settings: &ProfileSettings, home: &ThothHome) -> Result<()> {
    validate_parts(
        settings.schema_version,
        &settings.narration,
        &settings.visual_edit,
        &settings.analysis,
        &settings.ingest_source,
        &settings.output,
        home,
    )
}

/// Validates a resolved snapshot before it can be stored or handed to a worker.
pub fn validate_resolved_settings(settings: &ResolvedSettings, home: &ThothHome) -> Result<()> {
    validate_parts(
        settings.schema_version,
        &settings.narration,
        &settings.visual_edit,
        &settings.analysis,
        &settings.ingest_source,
        &settings.output,
        home,
    )
}

fn validate_parts(
    schema_version: u32,
    narration: &NarrationSettings,
    visual_edit: &VisualEditSettings,
    analysis: &AnalysisSettings,
    ingest_source: &IngestSourceSettings,
    output: &OutputSettings,
    home: &ThothHome,
) -> Result<()> {
    ensure!(
        schema_version == SETTINGS_SCHEMA_VERSION,
        "unsupported settings schema version {schema_version}"
    );
    validate_enum("analysis.provider", &analysis.provider, PROVIDERS)?;
    validate_enum("analysis.model", &analysis.model, MODELS)?;
    ensure!(
        analysis.max_clips > 0,
        "analysis.max_clips must be greater than zero"
    );
    validate_enum("visual_edit.layout", &visual_edit.layout, LAYOUTS)?;
    validate_enum(
        "visual_edit.clip_style",
        &visual_edit.clip_style,
        CLIP_STYLES,
    )?;
    validate_non_blank("visual_edit.style_profile", &visual_edit.style_profile)?;
    validate_optional_string("narration.language", narration.language.as_deref())?;
    validate_optional_string("ingest_source.source", ingest_source.source.as_deref())?;
    for keyword in &analysis.keywords {
        validate_non_blank("analysis.keywords", keyword)?;
    }
    validate_optional_path("visual_edit.bgm", visual_edit.bgm.as_deref())?;
    validate_optional_path("visual_edit.sfx_intro", visual_edit.sfx_intro.as_deref())?;
    validate_optional_path(
        "ingest_source.content_set",
        ingest_source.content_set.as_deref(),
    )?;
    ensure!(
        visual_edit.bgm_volume.is_finite() && (0.0..=1.0).contains(&visual_edit.bgm_volume),
        "visual_edit.bgm_volume must be finite and between 0.0 and 1.0"
    );
    ensure!(
        visual_edit.headline_dur.is_finite() && visual_edit.headline_dur > 0.0,
        "visual_edit.headline_dur must be finite and greater than zero"
    );
    ensure!(
        ingest_source.source.is_none() || ingest_source.content_set.is_none(),
        "ingest_source.source and ingest_source.content_set are mutually exclusive"
    );

    if let Some(directory) = &output.directory {
        validate_managed_output_directory(directory, home)?;
    }
    Ok(())
}

fn validate_enum(field: &str, value: &str, allowed: &[&str]) -> Result<()> {
    validate_non_blank(field, value)?;
    if !allowed.contains(&value) {
        bail!("{field} must be one of: {}", allowed.join(", "));
    }
    Ok(())
}

fn validate_non_blank(field: &str, value: &str) -> Result<()> {
    ensure!(!value.trim().is_empty(), "{field} must not be blank");
    Ok(())
}

fn validate_optional_string(field: &str, value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        validate_non_blank(field, value)?;
    }
    Ok(())
}

fn validate_optional_path(field: &str, value: Option<&Path>) -> Result<()> {
    if let Some(value) = value {
        ensure!(!value.as_os_str().is_empty(), "{field} must not be blank");
    }
    Ok(())
}

fn validate_managed_output_directory(directory: &Path, home: &ThothHome) -> Result<()> {
    ensure!(
        directory.is_absolute(),
        "output.directory must be an absolute path under ThothHome"
    );
    let canonical_home = fs::canonicalize(home.root()).with_context(|| {
        format!(
            "cannot validate managed output because ThothHome does not exist: {}",
            home.root().display()
        )
    })?;
    let existing_ancestor = canonicalize_existing_ancestor(directory)?;
    ensure!(
        existing_ancestor.starts_with(&canonical_home),
        "output.directory must stay under ThothHome without following a symlink outside it"
    );
    Ok(())
}

fn canonicalize_existing_ancestor(path: &Path) -> Result<PathBuf> {
    let mut candidate = path;
    loop {
        match fs::canonicalize(candidate) {
            Ok(canonical) => return Ok(canonical),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                candidate = candidate
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("output.directory has no existing ancestor"))?;
            }
            Err(error) => return Err(error).context("cannot inspect output.directory"),
        }
    }
}

/// Produces the only settings JSON permitted to enter a job snapshot.
pub fn redacted_settings_json(settings: &ResolvedSettings, credential_ref: Option<&str>) -> Value {
    let mut snapshot = serde_json::to_value(settings).expect("profile settings must serialize");
    let object = snapshot
        .as_object_mut()
        .expect("profile settings serialize to an object");
    object.insert(
        "credential_ref".to_owned(),
        credential_ref.map_or(Value::Null, |reference| json!(reference)),
    );
    snapshot
}
