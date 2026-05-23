use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::AppConfig;
use crate::pipeline::job::JobContext;
use crate::transcribe::model::{Transcript, WhisperSegment};
use crate::util::progress::{spinner, stage_done};

use super::error::AnalyzeError;
use super::prompt::{chunk_system_prompt, retry_system_prompt, system_prompt_with_trends, user_prompt};
use super::trending::{extract_keywords, fetch_trending_with_keywords, TrendingContext};
use crate::rag::embed::{context_to_embed_text, embed_text, embed_text_with_config, moment_to_embed_text, EmbedConfig};
use crate::rag::{RagStore, SimilarMoment};
use super::provider::{ClaudeProvider, GeminiProvider, GroqProvider, LlmProvider, OllamaProvider, OpenAiCompatProvider, OpenAiProvider, VllmProvider};
use super::schema::{ViralMoment, ViralMomentList};
use super::vision::{
    build_enriched_transcript, cleanup_frames, describe_video_frames,
    detect_scene_boundaries, extract_frames, parse_compact_timestamp, VisualAnalyzer,
};

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

    /// Run full analysis: transcript LLM + optional visual frame re-ranking.
    ///
    /// `video_path` — pass `Some` to enable visual frame analysis when
    /// `[vision] enabled = true` in config. Pass `None` to skip (e.g., standalone
    /// `clipper analyze` without a video file).
    pub async fn run(
        &self,
        transcript_path: &Path,
        provider_name:   &str,
        max_clips:       usize,
        user_keywords:   &[String],
        video_path:      Option<&Path>,
    ) -> Result<AnalyzeResult, AnalyzeError> {
        let t0 = Instant::now();
        let provider = self.build_provider(provider_name)?;

        // When visual analysis is enabled, request 2× candidates so the vision
        // re-ranker has a wider pool to promote/demote from.
        let vision_active = self.config.vision.enabled
            && video_path.is_some()
            && matches!(
                self.config.vision.provider.as_str(),
                "gemini" | "openai" | "claude" | "vllm"
            );
        let candidate_count = if vision_active {
            (max_clips * 2).max(max_clips + 1)
        } else {
            max_clips
        };

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

        // ── Build focus keyword list ──────────────────────────────────────────
        // Priority: user-specified > auto-extracted from transcript > trending
        let full_transcript_text: String = transcript.segments
            .iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
        let auto_keywords = extract_keywords("Video", &full_transcript_text);

        // Combine user keywords + auto keywords, deduplicated, user keywords first
        let mut focus_keywords: Vec<String> = user_keywords
            .iter()
            .map(|k| k.to_lowercase())
            .collect();
        for kw in &auto_keywords {
            if !focus_keywords.iter().any(|k| k == kw) {
                focus_keywords.push(kw.clone());
            }
        }

        if !user_keywords.is_empty() {
            info!("user-specified keywords: {}", user_keywords.join(", "));
        }
        if !auto_keywords.is_empty() {
            info!("auto-extracted keywords: {}", auto_keywords.join(", "));
        }
        info!("total focus keywords: {}", focus_keywords.join(", "));

        // ── Fetch real-time trending context (regional + keyword-specific) ────
        let pb_trend = spinner(&format!(
            "Fetching trends: regional topics + {} focus keywords…",
            focus_keywords.len()
        ));
        let trending = fetch_trending_with_keywords("ID", &focus_keywords).await;
        pb_trend.finish_and_clear();

        if !trending.daily_topics.is_empty() {
            info!(
                "regional trends: {} topics (e.g. {})",
                trending.daily_topics.len(),
                trending.daily_topics.first().map(|t| t.title.as_str()).unwrap_or("")
            );
        }
        if !trending.keyword_trends.is_empty() {
            info!("keyword trend scores:");
            for k in &trending.keyword_trends {
                info!("  {} \"{}\" — {}/100, {} news",
                    k.hotness(), k.keyword, k.interest_score, k.news_count);
            }
        }
        if !trending.has_data() {
            info!("trending context unavailable — proceeding without");
        }

        let trend_ctx = trending.as_prompt_context();

        // ── RAG: retrieve similar past successful moments ─────────────────────
        // Query Supabase for past moments similar to this video's context.
        // Retrieved examples are injected into the system prompt BEFORE the LLM
        // analyzes the transcript, giving it concrete reference for what works.
        let rag_context = build_rag_context(
            &full_transcript_text,
            &focus_keywords,
            &self.config.whisper.language,
            &self.config,
        ).await;

        // ── Analyze transcript ────────────────────────────────────────────────
        // ── Choose single-pass vs chunked based on estimated token count ────────
        //
        // Token budget: 5000 — leaves a safe margin for models with 6k–8k TPM limits
        // (e.g. Groq free tier llama-3.1-8b-instant = 6000 TPM).
        //
        // Strategy — two transcript formats:
        //   COMPACT  [sec] text          → ~3.5× smaller than verbose
        //   VERBOSE  [start - end] text  → more informative but far more tokens
        //
        // We always build the compact transcript first, estimate total tokens, and
        // only fall through to chunked mode if even the compact approach is too large.
        const SINGLE_PASS_BUDGET: usize = 5_000; // tokens
        const CHARS_PER_TOKEN: f64   = 3.5;

        // Build compact transcript (always used — saves ~50% vs verbose format)
        let base_compact = build_scored_transcript(
            &transcript.to_compact_prompt_lines(),
            &focus_keywords,
        );

        // ── Priority 1: Combined audio-visual prompt ──────────────────────────
        // When vision.describe_video = true: sample entire video, generate text
        // descriptions for each frame, then inject them into the transcript so
        // the LLM sees both WHAT WAS SAID and WHAT WAS VISIBLE at each timestamp.
        let compact_lines = if vision_active
            && self.config.vision.describe_video
            && video_path.is_some()
        {
            let vp           = video_path.unwrap();
            let interval     = self.config.vision.describe_interval.max(5.0);
            let batch        = self.config.vision.describe_batch.max(1);
            let n_frames     = (duration_secs / interval) as usize;
            let n_calls      = n_frames.div_ceil(batch as usize);

            info!(
                "  🎬 Full-video description: ~{} frames ({} API calls, interval={:.0}s)…",
                n_frames, n_calls, interval
            );

            let pb = spinner("Extracting visual descriptions of full video…");
            let desc_dir = self.job.analyze_dir().join("describe_frames");
            let descriptions = describe_video_frames(
                vp,
                duration_secs,
                interval,
                batch,
                self.config.vision.frame_width,
                &desc_dir,
                &self.config.vision,
                &self.config.llm,
            ).await;
            pb.finish_and_clear();
            cleanup_frames(&desc_dir);

            if descriptions.is_empty() {
                warn!("vision: no descriptions produced — using plain transcript");
                base_compact.clone()
            } else {
                info!("  🎬 Visual descriptions: {} timestamps captured", descriptions.len());
                let enriched = build_enriched_transcript(&base_compact, &descriptions, interval);
                // Log a sample so the user can see the enrichment
                if let Some(sample) = enriched.lines()
                    .filter(|l| l.trim_start().starts_with("↳ Visual:"))
                    .next()
                {
                    info!("  🎬 Sample: {}", sample.trim());
                }
                enriched
            }
        } else {
            base_compact.clone()
        };

        // ── Intro detection ───────────────────────────────────────────────────
        // Detect where the video intro ends (host greeting, channel CTA, content teaser)
        // and inject a marker so the LLM avoids picking moments from that section.
        let intro_end_sec = detect_intro_end(&transcript, self.config.llm.min_clip_start_sec);
        let compact_lines = if intro_end_sec > 1.0 {
            info!(
                "  🎬 Intro detected: skipping first {:.0}s — injecting boundary marker",
                intro_end_sec
            );
            inject_intro_marker(&compact_lines, intro_end_sec)
        } else {
            compact_lines
        };

        // Compact system prompt (~400 tokens) + trend context + compact transcript + user header
        let compact_sys_len   = chunk_system_prompt(max_clips).len() + trend_ctx.len();
        let compact_total_est = ((compact_sys_len + compact_lines.len() + 600) as f64
                                 / CHARS_PER_TOKEN) as usize;

        // Re-estimate with candidate_count (may be 2× max_clips)
        let compact_sys_len_c   = chunk_system_prompt(candidate_count).len() + trend_ctx.len();
        let compact_total_est_c = ((compact_sys_len_c + compact_lines.len() + 600) as f64
                                   / CHARS_PER_TOKEN) as usize;

        let force_chunks = segment_count > 400
            || duration_mins > 15.0
            || compact_total_est_c > SINGLE_PASS_BUDGET;

        let moments = if force_chunks {
            if compact_total_est_c > SINGLE_PASS_BUDGET {
                info!(
                    "estimated ~{} tokens > budget {} — using chunked analysis",
                    compact_total_est_c, SINGLE_PASS_BUDGET
                );
            } else {
                info!("transcript is large — using chunked analysis");
            }
            self.analyze_in_chunks(&*provider, &transcript, candidate_count, &trend_ctx, &focus_keywords)
                .await?
        } else {
            // Single pass — build system prompt with RAG + trends injected
            let sys = {
                let mut s = chunk_system_prompt(candidate_count);
                if let Some(ref rag) = rag_context {
                    s = format!("{s}\n\n{rag}");
                }
                if !trend_ctx.is_empty() {
                    s = format!("{s}\n\n{trend_ctx}\nUse these trends to prioritise relevant moments.");
                }
                s
            };
            let usr = user_prompt_with_focus(
                "Video", duration_secs, &compact_lines, candidate_count, &focus_keywords,
            );

            info!(
                "single-pass analysis (~{} estimated tokens, budget {})",
                compact_total_est, SINGLE_PASS_BUDGET
            );

            let pb = spinner(&format!(
                "Analyzing with {} ({})…",
                provider.name(),
                provider.model()
            ));
            let raw_response = provider.chat_completion(&sys, &usr).await?;
            pb.finish_and_clear();

            self.parse_with_retry(&*provider, &raw_response, candidate_count, duration_secs)
                .await?
        };

        if moments.moments.is_empty() {
            return Err(AnalyzeError::NoMomentsFound);
        }

        // ── Drop moments that start in the intro section ──────────────────────
        let mut moments = moments;
        if intro_end_sec > 1.0 {
            let before = moments.moments.len();
            moments.moments.retain(|m| {
                if m.start_sec < intro_end_sec {
                    info!(
                        "  ⚠️  Dropped intro moment at {:.1}s (intro ends at {:.1}s): \"{}\"",
                        m.start_sec, intro_end_sec, m.title
                    );
                    false
                } else {
                    true
                }
            });
            let dropped = before - moments.moments.len();
            if dropped > 0 {
                info!("  🎬 Dropped {} intro moment(s), {} remain", dropped, moments.moments.len());
            }
        }

        if moments.moments.is_empty() {
            // All moments were in the intro — increase candidate count and retry is not
            // practical here; warn and return what we have (caller handles empty list)
            tracing::warn!(
                "All moments fell within the intro section (first {:.0}s). \
                 Consider setting min_clip_start_sec manually in config.toml if auto-detection \
                 is too aggressive.",
                intro_end_sec
            );
            return Err(AnalyzeError::NoMomentsFound);
        }

        // ── Post-parse enrichment ─────────────────────────────────────────────
        // Cross-check hook/headline against actual transcript text.
        // If the LLM hallucinated the hook (different content from what's spoken
        // at start_sec), replace it with the verbatim first words from the transcript.
        enrich_moments_from_transcript(&mut moments.moments, &transcript);

        // ── Stage 2: visual re-ranking (optional) ────────────────────────────
        let mut final_moments: Vec<ViralMoment> = moments.moments;

        if vision_active {
            let vp = video_path.unwrap(); // safe: vision_active requires Some
            info!(
                "  🎥 Visual analysis: {} candidate(s) → selecting top {}…",
                final_moments.len(), max_clips
            );
            final_moments = self
                .visual_rerank(final_moments, vp, &transcript, max_clips)
                .await;
        } else {
            final_moments.truncate(max_clips);
        }

        let moments = ViralMomentList { moments: final_moments };

        if moments.moments.is_empty() {
            return Err(AnalyzeError::NoMomentsFound);
        }

        info!("identified {} viral moments:", moments.moments.len());
        for (i, m) in moments.moments.iter().enumerate() {
            info!(
                "  [{}/{}] [{}·{}] \"{}\"",
                i + 1, moments.moments.len(),
                m.viral_type.to_uppercase(),
                m.content_category,
                m.title,
            );
            info!(
                "        ⏱  {:.1}s – {:.1}s  ({:.0}s)  energy={}  trigger={}",
                m.start_sec, m.end_sec, m.duration(), m.energy, m.emotional_trigger
            );
            info!("        👥  Audience: {}", m.target_audience);
            info!("        🪝  Hook: {}", m.hook);
            info!("        📝  Caption: {}", m.caption.lines().next().unwrap_or(""));
        }

        // ── RAG storage: persist finalized moments for future retrieval ─────────
        // Runs in background (tokio::spawn) — non-blocking.
        // Provider dan dimensi embedding mengikuti [vector_db] embed_provider di config.toml.
        store_moments_to_rag(
            moments.moments.clone(),
            self.config.vector_db.clone(),
            crate::rag::embed::EmbedConfig::from_app_config(self.config),
            self.job.job_id.clone(),
        );

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
        trend_ctx: &str,
        focus_keywords: &[String],
    ) -> Result<ViralMomentList, AnalyzeError> {
        // Initial chunk size — will auto-shrink if 413 (payload too large) occurs
        let mut chunk_size_secs = 180.0_f64; // 3 minutes (conservative start)
        let overlap_secs = 30.0;
        let total_duration = transcript.duration_ms as f64 / 1000.0;
        let clips_per_chunk = (max_clips / 2).max(2);

        let mut all_moments: Vec<ViralMoment> = Vec::new();
        let mut start = 0.0_f64;

        while start < total_duration {
            let end = (start + chunk_size_secs).min(total_duration);

            // Build compact transcript with keyword relevance markers
            let raw_window = self.get_transcript_window(transcript, start, end);
            let chunk_text = build_scored_transcript(&raw_window, focus_keywords);
            if chunk_text.is_empty() {
                start = end - overlap_secs;
                continue;
            }

            // Estimate token count: rough rule ~3.5 chars per token
            // Budget: leave ~2500 tokens for system prompt + user header → transcript gets the rest
            let estimated_tokens = (chunk_text.len() as f64 / 3.5) as usize;
            let transcript_budget = 2800_usize; // safe margin for any model

            // Trim the transcript text if it's over budget
            let chunk_text = if estimated_tokens > transcript_budget {
                let max_chars = (transcript_budget as f64 * 3.5) as usize;
                warn!(
                    "chunk transcript too large (~{} tokens), trimming to ~{} tokens",
                    estimated_tokens, transcript_budget
                );
                trim_to_char_limit(&chunk_text, max_chars)
            } else {
                chunk_text
            };

            info!(
                "  analyzing chunk: {:.0}s – {:.0}s  (~{} tokens)…",
                start, end,
                (chunk_text.len() as f64 / 3.5) as usize
            );

            // Use compact system prompt for chunks to save tokens.
            // Inject trending context only into the first chunk (saves tokens on subsequent chunks).
            let sys = if start == 0.0 && !trend_ctx.is_empty() {
                format!(
                    "{}\n\n{trend_ctx}\nUse these trends to prioritise relevant moments.",
                    chunk_system_prompt(clips_per_chunk)
                )
            } else {
                chunk_system_prompt(clips_per_chunk)
            };
            let usr = user_prompt_with_focus("Video Segment", end - start, &chunk_text, clips_per_chunk, focus_keywords);

            // Retry loop: handles 429 (rate limit) and 413 (payload too large)
            let mut retries = 0;
            const MAX_RETRIES: u32 = 5;

            let raw = loop {
                match provider.chat_completion(&sys, &usr).await {
                    Ok(res) => break res,

                    Err(e) if retries < MAX_RETRIES => {
                        let err_msg = e.to_string();
                        retries += 1;

                        if err_msg.contains("413") || err_msg.contains("too large") || err_msg.contains("Request too large") {
                            // Payload too large — halve the chunk and restart this window
                            chunk_size_secs = (chunk_size_secs * 0.6).max(60.0);
                            warn!(
                                "Chunk too large (413), reducing chunk size to {:.0}s and retrying…",
                                chunk_size_secs
                            );
                            // Restart this window with the smaller chunk
                            let end2 = (start + chunk_size_secs).min(total_duration);
                            let raw2 = self.get_transcript_window(transcript, start, end2);
                            let chunk2 = build_scored_transcript(&raw2, focus_keywords);
                            let max_chars = (transcript_budget as f64 * 3.5) as usize;
                            let chunk2 = trim_to_char_limit(&chunk2, max_chars);
                            let sys2 = chunk_system_prompt(clips_per_chunk);
                            let usr2 = user_prompt_with_focus("Video Segment", end2 - start, &chunk2, clips_per_chunk, focus_keywords);
                            // Swap and retry immediately (no sleep needed for 413)
                            match provider.chat_completion(&sys2, &usr2).await {
                                Ok(res) => break res,
                                Err(e2) => {
                                    warn!("Still failing after chunk reduction: {e2}");
                                    // Skip this chunk rather than crashing the whole pipeline
                                    break String::from(r#"{"moments":[]}"#);
                                }
                            }
                        } else if err_msg.contains("429") {
                            // Rate limit — check if daily limit
                            if err_msg.contains("tokens per day") || err_msg.contains("TPD") {
                                return Err(AnalyzeError::ApiError {
                                    provider: provider.name().to_owned(),
                                    message: format!(
                                        "Daily token limit reached on Groq free tier.\n\
                                         Solutions:\n\
                                         1. Switch to Ollama: --provider ollama\n\
                                         2. Use OpenAI: --provider openai\n\
                                         3. Upgrade at https://console.groq.com/settings/billing\n\
                                         Error: {err_msg}"
                                    ),
                                });
                            }
                            // Minute rate limit — wait exponentially
                            let wait = 15 * retries;
                            warn!("Rate limit (429), waiting {wait}s… (attempt {retries}/{MAX_RETRIES})");
                            tokio::time::sleep(tokio::time::Duration::from_secs(wait as u64)).await;
                            continue;
                        } else {
                            return Err(e);
                        }
                    }

                    Err(e) => return Err(e),
                }
            };

            let mut moments = self.parse_with_retry(provider, &raw, clips_per_chunk, total_duration).await?;
            all_moments.append(&mut moments.moments);

            // Small delay between chunks to be polite to rate limits
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            if end >= total_duration {
                break;
            }
            start = (end - overlap_secs).max(start + 1.0); // advance, never go backward
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

        // Final sort: keyword relevance > energy level
        // Moments whose title/hook/reason contain focus keywords rank higher
        unique_moments.sort_by(|a, b| {
            let kw_score = |m: &ViralMoment, kws: &[String]| -> i32 {
                if kws.is_empty() { return 0; }
                let haystack = format!("{} {} {}", m.title, m.hook, m.reason).to_lowercase();
                kws.iter().filter(|k| haystack.contains(k.to_lowercase().as_str())).count() as i32
            };
            let energy_score = |m: &ViralMoment| -> i32 {
                match m.energy.to_lowercase().as_str() { "high" => 3, "medium" => 2, _ => 1 }
            };
            // Combined score: keyword match worth 5 points each, energy worth 1-3
            let score_b = kw_score(b, focus_keywords) * 5 + energy_score(b);
            let score_a = kw_score(a, focus_keywords) * 5 + energy_score(a);
            score_b.cmp(&score_a)
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

        // Retry with a FRESH compact request — do NOT echo back the invalid response.
        // Echoing `raw` back wastes tokens and pushes low-TPM models over their limit.
        let retry_sys = retry_system_prompt(max_clips);
        let retry_usr = format!(
            "Return only valid JSON matching the schema. {max_clips} moments, 30-120s each."
        );

        // Wait a beat before retrying — gives TPM window time to recover
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

        let pb = spinner("Retrying analysis (fixing JSON)…");
        let retry_raw = match provider.chat_completion(&retry_sys, &retry_usr).await {
            Ok(r) => r,
            Err(e) if e.to_string().contains("429") => {
                // Still rate-limited — wait longer and try once more
                pb.set_message("Rate-limited on retry, waiting 20s…");
                tokio::time::sleep(tokio::time::Duration::from_secs(20)).await;
                provider.chat_completion(&retry_sys, &retry_usr).await?
            }
            Err(e) => return Err(e),
        };
        pb.finish_and_clear();

        let cleaned2 = strip_markdown_fences(&retry_raw);
        let mut list = serde_json::from_str::<ViralMomentList>(&cleaned2).map_err(|e| {
            AnalyzeError::InvalidJson { retries: 2, source: e }
        })?;
        validate_and_clamp(&mut list, duration_secs);
        Ok(list)
    }

    // ── Visual re-ranking ─────────────────────────────────────────────────────

    /// Score each candidate moment's visual content and re-rank by a combined
    /// text+visual score, then truncate to `max_clips`.
    ///
    /// Returns the original slice (truncated) if any step fails, so callers
    /// always get a valid result.
    async fn visual_rerank(
        &self,
        mut moments:  Vec<ViralMoment>,
        video_path:   &Path,
        transcript:   &Transcript,
        max_clips:    usize,
    ) -> Vec<ViralMoment> {
        let cfg      = &self.config.vision;
        let analyzer = VisualAnalyzer::new(cfg, &self.config.llm);
        let n        = moments.len();
        let weight   = cfg.score_weight.clamp(0.0, 1.0);

        // frames_dir: analyze_dir/frames/  (cleaned up after scoring)
        let frames_dir = self.job.analyze_dir().join("frames");

        let mut scored: Vec<(f32, ViralMoment)> = Vec::with_capacity(n);

        for (idx, mut moment) in moments.drain(..).enumerate() {
            // Text rank score: #1 LLM pick = 1.0, last = ≈0
            let text_score = (n - idx) as f32 / n as f32;

            // Extract segment text from transcript (for prompt context)
            let segment_text = self.get_transcript_window(
                transcript, moment.start_sec, moment.end_sec,
            );

            // Extract frames into a per-moment subdirectory.
            // When scene_detection is enabled, detect cuts first then sample at boundaries.
            let moment_frames_dir = frames_dir.join(format!("{idx:02}"));
            let scene_ts = if cfg.scene_detection {
                detect_scene_boundaries(
                    video_path,
                    moment.start_sec, moment.end_sec,
                    cfg.scene_threshold,
                ).await
            } else {
                Vec::new()
            };
            let scene_ts_opt = if scene_ts.is_empty() { None } else { Some(scene_ts.as_slice()) };
            let frames = extract_frames(
                video_path,
                moment.start_sec,
                moment.end_sec,
                cfg.frames_per_moment,
                cfg.frame_width,
                &moment_frames_dir,
                scene_ts_opt,
            ).await;

            // Call vision LLM — returns None on any error
            let vis_raw = analyzer.score_moment(
                &frames, &segment_text, moment.start_sec, moment.end_sec,
            ).await;

            let vis_score = vis_raw.as_ref().map(|s| s.combined()).unwrap_or(0.0);
            let combined  = text_score * (1.0 - weight) + vis_score * weight;

            if let Some(ref vs) = vis_raw {
                info!(
                    "  📸 Candidate {}/{}: visual={:.0}% \
                     (humor={} impact={} novelty={} engagement={}) — {}",
                    idx + 1, n,
                    vis_score * 100.0,
                    vs.humor, vs.visual_impact, vs.novelty, vs.engagement,
                    if vs.note.is_empty() { "—" } else { &vs.note }
                );
            } else {
                info!(
                    "  📸 Candidate {}/{}: visual=n/a (no frames or API error)",
                    idx + 1, n
                );
            }

            moment.visual_score = vis_raw;
            scored.push((combined, moment));
        }

        // Clean up all frame files
        cleanup_frames(&frames_dir);

        // Sort descending by combined score and take the best max_clips
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(max_clips);

        info!(
            "  ✅ Visual re-ranking complete: {} clip(s) selected",
            scored.len()
        );

        scored.into_iter().map(|(_, m)| m).collect()
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
            "claude" => {
                if self.config.llm.claude_api_key.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "claude".to_owned(),
                        message: "CLIPPER_CLAUDE_API_KEY is not set.\n\
                                  Get your key at: https://console.anthropic.com/".to_owned(),
                    });
                }
                Ok(Box::new(ClaudeProvider::new(
                    self.config.llm.claude_api_key.clone(),
                    self.config.llm.claude_model.clone(),
                )))
            }
            "gemini" => {
                if self.config.llm.gemini_api_key.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "gemini".to_owned(),
                        message: "CLIPPER_GEMINI_API_KEY is not set.\n\
                                  Get your free key at: https://aistudio.google.com/apikey".to_owned(),
                    });
                }
                Ok(Box::new(GeminiProvider::new(
                    self.config.llm.gemini_api_key.clone(),
                    self.config.llm.gemini_model.clone(),
                )))
            }


            "vllm" => {
                if self.config.llm.vllm_base_url.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "vllm".to_owned(),
                        message:  "vllm_base_url is not set in config.toml.\n\
                                   Example: vllm_base_url = \"http://localhost:8000\"".to_owned(),
                    });
                }
                Ok(Box::new(VllmProvider::new(
                    self.config.llm.vllm_base_url.clone(),
                    self.config.llm.vllm_model.clone(),
                    self.config.llm.vllm_api_key.clone(),
                )))
            }
            "ollama" => Ok(Box::new(OllamaProvider::new(
                self.config.llm.ollama_base_url.clone(),
                self.config.llm.ollama_model.clone(),
            ))),
            "novita" => {
                if self.config.llm.novita_api_key.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "novita".to_owned(),
                        message: "CLIPPER_NOVITA_API_KEY is not set.\n\
                                  Get key: https://novita.ai/settings#key-management".to_owned(),
                    });
                }
                let base_url = if self.config.llm.novita_base_url.is_empty() {
                    "https://api.novita.ai/openai".to_owned()
                } else {
                    self.config.llm.novita_base_url.clone()
                };
                Ok(Box::new(OpenAiCompatProvider::new(
                    base_url,
                    self.config.llm.novita_api_key.clone(),
                    self.config.llm.novita_model.clone(),
                    "novita".into(),
                )))
            }
            "together" => {
                if self.config.llm.together_api_key.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "together".to_owned(),
                        message: "CLIPPER_TOGETHER_API_KEY is not set.".to_owned(),
                    });
                }
                Ok(Box::new(super::provider::openai_compat::together(
                    self.config.llm.together_api_key.clone(),
                    self.config.llm.together_model.clone(),
                )))
            }
            "fireworks" => {
                if self.config.llm.fireworks_api_key.is_empty() {
                    return Err(AnalyzeError::ApiError {
                        provider: "fireworks".to_owned(),
                        message: "CLIPPER_FIREWORKS_API_KEY is not set.".to_owned(),
                    });
                }
                Ok(Box::new(super::provider::openai_compat::fireworks(
                    self.config.llm.fireworks_api_key.clone(),
                    self.config.llm.fireworks_model.clone(),
                )))
            }
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

