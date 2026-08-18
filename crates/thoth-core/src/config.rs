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
    /// News enrichment (Stage 4): keyword extraction + internet search + screenshot.
    #[serde(default)]
    pub news:      NewsConfig,
    /// Reaction generation (Stage 4): LLM script + TTS voice synthesis + avatar (Phase 4-6).
    #[serde(default)]
    pub reaction:  ReactionConfig,
    /// Giant multi-colour hook title (0–3 s scroll-stopper) — opt-in.
    #[serde(default)]
    pub hook_title: HookTitleConfig,
    /// AI cover/thumbnail intro (full-screen AI bg + subject cutout + headline)
    /// shown for the hook window before cutting to footage — opt-in.
    #[serde(default)]
    pub cover: CoverConfig,
    /// Beat-2 character intro: profile card + giant name above the head — opt-in.
    #[serde(default)]
    pub profile_card: ProfileCardConfig,
    /// Beat-3 number callouts: big figure + pointing arrow — opt-in.
    #[serde(default)]
    pub callout: CalloutConfig,
    /// Twitter/X integration: credentials + search config.
    #[serde(default)]
    pub twitter: TwitterConfig,
    /// Multi-platform content search (YouTube/TikTok/Twitter/IG/News).
    #[serde(default)]
    pub content_search: ContentSearchConfig,
    /// Montage composite mode: paper-grid canvas + footage cards + intercutting.
    #[serde(default, alias = "animelorian")]
    pub montage: MontageConfig,
    /// Narrator-driven video: one TTS narration becomes the audio spine + pacing.
    #[serde(default)]
    pub narration: NarrationConfig,
}

/// Narrator-driven mode. A single continuous narrator script (gossip-commentator
/// style) is synthesized to a voiceover (ElevenLabs → Edge fallback) and becomes
/// the video's audio SPINE: the edit is built around it, event audio ducked,
/// subtitles synced to the narration words. Opt-in. TTS provider/voice come from
/// `[reaction.tts]` (reused). When `enabled=false` the legacy event-audio edit runs.
#[derive(Debug, Deserialize, Clone)]
pub struct NarrationConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Target spoken length in seconds (LLM writes ~3 words/sec to fit).
    #[serde(default = "default_narr_target")]
    pub target_secs: u32,
    /// Narration language (BCP-47: "id" | "en").
    #[serde(default = "default_narr_lang")]
    pub language: String,
    /// Event (footage) audio volume while the narrator speaks (0.0–1.0).
    #[serde(default = "default_narr_duck")]
    pub duck_event_vol: f32,
    /// Event volume during narrator PAUSES — the event "breathes through" here
    /// (dynamic ducking). Should be > duck_event_vol.
    #[serde(default = "default_narr_leak")]
    pub leak_event_vol: f32,
    /// Lead-in seconds where the event audio plays LOUD before the narrator comes
    /// in (establishes the scene/vibe), then ducks. 0 = no lead-in.
    #[serde(default = "default_narr_leadin")]
    pub lead_in_secs: f64,
    /// Max extra YouTube videos from enrichment pool to fetch subtitles from
    /// and include as context for the narrator LLM. 0 = main video only.
    #[serde(default = "default_narr_enrich_src")]
    pub max_enrichment_sources: u32,
    /// Retrieve proven narration STRUCTURES from the `narration_structures`
    /// Supabase table (built by `scripts/narration/analyze_narration_structure.py`) and
    /// inject them as a reference block into the narrator prompt — so the script
    /// copies arcs/hooks/lessons that worked instead of hallucinating. Requires
    /// `THOTH_SUPABASE_URL` + a valid embed provider; degrades silently if
    /// unavailable. Independent of `[vector_db] enabled` (which is moments-RAG).
    #[serde(default = "default_narr_struct_rag")]
    pub structure_rag: bool,
    /// How many reference structures to retrieve + inject (default 4).
    #[serde(default = "default_narr_struct_rag_count")]
    pub structure_rag_count: u32,
    /// Minimum cosine similarity (0..1) to include a reference. Default 0.0 =
    /// always take the top-N closest (the corpus is curated good examples, so
    /// structural guidance matters more than strict topical match).
    #[serde(default = "default_narr_struct_rag_minsim")]
    pub structure_rag_min_similarity: f32,
    /// LLM model for the NARRATION script ONLY, overriding the active provider's
    /// `[llm]` model. Empty = use the `[llm]` model. Lets you use a creative model
    /// (e.g. deepseek-v4-flash — natural Indonesian prose) for narration while
    /// analyze keeps a model that's reliable at structured JSON extraction. The
    /// provider stays the one from `--provider`; only the model id changes.
    #[serde(default)]
    pub model: String,
}

impl Default for NarrationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            target_secs: default_narr_target(),
            language: default_narr_lang(),
            duck_event_vol: default_narr_duck(),
            leak_event_vol: default_narr_leak(),
            lead_in_secs: default_narr_leadin(),
            max_enrichment_sources: default_narr_enrich_src(),
            structure_rag: default_narr_struct_rag(),
            structure_rag_count: default_narr_struct_rag_count(),
            structure_rag_min_similarity: default_narr_struct_rag_minsim(),
            model: String::new(),
        }
    }
}

fn default_narr_target() -> u32    { 45 }
fn default_narr_lang()   -> String { "id".to_owned() }
fn default_narr_duck()   -> f32    { 0.12 }
fn default_narr_leak()   -> f32    { 0.45 }
fn default_narr_leadin()      -> f64 { 1.6 }
fn default_narr_enrich_src()  -> u32 { 3 }
fn default_narr_struct_rag()        -> bool { true }
fn default_narr_struct_rag_count()  -> u32  { 4 }
fn default_narr_struct_rag_minsim() -> f32  { 0.0 }

/// Montage "reaction montage" style — the signature look of the reference
/// channel. Instead of a full-frame clip, content sits as a centred footage CARD
/// on a crumpled black-paper canvas, and the video cuts between the main footage
/// and relevant enrichment footage (a montage). The hook (first clip) stays
/// full-frame and immersive. Opt-in; everything degrades to the legacy look when
/// `enabled = false`.
///
/// ```toml
/// [montage]
/// enabled            = true
/// paper_bg           = "assets/ui/Crumpled-Black-Paper-Stop-Motion-Anim.mp4"
/// footage_scale_pct  = 88
/// hook_fullscreen    = true
/// intercut           = true
/// intercut_segment_secs = 4.0
/// placement_variation  = true
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct MontageConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_anim_paper")]
    pub paper_bg: PathBuf,
    #[serde(default = "default_anim_scale")]
    pub footage_scale_pct: u32,
    #[serde(default = "default_anim_hook_fs")]
    pub hook_fullscreen: bool,
    #[serde(default = "default_anim_montage", alias = "montage")]
    pub intercut: bool,
    #[serde(default = "default_anim_seg", alias = "montage_segment_secs")]
    pub intercut_segment_secs: f64,
    #[serde(default = "default_anim_variation")]
    pub placement_variation: bool,
    /// Max DISTINCT footage cards shown per content clip (montage density). 1 = the
    /// single legacy cut; 2+ tiles extra relevant clips from the scout footage
    /// pool across the clip so the video keeps changing footage. Each extra cut is
    /// one more download, so keep it modest (2–3).
    #[serde(default = "default_anim_max_cuts", alias = "montage_max_cuts")]
    pub intercut_max_cuts: u32,
}

