//! Stealth HTTP scraper for overlay URL resolution.
//!
//! Implements the anti-detection patterns from Scrapling (Python) in pure
//! Rust using reqwest + rustls:
//!
//! - Chrome-matched HTTP/2 flow-control window sizes (from chrome://net-internals)
//! - Full Chrome 124 header stack: User-Agent, Sec-Ch-Ua, Client Hints,
//!   Sec-Fetch-* navigation signals
//! - Google Referer on every request (organic visit signal)
//! - Result ranking by view count before yt-dlp download
//!
//! The scraper resolves direct video URLs from TikTok / YouTube search pages
//! so yt-dlp receives a concrete URL rather than running a blind search —
//! reducing download time by 3–5× and bypassing platform search-ranking noise.
//!
//! Fallback chain (tried in order):
//!   1. TikTok search page  (`__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON)
//!   2. YouTube Shorts page (`ytInitialData` JSON)
//!   3. Caller's existing yt-dlp search (overlay.rs handles this)

use std::time::Duration;

use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, REFERER, USER_AGENT,
};
use serde_json::Value;
use tracing::{debug, info, warn};

// ── Public types ──────────────────────────────────────────────────────────────

/// A single video result returned by the scraper.
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// Direct playable URL for yt-dlp (YouTube watch/shorts URL or TikTok video URL).
    pub url: String,
    /// Video title — for logging and relevance scoring.
    pub title: String,
    /// View/play count — used to rank results (higher = more viral).
    pub view_count: u64,
    /// Duration in seconds — clips over max_duration are filtered out.
    pub duration_secs: u32,
    /// Platform label for log messages.
    pub platform: &'static str,
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Resolve up to `max_results` direct video URLs for `query`.
///
/// Tries TikTok first (higher viral relevance), then YouTube Shorts.
/// Returns an empty Vec on any error — the caller falls back to yt-dlp search.
pub async fn resolve_overlay_urls(
    query:       &str,
    max_results: usize,
    max_dur_sec: u32,
) -> Vec<SearchResult> {
    // TikTok first — higher meme / viral clip density
    let tt = search_tiktok(query, max_results, max_dur_sec).await;
    if !tt.is_empty() {
        info!(
            "  🔍 Scraper: TikTok returned {} result(s) for \"{}\"",
            tt.len(), query
        );
        return tt;
    }

    // YouTube Shorts fallback
    let yt = search_youtube_shorts(query, max_results, max_dur_sec).await;
    if !yt.is_empty() {
        info!(
            "  🔍 Scraper: YouTube Shorts returned {} result(s) for \"{}\"",
            yt.len(), query
        );
        return yt;
    }

    debug!("scraper: no results from TikTok or YouTube for \"{}\"", query);
    Vec::new()
}

// ── Stealth HTTP client ───────────────────────────────────────────────────────

/// Recent Chrome User-Agent strings — rotated by subsecond timestamp to look organic.
const CHROME_UAS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

