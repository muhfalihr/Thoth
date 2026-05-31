use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use config::{Config, Environment, File};
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
pub struct AppConfig {
    pub llm:    LlmConfig,
    pub whisper: WhisperConfig,
    pub ffmpeg:  FfmpegConfig,
    pub gpu:     GpuConfig,
    pub output:  OutputConfig,
    pub ingest:  IngestConfig,
    pub assets:  AssetsConfig,
    pub vision:  VisionConfig,
    pub overlay:   OverlayConfig,
    pub styles:    StylesConfig,
    pub vector_db: VectorDbConfig,
}

/// GPU-accelerated processing configuration.
///
/// ```toml
/// [gpu]
/// enabled          = true   # requires NVIDIA/AMD GPU with Vulkan/DX12 support
/// color_grading    = true   # apply per-clip color grading on GPU
/// gpu_transitions  = true   # use GPU-native transitions (vs FFmpeg xfade)
/// concat_output    = false  # if true, concat all clips into one final video
/// default_color_mood = "cinematic"  # preset applied to all clips (empty = none)
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct GpuConfig {
    /// Enable GPU processing pipeline. Requires wgpu-compatible GPU.
    /// When false, falls back to FFmpeg-only path.
    #[serde(default)]
    pub enabled: bool,

    /// Apply GPU color grading (ColorPipeline) to each clip.
    #[serde(default = "default_true")]
    pub color_grading: bool,

    /// Use GPU-native transitions (TransitionPipeline) instead of FFmpeg xfade.
    /// Produces higher-quality blends at the cost of frame-by-frame processing.
    #[serde(default)]
    pub gpu_transitions: bool,

    /// If true, run `GpuProcessor::concat_gpu()` after all clips are rendered
    /// to produce a single concatenated output video.
    #[serde(default)]
    pub concat_output: bool,

    /// Default color mood applied to all clips when `ViralMoment.color_mood` is empty.
    /// Options: cinematic | warm | cool | vibrant | faded | night | bright | teal_orange
    /// Empty string = no default grading.
    #[serde(default)]
    pub default_color_mood: String,
}

impl Default for GpuConfig {
    fn default() -> Self {
        Self {
            enabled:            false,
            color_grading:      true,
            gpu_transitions:    false,
            concat_output:      false,
            default_color_mood: String::new(),
        }
    }
}

// ── Style profiles ────────────────────────────────────────────────────────────

/// A named editing style preset — groups subtitle, clip, sfx, bgm, and overlay
/// choices into a single selectable profile.  Users can define their own in
/// `config.toml` and pass `--style-profile <name>` to apply it to all clips.
///
/// Fields left empty (`""`) defer to the LLM's per-clip suggestion.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct StyleProfile {
    /// Human-readable description shown in logs.
    #[serde(default)]
    pub description: String,
    /// Subtitle animation style override: karaoke | capcut_bold | word_pop | minimal_white
    #[serde(default)]
    pub subtitle_style: String,
    /// Clip transition override: fade | flash | zoom | smooth | none
    #[serde(default)]
    pub clip_style: String,
    /// SFX vibe override: impact | whoosh | ding | comedy | none
    #[serde(default)]
    pub sfx_vibe: String,
    /// BGM vibe override: lofi | upbeat | cinematic | inspirational | none
    #[serde(default)]
    pub bgm_vibe: String,
    /// Overlay style override: auto | sticker | pip | fullscreen
    #[serde(default)]
    pub overlay_style: String,

    /// GPU color mood override: cinematic | warm | cool | vibrant | faded | ...
    /// Empty = defer to LLM's `color_mood` suggestion.
    #[serde(default)]
    pub color_mood: String,

    /// GPU transition type override for this profile.
    /// Empty = use LLM's `gpu_transition` suggestion.
    #[serde(default)]
    pub gpu_transition: String,
}

