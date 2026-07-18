/// Beat detection utilities for beat-sync SFX/BGM timing.
///
/// **No external dependencies required** — BPM is read from audio file
/// metadata tags (ID3 `TBPM`, Vorbis `BPM`, etc.) using `ffprobe`.
/// Falls back to a per-vibe lookup table when no tag is present.
///
/// Used by the edit stage to:
///   1. Delay SFX so the impact lands ON a downbeat
///   2. Seek the BGM file to the nearest downbeat at clip start
///   3. Enable BGM volume ducking during speech

use std::path::Path;

use tracing::debug;

use crate::execution::{is_cancelled, JobExecutionContext};

// ── Per-vibe BPM fallback table ───────────────────────────────────────────────

/// Typical BPM for each BGM vibe category.
/// Used when the audio file has no BPM metadata tag.
fn default_bpm_for_vibe(vibe: &str) -> f32 {
    match vibe.to_lowercase().as_str() {
        "lofi"          => 85.0,
        "upbeat"        => 128.0,
        "cinematic"     => 100.0,
        "inspirational" => 110.0,
        _               => 120.0,  // safe general default
    }
}

// ── Metadata BPM reading ──────────────────────────────────────────────────────

/// Try to read BPM from audio file metadata using ffprobe.
///
/// Reads the `BPM`, `TBPM`, or `bpm` tag from the file's format metadata.
/// Returns `None` if no BPM tag is found or ffprobe is unavailable.
pub async fn read_bpm_from_metadata(
    execution: &JobExecutionContext,
    path: &Path,
) -> anyhow::Result<Option<f32>> {
    let ffprobe = find_ffprobe();

    // ffprobe -v quiet -show_entries format_tags=BPM,TBPM,bpm,tempo -of json {path}
    let mut command = tokio::process::Command::new(&ffprobe);
    command
            .args([
                "-v", "quiet",
                "-show_entries", "format_tags=BPM,TBPM,bpm,tempo,Bpm",
                "-of", "json",
                &path.to_string_lossy(),
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
    let output = match execution
        .output_with_timeout(&mut command, std::time::Duration::from_secs(5))
        .await
    {
        Ok(output) => output,
        Err(error) if is_cancelled(&error) => return Err(error),
        _ => return Ok(None),
    };

    let json_text = String::from_utf8_lossy(&output.stdout);
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_text) else {
        return Ok(None);
    };

    // Try multiple tag name variants (case differences between taggers)
    let tags = &json["format"]["tags"];
    for key in &["BPM", "TBPM", "bpm", "tempo", "Bpm"] {
        if let Some(val) = tags[key].as_str() {
            // BPM tag may contain decimal: "128.00"
            if let Ok(bpm) = val.trim().parse::<f32>() {
                if bpm > 20.0 && bpm < 300.0 {
                    debug!("beat_detect: read BPM {:.1} from metadata tag '{}': {}", bpm, key, path.display());
                    return Ok(Some(bpm));
                }
            }
        }
    }
    Ok(None)
}

/// Determine the effective BPM for a BGM file.
///
/// Priority:
///   1. Metadata tag (BPM / TBPM) in the audio file
///   2. Per-vibe lookup table fallback
pub async fn detect_bpm(
    execution: &JobExecutionContext,
    path: &Path,
    vibe: &str,
) -> anyhow::Result<f32> {
    if let Some(bpm) = read_bpm_from_metadata(execution, path).await? {
        return Ok(bpm);
    }
    let fallback = default_bpm_for_vibe(vibe);
    debug!("beat_detect: no BPM metadata for {} — using vibe fallback {:.0} BPM (vibe={})",
           path.file_name().unwrap_or_default().to_string_lossy(), fallback, vibe);
    Ok(fallback)
}

// ── Beat math ─────────────────────────────────────────────────────────────────

/// Convert BPM to the duration of one beat in milliseconds.
///
/// Examples: 120 BPM → 500 ms/beat,  128 BPM → 469 ms/beat
pub fn beat_interval_ms(bpm: f32) -> u32 {
    if bpm <= 0.0 { return 500; }
    (60_000.0 / bpm).round() as u32
}

/// Find the beat timestamp (ms) nearest to `target_ms` at or after t=0.
///
/// Returns 0 when `target_ms` is already very close to a beat (< half-interval away).
/// This ensures the SFX/BGM starts at a musically meaningful position.
pub fn nearest_beat_after_ms(bpm: f32, target_ms: u32) -> u32 {
    let interval = beat_interval_ms(bpm);
    if interval == 0 { return target_ms; }

    let beats_before  = target_ms / interval;
    let beat_before   = beats_before * interval;
    let beat_after    = beat_before + interval;

    // Pick the closer beat; prefer "before" on a tie (land on the beat, not after)
    if (beat_after - target_ms) < (target_ms - beat_before) {
        beat_after
    } else {
        beat_before
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn find_ffprobe() -> String {
    // Try alongside FFMPEG_PATH first
    if let Ok(ffmpeg) = std::env::var("FFMPEG_PATH") {
        let probe = std::path::Path::new(&ffmpeg)
            .with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
        if probe.exists() {
            return probe.to_string_lossy().to_string();
        }
    }
    // Fall back to PATH
    if cfg!(windows) { "ffprobe.exe".to_owned() } else { "ffprobe".to_owned() }
}
