#[derive(Debug, thiserror::Error)]
pub enum AnalyzeError {
    #[error("{provider} API error: {message}")]
    ApiError { provider: String, message: String },

    #[error("LLM returned invalid JSON after {retries} attempt(s): {source}")]
    InvalidJson {
        retries: u32,
        source: serde_json::Error,
    },

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("no viral moments identified by the model")]
    NoMomentsFound,

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
