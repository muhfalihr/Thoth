//! Clean yt-dlp argument builder — implements the VidBee resilient downloader
//! patterns from SKILL.md.
//!
//! ## Patterns implemented
//!
//! - **§1A — Aggressive retry & timeout**: `--retries`, `--fragment-retries`,
//!   `--retry-sleep`, `--socket-timeout`
//! - **§1B — YouTube client fallbacks**: `--extractor-args youtube:player_client=default,-web`
//! - **§2A — Filename safety**: `--windows-filenames` (Windows only), `--trim-filenames 120`
//! - **§3A — Cookie management**: `--cookies-from-browser` / `--cookies <file>`,
//!   Windows Chromium locked-DB workaround, HTTP 400 detection hint
//! - **§5  — Resource cleanup**: supervised children terminate their process trees on cancellation

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tracing::{debug, warn};

use crate::execution::{JobExecutionContext, SupervisedChild};

// ── Cookie source ─────────────────────────────────────────────────────────────

/// Where yt-dlp should source authentication cookies from.
///
/// ## Security notes (SKILL.md §3A)
///
/// - Cookie files are high-sensitivity secrets — never log the full path.
/// - For browser extraction, prefer **Firefox** on Windows: Chromium-based browsers
///   (Chrome, Edge, Brave) encrypt cookies with the OS keyring. yt-dlp can decrypt
///   them, but the SQLite DB may be locked while the browser is running — use
///   `temp_copy_chromium_cookies()` as a workaround before passing the file path.
/// - Only use local-only export extensions (e.g. "Get cookies.txt LOCALLY").
///   Cloud-synced versions have been reported as malware vectors.
#[derive(Debug, Clone)]
pub enum CookieSource {
    /// Extract cookies live from an installed browser profile.
    /// Supported values: `"firefox"`, `"chrome"`, `"chromium"`, `"brave"`, `"edge"`,
    /// `"opera"`, `"vivaldi"`, `"safari"` (macOS only).
    Browser(String),
    /// Path to a Netscape/Mozilla format cookie file (e.g. exported with
    /// "Get cookies.txt LOCALLY" extension, or a `cookies.txt` from yt-dlp itself).
    File(PathBuf),
}

impl CookieSource {
    /// Parse from config string:
    /// - `"firefox"` / `"chrome"` / … → `Browser`
    /// - A path ending in `.txt` / `.sqlite` / containing `/` or `\` → `File`
    pub fn from_config(s: &str) -> Option<Self> {
        let s = s.trim();
        if s.is_empty() { return None; }
        if s.contains('/') || s.contains('\\') || s.ends_with(".txt") || s.ends_with(".sqlite") {
            Some(CookieSource::File(PathBuf::from(s)))
        } else {
            Some(CookieSource::Browser(s.to_lowercase()))
        }
    }
}

// ── YtDlpArgs builder ─────────────────────────────────────────────────────────

/// Builder for yt-dlp argument lists.
///
/// Each method appends the corresponding flags and returns `self` for chaining.
/// Call `build()` to get the final `Vec<String>` or `spawn()` to launch the
/// process supervised by the current job execution context.
///
/// # Example
///
/// ```no_run
/// let guard = YtDlpArgs::new("yt-dlp")
///     .output("/tmp/%(id)s.%(ext)s")
///     .format("bestvideo+bestaudio/best")
///     .resilience(30, 30, 2, 30)
///     .windows_safe()
///     .youtube_client_fallback(url)
///     .ffmpeg_dir("/usr/bin")
///     .url(url)
///     .spawn_with_streams(execution)?;
/// ```
pub struct YtDlpArgs {
    /// Path to the yt-dlp binary.
    pub bin: String,
    args: Vec<String>,
    /// Tracks whether a cookie temp-file was created so we can delete it after.
    pub temp_cookie_path: Option<PathBuf>,
}

impl YtDlpArgs {
    pub fn new(bin: impl Into<String>) -> Self {
        Self { bin: bin.into(), args: Vec::new(), temp_cookie_path: None }
    }

    /// Target URL (always the last argument — call after all option methods).
    pub fn url(mut self, url: impl Into<String>) -> Self {
        self.args.push(url.into());
        self
    }

    /// yt-dlp `--output` template.
    pub fn output(mut self, template: impl Into<String>) -> Self {
        self.push2("--output", template.into());
        self
    }

    /// `-f` / `--format` selector.
    pub fn format(mut self, fmt: impl Into<String>) -> Self {
        self.push2("--format", fmt.into());
        self
    }

    /// Force output container to `mp4`.
    pub fn merge_mp4(mut self) -> Self {
        self.push2("--merge-output-format", "mp4");
        self
    }

    /// Download only the first N items (for search results / playlists).
    pub fn max_downloads(mut self, n: u32) -> Self {
        self.push2("--max-downloads", n.to_string());
        self
    }

    /// Skip anything longer than `max_secs` seconds.
    pub fn max_duration(mut self, max_secs: u64) -> Self {
        self.push2("--match-filter", format!("duration <= {max_secs}"));
        self
    }

