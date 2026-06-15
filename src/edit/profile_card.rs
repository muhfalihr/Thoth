//! Beat-2 character intro: a profile card + a giant name above the head.
//!
//! Both are drawn with FFmpeg `drawbox`/`drawtext` filters straight into the video
//! chain (same approach as the lower-third headline) — no extra inputs, no assets,
//! no scraping. The avatar is a stylised initial-letter tile (a real avatar image
//! can be composited later). Data comes from the LLM (`character_*` fields).

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::intro::dt_escape;

/// Sidecar file (in the job base dir) holding the REAL subject profile that
/// OpenClaw scraped. Written by `main.rs` from the `--content` set; loaded here to
/// override the LLM-guessed `character_*` fields with factual data.
pub const PROFILE_FILE: &str = "content_profile.json";

/// On-disk form of the real profile (one object). `avatar_path` is a LOCAL file
/// already downloaded by `main.rs`; empty = no photo (drawn initial tile).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileCardData {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub handle: String,
    #[serde(default)]
    pub stats: String,
    #[serde(default)]
    pub avatar_path: String,
    /// Local path to a pre-cropped screenshot of the source's profile card (OpenClaw).
    /// When set + file exists, the render stage pastes this crop instead of the drawn card.
    #[serde(default)]
    pub image_path: String,
}

/// Load the real-profile override from `base_dir/content_profile.json`. Returns
/// `None` when absent/unparseable — the edit stage then keeps the LLM's guess.
/// Never errors (the card is purely additive).
pub fn load_profile_override(base_dir: &Path) -> Option<ProfileCardData> {
    let path = base_dir.join(PROFILE_FILE);
    if !path.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let data: ProfileCardData = serde_json::from_str(&raw).ok()?;
    if data.name.trim().is_empty() && data.handle.trim().is_empty() && data.image_path.trim().is_empty() {
        return None;
    }
    Some(data)
}

/// One character-intro overlay for a clip.
#[derive(Debug, Clone, Default)]
pub struct ProfileCard {
    /// Display name (e.g. "Heru Gundul").
    pub name: String,
    /// Social handle without `@` (e.g. "heru_gundul"). Empty = hide handle line.
    pub handle: String,
    /// Follower/like blurb (e.g. "153K followers"). Empty = hide stats line.
    pub stats: String,
    /// Accent colour as `#RRGGBB`.
    pub accent: String,
    /// drawtext font family (must resolve via fontconfig, e.g. "Arial Bold").
    pub font: String,
    /// Seconds from clip start when the intro appears.
    pub at_sec: f64,
    /// How long the intro is shown (seconds).
    pub duration_sec: f64,
    /// Card vertical anchor: "center" | "upper" | "lower" | "" (default lower-mid).
    pub position: String,
    /// Also render the giant name above the head (top-centre).
    pub name_above_head: bool,
    /// Render the profile card panel (set false for name-only).
    pub show_card: bool,
    /// Local path to a real avatar image (from OpenClaw). When non-empty the photo
    /// is composited into the avatar tile (as an FFmpeg input overlay) instead of
    /// the drawn initial letter. Empty = drawn initial tile.
    pub avatar_path: String,
    /// Local path to a pre-cropped screenshot of the source's profile card. When set +
    /// file exists, the render stage pastes this crop as the whole card (synthetic panel
    /// + avatar tile skipped). Empty = draw the synthetic card.
    pub image_path: String,
}

impl ProfileCard {
    pub fn is_empty(&self) -> bool {
        self.name.trim().is_empty() && !self.has_crop()
    }

    /// True when a real profile-card crop is available on disk → paste it instead of
    /// drawing the synthetic card.
    pub fn has_crop(&self) -> bool {
        let p = self.image_path.trim();
        !p.is_empty() && std::path::Path::new(p).exists()
    }

    /// Card rectangle `(x, y, width)` for a pasted profile-card crop — same lower-third
    /// zone as the synthetic panel, full panel width; height follows the crop's aspect.
    pub fn card_rect(&self, w: u32, h: u32) -> (u32, u32, u32) {
        let (cx, cy, cw, _ch) = card_geom(self, w, h);
        (cx, cy, cw)
    }

