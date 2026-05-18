use async_trait::async_trait;

use super::error::AnalyzeError;

pub mod groq;
pub mod openai;
pub mod ollama;

pub use groq::GroqProvider;
pub use openai::OpenAiProvider;
pub use ollama::OllamaProvider;

#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat_completion(
        &self,
        system: &str,
        user: &str,
    ) -> Result<String, AnalyzeError>;

    fn name(&self) -> &str;
    fn model(&self) -> &str;
}
