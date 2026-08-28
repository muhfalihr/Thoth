/// Generic OpenAI-compatible LLM provider.
///
/// Supports any API endpoint that follows the OpenAI chat-completions format:
///   POST {base_url}/v1/chat/completions
///   Authorization: Bearer {api_key}
///
/// Built-in aliases (novita / together / fireworks) take their base URL from
/// [`crate::endpoints`] — the only place a provider host is written, and overridable per
/// `THOTH_*_BASE_URL`.
///
/// Can also be used directly with any custom base URL.

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::analyze::error::AnalyzeError;
use crate::endpoints;

use super::LlmProvider;

pub struct OpenAiCompatProvider {
    client:       Client,
    base_url:     String,   // provider root, from `crate::endpoints` or config
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
                // Novita sits behind Cloudflare, which drops idle keep-alive sockets.
                // Analyze fires an LLM call, then trend-fetches for ~2 min, then calls
                // again — reusing a dead pooled socket => "error sending request".
                // Don't keep idle connections; open a fresh one per request (like curl).
                .pool_max_idle_per_host(0)
                // reqwest's HTTP/2 path to Cloudflare fails with SendRequest; curl over
                // HTTP/1.1 always works. Pin HTTP/1.1 for parity.
                .http1_only()
                .build()
                .unwrap_or_default(),
            base_url,
            api_key,
            model,
            provider_tag,
        }
    }
}

impl OpenAiCompatProvider {
    /// Shared request path. `json_mode` adds `response_format: {"type":"json_object"}` (OpenAI-compat
    /// strict JSON) for callers that need a top-level JSON object.
    async fn complete(&self, system: &str, user: &str, json_mode: bool) -> Result<String, AnalyzeError> {
        let url  = format!("{}/v1/chat/completions", self.base_url);
        let mut body = json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": user }
            ],
            "temperature": 0.3,
            "max_tokens": 4096
        });
        if json_mode {
            body["response_format"] = json!({ "type": "json_object" });
        }

        debug!("{}: POST {} model={} json={}", self.provider_tag, url, self.model, json_mode);

        let resp = {
            let mut attempt = 0u32;
            loop {
                attempt += 1;
                match self
                    .client
                    .post(&url)
                    .bearer_auth(&self.api_key)
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(r) => break r,
                    Err(e) if attempt < 3 => {
                        debug!("{}: send attempt {attempt} failed: {e}{}", self.provider_tag, std::error::Error::source(&e).map(|s| format!(" (cause: {s})")).unwrap_or_default());
                        tokio::time::sleep(std::time::Duration::from_millis(400 * attempt as u64)).await;
                    }
                    Err(e) => {
                        return Err(AnalyzeError::ApiError {
                            provider: self.provider_tag.clone(),
                            message:  format!("request failed: {e}{}", std::error::Error::source(&e).map(|s| format!(" (cause: {s})")).unwrap_or_default()),
                        });
                    }
                }
            }
        };

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
}

#[async_trait]
impl LlmProvider for OpenAiCompatProvider {
    async fn chat_completion(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        self.complete(system, user, false).await
    }
    async fn chat_completion_json(&self, system: &str, user: &str) -> Result<String, AnalyzeError> {
        self.complete(system, user, true).await
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
        endpoints::novita(),
        api_key, model, "novita".into(),
    )
}

/// Together AI — wide model selection.
pub fn together(api_key: String, model: String) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(
        endpoints::together(),
        api_key, model, "together".into(),
    )
}

/// Fireworks AI — fast open-source model serving.
pub fn fireworks(api_key: String, model: String) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new(
        endpoints::fireworks(),
        api_key, model, "fireworks".into(),
    )
}
