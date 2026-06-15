/// Real-time trending context: Google Trends (regional) + keyword-level trend search.
///
/// No API key required.
/// - Regional feed  : Google Trends Daily RSS  — what's hot right now in Indonesia
/// - Keyword trends : Google Trends Explore API — how trending are THIS video's topics
/// - News volume    : Google News RSS count     — how much coverage a keyword has today

use std::collections::HashMap;

// ─────────────────────────────────────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct TrendingContext {
    pub region: String,
    /// Top daily trending topics from Google Trends RSS
    pub daily_topics: Vec<TrendingTopic>,
    /// Video-specific keyword trend data
    pub keyword_trends: Vec<KeywordTrend>,
    pub fetched_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone)]
pub struct TrendingTopic {
    pub title: String,
    pub traffic: String,
}

#[derive(Debug, Clone)]
pub struct KeywordTrend {
    pub keyword: String,
    /// 0–100 interest score from Google Trends (100 = peak interest this week)
    pub interest_score: u8,
    /// Number of news articles found in the last ~24h
    pub news_count: usize,
    /// true if this keyword also appears in the daily trending feed
    pub in_daily_trends: bool,
}

impl KeywordTrend {
    /// Rough "hotness" label for the prompt.
    pub fn hotness(&self) -> &'static str {
        let s = self.interest_score;
        if self.in_daily_trends      { return "🔥 VIRAL" }
        if s >= 75 || self.news_count >= 20 { return "📈 HOT" }
        if s >= 40 || self.news_count >= 5  { return "📊 RISING" }
        if s > 0                     { return "💤 STABLE" }
        "❓ UNKNOWN"
    }
}

impl TrendingContext {
    pub fn has_data(&self) -> bool {
        !self.daily_topics.is_empty() || !self.keyword_trends.is_empty()
    }

