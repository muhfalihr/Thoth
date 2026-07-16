//! High-fidelity hook-title renderer via Pillow (`scripts/render/render_headline.py`).
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

use serde::Serialize;
use tokio::process::Command;

use super::error::EditError;
use crate::execution::JobExecutionContext;

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
    /// `scripts/render/render_headline.py`.
    pub async fn render(
        &self,
        execution: &JobExecutionContext,
        python_cmd: &str,
        script: &Path,
    ) -> Result<PathBuf, EditError> {
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

        let mut command = Command::new(python_cmd);
        command.arg(script).arg(&spec_path);
        let output = execution.output(&mut command).await.map_err(|error| {
            EditError::from_execution(error, format!("failed to spawn '{python_cmd}'"))
        })?;

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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::execution::JobExecutionContext;

    fn spec(out: PathBuf) -> HeadlinePngSpec {
        HeadlinePngSpec {
            text: String::new(),
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
            shadow: HeadlineShadow {
                dx: 0,
                dy: 0,
                blur: 0.0,
                color: String::new(),
                alpha: 0,
            },
            out: out.to_string_lossy().into_owned(),
        }
    }

    #[cfg(windows)]
    fn write_blocking_script(path: &Path) {
        std::fs::write(
            path,
            "Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n\
             Set marker = fso.CreateTextFile(WScript.Arguments(0) & \".started\", True)\r\n\
             marker.Close\r\n\
             WScript.Sleep 30000\r\n",
        )
        .expect("write headline helper script");
    }

    #[cfg(windows)]
    fn renderer_command() -> &'static str {
        "wscript.exe"
    }

    #[cfg(unix)]
    fn write_blocking_script(path: &Path) {
        std::fs::write(path, "printf started > \"$1.started\"\nsleep 30\n")
            .expect("write headline helper script");
    }

    #[cfg(unix)]
    fn renderer_command() -> &'static str {
        "sh"
    }

    #[tokio::test]
    async fn headline_renderer_honors_cancellation() {
        let base = std::env::temp_dir().join(format!(
            "thoth-headline-cancellation-{}",
            uuid::Uuid::new_v4()
        ));
        #[cfg(windows)]
        let script = base.with_extension("vbs");
        #[cfg(unix)]
        let script = base.with_extension("sh");
        let out = base.with_extension("png");
        let spec_path = out.with_extension("spec.json");
        let marker = PathBuf::from(format!("{}.started", spec_path.display()));
        write_blocking_script(&script);

        let execution = JobExecutionContext::new();
        let task_execution = execution.clone();
        let task_script = script.clone();
        let task_spec = spec(out.clone());
        let task = tokio::spawn(async move {
            task_spec
                .render(&task_execution, renderer_command(), &task_script)
                .await
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("headline helper must start");
        execution.cancel();

        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled headline helper must be reaped within two seconds")
            .expect("headline task must not panic")
            .expect_err("cancelled headline helper must fail");
        assert!(matches!(error, EditError::Cancelled(_)));

        let _ = std::fs::remove_file(marker);
        let _ = std::fs::remove_file(spec_path);
        let _ = std::fs::remove_file(script);
        let _ = std::fs::remove_file(out);
    }
}
