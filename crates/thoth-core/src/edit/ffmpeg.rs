use std::path::{Path, PathBuf};
use std::process::Stdio;

use tracing::{debug, info, warn};

use crate::config::FfmpegConfig;
use crate::execution::JobExecutionContext;

use super::error::EditError;
use super::fonts::FontConfig;
use super::layout::OutputLayout;

// ── Clip transition styles ────────────────────────────────────────────────────

/// Visual transition effect applied at the IN (start) and OUT (end) of every clip.
///
/// The effect is embedded directly into the video filtergraph — no extra pass needed.
///
/// | Style    | In                          | Out                          |
/// |----------|-----------------------------|------------------------------|
/// | `Fade`   | Fade in from black (0.5 s)  | Fade out to black (0.5 s)    |
/// | `Flash`  | Flash in from white (0.25 s)| Flash out to white (0.25 s)  |
/// | `Zoom`   | Slow push-in (Ken Burns)    | Fade out to black (0.5 s)    |
/// | `Smooth` | Very gentle fade (0.8 s)    | Very gentle fade (0.8 s)     |
/// | `None`   | No transition               | No transition                |
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ClipStyle {
    /// Fade from/to black — clean, works for all content (default)
    #[default]
    Fade,
    /// Flash from/to white — energetic, popular in meme/reaction content
    Flash,
    /// Subtle Ken Burns zoom-in at start + fade to black at end
    Zoom,
    /// Very gentle long fade (0.8 s) — cinematic, professional
    Smooth,
    /// No transition — instant cut
    None,
}

impl ClipStyle {
    /// Parse a vibe/style string (from LLM output) into a `ClipStyle`.
    ///
    /// Accepts the exact labels in the analyze schema plus common aliases.
    /// Falls back to `Fade` for unknown/empty values.
    pub fn from_vibe(s: &str) -> Self {
        match s.to_lowercase().trim() {
            "flash"                     => ClipStyle::Flash,
            "zoom" | "dynamic"          => ClipStyle::Zoom,
            "smooth" | "cinematic"      => ClipStyle::Smooth,
            "none"  | "cut" | "instant" => ClipStyle::None,
            _                           => ClipStyle::Fade,
        }
    }

    /// Return the beat-aligned fade-in duration for this style.
    ///
    /// When `bpm > 0`, durations snap to musical beat subdivisions:
    ///   - `Fade`:   1 beat  (e.g. 469ms at 128 BPM)
    ///   - `Flash`:  ½ beat  (e.g. 234ms at 128 BPM)
    ///   - `Smooth`: 2 beats (e.g. 938ms at 128 BPM)
    ///   - `Zoom`:   ¾ beat
    /// When `bpm == 0`, uses the hardcoded defaults.
    pub fn fade_in_dur(&self, bpm: f32) -> f64 {
        if bpm > 0.0 {
            let beat = 60.0 / bpm as f64;
            match self {
                ClipStyle::Fade   => beat,
                ClipStyle::Flash  => beat * 0.5,
                ClipStyle::Smooth => beat * 2.0,
                ClipStyle::Zoom   => beat * 0.75,
                ClipStyle::None   => 0.0,
            }
        } else {
            match self {
                ClipStyle::Fade   => 0.500,
                ClipStyle::Flash  => 0.250,
                ClipStyle::Smooth => 0.800,
                ClipStyle::Zoom   => 0.400,
                ClipStyle::None   => 0.0,
            }
        }
    }

    /// Return the beat-aligned fade-out duration (same proportions as fade-in).
    pub fn fade_out_dur(&self, bpm: f32) -> f64 {
        self.fade_in_dur(bpm)
    }

    /// Build the IN transition filter string (appended at the start of the video chain).
    /// `bpm` = beats per minute of the BGM (0 = use default durations).
    pub fn in_filter(&self, _duration: f64, w: u32, h: u32, bpm: f32) -> String {
        let d = self.fade_in_dur(bpm);
        match self {
            ClipStyle::Fade   => format!("fade=t=in:st=0:d={d:.3}:color=black"),
            ClipStyle::Flash  => format!("fade=t=in:st=0:d={d:.3}:color=white"),
            ClipStyle::Smooth => format!("fade=t=in:st=0:d={d:.3}:color=black"),
            ClipStyle::Zoom   => {
                let _ = (w, h);
                format!("crop=iw*94/100:ih*94/100,scale=iw*100/94:ih*100/94,\
                         fade=t=in:st=0:d={d:.3}:color=black")
            }
            ClipStyle::None   => String::new(),
        }
    }

    /// Build the OUT transition filter string.
    /// `fade_start` = time (seconds) at which the fade-out begins.
    /// `bpm` = beats per minute (0 = use default durations).
    pub fn out_filter(&self, fade_start: f64, bpm: f32) -> String {
        let d = self.fade_out_dur(bpm);
        match self {
            ClipStyle::Fade   => format!("fade=t=out:st={fade_start:.3}:d={d:.3}:color=black"),
            ClipStyle::Flash  => format!("fade=t=out:st={fade_start:.3}:d={d:.3}:color=white"),
            ClipStyle::Smooth => format!("fade=t=out:st={fade_start:.3}:d={d:.3}:color=black"),
            ClipStyle::Zoom   => format!("fade=t=out:st={fade_start:.3}:d={d:.3}:color=black"),
            ClipStyle::None   => String::new(),
        }
    }
}

/// News-style lower-third headline panel overlaid on the first N seconds of the clip.
///
/// Modelled after broadcast news lower-thirds (DPN News style):
///   ┌──────────────────────────────────────────┐
///   │ ▒▒▒▒▒▒▒▒▒▒ gradient fades in ▒▒▒▒▒▒▒▒▒▒ │  ← transparent → dark navy
///   │  @social_handle          (small, top)     │
///   │  HEADLINE TEXT IN CAPS   (large, bold)    │
///   │  Source: Channel Name    (small, bottom)  │
///   └──────────────────────────────────────────┘
///
/// News screenshot image overlay — shows a formatted 9:16 PNG inside the clip.
///
/// The image is composited over the video for `duration_sec` seconds starting at
/// `at_sec`. When `ken_burns = true`, a slow zoom-in (1.0 → 1.05 scale over the
/// display duration) is applied to the image.
///
/// The image should already be formatted to the clip's output dimensions (1080×1920
/// for vertical). Use `news::formatter::format_screenshot()` to produce it.
#[derive(Debug, Clone)]
pub struct ImageOverlaySpec {
    /// Absolute path to the pre-formatted PNG (must match clip output dimensions).
    pub path: PathBuf,
    /// Seconds from clip start when the image appears.
    pub at_sec: f64,
    /// How many seconds the image is visible.
    pub duration_sec: f64,
    /// Apply a slow Ken Burns zoom-in while the image is displayed.
    pub ken_burns: bool,
}

/// One timestamped SFX punch-in selected by the LLM from the annotated asset
/// catalog (`moment.asset_cues` with audio files). Unlike `sfx_intro` (one hit at
/// the clip open), several of these can be placed anywhere inside the clip.
#[derive(Debug, Clone)]
pub struct AssetSfxCue {
    /// Absolute (or cwd-relative) path to the SFX file, e.g. `assets/sfx/vine-boom.mp3`.
    pub path: PathBuf,
    /// Seconds from clip start where the cue fires.
    pub at_sec: f64,
    /// How long the cue plays (seconds).
    pub duration_sec: f64,
    /// Playback volume multiplier (0.0–1.0). Default 0.8.
    pub volume: f32,
}

/// One timestamped meme-video cutaway selected by the LLM from the catalog
/// (`moment.asset_cues` with video files). Rendered as a corner PiP over the clip
/// during `[at_sec, at_sec+duration_sec]`. Video-only (audio is not mixed — same
/// convention as the TikTok `OverlaySpec`).
#[derive(Debug, Clone)]
pub struct MemeCue {
    /// Path to the meme video, e.g. `assets/meme/clapping.mp4`.
    pub path: PathBuf,
    /// Seconds from clip start when the PiP appears.
    pub at_sec: f64,
    /// How long the PiP is shown (seconds).
    pub duration_sec: f64,
    /// Corner: "bottom_right" | "bottom_left" | "top_right" | "top_left" | "bottom_center".
    pub position: String,
    /// Mix the meme's own audio (e.g. vine-boom, screaming) into the clip.
    /// When false the meme is a silent visual cutaway. Set from the catalog's
    /// `has_audio`. When true, the narration is briefly ducked under it.
    pub with_audio: bool,
    /// Playback volume for the meme audio when `with_audio` (0.0–1.5). Default 0.9.
    pub audio_volume: f32,
    /// When true, the meme is shown FULL-SCREEN (whole meme centred over a blurred
    /// fill of itself) as a cutaway, instead of a small corner PiP. The subtitle is
    /// still burned on top. When false, the legacy corner PiP is used.
    pub fullscreen: bool,
}

/// The panel is tall enough (560 px for 1080×1920) to visually cover the subtitle
/// area (MarginV = 450 → subtitle y ≈ 1470, panel starts at y = 1360).
/// Subtitles are not removed — they simply become visible once the panel fades out.
#[derive(Debug, Clone, Default)]
pub struct HeadlineOverlay {
    /// Main headline text (shown in UPPERCASE). Usually `moment.title`.
    pub headline: String,
    /// Creator / channel name shown as source credit.
    pub source:   String,
    /// Social media handle shown top-left of the panel (e.g. "@namaakun").
    pub social:   String,
    /// How many seconds to display the panel (default: 4.0).
    pub duration_secs: f64,
}

/// Optional audio + visual enhancements applied during encoding.
/// Optional PNG icon displayed at the top-left of the headline panel,
/// replacing the plain-text `@social_handle`.
#[derive(Debug, Clone)]
pub struct SocialIcon {
    /// Path to the PNG icon file.
    pub path: PathBuf,
    /// Display size in pixels (width = height).  Validated: 16–128 px.
    pub size: u32,
}

/// Pre-rendered hook-title PNG (full-frame RGBA) + how long to show it.
/// Overlaid at 0,0 with a fade in/out over `[0, duration_sec]`.
#[derive(Debug, Clone)]
pub struct HeadlineImage {
    /// Path to the full-frame transparent PNG.
    pub path: PathBuf,
    /// Seconds to display (from clip start).
    pub duration_sec: f64,
}

/// Per-clip Montage render directive. When `Some`, the clip is composited on
/// the crumpled-paper canvas with the source footage shown as a centred card
/// (instead of the legacy full-frame/blur look). `None` = legacy look (also used
/// for the hook clip when `hook_fullscreen = true`). Set by `edit/service.rs`.
#[derive(Debug, Clone)]
pub struct MontageRender {
    /// Crumpled-paper background video (looped to clip length).
    pub paper_bg: PathBuf,
    /// Footage card width as % of frame width (≈88).
    pub footage_scale_pct: u32,
    /// Per-clip vertical placement offset in px (variation; 0 = centred).
    pub card_y_offset: i32,
}

/// One time-windowed footage CARD in a montage — a relevant clip shown centred on
/// the paper canvas for `[at_sec, at_sec+duration_sec]`, cutting over the base
/// B-roll. Chained so the video changes footage every few seconds (Montage).
#[derive(Debug, Clone)]
pub struct FootageCardCue {
    pub path: PathBuf,
    pub at_sec: f64,
    pub duration_sec: f64,
    /// Card width as % of frame width (≈88).
    pub scale_pct: u32,
}

/// One time-windowed IMAGE CARD in a montage — a STATIC cropped screenshot of a
/// non-video post (tweet/IG photo/article), shown centred on the paper canvas for
/// `[at_sec, at_sec+duration_sec]`, exactly like a [`FootageCardCue`] but sourced
/// from a still image (added as a `-loop 1` input) instead of a downloaded clip.
#[derive(Debug, Clone)]
pub struct ImageCardCue {
    /// Local PNG path (scout's vision-cropped post screenshot).
    pub path: PathBuf,
    pub at_sec: f64,
    pub duration_sec: f64,
    /// Card width as % of frame width (≈88).
    pub scale_pct: u32,
}

/// A small still-image badge composited at a fixed rectangle for a time window —
/// used for REAL avatar photos on the profile card and comment cards. The image is
/// added as an FFmpeg input (`-loop 1`), scaled to a square, and overlaid on top of
/// the drawn card during `[at_sec, at_sec+duration_sec]`. Empty list = no badges.
#[derive(Debug, Clone)]
pub struct ImageBadgeCue {
    /// Local image path (downloaded by `main.rs`).
    pub path: PathBuf,
    /// Top-left x of the badge (pixels) — the card's avatar-tile origin.
    pub x: u32,
    /// Top-left y of the badge (pixels).
    pub y: u32,
    /// Square size in pixels (the avatar tile size).
    pub size: u32,
    pub at_sec: f64,
    pub duration_sec: f64,
}

/// Narrator-driven audio spine. When set, this voiceover becomes the clip's
/// PRIMARY voice and the original event audio (`[0:a]`) is ducked underneath it.
#[derive(Debug, Clone)]
pub struct NarrationVoice {
    /// Narration voiceover MP3 (the spine).
    pub mp3: PathBuf,
    /// Event/footage audio volume while the narrator is speaking (0.0–1.0).
    pub duck_event_vol: f32,
    /// Windows (start_sec, end_sec) where the narrator PAUSES — the event audio
    /// "breathes through" louder here (dynamic ducking). Empty = constant duck.
    pub leak_windows: Vec<(f64, f64)>,
    /// Event volume during a leak window (> duck_event_vol).
    pub leak_vol: f32,
    /// Seconds the narration voice is DELAYED at the start (the event plays loud
    /// during this lead-in, then the narrator comes in). 0 = no delay.
    pub lead_in_secs: f64,
}

#[derive(Debug, Clone, Default)]
pub struct AudioOptions {
    /// Sound effect file played at the very start of the clip (any FFmpeg-supported format).
    pub sfx_intro: Option<PathBuf>,

    /// Background music file mixed underneath the clip voice.
    /// Looped if shorter than the clip.  Volume controlled by `bgm_volume`.
    pub bgm: Option<PathBuf>,

    /// Background music volume multiplier (0.0–1.0).  Default: 0.12 (≈ −18 dB).
    pub bgm_volume: f32,

    /// Visual transition at clip IN and OUT.  Default: `Fade`.
    pub clip_style: ClipStyle,

    /// News-style lower-third headline panel shown at the start of the clip.
    /// `None` = no headline overlay.
    pub headline: Option<HeadlineOverlay>,

