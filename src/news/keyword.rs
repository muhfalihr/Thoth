//! Keyword extraction from a moment's transcript window.
//!
//! This is the most important step of the News stage: search keywords are derived
//! from the RAW words spoken during the moment — never from the LLM-paraphrased
//! `title`/`reason` fields, which drift away from what was actually said.

use tracing::debug;

use crate::analyze::provider::LlmProvider;

use super::error::NewsError;

/// Build the system prompt that instructs the LLM to act as a search specialist.
fn keyword_system_prompt() -> String {
    "Kamu adalah search engine specialist berpengalaman untuk media Indonesia. \
     Tugasmu: membaca teks yang diucapkan dalam sebuah video, lalu menghasilkan \
     query pencarian Google yang paling efektif untuk menemukan berita/artikel \
     Indonesia yang relevan dengan statement tersebut. Jawab HANYA dengan JSON array."
        .to_owned()
}

/// Build the user prompt embedding the transcript window + video context.
fn keyword_user_prompt(transcript_window: &str, video_title: &str, video_channel: &str, max_keywords: usize) -> String {
    format!(
        "Teks yang diucapkan dalam video:\n\"{window}\"\n\n\
         Konteks video: \"{title}\" oleh \"{channel}\"\n\n\
         Ekstrak {n} query pencarian terbaik untuk menemukan berita Indonesia yang relevan.\n\n\
         Aturan:\n\
         - Setiap query string pendek (3-6 kata) yang bisa langsung diketik di Google\n\
         - Prioritaskan aspek kontroversial, mengejutkan, atau newsworthy\n\
         - Gunakan nama orang/tokoh jika disebutkan dalam teks\n\
         - Gunakan tahun jika konteks waktu relevan\n\
         - Jangan duplikasi — tiap query cari angle berbeda\n\
         - Bahasa Indonesia (boleh campur istilah yang umum dipakai media)\n\n\
         Output JSON array saja, tanpa penjelasan apapun:\n\
         [\"query 1\", \"query 2\", \"query 3\"]",
        window = transcript_window.trim(),
        title = video_title,
        channel = video_channel,
        n = max_keywords,
    )
}

/// Extract up to `max_keywords` search queries from the transcript window.
///
/// Returns an empty Vec only when the transcript window is empty; LLM/parse
/// failures surface as `NewsError` so the caller can decide whether to degrade.
pub async fn extract_keywords(
    provider: &dyn LlmProvider,
    transcript_window: &str,
    video_title: &str,
    video_channel: &str,
    max_keywords: usize,
) -> Result<Vec<String>, NewsError> {
    let window = transcript_window.trim();
    if window.is_empty() {
        return Ok(Vec::new());
    }

    let system = keyword_system_prompt();
    let user = keyword_user_prompt(window, video_title, video_channel, max_keywords);

    let raw = provider
        .chat_completion(&system, &user)
        .await
        .map_err(|e| NewsError::Llm(e.to_string()))?;

    let keywords = parse_keyword_response(&raw);
    debug!("keyword extraction raw response: {}", raw.trim());

    Ok(keywords.into_iter().take(max_keywords).collect())
}

/// Parse the LLM response into a clean list of keyword strings.
///
/// Tolerates: code fences, leading prose, trailing prose, and a plain
/// newline-separated list as a fallback when JSON parsing fails.
pub fn parse_keyword_response(raw: &str) -> Vec<String> {
    let cleaned = strip_code_fences(raw);

    // Preferred path: locate the first JSON array and parse it.
    if let (Some(start), Some(end)) = (cleaned.find('['), cleaned.rfind(']')) {
        if end > start {
            let slice = &cleaned[start..=end];
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(slice) {
                return normalize_keywords(arr);
            }
        }
    }

    // Fallback: treat each non-empty line as a keyword.
    let lines = cleaned
        .lines()
        .map(|l| l.trim().trim_start_matches(['-', '*', '•', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', ')', ' ']))
        .map(|l| l.trim().trim_matches(['"', '\'']).to_owned())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>();
    normalize_keywords(lines)
}

/// Remove ```json ... ``` fences if present.
fn strip_code_fences(raw: &str) -> String {
    let t = raw.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // drop optional language tag on the first line, then trailing ```
        let rest = rest.splitn(2, '\n').nth(1).unwrap_or(rest);
        return rest.trim_end().trim_end_matches("```").trim().to_owned();
    }
    t.to_owned()
}

/// Trim, drop empties, dedup case-insensitively while preserving order.
fn normalize_keywords(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for it in items {
        let k = it.trim().trim_matches(['"', '\'']).to_owned();
        if k.is_empty() {
            continue;
        }
        let key = k.to_lowercase();
        if seen.insert(key) {
            out.push(k);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_json_array() {
        let raw = r#"["Prabowo orang desa dollar", "kontroversi Prabowo 2025"]"#;
        let kw = parse_keyword_response(raw);
        assert_eq!(kw.len(), 2);
        assert_eq!(kw[0], "Prabowo orang desa dollar");
    }

    #[test]
    fn parses_fenced_json_with_prose() {
        let raw = "Tentu, berikut querynya:\n```json\n[\"a query\", \"b query\"]\n```";
        let kw = parse_keyword_response(raw);
        assert_eq!(kw, vec!["a query".to_owned(), "b query".to_owned()]);
    }

    #[test]
    fn dedups_case_insensitive() {
        let raw = r#"["Prabowo", "prabowo", "Dollar"]"#;
        let kw = parse_keyword_response(raw);
        assert_eq!(kw.len(), 2);
    }

    #[test]
    fn fallback_to_line_list() {
        let raw = "1. first keyword\n2. second keyword\n- third keyword";
        let kw = parse_keyword_response(raw);
        assert_eq!(kw, vec![
            "first keyword".to_owned(),
            "second keyword".to_owned(),
            "third keyword".to_owned(),
        ]);
    }
}
