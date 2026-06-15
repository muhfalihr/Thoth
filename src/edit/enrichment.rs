//! Cross-platform enrichment pool — cutaway B-roll source for the edit stage.
//!
//! Stage 0.5 (`resolve_query_to_url` in `main.rs`) writes `content_enrichment.json`
//! to the pipeline base dir: every relevant clip/tweet/news/IG post found across
//! platforms EXCEPT the main video. This module loads that file and exposes the
//! subset usable as overlay cutaways — downloadable, relevance-verified videos —
//! which is exactly what the Animelorian style needs (multiple relevant clips, not
//! one fresh per-query search).

use std::path::Path;

use tracing::{debug, info, warn};

use crate::ingest::content_search::ContentResult;

/// File name written by `resolve_query_to_url`, relative to the pipeline base dir.
pub const ENRICHMENT_FILE: &str = "content_enrichment.json";

/// Platforms that are article/page scrapes, never a yt-dlp-downloadable media URL.
/// Everything NOT in this set is treated as a candidate (yt-dlp supports a vast
/// site list — youtube, instagram, tiktok, twitter/x, facebook, vimeo, twitch,
/// dailymotion, …); a failed download is skipped gracefully by the caller.
const NON_MEDIA_PLATFORMS: &[&str] = &["news", "web", "article", "blog"];

/// True when a result is a downloadable video cutaway candidate.
///
/// Platform-agnostic: any platform yt-dlp can handle qualifies. We gate on the
/// `is_video` flag (OpenClaw sets it only for real video content — text tweets
/// are `false`) plus a non-empty URL, and exclude the explicit page-scrape
/// platforms above. yt-dlp attempts the actual download; if a given platform/URL
/// can't be fetched, `fetch_overlay_from_url` returns `None` and that footage is
/// simply skipped, so an over-broad match never breaks rendering.
fn is_downloadable_video(r: &ContentResult) -> bool {
    r.is_video
        && !r.url.trim().is_empty()
        && !NON_MEDIA_PLATFORMS.contains(&r.platform.as_str())
}

/// True when a result is a NON-video post with a usable cropped screenshot — i.e.
/// an image-card candidate (tweet/IG photo/article that OpenClaw screenshotted +
/// vision-cropped). These cannot be downloaded by yt-dlp; the edit stage renders
/// the still image as a centred card instead. The file must exist on disk.
fn is_image_card(r: &ContentResult) -> bool {
    !r.is_video
        && !r.image_path.trim().is_empty()
        && Path::new(r.image_path.trim()).exists()
}

/// Load the IMAGE-card pool from `base_dir/content_enrichment.json`: non-video
/// footage entries whose `image_path` points at an existing cropped screenshot.
///
/// Parallel to [`load_pool`] (the downloadable-video cutaways): same source file,
/// disjoint subset. Ranks `relevance == "match"` first, drops `"unverified"`, and
/// skips entries whose crop file is missing. Returns empty when none qualify —
/// callers then simply render no image cards. Never errors.
pub fn load_image_pool(base_dir: &Path) -> Vec<ContentResult> {
    let path = base_dir.join(ENRICHMENT_FILE);
    if !path.exists() {
        return Vec::new();
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let all: Vec<ContentResult> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            warn!("enrichment: cannot parse {} for image pool: {e}", path.display());
            return Vec::new();
        }
    };

    let mut pool: Vec<ContentResult> = all
        .into_iter()
        .filter(is_image_card)
        .filter(|r| r.relevance != "unverified")
        .collect();
    pool.sort_by_key(|r| if r.relevance == "match" { 0 } else { 1 });

    if !pool.is_empty() {
        info!(
            "🖼️  enrichment image-card pool: {} cropped post(s) [{}]",
            pool.len(),
            pool.iter().map(|r| r.platform.as_str()).collect::<Vec<_>>().join(",")
        );
    }
    pool
}

