use std::path::{Path, PathBuf};
use std::process::Stdio;

use tracing::{debug, info, warn};

use crate::config::FfmpegConfig;
use super::error::EditError;

// ── Transition type ───────────────────────────────────────────────────────────

/// Between-clip transition mapped directly from CapCut's transition catalog.
///
/// Each variant maps to an FFmpeg `xfade` transition name. Used when
/// concatenating multiple clip files into a single output via
/// [`concat_with_transitions`].
///
/// CapCut name → xfade parameter:
/// | CapCut name  | xfade name   | Notes                        |
/// |--------------|--------------|------------------------------|
/// | Blink        | fadewhite    | white-flash sprite           |
/// | Dissolve     | dissolve     | smooth pixel dissolve        |
/// | Fade         | fade         | fade through black           |
/// | Wipe Left    | wipeleft     | hard wipe →                  |
/// | Wipe Right   | wiperight    | hard wipe ←                  |
/// | Wipe Up      | wipeup       | hard wipe ↑                  |
/// | Wipe Down    | wipedown     | hard wipe ↓                  |
/// | Slide Left   | slideleft    | clip slides out left         |
/// | Slide Right  | slideright   |                              |
/// | Smooth Left  | smoothleft   | smooth version of wipe       |
/// | Smooth Right | smoothright  |                              |
/// | Zoom In      | zoomin       | zooms into next clip         |
/// | Circle Open  | circleopen   | iris wipe open               |
/// | Circle Close | circleclose  | iris wipe close              |
/// | Pixelize     | pixelize     | CapCut "Mosaic"              |
/// | Blur         | hblur        | horizontal motion blur       |
/// | Glitch       | hblur        | approximation (no GLSL)      |
/// | Radial       | radial       |                              |
/// | Diagonal TL  | diagtl       | diagonal corner wipe         |
/// | Cover Left   | coverleft    | next clip covers             |
/// | Reveal Left  | revealleft   | current clip reveals         |
/// | Squeeze H    | squeezeh     | squeezes out horizontally    |
/// | Fade Gray    | fadegrays    | desaturate → next clip       |
/// | None / Cut   | —            | no transition (hard cut)     |
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Transition {
    // ── Basic ─────────────────────────────────────────────────────────────────
    /// Fade through black (default — works on all content)
    #[default]
    Fade,
    /// Flash to white then next clip — energetic, CapCut "Blink"
    Blink,
    /// Pixel-level dissolve blend
    Dissolve,
    /// No transition — instant hard cut
    None,

    // ── Wipe ─────────────────────────────────────────────────────────────────
    WipeLeft,
    WipeRight,
    WipeUp,
    WipeDown,
    WipeTopLeft,
    WipeTopRight,
    WipeBottomLeft,
    WipeBottomRight,

    // ── Slide ────────────────────────────────────────────────────────────────
    SlideLeft,
    SlideRight,
    SlideUp,
    SlideDown,

    // ── Smooth slide ─────────────────────────────────────────────────────────
    SmoothLeft,
    SmoothRight,
    SmoothUp,
    SmoothDown,

    // ── Cover / Reveal ───────────────────────────────────────────────────────
    CoverLeft,
    CoverRight,
    CoverUp,
    CoverDown,
    RevealLeft,
    RevealRight,
    RevealUp,
    RevealDown,

    // ── Shape ────────────────────────────────────────────────────────────────
    CircleCrop,
    CircleOpen,
    CircleClose,
    VertOpen,
    VertClose,
    HorzOpen,
    HorzClose,
    RectCrop,

    // ── Effect ───────────────────────────────────────────────────────────────
    /// Zoom into next clip — CapCut "Zoom In"
    ZoomIn,
    /// Pixelate transition — CapCut "Mosaic"
    Pixelize,
    /// Radial wipe
    Radial,
    /// Horizontal blur wipe — CapCut "Blur" / "Glitch" approximation
    HBlur,
    /// Desaturate out, saturate in — cinematic
    FadeGrays,
    /// Squeeze horizontally
    SqueezeH,
    /// Squeeze vertically
    SqueezeV,
    // wind variants
    HlWind,
    HrWind,
    VuWind,
    VdWind,
    // slice variants
    HlSlice,
    HrSlice,
    VuSlice,
    VdSlice,
    DiagTl,
    DiagTr,
    DiagBl,
    DiagBr,
}