    /// Avatar tile rectangle `(x, y, size)` in pixels for a `w`×`h` frame, matching
    /// exactly where `build_profile_filter` draws the tile. Returns `None` when the
    /// panel is hidden (`show_card == false`) — there is nowhere to place a photo.
    /// The render stage uses this to overlay the real avatar image on the tile.
    pub fn avatar_rect(&self, w: u32, h: u32) -> Option<(u32, u32, u32)> {
        if !self.show_card {
            return None;
        }
        let (card_x, card_y, _card_w, card_h) = card_geom(self, w, h);
        let av: u32 = 150;
        let av_x = card_x + 30;
        let av_y = card_y + (card_h - av) / 2;
        Some((av_x, av_y, av))
    }
}

/// Shared panel geometry `(card_x, card_y, card_w, card_h)` so `build_profile_filter`
/// and `avatar_rect` agree on placement.
fn card_geom(card: &ProfileCard, w: u32, h: u32) -> (u32, u32, u32, u32) {
    let card_w: u32 = (w as f64 * 0.70) as u32;
    let card_h: u32 = 230;
    let card_x: u32 = (w - card_w) / 2;
    let card_y: u32 = match card.position.as_str() {
        "center" => (h - card_h) / 2,
        "upper" => (h as f64 * 0.28) as u32,
        "lower" => (h as f64 * 0.66) as u32,
        _ => (h as f64 * 0.60) as u32,
    };
    (card_x, card_y, card_w, card_h)
}

/// Convert `#RRGGBB` to FFmpeg `0xRRGGBB`. Falls back to white.
fn ff_color(hex: &str) -> String {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{}", h.to_uppercase())
    } else {
        "0xFFFFFF".to_string()
    }
}