impl Default for MontageConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            paper_bg: default_anim_paper(),
            footage_scale_pct: default_anim_scale(),
            hook_fullscreen: default_anim_hook_fs(),
            intercut: default_anim_montage(),
            intercut_segment_secs: default_anim_seg(),
            placement_variation: default_anim_variation(),
            intercut_max_cuts: default_anim_max_cuts(),
        }
    }
}

fn default_anim_paper()     -> PathBuf { PathBuf::from("assets/ui/Crumpled-Black-Paper-Stop-Motion-Anim.mp4") }
fn default_anim_scale()     -> u32     { 88 }
fn default_anim_hook_fs()   -> bool    { true }
fn default_anim_montage()   -> bool    { true }
fn default_anim_seg()       -> f64     { 4.0 }
fn default_anim_variation() -> bool    { true }
fn default_anim_max_cuts()  -> u32     { 2 }

/// Multi-platform content search — drives `scripts/news/social_search.py` to find a
/// MAIN clippable video plus MULTIPLE relevant clips/screenshots for enrichment.
/// Used by `thoth run --query` and the trending auto-mode.
///
/// ```toml
/// [content_search]
/// enabled          = true
/// conda_env        = "thoth-news"
/// python_path      = "python"
/// script           = "scripts/news/social_search.py"
/// platforms        = "youtube,instagram,twitter,news"  # tiktok bot-blocked, opt-in only
/// engine           = "auto"      # auto | playwright | scrapling
/// max_per_platform = 6
/// timeout_secs     = 30
/// region           = "ID"
/// lang             = "id"
/// min_dur_sec      = 60
/// max_dur_sec      = 1200
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct ContentSearchConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_cs_conda")]
    pub conda_env: String,
    #[serde(default = "default_cs_python")]
    pub python_path: String,
    #[serde(default = "default_cs_script")]
    pub script: String,
    #[serde(default = "default_cs_platforms")]
    pub platforms: String,
    #[serde(default = "default_cs_engine")]
    pub engine: String,
    #[serde(default = "default_cs_max")]
    pub max_per_platform: usize,
    #[serde(default = "default_cs_timeout")]
    pub timeout_secs: u64,
    #[serde(default = "default_cs_region")]
    pub region: String,
    #[serde(default = "default_cs_lang")]
    pub lang: String,
    #[serde(default = "default_cs_min_dur")]
    pub min_dur_sec: u64,
    #[serde(default = "default_cs_max_dur")]
    pub max_dur_sec: u64,
    /// Expand the raw query into multiple LLM-generated search keywords before
    /// searching, casting a wider net for relevant footage (e.g. "kata asbun
    /// ghufron" → "ghufron viral", "ghufron ceramah", "MUI Malang ghufron").
    /// Builds a richer enrichment pool for narrator-driven rage-bait narration.
    #[serde(default = "default_cs_expand")]
    pub expand_keywords: bool,
}

impl Default for ContentSearchConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            conda_env: default_cs_conda(),
            python_path: default_cs_python(),
            script: default_cs_script(),
            platforms: default_cs_platforms(),
            engine: default_cs_engine(),
            max_per_platform: default_cs_max(),
            timeout_secs: default_cs_timeout(),
            region: default_cs_region(),
            lang: default_cs_lang(),
            min_dur_sec: default_cs_min_dur(),
            max_dur_sec: default_cs_max_dur(),
            expand_keywords: default_cs_expand(),
        }
    }
}

fn default_cs_conda()     -> String { "thoth-news".to_owned() }
fn default_cs_python()    -> String { "python".to_owned() }
fn default_cs_script()    -> String { "scripts/news/social_search.py".to_owned() }
// TikTok dropped from defaults: its search/hashtag endpoints are bot-blocked
// (EmptyResponseException) without paid residential proxies — verified manually
// and with the TikTokApi library. Still selectable via `platforms = "...,tiktok"`.
fn default_cs_platforms() -> String { "youtube,instagram,twitter,news".to_owned() }
fn default_cs_engine()    -> String { "auto".to_owned() }
fn default_cs_max()       -> usize  { 6 }
fn default_cs_timeout()   -> u64    { 30 }
fn default_cs_region()    -> String { "ID".to_owned() }
fn default_cs_lang()      -> String { "id".to_owned() }
fn default_cs_min_dur()   -> u64    { 60 }
fn default_cs_max_dur()   -> u64    { 10800 }  // up to 3h — long-form is clippable
fn default_cs_expand()    -> bool   { true }   // LLM keyword expansion before search

/// Twitter/X integration — used when `thoth run` is invoked without a URL or
/// `--query`, causing the pipeline to auto-pick the top trending topic from X.
///
/// ```toml
/// [twitter]
/// cookies_file        = "data/cookies.txt"     # Netscape format (Firefox/Chrome export)
/// max_trends          = 5                       # how many trends to retrieve
/// youtube_search_max  = 8                       # yt-dlp search candidates per trend
/// youtube_min_dur_sec = 60                      # ignore videos shorter than this
/// youtube_max_dur_sec = 1200                    # ignore videos longer than this
/// bearer_token        = ""                      # override public token if needed
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct TwitterConfig {
    /// Netscape cookies.txt exported from your browser for x.com.
    #[serde(default = "default_twitter_cookies")]
    pub cookies_file: std::path::PathBuf,
    /// How many trending topics to fetch.
    #[serde(default = "default_twitter_max_trends")]
    pub max_trends: usize,
    /// yt-dlp candidates per query.
    #[serde(default = "default_twitter_yt_max")]
    pub youtube_search_max: usize,
    /// Minimum video duration (seconds) for YouTube search results.
    #[serde(default = "default_twitter_min_dur")]
    pub youtube_min_dur_sec: u64,
    /// Maximum video duration (seconds) for YouTube search results.
    #[serde(default = "default_twitter_max_dur")]
    pub youtube_max_dur_sec: u64,
    /// Override the public bearer token (leave empty to use built-in).
    #[serde(default)]
    pub bearer_token: String,
}

impl Default for TwitterConfig {
    fn default() -> Self {
        Self {
            cookies_file:       default_twitter_cookies(),
            max_trends:         default_twitter_max_trends(),
            youtube_search_max: default_twitter_yt_max(),
            youtube_min_dur_sec: default_twitter_min_dur(),
            youtube_max_dur_sec: default_twitter_max_dur(),
            bearer_token:       String::new(),
        }
    }
}

fn default_twitter_cookies()    -> std::path::PathBuf { std::path::PathBuf::from("data/cookies.txt") }
fn default_twitter_max_trends() -> usize { 5 }
fn default_twitter_yt_max()     -> usize { 8 }
fn default_twitter_min_dur()    -> u64   { 60 }
fn default_twitter_max_dur()    -> u64   { 1200 }