/// Trim transcript text to at most `max_chars` characters, cutting at a line boundary.
/// Appends a note so the LLM knows the text was truncated.
/// Score each line in a transcript window by keyword relevance and add markers.
///
/// Lines containing focus keywords get a `[🎯 kw1, kw2]` prefix — this guides
/// the LLM to pay extra attention to those segments when selecting viral moments.
///
/// Example output:
/// ```
/// [🎯 prabowo, dollar][120] Prabowo kemarin bilang soal kurs dollar…
/// [130] Normal segment tanpa keyword apapun…
/// [🎯 AI][145] Adopsi AI di Indonesia sekarang makin tinggi…
/// ```
// ── Post-parse transcript enrichment ─────────────────────────────────────────

/// After the LLM returns moments, ground each moment's `hook` and `transcript_segment`
/// in the actual Whisper transcript text.
///
/// Problems this fixes:
///   1. LLM hallucinated `hook` — replaced with verbatim first words from transcript
///   2. `transcript_segment` was empty — filled with actual spoken text in the window
///   3. Headline mismatch logged as debug warning (not auto-replaced — it's creative text)
fn enrich_moments_from_transcript(
    moments:    &mut Vec<ViralMoment>,
    transcript: &Transcript,
) {
    for m in moments.iter_mut() {
        // ── 1. Populate transcript_segment with actual spoken text ────────────
        let segment_text = transcript.segment_text_in_window(m.start_sec, m.end_sec);
        m.transcript_segment = segment_text.clone();

        // ── 2. Fix hook: extract verbatim first words from transcript ─────────
        // We look at the first 5 seconds of the clip for the hook words.
        let first_words: String = transcript
            .words_starting_in(m.start_sec, m.start_sec + 5.0)
            .into_iter()
            .take(9)  // first 9 words = roughly one sentence fragment
            .map(|w| w.word.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        if !first_words.is_empty() {
            let overlap = word_overlap_ratio(&m.hook, &first_words);
            if m.hook.is_empty() {
                // Hook was empty — fill with verbatim first words
                m.hook = first_words.clone();
                tracing::debug!("hook filled from transcript: \"{}\"", m.hook);
            } else if overlap < 0.25 {
                // Hook shares <25% words with actual first words → likely hallucinated
                tracing::info!(
                    "  🔧 Hook replaced (overlap={:.0}%): \"{}\" → \"{}\"",
                    overlap * 100.0, m.hook, first_words
                );
                m.hook = first_words.clone();
            }
        }

        // ── 3. Warn if headline seems unrelated to the actual segment ─────────
        if !m.headline.is_empty() && !segment_text.is_empty() {
            let hl_ratio = word_overlap_ratio(&m.headline, &segment_text);
            if hl_ratio < 0.12 {
                tracing::debug!(
                    "headline may not match clip content (overlap={:.0}%): \
                     headline=\"{}\" | segment=\"{}…\"",
                    hl_ratio * 100.0,
                    m.headline,
                    segment_text.chars().take(80).collect::<String>()
                );
            }
        }

        // ── 4. Context-aware overlay query refinement ─────────────────────────
        // Extract spoken text AT the overlay peak moment, detect tone, and refine
        // the LLM-generated generic query with subject-specific keywords.
        // Example: "funny laugh reaction" → "funny laugh prabowo joget lucu"
        if !m.overlay_query.is_empty() && m.overlay_at_sec >= 0.0 {
            let peak_t      = m.start_sec + m.overlay_at_sec;
            let window_text = transcript.segment_text_in_window(peak_t, peak_t + 3.5);

            if !window_text.is_empty() {
                m.overlay_context_text = window_text.clone();

                let subjects = extract_subject_keywords(&window_text);
                let tone     = detect_spoken_tone(&window_text);

                if !subjects.is_empty() {
                    // Build refined query: subject keywords + original reaction type
                    let refined = match tone {
                        OverlayTone::Funny   =>
                            format!("{} {} lucu viral", subjects.join(" "), m.overlay_query),
                        OverlayTone::Serious =>
                            format!("{} {}", subjects.join(" "), m.overlay_query),
                        OverlayTone::Neutral =>
                            format!("{} {}", m.overlay_query, subjects.join(" ")),
                    };

                    // Cap at 60 chars so yt-dlp search isn't too long
                    let refined: String = refined.chars().take(60).collect();

                    // Auto-adjust overlay style based on tone (if LLM left it as "auto")
                    if m.overlay_style.is_empty() || m.overlay_style == "auto" {
                        m.overlay_style = match tone {
                            OverlayTone::Funny   => "pip".to_owned(),
                            OverlayTone::Serious => "sticker".to_owned(),
                            OverlayTone::Neutral => "auto".to_owned(),
                        };
                    }

                    tracing::info!(
                        "  🎬 Overlay refined (tone={:?}): \"{}\" → \"{}\"  context=\"{}…\"",
                        tone, m.overlay_query, refined,
                        window_text.chars().take(55).collect::<String>()
                    );
                    m.overlay_query = refined;
                }
            }
        }
    }
}

/// Tone of spoken text — used to determine overlay style and query flavour.
#[derive(Debug, Clone, PartialEq)]
enum OverlayTone { Funny, Serious, Neutral }

/// Detect whether spoken text has a funny, serious, or neutral tone.
/// Uses vocabulary from VocabCache (Supabase) or hardcoded defaults as fallback.
fn detect_spoken_tone(text: &str) -> OverlayTone {
    detect_spoken_tone_with_vocab(text, None)
}

fn detect_spoken_tone_with_vocab(text: &str, vocab: Option<&crate::rag::VocabCache>) -> OverlayTone {
    let t = text.to_lowercase();

    // Use Supabase vocab if available, else hardcoded defaults
    let defaults = crate::rag::VocabCache::defaults(3600);
    let funny_list  = vocab.map(|v| v.tone_funny.as_slice()).unwrap_or(defaults.tone_funny.as_slice());
    let serious_list = vocab.map(|v| v.tone_serious.as_slice()).unwrap_or(defaults.tone_serious.as_slice());

    let funny_score: usize  = funny_list.iter().filter(|w| t.contains(w.as_str())).count();
    let serious_score: usize = serious_list.iter().filter(|w| t.contains(w.as_str())).count();
    // Exclamation/question marks as humor signals
    let excl = text.chars().filter(|&c| c == '!' || c == '?').count();
    let funny_score = funny_score + (excl / 2);

    if funny_score > serious_score && funny_score >= 1 {
        OverlayTone::Funny
    } else if serious_score > funny_score && serious_score >= 1 {
        OverlayTone::Serious
    } else {
        OverlayTone::Neutral
    }
}

/// Extract subject keywords (proper names, entities) from Indonesian spoken text.
/// Finds proper nouns and title+name patterns like "Pak Jokowi", "Dr Tirta".
fn extract_subject_keywords(text: &str) -> Vec<String> {
    let mut keywords: Vec<String> = Vec::new();

    // Strategy 1: words ≥4 chars starting with uppercase = likely proper nouns
    for word in text.split_whitespace() {
        let clean: String = word.chars()
            .filter(|c| c.is_alphanumeric())
            .collect();
        if clean.len() >= 4
            && clean.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
        {
            let kw = clean.to_lowercase();
            if !keywords.contains(&kw) {
                keywords.push(kw);
            }
        }
    }

    // Strategy 2: Indonesian title patterns followed by a name (from VocabCache or defaults)
    let defaults = crate::rag::VocabCache::defaults(3600);
    let title_patterns = defaults.name_titles.clone();
    let text_lower = text.to_lowercase();
    for pattern in &title_patterns {
        if let Some(pos) = text_lower.find(pattern) {
            let after = &text[pos + pattern.len()..];
            let name: String = after.split_whitespace()
                .next()
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_alphanumeric())
                .take(15)
                .collect::<String>()
                .to_lowercase();
            if name.len() >= 3 && !keywords.contains(&name) {
                keywords.push(name);
            }
        }
    }

    keywords.dedup();
    keywords.truncate(2);  // max 2 keywords → keep query focused
    keywords
}

