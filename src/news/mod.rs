//! News enrichment (pipeline Stage 4).
//!
//! Flow per viral moment:
//! ```text
//! transcript window (what was actually said)
//!   → keyword extraction (LLM)        — news/keyword.rs
//!   → internet search per keyword     — news/search.rs  (Playwright / Serper)
//!   → dedup + relevance scoring       — news/search.rs
//!   → (Phase 2) screenshot articles   — news/scraper.rs
//! ```
//!
//! Orchestration across all moments lives in [`service::EnrichService`], which the
//! pipeline runs between Analyze (Stage 3) and Edit (Stage 5).

pub mod error;
pub mod formatter;
pub mod keyword;
pub mod model;
pub mod scraper;
pub mod search;
pub mod service;
pub mod util;

pub use error::NewsError;
pub use model::{EnrichResult, MomentEnrichment, NewsItem};
pub use service::EnrichService;