/// Beat-3 number callouts (figure box + arrow). Opt-in. The LLM fills the
/// `callouts` array per moment (text, timing, position, direction); this config
/// only controls global styling and the on/off switch.
///
/// ```toml
/// [callout]
/// enabled      = true
/// accent       = "#FF3B5C"
/// font         = "Arial Bold"
/// max_per_clip = 3
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct CalloutConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_callout_accent")]
    pub accent: String,
    #[serde(default = "default_callout_font")]
    pub font: String,
    #[serde(default = "default_callout_max")]
    pub max_per_clip: usize,
}

impl Default for CalloutConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            accent: default_callout_accent(),
            font: default_callout_font(),
            max_per_clip: default_callout_max(),
        }
    }
}

fn default_callout_accent() -> String { "#FF3B5C".to_owned() }
fn default_callout_font()   -> String { "Arial Bold".to_owned() }
fn default_callout_max()    -> usize  { 3 }

/// Beat-2 character intro overlay (profile card + name above the head). Opt-in.
/// Driven by the LLM's `character_name`/`character_handle`/`character_stats`.
///
/// ```toml
/// [profile_card]
/// enabled         = true
/// at_sec          = 3.0      # appears this many seconds into the clip
/// duration_sec    = 3.0
/// position        = "lower"  # center | upper | lower
/// accent          = "#FF3B5C"
/// font            = "Arial Bold"
/// name_above_head = true
/// show_card       = true
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct ProfileCardConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_profile_at")]
    pub at_sec: f64,
    #[serde(default = "default_profile_dur")]
    pub duration_sec: f64,
    #[serde(default = "default_profile_position")]
    pub position: String,
    #[serde(default = "default_profile_accent")]
    pub accent: String,
    #[serde(default = "default_profile_font")]
    pub font: String,
    #[serde(default)] // default false — the giant name banner above the head is distracting
    pub name_above_head: bool,
    #[serde(default = "default_true")]
    pub show_card: bool,
}

impl Default for ProfileCardConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            at_sec: default_profile_at(),
            duration_sec: default_profile_dur(),
            position: default_profile_position(),
            accent: default_profile_accent(),
            font: default_profile_font(),
            name_above_head: false,
            show_card: true,
        }
    }
}

fn default_profile_at()       -> f64    { 3.0 }
fn default_profile_dur()      -> f64    { 3.0 }
fn default_profile_position() -> String { "lower".to_owned() }
fn default_profile_accent()   -> String { "#FF3B5C".to_owned() }
fn default_profile_font()     -> String { "Arial Bold".to_owned() }

/// Giant multi-colour per-word hook title shown in the upper third for the first
/// few seconds — the signature Indonesian reaction-news look. Opt-in (`enabled`).
///
/// ```toml
/// [hook_title]
/// enabled     = true
/// duration_sec = 3.0
/// palette     = ["#3DDC4A", "#FFE34D", "#3FC1FF", "#FFFFFF"]
/// font        = "Montserrat ExtraBold"   # ASS family name
/// fontsize    = 100
/// outline_px  = 6
/// margin_v    = 360                       # distance from top (alignment 8)
/// animate     = true                      # pop scale-in bounce
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct HookTitleConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_hook_duration")]
    pub duration_sec: f64,
    #[serde(default = "default_hook_palette")]
    pub palette: Vec<String>,
    #[serde(default = "default_hook_font")]
    pub font: String,
    #[serde(default = "default_hook_fontsize")]
    pub fontsize: u32,
    #[serde(default = "default_hook_outline")]
    pub outline_px: u32,
    /// ASS numpad alignment (1–9). 8 = top-centre, 2 = bottom-centre (lower-middle),
    /// 5 = middle-centre. Default 2 = the viral-template lower-middle block.
    #[serde(default = "default_hook_align")]
    pub align: u32,
    #[serde(default = "default_hook_marginv")]
    pub margin_v: u32,
    /// "per_line" = colour each whole line, alternating through the palette
    /// (white/yellow template look). "per_word" = legacy per-word rainbow cycle.
    #[serde(default = "default_hook_color_mode")]
    pub color_mode: String,
    #[serde(default = "default_true")]
    pub animate: bool,

    // ── PNG renderer (Pillow) — higher fidelity than libass ───────────────────
    /// "python" = render the headline as a PNG via scripts/render/render_headline.py
    /// (Pillow: thick stroke, drop-shadow, crisp AA) then overlay it. "ass" =
    /// legacy libass burn. Falls back to "ass" automatically if Python fails.
    #[serde(default = "default_hook_engine")]
    pub engine: String,
    /// TTF/OTF file for the PNG renderer (Pillow needs a file, not a family name).
    #[serde(default = "default_hook_font_file")]
    pub font_file: String,
    /// Black stroke thickness in px (PNG renderer).
    #[serde(default = "default_hook_stroke")]
    pub stroke_width: u32,
    /// Text alignment for the PNG renderer: "left" (template look) | "center".
    #[serde(default = "default_hook_text_align")]
    pub text_align: String,
    /// Left margin in px when `text_align = "left"`.
    #[serde(default = "default_hook_margin_l")]
    pub margin_l: u32,
    /// Line spacing as a multiple of the font size (≈1.0 = tight stacked look).
    #[serde(default = "default_hook_line_spacing")]
    pub line_spacing: f32,
    /// Drop-shadow vertical offset in px (PNG renderer). 0 = no shadow.
    #[serde(default = "default_hook_shadow_dy")]
    pub shadow_dy: i32,
    /// Drop-shadow gaussian blur radius in px (PNG renderer).
    #[serde(default = "default_hook_shadow_blur")]
    pub shadow_blur: f32,
    /// Drop-shadow opacity 0–255 (PNG renderer). 0 = no shadow.
    #[serde(default = "default_hook_shadow_alpha")]
    pub shadow_alpha: u32,
}

impl Default for HookTitleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            duration_sec: default_hook_duration(),
            palette: default_hook_palette(),
            font: default_hook_font(),
            fontsize: default_hook_fontsize(),
            outline_px: default_hook_outline(),
            align: default_hook_align(),
            margin_v: default_hook_marginv(),
            color_mode: default_hook_color_mode(),
            animate: true,
            engine: default_hook_engine(),
            font_file: default_hook_font_file(),
            stroke_width: default_hook_stroke(),
            text_align: default_hook_text_align(),
            margin_l: default_hook_margin_l(),
            line_spacing: default_hook_line_spacing(),
            shadow_dy: default_hook_shadow_dy(),
            shadow_blur: default_hook_shadow_blur(),
            shadow_alpha: default_hook_shadow_alpha(),
        }
    }
}

fn default_hook_duration() -> f64 { 3.0 }
// Viral-template palette: white + golden-yellow, alternated per line.
fn default_hook_palette() -> Vec<String> {
    vec!["#FFFFFF".into(), "#FFD60A".into()]
}
fn default_hook_font()       -> String { "Montserrat ExtraBold".to_owned() }
fn default_hook_fontsize()   -> u32    { 100 }
fn default_hook_outline()    -> u32    { 8 }
fn default_hook_align()      -> u32    { 2 }     // bottom-centre → lower-middle block
fn default_hook_marginv()    -> u32    { 380 }   // distance from the BOTTOM (align 2)
fn default_hook_color_mode() -> String { "per_line".to_owned() }
fn default_hook_engine()     -> String { "python".to_owned() }
fn default_hook_font_file()  -> String { "assets/fonts/Montserrat-ExtraBold.ttf".to_owned() }
fn default_hook_stroke()     -> u32    { 13 }
fn default_hook_shadow_dy()  -> i32    { 12 }
fn default_hook_shadow_blur()-> f32    { 10.0 }
fn default_hook_shadow_alpha()-> u32   { 170 }
fn default_hook_text_align() -> String { "left".to_owned() }
fn default_hook_margin_l()   -> u32    { 56 }
fn default_hook_line_spacing()-> f32   { 1.0 }

