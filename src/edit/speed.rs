// Speed ramp implementation reverse-engineered from CapCut's CurveSpeedInfo /
// AudioCurveSpeedProcessor (cccreator.dll vesdk::ccmodel namespace).
//
// CapCut stores speed as a bezier curve: a list of (time_norm, speed_multiplier)
// control points that define a piecewise cubic spline over the clip duration.
// The audio pitch is preserved by the PitchTempoAdjuster (mammon:: namespace)
// which decouples pitch from tempo independently.

use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

// ── Types ─────────────────────────────────────────────────────────────────────

/// A single point on the speed curve: `time` ∈ [0,1] (normalized clip position),
/// `speed` = multiplier (0.1 = 10%, 4.0 = 400%).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SpeedPoint {
    /// Normalized time in the clip, 0.0 = start, 1.0 = end.
    pub time: f64,
    /// Speed multiplier. 1.0 = normal, 0.5 = slow-mo, 2.0 = fast-forward.
    pub speed: f64,
}

/// CapCut CurveSpeedInfo equivalent — a sorted list of (time, speed) knots
/// that define a speed ramp applied to a clip.
///
/// The curve is evaluated with linear interpolation between knots (matching
/// CapCut's default behavior; bezier smoothing can be added later).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeedCurve {
    pub points: Vec<SpeedPoint>,
    /// Whether to preserve audio pitch during speed changes (CapCut default: true).
    pub pitch_preserve: bool,
}

impl Default for SpeedCurve {
    fn default() -> Self {
        Self {
            points: vec![SpeedPoint { time: 0.0, speed: 1.0 }, SpeedPoint { time: 1.0, speed: 1.0 }],
            pitch_preserve: true,
        }
    }
}

/// Named CapCut-style speed ramp presets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeedPreset {
    /// Constant speed change across entire clip.
    Constant(u32), // stored as thousandths to avoid f32 in enum
    /// Slow at start, speed up — "Hero Entrance"
    SlowToFast,
    /// Fast at start, slow down — "Dramatic Reveal"
    FastToSlow,
    /// Normal → slow at peak → normal — "Highlight Moment"
    MontageHit,
    /// Ramp up in first quarter, hold fast, ramp down — "Action Sequence"
    RaceMode,
    /// Rapid speed oscillation — "Glitch / Heartbeat"
    Heartbeat,
    /// Freeze on beat then resume — "Freeze Frame"
    BeatFreeze,
    /// Custom curve defined by explicit points.
    Custom,
}

impl SpeedCurve {
    pub fn from_preset(preset: SpeedPreset) -> Self {
        match preset {
            SpeedPreset::Constant(thousandths) => {
                let s = thousandths as f64 / 1000.0;
                Self { points: vec![SpeedPoint { time: 0.0, speed: s }, SpeedPoint { time: 1.0, speed: s }], pitch_preserve: true }
            }
            SpeedPreset::SlowToFast => Self {
                pitch_preserve: true,
                points: vec![
                    SpeedPoint { time: 0.0,  speed: 0.3 },
                    SpeedPoint { time: 0.25, speed: 0.5 },
                    SpeedPoint { time: 0.6,  speed: 1.0 },
                    SpeedPoint { time: 1.0,  speed: 2.0 },
                ],
            },
            SpeedPreset::FastToSlow => Self {
                pitch_preserve: true,
                points: vec![
                    SpeedPoint { time: 0.0,  speed: 2.5 },
                    SpeedPoint { time: 0.4,  speed: 1.0 },
                    SpeedPoint { time: 0.75, speed: 0.5 },
                    SpeedPoint { time: 1.0,  speed: 0.25 },
                ],
            },
            SpeedPreset::MontageHit => Self {
                pitch_preserve: true,
                points: vec![
                    SpeedPoint { time: 0.0,  speed: 1.0 },
                    SpeedPoint { time: 0.35, speed: 1.0 },
                    SpeedPoint { time: 0.5,  speed: 0.15 },
                    SpeedPoint { time: 0.65, speed: 1.0 },
                    SpeedPoint { time: 1.0,  speed: 1.0 },
                ],
            },
            SpeedPreset::RaceMode => Self {
                pitch_preserve: true,
                points: vec![
                    SpeedPoint { time: 0.0,  speed: 1.0 },
                    SpeedPoint { time: 0.2,  speed: 3.0 },
                    SpeedPoint { time: 0.8,  speed: 3.0 },
                    SpeedPoint { time: 1.0,  speed: 1.0 },
                ],
            },
            SpeedPreset::Heartbeat => Self {
                pitch_preserve: true,
                points: vec![
                    SpeedPoint { time: 0.0,  speed: 1.0 },
                    SpeedPoint { time: 0.1,  speed: 3.0 },
                    SpeedPoint { time: 0.2,  speed: 0.3 },
                    SpeedPoint { time: 0.3,  speed: 3.0 },
                    SpeedPoint { time: 0.4,  speed: 0.3 },
                    SpeedPoint { time: 0.5,  speed: 3.0 },
                    SpeedPoint { time: 0.6,  speed: 0.3 },
                    SpeedPoint { time: 0.7,  speed: 3.0 },
                    SpeedPoint { time: 0.8,  speed: 1.0 },
                    SpeedPoint { time: 1.0,  speed: 1.0 },
                ],
            },
            SpeedPreset::BeatFreeze => Self {
                pitch_preserve: true,
                points: vec![
                    SpeedPoint { time: 0.0,  speed: 1.0 },
                    SpeedPoint { time: 0.45, speed: 1.0 },
                    SpeedPoint { time: 0.46, speed: 0.01 },
                    SpeedPoint { time: 0.54, speed: 0.01 },
                    SpeedPoint { time: 0.55, speed: 1.0 },
                    SpeedPoint { time: 1.0,  speed: 1.0 },
                ],
            },
            SpeedPreset::Custom => Self::default(),
        }
    }

