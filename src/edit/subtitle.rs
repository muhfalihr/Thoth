use std::path::Path;

use crate::transcribe::model::WordTimestamp;

use super::error::EditError;
use super::fonts::FontConfig;

// ── Subtitle style ────────────────────────────────────────────────────────────

/// Visual rendering style for word-by-word karaoke subtitles.
///
/// Each style changes colors, sizes, and how active vs inactive words are shown.
/// The LLM picks the best style per clip via the `subtitle_style` field in
/// `ViralMoment` based on content energy, viral_type, and emotional_trigger.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum SubtitleStyle {
    /// Classic karaoke — white sentence, yellow active word, bold outline.
    /// Safe default that works for any content.
    #[default]
    Karaoke,

    /// CapCut-style (trending 2025 TikTok/Reels):
    /// - Inactive words: semi-transparent gray
    /// - Active word: white text + thick yellow glow/outline box
    /// - More contrast, feels more modern and dynamic
    /// Best for: high-energy, comedy, controversy, meme content
    CapcutBold,

    /// Word-pop — only the active word is shown each moment (no context words).
    /// Large, bold, centered — each word "pops" into view one at a time.
    /// Best for: shocking reveals, fast-paced clips, energetic content
    WordPop,

    /// Minimal clean — subtle size-only emphasis, all white.
    /// Active word is just slightly larger and bold.
    /// Best for: emotional, educational, slow conversational content
    MinimalWhite,
}

impl SubtitleStyle {
    /// Parse from the LLM's string output.  Falls back to `Karaoke` for unknown values.
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "capcut_bold" | "capcut"        => SubtitleStyle::CapcutBold,
            "word_pop"    | "pop" | "wordpop" => SubtitleStyle::WordPop,
            "minimal_white" | "minimal"     => SubtitleStyle::MinimalWhite,
            _                               => SubtitleStyle::Karaoke,
        }
    }
}

// ── ASS generation ────────────────────────────────────────────────────────────