    /// Format for the LLM prompt — two sections: regional trends + video keywords.
    pub fn as_prompt_context(&self) -> String {
        let mut parts = Vec::new();

        // Section 1: Regional daily trends
        if !self.daily_topics.is_empty() {
            let lines: Vec<String> = self.daily_topics.iter().take(12).map(|t| {
                if t.traffic.is_empty() { format!("  • {}", t.title) }
                else { format!("  • {}  ({})", t.title, t.traffic) }
            }).collect();
            parts.push(format!(
                "TOP DAILY TRENDS in {} (Google Trends, right now):\n{}",
                self.region, lines.join("\n")
            ));
        }

        // Section 2: Video-specific keyword trends
        if !self.keyword_trends.is_empty() {
            let hot: Vec<&KeywordTrend> = self.keyword_trends.iter()
                .filter(|k| k.interest_score > 0 || k.news_count > 0 || k.in_daily_trends)
                .collect();

            if !hot.is_empty() {
                let lines: Vec<String> = hot.iter().map(|k| {
                    let news = if k.news_count > 0 {
                        format!("  {} news articles today", k.news_count)
                    } else {
                        String::new()
                    };
                    format!(
                        "  {} \"{}\" — interest {}/100{}",
                        k.hotness(), k.keyword, k.interest_score, news
                    )
                }).collect();
                parts.push(format!(
                    "THIS VIDEO'S KEYWORDS — trending status:\n{}",
                    lines.join("\n")
                ));
            }
        }

        if parts.is_empty() {
            String::new()
        } else {
            parts.join("\n\n")
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main public API
// ─────────────────────────────────────────────────────────────────────────────

/// Fetch full trending context: daily trends + keyword-level analysis.
///
/// * `region`   — ISO country code, e.g. "ID"
/// * `keywords` — extracted from the video title + transcript
pub async fn fetch_trending_with_keywords(
    region: &str,
    keywords: &[String],
) -> TrendingContext {
    let region_upper = region.to_uppercase();

    // Fetch daily trends and keyword data concurrently
    let (daily, keyword_trends) = tokio::join!(
        fetch_daily_trends(&region_upper),
        fetch_keyword_trends(keywords, &region_upper),
    );

    // Mark which keywords also appear in the daily trending list
    let daily_titles_lower: Vec<String> = daily.iter()
        .map(|t| t.title.to_lowercase())
        .collect();

    let keyword_trends = keyword_trends.into_iter().map(|mut k| {
        k.in_daily_trends = daily_titles_lower.iter().any(|t|
            t.contains(&k.keyword.to_lowercase()) ||
            k.keyword.to_lowercase().split_whitespace().any(|w| t.contains(w))
        );
        k
    }).collect();

    TrendingContext {
        region: region_upper,
        daily_topics: daily,
        keyword_trends,
        fetched_at: Some(chrono::Utc::now()),
    }
}

/// Backward-compatible wrapper: daily trends only (no keyword input).
pub async fn fetch_trending(region: &str) -> TrendingContext {
    fetch_trending_with_keywords(region, &[]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword extraction — LLM-based (primary) + frequency-based (fallback)
// ─────────────────────────────────────────────────────────────────────────────

/// Extract important keywords from the video transcript using an LLM.
///
/// This is the **primary** keyword extraction method. It is semantically aware:
/// it identifies people, organisations, controversies, and newsworthy topics
/// rather than just counting word frequencies.
///
/// Returns up to `max_keywords` deduplicated keywords. Falls back to an empty
/// Vec on error — callers should then fall back to `extract_keywords()`.
///
/// The transcript is sampled to stay within reasonable token limits (≤ 3 000 chars).
pub async fn extract_keywords_llm(
    provider:      &dyn crate::analyze::provider::LlmProvider,
    title:         &str,
    channel:       &str,
    transcript_compact: &str,   // compact `[sec] text` lines from to_compact_prompt_lines()
    max_keywords:  usize,
) -> Vec<String> {
    let preview = sample_transcript(transcript_compact, 3_000);
    if preview.trim().is_empty() {
        return Vec::new();
    }

    let system = "Kamu adalah editor media sosial Indonesia yang berpengalaman. \
                  Tugasmu: membaca transcript video dan mengidentifikasi keyword terpenting. \
                  Balas HANYA dengan JSON array, tanpa penjelasan apapun.";

    let user = format!(
        "Video: \"{title}\" oleh \"{channel}\"\n\n\
         Transcript (cuplikan):\n{preview}\n\n\
         Identifikasi {max} keyword/frasa kunci terpenting dari video ini.\n\n\
         Kriteria keyword yang baik:\n\
         - Nama tokoh / pejabat / publik figur yang disebut\n\
         - Institusi / lembaga / perusahaan penting\n\
         - Topik utama yang dibahas (isu, kebijakan, peristiwa)\n\
         - Pernyataan kontroversial atau mengejutkan\n\
         - Angka / statistik penting (\"90% kasus\", \"Rp 17.000\")\n\
         - Konteks waktu/tempat jika relevan\n\n\
         Hindari: kata umum, stop words, kata yang terlalu luas (\"Indonesia\", \"video\")\n\n\
         Format: JSON array berisi string, dari yang paling penting:\n\
         [\"keyword 1\", \"keyword 2\", \"keyword 3\"]",
        title   = title,
        channel = channel,
        preview = preview,
        max     = max_keywords,
    );

    let raw = match provider.chat_completion(system, &user).await {
        Ok(r)  => r,
        Err(e) => {
            tracing::warn!("LLM keyword extraction failed: {e}");
            return Vec::new();
        }
    };

    parse_keyword_json(&raw, max_keywords)
}

/// Sample the compact transcript to at most `max_chars` characters.
///
/// Samples uniformly across the whole transcript so short/long videos are
/// represented fairly — we don't just take the beginning.
fn sample_transcript(compact: &str, max_chars: usize) -> String {
    if compact.len() <= max_chars {
        return compact.to_owned();
    }
    let lines: Vec<&str> = compact.lines().collect();
    let total = lines.len();
    if total == 0 { return String::new(); }

    // Take every N-th line to cover the whole transcript
    let step = (total as f64 / (max_chars / 60) as f64).ceil() as usize;
    let step = step.max(1);
    let sampled: String = lines
        .iter()
        .step_by(step)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

    // Hard-truncate if still over budget
    if sampled.len() > max_chars {
        sampled[..max_chars].rsplit_once('\n').map(|(l, _)| l).unwrap_or(&sampled[..max_chars]).to_owned()
    } else {
        sampled
    }
}

/// Parse the LLM response into a clean deduplicated keyword list.
/// Tolerates: JSON arrays, code fences, numbered lists.
fn parse_keyword_json(raw: &str, max: usize) -> Vec<String> {
    let cleaned = {
        let t = raw.trim();
        if let Some(rest) = t.strip_prefix("```") {
            let inner = rest.splitn(2, '\n').nth(1).unwrap_or(rest);
            inner.trim_end().trim_end_matches("```").trim()
        } else {
            t
        }
    };

    // Try JSON array first
    if let (Some(s), Some(e)) = (cleaned.find('['), cleaned.rfind(']')) {
        if e > s {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(&cleaned[s..=e]) {
                return normalize_keywords(arr, max);
            }
        }
    }

    // Fallback: numbered / bulleted lines
    let lines = cleaned
        .lines()
        .map(|l| l.trim()
            .trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | ')' | '-' | '*' | '•' | ' '))
            .trim_matches(|c: char| c == '"' || c == '\'')
        )
        .filter(|l| !l.is_empty())
        .map(|l| l.to_owned())
        .collect();
    normalize_keywords(lines, max)
}

fn normalize_keywords(items: Vec<String>, max: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out  = Vec::new();
    for kw in items {
        let k = kw.trim().trim_matches(|c: char| c == '"' || c == '\'').to_owned();
        if k.is_empty() || k.len() < 3 { continue; }
        let key = k.to_lowercase();
        if seen.insert(key) { out.push(k); }
        if out.len() >= max { break; }
    }
    out
}

/// Extract meaningful keywords from a video title and transcript text.
///
/// **Fallback method** (frequency-based). Use `extract_keywords_llm()` as the
/// primary method and call this only when the LLM call fails or is unavailable.
///
/// Strategy:
/// 1. Collect proper nouns (capitalised mid-sentence) — names, places, brands
/// 2. Find high-frequency content words (filtered by Indonesian + English stop words)
/// 3. Weight words in the title more heavily (repeat them × 3 in counting)
pub fn extract_keywords(title: &str, transcript_text: &str) -> Vec<String> {
    // Use VocabCache defaults — dynamic Supabase version loaded at startup
    // For full dynamic behavior, call extract_keywords_with_vocab(title, transcript, &cache)
    let defaults = crate::rag::VocabCache::defaults(3600);
    let stop_words: std::collections::HashSet<String> =
        defaults.stop_words_id.into_iter().chain(defaults.stop_words_en).collect();

    // Title words get triple weight (they're the most important signal)
    let weighted_text = format!("{} {} {} {}", title, title, title, transcript_text);

    // ── 1. Frequency count of all words ──────────────────────────────────────
    let mut freq: HashMap<String, usize> = HashMap::new();
    for word in weighted_text.split(|c: char| !c.is_alphanumeric()) {
        if word.len() < 3 { continue; }
        let lower = word.to_lowercase();
        if !stop_words.contains(&lower) && lower.chars().all(|c| c.is_alphabetic()) {
            *freq.entry(lower).or_insert(0) += 1;
        }
    }

    // ── 2. Collect proper nouns from title (capitalised words) ───────────────
    let mut proper_nouns: Vec<String> = Vec::new();
    for word in title.split_whitespace() {
        let trimmed = word.trim_matches(|c: char| !c.is_alphanumeric());
        if trimmed.len() >= 3
            && trimmed.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
        {
            let lower = trimmed.to_lowercase();
            if !stop_words.contains(&lower) {
                proper_nouns.push(lower.clone());
                // Boost their frequency so they rank high
                *freq.entry(lower).or_insert(0) += 10;
            }
        }
    }

    // Also extract capitalised words from the transcript (proper nouns / brands)
    for word in transcript_text.split_whitespace().take(5000) {
        let trimmed = word.trim_matches(|c: char| !c.is_alphanumeric());
        if trimmed.len() >= 3
            && trimmed.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
            && !trimmed.chars().all(|c| c.is_uppercase()) // skip ALL-CAPS
        {
            let lower = trimmed.to_lowercase();
            if !stop_words.contains(&lower) {
                *freq.entry(lower).or_insert(0) += 3;
            }
        }
    }

    // ── 3. Sort by frequency, return top 8 keywords ──────────────────────────
    let mut sorted: Vec<(String, usize)> = freq.into_iter().filter(|(_, c)| *c >= 3).collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));

    sorted.into_iter().take(8).map(|(w, _)| w).collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Trends data fetching
// ─────────────────────────────────────────────────────────────────────────────

/// Fetch daily trending topics from Google Trends RSS for the given region.
async fn fetch_daily_trends(region: &str) -> Vec<TrendingTopic> {
    let url = format!("https://trends.google.com/trending/rss?geo={region}");
    let body = http_get_text(&url).await.unwrap_or_default();
    parse_trends_rss(&body)
}

/// Fetch interest-over-time scores for a list of keywords via Google Trends Explore API.
///
/// The Explore API returns widget tokens; we then fetch widget data for the
/// "Interest over time" widget to get a 0–100 score for each keyword.
/// Falls back to news count only if the Explore API is unavailable.
async fn fetch_keyword_trends(keywords: &[String], region: &str) -> Vec<KeywordTrend> {
    if keywords.is_empty() { return Vec::new(); }

    // Batch keywords (max 5 per Trends request)
    let batch: Vec<&String> = keywords.iter().take(5).collect();

    // Build the comparison items JSON
    let items: Vec<String> = batch.iter().map(|kw| {
        format!(r#"{{"keyword":"{}","geo":"{}","time":"now 7-d"}}"#, kw, region)
    }).collect();
    let req_json = format!(
        r#"{{"comparisonItem":[{}],"category":0,"property":""}}"#,
        items.join(",")
    );
    let encoded_req = url_encode(&req_json);
    let explore_url = format!(
        "https://trends.google.com/trends/api/explore?hl=id&tz=-420&req={encoded_req}&tz=-420"
    );

    // Try to get interest scores from Trends Explore API
    let mut scores: HashMap<String, u8> = HashMap::new();
    if let Some(body) = http_get_text(&explore_url).await {
        scores = parse_explore_scores(&body, &batch);
    }

    // Fetch news article counts concurrently for each keyword
    let news_futs: Vec<_> = batch.iter().map(|kw| {
        let kw = kw.to_string();
        let region = region.to_owned();
        async move {
            let count = fetch_news_count(&kw, &region).await;
            (kw, count)
        }
    }).collect();

    let news_counts: HashMap<String, usize> = futures_util::future::join_all(news_futs)
        .await
        .into_iter()
        .collect();

    batch.iter().map(|kw| {
        KeywordTrend {
            keyword: kw.to_string(),
            interest_score: *scores.get(kw.as_str()).unwrap_or(&0),
            news_count: *news_counts.get(kw.as_str()).unwrap_or(&0),
            in_daily_trends: false, // set by caller after matching
        }
    }).collect()
}

/// Count recent news articles for a keyword via Google News RSS.
async fn fetch_news_count(keyword: &str, region: &str) -> usize {
    let ceid = format!("{}:id", region); // e.g. "ID:id"
    let encoded = url_encode(keyword);
    let url = format!(
        "https://news.google.com/rss/search?q={encoded}&hl=id&gl={region}&ceid={ceid}"
    );
    let body = http_get_text(&url).await.unwrap_or_default();
    // Count <item> occurrences — each is one article
    body.matches("<item>").count()
}

/// Parse the interest score for each keyword from the Trends Explore API response.
///
/// The response is prefixed with `)]}',\n` then JSON.
/// We look for the "averages" array in the TIMESERIES widget.
fn parse_explore_scores(body: &str, keywords: &[&String]) -> HashMap<String, u8> {
    // Strip the anti-JSON hijacking prefix
    let json_start = body.find('[').or_else(|| body.find('{'));
    let json_str = match json_start {
        Some(i) => &body[i..],
        None    => return HashMap::new(),
    };

    // The JSON contains an array of widgets. Find the TIMESERIES widget.
    // Each keyword has a "request.comparisonItem[N].keyword" → we match by position.
    // The "averages" field gives the overall score (0-100).
    let mut scores = HashMap::new();

    // Simple approach: extract all "averages": [n] from the JSON
    let mut search = json_str;
    let mut idx = 0;
    while let Some(pos) = search.find("\"averages\"") {
        let after = &search[pos + 10..];
        // Find the array of numbers
        if let Some(arr_start) = after.find('[') {
            let arr = &after[arr_start + 1..];
            if let Some(arr_end) = arr.find(']') {
                // Parse all numbers, take the max as the "interest score"
                let max_score = arr[..arr_end]
                    .split(',')
                    .filter_map(|n| n.trim().parse::<u8>().ok())
                    .max()
                    .unwrap_or(0);

                if idx < keywords.len() {
                    scores.insert(keywords[idx].to_string(), max_score);
                    idx += 1;
                }
            }
        }
        search = &search[pos + 10..];
    }

    scores
}

// ─────────────────────────────────────────────────────────────────────────────
// RSS parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

fn parse_trends_rss(xml: &str) -> Vec<TrendingTopic> {
    let mut topics = Vec::new();
    for item in xml.split("<item>").skip(1) {
        let title   = extract_tag(item, "title").unwrap_or_default();
        let traffic = extract_tag(item, "ht:approx_traffic").unwrap_or_default();
        if !title.is_empty() {
            topics.push(TrendingTopic {
                title: decode_html_entities(&title),
                traffic: traffic.trim().to_owned(),
            });
        }
    }
    topics
}

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open  = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let rest  = &xml[start..];
    let end   = rest.find(&close)?;
    let raw   = rest[..end].trim();
    let clean = raw
        .trim_start_matches("<![CDATA[")
        .trim_end_matches("]]>")
        .trim();
    if clean.is_empty() { None } else { Some(clean.to_owned()) }
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;",  "&")
     .replace("&lt;",   "<")
     .replace("&gt;",   ">")
     .replace("&quot;", "\"")
     .replace("&#39;",  "'")
     .replace("&apos;", "'")
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

async fn http_get_text(url: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .ok()?;
    let resp = client.get(url).send().await.ok()?;
    if resp.status().is_success() { resp.text().await.ok() } else { None }
}

fn url_encode(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        ' ' => "+".to_owned(),
        _   => format!("%{:02X}", c as u32),
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_array() {
        let raw = r#"["Prabowo dollar", "rupiah melemah", "ekonomi rakyat desa"]"#;
        let kw = parse_keyword_json(raw, 10);
        assert_eq!(kw.len(), 3);
        assert_eq!(kw[0], "Prabowo dollar");
    }

    #[test]
    fn parse_fenced_json() {
        let raw = "```json\n[\"keyword A\", \"keyword B\"]\n```";
        let kw = parse_keyword_json(raw, 10);
        assert_eq!(kw, vec!["keyword A", "keyword B"]);
    }

    #[test]
    fn parse_numbered_list_fallback() {
        let raw = "1. Prabowo desa\n2. Dollar AS\n3. Rupiah melemah";
        let kw = parse_keyword_json(raw, 10);
        assert_eq!(kw, vec!["Prabowo desa", "Dollar AS", "Rupiah melemah"]);
    }

    #[test]
    fn respects_max_keywords() {
        let raw = r#"["prabowo", "dollar", "rupiah", "inflasi", "desa", "ekonomi", "rakyat", "jakarta", "anggaran", "korupsi", "nilai tukar"]"#;
        let kw = parse_keyword_json(raw, 5);
        assert_eq!(kw.len(), 5);
    }

    #[test]
    fn deduplicates_case_insensitive() {
        let raw = r#"["prabowo", "Prabowo", "PRABOWO", "dollar"]"#;
        let kw = parse_keyword_json(raw, 10);
        assert_eq!(kw.len(), 2);
    }

    #[test]
    fn sample_transcript_short_unchanged() {
        let t = "[1] hello world\n[2] foo bar";
        assert_eq!(sample_transcript(t, 1000), t);
    }

    #[test]
    fn sample_transcript_long_truncated() {
        let long = (0..200).map(|i| format!("[{}] kata-kata panjang sekali\n", i)).collect::<String>();
        let result = sample_transcript(&long, 500);
        assert!(result.len() <= 550, "sampled len {} > 550", result.len());
    }
}