/// Collection of named style profiles + the default to use when no `--style-profile` is given.
#[derive(Debug, Deserialize, Clone)]
pub struct StylesConfig {
    /// Profile name applied when `--style-profile` is NOT specified.
    /// Use `"auto"` to let the LLM decide per-clip (no override).
    pub default_profile: String,
    /// Map of profile name → StyleProfile definition.
    #[serde(default)]
    pub profiles: HashMap<String, StyleProfile>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LlmConfig {
    pub default_provider: String,

    // ── Groq ────────────────────────────────────────────────────────────
    pub groq_model: String,
    #[serde(skip)]
    pub groq_api_key: String,

    // ── OpenAI ──────────────────────────────────────────────────────────
    pub openai_model: String,
    #[serde(skip)]
    pub openai_api_key: String,

    // ── Claude (Anthropic) ──────────────────────────────────────────────
    pub claude_model: String,
    #[serde(skip)]
    pub claude_api_key: String,

    // ── Gemini (Google) ────────────────────────────────────────────────
    pub gemini_model: String,
    #[serde(skip)]
    pub gemini_api_key: String,

    // ── Ollama (local, no auth) ─────────────────────────────────────────
    pub ollama_base_url: String,
    pub ollama_model: String,

    // ── Novita AI (cloud, OpenAI-compatible) ───────────────────────────
    pub novita_base_url: String,
    pub novita_model: String,
    #[serde(skip)]
    pub novita_api_key: String,

    // ── vLLM (self-hosted, OpenAI-compatible) ───────────────────────────
    /// vLLM server base URL, e.g. "http://localhost:8000"
    pub vllm_base_url: String,
    /// Model name as loaded in the vLLM server, e.g. "Qwen/Qwen2.5-72B-Instruct"
    pub vllm_model: String,
    #[serde(skip)]
    pub vllm_api_key: String,

    // ── OpenAI-compatible external providers ──────────────────────────
    /// Novita AI model name (default: meta-llama/llama-3.3-70b-instruct)
    /// Together AI model name (default: meta-llama/Llama-3.3-70B-Instruct-Turbo)
    pub together_model: String,
    #[serde(skip)]
    pub together_api_key: String,

    /// Fireworks AI model name (default: accounts/fireworks/models/llama-v3p3-70b-instruct)
    pub fireworks_model: String,
    #[serde(skip)]
    pub fireworks_api_key: String,

    // ── Pipeline limits ────────────────────────────────────────────────
    pub max_clips: usize,
    pub max_retries: u32,
    /// Minimum time (seconds) before which no clip can start.
    /// 0.0 = auto-detect intro end from transcript patterns.
    /// >0.0 = manual hard cutoff (e.g. 60.0 skips first 60 s always).
    pub min_clip_start_sec: f64,

    /// Maximum video timestamp (seconds) after which no clip can START.
    /// 0.0 = auto-detect outro start from transcript patterns.
    /// >0.0 = manual hard cutoff (e.g. 3540.0 = skip last 60 s for a 3600 s video).
    pub max_clip_end_sec: f64,
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

    // ── SKILL.md §1A — Network resilience ────────────────────────────────────
    /// Total HTTP request retries (default: 30 per VidBee blueprint).
    #[serde(default = "default_ingest_retries")]
    pub retries: u32,
    /// Per-fragment retries for HLS/DASH streams (default: 30).
    #[serde(default = "default_ingest_retries")]
    pub fragment_retries: u32,
    /// Seconds of backoff between retries to avoid hammering on transient errors (default: 2).
    #[serde(default = "default_retry_sleep")]
    pub retry_sleep: u32,
    /// Socket connect/read timeout in seconds — prevents DNS/connection hangs (default: 30).
    #[serde(default = "default_socket_timeout")]
    pub socket_timeout: u32,

    // ── SKILL.md §3A — Cookie authentication ─────────────────────────────────
    /// Browser to auto-extract cookies from for age-gated / region-locked videos.
    /// Supported: "firefox", "chrome", "edge", "brave", "chromium", "opera".
    /// On Windows, prefer "firefox" — Chromium browsers encrypt their DB with the OS keyring
    /// and lock it while running. Leave empty to disable (default).
    #[serde(default)]
    pub cookie_browser: String,
    /// Path to a Netscape/Mozilla format cookie file exported with
    /// "Get cookies.txt LOCALLY" (local-only extension — never cloud-synced).
    /// Takes priority over cookie_browser when both are set.
    /// Treat this file as a high-sensitivity secret — never commit it.
    #[serde(default)]
    pub cookie_file: String,
}

fn default_ingest_retries() -> u32  { 30 }
fn default_retry_sleep()    -> u32  { 2  }
fn default_socket_timeout() -> u32  { 30 }

/// Asset folder configuration + vibe→file mappings.
///
/// The LLM outputs semantic "vibes" (e.g. "impact", "lofi") during analysis.
/// These fields map each vibe label to an actual audio file inside `sfx_dir` / `bgm_dir`.
///
/// Example config.toml:
/// ```toml
/// [assets]
/// sfx_dir = "sfx"
/// bgm_dir = "bgm"
///
/// [assets.sfx]
/// impact  = "impact-hit.mp3"
/// whoosh  = "whoosh-swipe.mp3"
/// ding    = "notification.mp3"
/// comedy  = "vine-boom.mp3"
/// none    = ""
///
/// [assets.bgm]
/// lofi          = "lofi-chill.mp3"
/// upbeat        = "upbeat-pop.mp3"
/// cinematic     = "epic-cinematic.mp3"
/// inspirational = "inspiring-piano.mp3"
/// none          = ""
/// ```
#[derive(Debug, Deserialize, Clone, Default)]
pub struct AssetsConfig {
    /// Folder containing SFX files (default: "sfx/")
    #[serde(default = "default_sfx_dir")]
    pub sfx_dir: PathBuf,
    /// Folder containing BGM files (default: "bgm/")
    #[serde(default = "default_bgm_dir")]
    pub bgm_dir: PathBuf,
    /// vibe label → SFX filename mapping
    #[serde(default)]
    pub sfx: HashMap<String, String>,
    /// vibe label → BGM filename mapping
    #[serde(default)]
    pub bgm: HashMap<String, String>,

