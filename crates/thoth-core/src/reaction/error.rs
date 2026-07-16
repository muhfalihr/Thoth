#[derive(Debug, thiserror::Error)]
pub enum ReactionError {
    #[error(transparent)]
    Execution(#[from] anyhow::Error),

    #[error("LLM script generation failed: {0}")]
    Llm(String),

    #[error("invalid JSON from LLM: {0}")]
    InvalidJson(String),

    #[error("TTS synthesis failed: {0}")]
    Tts(String),

    #[error("TTS script not found: {0}")]
    ScriptMissing(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
