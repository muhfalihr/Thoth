/// Semantic embedding generation for ViralMoments — multi-provider.
///
/// Mendukung beberapa provider embedding:
///   - `gemini`  → Gemini text-embedding-004 (768 dims, free tier Google)
///   - `openai`  → OpenAI /v1/embeddings atau provider OpenAI-compatible
///                 (Novita AI, Together AI, dll.) — gunakan `embed_base_url` + `embed_api_key`
///   - `vllm`    → vLLM self-hosted server (OpenAI-compatible, model lokal)
///
/// Embedding text = concatenation of the most semantically rich fields:
///   title | reason | hook | target_audience | viral_type content_category

use anyhow::Result;
use serde_json::{json, Value};
use tracing::warn;

use crate::analyze::schema::ViralMoment;

/// Dimensi default untuk Gemini text-embedding-004.
/// Provider lain (OpenAI text-embedding-3-small = 1536, Qwen3-Embedding-8B = 4096)
/// menghasilkan dimensi sesuai model — dimensi aktual selalu diambil dari respons.
pub const EMBED_DIMS: usize = 768;

// ── Embedding config ─────────────────────────────────────────────────────────

/// Konfigurasi provider embedding untuk RAG.
///
/// Dibangun dari `VectorDbConfig` di config.rs dan dikirim ke `embed_text_with_config`.
#[derive(Debug, Clone)]
pub struct EmbedConfig {
    /// Provider: "gemini" | "openai" | "vllm"
    pub provider: String,
    /// Base URL untuk endpoint embedding.
    /// - gemini: tidak dipakai (URL dibangun otomatis)
    /// - openai: e.g. "https://api.novita.ai/openai" atau "https://api.openai.com"
    /// - vllm:   e.g. "http://localhost:8000"
    pub base_url: String,
    /// Nama model embedding.
    /// - gemini: "text-embedding-004" (default, bisa dikosongkan)
    /// - openai: "text-embedding-3-small" | "text-embedding-3-large" | "qwen/qwen3-embedding-8b"
    /// - vllm:   nama model yang diload di server, e.g. "Qwen/Qwen3-Embedding-8B"
    pub model: String,
    /// API key.
    /// - gemini: CLIPPER_GEMINI_API_KEY
    /// - openai/novita: CLIPPER_EMBED_API_KEY (atau CLIPPER_OPENAI_API_KEY sebagai fallback)
    /// - vllm:   CLIPPER_VLLM_API_KEY (opsional jika server tidak butuh auth)
    pub api_key: String,
}

impl EmbedConfig {
    /// Bangun EmbedConfig dari AppConfig.
    pub fn from_app_config(config: &crate::config::AppConfig) -> Self {
        let vdb = &config.vector_db;
        let provider = vdb.embed_provider.clone();

        // Pilih API key berdasarkan provider
        let api_key = match provider.as_str() {
            "gemini" => config.llm.gemini_api_key.clone(),
            "novita" => {
                // Prioritas: CLIPPER_EMBED_API_KEY > CLIPPER_NOVITA_API_KEY
                if !vdb.embed_api_key.is_empty() { vdb.embed_api_key.clone() }
                else { config.llm.novita_api_key.clone() }
            }
            "vllm" => config.llm.vllm_api_key.clone(),
            _ => {
                // "openai" dan provider OpenAI-compatible lainnya:
                // Prioritas: CLIPPER_EMBED_API_KEY > CLIPPER_OPENAI_API_KEY
                if !vdb.embed_api_key.is_empty() { vdb.embed_api_key.clone() }
                else { config.llm.openai_api_key.clone() }
            }
        };

        // Pilih base URL (config embed_base_url selalu override)
        let base_url = if !vdb.embed_base_url.is_empty() {
            vdb.embed_base_url.clone()
        } else {
            match provider.as_str() {
                "novita" => config.llm.novita_base_url.clone(),
                "vllm"   => config.llm.vllm_base_url.clone(),
                "openai" => "https://api.openai.com".to_owned(),
                _        => String::new(), // gemini: URL dibangun di dalam fungsi
            }
        };

        // Pilih nama model (config embed_model selalu override)
        let model = if !vdb.embed_model.is_empty() {
            vdb.embed_model.clone()
        } else {
            match provider.as_str() {
                "gemini" => "text-embedding-004".to_owned(),
                "novita" => "qwen/qwen3-embedding-8b".to_owned(),
                "openai" => "text-embedding-3-small".to_owned(),
                "vllm"   => "Qwen/Qwen3-Embedding-8B".to_owned(),
                _        => "text-embedding-004".to_owned(),
            }
        };

        EmbedConfig { provider, base_url, model, api_key }
    }

    /// Apakah config ini valid (tidak ada field penting yang kosong)?
    pub fn is_valid(&self) -> bool {
        if self.api_key.is_empty() {
            // vLLM self-hosted boleh tanpa API key
            if self.provider != "vllm" { return false; }
        }
        match self.provider.as_str() {
            "gemini" => true,
            "openai" | "novita" | "vllm" => !self.base_url.is_empty(),
            _ => false,
        }
    }
}

// ── Text helpers ─────────────────────────────────────────────────────────────

/// Build the text input used for embedding a ViralMoment.
pub fn moment_to_embed_text(moment: &ViralMoment) -> String {
    format!(
        "{title} | {reason} | {hook} | {audience} | {vtype} {category}",
        title    = moment.title,
        reason   = moment.reason,
        hook     = moment.hook,
        audience = moment.target_audience,
        vtype    = moment.viral_type,
        category = moment.content_category,
    )
}