/// Fraction of words in `needle` that appear in `haystack` (case-insensitive).
/// Used to detect hook/headline hallucinations.
fn word_overlap_ratio(needle: &str, haystack: &str) -> f32 {
    use std::collections::HashSet;
    let hay: HashSet<String> = haystack
        .split_whitespace()
        .map(|w| w.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric()).to_owned())
        .filter(|w| !w.is_empty())
        .collect();
    let needle_words: Vec<String> = needle
        .split_whitespace()
        .map(|w| w.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric()).to_owned())
        .filter(|w| !w.is_empty())
        .collect();
    if needle_words.is_empty() { return 0.0; }
    let matches = needle_words.iter().filter(|w| hay.contains(w.as_str())).count();
    matches as f32 / needle_words.len() as f32
}

// ── Intro detection ───────────────────────────────────────────────────────────

/// Keywords that indicate the video is still in its intro/greeting/CTA section.
/// These appear in the first ~15% of the video before the main content starts.
const INTRO_KEYWORDS: &[&str] = &[
    // Indonesian greetings
    "selamat datang", "welcome back", "halo semua", "hai semua",
    "assalamualaikum", "halo guys", "hai guys", "selamat pagi",
    "selamat siang", "selamat malam",
    // Channel call-to-action
    "subscribe", "like dan", "jangan lupa", "aktifkan", "notifikasi",
    "bell", "komentar di bawah", "tinggalkan komentar", "klik like",
    "tekan like", "dukung channel", "support channel",
    // Content teasers (intro preview of the episode)
    "kali ini kita akan", "di video ini kita", "hari ini kita akan",
    "kita akan bahas", "kita akan diskusi", "kita akan bicara",
    "di episode ini", "di kesempatan ini", "pada kesempatan kali",
    "kita akan membahas", "yang akan kita bahas",
    // Filler/transition intro phrases
    "tanpa panjang lebar", "tanpa basa basi", "langsung saja kita",
    "baik langsung", "oke langsung", "yuk langsung", "ayo langsung",
    // English (for bilingual channels)
    "welcome to", "today we're going", "today we will", "in today's video",
    "don't forget to", "smash that", "without further ado",
    "let's get started", "let's dive in",
];

