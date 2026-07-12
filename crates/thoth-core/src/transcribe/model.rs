use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordTimestamp {
    pub word: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub probability: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperSegment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub words: Vec<WordTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcript {
    pub segments: Vec<WhisperSegment>,
    pub duration_ms: i64,
}

impl Transcript {
    /// Format transcript as `[start_sec - end_sec] text` lines for LLM prompts.
    pub fn to_prompt_lines(&self) -> String {
        self.segments
            .iter()
            .map(|s| {
                format!(
                    "[{:.2} - {:.2}] {}",
                    s.start_ms as f64 / 1000.0,
                    s.end_ms as f64 / 1000.0,
                    s.text.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Even more compact version to save tokens on very long videos.
    pub fn to_compact_prompt_lines(&self) -> String {
        self.segments
            .iter()
            .map(|s| {
                format!(
                    "[{}] {}",
                    s.start_ms / 1000,
                    s.text.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Return all word timestamps that fall COMPLETELY within a time window (in seconds).
    /// Both start AND end must be within bounds. Strict — may return empty at boundaries.
    pub fn words_in_window(&self, start_sec: f64, end_sec: f64) -> Vec<&WordTimestamp> {
        let start_ms = (start_sec * 1000.0) as i64;
        let end_ms   = (end_sec   * 1000.0) as i64;
        self.segments
            .iter()
            .flat_map(|s| s.words.iter())
            .filter(|w| w.start_ms >= start_ms && w.end_ms <= end_ms)
            .collect()
    }

    /// Return words whose START time falls within the window (looser than `words_in_window`).
    /// Includes words that straddle the boundary — avoids empty returns at clip edges.
    pub fn words_starting_in(&self, start_sec: f64, end_sec: f64) -> Vec<&WordTimestamp> {
        let start_ms = (start_sec * 1000.0) as i64;
        let end_ms   = (end_sec   * 1000.0) as i64;
        self.segments
            .iter()
            .flat_map(|s| s.words.iter())
            .filter(|w| w.start_ms >= start_ms && w.start_ms < end_ms)
            .collect()
    }

    /// Collect all spoken text from segments that OVERLAP with the window.
    ///
    /// Returns joined segment texts. Used to ground hook/headline in actual content.
    pub fn segment_text_in_window(&self, start_sec: f64, end_sec: f64) -> String {
        let start_ms = (start_sec * 1000.0) as i64;
        let end_ms   = (end_sec   * 1000.0) as i64;
        self.segments
            .iter()
            .filter(|s| s.end_ms > start_ms && s.start_ms < end_ms)
            .map(|s| s.text.trim())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Find the segment start time at or BEFORE `t_sec` that begins at a natural
    /// sentence boundary (previous segment ends with `.!?` or gap > 0.5s, or is first).
    ///
    /// Looks back up to `max_lookback` seconds. Returns `t_sec` if nothing found.
    pub fn find_sentence_start_before(&self, t_sec: f64, max_lookback: f64) -> f64 {
        let t_ms        = (t_sec        * 1000.0) as i64;
        let limit_ms    = ((t_sec - max_lookback).max(0.0) * 1000.0) as i64;

        // Collect segments that end at or before t, within the lookback range
        let candidates: Vec<&WhisperSegment> = self.segments
            .iter()
            .filter(|s| s.start_ms <= t_ms && s.start_ms >= limit_ms)
            .collect();

        // Walk backwards through candidates to find a sentence boundary
        for i in (0..candidates.len()).rev() {
            let seg = candidates[i];
            let is_first = i == 0 && seg.start_ms == self.segments.first().map(|s| s.start_ms).unwrap_or(0);
            let prev_ends_sentence = if i == 0 {
                is_first // first segment in video = natural start
            } else {
                let prev = candidates[i - 1];
                let ends_with_punct = prev.text.trim_end().ends_with(['.', '!', '?', '…']);
                let long_gap = seg.start_ms - prev.end_ms > 500; // >0.5s silence
                ends_with_punct || long_gap
            };
            if prev_ends_sentence {
                return seg.start_ms as f64 / 1000.0;
            }
        }
        t_sec // fallback: no boundary found
    }

    /// Find the segment end time at or AFTER `t_sec` that completes a natural sentence
    /// (segment text ends with `.!?` or gap to next segment > 0.5s, or is last).
    ///
    /// Looks ahead up to `max_lookahead` seconds. Returns `t_sec` if nothing found.
    pub fn find_sentence_end_after(&self, t_sec: f64, max_lookahead: f64) -> f64 {
        let t_ms      = (t_sec                       * 1000.0) as i64;
        let limit_ms  = ((t_sec + max_lookahead)     * 1000.0) as i64;

        let segs: Vec<&WhisperSegment> = self.segments
            .iter()
            .filter(|s| s.end_ms >= t_ms && s.start_ms <= limit_ms)
            .collect();

        for (i, seg) in segs.iter().enumerate() {
            let is_last = i + 1 == segs.len();
            let ends_sentence = is_last
                || seg.text.trim_end().ends_with(['.', '!', '?', '…'])
                || (i + 1 < segs.len() && segs[i + 1].start_ms - seg.end_ms > 500);

            if ends_sentence {
                return seg.end_ms as f64 / 1000.0;
            }
        }
        t_sec // fallback: no boundary found
    }

    /// Find the start time of the first segment that comes after a silence gap
    /// longer than `min_gap_sec`, searching from `after_sec` up to `scan_limit_sec`.
    ///
    /// Used for intro detection: intro jingles/music create long silence gaps
    /// in the transcript that mark the transition into real content.
    ///
    /// Returns `None` if no such gap is found within the scan window.
    pub fn first_long_silence_after(
        &self,
        after_sec:      f64,
        min_gap_sec:    f64,
        scan_limit_sec: f64,
    ) -> Option<f64> {
        let after_ms = (after_sec      * 1000.0) as i64;
        let limit_ms = (scan_limit_sec * 1000.0) as i64;

        for window in self.segments.windows(2) {
            let a = &window[0];
            let b = &window[1];
            if a.end_ms   < after_ms { continue; }
            if a.start_ms > limit_ms { break;    }
            let gap_ms = b.start_ms - a.end_ms;
            if gap_ms as f64 / 1000.0 >= min_gap_sec {
                return Some(b.start_ms as f64 / 1000.0);
            }
        }
        None
    }

    /// Fix BPE subword token splits produced by Whisper/Groq.
    ///
    /// Groq returns tokens like `["bers","ama"]` instead of `["bersama"]`.
    /// This method uses each segment's authoritative `text` field to determine
    /// real word boundaries and merges the split tokens accordingly.
    ///
    /// Safe to call multiple times (idempotent: if tokens are already merged,
    /// the output is unchanged).
    pub fn fix_subwords(&mut self) {
        for seg in &mut self.segments {
            if seg.words.is_empty() { continue; }
            seg.words = merge_subword_tokens(&seg.text, &seg.words);
        }
    }
}

/// Merge BPE subword tokens into complete words using the segment text as guide.
///
/// Examples fixed:  "bers"+"ama" → "bersama",  "neg"+"ara" → "negara",
///                  "mis"+"alnya" → "misalnya",  "Peng"+"g"+"una"+"annya" → "Penggunaannya"
pub fn merge_subword_tokens(segment_text: &str, tokens: &[WordTimestamp]) -> Vec<WordTimestamp> {
    fn alnum_key(s: &str) -> String {
        s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
    }

    // Real words from segment text (skip standalone punctuation)
    let text_words: Vec<&str> = segment_text
        .split_whitespace()
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .collect();

    if text_words.is_empty() || tokens.is_empty() {
        return Vec::new();
    }

    let mut result  = Vec::new();
    let mut tok_idx = 0usize;

    for text_word in &text_words {
        let target_key = alnum_key(text_word);
        if target_key.is_empty() { continue; }

        // Skip leading pure-punctuation tokens (., ?, !, -, …, --)
        while tok_idx < tokens.len() && alnum_key(&tokens[tok_idx].word).is_empty() {
            tok_idx += 1;
        }
        if tok_idx >= tokens.len() { break; }

        let start_ms   = tokens[tok_idx].start_ms;
        let mut end_ms = tokens[tok_idx].end_ms;
        let mut accumulated = String::new();

        while tok_idx < tokens.len() {
            let tok_key = alnum_key(&tokens[tok_idx].word);
            if tok_key.is_empty() {
                // Mid-word punctuation — absorb timing without advancing accumulated
                end_ms = tokens[tok_idx].end_ms;
                tok_idx += 1;
                continue;
            }
            accumulated.push_str(&tok_key);
            end_ms = tokens[tok_idx].end_ms;
            tok_idx += 1;

            if accumulated.len() >= target_key.len() { break; }
        }

        // Strip surrounding punctuation for clean subtitle display
        let display = text_word.trim_matches(|c: char| !c.is_alphanumeric()).to_owned();
        if !display.is_empty() {
            result.push(WordTimestamp { word: display, start_ms, end_ms, probability: 1.0 });
        }
    }

    result
}