    /// Download only the first `secs` seconds of the video (FFmpeg-backed).
    ///
    /// Unlike [`max_duration`] this does NOT reject long videos — it grabs just the
    /// opening slice. Ideal for pulling a short cutaway out of a full-length clip
    /// (e.g. an enrichment video) quickly without downloading the whole thing.
    pub fn download_first_secs(mut self, secs: u64) -> Self {
        self.push2("--download-sections", format!("*0-{secs}"));
        // `--download-sections` needs a real (non-streaming) downloader.
        self.push2("--downloader", "ffmpeg");
        self
    }

    /// Suppress all output (for background / overlay downloads).
    pub fn quiet(mut self) -> Self {
        self.args.push("--quiet".to_owned());
        self
    }

    /// Write progress lines as individual stdout lines (needed for real-time parsing).
    pub fn newline_progress(mut self) -> Self {
        self.args.push("--newline".to_owned());
        self
    }

    /// Write `%(id)s.info.json` alongside the downloaded file.
    pub fn write_info_json(mut self) -> Self {
        self.args.push("--write-info-json".to_owned());
        self
    }

    /// Reject playlists — download only the single URL provided.
    pub fn no_playlist(mut self) -> Self {
        self.args.push("--no-playlist".to_owned());
        self
    }

    /// Prefer the deno JS runtime for full YouTube/TikTok support.
    pub fn js_runtimes(mut self) -> Self {
        self.push2("--js-runtimes", "deno");
        self
    }

    /// Pause `secs` seconds between requests to reduce 429 pressure.
    pub fn sleep_requests(mut self, secs: u32) -> Self {
        self.push2("--sleep-requests", secs.to_string());
        self
    }

    /// Continue after non-fatal errors (e.g. subtitle 429).
    pub fn ignore_errors(mut self) -> Self {
        self.args.push("--ignore-errors".to_owned());
        self
    }

    pub fn no_warnings(mut self) -> Self {
        self.args.push("--no-warnings".to_owned());
        self
    }

    /// SKILL.md §1A — Aggressive retry & timeout strategy.
    ///
    /// - `retries`: total HTTP request retries (VidBee default: 30)
    /// - `frag_retries`: per-fragment retries for HLS/DASH streams (VidBee default: 30)
    /// - `retry_sleep`: seconds between retries to avoid instant failure on transient errors
    /// - `socket_timeout`: seconds before a stalled DNS/connection is abandoned
    pub fn resilience(mut self, retries: u32, frag_retries: u32, retry_sleep: u32, socket_timeout: u32) -> Self {
        self.push2("--retries",          retries.to_string());
        self.push2("--fragment-retries", frag_retries.to_string());
        self.push2("--retry-sleep",      retry_sleep.to_string());
        self.push2("--socket-timeout",   socket_timeout.to_string());
        self
    }

    /// SKILL.md §1B — YouTube player-client fallback.
    ///
    /// Drops the bare `web` client (frequent 403 / PO-token issues) while retaining
    /// `web_safari`, `android`, `ios`, etc. — has no effect on non-YouTube URLs.
    pub fn youtube_client_fallback(mut self, url: &str) -> Self {
        if is_youtube_url(url) {
            self.push2("--extractor-args", "youtube:player_client=default,-web");
        }
        self
    }

    /// SKILL.md §2A — Cross-platform filename safety.
    ///
    /// - `--windows-filenames`: strip/replace reserved characters on Windows
    /// - `--trim-filenames 120`: prevent MAX_PATH errors (Windows 260-char limit)
    pub fn windows_safe(mut self) -> Self {
        if cfg!(windows) {
            self.args.push("--windows-filenames".to_owned());
        }
        self.push2("--trim-filenames", "120");
        self
    }

    /// SKILL.md §3A — Cookie authentication.
    ///
    /// - `Browser(name)` → `--cookies-from-browser <name>`
    ///   On Windows, attempts to copy a locked Chromium SQLite DB to a temp file first
    ///   (avoids "database is locked" errors when the browser is running).
    /// - `File(path)`    → `--cookies <path>`
    ///
    /// The temp file path is stored in `self.temp_cookie_path` so the caller can
    /// delete it after the download completes.
    pub async fn with_cookie(mut self, source: &CookieSource) -> Self {
        match source {
            CookieSource::Browser(browser) => {
                // Windows + Chromium: DB may be locked → copy first
                if cfg!(windows) && is_chromium_browser(browser) {
                    if let Some(tmp) = temp_copy_chromium_cookies(browser).await {
                        debug!("cookie: using temp DB copy for locked Chromium profile");
                        self.push2("--cookies", tmp.to_string_lossy().to_string());
                        self.temp_cookie_path = Some(tmp);
                        return self;
                    }
                }
                // Standard browser extraction (works natively on macOS/Linux and Firefox/Windows)
                self.push2("--cookies-from-browser", browser.clone());
            }
            CookieSource::File(path) => {
                self.push2("--cookies", path.to_string_lossy().to_string());
            }
        }
        self
    }