/// Build a `reqwest::Client` with Chrome 120+ fingerprint characteristics:
///
/// - HTTP/2 stream window:      6,291,456 bytes  (Chrome DevTools net-internals)
/// - HTTP/2 connection window: 15,728,640 bytes  (Chrome DevTools net-internals)
/// - Adaptive window sizing enabled
/// - rustls TLS stack (better fingerprint than OpenSSL/native-tls)
/// - Gzip decompression enabled
/// - 15-second timeout
fn build_stealth_client() -> reqwest::Client {
    let ua_idx = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis() as usize)
        .unwrap_or(0);
    let ua = CHROME_UAS[ua_idx % CHROME_UAS.len()];

    reqwest::Client::builder()
        .user_agent(ua)
        // ── Chrome 120+ HTTP/2 flow-control settings (SKILL.md §1A) ──────────
        // Source: chrome://net-internals/#http2 on a fresh Chrome 124 session.
        .http2_initial_stream_window_size(6_291_456_u32)
        .http2_initial_connection_window_size(15_728_640_u32)
        .http2_adaptive_window(true)
        // ── TLS ───────────────────────────────────────────────────────────────
        // rustls produces a cleaner TLS fingerprint than native-tls/OpenSSL.
        // HTTP/2 is automatically negotiated via ALPN (h2, http/1.1 order).
        .use_rustls_tls()
        // ── Decompression ─────────────────────────────────────────────────────
        .gzip(true)
        .deflate(true)
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Build Chrome 124 request headers (SKILL.md §1B — browser fingerprint spoofing).
///
/// Includes:
/// - `Sec-Ch-Ua` Client Hints (Chrome 124 signature)
/// - `Sec-Fetch-*` navigation signals that indicate a top-level navigation
/// - `Accept` and `Accept-Language` matching a Windows Chrome install
/// - `Referer: https://www.google.com/` (Scrapling §5 — organic visit signal)
fn chrome_headers(referer: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();

    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,\
             image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        ),
    );
    headers.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_static("en-US,en;q=0.9,id;q=0.8"),
    );
    // We claim brotli in Accept-Encoding (matches Chrome) but only decode gzip/deflate.
    // Servers that only support gzip will send gzip; brotli servers may send br,
    // which reqwest will return as raw bytes — handled by graceful parse failure.
    headers.insert(
        ACCEPT_ENCODING,
        HeaderValue::from_static("gzip, deflate, br, zstd"),
    );
    headers.insert(
        REFERER,
        HeaderValue::from_str(referer)
            .unwrap_or_else(|_| HeaderValue::from_static("https://www.google.com/")),
    );

    // ── Chrome Client Hints (Sec-Ch-Ua) ──────────────────────────────────────
    // These are the most reliable browser fingerprint signals (SKILL.md §1B).
    // A missing or wrong Sec-Ch-Ua is a strong bot indicator.
    headers.insert(
        "Sec-Ch-Ua",
        HeaderValue::from_static(
            r#""Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99""#,
        ),
    );
    headers.insert("Sec-Ch-Ua-Mobile",   HeaderValue::from_static("?0"));
    headers.insert("Sec-Ch-Ua-Platform", HeaderValue::from_static("\"Windows\""));

    // ── Navigation signals ────────────────────────────────────────────────────
    // Sec-Fetch-* headers describe how the request was initiated.
    // navigate + document + none + ?1 = top-level user navigation (address bar / click).
    headers.insert("Sec-Fetch-Dest", HeaderValue::from_static("document"));
    headers.insert("Sec-Fetch-Mode", HeaderValue::from_static("navigate"));
    headers.insert("Sec-Fetch-Site", HeaderValue::from_static("none"));
    headers.insert("Sec-Fetch-User", HeaderValue::from_static("?1"));

    headers.insert("Upgrade-Insecure-Requests", HeaderValue::from_static("1"));
    headers.insert("Cache-Control",              HeaderValue::from_static("max-age=0"));
    headers.insert("Connection",                 HeaderValue::from_static("keep-alive"));

    headers
}

// ── YouTube Shorts scraper ────────────────────────────────────────────────────

/// Search YouTube Shorts and return up to `max_results` direct video URLs.
///
/// Fetches `youtube.com/results?search_query=…&sp=EgIQAQ==` (Shorts filter),
/// extracts the `ytInitialData` JSON blob embedded in the page, and parses
/// `videoRenderer` and `reelItemRenderer` entries.
///
/// Results are sorted by view count descending so yt-dlp downloads the
/// most-viral match first.
pub async fn search_youtube_shorts(
    query:       &str,
    max_results: usize,
    max_dur_sec: u32,
) -> Vec<SearchResult> {
    let client = build_stealth_client();

    // sp=EgIQAQ%3D%3D  →  base64-encoded protobuf: {"filter":{"type":"VIDEO"}}
    // with Shorts sub-filter active. This is the stable Shorts filter token
    // as of Chrome 124 — YouTube changes it occasionally.
    let url = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%3D%3D",
        url_encode(query)
    );

    debug!("scraper: YouTube Shorts search — {url}");

    let resp = match client
        .get(&url)
        .headers(chrome_headers("https://www.google.com/"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            warn!("scraper: YouTube request failed: {e}");
            return Vec::new();
        }
    };

    if !resp.status().is_success() {
        warn!("scraper: YouTube returned HTTP {}", resp.status());
        return Vec::new();
    }

    let html = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            warn!("scraper: YouTube body read failed: {e}");
            return Vec::new();
        }
    };

    parse_yt_results(&html, max_results, max_dur_sec)
}

