//! Static avatar segment generation (Phase 5).
//!
//! Creates a short MP4 segment consisting of:
//!   - A background (news screenshot OR solid dark colour)
//!   - An optional avatar PNG overlay (PiP in the lower-centre area)
//!   - The TTS audio as the audio track
//!
//! The segment is designed to be appended AFTER (post-roll) or concatenated
//! alongside the main clip.  For post-roll: background = news screenshot so the
//! "host" appears to be commenting on the news context the viewer just saw.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tracing::{debug, info};

use crate::config::{AvatarMode, FfmpegConfig, ReactionConfig};
use crate::execution::JobExecutionContext;
use crate::news::util::{python_command, run_command};

use super::error::ReactionError;

/// Parameters for creating the avatar reaction segment.
pub struct AvatarSegmentSpec<'a> {
    /// Pre-rendered TTS audio file.
    pub tts_path: &'a Path,
    /// Duration of the segment (seconds) — should match TTS audio length.
    pub duration_secs: f64,
    /// Optional avatar PNG (transparent background preferred).
    pub avatar_image: Option<&'a Path>,
    /// Optional background image (e.g. formatted news screenshot).
    /// When `None` a dark-navy solid colour is used.
    pub background: Option<&'a Path>,
    /// Output frame dimensions (must match the main clip).
    pub clip_w: u32,
    pub clip_h: u32,
}

/// Generate an avatar reaction segment at `output_path`.
///
/// - `AvatarMode::SadTalker` — lip-synced talking head via SadTalker (GPU)
/// - `AvatarMode::StaticImage` — static PNG + TTS audio over news background
/// - `AvatarMode::None` — returns `Ok(None)` (caller skips)
pub async fn create_avatar_segment(
    execution: &JobExecutionContext,
    spec: &AvatarSegmentSpec<'_>,
    output_path: &Path,
    cfg: &FfmpegConfig,
    reaction: &ReactionConfig,
) -> Result<Option<PathBuf>, ReactionError> {
    match reaction.avatar.mode {
        AvatarMode::None => return Ok(None),
        AvatarMode::SadTalker => {
            return create_sadtalker_segment(execution, spec, output_path, reaction).await;
        }
        _ => {} // StaticImage and others fall through to FFmpeg approach
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let ffmpeg = ffmpeg_binary(cfg);
    let args   = build_avatar_segment_args(spec, output_path, cfg);

    debug!("avatar segment: ffmpeg {}", args.join(" "));

    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = execution.output(&mut command).await?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(ReactionError::Tts(format!(
            "avatar segment FFmpeg failed ({}): {}",
            output.status,
            err.chars().take(400).collect::<String>()
        )));
    }

    info!(
        "avatar segment created: {} ({:.1}s)",
        output_path.display(), spec.duration_secs
    );
    Ok(Some(output_path.to_path_buf()))
}

/// Build the FFmpeg argument list for the avatar segment.
fn build_avatar_segment_args(
    spec:   &AvatarSegmentSpec<'_>,
    output: &Path,
    cfg:    &FfmpegConfig,
) -> Vec<String> {
    let w = spec.clip_w;
    let h = spec.clip_h;
    let dur = spec.duration_secs;
    let has_bg     = spec.background.is_some();
    let has_avatar = spec.avatar_image.is_some();

    // ── Input construction ────────────────────────────────────────────────────
    // [0] background (lavfi colour OR looped PNG)
    // [1] avatar PNG (if provided, -loop 1)
    // [last] TTS audio

    let mut args: Vec<String> = vec!["-y".into()];

    // Background input
    if let Some(bg) = spec.background {
        args.extend(["-loop".into(), "1".into(),
                     "-i".into(), bg.to_string_lossy().to_string()]);
    } else {
        // Dark navy solid color background
        args.extend([
            "-f".into(), "lavfi".into(),
            "-i".into(), format!("color=c=0x1a1a2e:size={w}x{h}:rate=25"),
        ]);
    }

    // Avatar PNG input
    let avatar_idx = if has_avatar {
        args.extend(["-loop".into(), "1".into(),
                     "-i".into(), spec.avatar_image.unwrap().to_string_lossy().to_string()]);
        Some(1usize)
    } else { None };

    // TTS audio input
    let audio_idx = if has_avatar { 2usize } else { 1usize };
    args.extend(["-i".into(), spec.tts_path.to_string_lossy().to_string()]);

    // ── Filter complex ────────────────────────────────────────────────────────
    let filter = build_filter(w, h, dur, has_bg, avatar_idx);
    args.extend(["-filter_complex".into(), filter]);

    // ── Maps ──────────────────────────────────────────────────────────────────
    args.extend(["-map".into(), "[outv]".into(),
                 "-map".into(), format!("{audio_idx}:a")]);

    // ── Duration cap (match TTS length) ───────────────────────────────────────
    args.extend(["-t".into(), format!("{dur:.3}")]);

    // ── Codec ─────────────────────────────────────────────────────────────────
    let vcodec = if cfg.nvenc {
        vec!["h264_nvenc".into(),
             "-cq".into(), cfg.cq_value.to_string(),
             "-preset".into(), cfg.preset.clone()]
    } else {
        vec!["libx264".into(),
             "-crf".into(), cfg.cq_value.to_string(),
             "-preset".into(), "fast".into()]
    };
    args.extend(["-c:v".into()]);
    args.extend(vcodec);
    args.extend(["-c:a".into(), "aac".into(),
                 "-b:a".into(), cfg.audio_bitrate.clone(),
                 "-movflags".into(), "+faststart".into(),
                 "-pix_fmt".into(), "yuv420p".into(),
                 output.to_string_lossy().to_string()]);

    args
}

