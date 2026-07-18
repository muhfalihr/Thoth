//! Headless browser screenshot via Python + Playwright (Phase 2).
//!
//! Calls `scripts/news/news_screenshot.py` as a subprocess (routed through the
//! configured conda environment). The script outputs a JSON envelope that we
//! parse into [`ScreenshotResult`].
//!
//! If the screenshot script is missing or the browser fails, `screenshot()`
//! returns `Ok(None)` — callers log a warning and continue without a screenshot
//! rather than failing the whole enrichment run.

use std::path::PathBuf;

use serde::Deserialize;
use tracing::{debug, warn};

use crate::execution::JobExecutionContext;

use crate::config::NewsConfig;

use super::error::NewsError;
use super::util::{python_command, run_command};

/// Result of a successful screenshot operation.
#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    /// Absolute path to the raw PNG screenshot (viewport capture).
    pub raw_path: PathBuf,
    /// Article title extracted from the page (may be empty).
    pub title: String,
    /// First paragraph / lead text (may be empty).
    pub lead: String,
    /// Domain / publication name (may be empty).
    pub source: String,
}

/// JSON envelope emitted by `scripts/news/news_screenshot.py`.
#[derive(Debug, Deserialize)]
struct ScreenshotEnvelope {
    success: bool,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    lead: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    error: Option<String>,
}

/// Take a headless screenshot of `url`, saving the raw PNG to `output_path`.
///
/// Returns `Ok(Some(...))` on success, `Ok(None)` when the script is missing or
/// the browser cannot load the page (caller should log + skip gracefully).
pub async fn screenshot(
    execution: &JobExecutionContext,
    config: &NewsConfig,
    url: &str,
    output_path: &PathBuf,
) -> Result<Option<ScreenshotResult>, NewsError> {
    let script = &config.screenshot_script;

    // Soft-fail if the script is not present.
    if !script.exists() {
        warn!("screenshot script not found: {} — skipping screenshots", script.display());
        return Ok(None);
    }

    debug!("screenshotting {}", url);

    let mut cmd = python_command(config, script)?;
    cmd.arg("--url").arg(url)
        .arg("--output").arg(output_path)
        .arg("--width").arg(config.screenshot_width_px.to_string())
        .arg("--timeout").arg(config.screenshot_timeout_secs.to_string());

    let stdout = match run_command(execution, cmd, "screenshot", config.screenshot_timeout_secs + 15).await {
        Ok(s) => s,
        Err(e) => {
            warn!("screenshot subprocess failed for {url}: {e}");
            return Ok(None);
        }
    };

    let env = parse_screenshot_envelope(&stdout);
    match env {
        None => {
            warn!("screenshot: could not parse JSON output for {url}");
            Ok(None)
        }
        Some(env) if !env.success => {
            warn!(
                "screenshot: script reported failure for {}: {}",
                url,
                env.error.as_deref().unwrap_or("(no error message)")
            );
            Ok(None)
        }
        Some(env) => {
            let raw = match env.path {
                Some(ref p) if !p.is_empty() => PathBuf::from(p),
                _ => {
                    warn!("screenshot: success=true but no path returned for {url}");
                    return Ok(None);
                }
            };
            if !raw.exists() {
                warn!("screenshot: file missing after capture: {}", raw.display());
                return Ok(None);
            }
            Ok(Some(ScreenshotResult {
                raw_path: raw,
                title:    env.title,
                lead:     env.lead,
                source:   env.source,
            }))
        }
    }
}

fn parse_screenshot_envelope(stdout: &str) -> Option<ScreenshotEnvelope> {
    let trimmed = stdout.trim();
    // Find the first `{` in case there are log lines before the JSON.
    let json = trimmed.find('{').map(|i| &trimmed[i..])?;
    serde_json::from_str(json).ok()
}
