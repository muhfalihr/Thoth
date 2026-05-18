use std::path::PathBuf;

use anyhow::{Context, Result};
use config::{Config, Environment, File};
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
pub struct AppConfig {
    pub llm: LlmConfig,
    pub whisper: WhisperConfig,
    pub ffmpeg: FfmpegConfig,
    pub output: OutputConfig,
    pub ingest: IngestConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LlmConfig {
    pub default_provider: String,
    pub groq_model: String,
    pub openai_model: String,
    pub ollama_model: String,
    pub ollama_base_url: String,
    pub max_clips: usize,
    pub max_retries: u32,
    #[serde(skip)]
    pub groq_api_key: String,
    #[serde(skip)]
    pub openai_api_key: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct WhisperConfig {
    pub model_dir: PathBuf,
    pub model_size: String,
    pub language: String,
    pub n_threads: i32,
    pub gpu_device: i32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct FfmpegConfig {
    pub ffmpeg_path: Option<String>,
    pub nvenc: bool,
    pub cq_value: u32,
    pub preset: String,
    pub audio_bitrate: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct OutputConfig {
    pub default_dir: PathBuf,
    pub default_layout: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct IngestConfig {
    pub ytdlp_path: String,
    pub format: String,
}

impl AppConfig {
    pub fn load() -> Result<Self> {
        let cfg = Config::builder()
            .set_default("llm.default_provider", "groq")?
            .set_default("llm.groq_model", "llama-3.3-70b-versatile")?
            .set_default("llm.openai_model", "gpt-4o-mini")?
            .set_default("llm.ollama_model", "llama3:70b")?
            .set_default("llm.ollama_base_url", "http://localhost:11434")?
            .set_default("llm.max_clips", 3)?
            .set_default("llm.max_retries", 2)?
            .set_default("whisper.model_dir", "models")?
            .set_default("whisper.model_size", "medium")?
            .set_default("whisper.language", "en")?
            .set_default("whisper.n_threads", 4)?
            .set_default("whisper.gpu_device", 0)?
            .set_default("ffmpeg.nvenc", true)?
            .set_default("ffmpeg.cq_value", 23)?
            .set_default("ffmpeg.preset", "p4")?
            .set_default("ffmpeg.audio_bitrate", "192k")?
            .set_default("output.default_dir", "./output")?
            .set_default("output.default_layout", "vertical")?
            .set_default("ingest.ytdlp_path", "yt-dlp")?
            .set_default(
                "ingest.format",
                "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            )?
            .add_source(File::with_name("config").required(false))
            .add_source(Environment::with_prefix("CLIPPER").separator("_"))
            .build()
            .context("failed to build configuration")?;

        let mut app: AppConfig = cfg.try_deserialize().context("failed to parse configuration")?;

        // Load API keys from env — never from config file
        app.llm.groq_api_key = std::env::var("CLIPPER_GROQ_API_KEY").unwrap_or_default();
        app.llm.openai_api_key = std::env::var("CLIPPER_OPENAI_API_KEY").unwrap_or_default();
        
        // Priority for language: env var > config file
        if let Ok(lang) = std::env::var("CLIPPER_WHISPER_LANGUAGE") {
            app.whisper.language = lang;
        }

        Ok(app)
    }

    pub fn whisper_model_path(&self, size_override: Option<&str>) -> PathBuf {
        let size = size_override.unwrap_or(&self.whisper.model_size);
        let filename = match size {
            "tiny" => "ggml-tiny.bin",
            "base" => "ggml-base.bin",
            "small" => "ggml-small.bin",
            "large-v3" => "ggml-large-v3.bin",
            _ => "ggml-medium.bin",
        };
        self.whisper.model_dir.join(filename)
    }
}