    /// Evaluate speed multiplier at normalized time `t` ∈ [0, 1].
    /// Uses piecewise linear interpolation between knots (same as CapCut default).
    pub fn speed_at(&self, t: f64) -> f64 {
        let pts = &self.points;
        if pts.is_empty() { return 1.0; }
        if t <= pts[0].time { return pts[0].speed; }
        if t >= pts[pts.len()-1].time { return pts[pts.len()-1].speed; }

        for i in 1..pts.len() {
            if t <= pts[i].time {
                let lo = &pts[i-1];
                let hi = &pts[i];
                let frac = (t - lo.time) / (hi.time - lo.time).max(1e-9);
                return lo.speed + (hi.speed - lo.speed) * frac;
            }
        }
        1.0
    }

    /// Compute the output duration of the clip given its input duration (seconds).
    ///
    /// CapCut remaps wall-clock time: at a speed of 2× the clip consumes 2 input-seconds
    /// per 1 output-second, so the output is shorter. This integrates the curve.
    pub fn output_duration(&self, input_dur: f64) -> f64 {
        const STEPS: usize = 1000;
        let dt = 1.0 / STEPS as f64;
        let mut integral = 0.0;
        for i in 0..STEPS {
            let t = (i as f64 + 0.5) * dt;
            integral += 1.0 / self.speed_at(t).max(0.01);
        }
        input_dur * integral * dt
    }

    /// Build a setpts filter expression for FFmpeg from the curve.
    ///
    /// FFmpeg `setpts` works on PTS (presentation timestamp) in the input stream.
    /// For constant speed this is trivially `(1/speed)*PTS`. For a curve we have
    /// to use the `expr` form which is evaluated per-frame — but `setpts` only has
    /// access to `PTS` not normalized time, so we emit a lookup table approximation
    /// via `if()`-chained expressions.
    ///
    /// Returns `None` if the curve is essentially constant (all speeds equal).
    pub fn to_ffmpeg_setpts(&self, input_dur: f64) -> Option<String> {
        // Detect constant curve
        if self.is_constant() {
            let s = self.points[0].speed;
            if (s - 1.0).abs() < 1e-4 { return None; }
            return Some(format!("{:.6}/TB/{}*TB", 1.0/s, 1));
        }

        // Build piecewise constant approximation via chained ternary.
        // Each segment: if(lt(T,t_hi), slope*PTS+offset, ...)
        // T = PTS*TB gives seconds. For variable speed we need the inverse mapping.
        let pts_expr = self.build_setpts_expr(input_dur);
        Some(pts_expr)
    }

    fn is_constant(&self) -> bool {
        if self.points.len() < 2 { return true; }
        let s0 = self.points[0].speed;
        self.points.iter().all(|p| (p.speed - s0).abs() < 1e-4)
    }

    fn build_setpts_expr(&self, input_dur: f64) -> String {
        // Approximate with 50 segments: map each input PTS to output PTS.
        // output_pts(t) = ∫₀ᵗ (1/speed(τ)) dτ * input_dur
        const SEGMENTS: usize = 50;
        let dt = 1.0 / SEGMENTS as f64;

        // Precompute output PTS checkpoints
        let mut checkpoints: Vec<(f64, f64)> = Vec::with_capacity(SEGMENTS + 1);
        let mut acc = 0.0;
        for i in 0..=SEGMENTS {
            let t_in = i as f64 * dt * input_dur;
            checkpoints.push((t_in, acc * input_dur));
            if i < SEGMENTS {
                let t_norm = (i as f64 + 0.5) * dt;
                acc += (1.0 / self.speed_at(t_norm).max(0.01)) * dt;
            }
        }

        // Build if() chain from the end
        let mut expr = format!("{:.6}*PTS", 1.0 / self.points.last().unwrap().speed.max(0.01));
        for i in (1..checkpoints.len()).rev() {
            let (t_in, t_out) = checkpoints[i-1];
            let slope = if i < checkpoints.len() {
                let dt_in = checkpoints[i].0 - t_in;
                let dt_out = checkpoints[i].1 - t_out;
                if dt_in.abs() < 1e-9 { 1.0 } else { dt_out / dt_in }
            } else { 1.0 };
            let offset = t_out - slope * t_in;
            expr = format!(
                "if(lt(PTS*TB,{:.6}),{:.6}*PTS*TB+{:.6},{})",
                checkpoints[i].0, slope, offset, expr
            );
        }
        expr
    }
}

