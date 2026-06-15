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
use super::trending::{extract_keywords, extract_keywords_llm, fetch_trending_with_keywords, TrendingContext};
use crate::rag::embed::{context_to_embed_text, embed_text, embed_text_with_config, moment_to_embed_text, EmbedConfig};
use crate::rag::{RagStore, SimilarMoment};
use super::provider::LlmProvider;
use super::schema::{ViralMoment, ViralMomentList};
use super::vision::{
    build_enriched_transcript, cleanup_frames, describe_video_frames,
    detect_scene_boundaries, extract_frames, parse_compact_timestamp, VisualAnalyzer,
    VideoDescription,
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
        video_title:     &str,
        video_channel:   &str,
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
        // Priority:
        //   1. User CLI keywords (--keywords) — explicit overrides
        //   2. LLM-extracted keywords from transcript (primary auto method)
        //   3. Frequency-based fallback (if LLM fails)
        let full_transcript_text: String = transcript.segments
            .iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");

        // ── Try LLM-based keyword extraction first ────────────────────────────
        let compact_for_kw = transcript.to_compact_prompt_lines();
        let pb_kw = spinner("Extracting focus keywords from transcript (LLM)…");
        let llm_keywords = extract_keywords_llm(
            provider.as_ref(),
            video_title,
            video_channel,
            &compact_for_kw,
            12,
        ).await;
        pb_kw.finish_and_clear();

        // ── Frequency-based fallback (when LLM returns nothing) ───────────────
        let auto_keywords = if llm_keywords.is_empty() {
            warn!("LLM keyword extraction returned empty — falling back to frequency-based");
            extract_keywords(video_title, &full_transcript_text)
        } else {
            Vec::new()  // not needed when LLM succeeded
        };

        let effective_auto = if llm_keywords.is_empty() { &auto_keywords } else { &llm_keywords };

        // ── Merge: user CLI overrides first, then LLM/auto, deduplicated ─────
        let mut focus_keywords: Vec<String> = user_keywords
            .iter()
            .map(|k| k.to_lowercase())
            .collect();
        for kw in effective_auto {
            let lower = kw.to_lowercase();
            if !focus_keywords.iter().any(|k| k == &lower) {
                focus_keywords.push(lower);
            }
        }

        if !user_keywords.is_empty() {
            info!("  🔑 CLI override keywords  : {}", user_keywords.join(", "));
        }
        if !llm_keywords.is_empty() {
            info!("  🤖 LLM-extracted keywords : {}", llm_keywords.join(", "));
        } else if !auto_keywords.is_empty() {
            info!("  📊 Freq-based keywords    : {}", auto_keywords.join(", "));
        }
        info!("  📌 Total focus keywords   : {} → [{}]",
              focus_keywords.len(), focus_keywords.join(", "));

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
        //
        // vis_descriptions is also kept for post-LLM overlay query enrichment:
        // enrich_moments_from_transcript() uses it to find the nearest frame
        // description at each moment's overlay_at_sec and extract visual keywords.
        let mut vis_descriptions: Vec<VideoDescription> = Vec::new();

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
                vis_descriptions = descriptions;
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

        // ── Outro detection ───────────────────────────────────────────────────
        // Detect where the video outro begins (subscribe CTAs, farewells, end-cards).
        // Inject a marker so the LLM avoids picking moments from that section.
        let outro_start_sec = detect_outro_start(&transcript, self.config.llm.max_clip_end_sec);
        let compact_lines = if outro_start_sec > 0.0 {
            info!(
                "  🎬 Outro detected: skipping from {:.0}s to end ({:.0}s) — injecting boundary marker",
                outro_start_sec, duration_secs
            );
            inject_outro_marker(&compact_lines, outro_start_sec)
        } else {
            compact_lines
        };

        // ── Asset catalog (timestamped SFX & meme cues) ──────────────────────
        // Loaded once; fed to the LLM so it can fill the `asset_cues` field.
        // Missing/invalid catalog ⇒ empty section ⇒ LLM emits no cues (graceful).
        let asset_catalog = super::asset_catalog::AssetCatalog::load(
            &self.config.assets.catalog_path,
        );
        let asset_section = asset_catalog
            .as_ref()
            .map(|c| c.to_prompt_section())
            .unwrap_or_default();
        let asset_valid: std::collections::HashSet<String> = asset_catalog
            .as_ref()
            .map(|c| c.valid_files())
            .unwrap_or_default();

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
            self.analyze_in_chunks(&*provider, &transcript, candidate_count, &trend_ctx, &focus_keywords, outro_start_sec, &asset_section)
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
                if !asset_section.is_empty() {
                    s = format!("{s}{asset_section}");
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

        // ── Validate asset_cues against the catalog (drop unknown files, clamp timing) ──
        if !asset_valid.is_empty() {
            let mut kept = 0usize;
            let mut dropped = 0usize;
            for m in &mut moments.moments {
                let clip_dur = (m.end_sec - m.start_sec).max(0.0);
                let before = m.asset_cues.len();
                m.asset_cues.retain(|c| asset_valid.contains(&c.file));
                for c in &mut m.asset_cues {
                    if c.at_sec < 0.0 { c.at_sec = 0.0; }
                    if clip_dur > 0.0 && c.at_sec > clip_dur { c.at_sec = (clip_dur - 0.5).max(0.0); }
                    if c.duration_sec <= 0.0 { c.duration_sec = 2.0; }
                }
                dropped += before - m.asset_cues.len();
                kept += m.asset_cues.len();
            }
            if kept > 0 || dropped > 0 {
                info!("  🎚️  Asset cues: {kept} placed, {dropped} dropped (unknown file)");
            }
        }

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

        // ── Drop moments that start in or significantly overlap the outro ────────
        // Safety net: even when the LLM saw the outro marker in single-pass mode,
        // it may still pick a moment that starts in the outro (the marker is a hint,
        // not a hard constraint the model always respects).  In chunked mode the
        // chunk loop is capped at outro_start_sec, but guard here too.
        //
        // Two drop conditions:
        //   1. start_sec >= outro_start_sec  — clip starts inside the outro zone
        //   2. >25% of the clip falls in the outro zone
        //      (handles the case where keyword detection fires slightly AFTER the true
        //       outro start, so the clip begins just before the boundary but is mostly outro)
        if outro_start_sec > 0.0 {
            let before = moments.moments.len();
            moments.moments.retain(|m| {
                // Condition 1: starts in outro
                if m.start_sec >= outro_start_sec {
                    info!(
                        "  ⚠️  Dropped outro moment at {:.1}s (outro starts at {:.1}s): \"{}\"",
                        m.start_sec, outro_start_sec, m.title
                    );
                    return false;
                }
                // Condition 2: starts before outro but crosses significantly into it
                let clip_dur = (m.end_sec - m.start_sec).max(1.0);
                let overlap  = (m.end_sec - outro_start_sec).max(0.0);
                let pct      = overlap / clip_dur;
                if pct > 0.25 {
                    info!(
                        "  ⚠️  Dropped outro-overlap moment ({:.0}% in outro zone, \
                         {:.1}s past t={:.1}s): \"{}\"",
                        pct * 100.0, overlap, outro_start_sec, m.title
                    );
                    return false;
                }
                true
            });
            let dropped = before - moments.moments.len();
            if dropped > 0 {
                info!("  🎬 Dropped {} outro moment(s), {} remain", dropped, moments.moments.len());
            }
        }

        if moments.moments.is_empty() {
            tracing::warn!(
                "All moments fell within the outro section (from {:.0}s). \
                 Consider setting max_clip_end_sec manually in config.toml if auto-detection \
                 is too aggressive.",
                outro_start_sec
            );
            return Err(AnalyzeError::NoMomentsFound);
        }

        // ── Drop mid-video ceremony segments (content-based) ────────────────
        // Live recordings often have guest roll-calls, applause ceremonies, and
        // MC greetings mid-video (e.g. actual event starts at t=449s). These
        // pass the timestamp-based intro filter but contain zero substantive content.
        let before_ceremony = moments.moments.len();
        moments.moments.retain(|m| {
            if has_ceremony_transcript(&m.transcript_segment) {
                info!(
                    "  🎭 Dropped ceremony segment at {:.1}s: \"{}\"",
                    m.start_sec, m.title
                );
                false
            } else {
                true
            }
        });
        let ceremony_dropped = before_ceremony - moments.moments.len();
        if ceremony_dropped > 0 {
            info!(
                "  🎭 Dropped {} ceremony moment(s), {} remain",
                ceremony_dropped,
                moments.moments.len()
            );
        }

        // ── Snap clip starts forward past filler runs ────────────────────────
        // LLMs sometimes set start_sec on a run of filler words / back-channel
        // acknowledgements ("Ya. Ya. Ya.") before the real content begins.
        // Advance start_sec to the first substantive sentence.
        snap_start_past_fillers(&mut moments.moments, &transcript);

        // ── Snap clip ends to sentence boundaries ────────────────────────────
        // LLMs sometimes pick end_sec mid-sentence. Extend each clip forward
        // to the nearest clean transcript segment boundary.
        snap_end_to_sentence_boundary(&mut moments.moments, &transcript);

        // ── Post-parse enrichment ─────────────────────────────────────────────
        // Cross-check hook/headline against actual transcript text.
        // If the LLM hallucinated the hook (different content from what's spoken
        // at start_sec), replace it with the verbatim first words from the transcript.
        // vis_descriptions: frame-level captions from the vision system (may be empty
        // when vision is disabled). Used to enrich overlay_query with visual keywords.

        // Snapshot LLM-generated queries before enrichment (for debug log)
        let pre_enrich_queries: Vec<String> = moments.moments.iter()
            .map(|m| m.overlay_query.clone())
            .collect();

        enrich_moments_from_transcript(&mut moments.moments, &transcript, &vis_descriptions);

        // Write overlay query debug log — helps diagnose irrelevant overlay results
        write_overlay_debug_log(
            &self.job.analyze_dir().join("overlay_queries.log"),
            &moments.moments,
            &pre_enrich_queries,
            &vis_descriptions,
        ).await;

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
            video_title.to_owned(),
            video_channel.to_owned(),
            self.config.whisper.language.clone(),
        );

        let moments_path = self.job.moments_path();
        let json = serde_json::to_string_pretty(&moments).map_err(|e| {
            AnalyzeError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        })?;
        tokio::fs::write(&moments_path, json)
            .await
            .map_err(AnalyzeError::Io)?;

        // Persist the vision model's per-frame descriptions so the narration stage
        // can ground its script in what's ON SCREEN — essential for raw b-roll whose
        // spoken transcript is near-empty. Best-effort (purely additive).
        if !vis_descriptions.is_empty() {
            if let Ok(j) = serde_json::to_string_pretty(&vis_descriptions) {
                let _ = tokio::fs::write(self.job.video_descriptions_path(), j).await;
                info!("  🎬 Persisted {} visual description(s) → narration context",
                      vis_descriptions.len());
            }
        }

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
        outro_start_sec: f64,  // 0.0 = no outro; >0 = stop chunks at this timestamp
        asset_section: &str,   // annotated asset catalog block ("" = no catalog)
    ) -> Result<ViralMomentList, AnalyzeError> {
        let overlap_secs = 30.0;
        let total_duration = transcript.duration_ms as f64 / 1000.0;
        let duration_mins = total_duration / 60.0;

        // Effective end: cap at outro boundary so we never produce chunks inside the outro.
        // When outro_start_sec == 0.0 the full video is processed as before.
        let effective_end = if outro_start_sec > 0.0 { outro_start_sec } else { total_duration };

        // Adaptive chunk size — longer videos need bigger windows so the LLM sees
        // enough context per chunk and can rank relative quality within each window.
        // Larger chunks also cut total API calls (cost + rate-limit pressure).
        //   < 20 min → 3 min chunks  (~6 chunks)
        //   20-45 min → 4.5 min chunks (~8-10 chunks)
        //   > 45 min → 6 min chunks  (~12 chunks for a 72-min video vs 29 before)
        let mut chunk_size_secs = if duration_mins > 45.0 {
            360.0_f64   // 6 min — long form
        } else if duration_mins > 20.0 {
            270.0_f64   // 4.5 min — medium form
        } else {
            180.0_f64   // 3 min — short form
        };

        // clips_per_chunk scales inversely with chunk count to avoid flooding the
        // candidate pool with early-video content.
        //   Many chunks (>10)  → 2 clips/chunk: balanced pool, temporal diversity relies on bucketing
        //   Few chunks (≤5)    → up to max_clips/2: normal behaviour
        let n_estimated_chunks = ((effective_end - overlap_secs) / (chunk_size_secs - overlap_secs)).ceil() as usize;
        let clips_per_chunk = if n_estimated_chunks > 10 {
            2_usize
        } else if n_estimated_chunks > 5 {
            3_usize
        } else {
            (max_clips / 2).max(2)
        };

        let mut all_moments: Vec<ViralMoment> = Vec::new();
        let mut start = 0.0_f64;

        while start < effective_end {
            let end = (start + chunk_size_secs).min(effective_end);

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
                    "{}\n\n{trend_ctx}\nUse these trends to prioritise relevant moments.{asset_section}",
                    chunk_system_prompt(clips_per_chunk)
                )
            } else {
                format!("{}{asset_section}", chunk_system_prompt(clips_per_chunk))
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
                            // Restart this window with the smaller chunk (respect effective_end)
                            let end2 = (start + chunk_size_secs).min(effective_end);
                            let raw2 = self.get_transcript_window(transcript, start, end2);
                            let chunk2 = build_scored_transcript(&raw2, focus_keywords);
                            let max_chars = (transcript_budget as f64 * 3.5) as usize;
                            let chunk2 = trim_to_char_limit(&chunk2, max_chars);
                            let sys2 = format!("{}{asset_section}", chunk_system_prompt(clips_per_chunk));
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

            if end >= effective_end {
                break;
            }
            start = (end - overlap_secs).max(start + 1.0); // advance, never go backward
        }

        // De-duplicate moments that share significant time overlap.
        // Old approach (|start_diff|<10 AND |end_diff|<10) missed cases like
        // clip_000 (357-398s) and clip_001 (378-414s) — start_diff=21 > 10 but
        // they share 20s of content. New approach: use overlap ratio instead.
        all_moments.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap());
        let mut unique_moments: Vec<ViralMoment> = Vec::new();
        for m in all_moments {
            let is_duplicate = unique_moments.iter().any(|existing| {
                clips_overlap_significant(
                    m.start_sec, m.end_sec,
                    existing.start_sec, existing.end_sec,
                )
            });
            if !is_duplicate {
                unique_moments.push(m);
            }
        }

        // ── Temporal-diversity selection ──────────────────────────────────────
        // Pure quality-sort + truncate causes temporal clustering: for a 72-min
        // video the top-10 by keyword score all come from the first 10-15 min
        // because setup/broad-claim content scores higher on keyword frequency
        // than analytical conclusions later in the video.
        //
        // Fix: divide the video into `max_clips` equal-duration buckets and pick
        // the best-scoring moment from each bucket, then fill remaining slots
        // with the next-best from any bucket.  Guarantees full-video coverage.
        //
        // Use effective_end (capped at outro_start_sec) so bucket boundaries are
        // computed relative to the actual content portion of the video, not the
        // full total_duration which includes the outro.
        let selected = select_temporally_diverse(unique_moments, max_clips, effective_end, focus_keywords);

        Ok(ViralMomentList { moments: selected })
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
        super::provider::build_llm_provider(self.config, name)
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
    moments:      &mut Vec<ViralMoment>,
    transcript:   &Transcript,
    descriptions: &[VideoDescription],
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
        // Combines THREE sources (priority order):
        //   1. Visual keywords — extracted from the frame description closest to
        //      overlay_at_sec. Most specific: describes what's literally on screen.
        //   2. Spoken subject keywords — proper nouns from the transcript window.
        //   3. LLM-generated query — kept as the trailing context.
        //
        // When vision is disabled, sources 2+3 still improve query specificity.
        // Overlay style is preserved as-is: the LLM's explicit choice is correct,
        // and detect_overlay_style() in overlay.rs handles "auto" via pixel analysis.
        if !m.overlay_query.is_empty() && m.overlay_at_sec >= 0.0 {
            let peak_t      = m.start_sec + m.overlay_at_sec;
            let window_text = transcript.segment_text_in_window(peak_t, peak_t + 3.5);

            if !window_text.is_empty() {
                m.overlay_context_text = window_text.clone();
            }

            // Source 1: visual keywords from nearest frame description
            let visual_note = find_nearest_description(descriptions, peak_t)
                .map(|d| d.text.as_str())
                .unwrap_or("");
            let visual_kws = extract_visual_keywords(visual_note);

            // Source 2: spoken subject keywords (proper nouns / entities)
            let spoken_kws = if window_text.is_empty() {
                Vec::new()
            } else {
                extract_subject_keywords(&window_text)
            };

            let llm_query_is_meme = is_meme_query(&m.overlay_query);

            if llm_query_is_meme {
                tracing::warn!(
                    "  🎬 Overlay: LLM returned generic meme query \"{}\" — replacing with context keywords",
                    m.overlay_query
                );
            }

            // Build refined query when we have context OR when LLM used a meme query.
            // When LLM used a meme query, we DISCARD it entirely and use only visual+spoken keywords.
            // When LLM used a topic-relevant query, we PREPEND visual+spoken then APPEND LLM words.
            if !visual_kws.is_empty() || !spoken_kws.is_empty() || llm_query_is_meme {
                let mut parts: Vec<String> = Vec::new();
                for kw in visual_kws.iter().chain(spoken_kws.iter()) {
                    if !parts.iter().any(|p: &String| p.to_lowercase().contains(&kw.to_lowercase())) {
                        parts.push(kw.clone());
                    }
                }
                if !llm_query_is_meme {
                    // Topic-relevant LLM query: append its words not already covered
                    for word in m.overlay_query.split_whitespace() {
                        let w = word.to_lowercase();
                        if w.len() >= 4 && !parts.iter().any(|p| p.to_lowercase().contains(&w)) {
                            parts.push(w);
                        }
                    }
                }
                // Meme query: LLM words are fully discarded; only visual+spoken context survives.

                if !parts.is_empty() {
                    let refined: String = parts.join(" ").chars().take(60).collect();

                    if refined != m.overlay_query {
                        tracing::info!(
                            "  🎬 Overlay refined: \"{}\" → \"{}\"  visual=\"{}\"  spoken=\"{}\"",
                            m.overlay_query,
                            refined,
                            visual_note.chars().take(50).collect::<String>(),
                            window_text.chars().take(50).collect::<String>(),
                        );
                        m.overlay_query = refined;
                    }
                }
            }
        }
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