/// AI cover/thumbnail intro. At the hook window (clip start) a full-screen cover
/// is shown — AI background (Novita FLUX.1 schnell) + subject cutout (rembg) +
/// the headline text — then it dissolves into the footage. Reuses the Novita key
/// (`THOTH_NOVITA_API_KEY`) and `scripts/render/render_cover.py`. Opt-in; best-effort
/// (degrades to the normal hook title if Python/Novita/rembg fail).
///
/// ```toml
/// [cover]
/// enabled       = true
/// duration_sec  = 3.0
/// subject       = true            # cut out the person via rembg
/// prompt_suffix = "dramatic cinematic ..., no text, no watermark"
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct CoverConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_cover_duration")]
    pub duration_sec: f64,
    /// Cut out the subject (person) from a video frame and paste it over the bg.
    /// Only used when `subject_mode = "cutout"`.
    #[serde(default = "default_true")]
    pub subject: bool,
    /// "auto" = use the real cutout when it reads clearly, else generate an AI
    /// subject (recommended). "cutout" = always cut the real subject from a video
    /// frame (needs a clear/bright frame). "ai" = always let FLUX generate a
    /// dominant full-screen subject (template-like, but synthetic).
    #[serde(default = "default_cover_subject_mode")]
    pub subject_mode: String,
    /// rembg model: "u2net_human_seg" (people) | "birefnet-portrait" | "u2net".
    #[serde(default = "default_cover_rembg")]
    pub rembg_model: String,
    /// Subject height as a fraction of the canvas height.
    #[serde(default = "default_cover_subject_scale")]
    pub subject_scale: f32,
    /// Dark-gradient strength (0–1) applied over the bg for text contrast.
    #[serde(default = "default_cover_darken")]
    pub darken: f32,
    /// FLUX generation size (upscaled+cropped to the canvas). Keep ≈9:16.
    #[serde(default = "default_cover_bg_w")]
    pub bg_width: u32,
    #[serde(default = "default_cover_bg_h")]
    pub bg_height: u32,
    /// FLUX inference steps (schnell: 4 is ideal).
    #[serde(default = "default_cover_steps")]
    pub steps: u32,
    /// Appended to the headline to steer the background style. English works best.
    #[serde(default = "default_cover_prompt_suffix")]
    pub prompt_suffix: String,
    /// Ask the LLM (Novita chat) to convert the headline into a vivid ENGLISH
    /// scene prompt before generating the background. Off → use the raw headline.
    #[serde(default = "default_true")]
    pub prompt_translate: bool,
    /// Seconds at the clip's start to grab the subject frame from (0 = first frame).
    #[serde(default = "default_cover_subject_at")]
    pub subject_at_sec: f64,
    /// Swap the REAL subject's face onto the AI-generated subject (ai mode) for likeness. Face sourced
    /// from an internet reference photo (Wikipedia) of `character_name`, else the video frame.
    #[serde(default = "default_true")]
    pub face_swap: bool,
    /// Cover image backend: "flux" (Novita FLUX text2img + face-swap, default) | "openrouter" (an
    /// image-OUTPUT model like openai/gpt-5-image that natively preserves the subject's identity from
    /// reference photos — needs THOTH_OPENROUTER_API_KEY; falls back to flux if unavailable).
    #[serde(default = "default_cover_image_engine")]
    pub image_engine: String,
    /// OpenRouter image-output model id (used when image_engine="openrouter").
    #[serde(default = "default_cover_image_model")]
    pub image_model: String,
}

impl Default for CoverConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            duration_sec: default_cover_duration(),
            subject: true,
            subject_mode: default_cover_subject_mode(),
            rembg_model: default_cover_rembg(),
            subject_scale: default_cover_subject_scale(),
            darken: default_cover_darken(),
            bg_width: default_cover_bg_w(),
            bg_height: default_cover_bg_h(),
            steps: default_cover_steps(),
            prompt_suffix: default_cover_prompt_suffix(),
            prompt_translate: true,
            subject_at_sec: default_cover_subject_at(),
            face_swap: default_true(),
            image_engine: default_cover_image_engine(),
            image_model: default_cover_image_model(),
        }
    }
}

fn default_cover_duration()      -> f64 { 3.0 }
fn default_cover_rembg()         -> String { "u2net_human_seg".to_owned() }
fn default_cover_subject_mode()  -> String { "auto".to_owned() }
fn default_cover_subject_scale() -> f32 { 1.02 }  // fill full height → subject dominates
fn default_cover_darken()        -> f32 { 0.32 }
fn default_cover_bg_w()          -> u32 { 864 }
fn default_cover_bg_h()          -> u32 { 1536 }
fn default_cover_steps()         -> u32 { 4 }
fn default_cover_subject_at()    -> f64 { 1.0 }
fn default_cover_image_engine()  -> String { "flux".into() }
fn default_cover_image_model()   -> String { "google/gemini-2.5-flash-image".into() }
fn default_cover_prompt_suffix() -> String {
    "empty scene with no people, dramatic cinematic poster background, moody dark lighting, \
     high contrast, bokeh, depth of field, viral youtube thumbnail backdrop, photorealistic, \
     no people, no person, no human figures, no text, no watermark, no caption".to_owned()
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

    // ── OpenRouter (cloud, OpenAI-compatible) ───────────────────────────
    #[serde(skip)]
    pub openrouter_api_key: String,

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

    /// Annotated asset catalog produced by `scripts/media/annotate_assets.py`.
    /// When present, the analyze stage feeds it to the LLM so it can place
    /// timestamped `asset_cues` (SFX + meme videos). Missing file = feature off.
    #[serde(default = "default_asset_catalog")]
    pub catalog_path: PathBuf,

    /// In narrator-driven mode, let the LLM place reaction memes (video PiP) at
    /// narration beats matching the spoken emotion. Default true.
    #[serde(default = "default_true")]
    pub memes_in_narration: bool,
    /// Max reaction memes per narrated video.
    #[serde(default = "default_narration_max_memes")]
    pub narration_max_memes: u32,
    /// Show reaction memes FULL-SCREEN (cutaway, whole meme over a blurred fill)
    /// instead of a small corner PiP. The subtitle still burns on top. Default true.
    #[serde(default = "default_true")]
    pub meme_fullscreen: bool,

    /// In narrator-driven mode, let the LLM place reaction SFX (impact / whoosh /
    /// riser / notification) at the narration's emotional & transition beats — the
    /// SFX analogue of `memes_in_narration`. Default true.
    #[serde(default = "default_true")]
    pub sfx_in_narration: bool,
    /// Max LLM-placed reaction SFX per narrated video.
    #[serde(default = "default_narration_max_sfx")]
    pub narration_max_sfx: u32,
}