    /// Duration (seconds) for the headline panel. Carried here so it travels
    /// with AudioOptions; the actual HeadlineOverlay.duration_secs is set per-clip.
    pub headline_dur: f64,

    /// Font configuration for all text rendered in the clip.
    pub font: FontConfig,

    /// Optional PNG icon replacing the @social_handle text in the headline panel.
    pub social_icon: Option<SocialIcon>,

    /// Minimum allowed icon display size in pixels (validation, default 16).
    pub social_icon_min_size: u32,
    /// Maximum allowed icon display size in pixels (validation, default 128).
    pub social_icon_max_size: u32,

        /// Optional full-frame video overlay inserted at a specific moment.
    /// Downloaded by `edit::overlay::fetch_overlay_from_url()` from the scout
    /// enrichment pool (`content_enrichment.json`). `None` = no overlay (default).
    pub overlay: Option<super::overlay::OverlaySpec>,

    /// News screenshot image overlay (Phase 3).
    /// Shows the formatted 9:16 news screenshot at a specific moment in the clip.
    /// `None` = no news image overlay (default, or when screenshot unavailable).
    pub news_overlay: Option<ImageOverlaySpec>,

    /// Montage composite directive (paper canvas + footage card). `None` =
    /// legacy full-frame look (and hook clips when `hook_fullscreen`).
    pub montage: Option<MontageRender>,

    /// Narrator voiceover spine. `Some` = narration drives the audio (event ducked).
    pub narration: Option<NarrationVoice>,

    /// Montage footage cards (narrator-driven mode): relevant clips cutting over the
    /// base B-roll at intervals so the video keeps changing. Empty = single B-roll.
    pub footage_cards: Vec<FootageCardCue>,

    /// Montage IMAGE cards: static cropped screenshots of non-video posts shown as
    /// centred cards (same montage role as `footage_cards`, still-image source).
    /// Inputs are `-loop 1` stills appended after the footage-card inputs. Empty = none.
    pub image_cards: Vec<ImageCardCue>,

    // ── Beat-sync (Priority 4) ────────────────────────────────────────────────

    /// BPM of the selected BGM file — used to make ClipStyle transition durations
    /// snap to musical beat subdivisions (e.g. Fade = 1 beat, Flash = ½ beat).
    /// 0.0 = use hardcoded defaults (when beat_sync is disabled or no BGM).
    pub clip_bpm: f32,

    /// Delay the SFX by this many milliseconds so it lands on the BGM's downbeat.
    /// 0 = no delay (current behaviour).  Set by `edit/service.rs` when
    /// `config.assets.beat_sync = true`.
    pub sfx_beat_offset_ms: u32,

    /// Additional SFX delay (seconds from clip start) to hit a peak moment.
    /// LLM sets this via `moment.sfx_at_sec` — e.g. play impact at stat reveal t=8s.
    /// Combined with sfx_beat_offset_ms for precise timing.
    pub sfx_at_sec: f64,

    /// How long the SFX plays (seconds). Default 2.5.
    pub sfx_duration_sec: f64,

    /// Seek the BGM file to this position (ms) before looping, so the first
    /// downbeat aligns with the clip's t=0.  0 = start from file beginning.
    pub bgm_start_offset_ms: u32,

    /// Timestamped SFX punch-ins from `moment.asset_cues` (audio entries of the
    /// annotated catalog). Each is mixed at its `at_sec`. Empty = none.
    pub asset_sfx_cues: Vec<AssetSfxCue>,

    /// Timestamped meme-video cutaways from `moment.asset_cues` (video entries).
    /// Each is overlaid as a corner PiP at its `at_sec`. Empty = none.
    pub meme_cues: Vec<MemeCue>,

    /// Pre-rendered giant multi-colour hook-title ASS, burned as a second
    /// subtitles pass over the first few seconds. `None` = disabled.
    pub hook_title_ass: Option<PathBuf>,

    /// Pre-rendered hook-title PNG (Pillow, higher fidelity than ASS) overlaid
    /// full-frame for its `duration_sec`. Takes precedence over `hook_title_ass`
    /// when set. `None` = use ASS (or no hook). See `headline_png`.
    pub hook_title_png: Option<HeadlineImage>,

    /// AI cover/thumbnail intro (full-screen AI bg + subject cutout + headline),
    /// shown OPAQUE for `duration_sec` then dissolved to footage. When set it is
    /// the topmost layer for the hook window and the hook-title is suppressed
    /// (the cover already carries the text). See `cover`.
    pub cover: Option<HeadlineImage>,

    /// Loop the source video input (`-stream_loop -1`) so a short B-roll fills a
    /// LONGER timeline. Set in the narrator path when the narration outlasts the
    /// source clip — otherwise the video would end at the source length while the
    /// narration audio keeps going (Bug 6). The filtergraph trim bounds the loop.
    pub loop_source: bool,

    /// Beat-2 character intro (profile card + name above head). `None` = disabled.
    pub profile_card: Option<super::profile_card::ProfileCard>,

    /// Beat-3 number callouts (figure + arrow). Empty = none.
    pub callouts: Vec<super::callout::Callout>,

    /// Reaction-beat viral comment cards (screenshot style). Each has its own
    /// time window, so several can be shown across a clip without clashing. Empty
    /// = none.
    pub comment_cards: Vec<super::comment_card::CommentCard>,

    /// Real avatar photos to composite on the profile/comment cards. Each is an
    /// FFmpeg image input overlaid on its card's avatar tile. Empty = drawn tiles.
    pub image_badges: Vec<ImageBadgeCue>,

    /// Enable BGM volume ducking: reduce BGM to ~40% of normal volume during the
    /// speech portion of the clip (t=1.5s → clip_end − 1.0s), and restore it for
    /// the opening and closing seconds.  Creates the professional "sidechaining"
    /// effect common in TikTok/Reels editing.
    pub bgm_duck: bool,
}

/// Margin for input fast-seek. We seek this many seconds before the clip start so
/// FFmpeg lands inside a decodable keyframe window. YouTube AV1/VP9 keyframes are
/// typically every 2–5 s; 10 s is a safe margin.
const SEEK_MARGIN_SECS: f64 = 10.0;

/// Build the audio-filter fragment for one timestamped SFX cue.
///
/// `input_idx` is the ffmpeg input number, `label_k` the `[cueK]` output index,
/// `clip_duration` the clip length (to clamp the cue's tail). The fragment is
/// prefixed with `;` so it can be appended to the running filter chain.
fn build_cue_audio_filter(
    input_idx: usize,
    label_k: usize,
    cue: &AssetSfxCue,
    clip_duration: f64,
    normalize: &str,
) -> String {
    build_delayed_audio_filter(
        input_idx, &format!("cue{label_k}"),
        cue.at_sec, cue.duration_sec, cue.volume, clip_duration, normalize,
    )
}

/// Generic "play one audio clip once at `at_sec`" fragment. Used for both SFX
/// cues and meme audio. NORMALIZE → trim → fades → volume → delay → `[out_label]`.
/// A zero `volume` falls back to 0.8.
fn build_delayed_audio_filter(
    input_idx: usize,
    out_label: &str,
    at_sec: f64,
    duration_sec: f64,
    volume: f32,
    clip_duration: f64,
    normalize: &str,
) -> String {
    let at_sec  = at_sec.max(0.0);
    let cue_dur = duration_sec.clamp(0.3, 6.0).min((clip_duration - at_sec).max(0.2));
    let fade_o  = (cue_dur - 0.25).max(0.05);
    let at_ms   = (at_sec * 1000.0) as u64;
    let vol     = if volume <= 0.0 { 0.80_f32 } else { volume.min(1.5) };
    format!(
        ";[{input_idx}:a]{normalize},\
         atrim=duration={cue_dur:.3},asetpts=PTS-STARTPTS,\
         afade=t=in:st=0:d=0.100,\
         afade=t=out:st={fade_o:.3}:d=0.250,\
         volume={vol:.3},\
         adelay={at_ms}|{at_ms}\
         [{out_label}]"
    )
}

/// Build the video-filter fragment overlaying one meme onto the running chain.
///
/// `input_idx` = ffmpeg input number of the meme, `in_label`/`out_label` are the
/// bare graph labels (without brackets) for the video stream in/out. The meme is
/// trimmed and shifted to appear at `at_sec`, then either:
///   • `fullscreen` → the WHOLE meme is centred over a blurred fill of itself so it
///     covers the entire frame (a cutaway). The subtitle is burned later, on top.
///   • otherwise    → a small corner PiP with a thin white border (legacy).
/// Overlaid only during `[at_sec, at_sec+duration_sec]`.
fn build_meme_overlay_filter(
    input_idx: usize,
    k: usize,
    meme: &MemeCue,
    clip_w: u32,
    clip_h: u32,
    in_label: &str,
    out_label: &str,
) -> String {
    let at  = meme.at_sec.max(0.0);
    let dur = meme.duration_sec.clamp(0.5, 6.0);
    let end = at + dur;

    if meme.fullscreen {
        // Whole meme (force_original_aspect_ratio=decrease) centred over a blurred,
        // cover-scaled copy of itself → full-frame, no black bars, nothing cropped.
        return format!(
            "[{input_idx}:v]trim=duration={dur:.3},setpts=PTS-STARTPTS+{at:.3}/TB,\
             split=2[mbg{k}][mfg{k}];\
             [mbg{k}]scale={clip_w}:{clip_h}:force_original_aspect_ratio=increase,\
             crop={clip_w}:{clip_h},gblur=sigma=24[mb{k}];\
             [mfg{k}]scale={clip_w}:{clip_h}:force_original_aspect_ratio=decrease[mf{k}];\
             [mb{k}][mf{k}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[mm{k}];\
             [{in_label}][mm{k}]overlay=x=0:y=0:\
             enable='between(t,{at:.3},{end:.3})'[{out_label}]"
        );
    }

    let pip_w = ((clip_w as f64) * 0.42) as u32;
    let m = 40; // corner margin in px
    let (xe, ye) = match meme.position.as_str() {
        "bottom_left"   => (format!("{m}"),     format!("H-h-{m}")),
        "top_right"     => (format!("W-w-{m}"), format!("{m}")),
        "top_left"      => (format!("{m}"),     format!("{m}")),
        "bottom_center" => ("(W-w)/2".to_string(), format!("H-h-{m}")),
        _ /* bottom_right */ => (format!("W-w-{m}"), format!("H-h-{m}")),
    };
    format!(
        "[{input_idx}:v]trim=duration={dur:.3},setpts=PTS-STARTPTS+{at:.3}/TB,\
         scale={pip_w}:-2,pad=iw+8:ih+8:4:4:white,format=yuv420p[mm{k}];\
         [{in_label}][mm{k}]overlay=x={xe}:y={ye}:\
         enable='between(t,{at:.3},{end:.3})'[{out_label}]"
    )
}

/// Build the video-filter fragment overlaying one full-width footage CARD (centred)
/// onto the running chain — the narrator-driven montage cuts main↔relevant footage
/// every few seconds. Shown only during `[at, at+dur]`.
fn build_footage_card_overlay(
    input_idx: usize,
    k: usize,
    cue: &FootageCardCue,
    clip_w: u32,
    in_label: &str,
    out_label: &str,
) -> String {
    let at    = cue.at_sec.max(0.0);
    let dur   = cue.duration_sec.clamp(0.8, 8.0);
    let end   = at + dur;
    let cardw = (clip_w * cue.scale_pct.clamp(40, 100) / 100).max(160);
    format!(
        "[{input_idx}:v]trim=duration={dur:.3},setpts=PTS-STARTPTS+{at:.3}/TB,\
         scale={cardw}:-2,setsar=1[fc{k}];\
         [{in_label}][fc{k}]overlay=x=(W-w)/2:y=(H-h)/2:\
         enable='between(t,{at:.3},{end:.3})'[{out_label}]"
    )
}

/// Build the video-filter fragment overlaying one full-width IMAGE CARD (centred,
/// static cropped post screenshot) onto the running chain, shown only during
/// `[at, at+dur]`. Mirrors [`build_footage_card_overlay`] but the source is a looped
/// still (no `trim`/`setpts`); `eof_action=pass` keeps the base running underneath.
fn build_image_card_overlay(
    input_idx: usize,
    k: usize,
    cue: &ImageCardCue,
    clip_w: u32,
    in_label: &str,
    out_label: &str,
) -> String {
    let at    = cue.at_sec.max(0.0);
    let dur   = cue.duration_sec.clamp(0.8, 8.0);
    let end   = at + dur;
    let cardw = (clip_w * cue.scale_pct.clamp(40, 100) / 100).max(160);
    format!(
        "[{input_idx}:v]scale={cardw}:-2,setsar=1[ic{k}];\
         [{in_label}][ic{k}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:\
         enable='between(t,{at:.3},{end:.3})'[{out_label}]"
    )
}

/// Build the video-filter fragment compositing one real avatar IMAGE BADGE onto the
/// running chain at a fixed square rectangle, shown only during `[at, at+dur]`. The
/// still image input is scaled to `size`×`size` and overlaid on the card's avatar
/// tile (drawn underneath by `profile_card`/`comment_card`).
fn build_image_badge_overlay(
    input_idx: usize,
    k: usize,
    badge: &ImageBadgeCue,
    in_label: &str,
    out_label: &str,
) -> String {
    let at  = badge.at_sec.max(0.0);
    let end = at + badge.duration_sec.max(0.3);
    let (x, y, sz) = (badge.x, badge.y, badge.size.max(8));
    // `setpts` not needed: the looped still has no meaningful PTS; the overlay
    // `enable` window controls visibility. `eof_action=pass` keeps the base going.
    format!(
        "[{input_idx}:v]scale={sz}:{sz},setsar=1[badge{k}];\
         [{in_label}][badge{k}]overlay=x={x}:y={y}:eof_action=pass:\
         enable='between(t,{at:.3},{end:.3})'[{out_label}]"
    )
}

/// Build the video-filter fragment pasting one REAL comment crop screenshot at the
/// comment-card zone (top-centre), shown only during `[at, at+dur]`. The crop is scaled
/// to the card width; its height follows the crop's own aspect ratio. Used instead of the
/// synthetic drawn card when `CommentCard::has_crop()` (see `comment_card.rs`).
fn build_comment_image_overlay(
    input_idx: usize,
    k: usize,
    card: &super::comment_card::CommentCard,
    clip_w: u32,
    clip_h: u32,
    in_label: &str,
    out_label: &str,
) -> String {
    let at  = card.at_sec.max(0.0);
    let end = at + card.duration_sec.max(0.3);
    let (_cx, cy, cw) = card.card_rect(clip_w, clip_h);
    format!(
        "[{input_idx}:v]scale={cw}:-2,setsar=1[cm{k}];\
         [{in_label}][cm{k}]overlay=x=(W-w)/2:y={cy}:eof_action=pass:\
         enable='between(t,{at:.3},{end:.3})'[{out_label}]"
    )
}

