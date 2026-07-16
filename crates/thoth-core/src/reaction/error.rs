#[derive(Debug, thiserror::Error)]
pub enum ReactionError {
    #[error(transparent)]
    Cancelled(#[from] crate::execution::Cancelled),

    #[error(transparent)]
    News(#[from] crate::news::error::NewsError),

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

impl ReactionError {
    pub fn from_news_error(error: crate::news::error::NewsError) -> Self {
        if let crate::news::error::NewsError::Execution(execution) = &error
            && crate::execution::is_cancelled(execution)
        {
            Self::Cancelled(crate::execution::Cancelled)
        } else {
            Self::News(error)
        }
    }
}
