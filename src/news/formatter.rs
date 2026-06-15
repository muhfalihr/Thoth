//! Format a raw news screenshot (landscape) to 9:16 (1080×1920) portrait
//! with a blurred pillar-box background and an optional source/date caption.
//!
//! Uses the project's local `ffmpeg` binary (resolved via `FFMPEG_PATH` env var
//! → `ffmpeg_sidecar::paths::ffmpeg_path()` fallback), so no extra dependencies.
//!
//! # Visual layout
//!
//! ```text
//! ┌─────────────────────────────┐  1080 × 1920
//! │                             │
//! │   [BLURRED BACKGROUND]      │  screenshot stretched + blurred to fill
//! │                             │
//! │  ┌───────────────────────┐  │
//! │  │                       │  │  original screenshot scaled to fit width
//! │  │   [SCREENSHOT]        │  │  centered vertically (top-third position)
//! │  │                       │  │
//! │  └───────────────────────┘  │
//! │                             │
//! │  📰 SOURCE  •  DATE         │  source + date caption (bottom area)
//! │  Headline title...          │
//! └─────────────────────────────┘
//! ```

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tracing::debug;

use super::error::NewsError;

const OUT_W: u32 = 1080;
const OUT_H: u32 = 1920;

/// Parameters for formatting a screenshot.
pub struct FormatParams<'a> {
    /// Raw screenshot input path (PNG/JPEG).
    pub raw_path: &'a Path,
    /// Where to write the formatted PNG.
    pub out_path: &'a Path,
    /// News source name shown in caption (e.g. "CNN Indonesia").
    pub source: &'a str,
    /// Publication date string shown in caption (free-form).
    pub published: Option<&'a str>,
    /// Article headline shown below source/date in caption.
    pub headline: &'a str,
}

/// Format `raw_path` to 1080×1920 pillar-box with blur bg + source caption.
///
/// Returns the `out_path` on success, `Err` only on hard FFmpeg failure.
/// A missing fonts directory is handled gracefully — caption text uses a built-in
/// fallback font so the function never errors on missing Poppins.
pub async fn format_screenshot(params: &FormatParams<'_>) -> Result<PathBuf, NewsError> {
    let ffmpeg = ffmpeg_binary();

    // Ensure output parent dir exists.
    if let Some(parent) = params.out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let filter = build_filter(params.source, params.published, params.headline);
    debug!("formatter filter_complex: {}", filter);

    let output = tokio::process::Command::new(&ffmpeg)
        .args([
            "-y",                              // overwrite
            "-i", &params.raw_path.to_string_lossy(),
            "-filter_complex", &filter,
            "-map", "[out]",
            "-frames:v", "1",
            "-update", "1",                    // suppress "image sequence pattern" warning
            "-q:v", "2",                       // PNG quality (lower = better)
            &params.out_path.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| NewsError::Search(format!("ffmpeg spawn failed: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(NewsError::Search(format!(
            "ffmpeg formatter failed ({}): {}",
            output.status,
            stderr.chars().take(400).collect::<String>()
        )));
    }

    Ok(params.out_path.to_path_buf())
}