fn default_narration_max_memes() -> u32 { 3 }
fn default_narration_max_sfx() -> u32 { 4 }

fn default_sfx_dir() -> PathBuf { PathBuf::from("assets/sfx") }
fn default_bgm_dir() -> PathBuf { PathBuf::from("assets/bgm") }
fn default_asset_catalog() -> PathBuf { PathBuf::from("assets/asset_catalog.json") }
fn default_embed_provider() -> String { "gemini".to_owned() }
fn default_true() -> bool { true }

// ── Vector DB / RAG config ────────────────────────────────────────────────────

/// Configuration for Supabase PostgreSQL + pgvector long-term memory.
///
/// When `enabled = true`, Thoth:
/// 1. Retrieves similar past viral moments BEFORE LLM analysis → injects as examples
/// 2. Stores finalized moments AFTER analysis → builds library over time
///
/// Connection URI is loaded exclusively from `THOTH_SUPABASE_URL` env var.
/// Embeddings use Gemini `text-embedding-004` (free tier, 768 dims).
#[derive(Debug, Deserialize, Clone)]
pub struct VectorDbConfig {
    /// Enable Vector DB + RAG (default: false — requires THOTH_SUPABASE_URL).
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
    ///   Requires THOTH_GEMINI_API_KEY.
    /// - "openai": Gunakan endpoint OpenAI-compatible — cocok untuk Novita AI,
    ///   Together AI, OpenAI, dll. Set `embed_base_url` dan `embed_model`.
    ///   Requires THOTH_EMBED_API_KEY (atau fallback ke THOTH_OPENAI_API_KEY).
    /// - "vllm": Server vLLM self-hosted dengan model embedding (e.g. Qwen3-Embedding).
    ///   Requires `embed_base_url` dan opsional THOTH_VLLM_API_KEY.
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
    /// Diisi dari env var THOTH_EMBED_API_KEY.
    /// Jika kosong, fallback ke THOTH_OPENAI_API_KEY (untuk provider "openai"),
    /// THOTH_GEMINI_API_KEY (untuk "gemini"), atau THOTH_VLLM_API_KEY (untuk "vllm").
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
    /// Minimum cosine similarity (footage `description` ↔ narration-window text) required to PLACE a
    /// footage cutaway/image-card in a montage window. Below this, the slot is left empty so the main
    /// clip shows instead of forcing a weakly-related (often off-topic) cutaway. 0.0 disables the floor.
    #[serde(default = "default_placement_min_similarity")]
    pub placement_min_similarity: f32,
}

fn default_placement_min_similarity() -> f32 { 0.46 }

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
    /// Model vision di Novita AI, e.g. "qwen/qwen3-vl-235b-a22b-instruct"
    #[serde(default)]
    pub novita_model: String,

    /// Base URL untuk OpenRouter vision (cloud, OpenAI-compatible).
    /// Default "https://openrouter.ai/api". Dipakai saat provider = "openrouter".
    #[serde(default)]
    pub openrouter_base_url: String,
    /// Model vision di OpenRouter, e.g. "qwen/qwen-2.5-vl-72b-instruct".
    /// WAJIB diisi di config.toml — tak ada default (id model OpenRouter beragam).
    #[serde(default)]
    pub openrouter_model: String,

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

    /// Max concurrent vision API calls during analyze (moment scoring + full-video description).
    /// The analyze stage otherwise probes moments/frames one-by-one; this bounds how many run at
    /// once. Kept LOW on purpose — vision providers rate-limit (RPM/TPM), and unbounded fan-out
    /// trips 429s that are slower than serial. Default 4. Raise for high-limit providers; lower to
    /// 1–2 if you see rate-limit errors. 0 is treated as 1.
    #[serde(default)]
    pub concurrency: usize,
}

// ── News enrichment config (Stage 4) ──────────────────────────────────────────

/// Configuration for the News enrichment stage.
///
/// When `enabled = true`, the pipeline (Stage 4) extracts search keywords from
/// each viral moment's transcript window via the LLM, searches the internet for
/// relevant Indonesian news, optionally screenshots the article pages, and makes
/// the results available to the edit stage as visual context overlays.
///
/// **Keyword source:** keywords are extracted from the RAW transcript text spoken
/// during the moment — NOT from the LLM-paraphrased `title`/`reason` fields. The
/// transcript reflects what was actually said, which yields more accurate news hits.
///
/// Internet search is performed by an external Python + Playwright script
/// (`search_script`) so no paid search API key is required. A `serper` provider
/// is also supported as a fallback when `SERPER_API_KEY` is configured.
#[derive(Debug, Deserialize, Clone)]
pub struct NewsConfig {
    /// Enable the News enrichment stage (default: false — opt-in).
    #[serde(default)]
    pub enabled: bool,

    /// Search backend: "playwright" (default, Python script, no key) | "serper".
    #[serde(default = "default_news_provider")]
    pub provider: String,

    /// Conda environment name for running Python scripts.
    ///
    /// When non-empty, scripts are run via `conda run -n <conda_env> python <script>`.
    /// When empty, `python_path` is used directly.
    /// Default: "thoth-news" (created by scripts/setup_thoth_news.bat).
    #[serde(default = "default_conda_env")]
    pub conda_env: String,

    /// Python interpreter used when `conda_env` is empty.
    #[serde(default = "default_python_path")]
    pub python_path: String,

    /// Path to the Playwright news search script.
    #[serde(default = "default_news_search_script")]
    pub search_script: PathBuf,

    /// Path to the Playwright screenshot script.
    #[serde(default = "default_news_screenshot_script")]
    pub screenshot_script: PathBuf,

    /// Serper.dev API key (provider = "serper"). Loaded from env: THOTH_SERPER_API_KEY.
    #[serde(skip)]
    pub serper_api_key: String,

    /// Maximum number of news articles kept per moment (after ranking).
    #[serde(default = "default_news_max_results")]
    pub max_results_per_moment: usize,

    /// Maximum number of search keywords to extract per moment.
    #[serde(default = "default_news_max_keywords")]
    pub max_keywords: usize,

    /// Minimum relevance score (0.0–1.0) for an article to be kept.
    #[serde(default = "default_news_relevance")]
    pub relevance_threshold: f32,

    /// Drop articles older than this many days (0 = no age filter).
    #[serde(default = "default_news_max_age")]
    pub max_age_days: u32,

    /// Google region/country code for the search (e.g. "ID").
    #[serde(default = "default_news_region")]
    pub region: String,

    /// Search UI language code (e.g. "id").
    #[serde(default = "default_news_language")]
    pub language: String,

    /// Headless browser timeout in seconds for search + screenshot.
    #[serde(default = "default_news_timeout")]
    pub screenshot_timeout_secs: u64,

    /// Screenshot capture width in pixels (before 9:16 formatting).
    #[serde(default = "default_news_ss_width")]
    pub screenshot_width_px: u32,

    /// How long (seconds) the news screenshot is shown inside a clip.
    #[serde(default = "default_news_display_dur")]
    pub display_duration_secs: f64,

