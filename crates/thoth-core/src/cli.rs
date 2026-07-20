use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

/// Clip transition style — applied at the IN and OUT of every clip.
#[derive(Clone, Debug, ValueEnum, Default)]
pub enum ClipStyleArg {
    /// Fade from/to black (default — works for all content)
    #[default]
    Fade,
    /// Flash from/to white — energetic, great for meme/reaction content
    Flash,
    /// Subtle Ken Burns zoom-in push at start + fade out
    Zoom,
    /// Very gentle long fade (0.8 s) — cinematic, professional
    Smooth,
    /// No transition — instant cut
    None,
}

impl std::fmt::Display for ClipStyleArg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            ClipStyleArg::Fade => "fade",
            ClipStyleArg::Flash => "flash",
            ClipStyleArg::Zoom => "zoom",
            ClipStyleArg::Smooth => "smooth",
            ClipStyleArg::None => "none",
        };
        write!(f, "{s}")
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "thoth",
    version,
    about = "Thoth — AI short-form video strategist: source, narrate, and edit viral clips",
    long_about = None
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    /// Emit newline-delimited ProgressEvent JSON on stdout (machine channel).
    /// Human TTY output on stderr is unchanged. Used by thoth-server workers.
    #[arg(long, global = true, default_value_t = false)]
    pub progress_json: bool,
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
    /// Analyze trending videos to generate a reusable style profile
    TrendAnalyze(TrendAnalyzeArgs),
    /// Manage dynamic vocabulary (word lists stored in Supabase)
    Vocab(VocabArgs),
    /// Generate thumbnails for previously rendered clips
    Thumbnail(ThumbnailArgs),
    /// Run scout content-sourcing commands (TypeScript, requires Node ≥24).
    ///
    /// Delegates to scout/cli.ts — all scout sub-commands and flags are passed
    /// through transparently.
    ///
    /// Examples:
    ///   thoth scout browser status
    ///   thoth scout discover --max-per 4 --hours 48 --tiktok
    ///   thoth scout run <url> --out set.json --per 2 --max 4
    ///   thoth scout validate <set.json>
    Scout(ScoutArgs),

    /// Run as a persistent warm worker: pull queued jobs from the SQLite queue
    /// and execute them in-process (models stay resident between jobs). Peer to
    /// `thoth-server` — they share only the SQLite DB, no parent/child link.
    Worker(WorkerArgs),

    /// Manage projects on the local thoth-server (create / list / select active).
    Project(ProjectArgs),

    /// Manage typed project profiles on the local thoth-server. Every mutable
    /// field is an explicit flag — no raw TOML, no generic `--set key=value`,
    /// and credential *reference names* only (never a secret value).
    Profile(ProfileArgs),

    /// Interactive wizard to create a project + profile with typed, non-default
    /// fields, or `--import` an existing config.toml (one-way migration).
    Configure(ConfigureArgs),
}

#[derive(clap::Args, Debug)]
pub struct ProjectArgs {
    #[command(subcommand)]
    pub command: ProjectCommand,
}

#[derive(Subcommand, Debug)]
pub enum ProjectCommand {
    /// Create a new project
    Create {
        /// Project name (unique)
        name: String,
    },
    /// List all projects
    List,
    /// Select the active project — used when `--project` is omitted elsewhere
    Use {
        /// Existing project name to make active
        name: String,
    },
}

#[derive(clap::Args, Debug)]
pub struct ProfileArgs {
    #[command(subcommand)]
    pub command: ProfileCommand,
}

