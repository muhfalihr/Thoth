/// Intro banner card prepended to each clip.
///
/// Generates a 2.5-second card with:
///   - Gold accent bar at top
///   - Hook text (large, yellow) — the scroll-stopper
///   - Clip title (smaller, white)
///   - Source attribution (channel + video title)
///
/// Built entirely with FFmpeg's `drawtext` + `drawbox` filters — no external tools needed.

use super::layout::OutputLayout;

/// Parameters for the intro banner card.
#[derive(Debug, Clone)]
pub struct IntroCard {
    /// Main headline text — large bold black (the hook / scroll-stopper)
    pub hook: String,
    /// Channel / creator name shown in small source credit line
    pub channel: String,
    /// Original video title shown in small source credit line
    pub source_title: String,
    /// Social media handle or platform name displayed top-left of the banner
    /// e.g. "@prabowo.official", "TikTok", "YouTube"
    pub social_name: String,
    /// Duration of the intro card in seconds
    pub duration_secs: f64,
}

impl IntroCard {
    pub fn new(
        hook: impl Into<String>,
        channel: impl Into<String>,
        source_title: impl Into<String>,
        social_name: impl Into<String>,
    ) -> Self {
        Self {
            hook: hook.into(),
            channel: channel.into(),
            source_title: source_title.into(),
            social_name: social_name.into(),
            duration_secs: 2.5,
        }
    }

    /// True if there's nothing meaningful to display.
    pub fn is_empty(&self) -> bool {
        self.hook.is_empty()
    }

    /// Canvas dimensions matching the target layout.
    pub fn canvas(&self, layout: &OutputLayout) -> (u32, u32) {
        match layout {
            OutputLayout::Vertical   => (1080, 1920),
            OutputLayout::Horizontal => (1920, 1080),
            OutputLayout::Square     => (1080, 1080),
        }
    }

