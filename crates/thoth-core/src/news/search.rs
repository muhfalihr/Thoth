//! Internet news search per keyword + relevance scoring.
//!
//! Two backends are supported, selected by `config.news.provider`:
//!   - `"playwright"` (default): runs an external Python + Playwright script
//!     (`scripts/news/news_search.py`) that scrapes Google News — no paid API key.
//!   - `"serper"`: Serper.dev `/news` endpoint (requires `THOTH_SERPER_API_KEY`).
//!
//! Results are normalized into [`NewsItem`]s; the caller aggregates across
//! keywords, deduplicates by URL, scores relevance, and keeps the top N.

use std::collections::HashSet;
use std::time::Duration; // masih dipakai oleh search_serper timeout

use serde::Deserialize;
use tracing::{debug, warn};

use crate::config::NewsConfig;
use crate::execution::JobExecutionContext;

use super::error::NewsError;
use super::model::{NewsItem, RawSearchResult};
use super::util::{python_command, run_command};

/// JSON envelope emitted by `scripts/news/news_search.py` (`{"results": [...]}`).
#[derive(Debug, Deserialize, Default)]
struct SearchEnvelope {
    #[serde(default)]
    results: Vec<RawSearchResult>,
    #[serde(default)]
    error: Option<String>,
}

/// Search the internet for one keyword and return normalized news items.
///
/// Errors are returned so the caller can log + degrade per keyword without
/// aborting the whole moment.
pub async fn search_by_keyword(
    execution: &JobExecutionContext,
    config: &NewsConfig,
    keyword: &str,
) -> Result<Vec<NewsItem>, NewsError> {
    search_keywords(execution, config, std::slice::from_ref(&keyword.to_owned())).await
}

/// Search several keywords at once. For the Playwright backend this reuses a
/// single browser session across all queries (one subprocess) — far cheaper than
/// launching a browser per keyword. Each result is tagged with its originating
/// query via [`RawSearchResult::query`].
pub async fn search_keywords(
    execution: &JobExecutionContext,
    config: &NewsConfig,
    keywords: &[String],
) -> Result<Vec<NewsItem>, NewsError> {
    if keywords.is_empty() {
        return Ok(Vec::new());
    }
    let raws = match config.provider.as_str() {
        "serper" => {
            let mut all = Vec::new();
            for kw in keywords {
                match search_serper(config, kw).await {
                    Ok(mut r) => {
                        for item in &mut r {
                            item.query.get_or_insert_with(|| kw.clone());
                        }
                        all.append(&mut r);
                    }
                    Err(e) => warn!("serper search failed for \"{kw}\": {e}"),
                }
            }
            all
        }
        _ => search_playwright(execution, config, keywords).await?,
    };
    Ok(raws
        .into_iter()
        .filter(|r| !r.url.is_empty())
        .map(|r| NewsItem::from_raw(r, ""))
        .collect())
}

/// Run the Python + Playwright search script as a subprocess for one or more queries.
async fn search_playwright(
    execution: &JobExecutionContext,
    config: &NewsConfig,
    keywords: &[String],
) -> Result<Vec<RawSearchResult>, NewsError> {
    let max = config.max_results_per_moment.max(3).to_string();
    let timeout_arg = config.screenshot_timeout_secs.to_string();

    let mut cmd = python_command(config, &config.search_script.clone())?;
    for kw in keywords {
        cmd.arg("--query").arg(kw);
    }
    cmd.arg("--region").arg(&config.region)
        .arg("--lang").arg(&config.language)
        .arg("--max").arg(&max)
        .arg("--timeout").arg(&timeout_arg);

    debug!("news search (playwright): {} quer(ies)", keywords.len());

    // Hard cap: per-query timeout × number of queries + 15s for browser startup/teardown.
    let n = keywords.len().max(1) as u64;
    let timeout = config.screenshot_timeout_secs * n + 15;
    let stdout = run_command(execution, cmd, "search_playwright", timeout).await?;
    parse_envelope(&stdout)
}