#[derive(Subcommand, Debug)]
pub enum ProfileCommand {
    /// Create a new profile (seeded with server defaults)
    Create {
        /// Profile name
        name: String,
        /// Project name (falls back to the active project)
        #[arg(long)]
        project: Option<String>,
        /// Optional description
        #[arg(long, default_value = "")]
        description: String,
    },
    /// List profiles in a project
    List {
        /// Project name (falls back to the active project)
        #[arg(long)]
        project: Option<String>,
    },
    /// Show a profile's settings (secrets never shown — credential name only)
    Show {
        /// Profile name
        name: String,
        /// Project name (falls back to the active project)
        #[arg(long)]
        project: Option<String>,
    },
    /// Duplicate a profile under a new name
    Duplicate {
        /// Source profile name
        name: String,
        /// New profile name
        #[arg(long = "as")]
        new_name: String,
        /// Project name (falls back to the active project)
        #[arg(long)]
        project: Option<String>,
    },
    /// Update explicit typed fields on a profile (omitted flags stay unchanged)
    Set(ProfileSetArgs),
}

/// Explicit, typed per-field updates for `profile set`. Each `Option` left
/// `None` leaves the profile's existing value untouched. There is deliberately
/// no generic `--set key=value` — that would re-introduce raw config editing.
#[derive(clap::Args, Debug)]
pub struct ProfileSetArgs {
    /// Profile name to update
    pub name: String,
    /// Project name (falls back to the active project)
    #[arg(long)]
    pub project: Option<String>,

    // ── narration ──
    /// Transcription language code (e.g. "id", "en"); empty = auto
    #[arg(long)]
    pub language: Option<String>,

    // ── visual_edit ──
    /// Output aspect ratio / layout
    #[arg(long)]
    pub layout: Option<OutputLayout>,
    /// Clip transition style
    #[arg(long)]
    pub clip_style: Option<ClipStyleArg>,
    /// Named style profile ("auto" = LLM decides)
    #[arg(long)]
    pub style_profile: Option<String>,
    /// Social handle shown in the headline panel
    #[arg(long)]
    pub social: Option<String>,
    /// Background music volume (0.0–1.0)
    #[arg(long)]
    pub bgm_volume: Option<f32>,
    /// Headline panel duration in seconds
    #[arg(long)]
    pub headline_dur: Option<f64>,

    // ── analysis ──
    /// LLM provider for analysis
    #[arg(long)]
    pub provider: Option<LlmProviderName>,
    /// Whisper model size
    #[arg(long)]
    pub model: Option<WhisperModelSize>,
    /// Maximum number of viral clips
    #[arg(long)]
    pub max_clips: Option<usize>,
    /// Focus keywords (comma-separated)
    #[arg(long, value_delimiter = ',')]
    pub keywords: Option<Vec<String>>,

    // ── ingest_source ──
    /// Default source URL for runs
    #[arg(long)]
    pub source: Option<String>,
    /// Default content-set path for runs
    #[arg(long)]
    pub content_set: Option<String>,

    // ── credential (reference name only — never a secret value) ──
    /// Credential reference name (an env-var name resolved server-side)
    #[arg(long)]
    pub credential_ref: Option<String>,

    /// Free-text description
    #[arg(long)]
    pub description: Option<String>,
}

#[derive(clap::Args, Debug)]
pub struct ConfigureArgs {
    /// Import an existing config.toml into a project (one-way migration) instead
    /// of running the interactive wizard.
    #[arg(long)]
    pub import: bool,
}

#[derive(clap::Args, Debug)]
pub struct WorkerArgs {
    /// Path to the shared SQLite job database (same file `thoth-server` opens).
    #[arg(long, env = "THOTH_DB", default_value = "thoth.db")]
    pub db: String,
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
    #[arg(long, default_value = "novita")]
    pub provider: LlmProviderName,

    /// Maximum number of viral clips to find
    #[arg(long, default_value_t = 3)]
    pub max_clips: usize,

    /// [Optional override] Focus keywords — ketika di-set, ini MENJADI PRIORITAS
    /// di atas keyword yang diekstrak otomatis oleh LLM dari transcript.
    /// Format: comma-separated, e.g. "prabowo,dollar,AI".
    /// Biasanya TIDAK perlu diisi — LLM mengekstrak keyword secara otomatis.
    #[arg(long, value_delimiter = ',')]
    pub keywords: Vec<String>,

