//! Test script for CLIPPER scraper module.
//!
//! Menguji TikTok & YouTube Shorts stealth-scraping secara langsung.
//! Logic identik dengan `src/scraper/mod.rs` di project utama.
//!
//! Usage:
//!   cargo run -- "kurs rupiah dolar"
//!   cargo run -- "harga galaxy tab mahal" --max-results 5
//!   cargo run -- "momen lucu viral" --platform youtube --max-duration 30
//!   cargo run -- "MBG program pemerintah" --platform both --verbose

use std::time::{Duration, Instant};

use anyhow::Result;
use clap::Parser;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, REFERER,
};
use serde_json::Value;

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "scraper-test", about = "Test CLIPPER overlay scraper")]
struct Args {
    /// Query string to search for
    query: String,

    /// Platform to test: tiktok | youtube | both (default: both)
    #[arg(long, default_value = "both")]
    platform: String,

    /// Maximum results to return per platform
    #[arg(long, default_value_t = 5)]
    max_results: usize,

    /// Maximum video duration in seconds (0 = no limit, default)
    #[arg(long, default_value_t = 0)]
    max_duration: u32,

    /// Show raw JSON structure details (debug mode)
    #[arg(long)]
    verbose: bool,

    /// Save raw HTML to file for inspection (debug mode)
    #[arg(long)]
    save_html: bool,
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct SearchResult {
    url:           String,
    title:         String,
    view_count:    u64,
    duration_secs: u32,
    platform:      &'static str,
}

// ── Stealth client ────────────────────────────────────────────────────────────

const CHROME_UAS: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

fn build_stealth_client() -> reqwest::Client {
    let ua_idx = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis() as usize)
        .unwrap_or(0);
    let ua = CHROME_UAS[ua_idx % CHROME_UAS.len()];

    reqwest::Client::builder()
        .user_agent(ua)
        .http2_initial_stream_window_size(6_291_456_u32)
        .http2_initial_connection_window_size(15_728_640_u32)
        .http2_adaptive_window(true)
        .use_rustls_tls()
        .gzip(true)
        .deflate(true)
        .brotli(true)
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn chrome_headers(referer: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,\
             image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        ),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9,id;q=0.8"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, deflate, br, zstd"));
    headers.insert(
        REFERER,
        HeaderValue::from_str(referer)
            .unwrap_or_else(|_| HeaderValue::from_static("https://www.google.com/")),
    );
    headers.insert(
        "Sec-Ch-Ua",
        HeaderValue::from_static(
            r#""Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99""#,
        ),
    );
    headers.insert("Sec-Ch-Ua-Mobile",   HeaderValue::from_static("?0"));
    headers.insert("Sec-Ch-Ua-Platform", HeaderValue::from_static("\"Windows\""));
    headers.insert("Sec-Fetch-Dest",     HeaderValue::from_static("document"));
    headers.insert("Sec-Fetch-Mode",     HeaderValue::from_static("navigate"));
    headers.insert("Sec-Fetch-Site",     HeaderValue::from_static("none"));
    headers.insert("Sec-Fetch-User",     HeaderValue::from_static("?1"));
    headers.insert("Upgrade-Insecure-Requests", HeaderValue::from_static("1"));
    headers.insert("Cache-Control",             HeaderValue::from_static("max-age=0"));
    headers
}

// ── YouTube Shorts ────────────────────────────────────────────────────────────

async fn search_youtube(
    query:       &str,
    max_results: usize,
    max_dur:     u32,
    verbose:     bool,
    save_html:   bool,
) -> Result<Vec<SearchResult>> {
    let client = build_stealth_client();
    let url = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%3D%3D",
        url_encode(query)
    );

    println!("  🌐  GET {url}");
    let t0 = Instant::now();

    let resp = client
        .get(&url)
        .headers(chrome_headers("https://www.google.com/"))
        .send()
        .await?;

    let status = resp.status();
    let elapsed = t0.elapsed();
    println!("  ⚡  HTTP {} — {:.0}ms", status, elapsed.as_millis());

    if !status.is_success() {
        println!("  ❌  Request failed ({})", status);
        return Ok(Vec::new());
    }

    let html = resp.text().await?;
    println!("  📦  Response: {} bytes", html.len());

    if save_html {
        let fname = format!("yt_search_{}.html", sanitize_filename(query));
        std::fs::write(&fname, &html)?;
        println!("  💾  HTML saved to: {fname}");
    }

    // ── Marker detection ──────────────────────────────────────────────────────
    const MARKER: &str = "var ytInitialData = ";
    if let Some(pos) = html.find(MARKER) {
        println!("  ✅  ytInitialData found at offset {pos}");
    } else {
        println!("  ⚠️   ytInitialData NOT found — likely Cloudflare challenge or bot-blocked");
        // Print first 300 chars for debugging
        let snippet = html.chars().take(300).collect::<String>();
        println!("  📄  Page start: {snippet}");
        return Ok(Vec::new());
    }

    let results = parse_yt_results(&html, max_results, max_dur, verbose);
    Ok(results)
}

