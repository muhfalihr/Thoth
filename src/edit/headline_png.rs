//! High-fidelity hook-title renderer via Pillow (`scripts/render_headline.py`).
//!
//! libass (the ASS path) can't match a designed viral cover — thin uneven
//! strokes, no real drop-shadow, weaker AA. This module shells out to a small
//! Python+Pillow script that renders the headline as a full-frame transparent
//! PNG (thick uniform stroke, soft shadow, per-line colours, supersampled AA).
//! The encoder then overlays that PNG at 0,0 with the hook fade/timing.
//!
//! Everything is best-effort: if Python/Pillow is missing or the script fails,
//! `render` returns `Err` and the caller falls back to the ASS renderer.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use super::error::EditError;

/// Drop-shadow parameters for the PNG renderer.
#[derive(Debug, Clone, Serialize)]
pub struct HeadlineShadow {
    pub dx: i32,
    pub dy: i32,
    pub blur: f32,
    pub color: String,
    pub alpha: u32,
}

/// Spec serialised to JSON and handed to `render_headline.py`.
#[derive(Debug, Clone, Serialize)]
pub struct HeadlinePngSpec {
    pub text: String,
    pub width: u32,
    pub height: u32,
    pub font_path: String,
    pub font_size: u32,
    pub palette: Vec<String>,
    pub stroke_width: u32,
    pub stroke_color: String,
    pub line_spacing: f32,
    pub text_align: String,
    pub margin_l: u32,
    pub max_lines: u32,
    /// Distance (px) from the BOTTOM of the frame to the bottom of the text block.
    pub margin_v: u32,
    pub max_width_ratio: f32,
    pub uppercase: bool,
    pub shadow: HeadlineShadow,
    /// Absolute/relative path the script writes the PNG to.
    pub out: String,
}

impl HeadlinePngSpec {
    /// Render the PNG by invoking the Python script. Writes the JSON spec to a
    /// sidecar next to `out`, runs `<python> <script> <spec.json>`, and verifies
    /// the PNG exists. Returns the PNG path on success.
    ///
    /// `python_cmd` is the interpreter (e.g. "python"); `script` points at
    /// `scripts/render_headline.py`.
    pub fn render(&self, python_cmd: &str, script: &Path) -> Result<PathBuf, EditError> {
        let out_path = PathBuf::from(&self.out);
        let spec_path = out_path.with_extension("spec.json");

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| EditError::SubtitleError(format!("headline spec serialise: {e}")))?;
        std::fs::write(&spec_path, json)?;

        if !script.exists() {
            return Err(EditError::SubtitleError(format!(
                "headline script not found: {}",
                script.display()
            )));
        }

        let output = Command::new(python_cmd)
            .arg(script)
            .arg(&spec_path)
            .output()
            .map_err(|e| EditError::SubtitleError(format!(
                "failed to spawn '{python_cmd}': {e}"
            )))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(EditError::SubtitleError(format!(
                "render_headline.py failed ({}): {}",
                output.status,
                stderr.trim()
            )));
        }

        if !out_path.exists() {
            return Err(EditError::SubtitleError(
                "render_headline.py reported success but produced no PNG".into(),
            ));
        }
        Ok(out_path)
    }
}

/// Resolve the Python interpreter: `$THOTH_PYTHON` if set, else `python`.
pub fn python_cmd() -> String {
    std::env::var("THOTH_PYTHON").unwrap_or_else(|_| "python".to_owned())
}
