use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::AppConfig;
use crate::pipeline::job::JobContext;
use crate::transcribe::model::Transcript;
use crate::util::progress::{spinner, stage_done};

use super::error::AnalyzeError;
use super::prompt::{retry_system_prompt, system_prompt, user_prompt};
use super::provider::{GroqProvider, LlmProvider, OllamaProvider, OpenAiProvider};
use super::schema::{ViralMoment, ViralMomentList};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeResult {
    pub moments_path: PathBuf,
    pub moment_count: usize,
    pub provider_used: String,
    pub model_used: String,
    pub completed_at: DateTime<Utc>,
}

pub struct AnalyzeService<'a> {
    config: &'a AppConfig,
    job: &'a JobContext,
}

impl<'a> AnalyzeService<'a> {
    pub fn new(config: &'a AppConfig, job: &'a JobContext) -> Self {
        Self { config, job }
    }

    pub async fn run(
        &self,
        transcript_path: &Path,
        provider_name: &str,
        max_clips: usize,
    ) -> Result<AnalyzeResult, AnalyzeError> {
        let t0 = Instant::now();
        let provider = self.build_provider(provider_name)?;

        // Load transcript
        let raw = tokio::fs::read_to_string(transcript_path)
            .await
            .map_err(AnalyzeError::Io)?;
        let transcript: Transcript =
            serde_json::from_str(&raw).map_err(|e| AnalyzeError::InvalidJson { retries: 0, source: e })?;

        let segment_count = transcript.segments.len();
        let duration_secs = transcript.duration_ms as f64 / 1000.0;
        let duration_mins = duration_secs / 60.0;

        info!(
            "loaded transcript: {} segments, {:.1} min",
            segment_count, duration_mins
        );

        // Heuristic: if > 400 segments or > 15 mins, process in chunks to avoid token limits
        let moments = if segment_count > 400 || duration_mins > 15.0 {
            info!("transcript is large, analyzing in overlapping chunks…");
            self.analyze_in_chunks(&*provider, &transcript, max_clips)
                .await?
        } else {
            let prompt_lines = transcript.to_prompt_lines();
            let sys = system_prompt(max_clips);
            let usr = user_prompt("Video", duration_secs, &prompt_lines, max_clips);

            let pb = spinner(&format!(
                "Sending transcript to {} ({})…",
                provider.name(),
                provider.model()
            ));
            let raw_response = provider.chat_completion(&sys, &usr).await?;
            pb.finish_and_clear();

            self.parse_with_retry(&*provider, &raw_response, max_clips, duration_secs)
                .await?
        };

        if moments.moments.is_empty() {
            return Err(AnalyzeError::NoMomentsFound);
        }

        info!("identified {} viral moments:", moments.moments.len());
        for (i, m) in moments.moments.iter().enumerate() {
            info!(
                "  [{}/{}] [{}] \"{}\"",
                i + 1, moments.moments.len(),
                m.viral_type.to_uppercase(),
                m.title,
            );
            info!(
                "        ⏱  {:.1}s – {:.1}s  ({:.0}s)  energy={}",
                m.start_sec, m.end_sec, m.duration(), m.energy
            );
            info!("        🪝  Hook: {}", m.hook);
            info!("        📝  Caption: {}", m.caption.lines().next().unwrap_or(""));
        }

        let moments_path = self.job.moments_path();
        let json = serde_json::to_string_pretty(&moments).map_err(|e| {
            AnalyzeError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        })?;
        tokio::fs::write(&moments_path, json)
            .await
            .map_err(AnalyzeError::Io)?;

        stage_done("Analyze", t0.elapsed());

        Ok(AnalyzeResult {
            moments_path,
            moment_count: moments.moments.len(),
            provider_used: provider.name().to_owned(),
            model_used: provider.model().to_owned(),
            completed_at: Utc::now(),
        })
    }

    async fn analyze_in_chunks(
        &self,
        provider: &dyn LlmProvider,
        transcript: &Transcript,
        max_clips: usize,
    ) -> Result<ViralMomentList, AnalyzeError> {
        let chunk_size_secs = 300.0; // 5 minutes (reduced from 10 to fit TPM limits)
        let overlap_secs = 60.0;     // 1 minute overlap
        let total_duration = transcript.duration_ms as f64 / 1000.0;

        let mut all_moments = Vec::new();
        let mut start = 0.0;

        while start < total_duration {
            let end = (start + chunk_size_secs).min(total_duration);
            let chunk_transcript = self.get_transcript_window(transcript, start, end);
            
            if !chunk_transcript.is_empty() {
                // Ask for roughly proportional number of clips, or at least 2
                let clips_per_chunk = (max_clips / 2).max(2);
                
                info!("  analyzing chunk: {:.0}s – {:.0}s…", start, end);
                
                let sys = system_prompt(clips_per_chunk);
                let usr = user_prompt("Video Segment", end - start, &chunk_transcript, clips_per_chunk);

                // Retry logic for rate limits
                let mut retries = 0;
                let max_api_retries = 5;
                let raw = loop {
                    match provider.chat_completion(&sys, &usr).await {
                        Ok(res) => break res,
                        Err(e) if retries < max_api_retries && e.to_string().contains("429") => {
                            retries += 1;
                            let err_msg = e.to_string();
                            
                            // Check if it's a Daily Limit (TPD) vs a Minute Limit (TPM)
                            if err_msg.contains("tokens per day") || err_msg.contains("TPD") {
                                return Err(AnalyzeError::ApiError {
                                    provider: provider.name().to_owned(),
                                    message: format!(
                                        "Daily Token Limit reached! Groq free tier is limited. \n\
                                         Suggestions:\n\
                                         1. Use Ollama: --provider ollama\n\
                                         2. Use a smaller model in config.toml (e.g., llama-3.1-8b-instant)\n\
                                         Original error: {}", err_msg
                                    ),
                                });
                            }

                            let wait_sec = 15 * retries;
                            warn!("Rate limit hit (429), retrying in {}s... (Attempt {}/{})", wait_sec, retries, max_api_retries);
                            tokio::time::sleep(tokio::time::Duration::from_secs(wait_sec)).await;
                        }
                        Err(e) => return Err(e),
                    }
                };

                let mut moments = self.parse_with_retry(provider, &raw, clips_per_chunk, total_duration).await?;
                all_moments.append(&mut moments.moments);

                // Mandatory small delay between chunks to be nice to the API
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            }

            if end >= total_duration {
                break;
            }
            start += chunk_size_secs - overlap_secs;
        }

        // De-duplicate moments that are very close (overlap)
        all_moments.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap());
        let mut unique_moments: Vec<ViralMoment> = Vec::new();
        for m in all_moments {
            let is_duplicate = unique_moments.iter().any(|existing| {
                (m.start_sec - existing.start_sec).abs() < 10.0 && 
                (m.end_sec - existing.end_sec).abs() < 10.0
            });
            if !is_duplicate {
                unique_moments.push(m);
            }
        }

