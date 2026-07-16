//! Stage 4 orchestration: enrich every viral moment with internet news.
//!
//! Moments are processed sequentially; within each moment all keywords are
//! searched in a single batched browser session (see [`search::search_keywords`]).
//! This bounds resource use (at most one headless browser at a time) while still
//! amortising browser startup across a moment's keywords.

use std::cmp::Ordering;
use std::path::Path;

use tracing::{info, warn};

use crate::analyze::provider::build_llm_provider;
use crate::analyze::schema::ViralMomentList;
use crate::config::AppConfig;
use crate::execution::JobExecutionContext;
use crate::pipeline::job::JobContext;
use crate::transcribe::model::Transcript;

use crate::config::AvatarMode;
use crate::reaction;

use super::error::NewsError;
use super::formatter::{format_screenshot, FormatParams};
use super::model::{EnrichResult, MomentEnrichment};
use super::scraper;
use super::{keyword, search};

pub struct EnrichService<'a> {
    config: &'a AppConfig,
    job: &'a JobContext,
    execution: &'a JobExecutionContext,
}

impl<'a> EnrichService<'a> {
    pub fn new(
        config: &'a AppConfig,
        job: &'a JobContext,
        execution: &'a JobExecutionContext,
    ) -> Self {
        Self { config, job, execution }
    }

