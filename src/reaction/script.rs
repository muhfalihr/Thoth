//! LLM-based reaction script generation.
//!
//! Generates a natural, energetic reaction script (15–25 seconds) based on:
//!   - The raw transcript text of the viral moment
//!   - Related news articles found during search
//!   - Moment metadata (viral_type, emotional_trigger, energy)

use crate::analyze::provider::LlmProvider;
use crate::analyze::schema::ViralMoment;
use crate::news::model::NewsItem;

use super::error::ReactionError;
use super::model::{tone_guide_for, ReactionScript};

const SCRIPT_SYSTEM: &str = "\
Kamu adalah host/kreator konten Indonesia yang energetik, jujur, dan spontan. \
Tugasmu: membuat script reaksi singkat dan natural terhadap sebuah pernyataan viral. \
Balas HANYA dengan JSON, tanpa penjelasan apapun di luar JSON.";

pub async fn generate_script(
    provider: &dyn LlmProvider,
    moment: &ViralMoment,
    transcript_window: &str,
    news: &[NewsItem],
    language: &str,
    script_style: &str,
    max_secs: u32,
) -> Result<ReactionScript, ReactionError> {
    let user = build_prompt(moment, transcript_window, news, language, script_style, max_secs);
    let raw = provider
        .chat_completion(SCRIPT_SYSTEM, &user)
        .await
        .map_err(|e| ReactionError::Llm(e.to_string()))?;

    parse_script_response(&raw)
}

fn build_prompt(
    moment: &ViralMoment,
    transcript_window: &str,
    news: &[NewsItem],
    language: &str,
    script_style: &str,
    max_secs: u32,
) -> String {
    let (tone_desc, opener_example) = tone_guide_for(&moment.viral_type);
    let effective_tone = if script_style == "auto" || script_style.is_empty() {
        tone_desc.to_owned()
    } else {
        script_style.to_owned()
    };

    let news_context = if news.is_empty() {
        "Belum ada berita terkait ditemukan.".to_owned()
    } else {
        news.iter().take(3).enumerate().map(|(i, n)| {
            format!("{}. {} ({})", i + 1,
                n.title,
                n.source.chars().take(30).collect::<String>()
            )
        }).collect::<Vec<_>>().join("\n")
    };

    format!(
        "Aku sedang mereact pernyataan ini yang diucapkan dalam video:\n\
         \"{transcript}\"\n\n\
         Berita terkait yang ditemukan:\n{news}\n\n\
         Viral type: {vtype} | Emotional trigger: {etrigger} | Energy: {energy}\n\n\
         Buat script reaksi NATURAL dalam bahasa {lang} ({tone_desc} tone) yang:\n\
         - Maksimal {max_secs} detik jika dibaca ({words} kata)\n\
         - Langsung ke point — tidak ada basa-basi pembuka\n\
         - Ekspresikan reaksi sesuai tone: {tone_desc}\n\
         - Hubungkan dengan berita terkait jika relevan\n\
         - Akhiri dengan 1 pertanyaan/ajakan ke penonton\n\
         - Contoh pembuka: \"{opener}\"\n\n\
         Output JSON:\n\
         {{\"script\": \"...\", \"tone\": \"{tone_desc}\", \
         \"duration_estimate_secs\": {max_secs}, \
         \"suggested_avatar_expression\": \"surprised|serious|laughing|concerned|nodding\"}}",
        transcript    = transcript_window.trim(),
        news          = news_context,
        vtype         = moment.viral_type,
        etrigger      = moment.emotional_trigger,
        energy        = moment.energy,
        lang          = language,
        tone_desc     = effective_tone,
        max_secs      = max_secs,
        words         = max_secs * 3,  // ~3 kata/detik untuk bahasa Indonesia
        opener        = opener_example,
    )
}

fn parse_script_response(raw: &str) -> Result<ReactionScript, ReactionError> {
    let cleaned = strip_code_fences(raw);
    let json = cleaned
        .find('{')
        .and_then(|s| cleaned.rfind('}').map(|e| &cleaned[s..=e]))
        .unwrap_or(cleaned.trim());

    let script: ReactionScript = serde_json::from_str(json)
        .map_err(|e| ReactionError::InvalidJson(format!("{e}: {json}")))?;

    if !script.is_valid() {
        return Err(ReactionError::InvalidJson(
            "script too short (< 5 words)".to_owned()
        ));
    }
    Ok(script)
}

fn strip_code_fences(raw: &str) -> &str {
    let t = raw.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest.splitn(2, '\n').nth(1).unwrap_or(rest);
        return rest.trim_end().trim_end_matches("```").trim();
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_script_json() {
        let raw = r#"{"script":"Ini gila banget! Prabowo bilang orang desa gak pakai dollar. Menurut kamu gimana?","tone":"shocked","duration_estimate_secs":8,"suggested_avatar_expression":"surprised"}"#;
        let s = parse_script_response(raw).unwrap();
        assert!(s.is_valid());
        assert_eq!(s.tone, "shocked");
    }

    #[test]
    fn parses_fenced_json() {
        let raw = "```json\n{\"script\":\"Jadi gini guys, ini beneran terjadi dan mengejutkan banget!\",\"tone\":\"informative\",\"duration_estimate_secs\":5,\"suggested_avatar_expression\":\"nodding\"}\n```";
        let s = parse_script_response(raw).unwrap();
        assert!(s.is_valid());
        assert_eq!(s.tone, "informative");
    }
}