impl Transition {
    /// Map to the FFmpeg `xfade=transition=` value.
    /// Returns `None` for `Transition::None` (hard cut — no xfade filter).
    pub fn xfade_name(&self) -> Option<&'static str> {
        Some(match self {
            Self::Fade         => "fade",
            Self::Blink        => "fadewhite",
            Self::Dissolve     => "dissolve",
            Self::None         => return None,

            Self::WipeLeft     => "wipeleft",
            Self::WipeRight    => "wiperight",
            Self::WipeUp       => "wipeup",
            Self::WipeDown     => "wipedown",
            Self::WipeTopLeft  => "wipetl",
            Self::WipeTopRight => "wipetr",
            Self::WipeBottomLeft  => "wipebl",
            Self::WipeBottomRight => "wipebr",

            Self::SlideLeft    => "slideleft",
            Self::SlideRight   => "slideright",
            Self::SlideUp      => "slideup",
            Self::SlideDown    => "slidedown",

            Self::SmoothLeft   => "smoothleft",
            Self::SmoothRight  => "smoothright",
            Self::SmoothUp     => "smoothup",
            Self::SmoothDown   => "smoothdown",

            Self::CoverLeft    => "coverleft",
            Self::CoverRight   => "coverright",
            Self::CoverUp      => "coverup",
            Self::CoverDown    => "coverdown",
            Self::RevealLeft   => "revealleft",
            Self::RevealRight  => "revealright",
            Self::RevealUp     => "revealup",
            Self::RevealDown   => "revealdown",

            Self::CircleCrop   => "circlecrop",
            Self::CircleOpen   => "circleopen",
            Self::CircleClose  => "circleclose",
            Self::VertOpen     => "vertopen",
            Self::VertClose    => "vertclose",
            Self::HorzOpen     => "horzopen",
            Self::HorzClose    => "horzclose",
            Self::RectCrop     => "rectcrop",

            Self::ZoomIn       => "zoomin",
            Self::Pixelize     => "pixelize",
            Self::Radial       => "radial",
            Self::HBlur        => "hblur",
            Self::FadeGrays    => "fadegrays",
            Self::SqueezeH     => "squeezeh",
            Self::SqueezeV     => "squeezev",
            Self::HlWind       => "hlwind",
            Self::HrWind       => "hrwind",
            Self::VuWind       => "vuwind",
            Self::VdWind       => "vdwind",
            Self::HlSlice      => "hlslice",
            Self::HrSlice      => "hrslice",
            Self::VuSlice      => "vuslice",
            Self::VdSlice      => "vdslice",
            Self::DiagTl       => "diagtl",
            Self::DiagTr       => "diagtr",
            Self::DiagBl       => "diagbl",
            Self::DiagBr       => "diagbr",
        })
    }

    /// Parse a CapCut transition name or vibe string into a `Transition`.
    /// Case-insensitive. Falls back to `Fade` for unknown values.
    pub fn from_name(s: &str) -> Self {
        match s.to_lowercase().replace([' ', '-', '_'], "").as_str() {
            // CapCut catalog names
            "blink"                             => Self::Blink,
            "dissolve"                          => Self::Dissolve,
            "fade" | "fadeblack"                => Self::Fade,
            "none" | "cut" | "hardcut"          => Self::None,

            "wipeleft"  | "wipe"                => Self::WipeLeft,
            "wiperight"                         => Self::WipeRight,
            "wipeup"                            => Self::WipeUp,
            "wipedown"                          => Self::WipeDown,
            "wipetl"                            => Self::WipeTopLeft,
            "wipetr"                            => Self::WipeTopRight,
            "wipebl"                            => Self::WipeBottomLeft,
            "wipebr"                            => Self::WipeBottomRight,

            "slideleft" | "slide"               => Self::SlideLeft,
            "slideright"                        => Self::SlideRight,
            "slideup"                           => Self::SlideUp,
            "slidedown"                         => Self::SlideDown,

            "smoothleft" | "smooth"             => Self::SmoothLeft,
            "smoothright"                       => Self::SmoothRight,
            "smoothup"                          => Self::SmoothUp,
            "smoothdown"                        => Self::SmoothDown,

            "coverleft"  | "cover"              => Self::CoverLeft,
            "coverright"                        => Self::CoverRight,
            "coverup"                           => Self::CoverUp,
            "coverdown"                         => Self::CoverDown,
            "revealleft" | "reveal"             => Self::RevealLeft,
            "revealright"                       => Self::RevealRight,
            "revealup"                          => Self::RevealUp,
            "revealdown"                        => Self::RevealDown,

            "circlecrop" | "circle"             => Self::CircleCrop,
            "circleopen" | "irisopen"           => Self::CircleOpen,
            "circleclose" | "irisclose"         => Self::CircleClose,
            "vertopen"                          => Self::VertOpen,
            "vertclose"                         => Self::VertClose,
            "horzopen"                          => Self::HorzOpen,
            "horzclose"                         => Self::HorzClose,
            "rectcrop"                          => Self::RectCrop,

            "zoomin" | "zoom"                   => Self::ZoomIn,
            "pixelize" | "mosaic" | "pixel"     => Self::Pixelize,
            "radial"                            => Self::Radial,
            "hblur" | "blur" | "glitch"         => Self::HBlur,
            "fadegrays" | "gray" | "desaturate" => Self::FadeGrays,
            "squeezeh" | "squeeze"              => Self::SqueezeH,
            "squeezev"                          => Self::SqueezeV,
            "hlwind" | "wind"                   => Self::HlWind,
            "hrwind"                            => Self::HrWind,
            "vuwind"                            => Self::VuWind,
            "vdwind"                            => Self::VdWind,
            "hlslice" | "slice"                 => Self::HlSlice,
            "hrslice"                           => Self::HrSlice,
            "vuslice"                           => Self::VuSlice,
            "vdslice"                           => Self::VdSlice,
            "diagtl"                            => Self::DiagTl,
            "diagtr"                            => Self::DiagTr,
            "diagbl"                            => Self::DiagBl,
            "diagbr"                            => Self::DiagBr,

            _                                   => Self::Fade,
        }
    }

    /// Default transition duration in seconds.
    ///
    /// Beat-aligned when `bpm > 0` (snaps to nearest musical beat subdivision).
    pub fn default_duration(&self, bpm: f32) -> f64 {
        if bpm > 0.0 {
            let beat = 60.0 / bpm as f64;
            return match self {
                Self::None        => 0.0,
                Self::Blink       => beat * 0.5,
                Self::Dissolve    => beat,
                Self::HBlur       => beat * 0.5,
                _                 => beat,
            };
        }
        match self {
            Self::None     => 0.0,
            Self::Blink    => 0.25,
            Self::Dissolve => 0.60,
            Self::HBlur    => 0.40,
            Self::ZoomIn   => 0.50,
            _              => 0.50,
        }
    }
}

