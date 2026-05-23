use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::analyze::error::AnalyzeError;

use super::LlmProvider;

/// vLLM provider — connects to a self-hosted vLLM inference server.
///
/// vLLM exposes an OpenAI-compatible API at `/v1/chat/completions`.
/// The base URL typically looks like `http://localhost:8000` or
/// `http://your-server:8000`.
///
/// Handles both standard and **reasoning models** (e.g. gpt-oss-120b, DeepSeek-R1,
/// Qwen3-thinking) that output to `reasoning` / `reasoning_content` instead of
/// (or alongside) `content`.
///
/// Config:
///   vllm_base_url = "http://localhost:8000"   # in config.toml
///   vllm_model    = "Qwen/Qwen2.5-72B-Instruct"
///
/// No API key is required unless your vLLM server is configured with one.
/// Set CLIPPER_VLLM_API_KEY if needed; leave empty otherwise.
pub struct VllmProvider {
    client:   Client,
    base_url: String,
    model:    String,
    api_key:  String, // optional; empty = no auth header sent
}

impl VllmProvider {
    pub fn new(base_url: String, model: String, api_key: String) -> Self {
        // Normalise: remove trailing slash
        let base_url = base_url.trim_end_matches('/').to_owned();
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(300)) // long timeout for local inference
                .build()
                .unwrap_or_default(),
            base_url,
            model,
            api_key,
        }
    }
}

#[async_trait]
impl LlmProvider for VllmProvider {
    async fn chat_completion(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        let url = format!("{}/v1/chat/completions", self.base_url);

        let body = json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": user }
            ],
            "temperature": 0.3,
            // Generous token budget — reasoning models use extra tokens for
            // chain-of-thought before outputting JSON.
            "max_tokens": 16384
        });

        debug!("sending request to vLLM at {}, model={}", url, self.model);

        let mut req = self.client.post(&url).json(&body);

        // Only add Authorization header if an API key is configured
        if !self.api_key.is_empty() {
            req = req.bearer_auth(&self.api_key);
        }

        let resp = req.send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text   = resp.text().await.unwrap_or_default();
            return Err(AnalyzeError::ApiError {
                provider: "vllm".to_owned(),
                message:  format!("HTTP {status}: {text}"),
            });
        }

        let json: Value = resp.json().await?;

        // Warn if the model was cut off mid-generation
        let finish_reason = json["choices"][0]["finish_reason"].as_str().unwrap_or("");
        if finish_reason == "length" {
            warn!(
                "vLLM: model stopped due to max_tokens limit (finish_reason=length). \
                 Response may be truncated — JSON parse will be attempted anyway."
            );
        }

        let msg = &json["choices"][0]["message"];

        // Priority for extracting the usable text:
        //  1. `content`           — standard OpenAI-compatible output
        //  2. `reasoning_content` — DeepSeek-R1 / some vLLM reasoning models
        //  3. `reasoning`         — gpt-oss-* and other thinking models
        //
        // For reasoning models the JSON answer is usually embedded at the end of
        // the reasoning text, so we pass the whole thing to the JSON parser which
        // already strips leading prose and markdown fences.
        let content = msg["content"].as_str()
            .or_else(|| msg["reasoning_content"].as_str())
            .or_else(|| msg["reasoning"].as_str())
            .map(|s| s.to_owned())
            .unwrap_or_default();

        if content.is_empty() {
            return Err(AnalyzeError::ApiError {
                provider: "vllm".to_owned(),
                message:  format!(
                    "empty response (finish_reason={finish_reason}): {}",
                    json.to_string().chars().take(400).collect::<String>()
                ),
            });
        }

        Ok(content)
    }

    fn name(&self) -> &str { "vllm" }
    fn model(&self) -> &str { &self.model }
}