// ── FFmpeg filter builder ──────────────────────────────────────────────────────

/// Apply a speed curve to a clip using FFmpeg subprocess.
///
/// Output file is written to `output`. Audio pitch is preserved when
/// `curve.pitch_preserve = true` via `atempo` filter (max 2× per stage).
pub async fn apply_speed_curve(
    input:   &Path,
    output:  &Path,
    start:   f64,
    end:     f64,
    curve:   &SpeedCurve,
    nvenc:   bool,
) -> Result<()> {
    let input_dur = end - start;
    let ffmpeg = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into());

    // Build video filter chain
    let video_filter = if let Some(setpts) = curve.to_ffmpeg_setpts(input_dur) {
        format!("trim={start:.3}:{end:.3},setpts=PTS-STARTPTS,setpts={setpts},setpts=PTS-STARTPTS")
    } else {
        format!("trim={start:.3}:{end:.3},setpts=PTS-STARTPTS")
    };

    // Build audio filter chain (atempo supports 0.5–100.0, chain for extremes)
    let audio_filter = build_atempo_chain(curve, input_dur);

    let vcodec = if nvenc { vec!["-c:v", "h264_nvenc", "-preset", "p4"] }
                 else     { vec!["-c:v", "libx264",    "-preset", "fast"] };

    let status = tokio::process::Command::new(&ffmpeg)
        .args(["-y", "-i", &input.to_string_lossy()])
        .args(["-vf", &video_filter])
        .args(["-af", &audio_filter])
        .args(vcodec)
        .args(["-crf", "23", "-c:a", "aac", "-b:a", "192k"])
        .arg(output.to_string_lossy().as_ref())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("ffmpeg spawn failed")?;

    anyhow::ensure!(status.success(), "ffmpeg speed curve failed: exit {:?}", status.code());
    Ok(())
}

fn build_atempo_chain(curve: &SpeedCurve, input_dur: f64) -> String {
    // Average speed across the clip
    let avg_speed = {
        const S: usize = 100;
        let sum: f64 = (0..S).map(|i| curve.speed_at((i as f64 + 0.5) / S as f64)).sum();
        sum / S as f64
    };
    let _ = input_dur; // reserved for per-segment atempo later

    // Chain multiple atempo filters if speed is outside [0.5, 2.0]
    let mut filters = Vec::new();
    let mut remaining = avg_speed.clamp(0.1, 10.0);

    loop {
        if remaining > 2.0 {
            filters.push("atempo=2.0".to_string());
            remaining /= 2.0;
        } else if remaining < 0.5 {
            filters.push("atempo=0.5".to_string());
            remaining /= 0.5;
        } else {
            filters.push(format!("atempo={remaining:.4}"));
            break;
        }
        if filters.len() > 6 { break; } // safety
    }

    if !curve.pitch_preserve {
        // No pitch preservation — just use asetrate (changes pitch with speed)
        return format!("asetrate=48000*{avg_speed:.4},aresample=48000");
    }

    filters.join(",")
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_speed_1x_no_setpts() {
        let curve = SpeedCurve::from_preset(SpeedPreset::Constant(1000));
        assert!(curve.to_ffmpeg_setpts(10.0).is_none());
    }

    #[test]
    fn constant_speed_2x_setpts() {
        let curve = SpeedCurve::from_preset(SpeedPreset::Constant(2000));
        let expr = curve.to_ffmpeg_setpts(10.0);
        assert!(expr.is_some());
        assert!(expr.unwrap().contains("0.5"));
    }

    #[test]
    fn speed_at_interpolates() {
        let curve = SpeedCurve::from_preset(SpeedPreset::SlowToFast);
        let s0 = curve.speed_at(0.0);
        let s1 = curve.speed_at(1.0);
        let mid = curve.speed_at(0.5);
        assert!(s0 < mid, "should accelerate through clip");
        assert!(mid < s1, "should keep accelerating");
    }

    #[test]
    fn output_duration_halved_at_2x() {
        let curve = SpeedCurve::from_preset(SpeedPreset::Constant(2000));
        let dur = curve.output_duration(10.0);
        assert!((dur - 5.0).abs() < 0.1, "2× speed → ~half duration, got {dur}");
    }

    #[test]
    fn output_duration_doubled_at_half_speed() {
        let curve = SpeedCurve::from_preset(SpeedPreset::Constant(500));
        let dur = curve.output_duration(10.0);
        assert!((dur - 20.0).abs() < 0.2, "0.5× speed → ~double duration, got {dur}");
    }

    #[test]
    fn all_presets_build_without_panic() {
        let presets = [
            SpeedPreset::SlowToFast, SpeedPreset::FastToSlow,
            SpeedPreset::MontageHit, SpeedPreset::RaceMode,
            SpeedPreset::Heartbeat,  SpeedPreset::BeatFreeze,
        ];
        for p in presets {
            let c = SpeedCurve::from_preset(p);
            let _ = c.to_ffmpeg_setpts(10.0);
        }
    }
}