// ── Clip spec for concatenation ───────────────────────────────────────────────

/// One clip in a multi-clip concat operation.
pub struct ClipSpec {
    /// Path to the pre-encoded clip file.
    pub path: PathBuf,
    /// Duration of this clip in seconds (needed for xfade offset calculation).
    pub duration_sec: f64,
    /// Transition to apply AFTER this clip (leading into the NEXT clip).
    /// The last clip's transition is ignored.
    pub transition_out: Transition,
    /// Override transition duration (0 = use `Transition::default_duration`).
    pub transition_dur: f64,
}

impl ClipSpec {
    pub fn new(path: impl Into<PathBuf>, duration_sec: f64, transition_out: Transition) -> Self {
        Self {
            path: path.into(),
            duration_sec,
            transition_out,
            transition_dur: 0.0,
        }
    }

    pub fn with_dur(mut self, dur: f64) -> Self {
        self.transition_dur = dur;
        self
    }

    fn effective_dur(&self, bpm: f32) -> f64 {
        if self.transition_dur > 0.0 {
            self.transition_dur
        } else {
            self.transition_out.default_duration(bpm)
        }
    }
}

// ── concat_with_transitions ───────────────────────────────────────────────────

/// Concatenate N pre-encoded clips into a single output with CapCut-style
/// `xfade` transitions between them.
///
/// ## How it works (FFmpeg xfade chain)
///
/// For 3 clips A (10s), B (8s), C (12s) with 0.5s transitions:
///
/// ```text
/// Inputs: [0:v] [1:v] [2:v]   (3 video inputs)
///         [0:a] [1:a] [2:a]   (3 audio inputs)
///
/// filter_complex:
///   [0:v][1:v] xfade=transition=fade:duration=0.5:offset=9.5 [v01];
///   [v01][2:v] xfade=transition=dissolve:duration=0.5:offset=17.0 [outv];
///   [0:a][1:a] acrossfade=d=0.5:c1=tri:c2=tri [a01];
///   [a01][2:a] acrossfade=d=0.5:c1=tri:c2=tri [outa]
/// ```
///
/// The `offset` for each xfade = sum of (previous clip durations) − sum of
/// (previous transition durations), which gives the frame-accurate blend point.
///
/// Audio uses `acrossfade` for smooth crossfade matching the video transition.
///
/// ## Hard cuts
///
/// When a transition is `Transition::None`, no xfade is added — the clips are
/// joined with FFmpeg `concat` instead, keeping full durations.
///
/// ## Notes
///
/// - All input clips must have the same resolution, FPS, and codec profile.
///   Use `encode_clip_direct` with consistent `OutputLayout` before calling this.
/// - Output re-encodes using libx264 (CPU) or h264_nvenc (GPU) based on `cfg`.
pub fn concat_with_transitions(
    clips: &[ClipSpec],
    output: &Path,
    cfg: &FfmpegConfig,
    bpm: f32,
) -> Result<(), EditError> {
    if clips.is_empty() {
        return Err(EditError::FfmpegFailed("no clips to concatenate".into()));
    }

    if clips.len() == 1 {
        std::fs::copy(&clips[0].path, output).map_err(EditError::Io)?;
        return Ok(());
    }

    let n = clips.len();
    let (vcodec, extra_enc) = build_encoder(cfg);

    // Check if ALL transitions are None → use simple concat (faster, lossless)
    let all_none = clips[..n - 1].iter().all(|c| c.transition_out == Transition::None);
    if all_none {
        return concat_simple(clips, output, cfg);
    }

    // Build filter_complex with xfade chain
    let mut filter_parts: Vec<String> = Vec::new();

    // ── Video xfade chain ─────────────────────────────────────────────────────
    // Running timeline position: tracks where each xfade offset falls.
    // offset_i = (sum of clip[0..i] durations) − (sum of transition[0..i-1] durations)
    let mut timeline_sec: f64 = 0.0;
    let mut prev_label = "[0:v]".to_owned();

    for i in 0..n - 1 {
        let clip = &clips[i];
        let td   = clip.effective_dur(bpm);
        timeline_sec += clip.duration_sec - td; // advance by (duration − transition overlap)

        let _next_label = format!("[0:v{}]", i + 1); // "[0:v1]", "[0:v2]", ...
        let out_label  = if i == n - 2 { "[outv]".to_owned() } else { format!("[v{i}]") };

        if let Some(xname) = clip.transition_out.xfade_name() {
            filter_parts.push(format!(
                "{prev_label}[{ni}:v]xfade=transition={xname}:duration={td:.3}:offset={off:.3}{out_label}",
                ni  = i + 1,
                td  = td,
                off = timeline_sec,
            ));
        } else {
            // Hard cut — just relabel (will use concat for these pairs)
            filter_parts.push(format!("{prev_label}[{ni}:v]concat=n=2:v=1:a=0{out_label}", ni = i + 1));
        }

        prev_label = out_label;
    }

    // ── Audio acrossfade chain ────────────────────────────────────────────────
    let mut audio_prev = "[0:a]".to_owned();
    for i in 0..n - 1 {
        let td        = clips[i].effective_dur(bpm);
        let out_label = if i == n - 2 { "[outa]".to_owned() } else { format!("[a{i}]") };
        filter_parts.push(format!(
            "{audio_prev}[{ni}:a]acrossfade=d={td:.3}:c1=tri:c2=tri{out_label}",
            ni = i + 1,
        ));
        audio_prev = out_label;
    }

    let filter_complex = filter_parts.join(";");

    // ── Build FFmpeg args ─────────────────────────────────────────────────────
    let mut args: Vec<String> = vec!["-y".into()];
    for clip in clips {
        args.extend(["-i".into(), clip.path.to_string_lossy().to_string()]);
    }
    args.extend([
        "-filter_complex".into(), filter_complex,
        "-map".into(), "[outv]".into(),
        "-map".into(), "[outa]".into(),
        "-c:v".into(), vcodec,
    ]);
    args.extend(extra_enc);
    args.extend([
        "-c:a".into(), "aac".into(),
        "-b:a".into(), cfg.audio_bitrate.clone(),
        "-ac".into(), "2".into(),
        "-movflags".into(), "+faststart".into(),
        output.to_string_lossy().to_string(),
    ]);

    info!(
        "concat_with_transitions: {} clips → {}",
        n, output.display()
    );
    debug!("ffmpeg {}", args.join(" "));

    run_ffmpeg(&args)
}