/// Build the video-filter fragment pasting a REAL profile-card crop screenshot at the
/// profile-card zone (lower-third), shown only during `[at, at+dur]`. Scaled to the card
/// width; height follows the crop's aspect. Used instead of the synthetic drawn card when
/// `ProfileCard::has_crop()` (see `profile_card.rs`).
fn build_profile_image_overlay(
    input_idx: usize,
    card: &super::profile_card::ProfileCard,
    clip_w: u32,
    clip_h: u32,
    in_label: &str,
    out_label: &str,
) -> String {
    let at  = card.at_sec.max(0.0);
    let end = at + card.duration_sec.max(0.3);
    let (_cx, cy, cw) = card.card_rect(clip_w, clip_h);
    format!(
        "[{input_idx}:v]scale={cw}:-2,setsar=1[pf];\
         [{in_label}][pf]overlay=x=(W-w)/2:y={cy}:eof_action=pass:\
         enable='between(t,{at:.3},{end:.3})'[{out_label}]"
    )
}

/// Build the video-filter fragment overlaying the full-frame hook-title PNG
/// (Pillow-rendered) at 0,0, faded in/out over `[0, duration_sec]`.
///
/// The PNG is already canvas-sized with the text baked at the right position, so
/// the overlay needs no geometry — only an alpha fade and the enable window. A
/// short scale "pop" (110%→100%) gives the same scroll-stopper bounce the ASS
/// path had, anchored at the frame centre.
fn build_headline_png_overlay(
    input_idx: usize,
    hl: &HeadlineImage,
    in_label: &str,
    out_label: &str,
) -> String {
    let dur      = hl.duration_sec.max(0.4);
    let fade_in  = 0.18_f64.min(dur / 3.0);
    let fade_out = 0.30_f64.min(dur / 3.0);
    let out_st   = (dur - fade_out).max(0.0);
    format!(
        "[{input_idx}:v]format=rgba,setsar=1,\
         fade=t=in:st=0:d={fade_in:.3}:alpha=1,\
         fade=t=out:st={out_st:.3}:d={fade_out:.3}:alpha=1[hlp];\
         [{in_label}][hlp]overlay=x=0:y=0:eof_action=pass:\
         enable='between(t,0,{dur:.3})'[{out_label}]"
    )
}

/// Build the video-filter fragment overlaying the OPAQUE full-screen AI cover at
/// 0,0 for `[0, duration_sec]`, then dissolving to the footage.
///
/// The cover is shown solid from frame 0 (no fade-in — it IS the opening frame),
/// with a slow Ken-Burns zoom for life, and an alpha fade-out over the last ~0.4s
/// so it cross-dissolves into the running footage underneath. Placed as the
/// ABSOLUTE topmost layer (after the subtitle burn) so it hides everything during
/// the hook window.
fn build_cover_overlay(
    input_idx: usize,
    cov: &HeadlineImage,
    canvas_w: u32,
    canvas_h: u32,
    in_label: &str,
    out_label: &str,
) -> String {
    let dur      = cov.duration_sec.max(0.4);
    let fade_out = 0.40_f64.min(dur / 3.0);
    let out_st   = (dur - fade_out).max(0.0);
    // Slow zoom-in (Ken Burns): 100% → ~108% across the cover window. zoompan runs
    // at 25 fps over `dur` frames, scaling back to the canvas each frame.
    let frames   = ((dur * 25.0).round() as i64).max(1);
    format!(
        "[{input_idx}:v]scale={canvas_w}:{canvas_h}:force_original_aspect_ratio=increase,\
         crop={canvas_w}:{canvas_h},\
         zoompan=z='min(zoom+0.0009,1.08)':d={frames}:s={canvas_w}x{canvas_h}:fps=25,\
         format=rgba,setsar=1,\
         fade=t=out:st={out_st:.3}:d={fade_out:.3}:alpha=1[cov];\
         [{in_label}][cov]overlay=x=0:y=0:eof_action=pass:\
         enable='between(t,0,{dur:.3})'[{out_label}]"
    )
}