/// Generate an ASS subtitle file with word-level karaoke highlighting.
///
/// The `style` parameter controls the visual appearance:
/// - `Karaoke`:      white sentence, yellow active word (classic)
/// - `CapcutBold`:   gray context, white+yellow-glow active word (CapCut look)
/// - `WordPop`:      only active word shown, large and centered
/// - `MinimalWhite`: subtle size-only emphasis, all white
pub fn generate_ass(
    words:          &[&WordTimestamp],
    clip_start_sec: f64,
    output_path:    &Path,
    font:           &FontConfig,
    style:          &SubtitleStyle,
) -> Result<(), EditError> {
    let mut ass = String::new();
    let font_name = font.ass_family();

    // ── Script Info ───────────────────────────────────────────────────────────
    ass.push_str("[Script Info]\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("PlayResX: 1080\n");
    ass.push_str("PlayResY: 1920\n");
    ass.push_str("ScaledBorderAndShadow: yes\n\n");

    // ── Styles ────────────────────────────────────────────────────────────────
    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, \
                  OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, \
                  ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, \
                  Alignment, MarginL, MarginR, MarginV, Encoding\n");

    match style {
        SubtitleStyle::Karaoke => {
            // White, 4px black outline, bold, bottom-center
            ass.push_str(&format!(
                "Style: Default,{font_name},72,&H00FFFFFF,&H000000FF,&H00000000,\
                 &H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,10,10,450,1\n\n"
            ));
        }
        SubtitleStyle::CapcutBold => {
            // Base style: gray inactive words, thinner outline
            // Active word overrides are applied inline with \c and \3c tags
            ass.push_str(&format!(
                "Style: Default,{font_name},72,&H00FFFFFF,&H000000FF,&H00000000,\
                 &H96000000,-1,0,0,0,100,100,0,0,1,3,1,2,10,10,450,1\n\n"
            ));
        }
        SubtitleStyle::WordPop => {
            // Single large word, centered, bright white, thick outline
            ass.push_str(&format!(
                "Style: Default,{font_name},88,&H00FFFFFF,&H000000FF,&H00000000,\
                 &H96000000,-1,0,0,0,100,100,0,0,1,5,3,2,10,10,450,1\n\n"
            ));
        }
        SubtitleStyle::MinimalWhite => {
            // Clean white, thin outline — active word gets inline size boost
            ass.push_str(&format!(
                "Style: Default,{font_name},70,&H00FFFFFF,&H000000FF,&H00000000,\
                 &H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,10,10,450,1\n\n"
            ));
        }
    }

    // ── Events ────────────────────────────────────────────────────────────────
    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    if words.is_empty() {
        std::fs::write(output_path, ass).map_err(EditError::Io)?;
        return Ok(());
    }

    // ── WordPop: one word per Dialogue, no context ────────────────────────────
    if *style == SubtitleStyle::WordPop {
        return generate_ass_word_pop(words, clip_start_sec, output_path, &ass);
    }

    // ── Multi-word chunk styles (Karaoke, CapcutBold, MinimalWhite) ───────────
    generate_ass_chunked(words, clip_start_sec, output_path, ass, style)
}

/// WordPop style: emit one `Dialogue` per word containing only that word.
fn generate_ass_word_pop(
    words:          &[&WordTimestamp],
    clip_start_sec: f64,
    output_path:    &Path,
    header:         &str,
) -> Result<(), EditError> {
    let mut ass = header.to_owned();

    for (i, word) in words.iter().enumerate() {
        let start = (word.start_ms as f64 / 1000.0 - clip_start_sec).max(0.0);
        let end   = if i + 1 < words.len() {
            let next = (words[i + 1].start_ms as f64 / 1000.0 - clip_start_sec).max(0.0);
            next.max(start + 0.05)
        } else {
            (word.end_ms as f64 / 1000.0 - clip_start_sec).max(start + 0.05)
        };

        if start >= end { continue; }

        // All caps, bold, white — the style definition handles size/outline
        let text = word.word.to_uppercase();
        ass.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            ms_to_ass_time((start * 1000.0) as i64),
            ms_to_ass_time((end   * 1000.0) as i64),
            text
        ));
    }

    std::fs::write(output_path, ass).map_err(EditError::Io)?;
    Ok(())
}

/// Chunked styles (Karaoke, CapcutBold, MinimalWhite): 4-word chunks with
/// per-word highlight overlaid on the full sentence.
fn generate_ass_chunked(
    words:          &[&WordTimestamp],
    clip_start_sec: f64,
    output_path:    &Path,
    mut ass:        String,
    style:          &SubtitleStyle,
) -> Result<(), EditError> {
    const LINE_WORDS: usize = 4;
    let chunks: Vec<&[&WordTimestamp]> = words.chunks(LINE_WORDS).collect();

    // Compute non-overlapping chunk boundaries (same logic as original Karaoke)
    let natural_starts: Vec<f64> = chunks.iter()
        .map(|c| (c[0].start_ms as f64 / 1000.0 - clip_start_sec).max(0.0))
        .collect();
    let natural_ends: Vec<f64> = chunks.iter()
        .map(|c| (c[c.len()-1].end_ms as f64 / 1000.0 - clip_start_sec).max(0.0))
        .collect();

    let mut chunk_starts = natural_starts.clone();
    for i in 1..chunks.len() {
        let min_start = natural_ends[i-1].max(chunk_starts[i-1] + 0.02);
        if chunk_starts[i] < min_start { chunk_starts[i] = min_start; }
    }
    let chunk_ends = natural_ends;

    for (ci, chunk) in chunks.iter().enumerate() {
        let chunk_start = chunk_starts[ci];
        let chunk_end   = chunk_ends[ci];
        if chunk_start >= chunk_end { continue; }

        let chunk_words_owned: Vec<String> = chunk.iter().map(|w| w.word.to_uppercase()).collect();
        let chunk_words: Vec<&str> = chunk_words_owned.iter().map(|s| s.as_str()).collect();

        // Silent gap before first word (all inactive)
        let first_word_start = (chunk[0].start_ms as f64 / 1000.0 - clip_start_sec).max(0.0);
        if first_word_start > chunk_start + 0.02 {
            let inactive_line = build_inactive_line(&chunk_words, style);
            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                ms_to_ass_time((chunk_start * 1000.0) as i64),
                ms_to_ass_time((first_word_start * 1000.0) as i64),
                inactive_line
            ));
        }

        // One Dialogue per word (active word highlighted, rest inactive)
        for (wi, word) in chunk.iter().enumerate() {
            let word_start = (word.start_ms as f64 / 1000.0 - clip_start_sec).max(0.0);
            let word_end   = if wi + 1 < chunk.len() {
                let ns = (chunk[wi+1].start_ms as f64 / 1000.0 - clip_start_sec).max(0.0);
                ns.max(word_start + 0.02).min(chunk_end)
            } else {
                chunk_end
            };
            if word_start >= word_end { continue; }

            let text = build_active_line(&chunk_words, wi, style);
            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                ms_to_ass_time((word_start * 1000.0) as i64),
                ms_to_ass_time((word_end   * 1000.0) as i64),
                text
            ));
        }
    }

    std::fs::write(output_path, ass).map_err(EditError::Io)?;
    Ok(())
}