/// Build the filter_complex string for the avatar segment.
fn build_filter(
    w: u32, h: u32,
    dur: f64,
    _has_bg: bool,
    avatar_idx: Option<usize>,
) -> String {
    let _dur_frames = (dur * 25.0).ceil() as u32;

    // Background: scale + crop to exact frame size
    let bg_filter = format!(
        "[0:v]fps=25,scale={w}:{h}:force_original_aspect_ratio=increase,\
         crop={w}:{h},setsar=1,\
         trim=duration={dur:.3}[bg]"
    );

    // Optional "REAKSI" label at top of background
    let label_filter = format!(
        "[bg]drawtext=\
         text='REAKSI':fontcolor=white@0.7:fontsize=50:\
         x=(w-text_w)/2:y=60:\
         shadowx=2:shadowy=2:shadowcolor=black@0.7\
         [bg_lbl]"
    );

    if let Some(av_i) = avatar_idx {
        // Scale avatar to ~40% frame width, centered horizontally, 55% from top
        let av_w = w * 40 / 100;
        let av_x = format!("(W-w)/2");
        let av_y = format!("H*55/100");
        format!(
            "{bg_filter};{label_filter};\
             [{av_i}:v]fps=25,\
             scale={av_w}:-2,setsar=1,\
             trim=duration={dur:.3}[av];\
             [bg_lbl][av]overlay=x={av_x}:y={av_y}[outv]",
            dur = dur,
        )
    } else {
        format!("{bg_filter};{label_filter};[bg_lbl]setsar=1[outv]")
    }
}

// ── SadTalker mode ────────────────────────────────────────────────────────────

/// Run SadTalker to produce a lip-synced talking head video.
///
/// Calls `scripts/media/sadtalker_generate.py` via the `thoth-sadtalker` conda env.
/// The script wraps SadTalker's `inference.py` and returns a JSON envelope.
async fn create_sadtalker_segment(
    execution: &JobExecutionContext,
    spec:     &AvatarSegmentSpec<'_>,
    output:   &Path,
    reaction: &ReactionConfig,
) -> Result<Option<PathBuf>, ReactionError> {
    let avatar_img = match spec.avatar_image {
        Some(p) => p,
        None => {
            return Err(ReactionError::Tts(
                "SadTalker mode requires reaction.avatar.image_path to be set".to_owned()
            ));
        }
    };

    let script = &reaction.avatar.sadtalker_script;
    if !script.exists() {
        return Err(ReactionError::Tts(format!(
            "sadtalker_generate.py not found: {}. Check reaction.avatar.sadtalker_script.",
            script.display()
        )));
    }

    // Build a NewsConfig-compatible struct so python_command() can resolve
    // conda env. We re-use the news module's helper with sadtalker_env.
    let fake_news_cfg = crate::config::NewsConfig {
        conda_env: reaction.avatar.sadtalker_env.clone(),
        python_path: "python".to_owned(),
        ..Default::default()
    };

    let mut cmd = python_command(&fake_news_cfg, script)
        .map_err(|e| ReactionError::Tts(e.to_string()))?;

    cmd.arg("--audio").arg(spec.tts_path)
        .arg("--image").arg(avatar_img)
        .arg("--output").arg(output)
        .arg("--sadtalker-dir").arg(&reaction.avatar.sadtalker_dir)
        .arg("--size").arg(reaction.avatar.sadtalker_size.to_string());
    if reaction.avatar.sadtalker_still {
        cmd.arg("--still");
    }

    info!(
        "SadTalker: audio={}, image={}, size={}, still={}",
        spec.tts_path.display(), avatar_img.display(),
        reaction.avatar.sadtalker_size, reaction.avatar.sadtalker_still
    );

    // SadTalker can take 1-3 minutes on GPU — use generous timeout.
    let stdout = run_command(execution, cmd, "sadtalker", 300)
        .await
        .map_err(|e| ReactionError::Tts(e.to_string()))?;

    let env: serde_json::Value = serde_json::from_str(
        stdout.trim().find('{').map(|i| &stdout[i..]).unwrap_or(stdout.trim())
    ).map_err(|e| ReactionError::Tts(format!("parse sadtalker output: {e}")))?;

    if !env["success"].as_bool().unwrap_or(false) {
        let err = env["error"].as_str().unwrap_or("unknown").to_owned();
        return Err(ReactionError::Tts(format!("SadTalker: {err}")));
    }

    let path = env["path"].as_str()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .ok_or_else(|| ReactionError::Tts("SadTalker: output file not found".to_owned()))?;

    info!("SadTalker output → {}", path.display());
    Ok(Some(path))
}

fn ffmpeg_binary(cfg: &FfmpegConfig) -> PathBuf {
    if let Some(ref p) = cfg.ffmpeg_path {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("FFMPEG_PATH") {
        return PathBuf::from(p);
    }
    ffmpeg_sidecar::paths::ffmpeg_path()
}