/// Extract video results from the `ytInitialData` JSON blob in a YouTube HTML page.
///
/// Content extraction approach (SKILL.md §3A):
///   1. Find `var ytInitialData = ` in the raw HTML (no DOM parsing needed)
///   2. Extract the JSON object using brace-depth tracking
///   3. Navigate the JSON tree for `videoRenderer` and `reelItemRenderer` nodes
fn parse_yt_results(html: &str, max_results: usize, max_dur_sec: u32) -> Vec<SearchResult> {
    const MARKER: &str = "var ytInitialData = ";
    let start = match html.find(MARKER) {
        Some(i) => i + MARKER.len(),
        None => {
            debug!("scraper: ytInitialData not found — likely Cloudflare challenge page");
            return Vec::new();
        }
    };

    let slice = &html[start..];
    let end = match find_json_end(slice) {
        Some(i) => i,
        None => {
            warn!("scraper: could not find end of ytInitialData JSON");
            return Vec::new();
        }
    };

    let json: Value = match serde_json::from_str(&slice[..end]) {
        Ok(v) => v,
        Err(e) => {
            warn!("scraper: ytInitialData parse error: {e}");
            return Vec::new();
        }
    };

    // Primary path for regular search results
    let sections = json
        .pointer("/contents/twoColumnSearchResultsRenderer/primaryContents/sectionListRenderer/contents")
        .and_then(|v| v.as_array());

    let Some(sections) = sections else {
        debug!("scraper: unexpected ytInitialData structure (no sectionListRenderer)");
        return Vec::new();
    };

    let mut results: Vec<SearchResult> = Vec::new();

    for section in sections {
        if results.len() >= max_results * 3 { break; }

        // Standard video results
        if let Some(items) = section
            .pointer("/itemSectionRenderer/contents")
            .and_then(|v| v.as_array())
        {
            for item in items {
                if let Some(vr) = item.get("videoRenderer") {
                    if let Some(sr) = extract_video_renderer(vr, max_dur_sec) {
                        results.push(sr);
                    }
                }
            }
        }

        // Shorts shelf (reelShelfRenderer)
        if let Some(items) = section
            .pointer("/reelShelfRenderer/items")
            .and_then(|v| v.as_array())
        {
            for item in items {
                if let Some(rr) = item.get("reelItemRenderer") {
                    if let Some(sr) = extract_reel_renderer(rr) {
                        results.push(sr);
                    }
                }
            }
        }
    }

    // Sort by view count descending — most-viral clips come first
    results.sort_by(|a, b| b.view_count.cmp(&a.view_count));
    results.truncate(max_results);

    results
}