    /// Enable beat-synchronised SFX timing and BGM volume ducking (default: false).
    ///
    /// When true:
    ///   - SFX start time is snapped to the nearest downbeat of the BGM
    ///   - BGM volume is ducked (−60%) during the speech portion of the clip
    ///     and restored for the opening/closing seconds
    pub beat_sync: bool,
}

fn default_sfx_dir() -> PathBuf { PathBuf::from("sfx") }
fn default_bgm_dir() -> PathBuf { PathBuf::from("bgm") }
fn default_embed_provider() -> String { "gemini".to_owned() }
fn default_true() -> bool { true }

// ── Vector DB / RAG config ────────────────────────────────────────────────────

/// Configuration for Supabase PostgreSQL + pgvector long-term memory.
///
/// When `enabled = true`, CLIPPER:
/// 1. Retrieves similar past viral moments BEFORE LLM analysis → injects as examples
/// 2. Stores finalized moments AFTER analysis → builds library over time
///
/// Connection URI is loaded exclusively from `CLIPPER_SUPABASE_URL` env var.
/// Embeddings use Gemini `text-embedding-004` (free tier, 768 dims).
#[derive(Debug, Deserialize, Clone)]
pub struct VectorDbConfig {
    /// Enable Vector DB + RAG (default: false — requires CLIPPER_SUPABASE_URL).
    pub enabled: bool,
    /// Number of similar past moments to retrieve and inject per analysis (default: 3).
    pub retrieval_count: usize,
    /// Minimum cosine similarity for retrieval (0.0–1.0, default: 0.65).
    pub similarity_threshold: f32,
    /// How often to refresh vocabulary from Supabase (seconds). Default: 3600 (1 hour).
    pub vocab_cache_ttl_secs: u64,
    /// Supabase PostgreSQL connection URI — never stored in config file.
    #[serde(skip)]
    pub supabase_url: String,

    // ── Embedding provider ─────────────────────────────────────────────────────────

    /// Provider untuk text embedding.
    /// Pilihan: "gemini" (default) | "openai" | "vllm"
    ///
    /// - "gemini": Gunakan Gemini text-embedding-004 (768 dims, gratis).
    ///   Requires CLIPPER_GEMINI_API_KEY.
    /// - "openai": Gunakan endpoint OpenAI-compatible — cocok untuk Novita AI,
    ///   Together AI, OpenAI, dll. Set `embed_base_url` dan `embed_model`.
    ///   Requires CLIPPER_EMBED_API_KEY (atau fallback ke CLIPPER_OPENAI_API_KEY).
    /// - "vllm": Server vLLM self-hosted dengan model embedding (e.g. Qwen3-Embedding).
    ///   Requires `embed_base_url` dan opsional CLIPPER_VLLM_API_KEY.
    #[serde(default = "default_embed_provider")]
    pub embed_provider: String,

    /// Base URL endpoint embedding.
    /// - "gemini": tidak dipakai.
    /// - "openai" (Novita AI): "https://api.novita.ai/openai"
    /// - "openai" (OpenAI):    "https://api.openai.com"
    /// - "vllm":              "http://localhost:8000"
    /// Kosong = gunakan default per provider.
    #[serde(default)]
    pub embed_base_url: String,

