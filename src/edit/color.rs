use serde::{Deserialize, Serialize};

use crate::gpu::effect::ColorParams;

// ── ColorGrading — user-facing struct ────────────────────────────────────────

/// Human-readable color grading parameters.
///
/// All values follow CapCut's slider conventions:
/// - Basic adjustments: `-1.0` to `1.0` (0 = unchanged)
/// - HSL per-channel: hue shift in degrees, sat/lum delta in -100..100
/// - Wheels: R/G/B shift in -1..1, saturation delta in -1..1
///
/// Serializable for config.toml, moments.json, and LLM output.
///
/// ```toml
/// # config.toml style profile example
/// [styles.profiles.cinematic.color]
/// saturation  = -0.1
/// contrast    = 0.15
/// temperature = -0.2
/// vignette    = 0.5
/// hsl_blue    = [0.0, 20.0, -5.0]
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ColorGrading {
    // ── Basic adjustments ─────────────────────────────────────────────────────
    /// Brightness: -1.0 (dark) to +1.0 (bright). Default 0.
    #[serde(default)]
    pub brightness: f32,

    /// Contrast: -1.0 to +1.0. Default 0.
    #[serde(default)]
    pub contrast: f32,

    /// Saturation: -1.0 (grayscale) to +1.0 (vivid). Default 0.
    #[serde(default)]
    pub saturation: f32,

    /// Color temperature: -1.0 (cool/blue) to +1.0 (warm/orange). Default 0.
    #[serde(default)]
    pub temperature: f32,

    /// Tint: -1.0 (green) to +1.0 (magenta). Default 0.
    #[serde(default)]
    pub tint: f32,

    // ── Tone ─────────────────────────────────────────────────────────────────
    /// Highlights: -1.0 to +1.0. Default 0.
    #[serde(default)]
    pub highlights: f32,

    /// Shadows: -1.0 to +1.0. Default 0.
    #[serde(default)]
    pub shadows: f32,

    /// Whites: -1.0 to +1.0. Default 0.
    #[serde(default)]
    pub whites: f32,

    /// Blacks: -1.0 to +1.0. Default 0.
    #[serde(default)]
    pub blacks: f32,

    // ── HSL per-channel ────────────────────────────────────────────────────────
    // Each field is [hue_shift°, saturation_delta (-100..100), luminance_delta (-100..100)]
    #[serde(default)] pub hsl_red:     [f32; 3],
    #[serde(default)] pub hsl_orange:  [f32; 3],
    #[serde(default)] pub hsl_yellow:  [f32; 3],
    #[serde(default)] pub hsl_green:   [f32; 3],
    #[serde(default)] pub hsl_cyan:    [f32; 3],
    #[serde(default)] pub hsl_blue:    [f32; 3],
    #[serde(default)] pub hsl_purple:  [f32; 3],
    #[serde(default)] pub hsl_magenta: [f32; 3],

    // ── Log Color Wheels (Shadow / Midtone / Highlight / Offset) ──────────────
    // Each is [r, g, b, saturation_delta] in -1..1
    #[serde(default)] pub wheel_shadow:    [f32; 4],
    #[serde(default)] pub wheel_midtone:   [f32; 4],
    #[serde(default)] pub wheel_highlight: [f32; 4],
    #[serde(default)] pub wheel_offset:    [f32; 4],

    /// Wheel tone range: lower bound (default 0.333 = shadow/midtone boundary)
    #[serde(default = "default_range_lo")]
    pub wheel_range_lo: f32,

    /// Wheel tone range: upper bound (default 0.550 = midtone/highlight boundary)
    #[serde(default = "default_range_hi")]
    pub wheel_range_hi: f32,

    // ── Detail ───────────────────────────────────────────────────────────────
    /// Sharpness: 0.0 (none) to 1.0 (maximum). Default 0.
    #[serde(default)]
    pub sharpen: f32,

    /// Vignette: 0.0 (none) to 1.0 (strong dark edges). Default 0.
    #[serde(default)]
    pub vignette: f32,

    /// Path to a .cube LUT file for cinematic color grading.
    /// Empty = no LUT applied.
    #[serde(default)]
    pub lut_path: String,
}