/// Detect where the video intro/teaser ends and main content begins.
///
/// Combines THREE independent signals and takes the maximum (latest boundary):
///
///   Signal 1 — `detect_speech_start_gap`:
///     If the first Whisper segment starts >5s after t=0, there was a music/silent
///     intro (Whisper skips non-speech audio entirely).
///
///   Signal 2 — `detect_montage_intro`:
///     If the first 60s contain many short segments (≤3 words, high gap frequency),
///     it's a highlight-clip montage preview. Ends when sustained speech begins.
///
///   Signal 3 — `detect_keyword_intro`:
///     Last occurrence of greeting/CTA/teaser keywords + optional silence gap after.
///
/// Returns 0.0 if no intro is detected.
fn detect_intro_end(transcript: &Transcript, min_sec_override: f64) -> f64 {
    if min_sec_override > 0.0 { return min_sec_override; }

    let total_dur = transcript.duration_ms as f64 / 1000.0;
    if total_dur < 30.0 { return 0.0; }
    let scan_limit = (total_dur * 0.15).min(120.0);

    let music_end   = detect_speech_start_gap(transcript);
    let montage_end = detect_montage_intro(transcript);
    let keyword_end = detect_keyword_intro(transcript, scan_limit);

    let intro_end = music_end.max(montage_end).max(keyword_end);

    tracing::debug!(
        "intro detection: music={:.1}s  montage={:.1}s  keyword={:.1}s  → final={:.1}s",
        music_end, montage_end, keyword_end, intro_end
    );

    intro_end.min(scan_limit)
}