/// Load and rank the enrichment cutaway pool from `base_dir/content_enrichment.json`.
///
/// Returns downloadable video candidates ordered best-first:
///   1. `relevance == "match"` (caption/title verified against the query) first,
///   2. then entries with no relevance tag (older files / pre-filter),
///   3. dropping `relevance == "unverified"` (couldn't be checked — avoid noise).
///
/// Returns an empty vec when the file is absent or holds no usable video — callers
/// then fall back to the per-moment `overlay_query` search. Never errors.
pub fn load_pool(base_dir: &Path) -> Vec<ContentResult> {
    let path = base_dir.join(ENRICHMENT_FILE);
    if !path.exists() {
        debug!("enrichment: no {} (skipping cutaway pool)", path.display());
        return Vec::new();
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            warn!("enrichment: cannot read {}: {e}", path.display());
            return Vec::new();
        }
    };
    let all: Vec<ContentResult> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            warn!("enrichment: cannot parse {}: {e}", path.display());
            return Vec::new();
        }
    };

    let mut pool: Vec<ContentResult> = all
        .into_iter()
        .filter(is_downloadable_video)
        .filter(|r| r.relevance != "unverified")
        .collect();

    // Stable rank: relevance=="match" before untagged; preserve original order within.
    pool.sort_by_key(|r| if r.relevance == "match" { 0 } else { 1 });

    if !pool.is_empty() {
        info!(
            "🎬 enrichment cutaway pool: {} downloadable video(s) [{}]",
            pool.len(),
            pool.iter().map(|r| r.platform.as_str()).collect::<Vec<_>>().join(",")
        );
    }
    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vid(platform: &str, url: &str, is_video: bool, relevance: &str) -> ContentResult {
        ContentResult {
            platform: platform.into(), url: url.into(), title: "t".into(),
            snippet: String::new(), source: String::new(), published: None,
            thumbnail: String::new(), is_video, duration_sec: 120, views: 0,
            query: "q".into(), description: String::new(), relevance: relevance.into(), image_path: String::new(),
        }
    }

    #[test]
    fn image_card_requires_existing_file() {
        // Non-video with empty image_path → not a card.
        assert!(!is_image_card(&vid("twitter", "u", false, "match")));
        // Non-video pointing at a real temp file → card.
        let mut p = std::env::temp_dir();
        p.push(format!("clipper_imgcard_{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&p, b"x").unwrap();
        let mut r = vid("twitter", "u", false, "match");
        r.image_path = p.to_string_lossy().to_string();
        assert!(is_image_card(&r));
        // A video item with an image_path is NOT an image card (it's a real video).
        let mut rv = vid("youtube", "u", true, "match");
        rv.image_path = p.to_string_lossy().to_string();
        assert!(!is_image_card(&rv));
        let _ = std::fs::remove_file(&p);
        // Missing file → not a card.
        assert!(!is_image_card(&r));
    }

    #[test]
    fn missing_file_is_empty() {
        let pool = load_pool(Path::new("C:/nonexistent/clipper/path/xyz"));
        assert!(pool.is_empty());
    }

    #[test]
    fn filters_and_ranks() {
        let all = vec![
            vid("youtube",  "yt_unver", true,  "unverified"), // dropped (unverified)
            vid("twitter",  "tw_vid",   true,  "match"),       // kept now (video, yt-dlp-able)
            vid("youtube",  "yt_match", true,  "match"),       // kept, rank 0
            vid("news",     "nw1",      true,  "match"),       // dropped (page-scrape platform)
            vid("twitter",  "tw_text",  false, "match"),       // dropped (not video)
            vid("tiktok",   "tt_plain", true,  ""),            // kept, rank 1
            vid("instagram","ig_plain", true,  ""),            // kept, rank 1
        ];
        // Round-trip through the same filtering used by load_pool.
        let mut pool: Vec<ContentResult> = all.into_iter()
            .filter(is_downloadable_video)
            .filter(|r| r.relevance != "unverified")
            .collect();
        pool.sort_by_key(|r| if r.relevance == "match" { 0 } else { 1 });
        let urls: Vec<&str> = pool.iter().map(|r| r.url.as_str()).collect();
        // match-ranked first (order preserved within rank), then untagged.
        assert_eq!(urls, vec!["tw_vid", "yt_match", "tt_plain", "ig_plain"]);
    }

    #[test]
    fn page_scrapes_excluded() {
        assert!(!is_downloadable_video(&vid("news", "u", true, "match")));
        assert!(!is_downloadable_video(&vid("web",  "u", true, "match")));
        // real video platforms all qualify regardless of name
        for p in ["youtube", "instagram", "tiktok", "twitter", "facebook", "vimeo"] {
            assert!(is_downloadable_video(&vid(p, "u", true, "match")), "{p} should qualify");
        }
    }
}