    /// Run the enrichment stage and persist `enrich/enrich.json`.
    ///
    /// `provider_name` selects the LLM used for keyword extraction and reaction
    /// script generation. News search uses `config.news.provider`.
    pub async fn run(
        &self,
        moments_path: &Path,
        transcript_path: &Path,
        video_title: &str,
        video_channel: &str,
        provider_name: &str,
    ) -> anyhow::Result<EnrichResult> {
        self.execution.check_cancelled()?;
        let cfg = &self.config.news;

        // ── Load inputs ────────────────────────────────────────────────────────
        let moments_raw = tokio::fs::read_to_string(moments_path).await?;
        let moments: ViralMomentList = serde_json::from_str(&moments_raw)
            .map_err(|e| NewsError::InvalidJson(format!("moments.json: {e}")))?;

        let transcript_raw = tokio::fs::read_to_string(transcript_path).await?;
        let transcript: Transcript = serde_json::from_str(&transcript_raw)
            .map_err(|e| NewsError::InvalidJson(format!("transcript.json: {e}")))?;

        std::fs::create_dir_all(self.job.enrich_dir())?;

        let provider = build_llm_provider(self.config, provider_name)
            .map_err(|e| NewsError::Llm(e.to_string()))?;

        info!(
            "Enrich: {} moment(s), search provider = {}",
            moments.moments.len(),
            cfg.provider
        );

        // ── Per-moment enrichment (sequential) ─────────────────────────────────
        let mut enrichments = Vec::with_capacity(moments.moments.len());
        for (i, moment) in moments.moments.iter().enumerate() {
            self.execution.check_cancelled()?;
            let window = transcript_window(&transcript, moment.start_sec, moment.end_sec);
            let mut enrichment = MomentEnrichment::new(i, window.clone());

            if window.trim().is_empty() {
                warn!("moment {i}: empty transcript window — skipping news");
                enrichments.push(enrichment);
                continue;
            }

            // 4a/4b: keyword extraction from the transcript window
            let keywords = match keyword::extract_keywords(
                provider.as_ref(),
                &window,
                video_title,
                video_channel,
                cfg.max_keywords,
            )
            .await
            {
                Ok(k) => k,
                Err(e) => {
                    warn!("moment {i}: keyword extraction failed: {e}");
                    Vec::new()
                }
            };
            info!("moment {i}: extracted {} keyword(s): {:?}", keywords.len(), keywords);
            enrichment.extracted_keywords = keywords.clone();

            // 4c: internet search (batched), dedup, score, filter, rank
            if !keywords.is_empty() {
                match search::search_keywords(self.execution, cfg, &keywords).await {
                    Ok(mut results) => {
                        search::dedup_by_url(&mut results);
                        results.retain(|item| search::within_max_age(item, cfg.max_age_days));
                        for item in &mut results {
                            item.relevance_score =
                                search::score_relevance(item, &window, &cfg.preferred_sources);
                        }
                        results.retain(|item| item.relevance_score >= cfg.relevance_threshold);
                        results.sort_by(|a, b| {
                            b.relevance_score
                                .partial_cmp(&a.relevance_score)
                                .unwrap_or(Ordering::Equal)
                        });
                        results.truncate(cfg.max_results_per_moment);
                        enrichment.news = results;
                    }
                    Err(e) => warn!("moment {i}: news search failed: {e}"),
                }
            }
            info!("moment {i}: {} relevant news kept", enrichment.news.len());

            // ── 4d/4e: Screenshot + format news articles (Phase 2) ─────────────
            let news_dir = self.job.news_dir(i);
            for (j, item) in enrichment.news.iter_mut().enumerate() {
                self.execution.check_cancelled()?;
                let raw_path = news_dir.join(format!("news_{j}.png"));
                match scraper::screenshot(self.execution, cfg, &item.url, &raw_path).await {
                    Ok(Some(result)) => {
                        // Update item's source from the page if we didn't have it yet.
                        if item.source.is_empty() && !result.source.is_empty() {
                            item.source = result.source.clone();
                        }
                        if item.summary.is_empty() && !result.lead.is_empty() {
                            item.summary = result.lead.clone();
                        }
                        item.screenshot_path = Some(result.raw_path.clone());

                        // 4e: Format to 9:16 pillar-box + caption
                        let fmt_path = news_dir.join(format!("news_{j}_formatted.png"));
                        let params = FormatParams {
                            raw_path: &result.raw_path,
                            out_path: &fmt_path,
                            source:    &item.source,
                            published: item.published_at.as_deref(),
                            headline:  &item.title,
                        };
                        match format_screenshot(self.execution, &params).await {
                            Ok(p) => {
                                info!("moment {i} news {j}: formatted → {}", p.display());
                                item.formatted_screenshot_path = Some(p);
                            }
                            Err(e) => warn!("moment {i} news {j}: format failed: {e}"),
                        }
                    }
                    Ok(None) => {}
                    Err(e) => warn!("moment {i} news {j}: screenshot error: {e}"),
                }
            }

            // ── Phase 4: Reaction script (LLM) + TTS synthesis ─────────────────
            if self.config.reaction.enabled {
                let moment = &moments.moments[i];
                match reaction::script::generate_script(
                    provider.as_ref(),
                    moment,
                    &enrichment.transcript_window,
                    &enrichment.news,
                    &self.config.reaction.language,
                    &self.config.reaction.script_style,
                    self.config.reaction.max_reaction_secs,
                ).await {
                    Ok(script) => {
                        info!("moment {i}: reaction script ({:.0}s est.) — tone={}",
                              script.duration_estimate_secs, script.tone);

                        // TTS synthesis
                        let tts_path = self.job.reaction_dir(i).join("voice.mp3");
                        std::fs::create_dir_all(self.job.reaction_dir(i))?;

                        let openai_key = if self.config.reaction.tts.provider == "openai" {
                            Some(self.config.llm.openai_api_key.as_str())
                        } else { None };

                        match reaction::synthesize(
                            self.execution,
                            &script.script,
                            &tts_path,
                            &self.config.reaction,
                            &self.config.news,
                            openai_key,
                        ).await {
                            Ok(tts) => {
                                info!("moment {i}: TTS → {} ({:.1}s)",
                                      tts.path.file_name().unwrap_or_default().to_string_lossy(),
                                      tts.duration_secs);
                                enrichment.tts_audio_path = Some(tts.path);
                            }
                            Err(e) => warn!("moment {i}: TTS failed: {e}"),
                        }
                        // ── Phase 5: Avatar segment generation ─────────────
                        if self.config.reaction.avatar.mode != AvatarMode::None {
                            let seg_path = self.job.reaction_dir(i).join("avatar_segment.mp4");
                            let bg_path  = enrichment.best_news()
                                .and_then(|n| n.formatted_screenshot_path.as_deref());
                            let av_path  = {
                                let p = &self.config.reaction.avatar.image_path;
                                if !p.as_os_str().is_empty() && p.exists() { Some(p.as_path()) }
                                else { None }
                            };
                            let tts_dur = enrichment.tts_audio_path.as_ref()
                                .and_then(|p| std::fs::metadata(p).ok())
                                .map(|m| m.len() as f64 / 16_000.0)
                                .unwrap_or(self.config.reaction.max_reaction_secs as f64);

                            let spec = reaction::AvatarSegmentSpec {
                                tts_path:     enrichment.tts_audio_path.as_deref().unwrap(),
                                duration_secs: tts_dur,
                                avatar_image:  av_path,
                                background:    bg_path,
                                clip_w: 1080,
                                clip_h: 1920,
                            };
                            match reaction::create_avatar_segment(
                                self.execution,
                                &spec, &seg_path,
                                &self.config.ffmpeg,
                                &self.config.reaction,
                            ).await {
                                Ok(Some(p)) => {
                                    info!("moment {i}: avatar segment → {}", p.display());
                                    enrichment.avatar_video_path = Some(p);
                                }
                                Ok(None) => {}
                                Err(e) => warn!("moment {i}: avatar segment failed: {e}"),
                            }
                        }

                        enrichment.reaction_script = Some(script);
                    }
                    Err(e) => warn!("moment {i}: reaction script failed: {e}"),
                }
            }

            enrichments.push(enrichment);
        }

        // ── Persist ────────────────────────────────────────────────────────────
        let result = EnrichResult::from_enrichments(enrichments);
        self.execution.check_cancelled()?;
        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| NewsError::InvalidJson(format!("serialize enrich.json: {e}")))?;
        tokio::fs::write(self.job.enrich_path(), json).await?;

        info!(
            "Enrich complete: {} news article(s) across {} moment(s) → {}",
            result.news_found,
            result.enrichments.len(),
            self.job.enrich_path().display()
        );

        Ok(result)
    }
}

/// Extract the spoken text for a moment's time window, preferring word-level
/// timestamps and falling back to overlapping segment text.
fn transcript_window(transcript: &Transcript, start_sec: f64, end_sec: f64) -> String {
    let words = transcript.words_starting_in(start_sec, end_sec);
    let joined = words
        .iter()
        .map(|w| w.word.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if joined.trim().is_empty() {
        transcript.segment_text_in_window(start_sec, end_sec)
    } else {
        joined
    }
}