// ── Intro detection helpers ───────────────────────────────────────────────────

/// Signal 1 — Music/silent intro detection.
///
/// When a video starts with background music or a silent jingle, Whisper produces
/// no transcript segments for that period. If the first speech segment begins
/// significantly after t=0, there was a silent/music intro.
fn detect_speech_start_gap(transcript: &Transcript) -> f64 {
    const MIN_GAP_SEC: f64 = 5.0; // music/silence intro is typically ≥5 s

    if let Some(first) = transcript.segments.first() {
        let first_sec = first.start_ms as f64 / 1000.0;
        if first_sec >= MIN_GAP_SEC {
            // Speech starts late → there was a music/silent intro before it
            return first_sec;
        }
    }
    0.0
}

/// Signal 2 — Highlight-clip montage intro detection.
///
/// Many Indonesian YouTube videos open with 15–30s of rapid clip previews
/// ("coming up in this episode"). These appear in the transcript as many short
/// segments (≤3 words) with small inter-segment gaps.
///
/// Detection: if >55% of segments in the first 120s are ≤3 words AND there are
/// at least 4 such fragments → it's a montage. End is detected as the first pair
/// of consecutive long segments (>5 words each, gap <3s) = real content starts.
fn detect_montage_intro(transcript: &Transcript) -> f64 {

    const SCAN_LIMIT_SEC:   f64   = 120.0;
    const SHORT_WORD_MAX:   usize = 3;    // ≤3 words = fragment
    const LONG_WORD_MIN:    usize = 6;    // >6 words = real sentence
    const MONTAGE_RATIO:    f32   = 0.55; // >55% short segs in window → montage
    const MIN_MONTAGE_SEGS: usize = 4;    // need ≥4 fragments to qualify
    const SUSTAINED_GAP_MAX: f64  = 3.0; // two long segs within 3s = sustained

    let scan_segs: Vec<&WhisperSegment> = transcript.segments.iter()
        .filter(|s| s.start_ms as f64 / 1000.0 < SCAN_LIMIT_SEC)
        .collect();

    if scan_segs.len() < MIN_MONTAGE_SEGS { return 0.0; }

    let short_count = scan_segs.iter()
        .filter(|s| s.text.split_whitespace().count() <= SHORT_WORD_MAX)
        .count();

    let ratio = short_count as f32 / scan_segs.len() as f32;
    if ratio < MONTAGE_RATIO { return 0.0; }

    // Montage confirmed — find where it ends (first sustained speech pair)
    for window in transcript.segments.windows(2) {
        let a = &window[0];
        let b = &window[1];
        if a.start_ms as f64 / 1000.0 > SCAN_LIMIT_SEC { break; }

        let a_words = a.text.split_whitespace().count();
        let b_words = b.text.split_whitespace().count();
        let gap_sec = (b.start_ms - a.end_ms) as f64 / 1000.0;

        if a_words > LONG_WORD_MIN && b_words > LONG_WORD_MIN && gap_sec < SUSTAINED_GAP_MAX {
            // Two consecutive long segments = real content has started
            return a.start_ms as f64 / 1000.0;
        }
    }

    // Montage detected but no clear content boundary found — use end of scan window
    scan_segs.last().map(|s| s.end_ms as f64 / 1000.0).unwrap_or(0.0)
}

