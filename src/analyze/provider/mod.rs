use async_trait::async_trait;

use super::error::AnalyzeError;

pub mod claude;
pub mod gemini;
pub mod groq;
pub mod openai;
pub mod openai_compat;
pub mod ollama;
pub mod vllm;

pub use claude::ClaudeProvider;
pub use gemini::GeminiProvider;
pub use groq::GroqProvider;
pub use openai::OpenAiProvider;
pub use openai_compat::OpenAiCompatProvider;
pub use ollama::OllamaProvider;
pub use vllm::VllmProvider;

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