fn default_range_lo() -> f32 { 0.333 }
fn default_range_hi() -> f32 { 0.550 }

impl ColorGrading {
    /// Returns `true` when all parameters are identity (no GPU pass needed).
    pub fn is_identity(&self) -> bool {
        self.brightness  == 0.0 && self.contrast    == 0.0 &&
        self.saturation  == 0.0 && self.temperature == 0.0 &&
        self.tint        == 0.0 && self.highlights  == 0.0 &&
        self.shadows     == 0.0 && self.whites      == 0.0 &&
        self.blacks      == 0.0 && self.sharpen     == 0.0 &&
        self.vignette    == 0.0 && self.lut_path.is_empty() &&
        self.hsl_red    == [0.0; 3] && self.hsl_orange  == [0.0; 3] &&
        self.hsl_yellow == [0.0; 3] && self.hsl_green   == [0.0; 3] &&
        self.hsl_cyan   == [0.0; 3] && self.hsl_blue    == [0.0; 3] &&
        self.hsl_purple == [0.0; 3] && self.hsl_magenta == [0.0; 3] &&
        self.wheel_shadow    == [0.0; 4] && self.wheel_midtone   == [0.0; 4] &&
        self.wheel_highlight == [0.0; 4] && self.wheel_offset    == [0.0; 4]
    }

    /// Convert to the GPU uniform struct (`ColorParams`).
    pub fn to_gpu_params(&self) -> ColorParams {
        let hsl = |v: [f32; 3]| [v[0], v[1], v[2], 0.0f32];
        ColorParams {
            brightness:  self.brightness,
            contrast:    self.contrast,
            saturation:  self.saturation,
            temperature: self.temperature,
            tint:        self.tint,
            highlights:  self.highlights,
            shadows:     self.shadows,
            whites:      self.whites,
            blacks:      self.blacks,
            _pad0:       [0.0; 3],
            hsl_red:     hsl(self.hsl_red),
            hsl_orange:  hsl(self.hsl_orange),
            hsl_yellow:  hsl(self.hsl_yellow),
            hsl_green:   hsl(self.hsl_green),
            hsl_cyan:    hsl(self.hsl_cyan),
            hsl_blue:    hsl(self.hsl_blue),
            hsl_purple:  hsl(self.hsl_purple),
            hsl_magenta: hsl(self.hsl_magenta),
            wheel_shadow:    self.wheel_shadow,
            wheel_midtone:   self.wheel_midtone,
            wheel_highlight: self.wheel_highlight,
            wheel_offset:    self.wheel_offset,
            wheel_range_lo:  self.wheel_range_lo,
            wheel_range_hi:  self.wheel_range_hi,
            wheel_intensity: 1.0,
            _pad1: 0.0,
            sharpen:     self.sharpen,
            vignette:    self.vignette,
            lut_enabled: if self.lut_path.is_empty() { 0 } else { 1 },
            _pad2: 0.0,
            _pad3: [0.0; 3],
            _pad4: 0.0,
        }
    }