/// Signal 3 — Keyword-based intro detection (existing logic extracted).
///
/// Finds the last occurrence of greeting/CTA/teaser keywords in the first
/// `scan_limit` seconds, then looks for the first long silence gap (>2s) after
/// those keywords as the end of the intro jingle/music.
fn detect_keyword_intro(transcript: &Transcript, scan_limit: f64) -> f64 {
    let defaults = crate::rag::VocabCache::defaults(3600);
    // Use dynamic vocab from cache if available (set via set_vocab_cache)
    // For now use defaults — in future pass SharedVocabCache here
    let intro_keywords = &defaults.intro;
    let mut last_keyword_end = 0.0_f64;

    for seg in &transcript.segments {
        if seg.start_ms as f64 / 1000.0 > scan_limit { break; }
        let text_lower = seg.text.to_lowercase();
        if intro_keywords.iter().any(|kw| text_lower.contains(kw.as_str())) {
            let end_sec = seg.end_ms as f64 / 1000.0;
            if end_sec > last_keyword_end { last_keyword_end = end_sec; }
        }
    }

    if last_keyword_end <= 0.0 { return 0.0; }

    // Look for silence gap after the last keyword (jingle marks end of host intro)
    let silence = transcript.first_long_silence_after(last_keyword_end, 2.0, scan_limit);
    match silence {
        Some(t) => t,
        None    => last_keyword_end + 5.0, // 5s buffer if no gap found
    }
}