    /// Optional path to the source video file.
    /// When provided and [vision] enabled = true in config.toml, the analyze
    /// stage extracts frames and scores each candidate moment visually
    /// (humor, impact, novelty, engagement) before selecting the final clips.
    #[arg(long)]
    pub video_path: Option<PathBuf>,

    /// Video title (optional — stored as metadata in the RAG database).
    #[arg(long, default_value = "")]
    pub title: String,

    /// Channel / creator name (optional — stored as metadata in the RAG database).
    #[arg(long, default_value = "")]
    pub channel: String,
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

    /// Sound effect file played at the start of each clip (MP3, WAV, AAC, etc.)
    /// Mixed with the video audio for the first few seconds. e.g. --sfx ./sfx/whoosh.mp3
    #[arg(long)]
    pub sfx_intro: Option<std::path::PathBuf>,

    /// Background music file mixed under the clip voice at low volume (looped automatically)
    /// e.g. --bgm ./music/lofi-beat.mp3
    #[arg(long)]
    pub bgm: Option<std::path::PathBuf>,

    /// Background music volume (0.0–1.0, default 0.12 ≈ −18 dB)
    #[arg(long, default_value_t = 0.12)]
    pub bgm_volume: f32,

    /// Visual transition style applied at clip IN and OUT
    /// fade=black fade (default) | flash=white flash | zoom=Ken Burns | smooth=gentle | none
    #[arg(long, default_value = "fade")]
    pub clip_style: ClipStyleArg,

    /// Social media handle shown top-left of the headline panel (e.g. "@namaakun")
    #[arg(long, default_value = "")]
    pub social: String,

    /// Channel / creator name for the source credit in the headline panel
    #[arg(long, default_value = "")]
    pub source_channel: String,

    /// How many seconds to show the headline panel (default: 4.0)
    #[arg(long, default_value_t = 4.0)]
    pub headline_dur: f64,

    // ── Font settings ─────────────────────────────────────────────────────────
    /// Directory containing font files (default: "assets/fonts/")
    /// Poppins-Bold.ttf and Poppins-Regular.ttf are auto-downloaded if missing.
    #[arg(long, default_value = "assets/fonts")]
    pub font_dir: PathBuf,

    /// Bold font filename inside --font-dir for headlines and subtitles
    #[arg(long, default_value = "Poppins-Bold.ttf")]
    pub font_bold: String,

    /// Regular font filename inside --font-dir for source credit text
    #[arg(long, default_value = "Poppins-Regular.ttf")]
    pub font_regular: String,

    // ── Social icon ───────────────────────────────────────────────────────────
    /// PNG icon file to display at the top-left of the headline panel
    /// (replaces the @social_handle text). Default: none (text shown instead).
    #[arg(long)]
    pub social_icon: Option<PathBuf>,

    /// Display size of the social icon in pixels (must be within min/max range)
    #[arg(long, default_value_t = 48)]
    pub social_icon_size: u32,

    /// Minimum allowed icon display size in pixels
    #[arg(long, default_value_t = 16)]
    pub social_icon_min_size: u32,

    /// Maximum allowed icon display size in pixels
    #[arg(long, default_value_t = 128)]
    pub social_icon_max_size: u32,

    /// Apply a named style profile to all clips (defined in config.toml [styles.profiles]).
    /// Overrides LLM-picked subtitle_style, clip_style, sfx_vibe, bgm_vibe, overlay_style.
    /// "auto" = let LLM decide per-clip (default).
    #[arg(long, default_value = "auto")]
    pub style_profile: String,
}

#[derive(Parser, Debug)]
pub struct RunArgs {
    /// Single video URL to clip (default mode). Takes precedence over --content.
    /// Example: thoth run --url https://youtu.be/abc
    pub url: Option<String>,

    /// scout content set (JSON) supplying the main video + footage pool.
    /// Content discovery is handled upstream by scout; Thoth no longer
    /// searches. The file shape is:
    ///   { "main": { "url": "...", ... }, "footage": [ { "platform": "...", "url": "..." }, ... ] }
    /// The footage list is written to <output_dir>/content_enrichment.json for the
    /// edit/narration stages. Example: thoth run --content set.json
    #[arg(long)]
    pub content: Option<PathBuf>,