    /// Parse a simple color "mood" string (from LLM output) into a `ColorGrading`.
    ///
    /// LLM can output `color_mood` as one of these preset names, or leave it
    /// empty for no grading. Presets approximate real CapCut filter looks.
    pub fn from_mood(mood: &str) -> Self {
        match mood.to_lowercase().trim() {
            "cinematic" | "film" => Self {
                saturation:  -0.15,
                contrast:     0.20,
                temperature: -0.10,
                vignette:     0.45,
                highlights:  -0.15,
                shadows:      0.05,
                ..Default::default()
            },
            "warm" | "golden" | "summer" => Self {
                temperature:  0.35,
                saturation:   0.10,
                highlights:   0.05,
                ..Default::default()
            },
            "cool" | "moody" | "winter" => Self {
                temperature: -0.30,
                saturation:  -0.05,
                shadows:     -0.05,
                vignette:     0.30,
                ..Default::default()
            },
            "vibrant" | "pop" | "vivid" => Self {
                saturation:  0.30,
                contrast:    0.15,
                sharpen:     0.20,
                ..Default::default()
            },
            "faded" | "vintage" | "retro" => Self {
                saturation:  -0.25,
                contrast:    -0.10,
                blacks:       0.10,
                highlights:  -0.05,
                ..Default::default()
            },
            "night" | "dark" | "noir" => Self {
                brightness:  -0.20,
                contrast:     0.30,
                saturation:  -0.20,
                vignette:     0.60,
                temperature: -0.15,
                ..Default::default()
            },
            "bright" | "airy" | "clean" => Self {
                brightness:   0.15,
                contrast:    -0.10,
                saturation:   0.05,
                highlights:   0.10,
                shadows:      0.10,
                ..Default::default()
            },
            "teal_orange" | "blockbuster" => Self {
                temperature:       0.15,
                saturation:        0.10,
                wheel_shadow:      [-0.05, 0.05, 0.10, 0.0],
                wheel_highlight:   [0.10, 0.05, -0.05, 0.0],
                vignette:          0.35,
                contrast:          0.20,
                ..Default::default()
            },
            _ => Self::default(), // no grading
        }
    }
}

// ── Presets ───────────────────────────────────────────────────────────────────

/// Named preset — ready-to-use color looks matching common TikTok/Reels aesthetics.
pub struct ColorPresets;

impl ColorPresets {
    pub fn tiktok_viral() -> ColorGrading {
        ColorGrading {
            saturation: 0.20,
            contrast:   0.15,
            sharpen:    0.15,
            vignette:   0.25,
            ..Default::default()
        }
    }

    pub fn news_broadcast() -> ColorGrading {
        ColorGrading {
            saturation:  0.05,
            contrast:    0.10,
            temperature: 0.05,  // slightly warm
            ..Default::default()
        }
    }

    pub fn documentary() -> ColorGrading {
        ColorGrading {
            saturation:  -0.10,
            contrast:     0.15,
            temperature: -0.05,
            vignette:     0.30,
            ..Default::default()
        }
    }

    pub fn music_video() -> ColorGrading {
        ColorGrading {
            saturation:  0.25,
            contrast:    0.20,
            vignette:    0.40,
            sharpen:     0.10,
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_roundtrip() {
        let g = ColorGrading::default();
        assert!(g.is_identity());
        let p = g.to_gpu_params();
        assert!(p.is_identity());
    }

    #[test]
    fn mood_presets_not_identity() {
        for mood in &["cinematic", "warm", "vibrant", "faded", "teal_orange"] {
            let g = ColorGrading::from_mood(mood);
            assert!(!g.is_identity(), "{mood} should not be identity");
        }
    }

    #[test]
    fn unknown_mood_is_identity() {
        assert!(ColorGrading::from_mood("xyzzy").is_identity());
        assert!(ColorGrading::from_mood("").is_identity());
    }

    #[test]
    fn gpu_params_field_mapping() {
        let g = ColorGrading {
            saturation: 0.5,
            hsl_blue: [10.0, 20.0, -5.0],
            wheel_shadow: [0.1, -0.1, 0.05, 0.0],
            vignette: 0.4,
            ..Default::default()
        };
        let p = g.to_gpu_params();
        assert_eq!(p.saturation, 0.5);
        assert_eq!(p.hsl_blue, [10.0, 20.0, -5.0, 0.0]);
        assert_eq!(p.wheel_shadow, [0.1, -0.1, 0.05, 0.0]);
        assert_eq!(p.vignette, 0.4);
    }
}