    /// Build the FFmpeg filter chain for the intro card.
    ///
    /// **Design (bottom-center white banner on crisp video background):**
    /// ```
    /// ┌─────────────────────────────────────┐
    /// │                                     │  ← real clip video, NO blur
    /// │          (video content)            │
    /// │                                     │
    /// ├═════════════════════════════════════╡  ← thin black top border
    /// │ @social_name           (top-left)   │  ← small black, from --social arg
    /// │                                     │
    /// │  HEADLINE TEXT   (large bold black) │  ← hook, centered
    /// │  line 2 if needed                   │
    /// │                                     │
    /// │  Channel Name • Video Title (small) │  ← source credit, left-aligned
    /// └─────────────────────────────────────┘  ← solid white banner
    /// ```
    pub fn build_video_filter(&self, layout: &OutputLayout, rel_start: f64) -> String {
        let (w, h) = self.canvas(layout);
        let dur           = self.duration_secs;
        let rel_end_intro = rel_start + dur;
        let fade_out      = (dur - 0.5_f64).max(0.1);

        let ff = fontfile_prefix("");

        let is_wide = w >= 1920;

        // ── Typography ────────────────────────────────────────────────────────
        // Font matches the subtitle style: Arial Bold, same weight and family.
        // Subtitle ASS uses: Style: Default,Arial,...,-1 (Bold=-1)
        // drawtext uses:     font='Arial Bold' — identical typeface rendered by fontconfig
        let max_chars: usize    = if is_wide { 32 } else { 24 }; // slightly wider lines
        let font_sz_hook: u32   = if is_wide { 56 } else { 62 }; // larger for visual impact
        let line_h: u32         = if is_wide { 68 } else { 76 }; // generous line height
        let font_sz_social: u32 = if is_wide { 22 } else { 24 };
        let font_sz_credit: u32 = if is_wide { 20 } else { 22 };

        let hook_lines   = wrap_text(&dt_escape(&self.hook), max_chars);
        let social_text  = dt_escape(&truncate(&self.social_name, 30));
        let channel_text = dt_escape(&truncate(&self.channel, 36));
        let source_text  = dt_escape(&truncate(&self.source_title, 46));

        let credit_text = match (channel_text.is_empty(), source_text.is_empty()) {
            (false, false) => format!("{channel_text} • {source_text}"),
            (false, true)  => channel_text.clone(),
            (true,  false) => source_text.clone(),
            (true,  true)  => String::new(),
        };

        // ── Banner geometry — FIXED height, headline vertically centered ──────
        //
        // The banner has three zones:
        //   TOP:    social name (small, top-left) + top padding
        //   MIDDLE: headline — VERTICALLY CENTERED in the available area
        //   BOTTOM: source credit + bottom padding
        //
        // Fixed layout (pixels for 1080×1920 vertical):
        //   banner_h  = 420 px
        //   social zone: top 58 px  (20px pad + 26px text + 12px gap)
        //   credit zone: bottom 54 px (20px text + 34px pad)
        //   headline zone: remaining center area
        let banner_h: u32    = if is_wide { 320 } else { 420 };
        let banner_y: u32    = h - banner_h;

        // Social name zone: fixed 20px padding + ~26px text
        let social_pad: u32  = 22;
        let social_y: u32    = banner_y + social_pad;
        let social_zone_h: u32 = if social_text.is_empty() { 0 } else { 28 + 14 }; // text+gap

        // Source credit zone: fixed at 38px from bottom
        let credit_pad_bot: u32 = 38;
        let credit_y: u32 = banner_y + banner_h - credit_pad_bot
            - if credit_text.is_empty() { 0 } else { font_sz_credit };

        // Headline: vertically centered in the space between social and credit
        let headline_area_top = banner_y + social_zone_h + social_pad;
        let headline_area_bot = if credit_text.is_empty() {
            banner_y + banner_h - 20
        } else {
            credit_y - 20
        };
        let headline_h: u32  = hook_lines.len() as u32 * line_h;
        let headline_area_h  = headline_area_bot.saturating_sub(headline_area_top);

        // Center the headline block within its area, bias slightly upward (×0.45)
        let hook_y: u32 = headline_area_top
            + (headline_area_h.saturating_sub(headline_h) as f64 * 0.45) as u32;

        // ── Build filter parts ────────────────────────────────────────────────
        let mut parts: Vec<String> = vec![
            // ── 1. Trim to intro window from the source video ─────────────────
            format!("trim=start={rel_start:.3}:end={rel_end_intro:.3}"),
            "setpts=PTS-STARTPTS".into(),

            // ── 2. Scale to fill the layout — NO blur, crisp background ───────
            format!(
                "scale={w}:{h}:force_original_aspect_ratio=increase,\
                 crop={w}:{h},setsar=1"
            ),

            // ── 3. Solid white banner at bottom ───────────────────────────────
            format!(
                "drawbox=x=0:y={banner_y}:w=iw:h={banner_h}:\
                 color=white@1.0:t=fill"
            ),

            // ── 4. Thin black top border of the banner ────────────────────────
            format!(
                "drawbox=x=0:y={banner_y}:w=iw:h=3:\
                 color=#000000@0.90:t=fill"
            ),
        ];

        // ── 5. Social media name — top-left, small black ──────────────────────
        if !social_text.is_empty() {
            parts.push(format!(
                "drawtext={ff}text='{social_text}':fontsize={font_sz_social}:\
                 fontcolor=#111111:x=40:y={social_y}"
            ));
        }

        // ── 6. Headline — large bold black, centered, matches subtitle font ─────
        // font='Arial Bold' mirrors the ASS subtitle style (Style:Default,Arial,Bold=-1)
        // Left margin 30px, right margin 30px — slightly wider than before
        for (i, line) in hook_lines.iter().enumerate() {
            let y = hook_y + i as u32 * line_h;
            parts.push(format!(
                "drawtext={ff}text='{line}':fontsize={font_sz_hook}:\
                 fontcolor=#000000:x=(w-text_w)/2:y={y}:\
                 borderw=0"
            ));
        }

        // ── 7. Source credit — small black, left-aligned ─────────────────────
        if !credit_text.is_empty() {
            let credit_escaped = dt_escape(&credit_text);
            parts.push(format!(
                "drawtext={ff}text='{credit_escaped}':fontsize={font_sz_credit}:\
                 fontcolor=#333333:x=40:y={credit_y}"
            ));
        }

        // ── 8. Fade in / fade out ─────────────────────────────────────────────
        parts.push("fade=t=in:st=0:d=0.400".into());
        parts.push(format!("fade=t=out:st={fade_out:.3}:d=0.500"));

        parts.join(",")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Escape a string for safe use inside FFmpeg's `drawtext=text='...'` value.
///
/// Rules:
/// - Remove `'`  (would break the outer single-quote delimiters)
/// - Escape `:` → `\:`   (FFmpeg option separator)
/// - Escape `\` → `\\`
/// - Escape `%` → `\%`   (FFmpeg percent expansion)
/// - Strip control characters
pub fn dt_escape(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '\'' => String::new(),
            ':'  => "\\:".into(),
            '\\' => "\\\\".into(),
            '%'  => "\\%".into(),
            c    => c.to_string(),
        })
        .collect()
}

/// Wrap text at word boundaries, max `max_chars` per line, up to 3 lines.
pub fn wrap_text(text: &str, max_chars: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();

    for word in text.split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
        } else if current.len() + 1 + word.len() <= max_chars {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(current.clone());
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines.truncate(3);
    lines
}

/// Truncate a string to at most `max` chars, appending "..." at a word boundary.
pub fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_owned();
    }
    let cut: String = chars[..max.saturating_sub(3)].iter().collect();
    if let Some(pos) = cut.rfind(' ') {
        format!("{}...", &cut[..pos])
    } else {
        format!("{cut}...")
    }
}

/// Build the font specification prefix for a drawtext filter option.
///
/// Windows font file paths (e.g. `C:/Windows/Fonts/arialbd.ttf`) contain
/// a `:` (drive letter colon) that FFmpeg's filter option parser treats as
/// an option separator — even when the path is single-quoted — because the
/// filter complex parser processes `:` before the option value parser runs.
///
/// Solution: use `font=<family_name>` (fontconfig lookup) instead of
/// `fontfile=<path>`.  FFmpeg on Windows with fontconfig enabled resolves
/// the font by name from the system font directory without any path issues.
fn fontfile_prefix(_font_path: &str) -> String {
    // Use font family name for zero path-escaping headaches on Windows.
    // fontconfig (enabled in the ffmpeg build) will find Arial Bold from
    // C:/Windows/Fonts/ automatically.
    "font='Arial Bold':".to_owned()
}