/// Seek, reframe, burn subtitles, and encode — single pass with **perfect subtitle sync**.
///
/// ## The subtitle-sync problem
///
/// The subtitle (`subtitles=file.ass`) filter matches events by **filtergraph timestamp**.
/// The ASS file contains events at 0 s, 0.18 s, 1.05 s … (relative to clip start).
///
/// ### Why `-ss` before `-i` (input fast-seek) breaks sync
/// Input fast-seek lands on the nearest *keyframe* before `start_sec`, e.g. 237 s.
/// Without timestamp correction, the filtergraph sees 237 s, 238 s, 239 s … so the
/// ASS events at 0–30 s never fire → no subtitles.
/// With `-avoid_negative_ts make_zero`, timestamps become 0, 1, 2 … but "0" is
/// 237 s content, not 239 s → subtitles appear 2 s early.
///
/// ### Why `-ss` after `-i` (output seek) breaks sync
/// Output seek does not shift filtergraph timestamps: the filter still sees 239 s, 240 s…
/// while ASS events are at 0 s → no subtitles.
///
/// ### The fix: `trim` + `setpts` inside the filtergraph
///
/// ```
/// -ss (start-10)   ← fast seek for performance (10 s before target)
/// -i source
/// -vf "trim=start=S:end=E, setpts=PTS-STARTPTS, [layout filters], subtitles=file.ass"
/// -af "atrim=start=S:end=E, asetpts=PTS-STARTPTS"
/// ```
///
/// 1. `trim=start=S:end=E`   — passes only frames from S to E (absolute source timestamps)
/// 2. `setpts=PTS-STARTPTS`  — resets timestamps so that S→0, S+1→1, …
/// 3. `subtitles=file.ass`   — sees 0-based timestamps, ASS events match ✓
/// 4. `atrim` + `asetpts`    — same for audio, guarantees A/V sync ✓
///
/// Result: output timestamp 0 = source content at exactly `start_sec`.
/// Subtitle timestamps (`word_time − start_sec`) are frame-accurate.
/// Seek, reframe, burn subtitles, encode — and optionally prepend an intro banner card.
///
/// When `intro` is `Some`, the command uses three lavfi/file inputs and a
/// `filter_complex` that concatenates the intro card with the main clip:
///
/// ```
/// Inputs:
///   [0] lavfi color=…     → intro background (dark card)
///   [1] lavfi anullsrc=…  → intro silence
///   [2] source.mp4        → main video (fast-seek applied)
///
/// filter_complex:
///   [0:v] {intro_vf} [intro_v]
///   [1:a] atrim=duration=… [intro_a]
///   [2:v] {main_vf}  [main_v]
///   [2:a] {main_af}  [main_a]
///   [intro_v][intro_a][main_v][main_a] concat=n=2:v=1:a=1 [outv][outa]
/// ```
///
/// When `intro` is `None`, a simple `-vf / -af` command is used (same as before).
pub async fn encode_clip_direct(
    execution: &JobExecutionContext,
    source: &Path,
    start_sec: f64,
    end_sec: f64,
    ass_path: &Path,
    layout: &OutputLayout,
    output: &Path,
    cfg: &FfmpegConfig,
    _intro: Option<&()>,  // reserved for future use
    audio: &AudioOptions,
) -> Result<(), EditError> {
    let fast_seek = (start_sec - SEEK_MARGIN_SECS).max(0.0);
    let duration  = end_sec - start_sec;
    let rel_start = start_sec - fast_seek;   // position within the fast-seeked stream
    let rel_end   = end_sec   - fast_seek;   // = rel_start + duration

    // Montage paper-canvas input is appended LAST among inputs, so its index
    // equals the count of every input added before it (source + sfx/bgm/overlay/
    // news/cues/memes). Compute it here so build_video_filter can reference it.
    let paper_idx = {
        let has_sfx     = audio.sfx_intro.is_some();
        let has_bgm     = audio.bgm.is_some();
        let has_overlay = audio.overlay.is_some();
        let has_news    = audio.news_overlay.as_ref().map(|n| n.path.exists()).unwrap_or(false);
        let n_cues      = audio.asset_sfx_cues.iter()
            .filter(|c| c.path.exists() && c.at_sec < duration).count();
        let n_memes     = audio.meme_cues.iter()
            .filter(|m| m.path.exists() && m.at_sec < duration).count();
        1 + has_sfx as usize + has_bgm as usize + has_overlay as usize
            + has_news as usize + n_cues + n_memes
    };
    let anim_arg = audio.montage.as_ref().map(|a| (a, paper_idx));
    // Narration is appended AFTER paper → its index sits one past the paper slot.
    let narration_idx = paper_idx + audio.montage.is_some() as usize;

    let main_vf = build_video_filter(
        layout, ass_path, rel_start, rel_end,
        &audio.clip_style,
        audio.headline.as_ref(),
        &audio.font,
        audio.social_icon.as_ref(),
        audio.clip_bpm,   // 0.0 = default durations; >0 = beat-aligned
        audio.hook_title_ass.as_deref(),
        audio.profile_card.as_ref(),
        &audio.callouts,
        &audio.comment_cards,
        anim_arg,
        true,   // defer subtitle burn → re-applied LAST as the topmost layer
    );
    // Subtitle + hook burn-in, applied as the ABSOLUTE topmost layer so footage
    // cards / image cards / meme PiPs / crops never cover the captions.
    let sub_suffix = subtitle_burn_suffix(ass_path, audio.hook_title_ass.as_deref(), &audio.font);
    let (vcodec, extra_args) = build_encoder(cfg);

    const FADE_DUR: f64 = 0.5;
    let fade_out_start = (duration - FADE_DUR).max(0.0);

    // ── NORMALIZE all audio to 48000 Hz stereo ────────────────────────────────
    // Root cause of noise: sample rate mismatch between video audio (YouTube
    // typically 48000 Hz) and SFX/BGM files (often 44100 Hz).  All audio streams
    // must be resampled to the SAME rate before mixing.
    // Using swr resampler with async=1 prevents click/pop at loop boundaries.
    const AR: u32 = 48_000; // target sample rate for all audio
    const NORMALIZE: &str = "aresample=48000:resampler=swr:async=1:first_pts=0,\
                              aformat=sample_fmts=fltp:channel_layouts=stereo";

    // Main clip voice: trim → normalize → fade
    let main_af = format!(
        "atrim=start={rel_start:.3}:end={rel_end:.3},\
         asetpts=PTS-STARTPTS,\
         {NORMALIZE},\
         afade=t=in:st=0:d={FADE_DUR:.3},\
         afade=t=out:st={fade_out_start:.3}:d={FADE_DUR:.3}"
    );

    // ── Resolve audio/overlay options ────────────────────────────────────────
    let has_sfx        = audio.sfx_intro.is_some();
    let has_bgm        = audio.bgm.is_some();
    let has_overlay    = audio.overlay.is_some();
    let has_news_image = audio.news_overlay.as_ref()
        .map(|n| n.path.exists())
        .unwrap_or(false);
    // Timestamped SFX cues (catalog) — keep only existing files within the clip.
    let cue_audio: Vec<&AssetSfxCue> = audio.asset_sfx_cues
        .iter()
        .filter(|c| c.path.exists() && c.at_sec < duration)
        .collect();
    let has_cue_audio = !cue_audio.is_empty();
    // Timestamped meme PiP cues — keep only existing files that fall inside the clip.
    let meme_cues: Vec<&MemeCue> = audio.meme_cues
        .iter()
        .filter(|m| m.path.exists() && m.at_sec < duration)
        .collect();
    let has_meme = !meme_cues.is_empty();
    let bgm_vol = if audio.bgm_volume <= 0.0 { 0.12_f32 } else { audio.bgm_volume };

    if has_sfx { info!("intro SFX: {}", audio.sfx_intro.as_ref().unwrap().display()); }
    if has_bgm { info!("BGM: {} vol={:.0}%", audio.bgm.as_ref().unwrap().display(), bgm_vol * 100.0); }
    if has_overlay {
        let ov = audio.overlay.as_ref().unwrap();
        info!("overlay: {} at t={:.1}s for {:.1}s",
              ov.path.file_name().unwrap_or_default().to_string_lossy(),
              ov.at_sec, ov.duration_sec);
    }
    if has_news_image {
        let n = audio.news_overlay.as_ref().unwrap();
        info!("news image overlay: {} at t={:.1}s for {:.1}s  ken_burns={}",
              n.path.file_name().unwrap_or_default().to_string_lossy(),
              n.at_sec, n.duration_sec, n.ken_burns);
    }
    if has_cue_audio {
        for c in &cue_audio {
            info!("sfx cue: {} at t={:.1}s for {:.1}s",
                  c.path.file_name().unwrap_or_default().to_string_lossy(),
                  c.at_sec, c.duration_sec);
        }
    }
    if has_meme {
        for m in &meme_cues {
            info!("meme cue: {} at t={:.1}s for {:.1}s ({})",
                  m.path.file_name().unwrap_or_default().to_string_lossy(),
                  m.at_sec, m.duration_sec,
                  if m.fullscreen { "full-screen" } else { m.position.as_str() });
        }
    }

    // Clip output dimensions (used by overlay scale filter)
    let (clip_w, clip_h) = match layout {
        OutputLayout::Vertical   => (1080u32, 1920u32),
        OutputLayout::Horizontal => (1920u32, 1080u32),
        OutputLayout::Square     => (1080u32, 1080u32),
    };

    // intro card removed — `_intro` parameter reserved for future use
    let mut args: Vec<String> = {
        // ── MAIN CLIP (no intro card) ─────────────────────────────────────────
        //
        // SFX (if provided) is mixed at the start of the clip:
        //   - Play once at full volume, fade out after sfx_dur seconds
        //   - Overlaid on top of the voice audio (not replacing it)
        //
        // Input assignments:
        //   [0]       = source video (always)
        //   [1]       = SFX file (if sfx_intro provided)
        //   [1|2]     = BGM file (if bgm provided, index depends on sfx)
        //   [1|2|3]   = overlay video (if overlay provided)
        //   [last]    = news image PNG (if news_overlay provided, always last)
        if has_sfx || has_bgm || has_overlay || has_news_image || has_cue_audio || has_meme
            || audio.montage.is_some() || audio.narration.is_some()
            || !audio.footage_cards.is_empty() || !audio.image_badges.is_empty()
            || !audio.image_cards.is_empty()
            || audio.comment_cards.iter().any(|c| c.has_crop())
            || audio.profile_card.as_ref().map(|p| p.has_crop()).unwrap_or(false)
            || audio.hook_title_png.is_some()
            || audio.cover.is_some()
        {
            // Input index calculations
            let sfx_idx     = if has_sfx { Some(1usize) } else { None };
            let bgm_idx     = if has_bgm { Some(1 + has_sfx as usize) } else { None };
            let overlay_idx = if has_overlay { Some(1 + has_sfx as usize + has_bgm as usize) } else { None };
            let news_img_idx = if has_news_image {
                Some(1 + has_sfx as usize + has_bgm as usize + has_overlay as usize)
            } else { None };
            // Extra cue inputs come LAST, in order: SFX cues, then meme videos.
            let cue_base_idx = 1 + has_sfx as usize + has_bgm as usize
                + has_overlay as usize + has_news_image as usize;
            let meme_base_idx = cue_base_idx + cue_audio.len();
            // Memes whose own audio is mixed in (and that duck the narration).
            let meme_audio: Vec<(usize, &MemeCue)> = meme_cues.iter().enumerate()
                .filter(|(_, m)| m.with_audio)
                .map(|(k, m)| (meme_base_idx + k, *m))
                .collect();

            // Build video filter string.
            // If news image overlay exists: the base filter ends with [pre_news_v]
            // and we chain the news filter on top to produce [outv].
            let base_out_label = if has_news_image { "pre_news_v" } else { "outv" };

            let base_video_filter = if let (true, Some(ov_i), Some(ov)) =
                (has_overlay, overlay_idx, &audio.overlay)
            {
                // Build overlay filter and redirect its [outv] to [pre_news_v] when needed
                let f = build_overlay_filter(ov_i, ov, &main_vf, clip_w, clip_h);
                if has_news_image { f.replace("[outv]", "[pre_news_v]") } else { f }
            } else {
                format!("[0:v]{main_vf}[{base_out_label}]")
            };

            let video_filter_str = if let (Some(ni), Some(news)) = (news_img_idx, &audio.news_overlay) {
                let news_filter = build_news_image_filter(ni, news, base_out_label, clip_w, clip_h);
                format!("{base_video_filter};{news_filter}")
            } else {
                base_video_filter
            };

            // Chain montage FOOTAGE CARDS (narrator-driven) — centred clips cutting
            // over the base B-roll. Inputs sit AFTER narration. Memes (below) chain
            // on top of these.
            let fc_base_idx = narration_idx + audio.narration.is_some() as usize;
            let fc_cues: Vec<&FootageCardCue> = audio.footage_cards.iter()
                .filter(|c| c.path.exists() && c.at_sec < duration).collect();
            let video_filter_str = if !fc_cues.is_empty() {
                let mut s = video_filter_str.replacen("[outv]", "[fc_in]", 1);
                let mut cur = "fc_in".to_string();
                let last = fc_cues.len() - 1;
                for (k, c) in fc_cues.iter().enumerate() {
                    let out = if k == last { "outv".to_string() } else { format!("fcx{}", k + 1) };
                    s.push(';');
                    s.push_str(&build_footage_card_overlay(fc_base_idx + k, k, c, clip_w, &cur, &out));
                    cur = out;
                }
                s
            } else {
                video_filter_str
            };

            // Chain montage IMAGE CARDS (static cropped post screenshots) — same
            // centred-card role as the footage cards, but looped-still inputs. Their
            // inputs are appended right after the footage cards, so indices start at
            // `fc_base_idx + fc_cues.len()`.
            let ic_base_idx = fc_base_idx + fc_cues.len();
            let ic_cues: Vec<&ImageCardCue> = audio.image_cards.iter()
                .filter(|c| c.path.exists() && c.at_sec < duration).collect();
            let video_filter_str = if !ic_cues.is_empty() {
                let mut s = video_filter_str.replacen("[outv]", "[ic_in]", 1);
                let mut cur = "ic_in".to_string();
                let last = ic_cues.len() - 1;
                for (k, c) in ic_cues.iter().enumerate() {
                    let out = if k == last { "outv".to_string() } else { format!("icx{}", k + 1) };
                    s.push(';');
                    s.push_str(&build_image_card_overlay(ic_base_idx + k, k, c, clip_w, &cur, &out));
                    cur = out;
                }
                s
            } else {
                video_filter_str
            };

            // Chain meme PiP overlays onto the video tail. The current graph ends at
            // a single [outv]; rename it to [vm_in] and feed it through the memes.
            let video_filter_str = if has_meme {
                let mut s = video_filter_str.replacen("[outv]", "[vm_in]", 1);
                let mut cur = "vm_in".to_string();
                let last = meme_cues.len() - 1;
                for (k, m) in meme_cues.iter().enumerate() {
                    let out = if k == last { "outv".to_string() } else { format!("vm{}", k + 1) };
                    s.push(';');
                    s.push_str(&build_meme_overlay_filter(meme_base_idx + k, k, m, clip_w, clip_h, &cur, &out));
                    cur = out;
                }
                s
            } else {
                video_filter_str
            };

            // Chain real avatar IMAGE BADGES onto the video tail (LAST, so photos
            // sit on top of the drawn cards). Inputs are appended after the footage
            // AND image cards, so their indices start past both pools.
            let badge_base_idx = ic_base_idx + ic_cues.len();
            let badges: Vec<&ImageBadgeCue> = audio.image_badges.iter()
                .filter(|b| b.path.exists() && b.at_sec < duration).collect();
            let video_filter_str = if !badges.is_empty() {
                let mut s = video_filter_str.replacen("[outv]", "[bdg_in]", 1);
                let mut cur = "bdg_in".to_string();
                let last = badges.len() - 1;
                for (k, b) in badges.iter().enumerate() {
                    let out = if k == last { "outv".to_string() } else { format!("bdg{}", k + 1) };
                    s.push(';');
                    s.push_str(&build_image_badge_overlay(badge_base_idx + k, k, b, &cur, &out));
                    cur = out;
                }
                s
            } else {
                video_filter_str
            };

            // Chain REAL comment-crop screenshots LAST of all — paste the actual TikTok
            // comment card (replacing the synthetic one, which build_comment_filter skipped
            // for these). Inputs appended after the avatar badges → start past every pool.
            let cm_base_idx = badge_base_idx + badges.len();
            let cm_cards: Vec<&super::comment_card::CommentCard> = audio.comment_cards.iter()
                .filter(|c| c.has_crop() && c.at_sec < duration).collect();
            let video_filter_str = if !cm_cards.is_empty() {
                let mut s = video_filter_str.replacen("[outv]", "[cm_in]", 1);
                let mut cur = "cm_in".to_string();
                let last = cm_cards.len() - 1;
                for (k, c) in cm_cards.iter().enumerate() {
                    let out = if k == last { "outv".to_string() } else { format!("cmx{}", k + 1) };
                    s.push(';');
                    s.push_str(&build_comment_image_overlay(cm_base_idx + k, k, c, clip_w, clip_h, &cur, &out));
                    cur = out;
                }
                s
            } else {
                video_filter_str
            };

            // Chain the REAL profile-card crop ABSOLUTELY LAST (after comment crops). Pasted at
            // the lower-third profile zone, replacing the synthetic card (build_profile_filter
            // skipped it). Its input is appended after the comment crops → matches pf_base_idx.
            let pf_base_idx = cm_base_idx + cm_cards.len();
            let pf_card: Option<&super::profile_card::ProfileCard> = audio.profile_card.as_ref()
                .filter(|p| p.has_crop() && p.at_sec < duration);
            let video_filter_str = if let Some(pf) = pf_card {
                let mut s = video_filter_str.replacen("[outv]", "[pf_in]", 1);
                s.push(';');
                s.push_str(&build_profile_image_overlay(pf_base_idx, pf, clip_w, clip_h, "pf_in", "outv"));
                s
            } else {
                video_filter_str
            };

            // ── Hook-title PNG (Pillow) — full-frame overlay with fade ─────────
            // Appended AFTER the profile crop (last input) so its index is
            // pf_base_idx + (profile crop present). Fades in/out over its window.
            let hl_png_idx = pf_base_idx + pf_card.is_some() as usize;
            let video_filter_str = if let Some(hl) = &audio.hook_title_png {
                let mut s = video_filter_str.replacen("[outv]", "[hlp_in]", 1);
                s.push(';');
                s.push_str(&build_headline_png_overlay(hl_png_idx, hl, "hlp_in", "outv"));
                s
            } else {
                video_filter_str
            };

            // ── Subtitles ON TOP of everything ────────────────────────────────
            // Burn the captions (+ hook title) as the FINAL pass, after every
            // overlay above, so footage / image / meme / crop cutaways can never
            // cover them. Rename the chain's single final [outv] → [sub_in] and
            // feed it through the subtitle filter to a fresh [outv].
            let video_filter_str = {
                let mut s = video_filter_str.replacen("[outv]", "[sub_in]", 1);
                s.push_str(&format!(";[sub_in]{sub_suffix}[outv]"));
                s
            };

            // ── AI cover intro — ABSOLUTE topmost (even above subtitles) ───────
            // Opaque full-screen for the hook window, then dissolves to footage.
            // Input is appended after the hook-title PNG → cover_idx follows it.
            let cover_idx = hl_png_idx + audio.hook_title_png.is_some() as usize;
            let video_filter_str = if let Some(cov) = &audio.cover {
                let mut s = video_filter_str.replacen("[outv]", "[cov_in]", 1);
                s.push(';');
                s.push_str(&build_cover_overlay(cover_idx, cov, clip_w, clip_h, "cov_in", "outv"));
                s
            } else {
                video_filter_str
            };

            // ponytail: no `-hwaccel cuda`. Benchmarked to give no measurable speedup (decode ≪
            // the GPU-bound nvenc encode) and it adds a CUDA decode path that muddies the
            // overlay/loop frame timing implicated in the filtergraph deadlock. Not worth it.
            let mut a = vec!["-y".into()];
            // Loop the B-roll when the narration outlasts the source (Bug 6). Must precede `-i`.
            if audio.loop_source { a.extend(["-stream_loop".into(), "-1".into()]); }
            a.extend(["-ss".into(), format!("{fast_seek:.3}"),
                "-i".into(), source.to_string_lossy().to_string()]);

            // Add SFX input (plays once, no loop)
            if let Some(sfx_path) = &audio.sfx_intro {
                a.extend(["-i".into(), sfx_path.to_string_lossy().to_string()]);
            }
            // Add BGM input (looped at input level).
            // When bgm_start_offset_ms > 0, seek the file to the downbeat before looping.
            if let Some(bgm_path) = &audio.bgm {
                if audio.bgm_start_offset_ms > 0 {
                    let offset_sec = audio.bgm_start_offset_ms as f64 / 1000.0;
                    a.extend(["-ss".into(), format!("{offset_sec:.3}")]);
                }
                a.extend(["-stream_loop".into(), "-1".into(),
                          "-i".into(), bgm_path.to_string_lossy().to_string()]);
            }
            // Add overlay video input (no loop — plays once)
            if let Some(ov) = &audio.overlay {
                a.extend(["-i".into(), ov.path.to_string_lossy().to_string()]);
            }
            // Add news image PNG input (-loop 1 repeats the single frame as a video stream)
            if let Some(news) = &audio.news_overlay {
                a.extend(["-loop".into(), "1".into(),
                          "-i".into(), news.path.to_string_lossy().to_string()]);
            }
            // Add SFX cue inputs (play once each, no loop) — must stay AFTER news input
            // so the precomputed news_img_idx remains valid.
            for c in &cue_audio {
                a.extend(["-i".into(), c.path.to_string_lossy().to_string()]);
            }
            // Add meme PiP video inputs — must stay AFTER the SFX cue inputs so the
            // precomputed meme_base_idx remains valid.
            for m in &meme_cues {
                a.extend(["-i".into(), m.path.to_string_lossy().to_string()]);
            }
            // Montage paper-canvas — appended after every other input so its
            // index matches the precomputed `paper_idx`. Looped to clip length.
            if let Some(anim) = &audio.montage {
                a.extend(["-stream_loop".into(), "-1".into(),
                          "-i".into(), anim.paper_bg.to_string_lossy().to_string()]);
            }
            // Narration voiceover — appended after paper so its index matches the
            // precomputed `narration_idx`. Plays once (no loop).
            if let Some(narr) = &audio.narration {
                a.extend(["-i".into(), narr.mp3.to_string_lossy().to_string()]);
            }
            // Montage footage-card inputs — appended after narration so they match
            // `fc_base_idx`. Same filter applied at the filtergraph level.
            for c in &fc_cues {
                a.extend(["-i".into(), c.path.to_string_lossy().to_string()]);
            }
            // Montage image-card inputs — appended after the footage cards so they
            // match `ic_base_idx`. `-loop 1` turns each still into a video stream the
            // centred overlay can sample throughout its enable window.
            for c in &ic_cues {
                a.extend(["-loop".into(), "1".into(),
                          "-i".into(), c.path.to_string_lossy().to_string()]);
            }
            // Real avatar image-badge inputs — appended after the card pools so they
            // match `badge_base_idx`. `-loop 1` turns the single still into a video
            // stream the overlay can sample at any timestamp inside the enable window.
            for b in &badges {
                a.extend(["-loop".into(), "1".into(),
                          "-i".into(), b.path.to_string_lossy().to_string()]);
            }
            // Real comment-crop inputs — appended ABSOLUTELY LAST so they match
            // `cm_base_idx`. `-loop 1` turns each crop PNG into a samplable video stream.
            for c in &cm_cards {
                a.extend(["-loop".into(), "1".into(),
                          "-i".into(), c.image_path.clone()]);
            }
            // Real profile-card crop — appended after the comment crops so it matches
            // `pf_base_idx`. `-loop 1` turns the crop PNG into a samplable video stream.
            if let Some(pf) = audio.profile_card.as_ref().filter(|p| p.has_crop() && p.at_sec < duration) {
                a.extend(["-loop".into(), "1".into(), "-i".into(), pf.image_path.clone()]);
            }
            // Hook-title PNG — appended after the profile crop so it matches `hl_png_idx`.
            // `-loop 1` turns the still PNG into a video stream for the overlay.
            if let Some(hl) = &audio.hook_title_png {
                a.extend(["-loop".into(), "1".into(),
                          "-i".into(), hl.path.to_string_lossy().to_string()]);
            }
            // AI cover PNG — appended ABSOLUTELY LAST so it matches `cover_idx`.
            if let Some(cov) = &audio.cover {
                a.extend(["-loop".into(), "1".into(),
                          "-i".into(), cov.path.to_string_lossy().to_string()]);
            }

            // Build audio filter chain
            // Step 1: process main voice — duck it under each meme-audio window so
            // the meme sound (boom/scream/etc.) cuts through without losing speech.
            let voice_duck = {
                let mut d = String::new();
                for (_, m) in &meme_audio {
                    let at  = m.at_sec.max(0.0);
                    let end = at + m.duration_sec.clamp(0.5, 6.0);
                    d.push_str(&format!(
                        ",volume=enable='between(t,{at:.3},{end:.3})':volume=0.50"
                    ));
                }
                d
            };
            // Voice spine: narration (if any) is PRIMARY and the event audio is
            // ducked underneath it; otherwise the event audio IS the voice.
            let mut af = if let Some(narr) = &audio.narration {
                let duck = narr.duck_event_vol.clamp(0.0, 1.0);
                // Dynamic ducking: event sits at `duck` while the narrator talks and
                // rises to `leak_vol` during narration pauses (it "breathes through").
                let evt_vol = if narr.leak_windows.is_empty() {
                    format!("volume={duck:.3}")
                } else {
                    let leak = narr.leak_vol.clamp(duck, 1.0);
                    // commas inside the volume expression must be escaped in a filtergraph
                    let cond = narr.leak_windows.iter()
                        .map(|(s, e)| format!("between(t\\,{s:.2}\\,{e:.2})"))
                        .collect::<Vec<_>>()
                        .join("+");
                    format!("volume='if(gt({cond}\\,0)\\,{leak:.3}\\,{duck:.3})':eval=frame")
                };
                // Lead-in: delay the narrator so the event audio plays loud first.
                let lead = if narr.lead_in_secs > 0.01 {
                    let ms = (narr.lead_in_secs * 1000.0) as u64;
                    format!(",adelay={ms}|{ms}")
                } else { String::new() };
                format!(
                    "[{narration_idx}:a]{NORMALIZE},afade=t=in:st=0:d=0.15{lead}{voice_duck}[voice];\
                     [0:a]atrim=start={rel_start:.3}:end={rel_end:.3},asetpts=PTS-STARTPTS,\
                     {NORMALIZE},{evt_vol}[evt]"
                )
            } else {
                format!("[0:a]{main_af}{voice_duck}[voice]")
            };

            // Step 2: process SFX (play once at the configured moment)
            // Supports two timing mechanisms (combined when both active):
            //   1. sfx_beat_offset_ms  — snap to BGM downbeat (beat_sync mode)
            //   2. sfx_at_ms           — delay SFX to peak moment inside clip
            //      (LLM sets sfx_at_sec; e.g. play impact at stat reveal t=8s not t=0)
            let sfx_dur = audio.sfx_duration_sec.clamp(0.5, 5.0).min(duration);
            let sfx_fade_out = (sfx_dur - 0.5).max(0.1);
            if let Some(si) = sfx_idx {
                // Combine beat-sync offset + explicit peak-moment delay
                let sfx_at_ms    = (audio.sfx_at_sec * 1000.0) as u64;
                let beat_off_ms  = audio.sfx_beat_offset_ms as u64;
                let total_delay_ms = sfx_at_ms + beat_off_ms;

                let sfx_delay_filter = if total_delay_ms > 0 {
                    format!("adelay={total_delay_ms}|{total_delay_ms},")
                } else {
                    String::new()
                };
                af.push_str(&format!(
                    ";[{si}:a]{sfx_delay_filter}{NORMALIZE},\
                     atrim=duration={sfx_dur:.3},asetpts=PTS-STARTPTS,\
                     apad=pad_dur={duration:.3},\
                     afade=t=in:st=0:d=0.200,\
                     afade=t=out:st={sfx_fade_out:.3}:d=0.500,\
                     volume=0.80\
                     [sfx_out]"
                ));
            }

            // Step 3: process BGM
            // When beat_sync ducking is enabled, volume expression lowers BGM during
            // the speech portion of the clip (t=1.5s → clip_end−1.0s).
            if let Some(bi) = bgm_idx {
                let duck_filter = if audio.bgm_duck && duration > 3.0 {
                    let duck_start = 1.5_f64;
                    let duck_end   = (duration - 1.0).max(duck_start + 0.5);
                    let duck_vol   = (bgm_vol * 0.35_f32).max(0.02_f32); // ~−9 dB during speech
                    // Two volume filters: one for the duck region, one for normal regions
                    format!(
                        ",volume=enable='between(t,{duck_start:.1},{duck_end:.1})':volume={duck_vol:.4},\
                         volume=enable='not(between(t,{duck_start:.1},{duck_end:.1}))':volume={bgm_vol:.4}"
                    )
                } else {
                    format!(",volume={bgm_vol:.4}")
                };

                af.push_str(&format!(
                    ";[{bi}:a]{NORMALIZE},\
                     atrim=duration={duration:.3},asetpts=PTS-STARTPTS\
                     {duck_filter}\
                     [bgm_out]"
                ));
            }

            // Step 3b: process each timestamped SFX cue → [cueK]
            // NORMALIZE → trim to its duration → fades → volume → delay to at_sec.
            // amix (duration=first) zero-pads the tail back to clip length.
            for (k, c) in cue_audio.iter().enumerate() {
                af.push_str(&build_cue_audio_filter(cue_base_idx + k, k, c, duration, NORMALIZE));
            }

            // Step 3c: process meme audio (for memes with their own sound) → [memeaJ]
            for (j, (idx, m)) in meme_audio.iter().enumerate() {
                let vol = if m.audio_volume <= 0.0 { 0.90_f32 } else { m.audio_volume };
                af.push_str(&build_delayed_audio_filter(
                    *idx, &format!("memea{j}"),
                    m.at_sec, m.duration_sec, vol, duration, NORMALIZE,
                ));
            }

            // Step 4: mix all audio streams (voice + optional sfx/bgm + cues + meme audio)
            let mut mix_labels: Vec<String> = vec!["[voice]".into()];
            // Ducked event audio (only present in narration mode).
            if audio.narration.is_some() { mix_labels.push("[evt]".into()); }
            if sfx_idx.is_some() { mix_labels.push("[sfx_out]".into()); }
            if bgm_idx.is_some() { mix_labels.push("[bgm_out]".into()); }
            for k in 0..cue_audio.len() { mix_labels.push(format!("[cue{k}]")); }
            for j in 0..meme_audio.len() { mix_labels.push(format!("[memea{j}]")); }
            let mix_count = mix_labels.len();

            if mix_count > 1 {
                af.push_str(&format!(
                    ";{inputs}amix=inputs={mix_count}:duration=first:\
                     normalize=0:weights='{weights}'\
                     [outa]",
                    inputs = mix_labels.concat(),
                    weights = "1 ".repeat(mix_count).trim_end()
                ));
            } else {
                af.push_str(";[voice]aformat=sample_fmts=fltp:channel_layouts=stereo[outa]");
            }

            // Multithreaded filtergraph. This USED to deadlock intermittently — many
            // Multithreaded filtergraph (default = ncpu). The "runaway render" hangs were
            // NEVER a threading bug — they were a CORRUPT `-loop 1` input image (a garbage
            // avatar download) that never emitted a frame, so the overlay consuming it
            // blocked forever. That's thread-count-independent: PROVEN 2026-07-07 when the
            // SAME corrupt comment_avatar_2.png hung both `-filter_complex_threads 28` AND
            // `1`. Fixed at the source (main.rs rejects non-image downloads + drops the
            // obsolete comment avatar), so multithreading is safe again and faster.
            // `THOTH_FILTER_THREADS` overrides the count; the run_ffmpeg watchdog stays as
            // the backstop for any other never-EOF input.
            let filter_threads = std::env::var("THOTH_FILTER_THREADS").ok()
                .and_then(|s| s.parse::<usize>().ok())
                .filter(|&n| n > 0)
                .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
            a.extend([
                "-filter_complex_threads".into(), filter_threads.to_string(),
                "-filter_complex".into(), format!("{video_filter_str};{af}"),
                "-map".into(), "[outv]".into(),
                "-map".into(), "[outa]".into(),
                // Hard output cap. The video (overlay shortest=1) and audio (amix
                // duration=first) are bounded INSIDE the filtergraph, but the
                // `-stream_loop -1` inputs (b-roll + paper-grid bg) never emit EOF —
                // without an output `-t` ffmpeg hangs forever at finalize (moov never
                // written). Mirrors the plain-branch/other render paths.
                "-t".into(), format!("{duration:.3}"),
                "-c:v".into(), vcodec]);
            a
        } else {
            // Plain — no audio effects, fastest path. Subtitles are still burned
            // last (topmost) for consistency with the overlay path.
            let mut a = vec!["-y".into()];
            if audio.loop_source { a.extend(["-stream_loop".into(), "-1".into()]); }
            a.extend([
                "-ss".into(), format!("{fast_seek:.3}"),
                "-i".into(), source.to_string_lossy().to_string(),
                "-vf".into(), format!("{main_vf},{sub_suffix}"),
                "-af".into(), main_af,
                "-t".into(), format!("{duration:.3}"),
                "-c:v".into(), vcodec]);
            a
        }
    }; // end args

    args.extend(extra_args);
    args.extend([
        "-c:a".into(), "aac".into(),
        "-b:a".into(), cfg.audio_bitrate.clone(),
        "-ac".into(),  "2".into(),
        "-movflags".into(), "+faststart".into(),
        output.to_string_lossy().to_string(),
    ]);

    debug!("encode_clip_direct: ffmpeg {}", args.join(" "));
    run_ffmpeg(execution, &args).await
}

