//! Giant multi-colour hook title (the 0–3 s scroll-stopper).
//!
//! Renders the clip's hook/headline as a big, stacked, per-word-coloured title in
//! the upper third — the signature look of Indonesian reaction-news Shorts. Built
//! as a standalone ASS file that the encoder burns as a SECOND `subtitles=` filter
//! on top of the running karaoke subtitles, so it needs no extra inputs.
//!
//! Each word cycles through a palette; the whole line pops in with a scale bounce.

use std::path::Path;

use super::error::EditError;

/// Everything needed to render one hook-title ASS file.
#[derive(Debug, Clone)]
pub struct HookTitleSpec {
    /// The hook text (will be upper-cased). Usually `moment.headline` or `moment.hook`.
    pub text: String,
    /// Show the title from t=0 to this many seconds.
    pub duration_sec: f64,
    /// Per-word colours as `#RRGGBB`, cycled across words. Empty ⇒ all white.
    pub palette: Vec<String>,
    /// ASS font family name (e.g. "Montserrat ExtraBold").
    pub font: String,
    /// Font size in ASS units (PlayRes 1080×1920). ~100 is giant.
    pub fontsize: u32,
    /// Outline thickness in px.
    pub outline_px: u32,
    /// Distance from the TOP of the frame (alignment 8). ~360 = upper third.
    pub margin_v: u32,
    /// Apply the scale-bounce pop-in animation.
    pub animate: bool,
}

impl HookTitleSpec {
    /// True when there is nothing meaningful to render.
    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }
}

/// Generate the hook-title ASS file at `output_path`.
pub fn generate_hook_ass(spec: &HookTitleSpec, output_path: &Path) -> Result<(), EditError> {
    let mut ass = String::new();
    ass.push_str("[Script Info]\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("PlayResX: 1080\n");
    ass.push_str("PlayResY: 1920\n");
    ass.push_str("ScaledBorderAndShadow: yes\n\n");

    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, \
                  OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, \
                  ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, \
                  Alignment, MarginL, MarginR, MarginV, Encoding\n");
    // Alignment 8 = top-centre; thick black outline + soft shadow for punch.
    ass.push_str(&format!(
        "Style: Hook,{font},{size},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,\
         -1,0,0,0,100,100,0,0,1,{outline},4,8,60,60,{mv},1\n\n",
        font = spec.font,
        size = spec.fontsize,
        outline = spec.outline_px,
        mv = spec.margin_v,
    ));

    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    if !spec.is_empty() {
        let end = ms_to_ass_time((spec.duration_sec.max(0.3) * 1000.0) as i64);
        let body = build_dialogue_text(spec);
        ass.push_str(&format!("Dialogue: 0,0:00:00.00,{end},Hook,,0,0,0,,{body}\n"));
    }

    std::fs::write(output_path, ass).map_err(EditError::Io)?;
    Ok(())
}

/// Build the Dialogue text: animation override + per-word colour tags + `\N` breaks.
fn build_dialogue_text(spec: &HookTitleSpec) -> String {
    let clean = sanitize(&spec.text).to_uppercase();
    let words: Vec<&str> = clean.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }

    let lines = wrap_words(&words, 12, 4);
    let palette: Vec<String> = if spec.palette.is_empty() {
        vec!["#FFFFFF".to_string()]
    } else {
        spec.palette.clone()
    };

    // Build coloured lines, cycling the palette across ALL words (not per line)
    // so adjacent words always differ.
    let mut wi = 0usize;
    let mut rendered_lines: Vec<String> = Vec::new();
    for line in &lines {
        let mut s = String::new();
        for (j, w) in line.iter().enumerate() {
            if j > 0 {
                s.push(' ');
            }
            let col = hex_to_ass_color(&palette[wi % palette.len()]);
            s.push_str(&format!("{{\\c{col}}}{w}"));
            wi += 1;
        }
        rendered_lines.push(s);
    }
    let colored = rendered_lines.join("\\N");

    let anim = if spec.animate {
        // fade in/out + scale bounce (overshoot then settle)
        "{\\fad(120,200)\\fscx55\\fscy55\\t(0,160,\\fscx110\\fscy110)\\t(160,260,\\fscx100\\fscy100)}"
    } else {
        "{\\fad(120,200)}"
    };

    format!("{anim}{colored}")
}

/// Convert `#RRGGBB` to an inline ASS colour `&HBBGGRR&`. Falls back to white.
fn hex_to_ass_color(hex: &str) -> String {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        let r = &h[0..2];
        let g = &h[2..4];
        let b = &h[4..6];
        format!("&H{}{}{}&", b.to_uppercase(), g.to_uppercase(), r.to_uppercase())
    } else {
        "&HFFFFFF&".to_string()
    }
}

/// Greedy word-wrap by character budget, capped at `max_lines`. Overflow words
/// are appended to the last line.
fn wrap_words<'a>(words: &[&'a str], max_chars: usize, max_lines: usize) -> Vec<Vec<&'a str>> {
    let mut lines: Vec<Vec<&str>> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut cur_len = 0usize;
    for w in words {
        let add = if cur.is_empty() { w.len() } else { w.len() + 1 };
        if !cur.is_empty() && cur_len + add > max_chars && lines.len() + 1 < max_lines {
            lines.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        cur_len += if cur.is_empty() { w.len() } else { w.len() + 1 };
        cur.push(w);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

/// Strip characters that would break ASS override parsing.
fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .filter(|c| !matches!(c, '{' | '}' | '\\'))
        .collect()
}

/// Convert milliseconds to ASS time `H:MM:SS.cc`.
fn ms_to_ass_time(ms: i64) -> String {
    let ms = ms.max(0);
    let cs = (ms % 1000) / 10;
    let s = (ms / 1000) % 60;
    let m = (ms / 60_000) % 60;
    let h = ms / 3_600_000;
    format!("{h}:{m:02}:{s:02}.{cs:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(text: &str) -> HookTitleSpec {
        HookTitleSpec {
            text: text.into(),
            duration_sec: 3.0,
            palette: vec!["#3DDC4A".into(), "#FFE34D".into(), "#3FC1FF".into()],
            font: "Montserrat ExtraBold".into(),
            fontsize: 100,
            outline_px: 6,
            margin_v: 360,
            animate: true,
        }
    }

    #[test]
    fn hex_converts_to_bgr() {
        assert_eq!(hex_to_ass_color("#3DDC4A"), "&H4ADC3D&");
        assert_eq!(hex_to_ass_color("#FFFFFF"), "&HFFFFFF&");
        assert_eq!(hex_to_ass_color("bad"), "&HFFFFFF&");
    }

    #[test]
    fn dialogue_has_colors_breaks_and_anim() {
        let t = build_dialogue_text(&spec("bro ini kena ban sama author"));
        assert!(t.contains("\\fad("));
        assert!(t.contains("\\fscx55"));        // pop animation present
        assert!(t.contains("{\\c&H4ADC3D&}BRO")); // first word colored + uppercased
        assert!(t.contains("\\N"));               // wrapped to multiple lines
    }

    #[test]
    fn empty_palette_defaults_white() {
        let mut s = spec("halo dunia");
        s.palette.clear();
        let t = build_dialogue_text(&s);
        assert!(t.contains("{\\c&HFFFFFF&}HALO"));
    }

    #[test]
    fn braces_are_stripped() {
        let t = build_dialogue_text(&spec("a {evil} b"));
        assert!(!t.contains("evil}"));
    }
}
