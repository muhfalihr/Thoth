use std::io;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum TranscribeError {
    #[error(transparent)]
    Cancelled(#[from] crate::execution::Cancelled),

    #[error("transcription command timed out")]
    CommandTimedOut,

    #[error("whisper model not found: {0}\nRun: curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin -o models/medium.bin")]
    ModelNotFound(PathBuf),

    #[error("whisper context initialization failed: {0}")]
    InitFailed(String),

    #[error("transcription inference failed: {0}")]
    InferenceFailed(String),

    #[error("audio extraction (FFmpeg) failed: {0}")]
    AudioExtraction(String),

    #[error("WAV decode error: {0}")]
    WavDecode(String),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}

impl TranscribeError {
    pub(crate) fn from_execution(error: anyhow::Error, operation: String) -> Self {
        if crate::execution::is_cancelled(&error) {
            Self::Cancelled(crate::execution::Cancelled)
        } else if error
            .chain()
            .any(|cause| cause.downcast_ref::<crate::execution::CommandTimedOut>().is_some())
        {
            Self::CommandTimedOut
        } else {
            Self::AudioExtraction(format!("{operation}: {error:#}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TranscribeError;

    #[test]
    fn converts_execution_cancellation_to_typed_error() {
        let error = TranscribeError::from_execution(
            anyhow::Error::new(crate::execution::Cancelled),
            "extract audio".to_owned(),
        );

        assert!(matches!(error, TranscribeError::Cancelled(_)));
    }

    #[test]
    fn converts_execution_timeout_to_distinct_error() {
        let error = TranscribeError::from_execution(
            anyhow::Error::new(crate::execution::CommandTimedOut),
            "extract audio".to_owned(),
        );

        assert!(matches!(error, TranscribeError::CommandTimedOut));
    }
}