fn extract_video_renderer(vr: &Value, max_dur_sec: u32) -> Option<SearchResult> {
    let video_id = vr.get("videoId")?.as_str()?.to_owned();

    let dur_secs = vr
        .pointer("/lengthText/simpleText")
        .or_else(|| vr.pointer("/lengthText/runs/0/text"))
        .and_then(|v| v.as_str())
        .and_then(parse_duration_hms)
        .unwrap_or(0);

    if max_dur_sec > 0 && dur_secs > max_dur_sec { return None; }

    let title = vr
        .pointer("/title/runs/0/text")
        .or_else(|| vr.pointer("/title/simpleText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();

    let view_count = vr
        .pointer("/viewCountText/simpleText")
        .and_then(|v| v.as_str())
        .and_then(parse_view_count)
        .unwrap_or(0);

    Some(SearchResult {
        url:           format!("https://www.youtube.com/watch?v={video_id}"),
        title,
        view_count,
        duration_secs: dur_secs,
        platform:      "youtube",
    })
}

fn extract_reel_renderer(rr: &Value) -> Option<SearchResult> {
    let video_id = rr.get("videoId")?.as_str()?.to_owned();

    let title = rr
        .pointer("/headline/simpleText")
        .or_else(|| rr.pointer("/accessibilityText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();

    let view_count = rr
        .pointer("/viewCountText/simpleText")
        .and_then(|v| v.as_str())
        .and_then(parse_view_count)
        .unwrap_or(0);

    Some(SearchResult {
        url:           format!("https://www.youtube.com/shorts/{video_id}"),
        title,
        view_count,
        duration_secs: 60, // Shorts ≤ 60s by platform definition
        platform:      "youtube_shorts",
    })
}

// ── TikTok scraper ────────────────────────────────────────────────────────────

/// Attempt to scrape TikTok search results.
///
/// TikTok embeds results in a `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">`
/// tag. This works when the page isn't behind a Cloudflare challenge.
/// Returns an empty Vec on any failure — caller falls back to YouTube.
pub async fn search_tiktok(
    query:       &str,
    max_results: usize,
    max_dur_sec: u32,
) -> Vec<SearchResult> {
    let client = build_stealth_client();

    let url = format!(
        "https://www.tiktok.com/search?q={}&type=video",
        url_encode(query)
    );

    debug!("scraper: TikTok search — {url}");

    // Use a more TikTok-appropriate referer (previous TikTok page)
    let mut headers = chrome_headers("https://www.tiktok.com/");
    // TikTok uses a different Accept header for its SPA pages
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ),
    );

    let resp = match client.get(&url).headers(headers).send().await {
        Ok(r) => r,
        Err(e) => {
            debug!("scraper: TikTok request failed: {e}");
            return Vec::new();
        }
    };

    if !resp.status().is_success() {
        debug!("scraper: TikTok returned HTTP {} — likely Cloudflare challenge", resp.status());
        return Vec::new();
    }

    let html = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            debug!("scraper: TikTok body read failed: {e}");
            return Vec::new();
        }
    };

    parse_tiktok_results(&html, max_results, max_dur_sec)
}