fn parse_yt_results(html: &str, max_results: usize, max_dur_sec: u32, verbose: bool) -> Vec<SearchResult> {
    const MARKER: &str = "var ytInitialData = ";
    let start = match html.find(MARKER) {
        Some(i) => i + MARKER.len(),
        None    => return Vec::new(),
    };

    let slice = &html[start..];
    let end = match find_json_end(slice) {
        Some(i) => i,
        None    => {
            println!("  ❌  Could not find end of ytInitialData JSON");
            return Vec::new();
        }
    };

    println!("  📊  ytInitialData JSON: {} bytes", end);

    let json: Value = match serde_json::from_str(&slice[..end]) {
        Ok(v)  => v,
        Err(e) => {
            println!("  ❌  JSON parse error: {e}");
            return Vec::new();
        }
    };

    if verbose {
        // Print top-level keys to understand structure
        if let Some(obj) = json.as_object() {
            println!("  🔑  JSON top-level keys: {}", obj.keys().take(10).cloned().collect::<Vec<_>>().join(", "));
        }
    }

    let sections = json
        .pointer("/contents/twoColumnSearchResultsRenderer/primaryContents/sectionListRenderer/contents")
        .and_then(|v| v.as_array());

    let Some(sections) = sections else {
        println!("  ⚠️   Unexpected ytInitialData structure — no sectionListRenderer");
        if verbose {
            // Try to print what we DO have
            let keys = json.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(", ")).unwrap_or_default();
            println!("  🔑  Available keys: {keys}");
        }
        return Vec::new();
    };

    println!("  📋  Sections found: {}", sections.len());

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
                        if verbose {
                            println!(
                                "    videoRenderer: \"{}\" — {}s — {} views",
                                sr.title.chars().take(60).collect::<String>(),
                                sr.duration_secs,
                                fmt_views(sr.view_count)
                            );
                        }
                        results.push(sr);
                    }
                }
            }
        }

        // Shorts shelf
        if let Some(items) = section
            .pointer("/reelShelfRenderer/items")
            .and_then(|v| v.as_array())
        {
            for item in items {
                if let Some(rr) = item.get("reelItemRenderer") {
                    if let Some(sr) = extract_reel_renderer(rr) {
                        if verbose {
                            println!(
                                "    reelItemRenderer: \"{}\" — {} views",
                                sr.title.chars().take(60).collect::<String>(),
                                fmt_views(sr.view_count)
                            );
                        }
                        results.push(sr);
                    }
                }
            }
        }
    }

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

    let title = vr
        .pointer("/title/runs/0/text")
        .or_else(|| vr.pointer("/title/simpleText"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();

    if max_dur_sec > 0 && dur_secs > max_dur_sec { return None; }

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
        duration_secs: 60,
        platform:      "youtube_shorts",
    })
}

// ── TikTok ────────────────────────────────────────────────────────────────────

async fn search_tiktok(
    query:       &str,
    max_results: usize,
    max_dur:     u32,
    verbose:     bool,
    save_html:   bool,
) -> Result<Vec<SearchResult>> {
    let client = build_stealth_client();
    let url = format!(
        "https://www.tiktok.com/search?q={}&type=video",
        url_encode(query)
    );

    println!("  🌐  GET {url}");
    let t0 = Instant::now();

    let mut headers = chrome_headers("https://www.tiktok.com/");
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ),
    );

    let resp = match client.get(&url).headers(headers).send().await {
        Ok(r)  => r,
        Err(e) => {
            println!("  ❌  Request failed: {e}");
            return Ok(Vec::new());
        }
    };

    let status = resp.status();
    let elapsed = t0.elapsed();
    println!("  ⚡  HTTP {} — {:.0}ms", status, elapsed.as_millis());

    if !status.is_success() {
        println!("  ❌  TikTok returned {} — likely Cloudflare challenge", status);
        return Ok(Vec::new());
    }

    let html = resp.text().await?;
    println!("  📦  Response: {} bytes", html.len());

    if save_html {
        let fname = format!("tiktok_search_{}.html", sanitize_filename(query));
        std::fs::write(&fname, &html)?;
        println!("  💾  HTML saved to: {fname}");
    }

    // ── Marker detection ──────────────────────────────────────────────────────
    const MARKER: &str = r#"id="__UNIVERSAL_DATA_FOR_REHYDRATION__""#;
    if html.contains(MARKER) {
        println!("  ✅  __UNIVERSAL_DATA_FOR_REHYDRATION__ found");
    } else {
        println!("  ⚠️   __UNIVERSAL_DATA_FOR_REHYDRATION__ NOT found");
        // Print first 500 chars to see what TikTok returned
        let snippet = html.chars().take(500).collect::<String>();
        println!("  📄  Page start:\n{snippet}");
        return Ok(Vec::new());
    }

    let results = parse_tiktok_results(&html, max_results, max_dur, verbose);
    Ok(results)
}

