// Keyframe animation reverse-engineered from CapCut's bef_keyFrame_info_st
// (cccreator.dll, [Frame] tag strings) and AmazingEngine::AnimazKeyFrame.
//
// CapCut draft JSON stores keyframes per-property as:
//   { "time_offset": <microseconds>, "values": [...] }
// under tracks[].segments[].clip.keyframe_refs[].keyframes[].
//
// This module provides a Rust representation + FFmpeg filter generation for
// the animatable clip properties: position (x,y), scale, rotation, opacity,
// and crop rect.

use serde::{Deserialize, Serialize};

// ── Easing types ─────────────────────────────────────────────────────────────

/// Interpolation method between two keyframes.
/// Maps to CapCut's AMGInterpolationType / AMGValueCurvedInterpolationType.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Easing {
    #[default]
    Linear,
    /// Smooth ease-in-out (cubic bezier, CapCut default for most properties)
    EaseInOut,
    EaseIn,
    EaseOut,
    /// Constant / step function (jump to next value)
    Hold,
}

impl Easing {
    /// Evaluate the easing function at `t` ∈ [0, 1].
    pub fn apply(&self, t: f64) -> f64 {
        match self {
            Easing::Linear => t,
            Easing::EaseInOut => t * t * (3.0 - 2.0 * t),
            Easing::EaseIn => t * t,
            Easing::EaseOut => t * (2.0 - t),
            Easing::Hold => if t < 1.0 { 0.0 } else { 1.0 },
        }
    }
}

// ── Keyframe value types ──────────────────────────────────────────────────────

/// A single keyframe: time offset within the clip + value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyframe<T> {
    /// Time offset from clip start in seconds.
    pub time: f64,
    pub value: T,
    pub easing: Easing,
}

impl<T> Keyframe<T> {
    pub fn new(time: f64, value: T) -> Self {
        Self { time, value, easing: Easing::EaseInOut }
    }
    pub fn with_easing(mut self, easing: Easing) -> Self {
        self.easing = easing;
        self
    }
}

// ── Animated properties ───────────────────────────────────────────────────────

/// 2D position keyframes (pixels from center, or -0.5..0.5 normalized).
pub type PositionKf = Keyframe<[f64; 2]>;
/// Scale keyframes (1.0 = original size).
pub type ScaleKf = Keyframe<f64>;
/// Rotation keyframes (degrees clockwise).
pub type RotationKf = Keyframe<f64>;
/// Opacity keyframes (0.0 = transparent, 1.0 = opaque).
pub type OpacityKf = Keyframe<f64>;

/// All animatable properties for a single clip segment.
///
/// CapCut supports per-property keyframe tracks; each property can be
/// independently animated with its own timing + easing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KeyframeTrack {
    pub position:   Vec<PositionKf>,
    pub scale_x:    Vec<ScaleKf>,
    pub scale_y:    Vec<ScaleKf>,
    pub rotation:   Vec<RotationKf>,
    pub opacity:    Vec<OpacityKf>,
}

impl KeyframeTrack {
    pub fn is_empty(&self) -> bool {
        self.position.is_empty()
            && self.scale_x.is_empty()
            && self.scale_y.is_empty()
            && self.rotation.is_empty()
            && self.opacity.is_empty()
    }
}

// ── Interpolation ─────────────────────────────────────────────────────────────

fn interpolate_f64(frames: &[Keyframe<f64>], t: f64) -> Option<f64> {
    if frames.is_empty() { return None; }
    if t <= frames[0].time { return Some(frames[0].value); }
    let last = frames.last().unwrap();
    if t >= last.time { return Some(last.value); }

    for i in 1..frames.len() {
        if t <= frames[i].time {
            let lo = &frames[i-1];
            let hi = &frames[i];
            let span = (hi.time - lo.time).max(1e-9);
            let raw = (t - lo.time) / span;
            let eased = lo.easing.apply(raw);
            return Some(lo.value + (hi.value - lo.value) * eased);
        }
    }
    None
}

fn interpolate_vec2(frames: &[Keyframe<[f64; 2]>], t: f64) -> Option<[f64; 2]> {
    if frames.is_empty() { return None; }
    if t <= frames[0].time { return Some(frames[0].value); }
    let last = frames.last().unwrap();
    if t >= last.time { return Some(last.value); }

    for i in 1..frames.len() {
        if t <= frames[i].time {
            let lo = &frames[i-1];
            let hi = &frames[i];
            let span = (hi.time - lo.time).max(1e-9);
            let raw = (t - lo.time) / span;
            let eased = lo.easing.apply(raw);
            return Some([
                lo.value[0] + (hi.value[0] - lo.value[0]) * eased,
                lo.value[1] + (hi.value[1] - lo.value[1]) * eased,
            ]);
        }
    }
    None
}