/// Inject a visible boundary marker into the compact transcript at `intro_end_sec`.
///
/// The marker tells the LLM exactly where the intro ends so it avoids picking
/// moments before that point.
fn inject_intro_marker(compact: &str, intro_end_sec: f64) -> String {
    let marker = format!(
        "━━━ CONTENT STARTS HERE (t={:.0}s) — DO NOT pick moments before this line ━━━",
        intro_end_sec
    );

    let mut result   = String::with_capacity(compact.len() + marker.len() + 2);
    let mut inserted = false;

    for line in compact.lines() {
        if !inserted {
            if let Some(ts) = parse_compact_timestamp(line) {
                if ts >= intro_end_sec {
                    result.push_str(&marker);
                    result.push('\n');
                    inserted = true;
                }
            }
        }
        result.push_str(line);
        result.push('\n');
    }

    // If we never inserted (all timestamps < intro_end_sec), append at end
    if !inserted {
        result.push_str(&marker);
        result.push('\n');
    }

    result
}

// ── RAG helpers ─────────────────────────────────────────────────────────

/// Query Supabase untuk past moments yang mirip dan format sebagai prompt context block.
/// Returns `None` saat RAG dinonaktifkan, tidak dikonfigurasi, atau ada error.
async fn build_rag_context(
    transcript_text: &str,
    keywords:        &[String],
    language:        &str,
    config:          &crate::config::AppConfig,
) -> Option<String> {
    let cfg = &config.vector_db;
    if !cfg.enabled || cfg.supabase_url.is_empty() {
        return None;
    }

    // Bangun EmbedConfig dari AppConfig — menentukan provider, model, dan API key
    let embed_cfg = crate::rag::embed::EmbedConfig::from_app_config(config);
    if !embed_cfg.is_valid() {
        tracing::debug!(
            "rag: embed provider '{}' tidak valid atau API key tidak di-set — skip retrieval",
            embed_cfg.provider
        );
        return None;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    // Bangun query embedding dari transcript snippet + keywords
    let query_text = crate::rag::embed::context_to_embed_text(
        transcript_text, keywords, language,
    );
    let embedding = crate::rag::embed::embed_text_with_config(
        &query_text, &embed_cfg, &client,
    ).await?;

    tracing::info!(
        "  🧠 RAG: embedding via '{}' ({} dims)",
        embed_cfg.provider, embedding.len()
    );

    let store = match crate::rag::RagStore::new(&cfg.supabase_url).await {
        Ok(s)  => s,
        Err(e) => { tracing::warn!("rag: cannot connect to Supabase: {e}"); return None; }
    };

    let similar = store.retrieve_similar(
        &embedding,
        cfg.retrieval_count as i64,
        cfg.similarity_threshold,
        None,
    ).await.ok()?;

    if similar.is_empty() {
        tracing::debug!("rag: tidak ada past moments yang mirip");
        return None;
    }

    tracing::info!(
        "  🧠 RAG: retrieved {} similar past moments (top similarity: {:.2})",
        similar.len(), similar.first().map(|m| m.similarity).unwrap_or(0.0)
    );

    let block = crate::rag::RagStore::format_for_prompt(&similar);
    Some(block)
}

/// Store finalized moments ke Supabase dalam background task (non-blocking).
fn store_moments_to_rag(
    moments:    Vec<crate::analyze::schema::ViralMoment>,
    cfg:        crate::config::VectorDbConfig,
    embed_cfg:  crate::rag::embed::EmbedConfig,
    job_id:     String,
) {
    if !cfg.enabled || cfg.supabase_url.is_empty() || !embed_cfg.is_valid() {
        return;
    }

    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();

        // Hitung embeddings untuk semua moments
        let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(moments.len());
        for m in &moments {
            let text = crate::rag::embed::moment_to_embed_text(m);
            let emb  = crate::rag::embed::embed_text_with_config(&text, &embed_cfg, &client)
                .await
                .unwrap_or_default();
            embeddings.push(emb);
        }

        tracing::info!(
            "  🧠 RAG: menyimpan {} moments via provider '{}'",
            moments.len(), embed_cfg.provider
        );

        // Connect dan store
        match crate::rag::RagStore::new(&cfg.supabase_url).await {
            Ok(store) => {
                match store.store_moments(
                    &moments, &embeddings,
                    &job_id, "", "", "id",
                ).await {
                    Ok(n)  => tracing::info!("  🧠 RAG: stored {n} moments to Supabase"),
                    Err(e) => tracing::warn!("rag: storage failed: {e}"),
                }
            }
            Err(e) => tracing::warn!("rag: cannot connect for storage: {e}"),
        }
    });
}

