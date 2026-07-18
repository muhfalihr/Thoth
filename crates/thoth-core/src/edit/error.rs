use std::io;

#[derive(Debug, thiserror::Error)]
pub enum EditError {
    #[error(transparent)]
    Cancelled(#[from] crate::execution::Cancelled),

    #[error(transparent)]
    TimedOut(#[from] crate::execution::CommandTimedOut),

    #[error("FFmpeg process failed: {0}")]
    FfmpegFailed(String),

    #[error("subtitle generation failed: {0}")]
    SubtitleError(String),

    #[error("invalid clip bounds: start={start:.2} end={end:.2} duration={duration:.2}")]
    InvalidBounds { start: f64, end: f64, duration: f64 },

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}

impl EditError {
    pub(crate) fn from_execution(error: anyhow::Error, operation: String) -> Self {
        if crate::execution::is_cancelled(&error) {
            Self::Cancelled(crate::execution::Cancelled)
        } else if error.is::<crate::execution::CommandTimedOut>() {
            Self::TimedOut(crate::execution::CommandTimedOut)
        } else {
            Self::SubtitleError(format!("{operation}: {error:#}"))
        }
    }
}
