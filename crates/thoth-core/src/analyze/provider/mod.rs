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

    /// Same as [`chat_completion`] but requests STRICT JSON-OBJECT output where the provider
    /// supports it (`response_format: {"type":"json_object"}`). Use ONLY for callers that expect a
    /// top-level JSON OBJECT (analyze/narration/meme/sfx/etc.) — NOT for ones expecting a top-level
    /// array (news keyword) or prose. Default impl delegates to [`chat_completion`] so providers
    /// without JSON-mode (or that don't override) behave exactly as before.
    async fn chat_completion_json(
        &self,
        system: &str,
        user: &str,
    ) -> Result<String, AnalyzeError> {
        self.chat_completion(system, user).await
    }

    fn name(&self) -> &str;
    fn model(&self) -> &str;
}

/// Build a text LLM provider from the application config by name.
///
/// Shared factory used by both the analyze stage and the enrich (news/reaction)
/// stage so provider wiring lives in one place. Unknown names fall back to Groq.
pub fn build_llm_provider(
    config: &crate::config::AppConfig,
    name: &str,
) -> Result<Box<dyn LlmProvider>, AnalyzeError> {
    match name {
        "openai" => {
            if config.llm.openai_api_key.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "openai".to_owned(),
                    message: "THOTH_OPENAI_API_KEY is not set".to_owned(),
                });
            }
            Ok(Box::new(OpenAiProvider::new(
                config.llm.openai_api_key.clone(),
                config.llm.openai_model.clone(),
            )))
        }
        "claude" => {
            if config.llm.claude_api_key.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "claude".to_owned(),
                    message: "THOTH_CLAUDE_API_KEY is not set.\n\
                              Get your key at: https://console.anthropic.com/".to_owned(),
                });
            }
            Ok(Box::new(ClaudeProvider::new(
                config.llm.claude_api_key.clone(),
                config.llm.claude_model.clone(),
            )))
        }
        "gemini" => {
            if config.llm.gemini_api_key.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "gemini".to_owned(),
                    message: "THOTH_GEMINI_API_KEY is not set.\n\
                              Get your free key at: https://aistudio.google.com/apikey".to_owned(),
                });
            }
            Ok(Box::new(GeminiProvider::new(
                config.llm.gemini_api_key.clone(),
                config.llm.gemini_model.clone(),
            )))
        }
        "vllm" => {
            if config.llm.vllm_base_url.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "vllm".to_owned(),
                    message:  "vllm_base_url is not set in config.toml.\n\
                               Example: vllm_base_url = \"http://localhost:8000\"".to_owned(),
                });
            }
            Ok(Box::new(VllmProvider::new(
                config.llm.vllm_base_url.clone(),
                config.llm.vllm_model.clone(),
                config.llm.vllm_api_key.clone(),
            )))
        }
        "ollama" => Ok(Box::new(OllamaProvider::new(
            config.llm.ollama_base_url.clone(),
            config.llm.ollama_model.clone(),
        ))),
        "novita" => {
            if config.llm.novita_api_key.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "novita".to_owned(),
                    message: "THOTH_NOVITA_API_KEY is not set.\n\
                              Get key: https://novita.ai/settings#key-management".to_owned(),
                });
            }
            let base_url = if config.llm.novita_base_url.is_empty() {
                crate::endpoints::novita()
            } else {
                config.llm.novita_base_url.clone()
            };
            Ok(Box::new(OpenAiCompatProvider::new(
                base_url,
                config.llm.novita_api_key.clone(),
                config.llm.novita_model.clone(),
                "novita".into(),
            )))
        }
        "together" => {
            if config.llm.together_api_key.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "together".to_owned(),
                    message: "THOTH_TOGETHER_API_KEY is not set.".to_owned(),
                });
            }
            Ok(Box::new(openai_compat::together(
                config.llm.together_api_key.clone(),
                config.llm.together_model.clone(),
            )))
        }
        "fireworks" => {
            if config.llm.fireworks_api_key.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "fireworks".to_owned(),
                    message: "THOTH_FIREWORKS_API_KEY is not set.".to_owned(),
                });
            }
            Ok(Box::new(openai_compat::fireworks(
                config.llm.fireworks_api_key.clone(),
                config.llm.fireworks_model.clone(),
            )))
        }
        _ => {
            if config.llm.groq_api_key.is_empty() {
                return Err(AnalyzeError::ApiError {
                    provider: "groq".to_owned(),
                    message: "THOTH_GROQ_API_KEY is not set".to_owned(),
                });
            }
            Ok(Box::new(GroqProvider::new(
                config.llm.groq_api_key.clone(),
                config.llm.groq_model.clone(),
            )))
        }
    }
}
