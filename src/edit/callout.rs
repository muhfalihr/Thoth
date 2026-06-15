//! Beat-3 number callouts: a big figure in an accent box + a pointing arrow.
//!
//! Drawn entirely with `drawtext` (the figure uses drawtext's own background box;
//! the arrow is a geometric glyph ◀▶▲▼) — no inputs, no PNG assets. The LLM picks
//! the figure, timing, screen position, and arrow direction (`schema::Callout`).

use super::intro::dt_escape;

/// One rendered callout.
#[derive(Debug, Clone, Default)]
pub struct Callout {
    /// Figure text, e.g. "25 KG".
    pub text: String,
    pub at_sec: f64,
    pub duration_sec: f64,
    /// "center" | "upper" | "lower" | "left" | "right".
    pub position: String,
    /// "left" | "right" | "up" | "down".
    pub direction: String,
    /// Accent colour `#RRGGBB`.
    pub accent: String,
    /// drawtext font family (e.g. "Arial Bold").
    pub font: String,
}

impl Callout {
    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }
}

fn ff_color(hex: &str) -> String {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{}", h.to_uppercase())
    } else {
        "0xFF3B5C".to_string()
    }
}

/// Box centre (cx, cy) for a named position.
fn anchor(position: &str, w: u32, h: u32) -> (f64, f64) {
    let (wf, hf) = (w as f64, h as f64);
    match position {
        "upper" => (wf * 0.50, hf * 0.30),
        "lower" => (wf * 0.50, hf * 0.66),
        "left"  => (wf * 0.34, hf * 0.52),
        "right" => (wf * 0.66, hf * 0.52),
        _        => (wf * 0.50, hf * 0.52), // center
    }
}

/// Arrow glyph + offset from the box centre for a direction.
fn arrow(direction: &str) -> (&'static str, f64, f64) {
    match direction {
        "right" => ("\u{25B6}",  230.0,   0.0), // ▶
        "up"    => ("\u{25B2}",    0.0, -170.0), // ▲
        "down"  => ("\u{25BC}",    0.0,  170.0), // ▼
        _        => ("\u{25C0}", -230.0,   0.0), // ◀ (left, default)
    }
}

/// Build the comma-prefixed filter chain for all callouts, or "" if none.
pub fn build_callout_filter(callouts: &[Callout], w: u32, h: u32) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in callouts {
        if c.is_empty() {
            continue;
        }
        let at  = c.at_sec.max(0.0);
        let end = at + c.duration_sec.max(0.3);
        let en  = format!(":enable='between(t,{at:.2},{end:.2})'");
        let accent = ff_color(&c.accent);
        let font = if c.font.trim().is_empty() { "Arial Bold".to_string() } else { c.font.clone() };
        let ff = format!("font='{font}':");
        let (cx, cy) = anchor(&c.position, w, h);

        // Figure: big white text in an accent box, centred on (cx, cy).
        let text = dt_escape(c.text.trim());
        parts.push(format!(
            "drawtext={ff}text='{text}':fontsize=86:fontcolor=white:\
             x={cx:.0}-text_w/2:y={cy:.0}-text_h/2:\
             borderw=5:bordercolor=black:box=1:boxcolor={accent}@0.92:boxborderw=22{en}"
        ));

        // Arrow glyph pointing toward the subject.
        let (glyph, dx, dy) = arrow(&c.direction);
        let ax = cx + dx;
        let ay = cy + dy;
        parts.push(format!(
            "drawtext={ff}text='{glyph}':fontsize=130:fontcolor={accent}:\
             x={ax:.0}-text_w/2:y={ay:.0}-text_h/2:borderw=6:bordercolor=black{en}"
        ));
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!(",{}", parts.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn callout(text: &str, pos: &str, dir: &str) -> Callout {
        Callout {
            text: text.into(),
            at_sec: 9.0,
            duration_sec: 2.0,
            position: pos.into(),
            direction: dir.into(),
            accent: "#FF3B5C".into(),
            font: "Arial Bold".into(),
        }
    }

    #[test]
    fn renders_figure_and_arrow_with_window() {
        let f = build_callout_filter(&[callout("25 KG", "center", "left")], 1080, 1920);
        assert!(f.starts_with(","));
        assert!(f.contains("text='25 KG'"));
        assert!(f.contains("\u{25C0}"));                       // left arrow glyph
        assert!(f.contains("enable='between(t,9.00,11.00)'"));
        assert!(f.contains("boxcolor=0xFF3B5C@0.92"));
    }

    #[test]
    fn direction_selects_glyph() {
        let r = build_callout_filter(&[callout("X", "center", "right")], 1080, 1920);
        assert!(r.contains("\u{25B6}"));
        let u = build_callout_filter(&[callout("X", "center", "up")], 1080, 1920);
        assert!(u.contains("\u{25B2}"));
    }

    #[test]
    fn empty_list_and_blank_text_yield_empty() {
        assert!(build_callout_filter(&[], 1080, 1920).is_empty());
        assert!(build_callout_filter(&[callout("  ", "center", "left")], 1080, 1920).is_empty());
    }

    #[test]
    fn multiple_callouts_each_render() {
        let f = build_callout_filter(
            &[callout("25 KG", "upper", "down"), callout("Rp2JT", "lower", "up")],
            1080, 1920,
        );
        assert!(f.contains("25 KG"));
        assert!(f.contains("Rp2JT"));
        assert!(f.contains("\u{25BC}"));
        assert!(f.contains("\u{25B2}"));
    }
}
