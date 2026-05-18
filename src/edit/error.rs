use std::io;

#[derive(Debug, thiserror::Error)]
pub enum EditError {
    #[error("FFmpeg process failed: {0}")]
    FfmpegFailed(String),

    #[error("subtitle generation failed: {0}")]
    SubtitleError(String),

    #[error("invalid clip bounds: start={start:.2} end={end:.2} duration={duration:.2}")]
    InvalidBounds { start: f64, end: f64, duration: f64 },

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}