// ── Simple concat (lossless when all cuts are hard) ──────────────────────────

/// Concatenate clips with no transitions using FFmpeg concat demuxer.
/// Avoids re-encoding — much faster for hard cuts.
fn concat_simple(clips: &[ClipSpec], output: &Path, cfg: &FfmpegConfig) -> Result<(), EditError> {
    // Write a temporary concat list file
    let list_path = output.with_extension("concat.txt");
    let list_content: String = clips
        .iter()
        .map(|c| {
            // FFmpeg concat demuxer requires forward-slash paths
            let p = c.path.to_string_lossy().replace('\\', "/");
            format!("file '{}'\n", p)
        })
        .collect();

    std::fs::write(&list_path, list_content).map_err(EditError::Io)?;

    let (vcodec, extra_enc) = build_encoder(cfg);
    let mut args = vec![
        "-y".into(),
        "-f".into(), "concat".into(),
        "-safe".into(), "0".into(),
        "-i".into(), list_path.to_string_lossy().to_string(),
        "-c:v".into(), vcodec,
    ];
    args.extend(extra_enc);
    args.extend([
        "-c:a".into(), "aac".into(),
        "-b:a".into(), cfg.audio_bitrate.clone(),
        "-ac".into(), "2".into(),
        "-movflags".into(), "+faststart".into(),
        output.to_string_lossy().to_string(),
    ]);

    info!("concat_simple: {} clips → {}", clips.len(), output.display());
    let result = run_ffmpeg(&args);
    let _ = std::fs::remove_file(&list_path); // cleanup regardless
    result
}