/// Build a query embedding from a short descriptive context
/// (used when retrieving before analysis — no full moment yet).
pub fn context_to_embed_text(
    transcript_snippet: &str,
    keywords:           &[String],
    language:           &str,
) -> String {
    format!(
        "video about: {keywords} | language: {language} | {snippet}",
        keywords = keywords.join(", "),
        language = language,
        snippet  = transcript_snippet.chars().take(400).collect::<String>(),
    )
}

// ── Multi-provider embed_text ────────────────────────────────────────────────

/// Generate embedding vector untuk teks yang diberikan menggunakan provider
/// yang dikonfigurasi di `EmbedConfig`.
///
/// Returns `None` on API error (graceful degradation — RAG is always optional).
pub async fn embed_text_with_config(
    text:   &str,
    cfg:    &EmbedConfig,
    client: &reqwest::Client,
) -> Option<Vec<f32>> {
    if text.is_empty() || !cfg.is_valid() {
        return None;
    }
    match cfg.provider.as_str() {
        "gemini" => embed_via_gemini(text, &cfg.api_key, &cfg.model, client).await,
        "vllm"   => embed_via_openai_compat(
            text, &cfg.api_key, &cfg.model,
            &format!("{}/v1/embeddings", cfg.base_url.trim_end_matches('/')),
            client,
        ).await,
        // "openai" dan provider OpenAI-compatible lainnya (Novita AI, dll.)
        _ => embed_via_openai_compat(
            text, &cfg.api_key, &cfg.model,
            &format!("{}/v1/embeddings", cfg.base_url.trim_end_matches('/')),
            client,
        ).await,
    }
}

/// Alias backward-compatible — memanggil Gemini secara langsung.
/// Dipertahankan agar kode lama yang masih menggunakan `embed_text` tetap bisa
/// dikompilasi. Untuk kode baru gunakan `embed_text_with_config`.
pub async fn embed_text(
    text:    &str,
    api_key: &str,
    client:  &reqwest::Client,
) -> Option<Vec<f32>> {
    embed_via_gemini(text, api_key, "text-embedding-004", client).await
}

// ── Provider implementations ─────────────────────────────────────────────────

/// Embed menggunakan Gemini REST API (`generativelanguage.googleapis.com`).
async fn embed_via_gemini(
    text:    &str,
    api_key: &str,
    model:   &str,
    client:  &reqwest::Client,
) -> Option<Vec<f32>> {
    if api_key.is_empty() {
        warn!("rag/embed[gemini]: CLIPPER_GEMINI_API_KEY tidak di-set");
        return None;
    }

    let model_name = if model.is_empty() { "text-embedding-004" } else { model };
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/\
         {model_name}:embedContent?key={api_key}"
    );

    let body = json!({
        "model": format!("models/{model_name}"),
        "content": { "parts": [{ "text": text }] }
    });

    let resp = match client.post(&url).json(&body).send().await {
        Ok(r)  => r,
        Err(e) => { warn!("rag/embed[gemini]: HTTP error: {e}"); return None; }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        warn!("rag/embed[gemini]: API returned {status}: {}",
              body.chars().take(200).collect::<String>());
        return None;
    }

    let json: Value = match resp.json().await {
        Ok(v)  => v,
        Err(e) => { warn!("rag/embed[gemini]: JSON parse error: {e}"); return None; }
    };

    let values = json["embedding"]["values"].as_array()?;
    let vec: Vec<f32> = values.iter()
        .filter_map(|v| v.as_f64().map(|f| f as f32))
        .collect();

    if vec.is_empty() {
        warn!("rag/embed[gemini]: embedding kosong");
        return None;
    }

    Some(vec)
}

/// Embed menggunakan endpoint OpenAI-compatible `/v1/embeddings`.
/// Mendukung: OpenAI, Novita AI, Together AI, vLLM, dan server OpenAI-compatible lainnya.
async fn embed_via_openai_compat(
    text:       &str,
    api_key:    &str,
    model:      &str,
    endpoint:   &str,  // full URL, e.g. "https://api.novita.ai/openai/v1/embeddings"
    client:     &reqwest::Client,
) -> Option<Vec<f32>> {
    let body = json!({
        "model": model,
        "input": text,
        "encoding_format": "float"
    });

    let mut req = client.post(endpoint).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }

    let resp = match req.send().await {
        Ok(r)  => r,
        Err(e) => { warn!("rag/embed[openai-compat]: HTTP error ke {endpoint}: {e}"); return None; }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body   = resp.text().await.unwrap_or_default();
        warn!("rag/embed[openai-compat]: API {endpoint} returned {status}: {}",
              body.chars().take(300).collect::<String>());
        return None;
    }

    let json: Value = match resp.json().await {
        Ok(v)  => v,
        Err(e) => { warn!("rag/embed[openai-compat]: JSON parse error: {e}"); return None; }
    };

    // Format respons OpenAI: { "data": [ { "embedding": [...] } ] }
    let embedding = json["data"][0]["embedding"].as_array()?;
    let vec: Vec<f32> = embedding.iter()
        .filter_map(|v| v.as_f64().map(|f| f as f32))
        .collect();

    if vec.is_empty() {
        warn!("rag/embed[openai-compat]: embedding kosong dari {endpoint}");
        return None;
    }

    Some(vec)
}
