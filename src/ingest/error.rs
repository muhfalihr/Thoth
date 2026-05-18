use std::io;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("yt-dlp not found at '{path}': {source}")]
    YtDlpNotFound { path: String, source: io::Error },

    #[error("yt-dlp exited with code {code}:\n{stderr}")]
    YtDlpFailed { code: i32, stderr: String },

    #[error("downloaded file not found at expected path: {0}")]
    OutputMissing(PathBuf),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}
