use async_trait::async_trait;
use reqwest::Client;
use serde_json::json;
use tracing::debug;

use crate::analyze::error::AnalyzeError;

use super::LlmProvider;

/// Google Gemini provider.
///
/// Uses the Generative Language API (v1beta):
/// https://ai.google.dev/api/generate-content
///
/// Auth: API key as `?key=` query param — no Bearer header needed.
/// Get a free key: https://aistudio.google.com/apikey
///
/// Env var: THOTH_GEMINI_API_KEY
pub struct GeminiProvider {
    client: Client,
    api_key: String,
    model: String,
}

impl GeminiProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            model,
        }
    }
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    async fn chat_completion(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        // Gemini uses system_instruction (separate from contents) for the system prompt
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.model, self.api_key
        );

        let body = json!({
            "system_instruction": {
                "parts": [{ "text": system }]
            },
            "contents": [{
                "role": "user",
                "parts": [{ "text": user }]
            }],
            "generationConfig": {
                "temperature": 0.3,
                "maxOutputTokens": 4096
            }
        });

        debug!("sending request to Gemini API, model={}", self.model);

        let resp = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AnalyzeError::ApiError {
                provider: "gemini".to_owned(),
                message: format!("HTTP {status}: {text}"),
            });
        }

        // Gemini response format:
        // { "candidates": [{ "content": { "parts": [{ "text": "..." }] } }] }
        let json: serde_json::Value = resp.json().await?;
        let content = json["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or_else(|| AnalyzeError::ApiError {
                provider: "gemini".to_owned(),
                message: format!(
                    "unexpected response format: {}",
                    json.to_string().chars().take(300).collect::<String>()
                ),
            })?
            .to_owned();

        Ok(content)
    }

    fn name(&self) -> &str {
        "gemini"
    }

    fn model(&self) -> &str {
        &self.model
    }
}