/// Build the subtitle (+ hook title) burn-in filter chain, with NO leading comma.
///
/// Returns e.g. `subtitles='clip.ass':fontsdir=…,subtitles='clip.hook.ass':fontsdir=…`.
/// Applied as the ABSOLUTE topmost layer by [`encode_clip_direct`] — after every
/// footage / image / meme / crop overlay — so captions are never covered. The hook
/// pass (if any) follows the main pass so the giant title stays on top of the body
/// subtitles, exactly as before the layering fix.
fn subtitle_burn_suffix(ass_path: &Path, hook_ass: Option<&Path>, font: &FontConfig) -> String {
    let ass_str = ass_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");
    let fontsdir_opt = font.fontsdir_opt();
    let mut s = format!("subtitles='{ass_str}'{fontsdir_opt}");
    if let Some(p) = hook_ass {
        let h = p.to_string_lossy().replace('\\', "/").replace(':', "\\:");
        s.push_str(&format!(",subtitles='{h}'{fontsdir_opt}"));
    }
    s
}

/// Build the video filtergraph string.
///
/// Prepends `trim=start:end, setpts=PTS-STARTPTS` so that:
/// - only frames from [start_sec, end_sec] are processed
/// - timestamps are reset to 0-based before the subtitle filter
///
/// The headline overlay (if provided) is appended AFTER the subtitle filter,
/// so it sits on top and visually covers the subtitle area during display.
fn build_video_filter(
    layout:   &OutputLayout,
    ass_path: &Path,
    start_sec: f64,
    end_sec:   f64,
    style:    &ClipStyle,
    headline: Option<&HeadlineOverlay>,
    font:     &FontConfig,
    icon:     Option<&SocialIcon>,
    bpm:      f32,   // 0.0 = use default durations; >0 = beat-aligned durations
    hook_ass: Option<&Path>,
    profile:  Option<&super::profile_card::ProfileCard>,
    callouts: &[super::callout::Callout],
    comments: &[super::comment_card::CommentCard],
    // Montage composite: (render directive, paper-bg input index). When set,
    // vertical clips render the footage as a centred card on the paper canvas.
    anim:     Option<(&MontageRender, usize)>,
    // When true, the subtitle + hook burn-in is OMITTED here so the caller can
    // re-apply it as the ABSOLUTE topmost layer — after every footage / image /
    // meme / crop overlay. This keeps captions always readable on top of cutaways.
    // See `subtitle_burn_suffix` and `encode_clip_direct`.
    defer_subs: bool,
) -> String {
    // Subtitle + hook fragment (`subs`) is comma-LEADING-or-empty, matching the
    // convention of every other effect fragment (headline/profile/callout/comment/
    // post). When deferred it is empty and the caller burns it last instead.
    let subs = if defer_subs {
        String::new()
    } else {
        let ass_str = ass_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace(':', "\\:");
        // Include fontsdir so FFmpeg finds the custom font for ASS subtitles
        let fontsdir_opt = font.fontsdir_opt();
        // Second subtitles pass for the giant multi-colour hook title (on top).
        let hook = hook_ass
            .map(|p| {
                let s = p.to_string_lossy().replace('\\', "/").replace(':', "\\:");
                format!(",subtitles='{s}'{fontsdir_opt}")
            })
            .unwrap_or_default();
        format!(",subtitles='{ass_str}'{fontsdir_opt}{hook}")
    };

    let duration = end_sec - start_sec;
    let trim = format!("trim=start={start_sec:.3}:end={end_sec:.3},setpts=PTS-STARTPTS");

    // ── Canvas dimensions ─────────────────────────────────────────────────────
    let (w, h) = match layout {
        OutputLayout::Vertical   => (1080u32, 1920u32),
        OutputLayout::Horizontal => (1920u32, 1080u32),
        OutputLayout::Square     => (1080u32, 1080u32),
    };

    // ── Transition filters ────────────────────────────────────────────────────
    // When bpm > 0, durations snap to beat subdivisions for musical alignment.
    let out_offset     = style.fade_out_dur(bpm);
    let fade_out_start = (duration - out_offset).max(0.0);

    let in_fx  = style.in_filter(duration, w, h, bpm);
    let out_fx = style.out_filter(fade_out_start, bpm);

    let (pre_filter, post_filter) = match style {
        ClipStyle::None => (String::new(), String::new()),
        ClipStyle::Zoom => (format!("{},", in_fx), format!(",{}", out_fx)),
        _ => (
            if in_fx.is_empty() { String::new() } else { format!("{},", in_fx) },
            if out_fx.is_empty() { String::new() } else { format!(",{}", out_fx) },
        ),
    };
    // Leading-comma forms of the transition filters, for the Horizontal/Square
    // templates where every post-scale fragment carries its own leading comma.
    let in_fx_lead = if in_fx.is_empty() { String::new() } else { format!(",{in_fx}") };

    // ── Headline overlay ──────────────────────────────────────────────────────
    // Pass the clip style so the panel entrance/exit animation matches the video.
    let hl_filter = headline
        .map(|c| build_headline_filter(c, w, h, font, icon, style, bpm))
        .unwrap_or_default();

    // ── Beat-2 character intro (profile card + name above head) ───────────────
    let profile_filter = profile
        .map(|c| super::profile_card::build_profile_filter(c, w, h))
        .unwrap_or_default();

    // ── Beat-3 number callouts (figure + arrow) ───────────────────────────────
    let callout_filter = super::callout::build_callout_filter(callouts, w, h);

    // ── Reaction-beat viral comment cards (screenshot style) ──────────────────
    // Each card carries its own enable window; concatenate their filter fragments.
    let comment_filter: String = comments
        .iter()
        .map(|c| super::comment_card::build_comment_filter(c, w, h))
        .collect();

    // ── Assemble the full filtergraph ─────────────────────────────────────────
    match layout {
        // Montage vertical: footage as a centred CARD on the crumpled-paper
        // canvas (paper from input `paper_idx`), instead of the blurred-self bg.
        OutputLayout::Vertical if anim.is_some() => {
            let (render, paper_idx) = anim.unwrap();
            let cardw = (1080u32 * render.footage_scale_pct.clamp(40, 100) / 100).max(160);
            let y_off = render.card_y_offset;
            let y_expr = if y_off == 0 {
                "(H-h)/2".to_string()
            } else {
                format!("(H-h)/2+({y_off})")
            };
            // `shortest=1` is ESSENTIAL: the paper bg is `-stream_loop -1` (infinite),
            // so without it the overlay (and thus the whole encode) would never end.
            // It bounds the output to the footage card `[fg]` length (= clip duration).
            format!(
                "{trim},\
                 {pre_filter}\
                 scale={cardw}:-2,setsar=1[fg];\
                 [{paper_idx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg];\
                 [bg][fg]overlay=x=(W-w)/2:y='{y_expr}':shortest=1{subs}{hl_filter}{profile_filter}{callout_filter}{comment_filter}{post_filter},setsar=1"
            )
        }
        OutputLayout::Vertical => {
            format!(
                "{trim},\
                 {pre_filter}\
                 split=2[main][blur];\
                 [blur]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg];\
                 [main]scale=-2:1080,setsar=1[fg];\
                 [bg][fg]overlay=(W-w)/2:(H-h)/2{subs}{hl_filter}{profile_filter}{callout_filter}{comment_filter}{post_filter},setsar=1"
            )
        }
        OutputLayout::Horizontal => {
            format!(
                "{trim},\
                 scale=1920:1080:force_original_aspect_ratio=decrease,\
                 pad=1920:1080:(ow-iw)/2:(oh-ih)/2\
                 {in_fx_lead}{subs}{hl_filter}{profile_filter}{callout_filter}{comment_filter}{post_filter}"
            )
        }
        OutputLayout::Square => {
            format!(
                "{trim},\
                 crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080\
                 {in_fx_lead}{subs}{hl_filter}{profile_filter}{callout_filter}{comment_filter}{post_filter}"
            )
        }
    }
}

