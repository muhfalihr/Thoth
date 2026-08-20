use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use anyhow::{Context, Result};
use serde::Deserialize;

pub const DEFAULT_SCOUT_OUTPUT_DIR: &str = "scout/output";
pub const SCOUT_OUTPUT_DIR_ENV: &str = "THOTH_SCOUT_OUTPUT_DIR";

#[derive(Debug, Default, Deserialize)]
struct WorkerConfigSubset {
    #[serde(default)]
    scout: ScoutOutputSettings,
}

/// The light-weight part of worker configuration that both the queue server
/// and the rendering worker must resolve identically.
#[derive(Debug, Clone, Deserialize)]
pub struct ScoutOutputSettings {
    #[serde(default = "default_output_dir")]
    pub output_dir: PathBuf,
}

impl Default for ScoutOutputSettings {
    fn default() -> Self {
        Self {
            output_dir: default_output_dir(),
        }
    }
}

fn default_output_dir() -> PathBuf {
    PathBuf::from(DEFAULT_SCOUT_OUTPUT_DIR)
}

/// Resolve the worker's Scout hand-off directory with one explicit precedence:
/// `THOTH_SCOUT_OUTPUT_DIR`, then typed `[scout].output_dir`, then the legacy
/// `scout/output` default. A malformed present TOML file is an error.
pub fn load_scout_output_dir(config_path: &Path) -> Result<PathBuf> {
    let from_file = match fs::read_to_string(config_path) {
        Ok(raw) => {
            toml::from_str::<WorkerConfigSubset>(&raw)
                .context("failed to parse Scout worker configuration")?
                .scout
                .output_dir
        }
        Err(error) if error.kind() == ErrorKind::NotFound => default_output_dir(),
        Err(error) => return Err(error).context("failed to read Scout worker configuration"),
    };

    match std::env::var_os(SCOUT_OUTPUT_DIR_ENV) {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        Some(_) => anyhow::bail!("{SCOUT_OUTPUT_DIR_ENV} must not be empty"),
        None => Ok(from_file),
    }
}

/// Warm server-side resolver mirroring the worker's last-good reload policy.
/// A valid reload replaces the cached value; a malformed/unreadable reload
/// retains the value that was last resolved successfully.
#[derive(Clone)]
pub struct ScoutOutputConfig {
    config_path: Arc<PathBuf>,
    last_good: Arc<RwLock<PathBuf>>,
}

impl ScoutOutputConfig {
    pub fn new(config_path: PathBuf) -> Result<Self> {
        let initial = load_scout_output_dir(&config_path)?;
        Ok(Self {
            config_path: Arc::new(config_path),
            last_good: Arc::new(RwLock::new(initial)),
        })
    }

    pub fn resolve(&self) -> PathBuf {
        match load_scout_output_dir(&self.config_path) {
            Ok(resolved) => {
                *self.last_good.write().expect("Scout config lock poisoned") = resolved.clone();
                resolved
            }
            Err(_) => self
                .last_good
                .read()
                .expect("Scout config lock poisoned")
                .clone(),
        }
    }
}
