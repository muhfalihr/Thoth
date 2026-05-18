use async_trait::async_trait;
use reqwest::Client;
use serde_json::json;
use tracing::debug;

use crate::analyze::error::AnalyzeError;

use super::LlmProvider;

pub struct GroqProvider {
    client: Client,
    api_key: String,
    model: String,
}

impl GroqProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            model,
        }
    }
}

#[async_trait]
impl LlmProvider for GroqProvider {
    async fn chat_completion(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        let body = json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": user }
            ],
            "temperature": 0.3,
            "max_tokens": 2048
        });

        debug!("sending request to Groq API, model={}", self.model);

        let resp = self
            .client
            .post("https://api.groq.com/openai/v1/chat/completions")
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AnalyzeError::ApiError {
                provider: "groq".to_owned(),
                message: format!("HTTP {status}: {text}"),
            });
        }

        let json: serde_json::Value = resp.json().await?;
        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AnalyzeError::ApiError {
                provider: "groq".to_owned(),
                message: "missing content in response".to_owned(),
            })?
            .to_owned();

        Ok(content)
    }

    fn name(&self) -> &str {
        "groq"
    }

    fn model(&self) -> &str {
        &self.model
    }
}