/// Resolved property values at a given time.
#[derive(Debug, Clone)]
pub struct ResolvedFrame {
    pub x: f64,          // pixels from center (positive = right)
    pub y: f64,          // pixels from center (positive = up)
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation: f64,   // degrees clockwise
    pub opacity: f64,    // 0..1
}

impl Default for ResolvedFrame {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, scale_x: 1.0, scale_y: 1.0, rotation: 0.0, opacity: 1.0 }
    }
}

impl KeyframeTrack {
    /// Evaluate all properties at time `t` (seconds from clip start).
    pub fn eval(&self, t: f64) -> ResolvedFrame {
        let pos = interpolate_vec2(&self.position, t);
        ResolvedFrame {
            x:        pos.map(|p| p[0]).unwrap_or(0.0),
            y:        pos.map(|p| p[1]).unwrap_or(0.0),
            scale_x:  interpolate_f64(&self.scale_x, t).unwrap_or(1.0),
            scale_y:  interpolate_f64(&self.scale_y, t).unwrap_or(1.0),
            rotation: interpolate_f64(&self.rotation, t).unwrap_or(0.0),
            opacity:  interpolate_f64(&self.opacity, t).unwrap_or(1.0),
        }
    }
}

// ── CapCut preset animations ──────────────────────────────────────────────────

/// Named in-clip animation presets matching CapCut's built-in animations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipAnimation {
    None,
    FadeIn,
    FadeOut,
    FadeInOut,
    ZoomIn,
    ZoomOut,
    /// Drift right while fading in (CapCut "Float In")
    FloatIn,
    /// Drift left while fading out (CapCut "Float Out")
    FloatOut,
    /// Ken Burns pan left-to-right
    KenBurnsLeft,
    KenBurnsRight,
    /// Slow zoom into center
    KenBurnsZoomIn,
    /// Rotate slightly while zooming (CapCut "Rotate In")
    RotateIn,
    /// Pop scale up then settle (CapCut "Pop")
    Pop,
    /// Shake horizontally (CapCut "Shake")
    Shake,
}