/// Write a human-readable overlay query debug log to `path`.
///
/// Records every moment's overlay intent — LLM-generated query, post-enrichment
/// query, style, timing, spoken context, and nearest visual frame description.
/// Use this file to diagnose irrelevant or stale cached overlay clips.
async fn write_overlay_debug_log(
    path:         &Path,
    moments:      &[crate::analyze::schema::ViralMoment],
    pre_queries:  &[String],
    descriptions: &[VideoDescription],
) {
    use std::fmt::Write as _;

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC");
    let mut log = String::with_capacity(2048);

    let _ = writeln!(log, "OVERLAY QUERY DEBUG LOG");
    let _ = writeln!(log, "Generated : {now}");
    let _ = writeln!(log, "Moments   : {}", moments.len());
    let _ = writeln!(log, "{}", "═".repeat(64));

    let has_overlays = moments.iter().any(|m| !m.overlay_query.is_empty());
    if !has_overlays {
        let _ = writeln!(log, "\n(no overlay queries generated for any moment)");
    }

    for (i, m) in moments.iter().enumerate() {
        let orig = pre_queries.get(i).map(|s| s.as_str()).unwrap_or("");
        let peak_t = m.start_sec + m.overlay_at_sec;
        let visual = find_nearest_description(descriptions, peak_t)
            .map(|d| d.text.clone())
            .unwrap_or_default();

        let _ = writeln!(log);
        let _ = writeln!(log, "[{}/{}] \"{}\"", i + 1, moments.len(), m.title);
        let _ = writeln!(log, "  clip range     : {:.1}s – {:.1}s  ({:.0}s)", m.start_sec, m.end_sec, m.duration());

        if m.overlay_query.is_empty() {
            let _ = writeln!(log, "  overlay_query  : (none — no overlay for this clip)");
        } else {
            let _ = writeln!(log, "  overlay at     : clip+{:.1}s  (abs {:.1}s)  show {:.1}s",
                m.overlay_at_sec, peak_t, m.overlay_duration);
            let _ = writeln!(log, "  LLM query      : \"{}\"", orig);
            if m.overlay_query != orig {
                let _ = writeln!(log, "  refined query  : \"{}\"  ← visual+spoken enrichment", m.overlay_query);
            } else {
                let _ = writeln!(log, "  refined query  : (unchanged)");
            }
            let _ = writeln!(log, "  overlay_style  : \"{}\"  position: \"{}\"",
                m.overlay_style, m.overlay_position);
            if !m.overlay_context_text.is_empty() {
                let ctx = m.overlay_context_text.chars().take(100).collect::<String>();
                let _ = writeln!(log, "  spoken context : \"{}{}\"",
                    ctx, if m.overlay_context_text.len() > 100 { "…" } else { "" });
            }
            if !visual.is_empty() {
                let vis = visual.chars().take(120).collect::<String>();
                let _ = writeln!(log, "  visual@peak    : \"{}{}\"",
                    vis, if visual.len() > 120 { "…" } else { "" });
            } else {
                let _ = writeln!(log, "  visual@peak    : (no frame description near {:.1}s)", peak_t);
            }

            // Cache key — same hash used by overlay.rs to determine cache filename
            let hash = format!("{:x}", md5::compute(m.overlay_query.to_lowercase().trim().as_bytes()));
            let _ = writeln!(log, "  cache key      : {hash}_*.mp4");
        }
        let _ = writeln!(log, "  {}", "─".repeat(60));
    }

    let _ = writeln!(log);
    let _ = writeln!(log,
        "NOTE: If cached overlays look wrong, delete the matching overlay_cache/<hash>_*.mp4 \
         file and re-run. Query changes only take effect when the cache file is absent."
    );

    match tokio::fs::write(path, &log).await {
        Ok(_)  => info!("  📝 Overlay debug log: {}", path.display()),
        Err(e) => warn!("overlay debug log write failed: {e}"),
    }
}

