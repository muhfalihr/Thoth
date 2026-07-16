#[derive(Debug, thiserror::Error)]
pub enum NewsError {
    #[error(transparent)]
    Execution(#[from] anyhow::Error),

    #[error("LLM keyword extraction failed: {0}")]
    Llm(String),

    #[error("search backend failed: {0}")]
    Search(String),

    #[error("search script not found: {0}")]
    ScriptMissing(String),

    #[error("invalid JSON from search backend: {0}")]
    InvalidJson(String),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