/// Build the news-style lower-third headline overlay filters.
///
/// Returns a comma-prefixed filter chain segment that can be appended directly
/// after the subtitle filter.  Returns `String::new()` if the headline is empty.
///
/// Visual layout (1080×1920 vertical):
/// ```
///  y=1360 ┌─────── gradient panel 560 px ───────┐
///          │  @social_handle         (y≈1385)    │  ← small, top-left
///          │  HEADLINE LINE 1        (y≈1430)    │  ← large bold white
///          │  HEADLINE LINE 2        (y≈1510)    │  ← (if wrapping)
///          │  Source: Channel Name   (y≈1890)    │  ← small, bottom-left
///  y=1920 └─────────────────────────────────────┘
/// ```
///
/// The panel is intentionally taller than the subtitle MarginV (450 px → text
/// at y≈1470), so it visually covers subtitles during the headline period.
/// After the headline fades out, subtitles become visible with no timing changes.
// ── Headline animation parameters ────────────────────────────────────────────

/// Per-style animation parameters for the lower-third headline panel.
///
/// Each `ClipStyle` maps to a distinct entrance/exit animation so the panel
/// feels like a natural extension of the video's visual language:
///
/// | Style    | Entrance                         | Exit             |
/// |----------|----------------------------------|------------------|
/// | `Fade`   | Soft fade in 0.40 s              | Soft fade 0.60 s |
/// | `Flash`  | Snap in 0.12 s (energetic pop)   | Snap out 0.20 s  |
/// | `Zoom`   | Slide up from bottom + fade 0.35s| Fade out 0.50 s  |
/// | `Smooth` | Slow cinematic fade 0.80 s       | Slow fade 0.80 s |
/// | `None`   | Instant appear                   | Instant disappear|
struct HeadlineAnim {
    /// Fade-in duration in seconds.
    fi: f64,
    /// Fade-out duration in seconds.
    fo: f64,
    /// If > 0, slide the panel UP by this many pixels over `fi` seconds.
    slide_px: u32,
}

impl HeadlineAnim {
    fn from_style(style: &ClipStyle, panel_h: u32, bpm: f32) -> Self {
        // When bpm > 0, fade durations snap to beat subdivisions
        if bpm > 0.0 {
            let fi = style.fade_in_dur(bpm);
            let fo = style.fade_out_dur(bpm);
            let slide = if matches!(style, ClipStyle::Zoom) { panel_h } else { 0 };
            return Self { fi, fo, slide_px: slide };
        }
        match style {
            ClipStyle::Fade   => Self { fi: 0.40, fo: 0.60, slide_px: 0       },
            ClipStyle::Flash  => Self { fi: 0.12, fo: 0.20, slide_px: 0       },
            ClipStyle::Smooth => Self { fi: 0.80, fo: 0.80, slide_px: 0       },
            ClipStyle::Zoom   => Self { fi: 0.35, fo: 0.50, slide_px: panel_h },
            ClipStyle::None   => Self { fi: 0.00, fo: 0.00, slide_px: 0       },
        }
    }

    /// Alpha expression used for all `drawtext` / `drawbox` elements.
    ///
    /// `ClipStyle::None` returns `"1"` — always fully opaque while enabled.
    fn alpha_expr(&self, dur: f64) -> String {
        if self.fi == 0.0 && self.fo == 0.0 {
            return "1".into();
        }
        let fo_start = (dur - self.fo).max(self.fi);
        format!(
            "if(lt(t,{fi:.3}),t/{fi:.3},\
             if(gt(t,{fs:.3}),({dur:.3}-t)/{fo:.3},\
             1))",
            fi  = self.fi,
            fo  = self.fo,
            fs  = fo_start,
            dur = dur,
        )
    }

    /// Additive Y-offset expression for the slide-up entrance.
    ///
    /// Returns `""` when there is no slide (most styles).
    /// For `Zoom`, returns `"N*(1-t/D)"` so the panel starts below the frame
    /// and reaches its rest position exactly when the fade-in finishes.
    fn y_offset_expr(&self) -> String {
        if self.slide_px == 0 || self.fi == 0.0 {
            return String::new();
        }
        format!(
            "if(lt(t,{fi:.3}),{px}*(1-t/{fi:.3}),0)",
            fi = self.fi,
            px = self.slide_px,
        )
    }

    /// Format a Y position as a (possibly animated) FFmpeg expression.
    ///
    /// Returns a plain number string when there is no slide so that the filter
    /// string stays readable in logs.
    fn y_expr(&self, base_y: u32) -> String {
        let offset = self.y_offset_expr();
        if offset.is_empty() {
            format!("{base_y}")
        } else {
            format!("{base_y}+{offset}")
        }
    }
}

// ── Panel background builder ──────────────────────────────────────────────────

/// Build FFmpeg filter parts for the white headline panel background.
///
/// Design: solid white full-width panel with a bold accent line at the top.
/// The `anim` parameter drives the panel's entrance animation (slide / fade).
///
/// ```
/// ──────────────────────────────────────  ← 5 px accent line (#FF6B35 orange)
/// │  [solid white, full width]          │
/// │  @social  |  HEADLINE  |  source   │
/// └─────────────────────────────────────┘
/// ```
fn rounded_panel_top(
    x: i32, y: i32,
    w: u32, h: u32,
    _r: u32,      // reserved
    _color: &str, // reserved
    enable: &str,
    anim: &HeadlineAnim,
) -> Vec<String> {
    let accent_w = 6u32;   // vertical left bar width (px)
    let y_body   = anim.y_expr(y as u32);

    vec![
        // 1. Dark glass body — near-black, 90% opacity (modern 2025 style)
        format!(
            "drawbox=x={x}:y='{y_body}':w={w}:h={h}:\
             color=#0d0d0d@0.90:t=fill:enable='{enable}'"
        ),
        // 2. Vertical left accent bar — orange, full panel height
        format!(
            "drawbox=x={x}:y='{y_body}':w={accent_w}:h={h}:\
             color=#FF6B35@1.0:t=fill:enable='{enable}'"
        ),
    ]
}

fn build_headline_filter(
    card:  &HeadlineOverlay,
    w:     u32,
    h:     u32,
    font:  &FontConfig,
    icon:  Option<&SocialIcon>,
    style: &ClipStyle,   // drives entrance/exit animation
    bpm:   f32,          // 0.0 = defaults; >0 = beat-aligned animation durations
) -> String {
    if card.headline.is_empty() {
        return String::new();
    }

    let dur      = card.duration_secs.max(1.0);
    let is_wide  = w >= 1920;
    // Slightly taller panel for better breathing room (modern design)
    let panel_h: u32  = if is_wide { 300 } else { 580 };
    let panel_y: u32  = h - panel_h;
    let corner_r: u32 = if is_wide { 18 } else { 24 };

    // ── Derive animation parameters from the clip's visual style ─────────────
    let anim       = HeadlineAnim::from_style(style, panel_h, bpm);
    let alpha_expr = anim.alpha_expr(dur);
    let enable     = format!("between(t,0,{dur:.3})");

    // ── Layout constants ──────────────────────────────────────────────────────
    let sz_social:   u32 = 22;
    let sz_headline: u32 = if is_wide { 52 } else { 56 };
    let sz_source:   u32 = 20;
    let line_h: u32      = if is_wide { 64 } else { 76 };
    // pad_x: 40px left margin + 6px accent bar + 10px gap = 56px
    let pad_x:  u32      = 56;
    let pad_top: u32     = 22;
    // max_chars: maximum characters per headline line before word-wrapping.
    // Vertical 1080px panel, Poppins Bold 56px: empirical safe limit is ~24 chars
    // (~816px at avg 34px/glyph + 56px left pad = 872px, well within the frame).
    // 22 was too tight — it caused last-word truncation on common 36-42 char headlines
    // like "INVESTOR TOLAK INVESTASI KARENA RISIKO" (line2 "INVESTASI KARENA"=16,
    // "RISIKO"=6 → 23 > 22 → "RISIKO" silently dropped).
    let max_chars: usize = if is_wide { 38 } else { 24 };

    let hl_upper = card.headline.to_uppercase();
    let hl_lines = wrap_headline(&hl_upper, max_chars);

    let icon_size  = icon.map(|ic| ic.size).unwrap_or(0);
    let text_pad_x = if icon_size > 0 { pad_x + icon_size + 12 } else { pad_x };

    // Base Y positions (may be animated via anim.y_expr)
    let y_social_base = panel_y + pad_top;
    let y_hl_1_base   = y_social_base + sz_social + 16;
    let y_hl_2_base   = y_hl_1_base + line_h;
    let y_source_base = h - sz_source - 24;

    // Animated Y expression strings
    let y_social = anim.y_expr(y_social_base);
    let y_hl_1   = anim.y_expr(y_hl_1_base);
    let y_hl_2   = anim.y_expr(y_hl_2_base);
    let y_source = anim.y_expr(y_source_base);

    // Escape special characters for FFmpeg drawtext `text='...'` option.
    //
    // FFmpeg drawtext parsing is two-phase:
    //   Phase 1 (option parser, single-quoted): `\` is an escape prefix.
    //     • `\:` → literal `:`  (prevents `:` from being misread as option separator)
    //     • `\'` → but `'` terminates single-quoted strings — can't be escaped;
    //              we remove single quotes entirely instead.
    //
    //   Phase 2 (text expander): `%{...}` is a runtime variable expansion.
    //     • `%%` MAY expand to `%` in some FFmpeg versions, but behavior is
    //       version-dependent: some versions treat the first `%` as the start of
    //       an invalid format specifier and silently DROP the entire drawtext
    //       element (headline line 1 becomes invisible).
    //     • Solution: add `expansion=none` to every drawtext call so Phase 2 is
    //       bypassed entirely. With expansion disabled, `%` is always a literal
    //       character — no escaping needed and no version sensitivity.
    let esc = |s: &str| -> String {
        s.chars()
            .filter(|c| !c.is_control())
            .map(|c| match c {
                '\'' => String::new(),   // single quotes end the option — strip them
                ':'  => "\\:".into(),    // Phase 1: escape `:` so it's not an option separator
                // `%` needs no escaping — `expansion=none` on every drawtext call
                // disables the text expander, so `%` is always treated literally.
                c    => c.to_string(),
            })
            .collect()
    };

    let source_text = esc(&format!("Source: {}", card.source));
    let hl1_text    = esc(&hl_lines[0]);
    let hl2_text    = hl_lines.get(1).map(|l| esc(l)).unwrap_or_default();
    let bold_ff     = font.bold_ff();
    let regular_ff  = font.regular_ff();

    let mut parts: Vec<String> = Vec::new();

    // ── Dark glass panel + vertical left accent bar ───────────────────────────
    parts.extend(rounded_panel_top(
        0, panel_y as i32, w, panel_h, corner_r, "dark", &enable, &anim,
    ));

    // ── Social handle text OR icon PNG ────────────────────────────────────────
    let has_icon = icon.map(|ic| ic.path.exists()).unwrap_or(false);

    if !has_icon {
        let social_text = esc(&card.social);
        if !social_text.is_empty() {
            parts.push(format!(
                "drawtext={bold_ff}text='{social_text}':fontsize={sz_social}:\
                 fontcolor=#BBBBBB:alpha='{alpha_expr}':x={pad_x}:y='{y_social}':\
                 enable='{enable}':expansion=none"
            ));
        }
    }

    // ── Headline lines — bold, WHITE text on dark background ──────────────────
    // `expansion=none` disables drawtext's `%{...}` text expander so that `%`
    // in the headline (e.g. "90% ...") is always rendered as a literal percent
    // sign, regardless of FFmpeg version.
    parts.push(format!(
        "drawtext={bold_ff}text='{hl1_text}':fontsize={sz_headline}:\
         fontcolor=#FFFFFF:alpha='{alpha_expr}':x={text_pad_x}:y='{y_hl_1}':\
         enable='{enable}':expansion=none"
    ));

    if !hl2_text.is_empty() {
        parts.push(format!(
            "drawtext={bold_ff}text='{hl2_text}':fontsize={sz_headline}:\
             fontcolor=#FFFFFF:alpha='{alpha_expr}':x={text_pad_x}:y='{y_hl_2}':\
             enable='{enable}':expansion=none"
        ));
    }

    // ── Source credit — regular weight, dim gray ──────────────────────────────
    if !source_text.is_empty() {
        parts.push(format!(
            "drawtext={regular_ff}text='{source_text}':fontsize={sz_source}:\
             fontcolor=#888888:alpha='{alpha_expr}':x={pad_x}:y='{y_source}':\
             enable='{enable}':expansion=none"
        ));
    }

    let chain = parts.join(",");

    // ── Icon PNG overlay (movie filter + overlay, only when file exists) ──────
    if has_icon {
        let ic       = icon.unwrap();
        let sz       = ic.size;
        let icon_path = super::fonts::escape_ffmpeg_path(&ic.path);
        let icon_x   = pad_x;
        // Icon Y follows the same slide animation as the social text row
        let icon_y   = anim.y_expr(y_social_base);

        format!(
            ",{chain}[_hl_b];\
             movie='{icon_path}':s={sz}x{sz}:loop=0[_hl_i];\
             [_hl_b][_hl_i]overlay=x={icon_x}:y='{icon_y}':enable='{enable}'"
        )
    } else {
        format!(",{chain}")
    }
}

