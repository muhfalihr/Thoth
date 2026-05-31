use std::path::{Path, PathBuf};
use std::process::Stdio;

use tracing::{debug, info, warn};

use crate::config::FfmpegConfig;

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
    /// Downloaded by `edit::overlay::fetch_overlay_clip()` from TikTok/YouTube Shorts.
    /// `None` = no overlay (default).
    pub overlay: Option<super::overlay::OverlaySpec>,

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
pub fn encode_clip_direct(
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

    let main_vf = build_video_filter(
        layout, ass_path, rel_start, rel_end,
        &audio.clip_style,
        audio.headline.as_ref(),
        &audio.font,
        audio.social_icon.as_ref(),
        audio.clip_bpm,   // 0.0 = default durations; >0 = beat-aligned
    );
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
    let has_sfx     = audio.sfx_intro.is_some();
    let has_bgm     = audio.bgm.is_some();
    let has_overlay = audio.overlay.is_some();
    let bgm_vol = if audio.bgm_volume <= 0.0 { 0.12_f32 } else { audio.bgm_volume };

    if has_sfx { info!("intro SFX: {}", audio.sfx_intro.as_ref().unwrap().display()); }
    if has_bgm { info!("BGM: {} vol={:.0}%", audio.bgm.as_ref().unwrap().display(), bgm_vol * 100.0); }
    if has_overlay {
        let ov = audio.overlay.as_ref().unwrap();
        info!("overlay: {} at t={:.1}s for {:.1}s",
              ov.path.file_name().unwrap_or_default().to_string_lossy(),
              ov.at_sec, ov.duration_sec);
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
        //   [1|2|3]   = overlay video (if overlay provided, always last)
        if has_sfx || has_bgm || has_overlay {
            // Input index calculations
            let sfx_idx     = if has_sfx { Some(1usize) } else { None };
            let bgm_idx     = if has_bgm { Some(1 + has_sfx as usize) } else { None };
            let overlay_idx = if has_overlay { Some(1 + has_sfx as usize + has_bgm as usize) } else { None };

            // Build video filter string — style-aware overlay placement.
            // Without overlay: "[0:v]{main_vf}[outv]"
            // With overlay:    "[0:v]{main_vf}[main_v]; [OV:v]{ov_filter}[ov_ts]; [main_v][ov_ts]overlay=...[outv]"
            let video_filter_str = if let (true, Some(ov_i), Some(ov)) =
                (has_overlay, overlay_idx, &audio.overlay)
            {
                build_overlay_filter(ov_i, ov, &main_vf, clip_w, clip_h)
            } else {
                format!("[0:v]{main_vf}[outv]")
            };

            let mut a = vec!["-y".into(),
                "-ss".into(), format!("{fast_seek:.3}"),
                "-i".into(), source.to_string_lossy().to_string()];

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

            // Build audio filter chain
            // Step 1: process main voice
            let mut af = format!("[0:a]{main_af}[voice]");

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

            // Step 4: mix all audio streams
            let (mix_inputs, mix_count) = match (sfx_idx, bgm_idx) {
                (Some(_), Some(_)) => ("[voice][sfx_out][bgm_out]", 3),
                (Some(_), None)    => ("[voice][sfx_out]", 2),
                (None,    Some(_)) => ("[voice][bgm_out]", 2),
                (None,    None)    => ("[voice]", 1),
            };
            if mix_count > 1 {
                af.push_str(&format!(
                    ";{mix_inputs}amix=inputs={mix_count}:duration=first:\
                     normalize=0:weights='{weights}'\
                     [outa]",
                    weights = "1 ".repeat(mix_count).trim_end()
                ));
            } else {
                af.push_str(";[voice]aformat=sample_fmts=fltp:channel_layouts=stereo[outa]");
            }

            a.extend([
                "-filter_complex".into(), format!("{video_filter_str};{af}"),
                "-map".into(), "[outv]".into(),
                "-map".into(), "[outa]".into(),
                "-c:v".into(), vcodec]);
            a
        } else {
            // Plain — no audio effects, fastest path
            vec!["-y".into(),
                "-ss".into(), format!("{fast_seek:.3}"),
                "-i".into(), source.to_string_lossy().to_string(),
                "-vf".into(), main_vf,
                "-af".into(), main_af,
                "-t".into(), format!("{duration:.3}"),
                "-c:v".into(), vcodec]
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
    run_ffmpeg(&args)
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
) -> String {
    let ass_str = ass_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");
    // Include fontsdir so FFmpeg finds the custom font for ASS subtitles
    let fontsdir_opt = font.fontsdir_opt();
    let subtitle_filter = format!("subtitles='{ass_str}'{fontsdir_opt}");

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

    // ── Headline overlay ──────────────────────────────────────────────────────
    // Pass the clip style so the panel entrance/exit animation matches the video.
    let hl_filter = headline
        .map(|c| build_headline_filter(c, w, h, font, icon, style, bpm))
        .unwrap_or_default();

    // ── Assemble the full filtergraph ─────────────────────────────────────────
    match layout {
        OutputLayout::Vertical => {
            format!(
                "{trim},\
                 {pre_filter}\
                 split=2[main][blur];\
                 [blur]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg];\
                 [main]scale=-2:1080,setsar=1[fg];\
                 [bg][fg]overlay=(W-w)/2:(H-h)/2,{subtitle_filter}{hl_filter}{post_filter},setsar=1"
            )
        }
        OutputLayout::Horizontal => {
            format!(
                "{trim},\
                 scale=1920:1080:force_original_aspect_ratio=decrease,\
                 pad=1920:1080:(ow-iw)/2:(oh-ih)/2,\
                 {pre_filter}{subtitle_filter}{hl_filter}{post_filter}"
            )
        }
        OutputLayout::Square => {
            format!(
                "{trim},\
                 crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080,\
                 {pre_filter}{subtitle_filter}{hl_filter}{post_filter}"
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
    }
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

fn run_ffmpeg(args: &[String]) -> Result<(), EditError> {
    let binary = if let Ok(p) = std::env::var("FFMPEG_PATH") {
        std::path::PathBuf::from(p)
    } else {
        ffmpeg_sidecar::paths::ffmpeg_path()
    };

    debug!("ffmpeg {}", args.join(" "));

    let output = std::process::Command::new(&binary)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| EditError::FfmpegFailed(format!(
            "failed to spawn FFmpeg at '{}': {e}", binary.display()
        )))?;

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

/// Generate a thumbnail frame from the video at `time_sec`.
pub fn generate_thumbnail(video_path: &Path, thumb_path: &Path, time_sec: f64) -> Result<(), EditError> {
    let args = vec![
        "-y".into(),
        "-ss".into(), format!("{time_sec:.3}"),
        "-i".into(), video_path.to_string_lossy().to_string(),
        "-vframes".into(), "1".into(),
        "-q:v".into(), "2".into(),
        thumb_path.to_string_lossy().to_string(),
    ];
    debug!("generate_thumbnail: ffmpeg {}", args.join(" "));
    run_ffmpeg(&args)
}