    /// Specify where the local FFmpeg binary lives.
    pub fn ffmpeg_dir(mut self, dir: &str) -> Self {
        if !dir.is_empty() {
            self.push2("--ffmpeg-location", dir);
        }
        self
    }

    /// Append arbitrary extra flags (escape hatch for one-off options).
    pub fn extra(mut self, args: &[&str]) -> Self {
        self.args.extend(args.iter().map(|s| s.to_string()));
        self
    }

    // ── Subtitle helpers ──────────────────────────────────────────────────────

    /// Download auto-generated + manual subtitles alongside the video.
    pub fn with_subtitles(mut self, langs: &str) -> Self {
        self.args.extend([
            "--write-auto-subs".to_owned(),
            "--write-subs".to_owned(),
        ]);
        self.push2("--sub-format", "json3/vtt/best");
        self.push2("--sub-langs",  langs);
        self
    }

    // ── Terminal ──────────────────────────────────────────────────────────────

    /// Consume the builder and return `(binary_path, arg_list)`.
    pub fn build(self) -> (String, Vec<String>) {
        (self.bin, self.args)
    }

    /// Spawn yt-dlp under the job supervisor, retaining piped streams for parsing.
    ///
    /// stdout and stderr are piped so the caller can stream output.
    pub fn spawn_with_streams(
        self,
        execution: &JobExecutionContext,
    ) -> anyhow::Result<SupervisedChild> {
        let (bin, args) = self.build();
        debug!("yt-dlp spawn: {:?} {:?}", bin, args);
        let mut command = tokio::process::Command::new(&bin);
        command
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        execution.spawn(&mut command)
    }

    /// Spawn yt-dlp under the job supervisor with output discarded.
    pub fn spawn_silent(self, execution: &JobExecutionContext) -> anyhow::Result<SupervisedChild> {
        let (bin, args) = self.build();
        debug!("yt-dlp spawn silent: {:?} {:?}", bin, args);
        let mut command = tokio::process::Command::new(&bin);
        command
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        execution.spawn(&mut command)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn push2(&mut self, flag: &str, value: impl Into<String>) {
        self.args.push(flag.to_owned());
        self.args.push(value.into());
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Returns `true` if `url` is a YouTube URL (handles youtu.be short links too).
pub fn is_youtube_url(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("youtube.com") || u.contains("youtu.be")
}

fn is_chromium_browser(browser: &str) -> bool {
    matches!(
        browser.to_lowercase().as_str(),
        "chrome" | "chromium" | "edge" | "brave" | "vivaldi" | "opera"
    )
}

/// SKILL.md §3A — Windows Chromium locked-DB workaround.
///
/// When a Chromium-based browser is running, its SQLite cookie DB is write-locked.
/// yt-dlp cannot open it directly.  Copying the file to a temp location bypasses
/// the lock (the copy is made at OS level and is not subject to the lock held on
/// the original file).
///
/// Returns the path to the temp copy, or `None` if the DB cannot be located/copied.
/// The caller is responsible for deleting the temp file after the download.
async fn temp_copy_chromium_cookies(browser: &str) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        let _ = browser;
        return None;
    }

    #[cfg(windows)]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        let local = Path::new(&local);

        let db_candidates: &[&str] = match browser.to_lowercase().as_str() {
            "chrome"    => &[
                "Google/Chrome/User Data/Default/Network/Cookies",
                "Google/Chrome/User Data/Default/Cookies",
            ],
            "edge"      => &[
                "Microsoft/Edge/User Data/Default/Network/Cookies",
                "Microsoft/Edge/User Data/Default/Cookies",
            ],
            "brave"     => &[
                "BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies",
                "BraveSoftware/Brave-Browser/User Data/Default/Cookies",
            ],
            "vivaldi"   => &["Vivaldi/User Data/Default/Cookies"],
            "chromium"  => &["Chromium/User Data/Default/Cookies"],
            _           => return None,
        };

        for rel in db_candidates {
            let src = local.join(rel);
            if src.exists() {
                let tmp = std::env::temp_dir()
                    .join(format!("thoth_cookies_{browser}_{}.db", std::process::id()));
                if tokio::fs::copy(&src, &tmp).await.is_ok() {
                    return Some(tmp);
                }
            }
        }
        None
    }
}

/// Check stderr output for cookie-related HTTP 400 errors.
///
/// SKILL.md §3A: "If yt-dlp returns HTTP Error 400 (Bad Request), it often indicates
/// a malformed or expired cookie file."
pub fn is_cookie_error(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    (s.contains("http error 400") || s.contains("error 400")
        || s.contains("bad request"))
        && (s.contains("cookie") || s.contains("login") || s.contains("sign in"))
}

/// Clean up a temporary cookie file if one was created.
///
/// SKILL.md §3A: "Treat cookie files as high-sensitivity secrets.
/// Implement auto-delete logic for temporary cookie files after a job completes."
pub async fn cleanup_temp_cookie(path: &Path) {
    if let Err(e) = tokio::fs::remove_file(path).await {
        warn!("cookie: failed to delete temp cookie file ({}): {e}", path.display());
    } else {
        debug!("cookie: deleted temp cookie file");
    }
}
