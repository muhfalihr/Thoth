//! Reaction-beat comment card: a screenshot-style overlay of a REAL viral comment
//! scraped by scout (author + text + like count + avatar).
//!
//! Like `profile_card.rs`, the panel/text is drawn with FFmpeg `drawbox`/`drawtext`
//! filters straight into the video chain (no extra inputs). When a real avatar photo
//! is available it is composited ON TOP of the avatar tile by the render stage (see
//! [`CommentCard::avatar_rect`]); otherwise a drawn initial tile stands in.
//!
//! Data comes from `content_comments.json` (written by `main.rs` from the `--content`
//! set). The edit stage rotates one comment onto each content clip's reaction beat.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::intro::dt_escape;

/// Sidecar file (in the job base dir) holding the scraped viral comments.
pub const COMMENTS_FILE: &str = "content_comments.json";

/// On-disk form of one comment. `avatar_path` is a LOCAL file already downloaded by
/// `main.rs`; empty = no photo (drawn initial tile). `content_comments.json` is a
/// `Vec<CommentData>`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommentData {
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub likes: u64,
    #[serde(default)]
    pub avatar_path: String,
    /// Local path to a pre-cropped screenshot of this comment (scout). When set +
    /// file exists, the render stage pastes this real crop instead of the drawn card.
    /// Empty = synthetic drawn card. author/text/likes still feed narration.
    #[serde(default)]
    pub image_path: String,
    /// One-line decoded meaning (subtext + tone) of this comment, from `enrich_context.js`.
    /// Used only for narration grounding (not drawn on the card). Empty = no enrichment.
    #[serde(default)]
    pub context: String,
}

/// Load the comment pool from `base_dir/content_comments.json`. Returns an empty
/// vec when absent/unparseable — the reaction beat then renders no comment card.
/// Never errors (the card is purely additive).
pub fn load_comment_pool(base_dir: &Path) -> Vec<CommentData> {
    let path = base_dir.join(COMMENTS_FILE);
    if !path.exists() {
        return Vec::new();
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let all: Vec<CommentData> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    all.into_iter()
        .filter(|c| !c.author.trim().is_empty() && !c.text.trim().is_empty())
        .collect()
}

/// One resolved comment card for a clip (timing + accent resolved by the edit stage).
#[derive(Debug, Clone, Default)]
pub struct CommentCard {
    /// Author display name / handle (shown bold).
    pub author: String,
    /// Comment body text (word-wrapped to a few lines).
    pub text: String,
    /// Like count (0 = hide the count row).
    pub likes: u64,
    /// Local avatar photo path. Empty = drawn initial tile.
    pub avatar_path: String,
    /// Local path to a pre-cropped screenshot of this comment. When set + file exists,
    /// the render stage pastes this crop as the whole card (the synthetic panel and the
    /// avatar tile are skipped). Empty = draw the synthetic card.
    pub image_path: String,
    /// Accent colour as `#RRGGBB` (heart + frame).
    pub accent: String,
    /// drawtext font family.
    pub font: String,
    /// Seconds from clip start when the card appears.
    pub at_sec: f64,
    /// How long the card is shown (seconds).
    pub duration_sec: f64,
}

// ── Fixed geometry (top-centre "pinned comment" zone, free on content clips) ────
const CARD_W_PCT: f64 = 0.84; // card width as fraction of frame width
const CARD_Y_PCT: f64 = 0.10; // card top as fraction of frame height
const PAD: u32 = 28; // inner padding
const AV: u32 = 96; // avatar tile size
const LINE_H: u32 = 46; // text line height
const MAX_LINE_CHARS: usize = 30;
const MAX_LINES: usize = 3;

impl CommentCard {
    pub fn is_empty(&self) -> bool {
        self.author.trim().is_empty() || self.text.trim().is_empty()
    }

    /// True when a real crop screenshot is available on disk → paste it instead of
    /// drawing the synthetic card.
    pub fn has_crop(&self) -> bool {
        let p = self.image_path.trim();
        !p.is_empty() && Path::new(p).exists()
    }

    /// Avatar tile rectangle `(x, y, size)` matching where `build_comment_filter`
    /// draws the tile, so the render stage can overlay the real photo on it.
    pub fn avatar_rect(&self, w: u32, h: u32) -> (u32, u32, u32) {
        let card_w = (w as f64 * CARD_W_PCT) as u32;
        let card_x = (w - card_w) / 2;
        let card_y = (h as f64 * CARD_Y_PCT) as u32;
        (card_x + PAD, card_y + PAD, AV)
    }

    /// Card rectangle `(x, y, width)` — top-centre pinned zone. Used by the render
    /// stage to place a pasted comment crop at the same position/width as the drawn
    /// card (height follows the crop's own aspect ratio).
    pub fn card_rect(&self, w: u32, h: u32) -> (u32, u32, u32) {
        let card_w = (w as f64 * CARD_W_PCT) as u32;
        let card_x = (w - card_w) / 2;
        let card_y = (h as f64 * CARD_Y_PCT) as u32;
        (card_x, card_y, card_w)
    }
}

/// Convert `#RRGGBB` to FFmpeg `0xRRGGBB`. Falls back to a TikTok-pink accent.
fn ff_color(hex: &str) -> String {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{}", h.to_uppercase())
    } else {
        "0xFF3B5C".to_string()
    }
}

