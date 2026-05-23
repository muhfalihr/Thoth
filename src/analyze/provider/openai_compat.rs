/// Generic OpenAI-compatible LLM provider.
///
/// Supports any API endpoint that follows the OpenAI chat-completions format:
///   POST {base_url}/v1/chat/completions
///   Authorization: Bearer {api_key}
///
/// Built-in aliases (pre-configured base URLs):
///   novita   → https://api.novita.ai/v3/openai
///   together → https://api.together.xyz
///   fireworks→ https://api.fireworks.ai/inference
///   anyscale → https://api.endpoints.anyscale.com/v1
///
/// Can also be used directly with any custom base URL.

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::analyze::error::AnalyzeError;

use super::LlmProvider;

pub struct OpenAiCompatProvider {
    client:       Client,
    base_url:     String,   // e.g. "https://api.novita.ai/v3/openai"
    api_key:      String,
    model:        String,
    provider_tag: String,   // for logs: "novita", "together", etc.
}

impl OpenAiCompatProvider {
    pub fn new(
        base_url:     String,
        api_key:      String,
        model:        String,
        provider_tag: String,
    ) -> Self {
        let base_url = base_url.trim_end_matches('/').to_owned();
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            base_url,
            api_key,
            model,
            provider_tag,
        }
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatProvider {
    async fn chat_completion(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        let url  = format!("{}/v1/chat/completions", self.base_url);
        let body = json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": user }
            ],
            "temperature": 0.3,
            "max_tokens": 4096
        });

        debug!("{}: POST {} model={}", self.provider_tag, url, self.model);

        let resp = self.client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AnalyzeError::ApiError {
                provider: self.provider_tag.clone(),
                message:  format!("request failed: {e}"),
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text   = resp.text().await.unwrap_or_default();
            return Err(AnalyzeError::ApiError {
                provider: self.provider_tag.clone(),
                message:  format!("HTTP {status}: {text}"),
            });
        }

        let json: Value = resp.json().await.map_err(|e| AnalyzeError::ApiError {
            provider: self.provider_tag.clone(),
            message:  format!("JSON parse: {e}"),
        })?;

        // Handle both standard content and reasoning models (same pattern as vllm.rs)
        let msg = &json["choices"][0]["message"];
        let content = msg["content"].as_str()
            .or_else(|| msg["reasoning_content"].as_str())
            .or_else(|| msg["reasoning"].as_str())
            .ok_or_else(|| AnalyzeError::ApiError {
                provider: self.provider_tag.clone(),
                message:  format!(
                    "missing content in response: {}",
                    json.to_string().chars().take(300).collect::<String>()
                ),
            })?
            .to_owned();

        Ok(content)
    }

    fn name(&self)  -> &str { &self.provider_tag }
    fn model(&self) -> &str { &self.model }
}

// ── Pre-configured aliases ────────────────────────────────────────────────────

/// Novita AI — OpenAI-compatible, fast & cheap inference.
/// Models: meta-llama/llama-3.3-70b-instruct, deepseek/deepseek-r1-turbo, etc.
/// Get key: https://novita.ai/settings#key-management
pub fn novita(api_key: String, model: String) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(
        "https://api.novita.ai/openai".into(),
        api_key, model, "novita".into(),
    )
}

/// Together AI — wide model selection.
pub fn together(api_key: String, model: String) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(
        "https://api.together.xyz".into(),
        api_key, model, "together".into(),
    )
}

/// Fireworks AI — fast open-source model serving.
pub fn fireworks(api_key: String, model: String) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(
        "https://api.fireworks.ai/inference".into(),
        api_key, model, "fireworks".into(),
    )
}