    /// When (seconds from clip start) the news screenshot appears.
    #[serde(default = "default_news_display_start")]
    pub display_start_sec: f64,

    /// Preferred news domains, ranked higher (empty = no preference).
    #[serde(default)]
    pub preferred_sources: Vec<String>,

    /// Directory (relative to job root) for caching news screenshots.
    #[serde(default = "default_news_cache_dir")]
    pub cache_dir: PathBuf,

    /// Path to a Netscape-format cookies.txt file exported from Firefox/Chrome.
    ///
    /// When set, cookies are injected into the Playwright browser context before
    /// every request, bypassing bot detection and paywalls on sites like Kumparan.
    ///
    /// Export via "Get cookies.txt LOCALLY" extension (Firefox/Chrome).
    /// Treat as a secret — never commit to git.
    #[serde(default)]
    pub cookies_file: PathBuf,
}

fn default_news_provider()          -> String  { "playwright".to_owned() }
fn default_conda_env()              -> String  { "thoth-news".to_owned() }
fn default_python_path()            -> String  { "python".to_owned() }
fn default_news_search_script()     -> PathBuf { PathBuf::from("scripts/news/news_search.py") }
fn default_news_screenshot_script() -> PathBuf { PathBuf::from("scripts/news/news_screenshot.py") }
fn default_news_max_results()   -> usize   { 3 }
fn default_news_max_keywords()  -> usize   { 5 }
fn default_news_relevance()     -> f32     { 0.5 }
fn default_news_max_age()       -> u32     { 14 }
fn default_news_region()        -> String  { "ID".to_owned() }
fn default_news_language()      -> String  { "id".to_owned() }
fn default_news_timeout()       -> u64     { 20 }
fn default_news_ss_width()      -> u32     { 1200 }
fn default_news_display_dur()   -> f64     { 4.0 }
fn default_news_display_start() -> f64     { 2.0 }
fn default_news_cache_dir()     -> PathBuf { PathBuf::from("news_cache") }

impl Default for NewsConfig {
    fn default() -> Self {
        Self {
            enabled:                false,
            provider:               default_news_provider(),
            conda_env:              default_conda_env(),
            python_path:            default_python_path(),
            search_script:          default_news_search_script(),
            screenshot_script:      default_news_screenshot_script(),
            serper_api_key:         String::new(),
            max_results_per_moment: default_news_max_results(),
            max_keywords:           default_news_max_keywords(),
            relevance_threshold:    default_news_relevance(),
            max_age_days:           default_news_max_age(),
            region:                 default_news_region(),
            language:               default_news_language(),
            screenshot_timeout_secs: default_news_timeout(),
            screenshot_width_px:    default_news_ss_width(),
            display_duration_secs:  default_news_display_dur(),
            display_start_sec:      default_news_display_start(),
            preferred_sources:      Vec::new(),
            cache_dir:              default_news_cache_dir(),
            cookies_file:           PathBuf::new(),
        }
    }
}

// ── Reaction / TTS / Avatar config (Stage 4 Phase 4-6) ────────────────────────

/// TTS provider configuration.
///
/// Supported providers:
///   - `"edge"`       — Microsoft Edge TTS (free, no key, good Indonesian)
///   - `"minimax"`    — MiniMax Speech 2.8 HD Sync (high quality, requires API key)
///   - `"fish_audio"` — Fish Audio S2 Pro (very natural, requires API key)
///   - `"openai"`     — OpenAI TTS (good quality, uses llm.openai_api_key)
///   - `"elevenlabs"` — ElevenLabs (best quality, highest cost)
///   - `"none"`       — Disable TTS (avatar segment will have no audio)
#[derive(Debug, Deserialize, Clone)]
pub struct TtsConfig {
    /// Active TTS provider (see doc above).
    #[serde(default = "default_tts_provider")]
    pub provider: String,

    // ── Edge TTS (free) ───────────────────────────────────────────────────────
    /// Microsoft Edge TTS voice. Indonesian: "id-ID-ArdiNeural" (M) | "id-ID-GadisNeural" (F)
    #[serde(default = "default_edge_voice")]
    pub edge_voice: String,

    // ── MiniMax Speech 2.8 HD Sync ────────────────────────────────────────────
    /// MiniMax TTS model. Recommended: "speech-02-hd" (HD quality, synchronous).
    /// Other options: "speech-02-turbo" (faster), "speech-2.6-hd", "speech-2.6-turbo"
    #[serde(default = "default_minimax_model")]
    pub minimax_model: String,

    /// MiniMax voice ID. See https://platform.minimaxi.com/document/voice-list
    /// Indonesian voices: "Indonesian_Female_XiuLan" | "Indonesian_Male_Ardi"
    /// General (works for Indonesian): "Friendly_Person" | "Energetic_Female"
    #[serde(default = "default_minimax_voice_id")]
    pub minimax_voice_id: String,

    /// MiniMax speech speed (0.5–2.0, default 1.0). Slightly faster (1.1) for
    /// energetic reaction content.
    #[serde(default = "default_minimax_speed")]
    pub minimax_speed: f32,

    /// MiniMax emotion hint: "happy" | "excited" | "neutral" | "sad" | "angry"
    #[serde(default = "default_minimax_emotion")]
    pub minimax_emotion: String,

    /// MiniMax Group ID — from the API Dashboard. Required in the API URL.
    /// Loaded from env: THOTH_MINIMAX_GROUP_ID
    #[serde(skip)]
    pub minimax_group_id: String,

    /// MiniMax API key. Loaded from env: THOTH_MINIMAX_API_KEY
    #[serde(skip)]
    pub minimax_api_key: String,

    // ── Fish Audio S2 Pro ─────────────────────────────────────────────────────
    /// Fish Audio model. "s2-pro" (S2 Pro, highest quality) | "s1" (S1, faster).
    #[serde(default = "default_fish_audio_model")]
    pub fish_audio_model: String,

    /// Fish Audio voice reference ID (optional).
    /// Use a preset voice ID from Fish Audio's voice library, or leave empty
    /// to use the default voice. For voice cloning, use your uploaded voice ID.
    /// Example Indonesian preset: "4b58a3082e7f4ef7b8726dad6a0e1a0a"
    #[serde(default)]
    pub fish_audio_reference_id: String,

    /// Fish Audio API key. Loaded from env: THOTH_FISH_AUDIO_API_KEY
    #[serde(skip)]
    pub fish_audio_api_key: String,

    // ── ElevenLabs ────────────────────────────────────────────────────────────
    /// ElevenLabs voice ID. From THOTH_ELEVENLABS_API_KEY.
    #[serde(default)]
    pub elevenlabs_voice_id: String,
    /// ElevenLabs model (default: eleven_multilingual_v2).
    #[serde(default = "default_elevenlabs_model")]
    pub elevenlabs_model: String,
    #[serde(skip)]
    pub elevenlabs_api_key: String,

    // ── OpenAI TTS ────────────────────────────────────────────────────────────
    /// OpenAI TTS voice. Uses llm.openai_api_key.
    #[serde(default = "default_openai_tts_voice")]
    pub openai_voice: String,
    /// OpenAI TTS model (default: tts-1-hd).
    #[serde(default = "default_openai_tts_model")]
    pub openai_model: String,
}

