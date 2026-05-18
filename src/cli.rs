use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Parser, Debug)]
#[command(
    name = "clipper",
    version,
    about = "GPU-accelerated viral video clipping and editing from YouTube URLs",
    long_about = None
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Download a YouTube video for processing
    Ingest(IngestArgs),
    /// Transcribe a video file using Whisper (CUDA)
    Transcribe(TranscribeArgs),
    /// Identify viral moments using an LLM
    Analyze(AnalyzeArgs),
    /// Cut, reframe, and burn subtitles into clips
    Edit(EditArgs),
    /// Run the full pipeline end-to-end
    Run(RunArgs),
}

#[derive(Parser, Debug)]
pub struct IngestArgs {
    /// YouTube URL to download
    pub url: String,

    /// Output directory for all job artifacts
    #[arg(short, long, default_value = "./output")]
    pub output_dir: PathBuf,

    /// Force re-download even if the file already exists
    #[arg(long)]
    pub force: bool,
}

#[derive(Parser, Debug)]
pub struct TranscribeArgs {
    /// Path to the source video file
    pub video_path: PathBuf,

    /// Output directory for transcript JSON
    #[arg(short, long, default_value = "./output")]
    pub output_dir: PathBuf,

    /// Whisper model size
    #[arg(long, default_value = "medium")]
    pub model: WhisperModelSize,

    /// Language code for transcription (e.g., "id", "en"). Auto-detects if empty.
    #[arg(long)]
    pub language: Option<String>,
}

#[derive(Parser, Debug)]
pub struct AnalyzeArgs {
    /// Path to the transcript JSON file produced by `transcribe`
    pub transcript_path: PathBuf,

    /// LLM provider to use
    #[arg(long, default_value = "groq")]
    pub provider: LlmProviderName,

    /// Maximum number of viral clips to find
    #[arg(long, default_value_t = 3)]
    pub max_clips: usize,
}

#[derive(Parser, Debug)]
pub struct EditArgs {
    /// Path to the source video file
    pub video_path: PathBuf,

    /// Path to the viral moments JSON file produced by `analyze`
    pub moments_path: PathBuf,

    /// Path to the transcript JSON file (for subtitle burning)
    pub transcript_path: PathBuf,

    /// Output aspect ratio / layout
    #[arg(long, default_value = "vertical")]
    pub layout: OutputLayout,

    /// Output directory for rendered clips
    #[arg(short, long, default_value = "./output")]
    pub output_dir: PathBuf,
}

#[derive(Parser, Debug)]
pub struct RunArgs {
    /// YouTube URL to process
    pub url: String,

    /// Output directory for all job artifacts
    #[arg(short, long, default_value = "./output")]
    pub output_dir: PathBuf,

    /// LLM provider for analysis
    #[arg(long, default_value = "groq")]
    pub provider: LlmProviderName,

    /// Whisper model size
    #[arg(long, default_value = "medium")]
    pub model: WhisperModelSize,

    /// Maximum number of viral clips to produce
    #[arg(long, default_value_t = 3)]
    pub max_clips: usize,

    /// Output aspect ratio / layout
    #[arg(long, default_value = "vertical")]
    pub layout: OutputLayout,

    /// Language code for transcription (e.g., "id", "en"). Auto-detects if empty.
    #[arg(long)]
    pub language: Option<String>,

    /// Resume a previous job by its ID (skips completed stages)
    #[arg(long)]
    pub resume: Option<String>,
}

#[derive(Clone, Debug, ValueEnum)]
pub enum WhisperModelSize {
    Tiny,
    Base,
    Small,
    Medium,
    #[value(name = "large-v3")]
    LargeV3,
}

impl WhisperModelSize {
    pub fn as_filename(&self) -> &'static str {
        match self {
            WhisperModelSize::Tiny => "ggml-tiny.bin",
            WhisperModelSize::Base => "ggml-base.bin",
            WhisperModelSize::Small => "ggml-small.bin",
            WhisperModelSize::Medium => "ggml-medium.bin",
            WhisperModelSize::LargeV3 => "ggml-large-v3.bin",
        }
    }
}

impl std::fmt::Display for WhisperModelSize {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            WhisperModelSize::Tiny => "tiny",
            WhisperModelSize::Base => "base",
            WhisperModelSize::Small => "small",
            WhisperModelSize::Medium => "medium",
            WhisperModelSize::LargeV3 => "large-v3",
        };
        write!(f, "{s}")
    }
}

#[derive(Clone, Debug, ValueEnum)]
pub enum LlmProviderName {
    Groq,
    Openai,
    Ollama,
}

impl std::fmt::Display for LlmProviderName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmProviderName::Groq => write!(f, "groq"),
            LlmProviderName::Openai => write!(f, "openai"),
            LlmProviderName::Ollama => write!(f, "ollama"),
        }
    }
}

#[derive(Clone, Debug, ValueEnum)]
pub enum OutputLayout {
    /// 9:16 vertical (TikTok / Reels / Shorts)
    Vertical,
    /// 16:9 horizontal (YouTube / standard)
    Horizontal,
    /// 1:1 square (Instagram feed)
    Square,
}

impl std::fmt::Display for OutputLayout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OutputLayout::Vertical => write!(f, "vertical"),
            OutputLayout::Horizontal => write!(f, "horizontal"),
            OutputLayout::Square => write!(f, "square"),
        }
    }
}