/// Greedy word-wrap into at most `MAX_LINES` lines of ~`MAX_LINE_CHARS` chars. The
/// final line is ellipsised if text remains.
fn wrap(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut words = text.split_whitespace().peekable();
    while let Some(word) = words.next() {
        let candidate = if cur.is_empty() { word.to_string() } else { format!("{cur} {word}") };
        if candidate.chars().count() <= MAX_LINE_CHARS {
            cur = candidate;
        } else {
            if !cur.is_empty() {
                lines.push(std::mem::take(&mut cur));
            }
            cur = word.to_string();
            if lines.len() == MAX_LINES - 1 {
                // last allowed line — fill greedily then ellipsise if more remains.
                while let Some(w) = words.peek() {
                    let cand = format!("{cur} {w}");
                    if cand.chars().count() <= MAX_LINE_CHARS { cur = cand; words.next(); }
                    else { break; }
                }
                if words.peek().is_some() {
                    let trimmed: String = cur.chars().take(MAX_LINE_CHARS.saturating_sub(1)).collect();
                    cur = format!("{trimmed}…");
                }
                lines.push(std::mem::take(&mut cur));
                return lines;
            }
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// Human-readable like count: `1200 → "1.2K"`, `2_500_000 → "2.5M"`.
fn format_likes(n: u64) -> String {
    let fmt = |v: f64, suffix: &str| {
        let s = format!("{v:.1}");
        let s = s.strip_suffix(".0").map(|x| x.to_string()).unwrap_or(s);
        format!("{s}{suffix}")
    };
    if n >= 1_000_000 {
        fmt(n as f64 / 1_000_000.0, "M")
    } else if n >= 1_000 {
        fmt(n as f64 / 1_000.0, "K")
    } else {
        n.to_string()
    }
}

/// Build the comma-prefixed filter chain for the comment card, or "" if empty.
/// `w`/`h` are the clip dimensions.
pub fn build_comment_filter(card: &CommentCard, w: u32, h: u32) -> String {
    if card.is_empty() {
        return String::new();
    }
    // A real crop is pasted by the render stage (see `build_comment_image_overlay`),
    // so skip the synthetic panel/text/avatar for this card.
    if card.has_crop() {
        return String::new();
    }
    let at = card.at_sec.max(0.0);
    let end = at + card.duration_sec.max(0.3);
    let en = format!(":enable='between(t,{at:.2},{end:.2})'");
    let accent = ff_color(&card.accent);
    let font = if card.font.trim().is_empty() { "Arial Bold".to_string() } else { card.font.clone() };
    let ff = format!("font='{font}':");

    let card_w = (w as f64 * CARD_W_PCT) as u32;
    let card_x = (w - card_w) / 2;
    let card_y = (h as f64 * CARD_Y_PCT) as u32;

    let lines = wrap(card.text.trim());
    let text_top = card_y + PAD + AV + 18;
    let card_h = (text_top - card_y) + (lines.len() as u32 * LINE_H) + PAD + 24;

    let mut parts: Vec<String> = Vec::new();

    // White rounded-ish panel (comment screenshot look) + subtle shadow bar.
    parts.push(format!(
        "drawbox=x={card_x}:y={card_y}:w={card_w}:h={card_h}:color=0xFFFFFF@0.97:t=fill{en}"
    ));
    parts.push(format!(
        "drawbox=x={card_x}:y={card_y}:w={card_w}:h={card_h}:color=0x000000@0.10:t=2{en}"
    ));

    // Avatar tile (top-left). Real photo (if any) is composited on top by the
    // render stage; otherwise draw the initial letter. Accent frame always drawn.
    let av_x = card_x + PAD;
    let av_y = card_y + PAD;
    let has_photo = !card.avatar_path.trim().is_empty();
    if !has_photo {
        parts.push(format!(
            "drawbox=x={av_x}:y={av_y}:w={AV}:h={AV}:color={accent}@0.20:t=fill{en}"
        ));
        let initial = dt_escape(
            &card.author.trim_start_matches('@').chars().next()
                .map(|c| c.to_uppercase().to_string()).unwrap_or_default(),
        );
        parts.push(format!(
            "drawtext={ff}text='{initial}':fontsize=56:fontcolor={accent}:\
             x={av_x}+({AV}-text_w)/2:y={av_y}+({AV}-text_h)/2{en}"
        ));
    }
    parts.push(format!(
        "drawbox=x={av_x}:y={av_y}:w={AV}:h={AV}:color={accent}@0.9:t=3{en}"
    ));

    // Author (bold, dark) to the right of the avatar.
    let author = dt_escape(&truncate(card.author.trim(), 24));
    let auth_x = av_x + AV + 24;
    parts.push(format!(
        "drawtext={ff}text='{author}':fontsize=40:fontcolor=0x111111:x={auth_x}:y={ay}{en}",
        ay = av_y + 8
    ));
    // Small "commented" sub-label under the author.
    parts.push(format!(
        "drawtext={ff}text='komentar':fontsize=28:fontcolor=0x8A8A90:x={auth_x}:y={sy}{en}",
        sy = av_y + 56
    ));

    // Comment body lines (dark grey).
    for (k, line) in lines.iter().enumerate() {
        if line.is_empty() { continue; }
        let esc = dt_escape(line);
        let ly = text_top + (k as u32 * LINE_H);
        parts.push(format!(
            "drawtext={ff}text='{esc}':fontsize=38:fontcolor=0x222222:x={tx}:y={ly}{en}",
            tx = card_x + PAD
        ));
    }

    // Like row (accent heart placeholder + count) at the card bottom.
    if card.likes > 0 {
        let likes = dt_escape(&format_likes(card.likes));
        let heart_y = card_y + card_h - PAD - 30;
        let heart_x = card_x + PAD;
        parts.push(format!(
            "drawbox=x={heart_x}:y={heart_y}:w=30:h=30:color={accent}@0.95:t=fill{en}"
        ));
        parts.push(format!(
            "drawtext={ff}text='{likes}':fontsize=34:fontcolor=0x555555:x={lx}:y={ly}{en}",
            lx = heart_x + 44,
            ly = heart_y - 2
        ));
    }

    format!(",{}", parts.join(","))
}

/// Truncate to `max` chars with an ellipsis.
fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_owned();
    }
    let cut: String = chars[..max.saturating_sub(1)].iter().collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> CommentCard {
        CommentCard {
            author: "@netizen1".into(),
            text: "anjir parah sih ini beneran ngakak banget sumpah".into(),
            likes: 1200,
            avatar_path: String::new(),
            image_path: String::new(),
            accent: "#FF3B5C".into(),
            font: "Arial Bold".into(),
            at_sec: 4.0,
            duration_sec: 3.0,
        }
    }

    #[test]
    fn format_likes_scales() {
        assert_eq!(format_likes(950), "950");
        assert_eq!(format_likes(1200), "1.2K");
        assert_eq!(format_likes(2_500_000), "2.5M");
        assert_eq!(format_likes(1000), "1K");
    }

    #[test]
    fn wrap_caps_lines() {
        // Long enough that the text cannot fit in MAX_LINES → final line ellipsised.
        let long = "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh \
                    sebelas dua belas tiga belas empat belas lima belas enam belas \
                    tujuh belas delapan belas sembilan belas dua puluh dua satu dua dua";
        let lines = wrap(long);
        assert!(lines.len() <= MAX_LINES);
        assert!(lines.last().unwrap().ends_with('…'), "got: {:?}", lines);
    }

    #[test]
    fn wrap_short_text_no_ellipsis() {
        let lines = wrap("singkat aja");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "singkat aja");
    }

    #[test]
    fn filter_has_author_text_and_window() {
        let f = build_comment_filter(&card(), 1080, 1920);
        assert!(f.starts_with(','));
        assert!(f.contains("netizen1"));
        assert!(f.contains("1.2K"));
        assert!(f.contains("enable='between(t,4.00,7.00)'"));
        assert!(f.contains("text='@'") || f.contains("text='N'")); // initial fallback
    }

    #[test]
    fn empty_yields_empty() {
        let mut c = card();
        c.text = "  ".into();
        assert!(build_comment_filter(&c, 1080, 1920).is_empty());
    }

    #[test]
    fn crop_skips_synthetic_card() {
        // A card whose image_path points at an existing file pastes the crop instead of
        // drawing the synthetic panel → build_comment_filter yields nothing.
        let mut c = card();
        let tmp = std::env::temp_dir().join("thoth_comment_crop_test.png");
        std::fs::write(&tmp, b"x").unwrap();
        c.image_path = tmp.to_string_lossy().to_string();
        assert!(c.has_crop());
        assert!(build_comment_filter(&c, 1080, 1920).is_empty());
        // card_rect width == 84% of frame, centred.
        let (cx, _cy, cw) = c.card_rect(1080, 1920);
        assert_eq!(cw, (1080.0 * CARD_W_PCT) as u32);
        assert_eq!(cx, (1080 - cw) / 2);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn no_crop_when_path_missing() {
        let mut c = card();
        c.image_path = "C:/definitely/not/here_xyz.png".into();
        assert!(!c.has_crop()); // missing file → fall back to synthetic
        assert!(!build_comment_filter(&c, 1080, 1920).is_empty());
    }

    #[test]
    fn real_avatar_skips_initial_tile() {
        let mut c = card();
        c.avatar_path = "C:/tmp/c.jpg".into();
        let f = build_comment_filter(&c, 1080, 1920);
        // The filled-tile + initial are suppressed; only the accent frame remains.
        assert!(!f.contains("fontsize=56"));
        let (_, _, size) = c.avatar_rect(1080, 1920);
        assert_eq!(size, AV);
    }
}