    /// Output directory for all job artifacts
    #[arg(short, long, default_value = "./output")]
    pub output_dir: PathBuf,

    /// LLM provider for analysis
    #[arg(long, default_value = "novita")]
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

    /// [Optional override] Focus keywords — ketika di-set, ini MENJADI PRIORITAS
    /// di atas keyword yang diekstrak otomatis oleh LLM dari transcript.
    /// Format: comma-separated, e.g. "prabowo,dollar,AI".
    /// Biasanya TIDAK perlu diisi — LLM mengekstrak keyword secara otomatis.
    #[arg(long, value_delimiter = ',')]
    pub keywords: Vec<String>,

    /// Sound effect file played at the start of each clip (MP3, WAV, AAC, etc.)
    /// e.g. --sfx ./sfx/vine-boom.mp3
    #[arg(long)]
    pub sfx_intro: Option<std::path::PathBuf>,

    /// Background music file mixed under the clip voice at low volume (looped automatically)
    /// e.g. --bgm ./music/lofi-beat.mp3
    #[arg(long)]
    pub bgm: Option<std::path::PathBuf>,

    /// Background music volume (0.0–1.0, default 0.12 ≈ −18 dB)
    #[arg(long, default_value_t = 0.12)]
    pub bgm_volume: f32,

    /// Visual transition style applied at clip IN and OUT
    /// fade=black fade (default) | flash=white flash | zoom=Ken Burns | smooth=gentle | none
    #[arg(long, default_value = "fade")]
    pub clip_style: ClipStyleArg,

    /// Social media handle shown top-left of the headline panel (e.g. "@namaakun")
    /// Auto-determined from the channel name if empty.
    #[arg(long, default_value = "")]
    pub social: String,

    /// How many seconds to show the headline panel (default: 4.0)
    #[arg(long, default_value_t = 4.0)]
    pub headline_dur: f64,

    // ── Font settings ─────────────────────────────────────────────────────────
    /// Directory containing font files (default: "assets/fonts/")
    #[arg(long, default_value = "assets/fonts")]
    pub font_dir: PathBuf,

    /// Bold font filename for headlines and subtitles
    #[arg(long, default_value = "Poppins-Bold.ttf")]
    pub font_bold: String,

    /// Regular font filename for source credit text
    #[arg(long, default_value = "Poppins-Regular.ttf")]
    pub font_regular: String,

    // ── Social icon ───────────────────────────────────────────────────────────
    /// PNG icon replacing the @social_handle text in the headline panel
    #[arg(long)]
    pub social_icon: Option<PathBuf>,

    /// Display size of the social icon in pixels
    #[arg(long, default_value_t = 48)]
    pub social_icon_size: u32,

    /// Minimum allowed icon display size in pixels
    #[arg(long, default_value_t = 16)]
    pub social_icon_min_size: u32,

    /// Maximum allowed icon display size in pixels
    #[arg(long, default_value_t = 128)]
    pub social_icon_max_size: u32,

    /// Resume a previous job by its ID (skips completed stages)
    #[arg(long)]
    pub resume: Option<String>,

    /// Apply a named style profile to all clips (defined in config.toml [styles.profiles]).
    /// Overrides per-clip LLM picks for subtitle_style, clip_style, sfx_vibe, bgm_vibe, overlay_style.
    #[arg(long, default_value = "auto")]
    pub style_profile: String,

    /// Use this exact job id and treat `--output-dir` as the job root directly
    /// (no `.thoth/<id>` wrapper). Set by the server worker so artifact paths
    /// are deterministic. Omit for CLI runs — a random id is generated + nested.
    #[arg(long)]
    pub job_id: Option<String>,
}

