//! AI cover/thumbnail intro via `scripts/render_cover.py`.
//!
//! Builds a full-screen cover for the hook window: AI background (Novita FLUX.1
//! schnell, themed to the headline) + subject cutout (rembg) + the headline text.
//! The encoder shows it opaque for `duration_sec`, then dissolves to the footage.
//!
//! Best-effort: any failure (no Python / no Novita key / network / rembg) returns
//! `Err`, and the caller falls back to the normal hook title.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use super::error::EditError;

/// Spec serialised to JSON for `render_cover.py`.
#[derive(Debug, Clone, Serialize)]
pub struct CoverSpec {
    /// Fallback background prompt (used when LLM translation is off/fails).
    pub prompt: String,
    /// Style suffix appended after the (English) scene description.
    pub prompt_suffix: String,
    /// When true, the script asks the LLM to turn `headline_text` into a vivid
    /// ENGLISH scene prompt before generation (FLUX understands English best).
    pub translate: bool,
    /// Novita chat model + base URL used for the prompt translation.
    pub chat_model: String,
    pub chat_base_url: String,
    /// Novita VISION model + base URL used to describe the actual frame so the AI
    /// image depicts the real event (empty = skip vision, fall back to headline).
    pub vision_model: String,
    pub vision_base_url: String,
    /// Headline text baked onto the cover.
    pub headline_text: String,
    /// Detailed description of the topic/event (beyond the short headline) — fed to the LLM so the
    /// generated scene reflects what the content is actually ABOUT, not just the 12-word hook.
    pub topic_desc: String,
    /// Subject's name → internet reference-photo lookup (Wikipedia) for a better face-swap. Empty = skip.
    pub subject_name: String,
    /// Swap the real subject's face onto the AI-generated subject (ai mode) for likeness.
    pub face_swap: bool,
    /// Image backend: "flux" | "openrouter" (image-output model preserving subject identity).
    pub image_engine: String,
    /// OpenRouter image-output model id (when image_engine="openrouter").
    pub image_model: String,
    /// "cutout" = composite a real subject cutout; "ai" = FLUX generates the
    /// scene; "auto" = cutout when readable, else AI.
    pub subject_mode: String,
    /// Frame to cut the subject from (empty = no cutout / "ai" mode).
    pub subject_frame: String,
    /// Frame to DESCRIBE via vision for the AI event recreation (set whenever a
    /// frame exists, both modes; empty = none).
    pub describe_frame: String,
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
    pub margin_v: u32,
    pub max_width_ratio: f32,
    pub uppercase: bool,
    pub text_shadow: super::headline_png::HeadlineShadow,
    pub model_steps: u32,
    pub model_seed: u32,
    pub bg_width: u32,
    pub bg_height: u32,
    pub rembg_model: String,
    pub subject_scale: f32,
    pub darken: f32,
    /// Output PNG path.
    pub out: String,
}

impl CoverSpec {
    /// Render the cover PNG by invoking the Python script. Writes the JSON spec to
    /// a sidecar, runs `<python> <script> <spec.json>`, verifies the PNG exists.
    pub fn render(&self, python_cmd: &str, script: &Path) -> Result<PathBuf, EditError> {
        let out_path = PathBuf::from(&self.out);
        let spec_path = out_path.with_extension("spec.json");

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| EditError::SubtitleError(format!("cover spec serialise: {e}")))?;
        std::fs::write(&spec_path, json)?;

        if !script.exists() {
            return Err(EditError::SubtitleError(format!(
                "cover script not found: {}",
                script.display()
            )));
        }

        let output = Command::new(python_cmd)
            .arg(script)
            .arg(&spec_path)
            .output()
            .map_err(|e| EditError::SubtitleError(format!("failed to spawn '{python_cmd}': {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(EditError::SubtitleError(format!(
                "render_cover.py failed ({}): {}",
                output.status,
                stderr.lines().last().unwrap_or("").trim()
            )));
        }
        if !out_path.exists() {
            return Err(EditError::SubtitleError(
                "render_cover.py reported success but produced no PNG".into(),
            ));
        }
        Ok(out_path)
    }
}