// ── Transition sequence helpers ───────────────────────────────────────────────

/// Build a beat-aligned sequence of transitions from a list of style names.
///
/// Designed for LLM output: takes per-clip `clip_style` strings and produces
/// a `Vec<Transition>` for use with [`concat_with_transitions`].
///
/// ```rust
/// let styles = vec!["fade", "blink", "wipe", "none"];
/// let transitions = transition_sequence_from_vibes(&styles, 128.0);
/// ```
pub fn transition_sequence_from_vibes(vibes: &[&str], bpm: f32) -> Vec<Transition> {
    let _ = bpm; // reserved for future beat-aligned selection
    vibes.iter().map(|v| Transition::from_name(v)).collect()
}

/// Return a `Vec<Transition>` with `n` entries, all set to the same type.
pub fn uniform_transitions(t: Transition, n: usize) -> Vec<Transition> {
    std::iter::repeat(t).take(n).collect()
}

// ── Shared internals (mirror of ffmpeg.rs) ───────────────────────────────────

fn build_encoder(cfg: &FfmpegConfig) -> (String, Vec<String>) {
    if cfg.nvenc {
        (
            "h264_nvenc".to_owned(),
            vec![
                "-preset".into(), cfg.preset.clone(),
                "-cq".into(), cfg.cq_value.to_string(),
                "-rc".into(), "vbr".into(),
            ],
        )
    } else {
        (
            "libx264".to_owned(),
            vec![
                "-preset".into(), "medium".into(),
                "-crf".into(), cfg.cq_value.to_string(),
            ],
        )
    }
}

