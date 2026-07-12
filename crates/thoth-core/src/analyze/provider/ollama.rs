use async_trait::async_trait;
use reqwest::Client;
use serde_json::json;
use tracing::debug;

use crate::analyze::error::AnalyzeError;

use super::LlmProvider;

pub struct OllamaProvider {
    client: Client,
    base_url: String,
    model: String,
}

impl OllamaProvider {
    pub fn new(base_url: String, model: String) -> Self {
        Self {
            client: Client::new(),
            base_url,
            model,
        }
    }
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    async fn chat_completion(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        let body = json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": user }
            ],
            "temperature": 0.3,
            "stream": false,
            "format": "json" // Ollama supports forcing JSON output
        });

        debug!("sending request to Ollama API ({}), model={}", self.base_url, self.model);

        let url = format!("{}/v1/chat/completions", self.base_url.trim_end_matches('/'));
        
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AnalyzeError::ApiError {
                provider: "ollama".to_owned(),
                message: format!("HTTP {status}: {text}"),
            });
        }

        let json: serde_json::Value = resp.json().await?;
        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AnalyzeError::ApiError {
                provider: "ollama".to_owned(),
                message: "missing content in response".to_owned(),
            })?
            .to_owned();

        Ok(content)
    }

    fn name(&self) -> &str {
        "ollama"
    }

    fn model(&self) -> &str {
        &self.model
    }
}