/// Avatar mode for the reaction segment.
#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AvatarMode {
    /// No avatar — voice-over only.
    None,
    /// Static PNG displayed in a PiP corner (no lip-sync).
    StaticImage,
    /// SadTalker — local GPU talking head, 1 photo + audio → lip-synced video.
    /// Requires SadTalker installed (scripts/setup_sadtalker.bat).
    SadTalker,
    /// D-ID talking avatar API.
    Did,
    /// HeyGen talking avatar API.
    Heygen,
}

impl Default for AvatarMode {
    fn default() -> Self { AvatarMode::None }
}

/// Avatar configuration.
#[derive(Debug, Deserialize, Clone)]
pub struct AvatarConfig {
    /// Avatar rendering mode.
    #[serde(default)]
    pub mode: AvatarMode,

    /// Path to the avatar PNG image (StaticImage and SadTalker modes).
    /// For SadTalker: a clear front-facing portrait photo works best.
    #[serde(default)]
    pub image_path: PathBuf,

    // ── SadTalker (local GPU talking avatar) ─────────────────────────────────

    /// Path to the SadTalker repository root (cloned via setup_sadtalker.bat).
    /// Example: "C:/tools/SadTalker"
    #[serde(default = "default_sadtalker_dir")]
    pub sadtalker_dir: PathBuf,

    /// Conda environment name for SadTalker (created by setup_sadtalker.bat).
    #[serde(default = "default_sadtalker_env")]
    pub sadtalker_env: String,

    /// Face image resolution for SadTalker: 256 (faster) or 512 (higher quality).
    #[serde(default = "default_sadtalker_size")]
    pub sadtalker_size: u32,

    /// Enable "still mode" — reduces head movement for a more static talking head.
    #[serde(default)]
    pub sadtalker_still: bool,

    /// Path to the SadTalker wrapper script.
    #[serde(default = "default_sadtalker_script")]
    pub sadtalker_script: PathBuf,

    // ── D-ID ─────────────────────────────────────────────────────────────────

    /// D-ID presenter ID.
    #[serde(default)]
    pub did_presenter_id: String,
    #[serde(skip)]
    pub did_api_key: String,

    // ── HeyGen ───────────────────────────────────────────────────────────────

    /// HeyGen avatar ID.
    #[serde(default)]
    pub heygen_avatar_id: String,
    #[serde(skip)]
    pub heygen_api_key: String,
}

fn default_sadtalker_dir()    -> PathBuf { PathBuf::from("tools/SadTalker") }
fn default_sadtalker_env()    -> String  { "thoth-sadtalker".to_owned() }
fn default_sadtalker_size()   -> u32     { 256 }
fn default_sadtalker_script() -> PathBuf { PathBuf::from("scripts/media/sadtalker_generate.py") }

impl Default for AvatarConfig {
    fn default() -> Self {
        Self {
            mode:              AvatarMode::None,
            image_path:        PathBuf::new(),
            sadtalker_dir:     default_sadtalker_dir(),
            sadtalker_env:     default_sadtalker_env(),
            sadtalker_size:    default_sadtalker_size(),
            sadtalker_still:   false,
            sadtalker_script:  default_sadtalker_script(),
            did_presenter_id:  String::new(),
            did_api_key:       String::new(),
            heygen_avatar_id:  String::new(),
            heygen_api_key:    String::new(),
        }
    }
}

/// Reaction module configuration (Stage 4 Phase 4-6).
#[derive(Debug, Deserialize, Clone)]
pub struct ReactionConfig {
    /// Enable reaction script generation + TTS synthesis (default: false).
    #[serde(default)]
    pub enabled: bool,

    /// Where to insert the reaction segment in the final clip.
    /// "post_roll" (default) | "pre_roll" | "pip_corner"
    #[serde(default = "default_reaction_position")]
    pub position: String,

    /// PiP corner position when position = "pip_corner".
    #[serde(default = "default_pip_position")]
    pub pip_position: String,

    /// PiP scale as % of frame width (pip_corner mode).
    #[serde(default = "default_pip_scale")]
    pub pip_scale_pct: u32,

    /// Maximum reaction duration in seconds (LLM will generate script to fit).
    #[serde(default = "default_max_reaction_secs")]
    pub max_reaction_secs: u32,

    /// Script language (BCP-47 code: "id" = Indonesian, "en" = English).
    #[serde(default = "default_reaction_language")]
    pub language: String,

    /// Reaction tone style.
    /// "auto" = LLM picks based on viral_type | "energetic" | "informative" | "shocked" | "casual"
    #[serde(default = "default_script_style")]
    pub script_style: String,

    /// TTS configuration.
    #[serde(default)]
    pub tts: TtsConfig,

    /// Avatar configuration.
    #[serde(default)]
    pub avatar: AvatarConfig,

    /// Path to the TTS Python script (routed through news.conda_env).
    #[serde(default = "default_tts_script")]
    pub tts_script: PathBuf,
}

fn default_tts_provider()         -> String  { "edge".to_owned() }
fn default_edge_voice()           -> String  { "id-ID-ArdiNeural".to_owned() }
fn default_minimax_model()        -> String  { "speech-02-hd".to_owned() }
fn default_minimax_voice_id()     -> String  { "Friendly_Person".to_owned() }
fn default_minimax_speed()        -> f32     { 1.0 }
fn default_minimax_emotion()      -> String  { "happy".to_owned() }
fn default_fish_audio_model()     -> String  { "s2-pro".to_owned() }
fn default_elevenlabs_model()     -> String  { "eleven_multilingual_v2".to_owned() }
fn default_openai_tts_voice()     -> String  { "nova".to_owned() }
fn default_openai_tts_model()     -> String  { "tts-1-hd".to_owned() }
fn default_reaction_position()  -> String  { "post_roll".to_owned() }
fn default_pip_position()       -> String  { "bottom_right".to_owned() }
fn default_pip_scale()          -> u32     { 30 }
fn default_max_reaction_secs()  -> u32     { 25 }
fn default_reaction_language()  -> String  { "id".to_owned() }
fn default_script_style()       -> String  { "auto".to_owned() }
fn default_tts_script()         -> PathBuf { PathBuf::from("scripts/tts/tts_generate.py") }

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            provider:              default_tts_provider(),
            edge_voice:            default_edge_voice(),
            minimax_model:         default_minimax_model(),
            minimax_voice_id:      default_minimax_voice_id(),
            minimax_speed:         default_minimax_speed(),
            minimax_emotion:       default_minimax_emotion(),
            minimax_group_id:      String::new(),
            minimax_api_key:       String::new(),
            fish_audio_model:      default_fish_audio_model(),
            fish_audio_reference_id: String::new(),
            fish_audio_api_key:    String::new(),
            elevenlabs_voice_id:   String::new(),
            elevenlabs_model:      default_elevenlabs_model(),
            elevenlabs_api_key:    String::new(),
            openai_voice:          default_openai_tts_voice(),
            openai_model:          default_openai_tts_model(),
        }
    }
}