fn run_ffmpeg(args: &[String]) -> Result<(), EditError> {
    let binary = if let Ok(p) = std::env::var("FFMPEG_PATH") {
        PathBuf::from(p)
    } else {
        ffmpeg_sidecar::paths::ffmpeg_path()
    };

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

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xfade_names_roundtrip() {
        let cases = [
            ("fade",       Some("fade")),
            ("blink",      Some("fadewhite")),
            ("dissolve",   Some("dissolve")),
            ("none",       None),
            ("wipeleft",   Some("wipeleft")),
            ("wipe",       Some("wipeleft")),
            ("zoom",       Some("zoomin")),
            ("glitch",     Some("hblur")),
            ("mosaic",     Some("pixelize")),
            ("slide",      Some("slideleft")),
            ("smooth",     Some("smoothleft")),
        ];
        for (input, expected) in cases {
            let t = Transition::from_name(input);
            assert_eq!(t.xfade_name(), expected, "failed for: {input}");
        }
    }

    #[test]
    fn default_durations_bpm_aligned() {
        let t = Transition::Fade;
        // At 120 BPM: beat = 0.5s → Fade = 1 beat = 0.5s
        assert!((t.default_duration(120.0) - 0.5).abs() < 1e-6);
        // At 0 BPM: fallback = 0.5s
        assert!((t.default_duration(0.0) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn xfade_offset_calculation() {
        // 3 clips: 10s, 8s, 12s with 0.5s transitions
        // offset[0] = 10.0 - 0.5 = 9.5
        // offset[1] = 9.5 + 8.0 - 0.5 = 17.0
        let clips = vec![
            ClipSpec::new("a.mp4", 10.0, Transition::Fade).with_dur(0.5),
            ClipSpec::new("b.mp4",  8.0, Transition::Dissolve).with_dur(0.5),
            ClipSpec::new("c.mp4", 12.0, Transition::None),
        ];

        let mut timeline = 0.0f64;
        let offsets: Vec<f64> = clips[..2].iter().map(|c| {
            let td = c.effective_dur(0.0);
            timeline += c.duration_sec - td;
            timeline
        }).collect();

        assert!((offsets[0] - 9.5).abs() < 1e-6, "offset[0]={}", offsets[0]);
        assert!((offsets[1] - 17.0).abs() < 1e-6, "offset[1]={}", offsets[1]);
    }
}