/// Parse the JSON envelope printed by the search script (last JSON object on stdout).
fn parse_envelope(stdout: &str) -> Result<Vec<RawSearchResult>, NewsError> {
    let trimmed = stdout.trim();
    // The script prints a single JSON object; tolerate leading log lines by
    // scanning for the first '{'.
    let json = match trimmed.find('{') {
        Some(i) => &trimmed[i..],
        None => return Err(NewsError::InvalidJson(format!("no JSON in output: {trimmed}"))),
    };
    let env: SearchEnvelope =
        serde_json::from_str(json).map_err(|e| NewsError::InvalidJson(format!("{e}: {json}")))?;
    if let Some(err) = env.error {
        return Err(NewsError::Search(err));
    }
    Ok(env.results)
}

/// Serper.dev `/news` search backend.
async fn search_serper(config: &NewsConfig, keyword: &str) -> Result<Vec<RawSearchResult>, NewsError> {
    if config.serper_api_key.is_empty() {
        return Err(NewsError::Search("THOTH_SERPER_API_KEY is not set".to_owned()));
    }

    #[derive(Deserialize)]
    struct SerperNews {
        #[serde(default)]
        news: Vec<SerperItem>,
    }
    #[derive(Deserialize)]
    struct SerperItem {
        #[serde(default)]
        title: String,
        #[serde(default)]
        link: String,
        #[serde(default)]
        snippet: String,
        #[serde(default)]
        source: String,
        #[serde(default)]
        date: Option<String>,
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "q": keyword,
        "gl": config.region.to_lowercase(),
        "hl": config.language,
        "num": config.max_results_per_moment.max(5),
    });
    let resp = client
        .post("https://google.serper.dev/news")
        .header("X-API-KEY", &config.serper_api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(config.screenshot_timeout_secs))
        .send()
        .await?
        .error_for_status()?
        .json::<SerperNews>()
        .await?;

    Ok(resp
        .news
        .into_iter()
        .map(|i| RawSearchResult {
            url: i.link,
            title: i.title,
            snippet: i.snippet,
            source: i.source,
            published: i.date,
            query: None,
        })
        .collect())
}

// ── Aggregation, dedup, ranking ────────────────────────────────────────────────

/// Deduplicate by normalized URL, keeping the first occurrence.
pub fn dedup_by_url(items: &mut Vec<NewsItem>) {
    let mut seen = HashSet::new();
    items.retain(|i| seen.insert(normalize_url(&i.url)));
}

fn normalize_url(url: &str) -> String {
    url.trim()
        .trim_end_matches('/')
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_lowercase()
}

/// Score an article's relevance to the moment's transcript window (0.0–1.0).
///
/// `keyword_overlap * 0.60 + freshness * 0.25 + source_credibility * 0.15`,
/// with a small bonus for preferred sources.
pub fn score_relevance(item: &NewsItem, transcript_window: &str, preferred_sources: &[String]) -> f32 {
    let haystack = format!("{} {}", item.title, item.summary);
    let overlap = word_overlap_ratio(&haystack, transcript_window);
    let freshness = freshness_score(item.published_at.as_deref());
    let mut credibility = source_credibility_score(&item.source, &item.url);

    if !preferred_sources.is_empty() {
        let url_l = item.url.to_lowercase();
        let src_l = item.source.to_lowercase();
        if preferred_sources
            .iter()
            .any(|p| url_l.contains(&p.to_lowercase()) || src_l.contains(&p.to_lowercase()))
        {
            credibility = (credibility + 0.3).min(1.0);
        }
    }

    (overlap * 0.60 + freshness * 0.25 + credibility * 0.15).clamp(0.0, 1.0)
}

/// Fraction of meaningful transcript words that appear in `text`.
fn word_overlap_ratio(text: &str, transcript_window: &str) -> f32 {
    let text_tokens: HashSet<String> = tokenize(text).into_iter().collect();
    let window_tokens = tokenize(transcript_window);
    let meaningful: Vec<&String> = window_tokens.iter().filter(|w| w.len() >= 4).collect();
    if meaningful.is_empty() {
        return 0.0;
    }
    let hits = meaningful.iter().filter(|w| text_tokens.contains(**w)).count();
    hits as f32 / meaningful.len() as f32
}