// ── Style-specific line builders ──────────────────────────────────────────────

/// Build the line text for the silent gap (no active word yet).
fn build_inactive_line(words: &[&str], style: &SubtitleStyle) -> String {
    match style {
        SubtitleStyle::CapcutBold => {
            // Gray for all words (base style is already gray)
            words.join(" ")
        }
        SubtitleStyle::MinimalWhite => words.join(" "),
        _ => words.join(" "), // Karaoke: plain white (base style)
    }
}

/// Build the Dialogue text with the word at `active_idx` highlighted.
fn build_active_line(words: &[&str], active_idx: usize, style: &SubtitleStyle) -> String {
    words.iter().enumerate().map(|(j, w)| {
        if j == active_idx {
            match style {
                SubtitleStyle::Karaoke => {
                    // Yellow active word, reset white for following words
                    if j + 1 < words.len() {
                        format!("{{\\c&H0000FFFF&}}{}{{\\c&H00CCCCCC&}}", w)
                    } else {
                        format!("{{\\c&H0000FFFF&}}{}", w)
                    }
                }
                SubtitleStyle::CapcutBold => {
                    // White text + thick orange border = orange glow box effect
                    // \c = white text, \3c = orange outline fill, \bord10 = thick glow
                    if j + 1 < words.len() {
                        format!("{{\\c&H00FFFFFF&\\3c&H0000A5FF&\\bord10}}{}{{\\c&H00CCCCCC&\\3c&H00000000&\\bord3}}", w)
                    } else {
                        format!("{{\\c&H00FFFFFF&\\3c&H0000A5FF&\\bord10}}{}", w)
                    }
                }
                SubtitleStyle::MinimalWhite => {
                    // Slightly larger + bold inline, white
                    if j + 1 < words.len() {
                        format!("{{\\fs80\\b1}}{}{{\\fs70\\b-1}}", w)
                    } else {
                        format!("{{\\fs80\\b1}}{}", w)
                    }
                }
                SubtitleStyle::WordPop => w.to_string(), // handled separately
            }
        } else {
            // Inactive word
            match style {
                SubtitleStyle::Karaoke => w.to_string(), // white (base style)
                SubtitleStyle::CapcutBold | SubtitleStyle::MinimalWhite => {
                    // Keep inline gray override on inactive words for CapcutBold;
                    // for Minimal: base style already white, no override needed
                    w.to_string()
                }
                SubtitleStyle::WordPop => w.to_string(),
            }
        }
    }).collect::<Vec<_>>().join(" ")
}

// ── Time format ───────────────────────────────────────────────────────────────

/// Convert milliseconds to ASS time format: `H:MM:SS.cc`
fn ms_to_ass_time(ms: i64) -> String {
    let ms          = ms.max(0);
    let centiseconds = (ms % 1000) / 10;
    let seconds      = (ms / 1000) % 60;
    let minutes      = (ms / 60_000) % 60;
    let hours        = ms / 3_600_000;
    format!("{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}")
}
