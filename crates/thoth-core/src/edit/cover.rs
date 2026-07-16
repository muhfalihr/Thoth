//! AI cover/thumbnail intro via `scripts/render/render_cover.py`.
//!
//! Builds a full-screen cover for the hook window: AI background (Novita FLUX.1
//! schnell, themed to the headline) + subject cutout (rembg) + the headline text.
//! The encoder shows it opaque for `duration_sec`, then dissolves to the footage.
//!
//! Best-effort: any failure (no Python / no Novita key / network / rembg) returns
//! `Err`, and the caller falls back to the normal hook title.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

use super::error::EditError;
use crate::execution::JobExecutionContext;

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
    pub async fn render(
        &self,
        execution: &JobExecutionContext,
        python_cmd: &str,
        script: &Path,
    ) -> Result<PathBuf, EditError> {
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

        let mut command = Command::new(python_cmd);
        command.arg(script).arg(&spec_path);
        let output = execution.output(&mut command).await.map_err(|error| {
            EditError::from_execution(error, format!("failed to spawn '{python_cmd}'"))
        })?;

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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::execution::JobExecutionContext;

    #[cfg(windows)]
    #[tokio::test]
    async fn blocking_media_wrapper_honors_cancellation() {
        let base = std::env::temp_dir().join(format!(
            "thoth-cover-cancellation-{}",
            uuid::Uuid::new_v4()
        ));
        let script = base.with_extension("vbs");
        let out = base.with_extension("png");
        let spec_path = out.with_extension("spec.json");
        let marker = PathBuf::from(format!("{}.started", spec_path.display()));
        std::fs::write(
            &script,
            "Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n\
             Set marker = fso.CreateTextFile(WScript.Arguments(0) & \".started\", True)\r\n\
             marker.Close\r\n\
             WScript.Sleep 30000\r\n",
        )
        .expect("write helper script");

        let spec = CoverSpec {
            prompt: String::new(),
            prompt_suffix: String::new(),
            translate: false,
            chat_model: String::new(),
            chat_base_url: String::new(),
            vision_model: String::new(),
            vision_base_url: String::new(),
            headline_text: String::new(),
            topic_desc: String::new(),
            subject_name: String::new(),
            face_swap: false,
            image_engine: String::new(),
            image_model: String::new(),
            subject_mode: String::new(),
            subject_frame: String::new(),
            describe_frame: String::new(),
            width: 1,
            height: 1,
            font_path: String::new(),
            font_size: 1,
            palette: Vec::new(),
            stroke_width: 0,
            stroke_color: String::new(),
            line_spacing: 0.0,
            text_align: String::new(),
            margin_l: 0,
            max_lines: 0,
            margin_v: 0,
            max_width_ratio: 0.0,
            uppercase: false,
            text_shadow: super::super::headline_png::HeadlineShadow {
                dx: 0,
                dy: 0,
                blur: 0.0,
                color: String::new(),
                alpha: 0,
            },
            model_steps: 0,
            model_seed: 0,
            bg_width: 1,
            bg_height: 1,
            rembg_model: String::new(),
            subject_scale: 0.0,
            darken: 0.0,
            out: out.to_string_lossy().into_owned(),
        };
        let execution = JobExecutionContext::new();
        let task_execution = execution.clone();
        let task_script = script.clone();
        let task = tokio::spawn(async move {
            spec.render(&task_execution, "wscript.exe", &task_script).await
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cover helper must start");
        execution.cancel();

        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled cover helper must be reaped within two seconds")
            .expect("cover task must not panic")
            .expect_err("cancelled cover helper must fail");
        assert!(matches!(error, EditError::Cancelled(_)));

        let _ = std::fs::remove_file(marker);
        let _ = std::fs::remove_file(spec_path);
        let _ = std::fs::remove_file(script);
    }
}