impl ClipAnimation {
    /// Build a `KeyframeTrack` for this animation with the given clip duration (seconds).
    pub fn to_track(&self, duration: f64) -> KeyframeTrack {
        let mut track = KeyframeTrack::default();
        let d = duration;
        match self {
            ClipAnimation::None => {}

            ClipAnimation::FadeIn => {
                track.opacity = vec![
                    Keyframe::new(0.0, 0.0),
                    Keyframe::new(d * 0.4, 1.0),
                ];
            }
            ClipAnimation::FadeOut => {
                track.opacity = vec![
                    Keyframe::new(d * 0.6, 1.0),
                    Keyframe::new(d, 0.0),
                ];
            }
            ClipAnimation::FadeInOut => {
                track.opacity = vec![
                    Keyframe::new(0.0,      0.0),
                    Keyframe::new(d * 0.3,  1.0),
                    Keyframe::new(d * 0.7,  1.0),
                    Keyframe::new(d,        0.0),
                ];
            }
            ClipAnimation::ZoomIn => {
                track.scale_x = vec![
                    Keyframe::new(0.0, 1.0),
                    Keyframe::new(d,   1.15),
                ];
                track.scale_y = track.scale_x.clone();
            }
            ClipAnimation::ZoomOut => {
                track.scale_x = vec![
                    Keyframe::new(0.0, 1.15),
                    Keyframe::new(d,   1.0),
                ];
                track.scale_y = track.scale_x.clone();
            }
            ClipAnimation::FloatIn => {
                track.opacity = vec![Keyframe::new(0.0, 0.0), Keyframe::new(d * 0.4, 1.0)];
                track.position = vec![
                    Keyframe::new(0.0,      [-30.0, 0.0]),
                    Keyframe::new(d * 0.5,  [0.0, 0.0]),
                ];
            }
            ClipAnimation::FloatOut => {
                track.opacity = vec![Keyframe::new(d * 0.6, 1.0), Keyframe::new(d, 0.0)];
                track.position = vec![
                    Keyframe::new(d * 0.5, [0.0,   0.0]),
                    Keyframe::new(d,       [30.0, 0.0]),
                ];
            }
            ClipAnimation::KenBurnsLeft => {
                track.position = vec![
                    Keyframe::new(0.0, [30.0,  0.0]),
                    Keyframe::new(d,   [-30.0, 0.0]),
                ];
                track.scale_x = vec![Keyframe::new(0.0, 1.1), Keyframe::new(d, 1.1)];
                track.scale_y = track.scale_x.clone();
            }
            ClipAnimation::KenBurnsRight => {
                track.position = vec![
                    Keyframe::new(0.0, [-30.0, 0.0]),
                    Keyframe::new(d,   [30.0,  0.0]),
                ];
                track.scale_x = vec![Keyframe::new(0.0, 1.1), Keyframe::new(d, 1.1)];
                track.scale_y = track.scale_x.clone();
            }
            ClipAnimation::KenBurnsZoomIn => {
                track.scale_x = vec![Keyframe::new(0.0, 1.0), Keyframe::new(d, 1.2)];
                track.scale_y = track.scale_x.clone();
            }
            ClipAnimation::RotateIn => {
                track.rotation = vec![Keyframe::new(0.0, -5.0), Keyframe::new(d * 0.4, 0.0)];
                track.opacity  = vec![Keyframe::new(0.0, 0.0),  Keyframe::new(d * 0.35, 1.0)];
                track.scale_x  = vec![Keyframe::new(0.0, 0.85), Keyframe::new(d * 0.4, 1.0)];
                track.scale_y  = track.scale_x.clone();
            }
            ClipAnimation::Pop => {
                track.scale_x = vec![
                    Keyframe::new(0.0,       0.7),
                    Keyframe::new(d * 0.15,  1.05).with_easing(Easing::EaseOut),
                    Keyframe::new(d * 0.25,  0.98),
                    Keyframe::new(d * 0.35,  1.0),
                ];
                track.scale_y = track.scale_x.clone();
                track.opacity = vec![Keyframe::new(0.0, 0.0), Keyframe::new(d * 0.1, 1.0)];
            }
            ClipAnimation::Shake => {
                let step = d / 8.0;
                track.position = (0..=8)
                    .map(|i| {
                        let t = i as f64 * step;
                        let x = if i % 2 == 0 { 8.0 } else { -8.0 };
                        Keyframe::new(t, [x, 0.0]).with_easing(Easing::Linear)
                    })
                    .collect();
            }
        }
        track
    }
}

// ── FFmpeg overlay filter builder ─────────────────────────────────────────────

/// Generate an FFmpeg `overlay` filter expression that applies the keyframe
/// track to an overlay clip positioned on a base.
///
/// `base_w / base_h`: canvas size in pixels.
/// `clip_w / clip_h`: overlay clip natural size.
/// `fps`: frames per second (determines keyframe sample rate).
///
/// Returns a `(overlay_x, overlay_y)` expression pair for use in
/// `overlay=x_expr:y_expr:enable='...'`
pub fn track_to_overlay_expr(
    track: &KeyframeTrack,
    base_w: u32,
    base_h: u32,
    _clip_w: u32,
    _clip_h: u32,
    _fps: f64,
    duration: f64,
) -> (String, String, String) {
    // For static (no position keyframes), return center
    let cx = base_w as f64 / 2.0;
    let cy = base_h as f64 / 2.0;

    if track.position.is_empty() {
        return (
            format!("{}", cx as i64),
            format!("{}", cy as i64),
            format!("between(t,0,{duration:.3})"),
        );
    }

    // Sample at 25fps to build an if() chain
    let fps = 25.0_f64;
    let frames = (duration * fps).ceil() as usize;
    let mut x_parts = Vec::new();
    let mut y_parts = Vec::new();

    for i in 0..=frames {
        let t = (i as f64) / fps;
        let fr = track.eval(t);
        let x = cx + fr.x;
        let y = cy - fr.y; // FFmpeg y increases downward
        if i < frames {
            x_parts.push(format!("if(lte(t,{:.3}),{:.1}", t + 1.0/fps, x));
            y_parts.push(format!("if(lte(t,{:.3}),{:.1}", t + 1.0/fps, y));
        } else {
            x_parts.push(format!("{x:.1}"));
            y_parts.push(format!("{y:.1}"));
        }
    }

    // Close all the if() calls
    let close: String = ")".repeat(frames);
    let x_expr = format!("{}{}", x_parts.join(","), close);
    let y_expr = format!("{}{}", y_parts.join(","), close);

    (x_expr, y_expr, format!("between(t,0,{duration:.3})"))
}

