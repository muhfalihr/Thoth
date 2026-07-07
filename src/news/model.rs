//! Data structures for the News enrichment stage (Stage 4).
//!
//! The central idea: every search keyword is derived from the RAW transcript text
//! spoken during a viral moment — see [`MomentEnrichment::transcript_window`].

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A raw result returned by the search backend (Playwright script or Serper API)
/// before relevance scoring / screenshotting. Mirrors the JSON shape emitted by
/// `scripts/news/news_search.py`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RawSearchResult {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub source: String,
    /// Publication date as returned by the backend (free-form or RFC3339).
    #[serde(default)]
    pub published: Option<String>,
    /// The search query that produced this result (set when batching multiple
    /// queries in one browser session).
    #[serde(default)]
    pub query: Option<String>,
}

/// A single relevant news article attached to a moment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsItem {
    /// Article URL.
    pub url: String,
    /// Article headline / title.
    pub title: String,
    /// Lead paragraph / snippet (≤ ~3 sentences).
    #[serde(default)]
    pub summary: String,
    /// Source name (e.g. "CNN Indonesia", "Kompas").
    #[serde(default)]
    pub source: String,
    /// Publication date (free-form string from the backend, or RFC3339).
    #[serde(default)]
    pub published_at: Option<String>,
    /// The extracted keyword that surfaced this article.
    #[serde(default)]
    pub matched_keyword: String,
    /// Relevance score 0.0–1.0 against the moment's transcript window.
    #[serde(default)]
    pub relevance_score: f32,
    /// Path to the raw screenshot (populated in Phase 2).
    #[serde(default)]
    pub screenshot_path: Option<PathBuf>,
    /// Path to the 9:16 formatted screenshot with caption (Phase 2).
    #[serde(default)]
    pub formatted_screenshot_path: Option<PathBuf>,
}

impl NewsItem {
    pub fn from_raw(raw: RawSearchResult, keyword: &str) -> Self {
        let matched = raw.query.clone().unwrap_or_else(|| keyword.to_owned());
        Self {
            url: raw.url,
            title: raw.title,
            summary: raw.snippet,
            source: raw.source,
            published_at: raw.published,
            matched_keyword: matched,
            relevance_score: 0.0,
            screenshot_path: None,
            formatted_screenshot_path: None,
        }
    }
}

/// All enrichment data attached to a single viral moment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MomentEnrichment {
    /// Index into `moments.json`.
    pub moment_index: usize,
    /// Raw transcript text spoken during the moment window — the INPUT to keyword
    /// extraction. Not a ViralMoment field; reflects what was actually said.
    pub transcript_window: String,
    /// Keywords the LLM extracted from `transcript_window`. One search per keyword.
    #[serde(default)]
    pub extracted_keywords: Vec<String>,
    /// Relevant news found, ranked by `relevance_score` descending.
    #[serde(default)]
    pub news: Vec<NewsItem>,

    // ── Reaction fields (Phase 4-6) ──────────────────────────────────────────
    /// LLM-generated reaction script (Phase 4).
    #[serde(default)]
    pub reaction_script: Option<crate::reaction::ReactionScript>,
    /// TTS audio path for the reaction voice-over (Phase 4).
    #[serde(default)]
    pub tts_audio_path: Option<PathBuf>,
    /// Avatar video path (Phase 5/6).
    #[serde(default)]
    pub avatar_video_path: Option<PathBuf>,
}

impl MomentEnrichment {
    pub fn new(moment_index: usize, transcript_window: String) -> Self {
        Self {
            moment_index,
            transcript_window,
            extracted_keywords: Vec::new(),
            news: Vec::new(),
            reaction_script: None,
            tts_audio_path: None,
            avatar_video_path: None,
        }
    }

    /// The single best news item (highest relevance), if any.
    pub fn best_news(&self) -> Option<&NewsItem> {
        self.news.first()
    }
}

/// Stage 4 output, stored in `enrich/enrich.json` and `state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichResult {
    pub enrichments: Vec<MomentEnrichment>,
    pub completed_at: DateTime<Utc>,
    pub news_found: usize,
    pub screenshots_taken: usize,
    pub reactions_generated: usize,
    pub tts_generated: usize,
    pub avatars_generated: usize,
}

impl EnrichResult {
    /// Build an `EnrichResult` from per-moment enrichments, computing aggregate stats.
    pub fn from_enrichments(enrichments: Vec<MomentEnrichment>) -> Self {
        let news_found = enrichments.iter().map(|e| e.news.len()).sum();
        let screenshots_taken = enrichments
            .iter()
            .flat_map(|e| e.news.iter())
            .filter(|n| n.screenshot_path.is_some())
            .count();
        let tts_generated = enrichments.iter().filter(|e| e.tts_audio_path.is_some()).count();
        let avatars_generated = enrichments.iter().filter(|e| e.avatar_video_path.is_some()).count();
        Self {
            enrichments,
            completed_at: Utc::now(),
            news_found,
            screenshots_taken,
            reactions_generated: 0,
            tts_generated,
            avatars_generated,
        }
    }
}