fn parse_tiktok_results(html: &str, max_results: usize, max_dur_sec: u32, verbose: bool) -> Vec<SearchResult> {
    const MARKER: &str = r#"id="__UNIVERSAL_DATA_FOR_REHYDRATION__""#;
    let tag_pos = match html.find(MARKER) {
        Some(i) => i,
        None    => return Vec::new(),
    };

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

    println!("  📊  TikTok rehydration JSON: {} bytes", json_end);

    let json: Value = match serde_json::from_str(json_slice[..json_end].trim()) {
        Ok(v)  => v,
        Err(e) => {
            println!("  ❌  JSON parse error: {e}");
            return Vec::new();
        }
    };

    if verbose {
        // Explore JSON structure
        if let Some(scope) = json.get("__DEFAULT_SCOPE__").and_then(|v| v.as_object()) {
            println!("  🔑  __DEFAULT_SCOPE__ keys: {}", scope.keys().take(10).cloned().collect::<Vec<_>>().join(", "));
        }
    }

    // Try multiple known JSON paths
    let item_list = json
        .pointer("/__DEFAULT_SCOPE__/webapp.search-result-list/data/itemList")
        .or_else(|| json.pointer("/__DEFAULT_SCOPE__/webapp.search-result-list/searchItemList"))
        .or_else(|| json.pointer("/__DEFAULT_SCOPE__/webapp.search-result-list/data/items"))
        .and_then(|v| v.as_array());

    let Some(items) = item_list else {
        // Check if TikTok returned a bot-detection page (no search scope keys)
        let scope_keys = json
            .get("__DEFAULT_SCOPE__")
            .and_then(|v| v.as_object())
            .map(|o| o.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let has_search_scope = scope_keys.iter().any(|k| k.contains("search"));

        if !has_search_scope {
            let bot_type = json
                .pointer("/__DEFAULT_SCOPE__/webapp.app-context/botType")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            println!("  ⚠️   TikTok returned bot-detection page (botType: {bot_type}) — no search data in static HTML");
            println!("       TikTok search is JS-rendered; scraper falls back to yt-dlp search (expected)");
        } else {
            println!("  ⚠️   No searchItemList found in TikTok JSON (scope keys: {})", scope_keys.join(", "));
        }
        if verbose {
            // Show what paths exist under __DEFAULT_SCOPE__
            if let Some(scope) = json.get("__DEFAULT_SCOPE__").and_then(|v| v.as_object()) {
                for (k, v) in scope.iter().take(5) {
                    let sub_keys = v.as_object().map(|o| o.keys().take(5).cloned().collect::<Vec<_>>().join(", ")).unwrap_or_default();
                    println!("    {k}: {{ {sub_keys} }}");
                }
            }
        }
        return Vec::new();
    };

    println!("  📋  Items found: {}", items.len());

    let mut results: Vec<SearchResult> = Vec::new();

    for entry in items {
        if results.len() >= max_results * 2 { break; }

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

        if verbose {
            println!(
                "    item @{author_id}: \"{title}\" — {dur_secs}s — {} plays",
                fmt_views(view_count)
            );
        }

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

// ── Output helpers ────────────────────────────────────────────────────────────

fn print_results(results: &[SearchResult], platform_label: &str) {
    if results.is_empty() {
        println!("  — No results");
        return;
    }
    println!();
    for (i, r) in results.iter().enumerate() {
        let dur_str = if r.duration_secs == 0 {
            "?s".to_owned()
        } else {
            format!("{}s", r.duration_secs)
        };
        let views = if r.view_count == 0 {
            "? views".to_owned()
        } else {
            format!("{} views", fmt_views(r.view_count))
        };
        println!(
            "  [{:>2}] [{:>15}]  [{:>6}]  {}",
            i + 1,
            views,
            dur_str,
            r.title.chars().take(70).collect::<String>()
        );
        println!("       {}", r.url);
    }
    println!();
    println!("  ✅  {} result(s) from {}", results.len(), platform_label);
}

fn fmt_views(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1}B", n as f64 / 1_000_000_000.0)
    } else if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

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

fn parse_view_count(s: &str) -> Option<u64> {
    let s = s.to_lowercase();
    let s = s
        .trim_end_matches("views")
        .trim_end_matches("view")
        .trim_end_matches("ditonton")
        .trim_end_matches("x ditonton")
        .replace([',', ' ', '\u{00a0}'], "");
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

fn find_json_end(s: &str) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape_next = false;
    for (i, c) in s.char_indices() {
        if escape_next { escape_next = false; continue; }
        if in_string {
            match c {
                '\\' => escape_next = true,
                '"'  => in_string = false,
                _    => {}
            }
        } else {
            match c {
                '"' => in_string = true,
                '{'  => depth += 1,
                '}'  => { depth -= 1; if depth == 0 { return Some(i + 1); } }
                _    => {}
            }
        }
    }
    None
}

fn url_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_owned(),
            c   => format!("%{:02X}", c as u32),
        })
        .collect()
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .take(40)
        .collect()
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let query       = &args.query;
    let platform    = args.platform.to_lowercase();
    let max_results = args.max_results;
    let max_dur     = args.max_duration;
    let verbose     = args.verbose;
    let save_html   = args.save_html;

    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║         CLIPPER Scraper Test                             ║");
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();
    println!("  Query    : \"{}\"", query);
    println!("  Platform : {}", platform);
    println!("  Max results : {max_results}  |  Max duration: {}",
        if max_dur == 0 { "unlimited".to_owned() } else { format!("{max_dur}s") });
    if verbose { println!("  Mode: VERBOSE (raw JSON paths printed)"); }

    let run_tiktok  = platform == "tiktok"  || platform == "both";
    let run_youtube = platform == "youtube" || platform == "both";

    // ── TikTok ────────────────────────────────────────────────────────────────
    if run_tiktok {
        println!();
        println!("━━━  TikTok Search  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        let t0 = Instant::now();
        match search_tiktok(query, max_results, max_dur, verbose, save_html).await {
            Ok(results) => {
                println!("  ⏱   Total: {:.0}ms", t0.elapsed().as_millis());
                print_results(&results, "TikTok");
            }
            Err(e) => println!("  ❌  Error: {e}"),
        }
    }

    // ── YouTube Shorts ────────────────────────────────────────────────────────
    if run_youtube {
        println!();
        println!("━━━  YouTube Shorts Search  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        let t0 = Instant::now();
        match search_youtube(query, max_results, max_dur, verbose, save_html).await {
            Ok(results) => {
                println!("  ⏱   Total: {:.0}ms", t0.elapsed().as_millis());
                print_results(&results, "YouTube Shorts");
            }
            Err(e) => println!("  ❌  Error: {e}"),
        }
    }

    println!();
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Done.");
    println!();
    Ok(())
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_encode() {
        assert_eq!(url_encode("harga naik 30%"), "harga+naik+30%25");
        assert_eq!(url_encode("MBG program"),    "MBG+program");
    }

    #[test]
    fn test_parse_duration() {
        assert_eq!(parse_duration_hms("0:45"),    Some(45));
        assert_eq!(parse_duration_hms("1:23"),    Some(83));
        assert_eq!(parse_duration_hms("1:23:45"), Some(5025));
    }

    #[test]
    fn test_parse_view_count() {
        assert_eq!(parse_view_count("1,234,567 views"), Some(1_234_567));
        assert_eq!(parse_view_count("2.5M views"),      Some(2_500_000));
        assert_eq!(parse_view_count("890K views"),       Some(890_000));
        assert_eq!(parse_view_count("1.2B views"),       Some(1_200_000_000));
        assert_eq!(parse_view_count("450 ditonton"),     Some(450));
    }

    #[test]
    fn test_fmt_views() {
        assert_eq!(fmt_views(1_500_000), "1.5M");
        assert_eq!(fmt_views(890_000),   "890.0K");
        assert_eq!(fmt_views(500),       "500");
    }

    #[test]
    fn test_find_json_end() {
        assert_eq!(find_json_end(r#"{"a":1};"#),              Some(7));
        assert_eq!(find_json_end(r#"{"a":{"b":2}}next"#),     Some(13));
        assert_eq!(find_json_end(r#"{"k":"val with } inside"}"#), Some(25));
    }
}