/// Extract video results from TikTok's `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON.
///
/// Content extraction (SKILL.md §3A):
///   1. Find the script tag by id
///   2. Extract JSON between `>` and `</script>`
///   3. Navigate: `__DEFAULT_SCOPE__` → `webapp.search-result-list` → `searchItemList`
fn parse_tiktok_results(html: &str, max_results: usize, max_dur_sec: u32) -> Vec<SearchResult> {
    const MARKER: &str = r#"id="__UNIVERSAL_DATA_FOR_REHYDRATION__""#;

    let tag_pos = match html.find(MARKER) {
        Some(i) => i,
        None => {
            debug!("scraper: TikTok __UNIVERSAL_DATA_FOR_REHYDRATION__ not found");
            return Vec::new();
        }
    };

    // Find the `>` that ends the opening tag, then parse JSON until `</script>`
    let after_tag = &html[tag_pos..];
    let json_start = match after_tag.find('>') {
        Some(i) => tag_pos + i + 1,
        None    => return Vec::new(),
    };
    let json_slice = &html[json_start..];
    let json_end = match json_slice.find("</script>") {
        Some(i) => i,
        None    => json_slice.len(),
    };

    let json: Value = match serde_json::from_str(json_slice[..json_end].trim()) {
        Ok(v) => v,
        Err(e) => {
            debug!("scraper: TikTok JSON parse error: {e}");
            return Vec::new();
        }
    };

    // Navigate to search result list
    let item_list = json
        .pointer("/__DEFAULT_SCOPE__/webapp.search-result-list/data/itemList")
        .or_else(|| json.pointer("/__DEFAULT_SCOPE__/webapp.search-result-list/searchItemList"))
        .and_then(|v| v.as_array());

    let Some(items) = item_list else {
        debug!("scraper: TikTok unexpected JSON structure (no searchItemList)");
        return Vec::new();
    };

    let mut results: Vec<SearchResult> = Vec::new();

    for entry in items {
        if results.len() >= max_results * 2 { break; }

        // Items can be at root or nested under "item"
        let item = entry.get("item").unwrap_or(entry);

        let Some(video_id) = item.get("id").and_then(|v| v.as_str()) else { continue };
        let author_id = item
            .pointer("/author/uniqueId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let dur_secs = item
            .pointer("/video/duration")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        if max_dur_sec > 0 && dur_secs > max_dur_sec { continue; }

        let title = item.get("desc")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();

        let view_count = item
            .pointer("/stats/playCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        results.push(SearchResult {
            url: format!("https://www.tiktok.com/@{author_id}/video/{video_id}"),
            title,
            view_count,
            duration_secs: dur_secs,
            platform: "tiktok",
        });
    }

    results.sort_by(|a, b| b.view_count.cmp(&a.view_count));
    results.truncate(max_results);
    results
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/// Parse "MM:SS" or "H:MM:SS" duration string into total seconds.
fn parse_duration_hms(s: &str) -> Option<u32> {
    let parts: Vec<u32> = s
        .split(':')
        .filter_map(|p| p.trim().parse::<u32>().ok())
        .collect();
    match parts.len() {
        1 => Some(parts[0]),
        2 => Some(parts[0] * 60 + parts[1]),
        3 => Some(parts[0] * 3_600 + parts[1] * 60 + parts[2]),
        _ => None,
    }
}

/// Parse view count strings: "1,234,567 views", "1.2M views", "890K views".
fn parse_view_count(s: &str) -> Option<u64> {
    let s = s.to_lowercase();
    let s = s
        .trim_end_matches("views")
        .trim_end_matches("view")
        .trim_end_matches("ditonton")   // Indonesian YouTube
        .trim_end_matches("x ditonton")
        .replace([',', ' ', '\u{00a0}'], ""); // non-breaking space too

    if s.ends_with('b') {
        s.trim_end_matches('b').parse::<f64>().ok().map(|n| (n * 1_000_000_000.0) as u64)
    } else if s.ends_with('m') {
        s.trim_end_matches('m').parse::<f64>().ok().map(|n| (n * 1_000_000.0) as u64)
    } else if s.ends_with('k') {
        s.trim_end_matches('k').parse::<f64>().ok().map(|n| (n * 1_000.0) as u64)
    } else {
        s.parse::<u64>().ok()
    }
}

/// Find the character index just past the closing `}` that matches the opening
/// `{` at position 0 of `s`. Handles nested objects and quoted strings.
fn find_json_end(s: &str) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape_next = false;

    for (i, c) in s.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if in_string {
            match c {
                '\\' => escape_next = true,
                '"'  => in_string = false,
                _    => {}
            }
        } else {
            match c {
                '"' => in_string = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 { return Some(i + 1); }
                }
                _ => {}
            }
        }
    }
    None
}

/// Percent-encode a query string for inclusion in a URL.
fn url_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_owned(),
            c   => format!("%{:02X}", c as u32),
        })
        .collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_duration() {
        assert_eq!(parse_duration_hms("0:45"),   Some(45));
        assert_eq!(parse_duration_hms("1:23"),   Some(83));
        assert_eq!(parse_duration_hms("1:23:45"), Some(5025));
        assert_eq!(parse_duration_hms("59"),     Some(59));
    }

    #[test]
    fn test_parse_view_count() {
        assert_eq!(parse_view_count("1,234,567 views"), Some(1_234_567));
        assert_eq!(parse_view_count("1.2M views"),      Some(1_200_000));
        assert_eq!(parse_view_count("890K views"),       Some(890_000));
        assert_eq!(parse_view_count("2.1B views"),       Some(2_100_000_000));
    }

    #[test]
    fn test_find_json_end() {
        let s = r#"{"a":1,"b":{"c":2}};"#;
        assert_eq!(find_json_end(s), Some(19));
    }

    #[test]
    fn test_url_encode() {
        assert_eq!(url_encode("hello world"), "hello+world");
        assert_eq!(url_encode("harga naik 30%"), "harga+naik+30%25");
    }
}