fn tokenize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_owned())
        .collect()
}

/// Rough freshness score. Without a parseable date we return a neutral 0.5 so an
/// undated-but-relevant article isn't unfairly penalised.
fn freshness_score(published: Option<&str>) -> f32 {
    let Some(p) = published else { return 0.5 };
    // Try RFC3339 / ISO-8601 first.
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(p.trim()) {
        let days = (chrono::Utc::now() - dt.with_timezone(&chrono::Utc)).num_days();
        return days_to_score(days);
    }
    // Common Indonesian relative phrasing from Google News ("2 jam lalu", "kemarin").
    let lower = p.to_lowercase();
    if lower.contains("menit") || lower.contains("jam") || lower.contains("baru") {
        1.0
    } else if lower.contains("kemarin") || lower.contains("hari") {
        0.8
    } else if lower.contains("minggu") {
        0.6
    } else if lower.contains("bulan") {
        0.3
    } else {
        0.5
    }
}

fn days_to_score(days: i64) -> f32 {
    match days {
        d if d <= 1 => 1.0,
        d if d <= 3 => 0.85,
        d if d <= 7 => 0.7,
        d if d <= 14 => 0.55,
        d if d <= 30 => 0.4,
        _ => 0.2,
    }
}

/// Credibility of well-known Indonesian outlets (0.0–1.0). Falls back to 0.4.
fn source_credibility_score(source: &str, url: &str) -> f32 {
    let hay = format!("{} {}", source.to_lowercase(), url.to_lowercase());
    const TIER1: [&str; 10] = [
        "kompas", "cnnindonesia", "detik", "tempo", "antaranews",
        "liputan6", "tribunnews", "republika", "kontan", "bbc",
    ];
    const TIER2: [&str; 8] = [
        "okezone", "suara", "merdeka", "kumparan", "tirto", "katadata", "idntimes", "viva",
    ];
    if TIER1.iter().any(|s| hay.contains(s)) {
        1.0
    } else if TIER2.iter().any(|s| hay.contains(s)) {
        0.7
    } else {
        0.4
    }
}

/// Whether the article passes the `max_age_days` filter (0 = no filter).
pub fn within_max_age(item: &NewsItem, max_age_days: u32) -> bool {
    if max_age_days == 0 {
        return true;
    }
    let Some(p) = item.published_at.as_deref() else { return true };
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(p.trim()) {
        let days = (chrono::Utc::now() - dt.with_timezone(&chrono::Utc)).num_days();
        return days <= max_age_days as i64;
    }
    // Undated or relative — keep it; freshness scoring already de-prioritises old text.
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, url: &str, source: &str) -> NewsItem {
        NewsItem {
            url: url.into(),
            title: title.into(),
            summary: String::new(),
            source: source.into(),
            published_at: None,
            matched_keyword: String::new(),
            relevance_score: 0.0,
            screenshot_path: None,
            formatted_screenshot_path: None,
        }
    }

    #[test]
    fn dedup_collapses_same_url_variants() {
        let mut v = vec![
            item("a", "https://kompas.com/x", "Kompas"),
            item("b", "https://kompas.com/x/", "Kompas"),
            item("c", "https://kompas.com/x?utm=1", "Kompas"),
            item("d", "https://detik.com/y", "Detik"),
        ];
        dedup_by_url(&mut v);
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn overlap_rewards_shared_words() {
        let r = word_overlap_ratio(
            "Prabowo bicara soal orang desa dan dollar",
            "orang desa tidak pakai dollar beli beras",
        );
        assert!(r > 0.4, "overlap was {r}");
    }

    #[test]
    fn tier1_source_scores_high() {
        assert_eq!(source_credibility_score("CNN Indonesia", "https://cnnindonesia.com/a"), 1.0);
        assert_eq!(source_credibility_score("Random Blog", "https://blog.example/a"), 0.4);
    }
}