        // Final sort by viral potential (energy "high" first, then "medium")
        unique_moments.sort_by(|a, b| {
            let score = |m: &ViralMoment| match m.energy.to_lowercase().as_str() {
                "high" => 3,
                "medium" => 2,
                _ => 1,
            };
            score(b).cmp(&score(a))
        });

        // Limit to requested max_clips
        unique_moments.truncate(max_clips);

        Ok(ViralMomentList { moments: unique_moments })
    }

    fn get_transcript_window(&self, transcript: &Transcript, start_sec: f64, end_sec: f64) -> String {
        let start_ms = (start_sec * 1000.0) as i64;
        let end_ms = (end_sec * 1000.0) as i64;
        
        transcript.segments.iter()
            .filter(|s| s.start_ms >= start_ms && s.start_ms < end_ms)
            .map(|s| {
                // Use compact format [sec] text to save tokens
                format!(
                    "[{}] {}",
                    s.start_ms / 1000,
                    s.text.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    async fn parse_with_retry(
        &self,
        provider: &dyn LlmProvider,
        raw: &str,
        max_clips: usize,
        duration_secs: f64,
    ) -> Result<ViralMomentList, AnalyzeError> {
        let cleaned = strip_markdown_fences(raw);

        match serde_json::from_str::<ViralMomentList>(&cleaned) {
            Ok(mut list) => {
                validate_and_clamp(&mut list, duration_secs);
                return Ok(list);
            }
            Err(first_err) => {
                warn!("LLM returned invalid JSON, retrying: {first_err}");
            }
        }

        // Retry with stricter prompt
        let retry_sys = retry_system_prompt(max_clips);
        let retry_usr = format!("Previous invalid response:\n{raw}\n\nPlease fix it and return only JSON.");

        let pb = spinner("Retrying analysis (fixing JSON)…");
        let retry_raw = provider.chat_completion(&retry_sys, &retry_usr).await?;
        pb.finish_and_clear();

        let cleaned2 = strip_markdown_fences(&retry_raw);
        let mut list = serde_json::from_str::<ViralMomentList>(&cleaned2).map_err(|e| {
            AnalyzeError::InvalidJson { retries: 2, source: e }
        })?;
        validate_and_clamp(&mut list, duration_secs);
        Ok(list)
    }

    fn build_provider(&self, name: &str) -> Result<Box<dyn LlmProvider>, AnalyzeError> {
        match name {
            "openai" => {
                if self.config.llm.openai_api_key.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "openai".to_owned(),
                        message: "CLIPPER_OPENAI_API_KEY is not set".to_owned(),
                    });
                }
                Ok(Box::new(OpenAiProvider::new(
                    self.config.llm.openai_api_key.clone(),
                    self.config.llm.openai_model.clone(),
                )))
            }
            "ollama" => Ok(Box::new(OllamaProvider::new(
                self.config.llm.ollama_base_url.clone(),
                self.config.llm.ollama_model.clone(),
            ))),
            _ => {
                if self.config.llm.groq_api_key.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "groq".to_owned(),
                        message: "CLIPPER_GROQ_API_KEY is not set".to_owned(),
                    });
                }
                Ok(Box::new(GroqProvider::new(
                    self.config.llm.groq_api_key.clone(),
                    self.config.llm.groq_model.clone(),
                )))
            }
        }
    }
}

fn strip_markdown_fences(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("```json").unwrap_or(s);
    let s = s.strip_prefix("```").unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s);
    s.trim().to_owned()
}

const MIN_CLIP_SECS: f64 = 30.0;
const MAX_CLIP_SECS: f64 = 90.0;

fn validate_and_clamp(list: &mut ViralMomentList, duration_secs: f64) {
    for m in &mut list.moments {
        m.start_sec = m.start_sec.max(0.0).min(duration_secs);
        m.end_sec   = m.end_sec.max(0.0).min(duration_secs);

        // Enforce minimum 30 s — clips shorter than this rarely retain viewers
        if m.end_sec - m.start_sec < MIN_CLIP_SECS {
            m.end_sec = (m.start_sec + MIN_CLIP_SECS).min(duration_secs);
        }
        // Enforce maximum 90 s — beyond this, completion rate drops sharply
        if m.end_sec - m.start_sec > MAX_CLIP_SECS {
            m.end_sec = m.start_sec + MAX_CLIP_SECS;
        }
    }
}
