//! One-way legacy `config.toml` → typed project/profile importer.
//!
//! Reads the legacy file exactly once per call and never writes or deletes
//! it. Only `[styles.profiles.default]` is understood: its recognized keys
//! map onto the new `Default` profile's `ProfileSettings.visual_edit`;
//! everything else in that table is reported as a warning, never stored as
//! free-form settings (spec: docs/superpowers/specs/2026-07-18-project-profile-studio-design.md §9).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use thoth_jobs::{JobStore, ProfileSettings, ResourceError};

const IMPORTED_PROJECT: &str = "Imported";
const IMPORTED_PROFILE: &str = "Default";

/// Outcome of one `import_legacy_config` call.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportReport {
    pub imported: bool,
    pub warnings: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LegacyConfig {
    styles: LegacyStyles,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LegacyStyles {
    profiles: LegacyProfiles,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct LegacyProfiles {
    default: Option<LegacyDefaultProfile>,
}

/// The `[styles.profiles.default]` fields this importer understands, 1:1
/// with `VisualEditSettings`. Any other key in that table lands in `extra`
/// (via `flatten`) and becomes a migration warning instead of being stored.
#[derive(Deserialize, Default)]
#[serde(default)]
struct LegacyDefaultProfile {
    layout: Option<String>,
    clip_style: Option<String>,
    style_profile: Option<String>,
    social: Option<String>,
    bgm: Option<String>,
    sfx_intro: Option<String>,
    bgm_volume: Option<f64>,
    headline_dur: Option<f64>,
    #[serde(flatten)]
    extra: BTreeMap<String, toml::Value>,
}

/// Imports the legacy `config.toml` at `config_path` into project
/// `"Imported"` / profile `"Default"`, once. Idempotency marker is the
/// unique project name: a second call hits `ResourceError::DuplicateName`
/// on `create_project` and returns `imported: false` without further writes.
pub async fn import_legacy_config(
    store: &JobStore,
    config_path: &Path,
) -> anyhow::Result<ImportReport> {
    let project = match store.create_project(IMPORTED_PROJECT).await {
        Ok(project) => project,
        Err(ResourceError::DuplicateName) => {
            return Ok(ImportReport {
                imported: false,
                warnings: Vec::new(),
            });
        }
        Err(other) => return Err(other.into()),
    };

    let text = std::fs::read_to_string(config_path).unwrap_or_default();
    let legacy: LegacyConfig = toml::from_str(&text).unwrap_or_default();
    let (settings, warnings) = map_settings(legacy);

    // ponytail: project-created-but-profile-create-fails (e.g. disk full) is
    // an accepted partial for this task — the project already existing means
    // every later retry reports `imported: false` forever. Upgrade path: a
    // transaction spanning both writes, if that partial ever bites in practice.
    store
        .create_profile(
            &project.id,
            IMPORTED_PROFILE,
            "Imported from legacy config.toml",
            settings,
            None,
        )
        .await?;

    Ok(ImportReport {
        imported: true,
        warnings,
    })
}

fn map_settings(legacy: LegacyConfig) -> (ProfileSettings, Vec<String>) {
    let mut settings = ProfileSettings::default();
    let mut warnings = Vec::new();

    let Some(profile) = legacy.styles.profiles.default else {
        return (settings, warnings);
    };

    if let Some(layout) = profile.layout {
        settings.visual_edit.layout = layout;
    }
    if let Some(clip_style) = profile.clip_style {
        settings.visual_edit.clip_style = clip_style;
    }
    if let Some(style_profile) = profile.style_profile {
        settings.visual_edit.style_profile = style_profile;
    }
    if let Some(social) = profile.social {
        settings.visual_edit.social = social;
    }
    if let Some(bgm) = profile.bgm {
        settings.visual_edit.bgm = Some(PathBuf::from(bgm));
    }
    if let Some(sfx_intro) = profile.sfx_intro {
        settings.visual_edit.sfx_intro = Some(PathBuf::from(sfx_intro));
    }
    if let Some(bgm_volume) = profile.bgm_volume {
        settings.visual_edit.bgm_volume = bgm_volume;
    }
    if let Some(headline_dur) = profile.headline_dur {
        settings.visual_edit.headline_dur = headline_dur;
    }

    for key in profile.extra.keys() {
        warnings.push(format!(
            "styles.profiles.default.{key} is not supported and was skipped"
        ));
    }

    (settings, warnings)
}
