use std::io;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("yt-dlp not found at '{path}': {source}")]
    YtDlpNotFound { path: String, source: io::Error },

    #[error("yt-dlp exited with code {code}:\n{stderr}")]
    YtDlpFailed { code: i32, stderr: String },

    /// SKILL.md §3A — HTTP 400 usually means malformed or expired cookies.
    #[error(
        "Cookie authentication failed (HTTP 400 — cookies are malformed or expired).\n\
         \n\
         To fix:\n\
         1. Re-export cookies using the 'Get cookies.txt LOCALLY' extension\n\
            (use the LOCAL-ONLY version — cloud-synced versions are malware risks).\n\
         2. Update `cookie_file` in config.toml, or\n\
         3. Set `cookie_browser = \"firefox\"` for auto-extraction.\n\
         \n\
         Original stderr: {stderr}"
    )]
    CookieExpired { stderr: String },

    #[error("downloaded file not found at expected path: {0}")]
    OutputMissing(PathBuf),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}