/// Build the FFmpeg `filter_complex` string for 9:16 formatting.
///
/// Layout:
/// ```text
/// ┌──────────────────────────┐  1080 × 1920
/// │  [ARTIKEL SCREENSHOT]    │  ← y=0, max 1500px tinggi (crop sisa)
/// │  (skala ke 1080px lebar) │
/// │  ...                     │
/// ├──────────────────────────┤  y=1520 — blur background mengisi sisa
/// │  [BLUR BG]               │
/// │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← gradient gelap semi-transparan
/// │  📰 SOURCE  •  DATE      │  y=1600
/// │  Judul artikel...        │  y=1680
/// └──────────────────────────┘
/// ```
fn build_filter(source: &str, published: Option<&str>, headline: &str) -> String {
    let date_str = published.unwrap_or("").trim().to_owned();
    let source_line = if date_str.is_empty() {
        escape_text(source)
    } else {
        format!("{}  •  {}", escape_text(source), escape_text(&date_str))
    };
    let hl_escaped = escape_text(&truncate_text(headline, 56));

    // Caption area starts at y=1500 with semi-transparent dark box overlay.
    let caption_y:  u32 = 1500;
    let src_y:      u32 = 1600;
    let hl_y:       u32 = 1680;

    // Max visible height of the article screenshot: crop to caption_y so
    // the caption bar always sits cleanly on top of the blurred background.
    let max_art_h = caption_y;

    format!(
        // 1. Blurred background — scale screenshot to fill 1080×1920, heavy blur
        "[0]scale={w}:{h}:force_original_aspect_ratio=increase,\
         crop={w}:{h},\
         boxblur=50:3[bg];\
         \
         [0]scale={w}:-2,crop={w}:{mh}:0:0[ss];\
         \
         [bg][ss]overlay=0:0[withss];\
         \
         [withss]\
         drawbox=x=0:y={cy}:w={w}:h={bh}:color=black@0.72:t=fill,\
         drawtext=text='{srcline}':fontcolor=white:fontsize=40:\
           x=40:y={sy}:\
           shadowx=2:shadowy=2:shadowcolor=black,\
         drawtext=text='{hlline}':fontcolor=white:fontsize=34:\
           x=40:y={hy}:\
           shadowx=2:shadowy=2:shadowcolor=black\
         [out]",
        w       = OUT_W,
        h       = OUT_H,
        mh      = max_art_h,
        cy      = caption_y,
        bh      = OUT_H - caption_y,
        srcline = source_line,
        hlline  = hl_escaped,
        sy      = src_y,
        hy      = hl_y,
    )
}

/// Escape text for FFmpeg `drawtext`: colons, backslashes, single-quotes, brackets.
fn escape_text(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ':' => r"\:".to_owned(),
            '\\' => r"\\".to_owned(),
            '\'' => r"\'".to_owned(),
            '[' => r"\[".to_owned(),
            ']' => r"\]".to_owned(),
            ',' => r"\,".to_owned(),
            ';' => r"\;".to_owned(),
            '\n' | '\r' => ' '.to_string(),
            other => other.to_string(),
        })
        .collect()
}

/// Truncate at the nearest word boundary ≤ max_chars, appending "..." if cut.
fn truncate_text(s: &str, max_chars: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max_chars {
        return s.to_owned();
    }
    let cut: String = s.chars().take(max_chars - 3).collect();
    let cut = cut.trim_end().rsplit_once(' ').map(|(a, _)| a).unwrap_or(&cut);
    format!("{cut}...")
}

fn ffmpeg_binary() -> PathBuf {
    if let Ok(p) = std::env::var("FFMPEG_PATH") {
        return PathBuf::from(p);
    }
    ffmpeg_sidecar::paths::ffmpeg_path()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_colon_and_apostrophe() {
        let out = escape_text("CNN Indonesia: \"It's true\"");
        assert!(out.contains(r"\:"), "colon should be escaped");
        assert!(out.contains(r"\'"), "apostrophe should be escaped");
        assert!(!out.contains(":\\"), "raw colon should not appear after backslash");
    }

    #[test]
    fn truncate_at_word_boundary() {
        let t = truncate_text("Prabowo Bilang Orang Desa Tidak Pakai Dollar", 30);
        assert!(t.ends_with("..."), "should end with ellipsis: {t}");
        assert!(t.len() < 34, "should be shorter than max: {t}");
    }

    #[test]
    fn truncate_short_string_unchanged() {
        let t = truncate_text("short", 60);
        assert_eq!(t, "short");
    }

    #[test]
    fn build_filter_includes_source_and_headline() {
        let f = build_filter("CNN Indonesia", Some("2 jam lalu"), "Prabowo Bicara Soal Dollar");
        assert!(f.contains("CNN Indonesia"), "source must appear in filter");
        assert!(f.contains("2 jam lalu"),    "date must appear in filter");
        assert!(f.contains("Prabowo"),        "headline must appear in filter");
        assert!(f.contains("[out]"),          "filter must map [out]");
    }
}