// ── Overlay filter builder ────────────────────────────────────────────────────

/// Build the FFmpeg filter graph segment for the overlay clip.
///
/// Supports three styles:
/// - `FullScreen` — covers entire frame (cut-away)
/// - `Sticker`    — chromakey + scaled to corner position
/// - `Pip`        — scaled to corner position (no chromakey)
fn build_overlay_filter(
    ov_idx:  usize,
    ov:      &super::overlay::OverlaySpec,
    main_vf: &str,
    w:       u32,
    h:       u32,
) -> String {
    use super::overlay::{OverlayStyle, StickerPosition};

    let at  = ov.at_sec.max(0.0);
    let dur = ov.duration_sec.max(1.0);

    match &ov.style {
        // ── Full-screen cut-away ──────────────────────────────────────────────
        OverlayStyle::FullScreen => format!(
            "[0:v]{main_vf}[main_v];\
             [{ov_idx}:v]\
             scale={w}:{h}:force_original_aspect_ratio=increase,\
             crop={w}:{h},\
             trim=start=0:end={dur:.3},\
             setpts=PTS-STARTPTS+{at:.3}/TB\
             [ov_ts];\
             [main_v][ov_ts]overlay=0:0:eof_action=pass,setsar=1\
             [outv]"
        ),

        // ── Chromakey sticker in corner ───────────────────────────────────────
        OverlayStyle::Sticker { position, scale_pct, key_color } => {
            let scale_w = (w * scale_pct / 100).max(80);
            let (x_expr, y_expr) = sticker_xy(position, scale_w, w, h);
            let chroma = key_color.ffmpeg_color();
            format!(
                "[0:v]{main_vf}[main_v];\
                 [{ov_idx}:v]\
                 chromakey={chroma}:0.15:0.05,\
                 scale={scale_w}:-2,\
                 trim=start=0:end={dur:.3},\
                 setpts=PTS-STARTPTS+{at:.3}/TB\
                 [ov_ts];\
                 [main_v][ov_ts]overlay=x={x_expr}:y={y_expr}:eof_action=pass,setsar=1\
                 [outv]"
            )
        }

        // ── Picture-in-picture (no chromakey) ─────────────────────────────────
        OverlayStyle::Pip { position, scale_pct } => {
            let scale_w = (w * scale_pct / 100).max(80);
            let (x_expr, y_expr) = sticker_xy(position, scale_w, w, h);
            format!(
                "[0:v]{main_vf}[main_v];\
                 [{ov_idx}:v]\
                 scale={scale_w}:-2,\
                 trim=start=0:end={dur:.3},\
                 setpts=PTS-STARTPTS+{at:.3}/TB\
                 [ov_ts];\
                 [main_v][ov_ts]overlay=x={x_expr}:y={y_expr}:eof_action=pass,setsar=1\
                 [outv]"
            )
        }

        // ── Centred footage card (Montage montage) ────────────────────────
        // Full-width centred card shown ONLY during [at, at+dur]; outside the
        // window the main footage card underneath is visible → a montage cut.
        OverlayStyle::FootageCard { scale_pct, y_offset } => {
            let scale_w = (w * scale_pct / 100).max(160);
            // x centred; y centred + variation, then clamp into frame.
            let y_expr = if *y_offset == 0 {
                "(H-h)/2".to_string()
            } else {
                format!("(H-h)/2+({y_offset})")
            };
            format!(
                "[0:v]{main_vf}[main_v];\
                 [{ov_idx}:v]\
                 scale={scale_w}:-2,setsar=1,\
                 trim=start=0:end={dur:.3},\
                 setpts=PTS-STARTPTS+{at:.3}/TB\
                 [ov_ts];\
                 [main_v][ov_ts]overlay=x=(W-w)/2:y='{y_expr}':enable='between(t,{at:.3},{end:.3})':eof_action=pass,setsar=1\
                 [outv]",
                end = at + dur
            )
        }
    }
}

/// Build the FFmpeg filter chain for a static news image overlay.
///
/// The image is a pre-formatted PNG (already 9:16) that slides on top of the video
/// for `spec.duration_sec` seconds starting at `spec.at_sec`. When `spec.ken_burns`
/// is true a very subtle slow zoom (1.0 → 1.05 over the display window) is applied.
///
/// `base_label` is the stream to overlay on (e.g. `"pre_news_v"` or `"main_v"`).
/// The filter always produces `[outv]`.
fn build_news_image_filter(
    img_idx:    usize,
    spec:       &ImageOverlaySpec,
    base_label: &str,
    w: u32, h: u32,
) -> String {
    let at  = spec.at_sec.max(0.0);
    let dur = spec.duration_sec.max(0.5);
    let end = at + dur;
    let fps = 25u32;
    let d   = (dur * fps as f64).ceil() as u32;

    // Scale the image to clip dimensions (force_original_aspect_ratio=decrease
    // keeps the image intact; pad fills any remaining space with black).
    let scale_pad = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
    );

    let kb_filter = if spec.ken_burns {
        // Subtle zoom: 1.0 → 1.05 centred on the image
        format!(
            "zoompan=z='if(lte(zoom,1.0),1.0,zoom+{step:.6})':d={d}:\
             x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':\
             s={w}x{h}:fps={fps},",
            step = 0.05_f64 / d.max(1) as f64,
        )
    } else {
        String::new()
    };

    // Fade in/out around the overlay window (0.25s each)
    let fi_dur = 0.25_f64.min(dur / 4.0);
    let fo_st  = (dur - fi_dur).max(0.0);

    format!(
        "[{img_idx}:v]fps={fps},{scale_pad},{kb_filter}\
         fade=t=in:st=0:d={fi_dur:.3},\
         fade=t=out:st={fo_st:.3}:d={fi_dur:.3},\
         setpts=PTS-STARTPTS+{at:.3}/TB\
         [news_img_v];\
         [{base_label}][news_img_v]overlay=0:0:\
         enable='between(t,{at:.3},{end:.3})',setsar=1[outv]"
    )
}

/// Compute x/y overlay position for a corner sticker/PiP.
///
/// The `scale_w` is the scaled overlay width in pixels.
/// The y offset (220 px for vertical, 120 px for horizontal) keeps the
/// overlay above the subtitle area.
fn sticker_xy(pos: &super::overlay::StickerPosition, scale_w: u32, w: u32, h: u32) -> (String, String) {
    use super::overlay::StickerPosition::*;
    // Estimated overlay height for a typical 9:16 or square video
    let scale_h = scale_w * 9 / 16;
    let pad     = 30u32;
    // Bottom offset: keep above subtitle region (≈220px for 1920-tall, ≈120px for 1080-tall)
    let bottom_pad = if h >= 1800 { 220u32 } else { 120u32 };

    let (x, y) = match pos {
        BottomRight  => (w - scale_w - pad, h - scale_h - bottom_pad),
        BottomLeft   => (pad,               h - scale_h - bottom_pad),
        TopRight     => (w - scale_w - pad, 160),
        TopLeft      => (pad,               160),
        BottomCenter => ((w - scale_w) / 2, h - scale_h - bottom_pad),
    };
    (format!("{x}"), format!("{y}"))
}

/// Word-wrap a headline string into at most 2 lines of `max_chars` each.
fn wrap_headline(text: &str, max_chars: usize) -> Vec<String> {
    if text.len() <= max_chars {
        return vec![text.to_owned()];
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
        } else if current.len() + 1 + word.len() <= max_chars {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(current.clone());
            if lines.len() >= 2 { break; }
            current = word.to_owned();
        }
    }
    if !current.is_empty() && lines.len() < 2 {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(text.chars().take(max_chars).collect());
    }
    lines
}

fn build_encoder(cfg: &FfmpegConfig) -> (String, Vec<String>) {
    if cfg.nvenc {
        (
            "h264_nvenc".to_owned(),
            vec![
                "-preset".to_owned(),
                cfg.preset.clone(),
                "-cq".to_owned(),
                cfg.cq_value.to_string(),
                "-rc".to_owned(),
                "vbr".to_owned(),
            ],
        )
    } else {
        (
            "libx264".to_owned(),
            vec![
                "-preset".to_owned(),
                "medium".to_owned(),
                "-crf".to_owned(),
                cfg.cq_value.to_string(),
            ],
        )
    }
}

async fn run_ffmpeg(execution: &JobExecutionContext, args: &[String]) -> Result<(), EditError> {
    let binary = if let Ok(p) = std::env::var("FFMPEG_PATH") {
        std::path::PathBuf::from(p)
    } else {
        ffmpeg_sidecar::paths::ffmpeg_path()
    };

    run_ffmpeg_with_binary(execution, &binary, args).await
}

async fn run_ffmpeg_with_binary(
    execution: &JobExecutionContext,
    binary: &Path,
    args: &[String],
) -> Result<(), EditError> {

    debug!("ffmpeg {}", args.join(" "));

    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // ponytail: watchdog. A runaway ffmpeg — e.g. a `-stream_loop -1` graph that
    // never reaches EOF under some input combo — otherwise pegs one core forever and
    // hangs the whole pipeline (`.output()`/`.wait()` never return). Cap wall time and
    // kill + log the full command so the offending render is diagnosable instead of a
    // silent 25-minute hang. Override with THOTH_FFMPEG_TIMEOUT_SECS.
    let timeout = std::time::Duration::from_secs(
        std::env::var("THOTH_FFMPEG_TIMEOUT_SECS").ok()
            .and_then(|s| s.parse().ok())
            .filter(|&n| n > 0)
            .unwrap_or(300),
    );
    let output = match execution.output_with_timeout(&mut command, timeout).await {
        Ok(output) => output,
        Err(error) => {
            if error.is::<crate::execution::CommandTimedOut>() {
                warn!(
                    "FFmpeg exceeded {}s — terminated as runaway render. Full command:\nffmpeg {}",
                    timeout.as_secs(), args.join(" ")
                );
            }
            return Err(EditError::from_execution(
                error,
                format!("failed to run FFmpeg at '{}'", binary.display()),
            ));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");

        warn!("FFmpeg stderr:\n{tail}");
        return Err(EditError::FfmpegFailed(format!(
            "FFmpeg exited with code {:?}. Error:\n{}", output.status.code(), tail
        )));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if line.contains("matches no streams") || line.contains("Output file #0 does not contain") {
            warn!("[ffmpeg] {line}");
        }
    }

    Ok(())
}

#[cfg(test)]
async fn run_ffmpeg_with_binary_and_ready(
    execution: &JobExecutionContext,
    binary: &Path,
    args: &[String],
    ready: tokio::sync::oneshot::Sender<()>,
) -> Result<(), EditError> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = execution.spawn(&mut command).map_err(|error| {
        EditError::from_execution(error, format!("failed to run FFmpeg at '{}'", binary.display()))
    })?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| EditError::FfmpegFailed("ready helper stdout is not piped".to_owned()))?;
    let mut stdout = BufReader::new(stdout).lines();
    let marker = tokio::time::timeout(std::time::Duration::from_secs(2), stdout.next_line())
        .await
        .map_err(|_| EditError::FfmpegFailed("ready helper did not emit a marker".to_owned()))?
        .map_err(|error| EditError::FfmpegFailed(error.to_string()))?
        .ok_or_else(|| EditError::FfmpegFailed("ready helper closed stdout".to_owned()))?;
    if marker != "ready" {
        return Err(EditError::FfmpegFailed(format!(
            "ready helper emitted unexpected marker: {marker}"
        )));
    }
    let _ = ready.send(());

    let status = child.status().await.map_err(|error| {
        EditError::from_execution(error, format!("failed to run FFmpeg at '{}'", binary.display()))
    })?;
    if status.success() {
        Ok(())
    } else {
        Err(EditError::FfmpegFailed(format!(
            "FFmpeg exited with code {:?}",
            status.code()
        )))
    }
}

/// Generate a thumbnail frame from the video at `time_sec`.
pub async fn generate_thumbnail(
    execution: &JobExecutionContext,
    video_path: &Path,
    thumb_path: &Path,
    time_sec: f64,
) -> Result<(), EditError> {
    let args = vec![
        "-y".into(),
        "-ss".into(), format!("{time_sec:.3}"),
        "-i".into(), video_path.to_string_lossy().to_string(),
        "-vframes".into(), "1".into(),
        "-q:v".into(), "2".into(),
        thumb_path.to_string_lossy().to_string(),
    ];
    debug!("generate_thumbnail: ffmpeg {}", args.join(" "));
    run_ffmpeg(execution, &args).await
}