    /// Model embedding yang digunakan.
    /// - "gemini": "text-embedding-004" (default)
    /// - "openai" / Novita AI: "qwen/qwen3-embedding-8b" | "text-embedding-3-small"
    /// - "vllm":  "Qwen/Qwen3-Embedding-8B" (sesuai model di server)
    /// Kosong = gunakan default model per provider.
    #[serde(default)]
    pub embed_model: String,

    /// API key khusus untuk embedding.
    /// Diisi dari env var CLIPPER_EMBED_API_KEY.
    /// Jika kosong, fallback ke CLIPPER_OPENAI_API_KEY (untuk provider "openai"),
    /// CLIPPER_GEMINI_API_KEY (untuk "gemini"), atau CLIPPER_VLLM_API_KEY (untuk "vllm").
    #[serde(skip)]
    pub embed_api_key: String,
}

// ── Overlay config ────────────────────────────────────────────────────────────

/// Configuration for the optional TikTok/YouTube Shorts overlay feature.
///
/// When `enabled = true`, the edit stage downloads a short contextual clip via
/// yt-dlp for each moment that has an `overlay_query` (set by the LLM during
/// analysis) and inserts it as a full-frame cut-away at the LLM-specified time.
///
/// No API key required — yt-dlp handles TikTok search natively.
/// Falls back to YouTube Shorts (`ytsearch1:`) if TikTok blocks.
/// Downloaded clips are cached by query hash to avoid re-downloading.
#[derive(Debug, Deserialize, Clone)]
pub struct OverlayConfig {
    /// Enable TikTok overlay insertion (default: false — opt-in).
    pub enabled: bool,
    /// yt-dlp binary path. Empty = inherit `ingest.ytdlp_path`.
    pub ytdlp_path: String,
    /// Directory for caching downloaded overlay clips.
    pub cache_dir: PathBuf,
    /// Maximum seconds to download per overlay clip (default: 8).
    pub max_duration: f64,
    /// If TikTok search fails, fall back to YouTube Shorts search.
    pub fallback_to_youtube: bool,
    /// Number of different clip variants to download per query (default: 3).
    /// Clips rotate by index so each clip in a run uses a different variant,
    /// even when the LLM generates the same overlay_query for multiple clips.
    pub max_variants: u32,
    /// Enable the stealth HTTP scraper for URL resolution (default: true).
    ///
    /// When enabled, the scraper fetches direct video URLs from TikTok / YouTube
    /// search pages using Chrome-fingerprint requests BEFORE yt-dlp runs.
    /// yt-dlp then downloads the specific URL rather than searching — 3–5× faster
    /// and results are pre-ranked by view count.
    /// Falls back to yt-dlp search automatically if scraping fails.
    #[serde(default = "default_true")]
    pub scraper_enabled: bool,
}

// ── Vision config ─────────────────────────────────────────────────────────────

/// Configuration for the optional visual frame-analysis stage.
///
/// When `enabled = true`, the analyze stage extracts JPEG frames from the video
/// for each candidate moment and sends them to a vision-capable LLM to compute
/// visual quality scores (humor, visual_impact, novelty, engagement).
/// Those scores are blended with the text-rank to re-order the moments before
/// the final `max_clips` are selected.
///
/// Supported vision providers: `"claude"` | `"openai"` | `"gemini"`
/// (Groq, vLLM, Ollama do not support vision — they are skipped gracefully.)
#[derive(Debug, Deserialize, Clone)]
pub struct VisionConfig {
    /// Enable visual frame analysis (default: false — opt-in).
    pub enabled: bool,
    /// Which LLM provider to use for vision: "claude" | "openai" | "gemini" | "vllm"
    pub provider: String,
    /// Number of JPEG frames to extract per candidate moment (2–5 recommended).
    pub frames_per_moment: u32,
    /// Resize width in pixels when extracting frames (smaller = fewer tokens).
    pub frame_width: u32,
    /// Weight of visual score in combined ranking.
    /// 0.0 = text rank only · 1.0 = visual score only · default 0.35
    pub score_weight: f32,
    /// Base URL for the vLLM vision server (only used when provider = "vllm").
    /// Separate from llm.vllm_base_url so text and vision can use different servers.
    /// Example: "http://192.168.1.10:8001"
    #[serde(default)]
    pub vllm_base_url: String,
    /// Model name served by the vLLM vision server.
    /// Example: "Qwen/Qwen2.5-VL-72B-Instruct-AWQ"
    #[serde(default)]
    pub vllm_model: String,