/// Return the `VideoDescription` whose timestamp is closest to `target_sec`,
/// within a ±10-second window. Returns `None` when descriptions is empty or
/// nothing falls within the window.
fn find_nearest_description(descriptions: &[VideoDescription], target_sec: f64) -> Option<&VideoDescription> {
    descriptions.iter()
        .filter(|d| (d.timestamp_sec - target_sec).abs() <= 10.0)
        .min_by(|a, b| {
            let da = (a.timestamp_sec - target_sec).abs();
            let db = (b.timestamp_sec - target_sec).abs();
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// Detect whether an overlay query is a generic meme/reaction phrase with no topic value.
///
/// Called by `enrich_moments_from_transcript` to identify cases where the LLM ignored
/// the RULE 7 ban and returned a reaction phrase instead of a topic-relevant query.
/// When true, the entire LLM query is discarded and replaced with context keywords.
fn is_meme_query(query: &str) -> bool {
    const MEME_SIGNALS: &[&str] = &[
        // English generic reaction
        "reaction face", "shocked face", "shocked reaction", "mind blown",
        "funny fail", "fail reaction", "omg reaction", "wow reaction",
        "amazing reaction", "unbelievable reaction", "viral reaction",
        "laugh reaction", "crying reaction", "surprise reaction",
        // Standalone meme-only words that appear without any topic context
        "reaction tiktok", "reaction viral", "meme reaction", "meme face",
        // Indonesian generic reaction
        "kaget parah", "terkejut banget", "reaksi kaget", "ekspresi kaget",
        "meme lucu", "reaksi viral", "momen lucu", "lucu parah",
        // Generic non-topic words (only flag when the ENTIRE query is these words)
    ];

    let q = query.trim().to_lowercase();
    if q.is_empty() { return false; }

    // Signal 1: query contains a known multi-word meme phrase
    if MEME_SIGNALS.iter().any(|sig| q.contains(sig)) {
        return true;
    }

    // Signal 2: ALL words in the query are generic emotion/reaction words with no topic noun.
    // This catches things like "shocked face viral" or "kaget terkejut parah".
    const GENERIC_WORDS: &[&str] = &[
        "shocked", "reaction", "face", "mind", "blown", "funny", "fail",
        "omg", "wtf", "lol", "wow", "viral", "amazing", "unbelievable",
        "kaget", "terkejut", "lucu", "parah", "banget", "ekspresi", "reaksi",
        "ngakak", "haha", "hehe", "seru", "keren", "gila", "aduh",
    ];
    let words: Vec<&str> = q.split_whitespace().collect();
    if !words.is_empty() && words.iter().all(|w| GENERIC_WORDS.contains(w)) {
        return true;
    }

    false
}

/// Extract searchable visual keywords from a vision-model frame description.
///
/// Talking-head descriptions ("presenter talking to camera") contain no useful
/// scene content for an overlay query, so they return an empty list — the spoken
/// transcript subjects are sufficient in that case.  For everything else (charts,
/// outdoor scenes, events, objects) the function picks the most content-bearing
/// words (≥5 chars, not generic visual stop-words) to include in the search query.
fn extract_visual_keywords(note: &str) -> Vec<String> {
    if note.is_empty() { return Vec::new(); }

    const STOP: &[&str] = &[
        // Visual/camera jargon — useless for search
        "video", "screen", "frame", "image", "camera", "shot", "scene",
        "showing", "visible", "appears", "display", "close-up",
        "background", "foreground", "lighting", "light",
        // People descriptors — too generic
        "person", "people", "woman", "man", "human", "figure",
        "speaking", "talking", "looking", "facing", "wearing", "holding",
        // Common filler adjectives
        "various", "several", "multiple", "large", "small", "clear",
    ];

    let lower = note.to_lowercase();

    // Talking-head heuristic: presenter/host talking straight to camera with
    // no notable background scene → visual adds nothing over spoken keywords.
    let is_talking_head =
        (lower.contains("presenter") || lower.contains("host") || lower.contains("speaker"))
        && (lower.contains("to camera") || lower.contains("facing camera")
            || lower.contains("plain background") || lower.contains("white background")
            || lower.contains("simple background"))
        && !lower.contains("chart") && !lower.contains("graph")
        && !lower.contains("aerial") && !lower.contains("drone")
        && !lower.contains("crowd") && !lower.contains("outdoor")
        && !lower.contains("footage");

    if is_talking_head { return Vec::new(); }

    // Extract content-bearing words: ≥5 chars, not in STOP list
    note.split_whitespace()
        .map(|w| w.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric()).to_owned())
        .filter(|w| w.len() >= 5 && !STOP.contains(&w.as_str()))
        .take(3)
        .collect()
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

// ── Ceremony content detection ───────────────────────────────────────────

/// Returns `true` if the transcript segment text is a ceremony / event-opening segment
/// rather than substantive content — even when it appears mid-video.
///
/// Live recordings (YouTube, talk shows) often contain a second "intro" segment well
/// past the video's actual start: the MC's audience greeting when the live event begins,
/// a guest roll-call, or an applause ceremony for a new panelist. These pass the
/// timestamp-based `intro_end_sec` filter but contain zero viral value.
///
/// Triggers (any one is sufficient):
///   • Applause ceremony: "tepuk tangan buat/untuk/dulu" or ≥ 2 occurrences of "tepuk tangan"
///   • Event MC greeting: "selamat malam/pagi/sore mahasiswa/teman-teman/para hadirin"
///   • Show announcement: "episode khusus", "gost to campus", similar program tags
///   • Guest roll-call: ≥ 3 occurrences of "ada" within a short segment (listing guests)
fn has_ceremony_transcript(text: &str) -> bool {
    let t = text.to_lowercase();

    // ── Applause ceremony ────────────────────────────────────────────────────
    // "tepuk tangan buat/untuk" = welcoming a specific person with applause
    // "tepuk tangan dulu"       = "give applause first" (MC instruction)
    if t.contains("tepuk tangan buat")
        || t.contains("tepuk tangan untuk")
        || t.contains("tepuk tangan dulu")
    {
        return true;
    }
    // Two or more "tepuk tangan" in one segment = applause ceremony (not a metaphor)
    if t.matches("tepuk tangan").count() >= 2 {
        return true;
    }

    // ── Event MC audience greeting ───────────────────────────────────────────
    for phrase in &[
        "selamat malam mahasiswa",
        "selamat malam teman-teman",
        "selamat malam para hadirin",
        "selamat pagi teman-teman",
        "selamat sore teman-teman",
        "selamat malam semua",
    ] {
        if t.contains(phrase) {
            return true;
        }
    }

    // ── Show episode/program announcement ───────────────────────────────────
    for phrase in &["episode khusus", "gost to campus", "go to campus"] {
        if t.contains(phrase) {
            return true;
        }
    }

    // ── Guest roll-call: 3+ "ada [Name]" in one short segment ───────────────
    // e.g. "Ada Pak Arijito... ada Tio... ada Rocky Gerung... ada Isla Bahrawi"
    // Counting raw "ada " occurrences in transcript_segment ≥ 4 is a strong roll-call signal.
    // (Normal conversation rarely uses "ada" 4+ times in a 30s stretch)
    if t.matches(" ada ").count() >= 4 {
        return true;
    }

    false
}

// ── Outro detection ───────────────────────────────────────────────────────────

/// Detect where the video outro begins — subscribe CTAs, farewells, end-cards, music bed.
///
/// Combines TWO independent signals, then returns the EARLIEST that falls inside
/// the scan window (the first hint of outro is the safe boundary).
///
///   Signal 1 — `detect_speech_end_gap_outro`:
///     If the last Whisper segment ends ≥ 8 s before the video's total duration,
///     there is a silent / music-bed section at the end (end-card, credits).
///
///   Signal 2 — `detect_keyword_outro`:
///     First occurrence of a farewell / subscribe-CTA / next-video keyword
///     within the scan window at the tail of the video.
///
/// Scan window: last 15% of the video, capped at 180 s — symmetric with intro's
/// first 15% / 120 s window, but slightly wider because outros can include a
/// sponsor segment before the farewell.
///
/// Returns 0.0 if no outro is detected (callers treat 0.0 as "no outro").
fn detect_outro_start(transcript: &Transcript, max_clip_end_sec_override: f64) -> f64 {
    // Manual override wins — user set it explicitly in config.toml
    if max_clip_end_sec_override > 0.0 { return max_clip_end_sec_override; }

    let total_dur = transcript.duration_ms as f64 / 1000.0;

    // Very short videos (< 2 min) are unlikely to have a meaningful outro section
    if total_dur < 120.0 { return 0.0; }

    // Scan window: last 15%, max 3 minutes
    let scan_window = (total_dur * 0.15).min(180.0);
    let scan_from   = total_dur - scan_window;

    let speech_end = detect_speech_end_gap_outro(transcript, total_dur);
    let kw_start   = detect_keyword_outro(transcript, scan_from);

    // Collect valid signals: must be inside the scan window and before total_dur
    let candidates: Vec<f64> = [speech_end, kw_start]
        .iter()
        .filter(|&&t| t >= scan_from && t < total_dur)
        .copied()
        .collect();

    let outro_start = candidates.iter().cloned().fold(f64::NAN, f64::min);

    tracing::debug!(
        "outro detection: speech_end={:.1}s  keyword={:.1}s  scan_from={:.1}s  → {}",
        speech_end, kw_start, scan_from,
        if outro_start.is_nan() { "none".to_string() } else { format!("{:.1}s", outro_start) }
    );

    if outro_start.is_nan() { 0.0 } else { outro_start }
}

/// Signal 1 — Detect a music/silent section at the tail of the video.
///
/// When a video ends with background music, an end-card jingle, or credits,
/// Whisper produces no transcript segments for that period. If the last speech
/// segment ends significantly before the video's total duration there is an
/// audio-only / silent outro section.
fn detect_speech_end_gap_outro(transcript: &Transcript, total_dur: f64) -> f64 {
    // 8 s is conservative: short music stings are ≤4 s; real end-cards are ≥8 s.
    const MIN_GAP_SEC: f64 = 8.0;

    if let Some(last) = transcript.segments.last() {
        let last_end_sec = last.end_ms as f64 / 1000.0;
        if total_dur - last_end_sec >= MIN_GAP_SEC {
            return last_end_sec;
        }
    }
    0.0
}

/// Signal 2 — Find the first outro keyword in the tail scan window.
///
/// Scans from `scan_from` to the end of the transcript looking for known
/// farewell / CTA / next-video keywords.  Returns the start timestamp of the
/// FIRST segment containing such a keyword (= where the outro begins).
///
/// "First in scan window" is the correct semantics: the moment the host pivots
/// to closing remarks is where substantive content ends.
fn detect_keyword_outro(transcript: &Transcript, scan_from: f64) -> f64 {
    let defaults = crate::rag::VocabCache::defaults(3600);
    let outro_keywords = &defaults.outro;
    let mut first_match = 0.0_f64;

    for seg in &transcript.segments {
        let seg_start = seg.start_ms as f64 / 1000.0;
        if seg_start < scan_from { continue; }

        let text_lower = seg.text.to_lowercase();
        if outro_keywords.iter().any(|kw| text_lower.contains(kw.as_str())) {
            // Return the very first hit — that is where the outro section begins
            if first_match <= 0.0 {
                first_match = seg_start;
                // Do not break — keep scanning; the debug log in detect_outro_start
                // already shows the value, but we don't need later ones here.
                break;
            }
        }
    }

    first_match
}

/// Inject a visible boundary marker into the compact transcript at `outro_start_sec`.
///
/// The marker tells the LLM exactly where the outro begins so it avoids picking
/// moments at or after that point.  Symmetric to `inject_intro_marker()`.
fn inject_outro_marker(compact: &str, outro_start_sec: f64) -> String {
    let marker = format!(
        "━━━ OUTRO STARTS HERE (t={:.0}s) — DO NOT pick moments at or after this line ━━━",
        outro_start_sec
    );

    let mut result   = String::with_capacity(compact.len() + marker.len() + 2);
    let mut inserted = false;

    for line in compact.lines() {
        if !inserted {
            if let Some(ts) = parse_compact_timestamp(line) {
                if ts >= outro_start_sec {
                    result.push_str(&marker);
                    result.push('\n');
                    inserted = true;
                }
            }
        }
        result.push_str(line);
        result.push('\n');
    }

    // If no timestamp ≥ outro_start_sec was found, append marker at the end
    if !inserted {
        result.push_str(&marker);
        result.push('\n');
    }

    result
}

// ── Clip boundary helpers ─────────────────────────────────────────────────

/// Advance start_sec forward past a run of pure filler/back-channel words.
///
/// When the LLM places start_sec at a point where the first words are repeated
/// fillers or acknowledgement responses ("Ya. Ya. Ya. Oke. Iya." before the
/// guest starts speaking), the clip opens with dead air / awkward agreement noise
/// instead of the actual hook.
///
/// This function scans up to `MAX_SKIP_SEC` forward and advances start_sec to
/// the first Whisper segment whose content is NOT exclusively filler words.
/// The clip's total duration is preserved by also advancing end_sec by the same
/// amount (capped at MAX_CLIP_SEC).
fn snap_start_past_fillers(moments: &mut Vec<ViralMoment>, transcript: &Transcript) {
    // Single-word / pure filler segments to skip at clip open.
    // We only skip if ALL words in the segment are fillers — mixed segments are kept.
    const FILLERS: &[&str] = &[
        "ya", "iya", "oke", "ee", "em", "eh", "ah", "oh", "uh", "um", "e",
        "mhm", "mm", "hmm", "hm", "yep", "yup", "ok", "yah",
    ];
    const MAX_SKIP_SEC: f64 = 6.0;   // never skip more than 6s at clip open
    const MAX_CLIP_SEC: f64 = 90.0;

    for m in moments.iter_mut() {
        let orig_start = m.start_sec;
        let scan_end   = (m.start_sec + MAX_SKIP_SEC).min(m.end_sec);

        let start_ms = (m.start_sec * 1000.0) as i64;
        let scan_end_ms = (scan_end * 1000.0) as i64;

        // Walk segments from start_sec forward while they are all-filler
        let mut new_start: Option<f64> = None;
        for seg in &transcript.segments {
            let seg_s = seg.start_ms as i64;
            let seg_e = seg.end_ms   as i64;

            if seg_e <= start_ms  { continue; }     // before clip start
            if seg_s >= scan_end_ms { break; }       // past scan window

            let words: Vec<String> = seg.text
                .split_whitespace()
                .map(|w| w.to_lowercase().trim_matches(|c: char| !c.is_alphabetic()).to_owned())
                .filter(|w| !w.is_empty())
                .collect();

            if words.is_empty() { continue; }

            let all_filler = words.iter().all(|w| FILLERS.contains(&w.as_str()));
            if all_filler {
                // Mark the end of this filler segment as a candidate new start
                new_start = Some(seg.end_ms as f64 / 1000.0);
            } else {
                // First non-filler segment — stop scanning
                break;
            }
        }

        if let Some(ns) = new_start {
            let advance = ns - orig_start;
            if advance > 0.1 {
                let total_sec = transcript.duration_ms as f64 / 1000.0;
                m.start_sec = ns;
                // Shift end_sec forward by the same amount, capped at 90s duration and video end
                let new_end = (m.end_sec + advance)
                    .min(m.start_sec + MAX_CLIP_SEC)
                    .min(total_sec);
                // Only extend end if it doesn't shrink the clip below 10s
                if new_end - m.start_sec >= 10.0 {
                    m.end_sec = new_end;
                }
                info!(
                    "  ✂️  start advanced {:.2}s → {:.2}s (+{:.1}s filler skip): \"{}\"",
                    orig_start, m.start_sec, advance, m.title
                );
            }
        }
    }
}

/// Extend end_sec forward to the nearest clean sentence boundary in the transcript.
///
/// Strategy (in priority order):
///   1. Snap out of mid-segment interior → segment end.
///   2. Look for an inter-segment silence gap ≥ SILENCE_MS within [end_sec, end_sec + MAX_EXTEND].
///      Whisper's VAD inserts gaps at natural breath/pause points, making this the most
///      reliable sentence-boundary signal for conversational speech.
///   3. Fallback: if the last word is a known connector/filler, scan forward segment-by-segment
///      for the first non-connector terminal.
///
/// Clips are never extended past 90 s total duration or the video end.
fn snap_end_to_sentence_boundary(moments: &mut Vec<ViralMoment>, transcript: &Transcript) {
    // Silence gap between consecutive Whisper segments that reliably marks a sentence boundary.
    // 300 ms is the sweet spot for conversational Indonesian: natural breath pauses are ≥300 ms,
    // while mid-sentence micro-pauses rarely exceed 200 ms.
    const SILENCE_MS: i64 = 300;

    // Fallback: words that signal the speaker has NOT finished their sentence.
    const CONNECTORS: &[&str] = &[
        // Indonesian subordinating conjunctions / prepositions / fillers
        "yang", "dan", "atau", "tapi", "tetapi", "namun", "karena",
        "sehingga", "maka", "kalau", "jika", "bila", "apabila", "ketika",
        "untuk", "dengan", "dari", "ke", "pada", "dalam", "oleh",
        "bahwa", "bahkan", "agar", "supaya", "setelah", "sebelum",
        "walaupun", "meskipun", "saat", "sampai", "ini", "itu",
        // Filler / mid-speech sounds Whisper transcribes as words
        "ee", "em", "eh", "ah", "oh", "uh", "um", "e",
        // English connectors
        "and", "but", "or", "so", "because", "although", "while",
        "when", "if", "unless", "until", "that", "which", "who", "as",
    ];

    const MAX_EXTEND_SEC: f64 = 15.0;
    const MAX_CLIP_SEC:   f64 = 90.0;

    // Build a sorted list of (gap_start_ms, gap_end_ms) from consecutive segment pairs.
    // We compute this once outside the moment loop.
    let gaps: Vec<(i64, i64)> = transcript.segments.windows(2)
        .filter_map(|w| {
            let gap = w[1].start_ms as i64 - w[0].end_ms as i64;
            if gap >= SILENCE_MS {
                Some((w[0].end_ms as i64, w[1].start_ms as i64))
            } else {
                None
            }
        })
        .collect();

    for m in moments.iter_mut() {
        let orig_end  = m.end_sec;
        let end_ms    = (m.end_sec * 1000.0) as i64;
        let total_sec = transcript.duration_ms as f64 / 1000.0;
        let max_end   = (m.start_sec + MAX_CLIP_SEC).min(total_sec);

        // ── Step 1: snap out of a segment interior ─────────────────────────
        let mut snapped = false;
        for seg in &transcript.segments {
            let s = seg.start_ms as i64;
            let e = seg.end_ms   as i64;
            if s < end_ms && end_ms < e {
                m.end_sec = (e as f64 / 1000.0).min(max_end);
                snapped = true;
                break;
            }
        }

        // ── Step 2: find nearest silence gap after current end ─────────────
        let look_from_ms  = (m.end_sec * 1000.0) as i64;
        let look_until_ms = ((m.end_sec + MAX_EXTEND_SEC).min(max_end) * 1000.0) as i64;

        let gap_hit = gaps.iter().find(|(gap_s, gap_e)| {
            // Gap must start at or after current end (allow 100 ms overlap for rounding)
            *gap_s >= look_from_ms - 100 && *gap_e <= look_until_ms
        });

        if let Some((gap_start_ms, _)) = gap_hit {
            // Snap to the last segment that ends at or before this gap
            let boundary_sec = *gap_start_ms as f64 / 1000.0;
            if boundary_sec > m.end_sec + 0.05 {
                m.end_sec = boundary_sec.min(max_end);
            }
        } else {
            // ── Step 3: fallback — connector-word scan ─────────────────────
            let cur_end_ms = (m.end_sec * 1000.0) as i64;
            let last_word: Option<String> = transcript.segments.iter()
                .filter(|s| s.end_ms as i64 <= cur_end_ms + 80)
                .last()
                .and_then(|s| s.text.split_whitespace().last()
                    .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase()));

            let is_open = last_word.as_deref().map_or(false, |w| {
                CONNECTORS.contains(&w) || w.len() == 1
            });

            // Also snap if we just snapped into a segment and that segment itself ends on a connector
            let is_open = is_open || (snapped && {
                transcript.segments.iter()
                    .filter(|s| s.end_ms as i64 <= cur_end_ms + 80)
                    .last()
                    .and_then(|s| s.text.split_whitespace().last()
                        .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase()))
                    .as_deref()
                    .map_or(false, |w| CONNECTORS.contains(&w) || w.len() == 1)
            });

            if is_open {
                let look_until = (m.end_sec + MAX_EXTEND_SEC).min(max_end);
                for seg in &transcript.segments {
                    let seg_start = seg.start_ms as f64 / 1000.0;
                    let seg_end   = seg.end_ms   as f64 / 1000.0;
                    if seg_start < m.end_sec - 0.05 { continue; }
                    if seg_end   > look_until        { break; }
                    let last = seg.text.split_whitespace().last()
                        .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase())
                        .unwrap_or_default();
                    if !CONNECTORS.contains(&last.as_str()) && last.len() > 1 {
                        m.end_sec = seg_end.min(max_end);
                        break;
                    }
                }
            }
        }

        if (m.end_sec - orig_end) > 0.05 {
            info!(
                "  ✂️  end_sec adjusted {:.2}s → {:.2}s (+{:.1}s): \"{}\"",
                orig_end, m.end_sec, m.end_sec - orig_end, m.title
            );
        }
    }
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
            "rag: embed provider '{}' invalid or API key not set — skip retrieval",
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
        tracing::debug!("rag: no similar past moments found");
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
    moments:       Vec<crate::analyze::schema::ViralMoment>,
    cfg:           crate::config::VectorDbConfig,
    embed_cfg:     crate::rag::embed::EmbedConfig,
    job_id:        String,
    video_title:   String,
    video_channel: String,
    language:      String,
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
            "  🧠 RAG: storing {} moments — video=\"{}\" channel=\"{}\" via provider '{}'",
            moments.len(), video_title, video_channel, embed_cfg.provider
        );

        // Connect dan store
        match crate::rag::RagStore::new(&cfg.supabase_url).await {
            Ok(store) => {
                match store.store_moments(
                    &moments, &embeddings,
                    &job_id, &video_title, &video_channel, &language,
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

// ── Clip deduplication ────────────────────────────────────────────────────────

/// Returns `true` when two clips share more than 35% of the shorter clip's duration.
///
/// Replaces the old `|start_diff|<10 AND |end_diff|<10` check which missed overlapping
/// clips that differ by more than 10s in start_sec but share large amounts of content
/// (e.g., clip A 357-398s and clip B 378-414s share 20s = 48% of the shorter clip).
fn clips_overlap_significant(a_s: f64, a_e: f64, b_s: f64, b_e: f64) -> bool {
    let overlap_start = a_s.max(b_s);
    let overlap_end   = a_e.min(b_e);
    if overlap_end <= overlap_start { return false; }

    let overlap  = overlap_end - overlap_start;
    let a_dur    = (a_e - a_s).max(0.001);
    let b_dur    = (b_e - b_s).max(0.001);
    let min_dur  = a_dur.min(b_dur);

    // >35% of the shorter clip's duration is shared → treat as duplicate
    overlap / min_dur > 0.35
}

// ── Temporal diversity selection ──────────────────────────────────────────────

/// Select `max_clips` moments with guaranteed temporal coverage of the full video.
///
/// **Problem with pure quality sort**: after aggregating candidates from ~12+ chunks,
/// keyword-frequency sorting picks early-video content disproportionately because:
///   • Intro/setup segments establish the topic → highest keyword density
///   • Later analysis/conclusion segments use the topic without repeating keywords
///   Result: 90% of clips come from the first 30% of a 72-min video.
///
/// **Solution — two-phase bucketed selection**:
///   Phase 1: Divide video into `max_clips` equal time buckets.
///            From each bucket take the highest-scoring moment.
///            This guarantees at least one clip from every 1/max_clips of the video.
///
///   Phase 2: Some buckets may be empty (no moments found by the LLM).
///            Fill remaining slots with the next-best moments from any bucket,
///            sorted by combined quality score (keyword + energy).
///
/// Returns moments sorted chronologically.
fn select_temporally_diverse(
    moments:        Vec<ViralMoment>,
    max_clips:      usize,
    total_duration: f64,
    focus_keywords: &[String],
) -> Vec<ViralMoment> {
    if moments.is_empty() || max_clips == 0 { return moments; }

    // Compute quality score for each moment.
    // Keyword relevance (×5) + energy level (1-3).
    let scores: Vec<i32> = moments.iter().map(|m| {
        let kw: i32 = if focus_keywords.is_empty() { 0 } else {
            let h = format!("{} {} {}", m.title, m.hook, m.reason).to_lowercase();
            focus_keywords.iter()
                .filter(|k| h.contains(k.to_lowercase().as_str()))
                .count() as i32 * 5
        };
        let en: i32 = match m.energy.to_lowercase().as_str() {
            "high" => 3, "medium" => 2, _ => 1,
        };
        kw + en
    }).collect();

    // Assign each moment to a time bucket
    let bucket_size = total_duration / max_clips as f64;
    let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); max_clips];
    for (i, m) in moments.iter().enumerate() {
        let b = ((m.start_sec / bucket_size) as usize).min(max_clips - 1);
        buckets[b].push(i);
    }

    let mut selected: std::collections::BTreeSet<usize> = Default::default();

    // Phase 1: one best moment per non-empty bucket
    for bucket in &buckets {
        if selected.len() >= max_clips { break; }
        if let Some(&best) = bucket.iter().max_by_key(|&&i| scores[i]) {
            selected.insert(best);
        }
    }

    // Phase 2: fill remaining slots by global quality score
    if selected.len() < max_clips {
        let mut remaining: Vec<usize> = (0..moments.len())
            .filter(|i| !selected.contains(i))
            .collect();
        remaining.sort_by(|&a, &b| scores[b].cmp(&scores[a]));
        for idx in remaining {
            if selected.len() >= max_clips { break; }
            selected.insert(idx);
        }
    }

    // Collect and sort chronologically
    let mut result: Vec<ViralMoment> = selected.into_iter()
        .map(|i| moments[i].clone())
        .collect();
    result.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap_or(std::cmp::Ordering::Equal));

    info!(
        "  🗺  Temporal selection: {} candidates → {} clips spread across {:.0} min",
        moments.capacity().max(result.len()),  // note: moments was consumed
        result.len(),
        total_duration / 60.0,
    );
    for (i, m) in result.iter().enumerate() {
        let pct = m.start_sec / total_duration * 100.0;
        info!("        [{}/{}] {:.0}s ({:.0}%) — \"{}\"", i + 1, result.len(), m.start_sec, pct, m.title);
    }

    result
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

        // ── Headline sanitization ─────────────────────────────────────────────
        // Enforce the 44-char hard limit so `wrap_headline()` never silently
        // drops words.  Also strips surrounding quotes that LLMs sometimes add.
        m.headline = sanitize_headline(&m.headline);
    }
}