/// Arguments for the `trend-analyze` subcommand.
#[derive(Parser, Debug)]
pub struct TrendAnalyzeArgs {
    /// URL to download sample videos from.
    /// Examples:
    ///   TikTok hashtag: "https://www.tiktok.com/tag/suratirta"
    ///   YouTube search: "ytsearch5:trending shorts indonesia 2025"
    ///   Single video:   "https://www.youtube.com/watch?v=..."
    pub url: String,

    /// Number of videos to sample and analyze (default: 5)
    #[arg(long, default_value_t = 5)]
    pub sample: usize,

    /// Vision LLM provider for style analysis: gemini | openai | claude | vllm
    #[arg(long, default_value = "gemini")]
    pub provider: LlmProviderName,

    /// Name for the generated style profile (saved to config.toml and style_profiles/)
    #[arg(long)]
    pub output_profile: String,

    /// Directory to save downloaded sample clips and generated profile
    #[arg(long, default_value = "style_profiles")]
    pub output_dir: PathBuf,
}

/// Arguments for `thoth vocab` subcommands.
#[derive(Parser, Debug)]
pub struct VocabArgs {
    #[command(subcommand)]
    pub command: VocabCommand,
}

#[derive(Subcommand, Debug)]
pub enum VocabCommand {
    /// Add a word to a vocabulary category
    Add {
        /// Category: tone_funny | tone_serious | intro | name_titles | stop_words | energy_high | energy_low | vibe
        category: String,
        /// The word or phrase to add
        word: String,
        /// Subcategory (for vibe: impact|whoosh|ding|comedy|...; for stop_words: id|en)
        #[arg(long)]
        subcategory: Option<String>,
        /// Language: id | en | mixed
        #[arg(long, default_value = "id")]
        language: String,
        /// Optional note explaining why this word matters
        #[arg(long)]
        notes: Option<String>,
    },
    /// List all words in a category
    List {
        category: String,
    },
    /// Review auto-discovered word candidates (approve/reject)
    Review,
    /// Seed vocabulary into Supabase.
    ///
    /// Available sources:
    ///   defaults          — all hardcoded word lists (run once after SQL setup)
    ///   kamus-alay        — Indonesian slang dictionary (~3000 words)
    ///   openslr-stopwords — Indonesian stop words (~758 words)
    ///
    /// Or use --url to download from any direct file URL:
    ///   thoth vocab seed --url https://example.com/words.txt --category tone_funny
    ///
    /// Supported formats (auto-detected by extension or content):
    ///   .txt  — one word/phrase per line
    ///   .csv  — comma-separated, first column = word (second = translation/label)
    ///   .tsv  — tab-separated, same as csv
    ///   .json — JSON array of strings, OR array of {"word":..., "label":...} objects
    Seed {
        /// Built-in dataset: defaults | kamus-alay | openslr-stopwords
        #[arg(long, default_value = "defaults")]
        source: String,
        /// Download from any URL instead of a built-in dataset
        #[arg(long)]
        url: Option<String>,
        /// Target category for URL-seeded words (required when --url is used):
        /// tone_funny | tone_serious | intro | name_titles | stop_words | energy_high | energy_low | vibe
        #[arg(long)]
        category: Option<String>,
        /// Subcategory (e.g. vibe name like "impact", or stop_words language "id"/"en")
        #[arg(long)]
        subcategory: Option<String>,
        /// Language code for seeded words (default: "id")
        #[arg(long, default_value = "id")]
        language: String,
        /// Column index to use as the word (0-based, default 0). For CSV/TSV files.
        #[arg(long, default_value_t = 0)]
        column: usize,
        /// Skip header line in CSV/TSV files
        #[arg(long)]
        skip_header: bool,
        /// Label filter: only seed words where column[1] contains this string (CSV/TSV only)
        #[arg(long)]
        label_filter: Option<String>,
    },
    /// Refresh the in-memory vocabulary cache from Supabase
    Refresh,
    /// Show vocabulary statistics
    Stats,
}