    /// Base URL untuk Novita AI vision (cloud, OpenAI-compatible).
    /// Gunakan ini jika provider = "novita" atau "vllm" dengan Novita AI.
    #[serde(default)]
    pub novita_base_url: String,
    /// Model vision di Novita AI, e.g. "qwen/qwen3-vl-8b-instruct"
    #[serde(default)]
    pub novita_model: String,

    // ── Combined audio-visual prompt (Priority 1) ─────────────────────────────

    /// Enable full-video frame description for combined audio-visual prompt (default: false).
    ///
    /// When true, the analyze stage samples one frame every `describe_interval` seconds
    /// across the ENTIRE video, generates a brief text description for each frame, and
    /// injects those descriptions into the transcript before LLM analysis.
    ///
    /// Result: LLM sees both what was said AND what was visible at each timestamp:
    ///   [120] "Hampir 60% uang dari Cina!"
    ///     ↳ Visual: close-up pembicara, ekspresi serius, grafik merah di background
    ///
    /// Requires `vision.enabled = true`. Uses the same vision provider.
    pub describe_video: bool,
    /// Interval in seconds between frames sampled for full-video description (default: 10).
    /// Lower = more detail but more API calls. 10s is a good balance.
    pub describe_interval: f64,
    /// Number of frames sent per vision API call for description (default: 5).
    /// Batching reduces API calls. 5 frames × ~10s = describes a 50s window per call.
    pub describe_batch: u32,

    // ── Describe-specific overrides (optional) ────────────────────────────────
    // Use a different (faster/smaller) model for full-video description while
    // keeping the larger model for the more critical score_moment ranking.
    // When empty, falls back to the main vllm_base_url / vllm_model above.

    /// vLLM base URL for describe_video calls only.
    /// Example: "http://10.200.151.202:8007" (smaller/faster model)
    /// Empty = use vllm_base_url.
    #[serde(default)]
    pub describe_vllm_base_url: String,
    /// Model name for describe_video calls only.
    /// Example: "Qwen2.5-VL-7B-Instruct"
    /// Empty = use vllm_model.
    #[serde(default)]
    pub describe_vllm_model: String,

    // ── Scene detection ───────────────────────────────────────────────────────

    /// Enable scene-boundary-aware frame extraction (default: false).
    ///
    /// When true, an extra FFmpeg pass detects visual cuts before sampling.
    /// Frames are extracted AT actual scene boundaries instead of uniform
    /// time intervals — more representative, less redundant.
    ///
    /// Adds ~0.3–0.5s per moment for the detection pass.
    /// Recommended when `describe_video = true` for richer descriptions.
    pub scene_detection: bool,

    /// Sensitivity threshold for scene cut detection (0.0–1.0, default: 0.3).
    /// Lower = more sensitive (subtle colour changes count as cuts).
    /// Higher = hard cuts only (fast-paced montage, green screen transitions).
    pub scene_threshold: f32,
}

impl AssetsConfig {
    /// Resolve a SFX vibe label to an absolute path, if the file exists.
    /// Returns `None` if the vibe is "none", unmapped, or the file is missing.
    pub fn resolve_sfx(&self, vibe: &str) -> Option<PathBuf> {
        self.resolve_audio(&self.sfx_dir, &self.sfx, vibe)
    }

    /// Resolve a BGM vibe label to an absolute path, if the file exists.
    /// Returns `None` if the vibe is "none", unmapped, or the file is missing.
    pub fn resolve_bgm(&self, vibe: &str) -> Option<PathBuf> {
        self.resolve_audio(&self.bgm_dir, &self.bgm, vibe)
    }

