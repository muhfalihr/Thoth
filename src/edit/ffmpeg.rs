use std::path::Path;
use std::process::Stdio;

use tracing::{debug, warn};

use crate::config::FfmpegConfig;

use super::error::EditError;
use super::layout::OutputLayout;

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
pub fn encode_clip_direct(
    source: &Path,
    start_sec: f64,
    end_sec: f64,
    ass_path: &Path,
    layout: &OutputLayout,
    output: &Path,
    cfg: &FfmpegConfig,
) -> Result<(), EditError> {
    let fast_seek = (start_sec - SEEK_MARGIN_SECS).max(0.0);
    let duration  = end_sec - start_sec;

    // FFmpeg input-seek (-ss before -i) resets timestamps to 0.
    // We must use relative offsets for the trim filters.
    let rel_start = start_sec - fast_seek;
    let rel_end   = end_sec - fast_seek;

    let vf = build_video_filter(layout, ass_path, rel_start, rel_end);
    let (vcodec, extra_args) = build_encoder(cfg);

    // Compute fade-out start in Rust — FFmpeg cannot evaluate "29.87-0.5" as arithmetic
    const FADE_DUR: f64 = 0.5;
    let fade_out_start = (duration - FADE_DUR).max(0.0);

    // Audio filter: trim + fade-in/out + reset timestamps
    let af = format!(
        "atrim=start={rel_start:.3}:end={rel_end:.3},\
         asetpts=PTS-STARTPTS,\
         afade=t=in:st=0:d={FADE_DUR:.3},\
         afade=t=out:st={fade_out_start:.3}:d={FADE_DUR:.3}"
    );

    let mut args = vec![
        "-y".to_owned(),
        // Fast input seek for performance: land near the target keyframe
        "-ss".to_owned(), format!("{fast_seek:.3}"),
        "-i".to_owned(),  source.to_string_lossy().to_string(),
        // Video filter (includes trim + setpts for exact timestamp reset)
        "-vf".to_owned(), vf,
        // Audio filter (trim + asetpts to match video timing)
        "-af".to_owned(), af,
        // Duration safety net (avoids encoding beyond end_sec if trim is slightly off)
        "-t".to_owned(), format!("{duration:.3}"),
        // Encoder
        "-c:v".to_owned(), vcodec,
    ];
    args.extend(extra_args);
    args.extend([
        "-c:a".to_owned(),
        "aac".to_owned(),
        "-b:a".to_owned(),
        cfg.audio_bitrate.clone(),
        "-ac".to_owned(),
        "2".to_owned(),
        "-movflags".to_owned(),
        "+faststart".to_owned(),
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
fn build_video_filter(
    layout: &OutputLayout,
    ass_path: &Path,
    start_sec: f64,
    end_sec: f64,
) -> String {
    // Escape the ASS path for the FFmpeg filter graph
    let ass_str = ass_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");

    let subtitle_filter = format!("subtitles='{ass_str}'");

    // Trim to the exact clip window and reset timestamps to 0.
    // This must come BEFORE any split/overlay so the subtitle filter
    // sees 0-based timestamps that match the ASS event times.
    let trim = format!("trim=start={start_sec:.3}:end={end_sec:.3},setpts=PTS-STARTPTS");
    let duration = end_sec - start_sec;
    // Compute fade-out start in Rust — FFmpeg rejects arithmetic in filter option strings
    let fade_out_start = (duration - 0.5_f64).max(0.0);
    let fade = format!(
        "fade=t=in:st=0:d=0.500,\
         fade=t=out:st={fade_out_start:.3}:d=0.500"
    );

    match layout {
        OutputLayout::Vertical => {
            format!(
                "{trim},\
                 split=2[main][blur];\
                 [blur]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bg];\
                 [main]scale=-2:1080,setsar=1[fg];\
                 [bg][fg]overlay=(W-w)/2:(H-h)/2,{subtitle_filter},{fade},setsar=1"
            )
        }
        OutputLayout::Horizontal => {
            format!(
                "{trim},\
                 scale=1920:1080:force_original_aspect_ratio=decrease,\
                 pad=1920:1080:(ow-iw)/2:(oh-ih)/2,\
                 {subtitle_filter},{fade}"
            )
        }
        OutputLayout::Square => {
            format!(
                "{trim},\
                 crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080,{subtitle_filter},{fade}"
            )
        }
    }
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
