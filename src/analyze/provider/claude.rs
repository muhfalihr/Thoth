use async_trait::async_trait;
use reqwest::Client;
use serde_json::json;
use tracing::debug;

use crate::analyze::error::AnalyzeError;

use super::LlmProvider;

/// Anthropic Claude provider.
///
/// Uses the Messages API: https://docs.anthropic.com/en/api/messages
/// Env var: THOTH_CLAUDE_API_KEY
pub struct ClaudeProvider {
    client: Client,
    api_key: String,
    model: String,
}

impl ClaudeProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            model,
        }
    }
}

#[async_trait]
impl LlmProvider for ClaudeProvider {
    async fn chat_completion(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        // Claude Messages API uses a separate `system` field (not inside `messages`)
        let body = json!({
            "model": self.model,
            "system": system,
            "messages": [
                { "role": "user", "content": user }
            ],
            "temperature": 0.3,
            "max_tokens": 4096
        });

        debug!("sending request to Claude API, model={}", self.model);

        let resp = self
            .client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AnalyzeError::ApiError {
                provider: "claude".to_owned(),
                message: format!("HTTP {status}: {text}"),
            });
        }

        // Claude response format:
        // { "content": [{ "type": "text", "text": "..." }], ... }
        let json: serde_json::Value = resp.json().await?;
        let content = json["content"]
            .as_array()
            .and_then(|arr| arr.iter().find(|item| item["type"] == "text"))
            .and_then(|item| item["text"].as_str())
            .ok_or_else(|| AnalyzeError::ApiError {
                provider: "claude".to_owned(),
                message: format!(
                    "unexpected response format: {}",
                    json.to_string().chars().take(200).collect::<String>()
                ),
            })?
            .to_owned();

        Ok(content)
    }

    fn name(&self) -> &str {
        "claude"
    }

    fn model(&self) -> &str {
        &self.model
    }
}