/// Mean left↔right asymmetry of one frame: 0 = perfectly mirror-symmetric, higher = natural.
/// Extracts a tiny 64×64 grayscale frame and compares each pixel to its horizontal mirror. Returns
/// `INFINITY` when scoring fails (so a failure never makes a frame look "more symmetric" / rejected).
async fn frame_asymmetry(execution: &JobExecutionContext, video_path: &Path, time_sec: f64) -> f64 {
    let tmp = std::env::temp_dir().join(format!(
        "thoth_sym_{}_{}.gray", std::process::id(), (time_sec * 1000.0) as u64));
    let args = vec![
        "-y".into(), "-ss".into(), format!("{time_sec:.3}"),
        "-i".into(), video_path.to_string_lossy().to_string(),
        "-vframes".into(), "1".into(),
        "-vf".into(), "scale=64:64,format=gray".into(),
        "-f".into(), "rawvideo".into(),
        tmp.to_string_lossy().to_string(),
    ];
    if run_ffmpeg(execution, &args).await.is_err() { return f64::INFINITY; }
    let buf = match std::fs::read(&tmp) { Ok(b) => b, Err(_) => return f64::INFINITY };
    let _ = std::fs::remove_file(&tmp);
    let (w, h) = (64usize, 64usize);
    if buf.len() < w * h { return f64::INFINITY; }
    let (mut sum, mut n) = (0u64, 0u64);
    for y in 0..h {
        for x in 0..w / 2 {
            let a = buf[y * w + x] as i64;
            let b = buf[y * w + (w - 1 - x)] as i64;
            sum += (a - b).unsigned_abs();
            n += 1;
        }
    }
    if n == 0 { f64::INFINITY } else { sum as f64 / n as f64 }
}

/// Pick the cover-subject frame time around `preferred` whose frame is LEAST mirror-symmetric, to
/// dodge transition/kaleidoscope frames that duplicate the subject (the cover then shows a doubled
/// face). Samples a small ±1.5 s window so it stays on the intended subject moment. Falls back to
/// `preferred` when the window is too short or scoring fails.
pub async fn pick_cover_frame_time(
    execution: &JobExecutionContext,
    video_path: &Path,
    preferred: f64,
    start: f64,
    end: f64,
) -> f64 {
    let lo = (preferred - 1.5).max(start);
    let hi = (preferred + 1.5).min((end - 0.1).max(start));
    if hi - lo < 0.4 { return preferred; }
    let steps = 6;
    let (mut best, mut best_score) = (preferred, -1.0f64);
    for i in 0..=steps {
        let t = lo + (hi - lo) * (i as f64 / steps as f64);
        let s = frame_asymmetry(execution, video_path, t).await;
        if s.is_finite() && s > best_score { best_score = s; best = t; }
    }
    best
}

/// Concatenate `main_clip` with an `avatar_segment` (post-roll) into `output`.
///
/// Uses FFmpeg `concat` filter so both clips can have different durations and
/// will be re-encoded to a common stream. The avatar segment is appended after
/// the main clip.
///
/// Audio streams are required in both inputs; the function fails if either is
/// missing an audio track.
pub async fn concat_post_roll(
    execution: &JobExecutionContext,
    main_clip:      &Path,
    avatar_segment: &Path,
    output:         &Path,
    cfg:            &FfmpegConfig,
) -> Result<(), EditError> {
    let vcodec_args: Vec<String> = if cfg.nvenc {
        vec!["h264_nvenc".into(),
             "-cq".into(), cfg.cq_value.to_string(),
             "-preset".into(), cfg.preset.clone()]
    } else {
        vec!["libx264".into(),
             "-crf".into(), cfg.cq_value.to_string(),
             "-preset".into(), "fast".into()]
    };

    let filter = "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]";

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(), main_clip.to_string_lossy().to_string(),
        "-i".into(), avatar_segment.to_string_lossy().to_string(),
        "-filter_complex".into(), filter.to_owned(),
        "-map".into(), "[outv]".into(),
        "-map".into(), "[outa]".into(),
        "-c:v".into(),
    ];
    args.extend(vcodec_args);
    args.extend([
        "-c:a".into(), "aac".into(),
        "-b:a".into(), cfg.audio_bitrate.clone(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-movflags".into(), "+faststart".into(),
        output.to_string_lossy().to_string(),
    ]);

    debug!("concat_post_roll: {} + {} → {}", main_clip.display(), avatar_segment.display(), output.display());
    run_ffmpeg(execution, &args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blocking_media_wrapper_honors_cancellation() {
        use std::time::Duration;

        let execution = crate::execution::JobExecutionContext::new();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        #[cfg(windows)]
        let (binary, args) = (
            "powershell",
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                "Write-Output ready; Start-Sleep -Seconds 30".into(),
            ],
        );
        #[cfg(unix)]
        let args = vec![
            "-c".into(),
            "printf 'ready\\n'; sleep 30".into(),
        ];
        #[cfg(unix)]
        let binary = "sh";
        let waiting_execution = execution.clone();
        let waiting = tokio::spawn(async move {
            run_ffmpeg_with_binary_and_ready(
                &waiting_execution,
                Path::new(binary),
                &args,
                ready_tx,
            )
            .await
        });

        tokio::time::timeout(Duration::from_secs(2), ready_rx)
            .await
            .expect("helper child must emit its ready marker")
            .expect("helper must forward its ready marker");
        execution.cancel();

        let result = tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .expect("cancelled wrapper must return promptly")
            .expect("wrapper task must not panic");
        assert!(matches!(result, Err(EditError::Cancelled(_))), "{result:?}");
    }

    fn cue(at: f64, dur: f64, vol: f32) -> AssetSfxCue {
        AssetSfxCue { path: PathBuf::from("assets/sfx/x.mp3"), at_sec: at, duration_sec: dur, volume: vol }
    }

    #[test]
    fn cue_filter_delays_and_labels() {
        let f = build_cue_audio_filter(3, 0, &cue(8.0, 1.5, 0.8), 30.0, "NORM");
        assert!(f.starts_with(";[3:a]NORM,"));
        assert!(f.contains("adelay=8000|8000"));
        assert!(f.contains("atrim=duration=1.500"));
        assert!(f.contains("volume=0.800"));
        assert!(f.ends_with("[cue0]"));
    }

    #[test]
    fn cue_duration_clamped_to_clip_tail() {
        // at=29.5 in a 30s clip → only 0.5s of room
        let f = build_cue_audio_filter(2, 1, &cue(29.5, 5.0, 0.8), 30.0, "N");
        assert!(f.contains("atrim=duration=0.500"));
        assert!(f.contains("[cue1]"));
    }

    #[test]
    fn cue_zero_volume_defaults_to_080() {
        let f = build_cue_audio_filter(1, 0, &cue(0.0, 2.0, 0.0), 30.0, "N");
        assert!(f.contains("volume=0.800"));
        assert!(f.contains("adelay=0|0"));
    }

    fn meme(at: f64, dur: f64, pos: &str) -> MemeCue {
        MemeCue { path: PathBuf::from("assets/meme/x.mp4"), at_sec: at, duration_sec: dur,
                  position: pos.into(), with_audio: false, audio_volume: 0.9, fullscreen: false }
    }

    #[test]
    fn delayed_audio_filter_custom_label() {
        let f = build_delayed_audio_filter(5, "memea0", 4.0, 2.0, 0.9, 30.0, "N");
        assert!(f.starts_with(";[5:a]N,"));
        assert!(f.contains("adelay=4000|4000"));
        assert!(f.contains("volume=0.900"));
        assert!(f.ends_with("[memea0]"));
    }

    #[test]
    fn meme_filter_shifts_scales_and_gates() {
        let f = build_meme_overlay_filter(4, 0, &meme(10.0, 2.5, "bottom_right"), 1080, 1920, "vm_in", "outv");
        assert!(f.contains("[4:v]trim=duration=2.500"));
        assert!(f.contains("setpts=PTS-STARTPTS+10.000/TB"));
        assert!(f.contains("scale=453:-2"));               // 1080 * 0.42
        assert!(f.contains("[vm_in][mm0]overlay=x=W-w-40:y=H-h-40"));
        assert!(f.contains("enable='between(t,10.000,12.500)'"));
        assert!(f.ends_with("[outv]"));
    }

    #[test]
    fn meme_fullscreen_covers_frame_no_corner() {
        let mut m = meme(5.0, 2.0, "top_right");
        m.fullscreen = true;
        let f = build_meme_overlay_filter(3, 0, &m, 1080, 1920, "vm_in", "outv");
        assert!(f.contains("setpts=PTS-STARTPTS+5.000/TB"));
        assert!(f.contains("scale=1080:1920:force_original_aspect_ratio=increase")); // blurred fill
        assert!(f.contains("force_original_aspect_ratio=decrease"));                 // whole meme
        assert!(f.contains("[vm_in][mm0]overlay=x=0:y=0"));                          // full-frame
        assert!(f.contains("enable='between(t,5.000,7.000)'"));
        assert!(!f.contains("W-w-40"));   // NOT a corner PiP
        assert!(f.ends_with("[outv]"));
    }

    #[test]
    fn meme_positions_map_to_corners() {
        let tl = build_meme_overlay_filter(2, 1, &meme(0.0, 2.0, "top_left"), 1080, 1920, "vm1", "vm2");
        assert!(tl.contains("overlay=x=40:y=40"));
        let bc = build_meme_overlay_filter(2, 0, &meme(0.0, 2.0, "bottom_center"), 1080, 1920, "a", "b");
        assert!(bc.contains("overlay=x=(W-w)/2:y=H-h-40"));
    }

    // ── Montage composite mode ────────────────────────────────────────────

    #[test]
    fn footage_card_centred_with_window() {
        use crate::edit::overlay::{OverlaySpec, OverlayStyle};
        let ov = OverlaySpec {
            path: PathBuf::from("footage_cache/x.mp4"),
            at_sec: 4.0, duration_sec: 4.0,
            style: OverlayStyle::FootageCard { scale_pct: 88, y_offset: 0 },
        };
        let f = build_overlay_filter(3, &ov, "TRIM", 1080, 1920);
        assert!(f.contains("[0:v]TRIM[main_v]"));
        assert!(f.contains("scale=950:-2"));                 // 1080 * 88/100
        assert!(f.contains("overlay=x=(W-w)/2"));
        assert!(f.contains("enable='between(t,4.000,8.000)'"));
        assert!(f.ends_with("[outv]"));
    }

    #[test]
    fn image_card_centred_looped_still() {
        let cue = ImageCardCue {
            path: PathBuf::from("crops/post.png"),
            at_sec: 5.0, duration_sec: 3.0, scale_pct: 88,
        };
        let f = build_image_card_overlay(9, 0, &cue, 1080, "ic_in", "outv");
        assert!(f.contains("[9:v]scale=950:-2"));                 // 1080 * 88/100
        assert!(f.contains("[ic_in][ic0]overlay=x=(W-w)/2:y=(H-h)/2"));
        assert!(f.contains("eof_action=pass"));                   // looped still keeps base running
        assert!(f.contains("enable='between(t,5.000,8.000)'"));
        assert!(f.ends_with("[outv]"));
        assert!(!f.contains("trim="));                            // still image: no trim/setpts
    }

    #[test]
    fn montage_branch_composites_on_paper() {
        let render = MontageRender {
            paper_bg: PathBuf::from("paper.mp4"),
            footage_scale_pct: 88,
            card_y_offset: -120,
        };
        let font = FontConfig::default();
        let f = build_video_filter(
            &OutputLayout::Vertical, std::path::Path::new("x.ass"), 0.0, 5.0,
            &ClipStyle::None, None, &font, None, 0.0, None, None, &[], &[],
            Some((&render, 7)), false,
        );
        assert!(f.contains("[7:v]scale=1080:1920")); // paper bg (input 7) composited at native framerate
        assert!(f.contains("crop=1080:1920"));
        assert!(f.contains("scale=950:-2,setsar=1[fg]"));    // footage card width
        assert!(f.contains("(H-h)/2+(-120)"));               // placement variation
        assert!(f.contains("shortest=1"));                   // bound the infinite paper loop
        assert!(!f.contains("gblur"));                       // NOT the blur-self path
    }

    #[test]
    fn montage_disabled_uses_blur_self() {
        let font = FontConfig::default();
        let f = build_video_filter(
            &OutputLayout::Vertical, std::path::Path::new("x.ass"), 0.0, 5.0,
            &ClipStyle::None, None, &font, None, 0.0, None, None, &[], &[], None, false,
        );
        assert!(f.contains("gblur=sigma=20"));               // legacy blurred-self bg
        assert!(!f.contains("paper"));
    }

    #[test]
    fn deferred_subs_omits_subtitle_and_stays_comma_safe() {
        let font = FontConfig::default();
        for layout in [OutputLayout::Vertical, OutputLayout::Horizontal, OutputLayout::Square] {
            let f = build_video_filter(
                &layout, std::path::Path::new("x.ass"), 0.0, 5.0,
                &ClipStyle::None, None, &font, None, 0.0, None, None, &[], &[], None,
                true, // defer
            );
            assert!(!f.contains("subtitles="), "deferred build must NOT burn subtitles: {f}");
            assert!(!f.contains(",,"), "no empty filter (double comma) allowed: {f}");
            assert!(!f.contains(",setsar=1,setsar"), "no stray duplication: {f}");
        }
    }

    #[test]
    fn non_deferred_subs_burns_subtitle_comma_safe() {
        let font = FontConfig::default();
        for layout in [OutputLayout::Vertical, OutputLayout::Horizontal, OutputLayout::Square] {
            let f = build_video_filter(
                &layout, std::path::Path::new("x.ass"), 0.0, 5.0,
                &ClipStyle::None, None, &font, None, 0.0, None, None, &[], &[], None,
                false,
            );
            assert!(f.contains("subtitles='x.ass'"), "non-deferred must burn subtitles: {f}");
            assert!(!f.contains(",,"), "no empty filter (double comma) allowed: {f}");
        }
    }

    #[test]
    fn subtitle_burn_suffix_has_no_leading_comma_and_chains_hook() {
        let font = FontConfig::default();
        let plain = subtitle_burn_suffix(std::path::Path::new("c.ass"), None, &font);
        assert!(plain.starts_with("subtitles="), "suffix must not lead with a comma: {plain}");
        assert!(!plain.contains(",subtitles="), "no hook expected: {plain}");

        let with_hook = subtitle_burn_suffix(
            std::path::Path::new("c.ass"), Some(std::path::Path::new("c.hook.ass")), &font);
        assert!(with_hook.starts_with("subtitles='c.ass'"));
        // hook pass chains AFTER the body subtitles (stays on top).
        assert!(with_hook.contains(",subtitles='c.hook.ass'"), "hook must follow body: {with_hook}");
    }
}