/// Trim whitespace / surrounding quotes, then enforce the 44-char hard limit.
///
/// If the raw headline exceeds `HEADLINE_MAX_CHARS`, it is truncated at the last
/// word boundary that still fits — no trailing "…" (all-caps headlines look
/// cleaner without it; truncation ideally never happens if the prompt is obeyed).
///
/// The 44-char limit matches the `wrap_headline()` capacity in `ffmpeg.rs`
/// (2 lines × ~22 chars).  If the limit here and there ever diverge, this
/// function is the authoritative gate.
fn sanitize_headline(raw: &str) -> String {
    const HEADLINE_MAX_CHARS: usize = 44;

    // Strip surrounding quotes and leading/trailing whitespace
    let text = raw
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim();

    if text.len() <= HEADLINE_MAX_CHARS {
        return text.to_owned();
    }

    // Log and truncate at last word boundary that fits within the limit
    tracing::warn!(
        "headline exceeds {HEADLINE_MAX_CHARS} chars ({}), truncating: {:?}",
        text.len(),
        text
    );

    let mut out = String::new();
    for word in text.split_whitespace() {
        let candidate = if out.is_empty() {
            word.to_owned()
        } else {
            format!("{out} {word}")
        };
        if candidate.len() <= HEADLINE_MAX_CHARS {
            out = candidate;
        } else {
            break;
        }
    }

    if out.is_empty() {
        // Single token longer than 44 chars — hard-slice as last resort
        text.chars().take(HEADLINE_MAX_CHARS).collect()
    } else {
        out
    }
}