/// Build the comma-prefixed filter chain for the character intro, or "" if empty.
/// `w`/`h` are the clip dimensions; `font` is the drawtext font family.
pub fn build_profile_filter(card: &ProfileCard, w: u32, h: u32) -> String {
    if card.is_empty() {
        return String::new();
    }
    let at  = card.at_sec.max(0.0);
    let end = at + card.duration_sec.max(0.3);
    let en  = format!(":enable='between(t,{at:.2},{end:.2})'");
    let accent = ff_color(&card.accent);
    let font = if card.font.trim().is_empty() { "Arial Bold".to_string() } else { card.font.clone() };
    let ff = format!("font='{font}':");

    let mut parts: Vec<String> = Vec::new();

    // ── Profile card panel ────────────────────────────────────────────────────
    // When a real crop screenshot exists it is pasted by the render stage
    // (`build_profile_image_overlay`), so skip the synthetic panel for it.
    if card.show_card && !card.has_crop() {
        let (card_x, card_y, card_w, card_h) = card_geom(card, w, h);

        // Dark rounded-ish panel + left accent bar.
        parts.push(format!(
            "drawbox=x={card_x}:y={card_y}:w={card_w}:h={card_h}:color=0x14141E@0.92:t=fill{en}"
        ));
        parts.push(format!(
            "drawbox=x={card_x}:y={card_y}:w=8:h={card_h}:color={accent}@0.95:t=fill{en}"
        ));

        // Avatar tile at the left. When a real photo is available it is composited
        // by the render stage (see `avatar_rect`) ON TOP of this tile, so we draw
        // only the accent frame and SKIP the drawn initial. Otherwise the initial
        // letter stands in for the photo.
        let av: u32 = 150;
        let av_x = card_x + 30;
        let av_y = card_y + (card_h - av) / 2;
        let has_photo = !card.avatar_path.trim().is_empty();
        if !has_photo {
            parts.push(format!(
                "drawbox=x={av_x}:y={av_y}:w={av}:h={av}:color={accent}@0.22:t=fill{en}"
            ));
        }
        parts.push(format!(
            "drawbox=x={av_x}:y={av_y}:w={av}:h={av}:color={accent}@0.9:t=3{en}"
        ));
        if !has_photo {
            let initial = dt_escape(
                &card.name.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default(),
            );
            parts.push(format!(
                "drawtext={ff}text='{initial}':fontsize=92:fontcolor={accent}:\
                 x={av_x}+({av}-text_w)/2:y={av_y}+({av}-text_h)/2{en}"
            ));
        }

        // Text column to the right of the avatar.
        let tx = av_x + av + 30;
        let name = dt_escape(&truncate(&card.name, 22));
        parts.push(format!(
            "drawtext={ff}text='{name}':fontsize=54:fontcolor=white:\
             x={tx}:y={ty}:borderw=2:bordercolor=black@0.6{en}",
            ty = card_y + 42
        ));
        if !card.handle.trim().is_empty() {
            let handle = dt_escape(&format!("@{}", truncate(card.handle.trim_start_matches('@'), 24)));
            parts.push(format!(
                "drawtext={ff}text='{handle}':fontsize=36:fontcolor=0xB8B8C0:\
                 x={tx}:y={hy}{en}",
                hy = card_y + 108
            ));
        }
        if !card.stats.trim().is_empty() {
            let stats = dt_escape(&truncate(card.stats.trim(), 28));
            parts.push(format!(
                "drawtext={ff}text='{stats}':fontsize=36:fontcolor={accent}:\
                 x={tx}:y={sy}{en}",
                sy = card_y + 160
            ));
        }
    }

    // ── Giant name above the head (top-centre) ────────────────────────────────
    if card.name_above_head {
        let name_up = dt_escape(&card.name.to_uppercase());
        let y_top = (h as f64 * 0.07) as u32;
        parts.push(format!(
            "drawtext={ff}text='{name_up}':fontsize=96:fontcolor=white:\
             x=(w-text_w)/2:y={y_top}:borderw=6:bordercolor=black:\
             box=1:boxcolor={accent}@0.85:boxborderw=18{en}"
        ));
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!(",{}", parts.join(","))
    }
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

    fn card() -> ProfileCard {
        ProfileCard {
            name: "Heru Gundul".into(),
            handle: "heru_gundul".into(),
            stats: "153K followers".into(),
            accent: "#FF3B5C".into(),
            font: "Arial Bold".into(),
            at_sec: 3.0,
            duration_sec: 3.0,
            position: "lower".into(),
            name_above_head: true,
            show_card: true,
            avatar_path: String::new(),
            image_path: String::new(),
        }
    }

    #[test]
    fn real_avatar_skips_drawn_initial() {
        let mut c = card();
        c.avatar_path = "C:/tmp/avatar.jpg".into();
        let f = build_profile_filter(&c, 1080, 1920);
        assert!(!f.contains("text='H'")); // initial suppressed when a photo exists
        assert!(c.avatar_rect(1080, 1920).is_some());
    }

    #[test]
    fn ff_color_converts() {
        assert_eq!(ff_color("#FF3B5C"), "0xFF3B5C");
        assert_eq!(ff_color("nope"), "0xFFFFFF");
    }

    #[test]
    fn filter_has_card_name_handle_and_window() {
        let f = build_profile_filter(&card(), 1080, 1920);
        assert!(f.starts_with(","));
        assert!(f.contains("Heru Gundul"));
        assert!(f.contains("@heru_gundul"));
        assert!(f.contains("153K followers"));
        assert!(f.contains("enable='between(t,3.00,6.00)'"));
        assert!(f.contains("text='H'")); // avatar initial
        assert!(f.contains("HERU GUNDUL")); // name above head (uppercase)
    }

    #[test]
    fn empty_name_yields_empty() {
        let mut c = card();
        c.name = "  ".into();
        assert!(build_profile_filter(&c, 1080, 1920).is_empty());
    }

    #[test]
    fn name_only_mode_skips_card_panel() {
        let mut c = card();
        c.show_card = false;
        let f = build_profile_filter(&c, 1080, 1920);
        assert!(!f.contains("@heru_gundul"));   // no card → no handle line
        assert!(f.contains("HERU GUNDUL"));     // still has name above head
    }
}