/// Build an FFmpeg `zoompan` filter string from a `KeyframeTrack` for a clip
/// (scale + position animation baked into video, not overlay).
pub fn track_to_zoompan(
    track: &KeyframeTrack,
    w: u32,
    h: u32,
    fps: f64,
    duration: f64,
) -> Option<String> {
    if track.scale_x.is_empty() && track.position.is_empty() {
        return None;
    }

    let frames = (duration * fps).ceil() as usize;
    let mut zoom_pts: Vec<f64> = Vec::with_capacity(frames);
    let mut x_pts: Vec<f64> = Vec::with_capacity(frames);
    let mut y_pts: Vec<f64> = Vec::with_capacity(frames);

    for i in 0..frames {
        let t = i as f64 / fps;
        let fr = track.eval(t);
        zoom_pts.push(fr.scale_x.max(1.0));
        x_pts.push(w as f64 / 2.0 - w as f64 / (2.0 * fr.scale_x.max(1.0)) + fr.x);
        y_pts.push(h as f64 / 2.0 - h as f64 / (2.0 * fr.scale_y.max(1.0)) - fr.y);
    }

    // For simplicity emit first/last and let zoompan lerp (good enough for KenBurns)
    let z_start = zoom_pts.first().copied().unwrap_or(1.0);
    let z_end   = zoom_pts.last().copied().unwrap_or(1.0);
    let x_start = x_pts.first().copied().unwrap_or(0.0);
    let x_end   = x_pts.last().copied().unwrap_or(0.0);
    let y_start = y_pts.first().copied().unwrap_or(0.0);
    let y_end   = y_pts.last().copied().unwrap_or(0.0);

    let fcount = frames as f64;
    Some(format!(
        "zoompan=z='lerp({z_start:.4},{z_end:.4},on/{fcount:.0})':x='lerp({x_start:.1},{x_end:.1},on/{fcount:.0})':y='lerp({y_start:.1},{y_end:.1},on/{fcount:.0})':d={fcount:.0}:s={w}x{h}:fps={fps}"
    ))
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fade_in_opacity_at_t0_is_zero() {
        let track = ClipAnimation::FadeIn.to_track(5.0);
        let fr = track.eval(0.0);
        assert!(fr.opacity < 0.01, "opacity at t=0 should be 0, got {}", fr.opacity);
    }

    #[test]
    fn fade_in_opacity_at_end_is_one() {
        let track = ClipAnimation::FadeIn.to_track(5.0);
        let fr = track.eval(5.0);
        assert!((fr.opacity - 1.0).abs() < 0.01, "opacity at end should be 1");
    }

    #[test]
    fn ease_in_out_midpoint() {
        let v = Easing::EaseInOut.apply(0.5);
        assert!((v - 0.5).abs() < 0.01, "EaseInOut at t=0.5 should be 0.5");
    }

    #[test]
    fn pop_scale_peaks_above_one() {
        let track = ClipAnimation::Pop.to_track(2.0);
        let fr = track.eval(0.3); // ~15% through → peak
        assert!(fr.scale_x > 1.0, "Pop should scale above 1.0 at peak, got {}", fr.scale_x);
    }

    #[test]
    fn ken_burns_left_moves_right_to_left() {
        let track = ClipAnimation::KenBurnsLeft.to_track(5.0);
        let start_x = track.eval(0.0).x;
        let end_x   = track.eval(5.0).x;
        assert!(start_x > end_x, "KenBurnsLeft should move right→left, {start_x} > {end_x}");
    }

    #[test]
    fn all_animations_build_without_panic() {
        let anims = [
            ClipAnimation::None, ClipAnimation::FadeIn, ClipAnimation::FadeOut,
            ClipAnimation::FadeInOut, ClipAnimation::ZoomIn, ClipAnimation::ZoomOut,
            ClipAnimation::FloatIn, ClipAnimation::FloatOut,
            ClipAnimation::KenBurnsLeft, ClipAnimation::KenBurnsRight,
            ClipAnimation::KenBurnsZoomIn, ClipAnimation::RotateIn,
            ClipAnimation::Pop, ClipAnimation::Shake,
        ];
        for a in anims {
            let t = a.to_track(3.0);
            let _ = t.eval(1.5);
        }
    }
}