    fn resolve_audio(&self, dir: &PathBuf, map: &HashMap<String, String>, vibe: &str) -> Option<PathBuf> {
        if vibe.is_empty() || vibe == "none" {
            return None;
        }
        let filename = map.get(vibe).map(|s| s.as_str()).unwrap_or(vibe);
        if filename.is_empty() || filename == "none" {
            return None;
        }
        let path = dir.join(filename);
        if path.exists() { Some(path) } else {
            tracing::debug!("Asset not found for vibe '{}': {}", vibe, path.display());
            None
        }
    }
}

impl AppConfig {
    pub fn load() -> Result<Self> {
        let cfg = Config::builder()
            .set_default("llm.default_provider", "groq")?
            .set_default("llm.groq_model", "llama-3.3-70b-versatile")?
            .set_default("llm.openai_model", "gpt-4o-mini")?
            .set_default("llm.claude_model", "claude-sonnet-4-5")?
            .set_default("llm.gemini_model", "gemini-2.0-flash")?
            .set_default("llm.ollama_base_url", "http://localhost:11434")?
            .set_default("llm.ollama_model", "llama3:70b")?
            .set_default("llm.novita_base_url", "https://api.novita.ai/openai")?
            .set_default("llm.novita_model", "meta-llama/llama-3.3-70b-instruct")?
            .set_default("llm.together_model", "meta-llama/Llama-3.3-70B-Instruct-Turbo")?
            .set_default("llm.fireworks_model", "accounts/fireworks/models/llama-v3p3-70b-instruct")?
            .set_default("llm.vllm_base_url", "http://localhost:8000")?
            .set_default("llm.vllm_model", "Qwen/Qwen2.5-72B-Instruct")?
            .set_default("llm.max_clips", 3)?
            .set_default("llm.max_retries", 2)?
            .set_default("llm.min_clip_start_sec", 0.0)?
            .set_default("llm.max_clip_end_sec", 0.0)?
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
            .set_default("assets.sfx_dir", "sfx")?
            .set_default("assets.bgm_dir", "bgm")?
            .set_default("assets.beat_sync", false)?
            .set_default("vision.enabled", false)?
            .set_default("vision.provider", "gemini")?
            .set_default("vision.frames_per_moment", 3)?
            .set_default("vision.frame_width", 384)?
            .set_default("vision.score_weight", 0.35)?
            .set_default("vision.vllm_base_url", "")?
            .set_default("vision.vllm_model", "Qwen/Qwen2.5-VL-7B-Instruct")?
            .set_default("vision.novita_base_url", "https://api.novita.ai/openai")?
            .set_default("vision.novita_model", "qwen/qwen3-vl-8b-instruct")?
            .set_default("vision.describe_video", false)?
            .set_default("vision.describe_interval", 10.0)?
            .set_default("vision.describe_batch", 5)?
            .set_default("vision.describe_vllm_base_url", "")?
            .set_default("vision.describe_vllm_model", "")?
            .set_default("vision.scene_detection", false)?
            .set_default("vision.scene_threshold", 0.3f64)?
            .set_default("overlay.enabled", false)?
            .set_default("overlay.ytdlp_path", "")?
            .set_default("overlay.cache_dir", "overlay_cache")?
            .set_default("overlay.max_duration", 8.0)?
            .set_default("overlay.fallback_to_youtube", true)?
            .set_default("overlay.max_variants", 3)?
            .set_default("styles.default_profile", "auto")?
            .set_default("vector_db.enabled", false)?
            .set_default("vector_db.retrieval_count", 3i64)?
            .set_default("vector_db.similarity_threshold", 0.65f64)?
            .set_default("vector_db.vocab_cache_ttl_secs", 3600i64)?
            .set_default("vector_db.embed_provider", "gemini")?
            .set_default("vector_db.embed_base_url", "")?
            .set_default("vector_db.embed_model", "")?
            .add_source(File::with_name("config").required(false))
            .add_source(Environment::with_prefix("CLIPPER").separator("_"))
            .build()
            .context("failed to build configuration")?;

        let mut app: AppConfig = cfg.try_deserialize().context("failed to parse configuration")?;

        // Load API keys from env — never from config file
        app.llm.groq_api_key   = std::env::var("CLIPPER_GROQ_API_KEY").unwrap_or_default();
        app.llm.openai_api_key = std::env::var("CLIPPER_OPENAI_API_KEY").unwrap_or_default();
        app.llm.claude_api_key = std::env::var("CLIPPER_CLAUDE_API_KEY").unwrap_or_default();
        app.llm.gemini_api_key = std::env::var("CLIPPER_GEMINI_API_KEY").unwrap_or_default();
        app.llm.novita_api_key    = std::env::var("CLIPPER_NOVITA_API_KEY").unwrap_or_default();
        app.llm.together_api_key  = std::env::var("CLIPPER_TOGETHER_API_KEY").unwrap_or_default();
        app.llm.fireworks_api_key = std::env::var("CLIPPER_FIREWORKS_API_KEY").unwrap_or_default();
        app.llm.vllm_api_key      = std::env::var("CLIPPER_VLLM_API_KEY").unwrap_or_default();
        // Supabase connection URI (full URI with password — never in config file)
        app.vector_db.supabase_url = std::env::var("CLIPPER_SUPABASE_URL").unwrap_or_default();
        // Embedding API key — khusus untuk RAG embedding, opsional
        app.vector_db.embed_api_key = std::env::var("CLIPPER_EMBED_API_KEY").unwrap_or_default();
        
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