/// Arguments for `thoth scout` — pass-through to scout/cli.ts (Bun).
///
/// Everything after `thoth scout` is forwarded verbatim to the TypeScript CLI:
///   thoth scout discover --max-per 4 --hours 48
///     → bun scout/cli.ts discover --max-per 4 --hours 48
#[derive(Parser, Debug)]
#[command(trailing_var_arg = true, allow_hyphen_values = true)]
pub struct ScoutArgs {
    /// Scout sub-command and its arguments (passed through to scout/cli.ts).
    ///
    /// Available: browser, discover, trending, run, comments, footage, figures,
    ///            enrich, images, validate, pulse, topics, news
    #[arg(trailing_var_arg = true)]
    pub args: Vec<String>,
}

#[derive(Parser, Debug)]
pub struct ThumbnailArgs {
    /// ID of the job containing the output clips
    pub job_id: String,

    /// Output directory where jobs are stored
    #[arg(short, long, default_value = "./output")]
    pub output_dir: PathBuf,
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
    /// Anthropic Claude — claude-sonnet-4-5 | claude-opus-4-5 | claude-haiku-3-5
    /// Set THOTH_CLAUDE_API_KEY and optionally claude_model in config.toml
    Claude,
    /// Google Gemini — gemini-2.0-flash | gemini-1.5-pro | gemini-2.5-pro
    /// Set THOTH_GEMINI_API_KEY. Free key: https://aistudio.google.com/apikey
    Gemini,
    /// Self-hosted vLLM server (OpenAI-compatible API)
    /// Set vllm_base_url and vllm_model in config.toml
    Vllm,
    Ollama,
    /// Novita AI — fast & cheap OpenAI-compatible inference
    /// Models: meta-llama/llama-3.3-70b-instruct, deepseek/deepseek-r1-turbo, etc.
    /// Set THOTH_NOVITA_API_KEY. Get key: https://novita.ai/settings#key-management
    Novita,
    /// Together AI — OpenAI-compatible, wide model selection
    /// Set THOTH_TOGETHER_API_KEY
    Together,
    /// Fireworks AI — OpenAI-compatible, fast open-source serving
    /// Set THOTH_FIREWORKS_API_KEY
    Fireworks,
}

impl std::fmt::Display for LlmProviderName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmProviderName::Groq   => write!(f, "groq"),
            LlmProviderName::Openai => write!(f, "openai"),
            LlmProviderName::Claude => write!(f, "claude"),
            LlmProviderName::Gemini => write!(f, "gemini"),
            LlmProviderName::Vllm      => write!(f, "vllm"),
            LlmProviderName::Ollama    => write!(f, "ollama"),
            LlmProviderName::Novita    => write!(f, "novita"),
            LlmProviderName::Together  => write!(f, "together"),
            LlmProviderName::Fireworks => write!(f, "fireworks"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_set_has_explicit_fields_not_generic_key_value() {
        // Every mutable field is an explicit, typed flag.
        assert!(
            Cli::try_parse_from([
                "thoth", "profile", "set", "Default", "--project", "Demo", "--layout", "vertical",
            ])
            .is_ok()
        );
        // No generic `--set key=value` escape hatch (that path re-invents raw TOML).
        assert!(Cli::try_parse_from(["thoth", "profile", "set", "Default", "--set", "x=y"]).is_err());
    }

    #[test]
    fn configure_wizard_command_parses() {
        assert!(Cli::try_parse_from(["thoth", "configure"]).is_ok());
    }

    #[test]
    fn project_and_profile_subcommands_parse() {
        assert!(Cli::try_parse_from(["thoth", "project", "create", "Demo"]).is_ok());
        assert!(Cli::try_parse_from(["thoth", "project", "list"]).is_ok());
        assert!(Cli::try_parse_from(["thoth", "project", "use", "Demo"]).is_ok());
        assert!(Cli::try_parse_from(["thoth", "profile", "list", "--project", "Demo"]).is_ok());
        assert!(
            Cli::try_parse_from(["thoth", "profile", "show", "Default", "--project", "Demo"]).is_ok()
        );
    }
}