fn build_scored_transcript(transcript_text: &str, keywords: &[String]) -> String {
    if keywords.is_empty() {
        return transcript_text.to_owned();
    }

    transcript_text.lines().map(|line| {
        let line_lower = line.to_lowercase();
        let matching: Vec<&str> = keywords.iter()
            .filter(|kw| line_lower.contains(kw.to_lowercase().as_str()))
            .map(|kw| kw.as_str())
            .collect();

        if matching.is_empty() {
            line.to_owned()
        } else {
            // Cap at 3 keywords per line to keep markers concise
            let label = matching.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            format!("[🎯 {label}]{line}")
        }
    }).collect::<Vec<_>>().join("\n")
}

/// User prompt that includes a keyword focus section.
fn user_prompt_with_focus(
    title: &str,
    duration_secs: f64,
    transcript: &str,
    max_clips: usize,
    focus_keywords: &[String],
) -> String {
    use super::prompt::user_prompt;
    let base = user_prompt(title, duration_secs, transcript, max_clips);

    if focus_keywords.is_empty() {
        return base;
    }

    let kw_list = focus_keywords.iter().take(8)
        .map(|k| format!("\"{}\"", k))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "{base}

━━━ KEYWORD FOCUS ━━━
The following keywords are HIGH PRIORITY for this analysis: {kw_list}
Lines marked with [🎯 keyword] in the transcript above CONTAIN these keywords.
STRONGLY PREFER clips that include or are closely related to these keywords.
If a [🎯] segment is part of a compelling moment, always include it.
━━━━━━━━━━━━━━━━━━━━━"
    )
}

fn trim_to_char_limit(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_owned();
    }
    // Cut at the last newline before max_chars
    let cut = text[..max_chars].rfind('\n').unwrap_or(max_chars);
    format!("{}\n[...transcript truncated to fit token limit]", &text[..cut])
}

fn strip_markdown_fences(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("```json").unwrap_or(s);
    let s = s.strip_prefix("```").unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s);
    s.trim().to_owned()
}

const MIN_CLIP_SECS: f64 = 30.0;
const MAX_CLIP_SECS: f64 = 120.0;

fn validate_and_clamp(list: &mut ViralMomentList, duration_secs: f64) {
    for m in &mut list.moments {
        m.start_sec = m.start_sec.max(0.0).min(duration_secs);
        m.end_sec   = m.end_sec.max(0.0).min(duration_secs);

        // Enforce minimum 30 s — clips shorter than this rarely retain viewers
        if m.end_sec - m.start_sec < MIN_CLIP_SECS {
            m.end_sec = (m.start_sec + MIN_CLIP_SECS).min(duration_secs);
        }
        // Enforce maximum 120 s — beyond this, completion rate drops sharply
        if m.end_sec - m.start_sec > MAX_CLIP_SECS {
            m.end_sec = m.start_sec + MAX_CLIP_SECS;
        }
    }
}
