use std::io;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum TranscribeError {
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
