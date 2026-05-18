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

    /// Return all word timestamps that fall within a time window (in seconds).
    pub fn words_in_window(&self, start_sec: f64, end_sec: f64) -> Vec<&WordTimestamp> {
        let start_ms = (start_sec * 1000.0) as i64;
        let end_ms = (end_sec * 1000.0) as i64;
        self.segments
            .iter()
            .flat_map(|s| s.words.iter())
            .filter(|w| w.start_ms >= start_ms && w.end_ms <= end_ms)
            .collect()
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
