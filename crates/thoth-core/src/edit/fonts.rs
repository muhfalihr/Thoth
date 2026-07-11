/// Font configuration for all text rendered in video clips.
///
/// Supports custom TTF/OTF fonts for headlines, subtitles, and source credit.
/// Defaults to Poppins (Google Font, auto-downloaded on first use).
///
/// Font files are looked up in `fonts_dir`.  The `ensure_fonts()` method
/// downloads the default Poppins fonts from Google's CDN if they are missing.

use std::path::{Path, PathBuf};
use anyhow::Result;
use tracing::{info, warn};

/// Font configuration passed to all text-rendering parts of the pipeline.
#[derive(Debug, Clone)]
pub struct FontConfig {
    /// Directory that contains the font files. Default: `"assets/fonts/"`.
    pub fonts_dir:    PathBuf,
    /// Bold font filename (headline text + subtitle). Default: `"Poppins-Bold.ttf"`.
    pub bold_font:    String,
    /// Regular font filename (source credit). Default: `"Poppins-Regular.ttf"`.
    pub regular_font: String,
    /// Font family name as it appears in the ASS Style definition.
    /// Default: `"Poppins"`.
    pub family_name:  String,
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            fonts_dir:    PathBuf::from("assets/fonts"),
            bold_font:    "Poppins-Bold.ttf".to_owned(),
            regular_font: "Poppins-Regular.ttf".to_owned(),
            family_name:  "Poppins".to_owned(),
        }
    }
}

impl FontConfig {
    // ── Path helpers ──────────────────────────────────────────────────────────

    pub fn bold_path(&self) -> PathBuf {
        self.fonts_dir.join(&self.bold_font)
    }

    pub fn regular_path(&self) -> PathBuf {
        self.fonts_dir.join(&self.regular_font)
    }

    /// Whether both font files exist on disk.
    pub fn fonts_available(&self) -> bool {
        self.bold_path().exists() && self.regular_path().exists()
    }

    // ── FFmpeg filter prefixes ────────────────────────────────────────────────

    /// `fontfile='...':font='FamilyName':` prefix for a **bold** `drawtext` filter.
    /// Falls back to `font='Arial Bold':` when the font file does not exist.
    pub fn bold_ff(&self) -> String {
        let path = self.bold_path();
        if path.exists() {
            // fontfile= points to the Bold variant file — no extra fontstyle needed
            format!(
                "fontfile='{}':font='{}':",
                escape_ffmpeg_path(&path),
                self.family_name
            )
        } else {
            "font='Arial Bold':".to_owned()
        }
    }

    /// `fontfile='...':font='FamilyName':` prefix for a **regular** `drawtext` filter.
    /// Falls back to `font='Arial':` when the font file does not exist.
    pub fn regular_ff(&self) -> String {
        let path = self.regular_path();
        if path.exists() {
            // fontfile= points to the Regular variant file
            format!(
                "fontfile='{}':font='{}':",
                escape_ffmpeg_path(&path),
                self.family_name
            )
        } else {
            "font='Arial':".to_owned()
        }
    }

    /// Value for the `fontsdir=` option of the `subtitles=` filter.
    /// Returns an empty string when the directory does not exist (ASS will use
    /// system fonts and fall back to whatever matches the family name).
    pub fn fontsdir_opt(&self) -> String {
        if self.fonts_dir.exists() {
            // Escape the path for the FFmpeg subtitles filter option
            let raw = self.fonts_dir.to_string_lossy().replace('\\', "/");
            format!(":fontsdir='{}'", raw.replace('\'', "\\'"))
        } else {
            String::new()
        }
    }

    /// Font family name to write into the ASS Style definition.
    pub fn ass_family(&self) -> &str {
        &self.family_name
    }

    // ── Auto-download ─────────────────────────────────────────────────────────

    /// Ensure font files are present.  Downloads Poppins from Google Fonts CDN
    /// if the default font files are missing.  Never fails — missing fonts fall
    /// back to system Arial.
    pub async fn ensure_fonts(&self) {
        if self.fonts_available() {
            return;
        }

        // Only auto-download the built-in Poppins defaults
        let is_default_bold    = self.bold_font    == "Poppins-Bold.ttf";
        let is_default_regular = self.regular_font == "Poppins-Regular.ttf";

        if !is_default_bold && !is_default_regular {
            // User specified custom fonts — don't auto-download
            if !self.fonts_available() {
                warn!(
                    "Custom fonts not found in '{}'. Falling back to system Arial.",
                    self.fonts_dir.display()
                );
            }
            return;
        }

        // Create fonts directory
        if let Err(e) = std::fs::create_dir_all(&self.fonts_dir) {
            warn!("Cannot create fonts directory: {e}");
            return;
        }

        info!("Downloading Poppins fonts from Google Fonts CDN…");

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("thoth/1.0")
            .build()
            .unwrap_or_default();

        let fonts = [
            (
                "Poppins-Bold.ttf",
                "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf",
            ),
            (
                "Poppins-Regular.ttf",
                "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Regular.ttf",
            ),
        ];

        for (filename, url) in &fonts {
            let dest = self.fonts_dir.join(filename);
            if dest.exists() {
                continue;
            }
            match download_font(&client, url, &dest).await {
                Ok(()) => info!("Downloaded {filename}"),
                Err(e) => warn!("Failed to download {filename}: {e} — will use Arial"),
            }
        }
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Download a font file to `dest`, logging progress.
async fn download_font(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> Result<()> {
    let bytes = client.get(url).send().await?.bytes().await?;
    std::fs::write(dest, &bytes)?;
    Ok(())
}

/// Escape a font file path for safe embedding in an FFmpeg filter option string.
///
/// Rules applied:
/// - Backslash → forward slash (Windows paths)
/// - Drive-letter colon escaped: `C:` → `C\:`   (FFmpeg option separator)
/// - Single quotes escaped: `'` → `\'`
pub fn escape_ffmpeg_path(p: &Path) -> String {
    let s = p.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "\\'");

    // Escape the drive-letter colon on Windows (e.g. "C:/" → "C\:/")
    // Only the first colon (at position 1) needs escaping — subsequent colons
    // in the path are always forward slashes on Windows.
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        format!("{}\\:{}", &s[..1], &s[2..])
    } else {
        s
    }
}