impl Default for ReactionConfig {
    fn default() -> Self {
        Self {
            enabled:           false,
            position:          default_reaction_position(),
            pip_position:      default_pip_position(),
            pip_scale_pct:     default_pip_scale(),
            max_reaction_secs: default_max_reaction_secs(),
            language:          default_reaction_language(),
            script_style:      default_script_style(),
            tts:               TtsConfig::default(),
            avatar:            AvatarConfig::default(),
            tts_script:        default_tts_script(),
        }
    }
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
            // Every other `gpu.*` field carries a serde default, but without one
            // key the `[gpu]` table itself is absent and deserialization fails
            // whenever `config.toml` is missing.
            .set_default("gpu.enabled", false)?
            .set_default("output.default_dir", "./output")?
            .set_default("output.default_layout", "vertical")?
            .set_default("ingest.ytdlp_path", "yt-dlp")?
            .set_default(
                "ingest.format",
                "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            )?
            .set_default("assets.sfx_dir", "assets/sfx")?
            .set_default("assets.bgm_dir", "assets/bgm")?
            .set_default("assets.beat_sync", false)?
            .set_default("assets.catalog_path", "assets/asset_catalog.json")?
            .set_default("vision.enabled", false)?
            .set_default("vision.provider", "gemini")?
            .set_default("vision.frames_per_moment", 3)?
            .set_default("vision.frame_width", 384)?
            .set_default("vision.score_weight", 0.35)?
            .set_default("vision.vllm_base_url", "")?
            .set_default("vision.vllm_model", "Qwen/Qwen2.5-VL-7B-Instruct")?
            .set_default("vision.novita_base_url", "https://api.novita.ai/openai")?
            .set_default("vision.novita_model", "qwen/qwen3-vl-235b-a22b-instruct")?
            .set_default("vision.openrouter_base_url", "https://openrouter.ai/api")?
            .set_default("vision.openrouter_model", "")?
            .set_default("vision.describe_video", false)?
            .set_default("vision.describe_interval", 10.0)?
            .set_default("vision.describe_batch", 5)?
            .set_default("vision.describe_vllm_base_url", "")?
            .set_default("vision.describe_vllm_model", "")?
            .set_default("vision.scene_detection", false)?
            .set_default("vision.scene_threshold", 0.3f64)?
            .set_default("vision.concurrency", 4i64)?
            .set_default("overlay.enabled", false)?
            .set_default("overlay.ytdlp_path", "")?
            .set_default("overlay.cache_dir", "footage_cache")?
            .set_default("overlay.max_duration", 8.0)?
            .set_default("overlay.fallback_to_youtube", true)?
            .set_default("overlay.max_variants", 3)?
            .set_default("overlay.placement_min_similarity", 0.46f64)?
            .set_default("styles.default_profile", "auto")?
            .set_default("vector_db.enabled", false)?
            .set_default("vector_db.retrieval_count", 3i64)?
            .set_default("vector_db.similarity_threshold", 0.65f64)?
            .set_default("vector_db.vocab_cache_ttl_secs", 3600i64)?
            .set_default("vector_db.embed_provider", "gemini")?
            .set_default("vector_db.embed_base_url", "")?
            .set_default("vector_db.embed_model", "")?
            .add_source(File::with_name("config").required(false))
            .add_source(Environment::with_prefix("THOTH").separator("_"))
            .build()
            .context("failed to build configuration")?;

        let mut app: AppConfig = cfg.try_deserialize().context("failed to parse configuration")?;

        // Load API keys from env — never from config file
        app.llm.groq_api_key   = std::env::var("THOTH_GROQ_API_KEY").unwrap_or_default();
        app.llm.openai_api_key = std::env::var("THOTH_OPENAI_API_KEY").unwrap_or_default();
        app.llm.claude_api_key = std::env::var("THOTH_CLAUDE_API_KEY").unwrap_or_default();
        app.llm.gemini_api_key = std::env::var("THOTH_GEMINI_API_KEY").unwrap_or_default();
        app.llm.novita_api_key    = std::env::var("THOTH_NOVITA_API_KEY").unwrap_or_default();
        app.llm.openrouter_api_key = std::env::var("THOTH_OPENROUTER_API_KEY").unwrap_or_default();
        app.llm.together_api_key  = std::env::var("THOTH_TOGETHER_API_KEY").unwrap_or_default();
        app.llm.fireworks_api_key = std::env::var("THOTH_FIREWORKS_API_KEY").unwrap_or_default();
        app.llm.vllm_api_key      = std::env::var("THOTH_VLLM_API_KEY").unwrap_or_default();
        // Supabase connection URI (full URI with password — never in config file)
        app.vector_db.supabase_url = std::env::var("THOTH_SUPABASE_URL").unwrap_or_default();
        // Embedding API key — khusus untuk RAG embedding, opsional
        app.vector_db.embed_api_key = std::env::var("THOTH_EMBED_API_KEY").unwrap_or_default();
        // News search: Serper.dev API key (only needed when news.provider = "serper")
        app.news.serper_api_key = std::env::var("THOTH_SERPER_API_KEY").unwrap_or_default();
        // Reaction TTS API keys
        app.reaction.tts.elevenlabs_api_key     = std::env::var("THOTH_ELEVENLABS_API_KEY").unwrap_or_default();
        app.reaction.tts.minimax_api_key        = std::env::var("THOTH_MINIMAX_API_KEY").unwrap_or_default();
        app.reaction.tts.minimax_group_id       = std::env::var("THOTH_MINIMAX_GROUP_ID").unwrap_or_default();
        app.reaction.tts.fish_audio_api_key     = std::env::var("THOTH_FISH_AUDIO_API_KEY").unwrap_or_default();
        // Reaction Avatar API keys
        app.reaction.avatar.did_api_key    = std::env::var("THOTH_DID_API_KEY").unwrap_or_default();
        app.reaction.avatar.heygen_api_key = std::env::var("THOTH_HEYGEN_API_KEY").unwrap_or_default();
        
        // Priority for language: env var > config file
        if let Ok(lang) = std::env::var("THOTH_WHISPER_LANGUAGE") {
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

#[cfg(test)]
mod tests {
    use super::MontageConfig;

    // The `[animelorian]` section and its old field names were renamed to
    // `[montage]` / `intercut*`. serde aliases keep pre-rename config.toml files
    // parsing unchanged — assert the old keys still map onto the new fields.
    #[test]
    fn montage_accepts_legacy_animelorian_field_names() {
        let legacy = r#"{
            "enabled": true,
            "montage": false,
            "montage_segment_secs": 3.5,
            "montage_max_cuts": 5
        }"#;
        let cfg: MontageConfig = serde_json::from_str(legacy).unwrap();
        assert!(!cfg.intercut, "old `montage` bool -> intercut");
        assert!((cfg.intercut_segment_secs - 3.5).abs() < 1e-6);
        assert_eq!(cfg.intercut_max_cuts, 5);

        // New names parse too.
        let modern = r#"{ "intercut": true, "intercut_max_cuts": 9 }"#;
        let cfg: MontageConfig = serde_json::from_str(modern).unwrap();
        assert!(cfg.intercut);
        assert_eq!(cfg.intercut_max_cuts, 9);
    }
}
