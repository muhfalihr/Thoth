use std::path::Path;

use crate::transcribe::model::WordTimestamp;

use super::error::EditError;

/// Generate an ASS subtitle file with karaoke-style word-level highlighting.
///
/// ## Design — single-layer color-tag approach
///
/// **Problem with the old 2-layer design:**
/// - Layer 0: full white sentence  ("finance 60 dari kerjaan")
/// - Layer 1: highlighted word on top ("finance" in yellow)
/// → Both render at the same screen position simultaneously → stacking artifact.
///
/// **New single-layer design:**
/// Each "active word" period generates exactly **one** `Dialogue` line that contains
/// the full sentence, but the currently-spoken word has an inline `\c` color-override
/// tag that makes it yellow, while the rest remain white.  No two `Dialogue` lines are
/// ever active at the same time, so there is no stacking.
///
/// Example for chunk `["finance", "60", "dari", "kerjaan"]`:
/// ```
/// # While "60" is spoken:
/// Dialogue: 0,0:00:01.30,0:00:01.50,Default,,,,finance {\c&H0000FFFF&}60{\c&H00FFFFFF&} dari kerjaan
/// ```
pub fn generate_ass(
    words: &[&WordTimestamp],
    clip_start_sec: f64,
    output_path: &Path,
) -> Result<(), EditError> {
    let mut ass = String::new();

    // ── Script Info ───────────────────────────────────────────────────────────
    ass.push_str("[Script Info]\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("PlayResX: 1080\n");
    ass.push_str("PlayResY: 1920\n");
    ass.push_str("ScaledBorderAndShadow: yes\n\n");

    // ── Styles ────────────────────────────────────────────────────────────────
    // Only one style is needed — highlighting is done with inline color tags.
    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    // White bold, black outline, 450 px MarginV from bottom, bottom-center (Alignment=2)
    ass.push_str("Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,10,10,450,1\n\n");

    // ── Events ────────────────────────────────────────────────────────────────
    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    if words.is_empty() {
        std::fs::write(output_path, ass).map_err(EditError::Io)?;
        return Ok(());
    }

    // ── Step 1: Group words into 4-word lines ─────────────────────────────────
    const LINE_WORDS: usize = 4;
    let chunks: Vec<&[&WordTimestamp]> = words.chunks(LINE_WORDS).collect();

    // ── Step 2: Compute non-overlapping chunk boundaries ─────────────────────
    //
    // Whisper timestamps can be "generous" — the last word of chunk N might end
    // after the first word of chunk N+1 starts.  Trim each chunk end to the next
    // chunk's start to prevent two sentences being visible simultaneously.
    let chunk_starts: Vec<f64> = chunks
        .iter()
        .map(|c| (c[0].start_ms as f64 / 1000.0 - clip_start_sec).max(0.0))
        .collect();

    let chunk_ends: Vec<f64> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let raw_end =
                (c[c.len() - 1].end_ms as f64 / 1000.0 - clip_start_sec).max(0.0);
            if i + 1 < chunks.len() {
                // Trim to next chunk start; keep at least 50 ms display time.
                raw_end
                    .min(chunk_starts[i + 1])
                    .max(chunk_starts[i] + 0.05)
            } else {
                raw_end
            }
        })
        .collect();

    // ── Step 3: Emit Dialogue lines ───────────────────────────────────────────
    for (ci, chunk) in chunks.iter().enumerate() {
        let chunk_start = chunk_starts[ci];
        let chunk_end   = chunk_ends[ci];
        if chunk_start >= chunk_end {
            continue;
        }

        // Pre-build the word list for this chunk — UPPERCASE for subtitle display
        let chunk_words_owned: Vec<String> = chunk.iter().map(|w| w.word.to_uppercase()).collect();
        let chunk_words: Vec<&str> = chunk_words_owned.iter().map(|s| s.as_str()).collect();

        // ── (a) Silent gap before first word starts (show all-white) ──────────
        let first_word_start =
            (chunk[0].start_ms as f64 / 1000.0 - clip_start_sec).max(0.0);
        if first_word_start > chunk_start + 0.02 {
            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                ms_to_ass_time((chunk_start * 1000.0) as i64),
                ms_to_ass_time((first_word_start * 1000.0) as i64),
                chunk_words.join(" ")
            ));
        }

        // ── (b) One line per word — active word is yellow, rest white ─────────
        for (wi, word) in chunk.iter().enumerate() {
            let word_start =
                (word.start_ms as f64 / 1000.0 - clip_start_sec).max(0.0);

            // Period ends when the NEXT word starts (or at chunk end for last word).
            let word_end = if wi + 1 < chunk.len() {
                let next_start =
                    (chunk[wi + 1].start_ms as f64 / 1000.0 - clip_start_sec)
                        .max(0.0);
                // Guarantee at least 20 ms display; don't exceed chunk boundary.
                next_start
                    .max(word_start + 0.02)
                    .min(chunk_end)
            } else {
                chunk_end
            };

            if word_start >= word_end {
                continue;
            }

            // Build the inline-colored sentence:
            //   other words → default white (no tag needed)
            //   active word  → {\c&H0000FFFF&}word{\c&H00FFFFFF&}
            //
            // ASS color format: &HAABBGGRR (alpha, blue, green, red)
            //   Yellow = R:FF G:FF B:00 → &H0000FFFF
            //   White  = R:FF G:FF B:FF → &H00FFFFFF
            let text: String = chunk_words
                .iter()
                .enumerate()
                .map(|(j, w)| {
                    if j == wi {
                        if wi + 1 < chunk_words.len() {
                            // Reset colour after the highlighted word so remaining
                            // words stay white.
                            format!("{{\\c&H0000FFFF&}}{}{{\\c&H00FFFFFF&}}", w)
                        } else {
                            // Last word: no reset needed.
                            format!("{{\\c&H0000FFFF&}}{}", w)
                        }
                    } else {
                        w.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");

            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
                ms_to_ass_time((word_start * 1000.0) as i64),
                ms_to_ass_time((word_end * 1000.0) as i64),
                text
            ));
        }
    }

    std::fs::write(output_path, ass).map_err(EditError::Io)?;
    Ok(())
}

/// Convert milliseconds to ASS time format: `H:MM:SS.cc`
fn ms_to_ass_time(ms: i64) -> String {
    let ms = ms.max(0);
    let centiseconds = (ms % 1000) / 10;
    let seconds      = (ms / 1000) % 60;
    let minutes      = (ms / 60_000) % 60;
    let hours        = ms / 3_600_000;
    format!("{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}")
}
