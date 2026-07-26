pub mod job;
pub mod ocr;
pub mod state;

use std::{future::Future, path::Path};

use anyhow::{Context, Result};
use futures_util::stream::{self, StreamExt};
use tracing::{info, warn};
use crate::util::progress::{stage_header, elapsed_secs};
use crate::brand;
use uuid::Uuid;

use crate::analyze::AnalyzeService;
use crate::cli::{LlmProviderName, OutputLayout as CliLayout, WhisperModelSize};
use crate::config::AppConfig;
use crate::edit::layout::OutputLayout;
use crate::edit::{AudioOptions, EditService};
use crate::execution::JobExecutionContext;
use crate::ingest::content_search::{
    OCR_ANALYZER_VERSION, OCR_SCHEMA_VERSION, configured_ocr_model, validate_main_ocr,
};
use crate::ingest::IngestService;
use crate::news::EnrichService;
use crate::transcribe::TranscribeService;
use crate::util::fs::ensure_dir;

use job::JobContext;
use state::{
    OcrStageResult, PipelineState, invalidate_after_ocr_rerun, ocr_is_fresh,
};

/// Pick nested (`JobContext::new`, CLI default) vs flat (`JobContext::new_flat`,
/// server-injected id) job root construction. Pulled out of `run()` so this
/// selection is unit-testable without spinning up the full pipeline (network/ffmpeg IO).
fn build_job_context(job_id_override: Option<&str>, job_id: String, output_dir: &Path) -> Result<JobContext> {
    if job_id_override.is_some() {
        JobContext::new_flat(job_id, output_dir.to_owned())
    } else {
        JobContext::new(job_id, output_dir.to_owned())
    }
}

async fn run_cooperative_stage<T, F, Fut>(
    execution: &JobExecutionContext,
    stage: F,
) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    execution.check_cancelled()?;
    let result = stage().await?;
    execution.check_cancelled()?;
    Ok(result)
}

fn persist_ocr_analysis(base_dir: &Path, analysis: &ocr::OcrAnalysis) -> Result<()> {
    let mut context = ocr::load_main_context_for_ocr(base_dir)?;
    ocr::apply_analysis(&mut context, analysis)?;
    ocr::save_main_context_atomic(base_dir, &context)
}

fn preflight_edit_ocr(base_dir: &Path) -> Result<()> {
    let context = ocr::load_main_context_for_ocr(base_dir)?;
    validate_main_ocr(&context)?;
    crate::edit::enrichment::preflight_ocr(base_dir)
}

pub struct PipelineRunner<'a> {
    config: &'a AppConfig,
    execution: &'a JobExecutionContext,
}

impl<'a> PipelineRunner<'a> {
    pub fn new(config: &'a AppConfig, execution: &'a JobExecutionContext) -> Self {
        Self { config, execution }
    }

    pub async fn run(
        &self,
        url: &str,
        output_dir: &Path,
        provider: &LlmProviderName,
        model: &WhisperModelSize,
        max_clips: usize,
        layout: &CliLayout,
        focus_keywords: &[String],
        audio_opts: &AudioOptions,
        social_name:        &str,
        resume_id:          Option<&str>,
        style_profile_name: &str,
        job_id_override:    Option<&str>,
    ) -> Result<Vec<std::path::PathBuf>> {
        ensure_dir(output_dir)?;

        // Create or load job state. An injected id (server) also selects a FLAT
        // root; a bare CLI run mints a uuid and nests under `.thoth/<id>`.
        let job_id = job_id_override
            .or(resume_id)
            .map(|s| s.to_owned())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let job = build_job_context(job_id_override, job_id.clone(), output_dir)
            .context("failed to create job directories")?;

        let mut state = if resume_id.is_some() && job.state_path().exists() {
            let s = PipelineState::load(&job.state_path()).context("failed to load pipeline state")?;
            info!("resuming job {job_id}");
            s
        } else {
            PipelineState::new(job_id.clone(), url.to_owned())
        };

        // ── Stage 1: Ingest ──────────────────────────────────────────────
        self.execution.check_cancelled()?;
        if state.stages.ingest.is_none() {
            stage_header(1, 6, "Ingest  (yt-dlp download)");
            let svc = IngestService::new(self.config, &job, self.execution);
            let result = run_cooperative_stage(self.execution, || async {
                svc.run(url, false).await.context("ingest stage failed")
            }).await?;
            state.stages.ingest = Some(result);
            self.execution.check_cancelled()?;
            state.save(&job.state_path())?;
            self.execution.check_cancelled()?;
        } else {
            info!("Stage 1/6: Ingest — skipped (already complete)");
        }
        self.execution.check_cancelled()?;

        // Clone fields out of ingest result before further borrows
        let ingest = state.stages.ingest.as_ref().unwrap();
        let video_path    = ingest.video_path.clone();
        let video_title   = ingest.title.clone();
        let video_channel = ingest.channel.clone();
        let video_duration = ingest.duration_secs;

        // ── Stage 2: OCR ────────────────────────────────────────────────
        self.execution.check_cancelled()?;
        let source_fingerprint =
            ocr::source_fingerprint(&video_path).context("local OCR stage failed")?;
        let expected_model = configured_ocr_model();
        let persisted_context = ocr::load_main_context_for_ocr(&job.base_dir).ok();
        if ocr_is_fresh(
            state.stages.ocr.as_ref(),
            &source_fingerprint,
            persisted_context.as_ref(),
            &expected_model,
        ) {
            info!("Stage 2/6: OCR — skipped (current analysis already complete)");
        } else {
            stage_header(2, 6, "OCR  (local Scout + DeepSeek)");
            let analysis = run_cooperative_stage(self.execution, || async {
                ocr::run_local_ocr(self.execution, &video_path).await
            })
            .await
            .context("local OCR stage failed")?;
            persist_ocr_analysis(&job.base_dir, &analysis)
                .context("local OCR stage failed")?;
            state.stages.ocr = Some(OcrStageResult {
                status: analysis.ocr_status,
                schema_version: OCR_SCHEMA_VERSION,
                analyzer_version: OCR_ANALYZER_VERSION.into(),
                model: expected_model,
                source_fingerprint,
                completed_at: chrono::Utc::now(),
            });
            invalidate_after_ocr_rerun(&mut state);
            self.execution.check_cancelled()?;
            state.save(&job.state_path())?;
            self.execution.check_cancelled()?;
        }
        self.execution.check_cancelled()?;

        // ── Stage 3: Transcribe ──────────────────────────────────────────
        self.execution.check_cancelled()?;
        if state.stages.transcribe.is_none() {
            stage_header(3, 6, "Transcribe  (Groq Whisper API)");
            info!("  Video   : \"{}\"  ({:.0}s)", video_title, video_duration);
            let svc = TranscribeService::new(self.config, &job, self.execution);
            let result = run_cooperative_stage(self.execution, || async {
                svc.run(&video_path, &model.to_string()).await.context("transcribe stage failed")
            }).await?;
            state.stages.transcribe = Some(result);
            self.execution.check_cancelled()?;
            state.save(&job.state_path())?;
            self.execution.check_cancelled()?;
        } else {
            info!("Stage 3/6: Transcribe — skipped (already complete)");
        }
        self.execution.check_cancelled()?;

        // ── Stage 4: Analyze ─────────────────────────────────────────────
        self.execution.check_cancelled()?;
        if state.stages.analyze.is_none() {
            stage_header(4, 6, &format!("Analyze  ({} LLM)", provider));
            let svc = AnalyzeService::new(self.config, &job, self.execution);
            let result = run_cooperative_stage(self.execution, || async {
                svc.run(
                    &job.transcript_path(),
                    &provider.to_string(),
                    max_clips,
                    focus_keywords,
                    Some(&video_path),   // enables visual frame analysis
                    &video_title,
                    &video_channel,
                )
                .await
                .context("analyze stage failed")
            }).await?;
            state.stages.analyze = Some(result);
            self.execution.check_cancelled()?;
            state.save(&job.state_path())?;
            self.execution.check_cancelled()?;
        } else {
            info!("Stage 4/6: Analyze — skipped (already complete)");
        }
        self.execution.check_cancelled()?;

        // ── Stage 5: Enrich  (news + reaction) ───────────────────────────
        self.execution.check_cancelled()?;
        if state.stages.enrich.is_none() && self.config.news.enabled {
            stage_header(5, 6, "Enrich  (news search)");
            let svc = EnrichService::new(self.config, &job, self.execution);
            match run_cooperative_stage(self.execution, || async {
                svc.run(
                    &job.moments_path(),
                    &job.transcript_path(),
                    &video_title,
                    &video_channel,
                    &provider.to_string(),
                )
                .await
                .context("enrich stage failed")
            }).await
            {
                Ok(result) => {
                    state.stages.enrich = Some(result);
                    self.execution.check_cancelled()?;
                    state.save(&job.state_path())?;
                    self.execution.check_cancelled()?;
                }
                // Enrichment is best-effort — never fail the whole pipeline over it.
                Err(e) => {
                    if e.downcast_ref::<crate::execution::Cancelled>().is_some() {
                        return Err(e);
                    }
                    warn!("Stage 5/6: Enrich failed — continuing without news: {e}");
                }
            }
        } else if state.stages.enrich.is_none() {
            info!("Stage 5/6: Enrich — skipped (news disabled)");
        } else {
            info!("Stage 5/6: Enrich — skipped (already complete)");
        }
        self.execution.check_cancelled()?;
        preflight_edit_ocr(&job.base_dir)
            .context("OCR preflight before narration/edit failed")?;

        // ── Stage 5.5: Narration  (narrator-driven spine) ────────────────
        // Generate ONE continuous narrator voiceover (+ word timings) that the
        // edit builds the video around. Best-effort: never fails the pipeline.
        if self.config.narration.enabled && !job.narration_mp3().exists() {
            self.execution.check_cancelled()?;
            stage_header(5, 6, "Narration  (narrator voiceover)");
            match self.generate_narration(&job, provider).await {
                Ok(()) => {}
                Err(e) => warn!("Narration failed — continuing without narrator: {e}"),
            }
            self.execution.check_cancelled()?;
        }

        // ── Stage 6: Edit ────────────────────────────────────────────────
        self.execution.check_cancelled()?;
        if state.stages.edit.is_none() {
            stage_header(6, 6, &format!("Edit  (FFmpeg {layout} clips)"));
            let svc = EditService::new(self.config, &job, self.execution);
            let out_layout = OutputLayout::from(layout);

            let result = run_cooperative_stage(self.execution, || async {
                svc.run(
                    &video_path,
                    &job.moments_path(),
                    &job.transcript_path(),
                    &out_layout,
                    audio_opts,
                    &video_channel,
                    social_name,
                    style_profile_name,
                )
                .await
                .context("edit stage failed")
            }).await?;
            state.stages.edit = Some(result);
            self.execution.check_cancelled()?;
            state.save(&job.state_path())?;
            self.execution.check_cancelled()?;
        } else {
            info!("Stage 6/6: Edit — skipped (already complete)");
        }
        self.execution.check_cancelled()?;

        let edit = state.stages.edit.as_ref().unwrap();
        let paths: Vec<_> = edit.output_clips.iter().map(|c| c.path.clone()).collect();

        let p = brand::p();
        eprintln!(
            "\n  {}{}{}  {}done{} {}{}{} {}{} clip(s){} {}{}{} {}{:.1}s{}",
            p.gold, brand::FEATHER, p.reset,
            p.gold, p.reset,
            p.dim, brand::DOT, p.reset,
            p.violet, paths.len(), p.reset,
            p.dim, brand::DOT, p.reset,
            p.gold, elapsed_secs(), p.reset,
        );
        for clip in &edit.output_clips {
            eprintln!(
                "  {}{}{} {}{}{} \"{}\"  {}({:.0}s){}  {}→{}  {}",
                p.violet, brand::SPINE, p.reset,
                p.gold, brand::OK, p.reset,
                clip.title,
                p.dim, clip.duration_secs, p.reset,
                p.dim, p.reset,
                clip.path.display(),
            );
        }
        eprintln!();

        Ok(paths)
    }

    /// Generate the narrator voiceover spine: read the event transcript, ask the
    /// LLM for one continuous commentator script, synthesize it (timed), and save
    /// `narration.mp3` + `narration_words.json`. Best-effort.
    async fn generate_narration(
        &self,
        job: &JobContext,
        provider: &LlmProviderName,
    ) -> Result<()> {
        use crate::transcribe::model::Transcript;

        let raw = tokio::fs::read_to_string(job.transcript_path())
            .await
            .context("read transcript for narration")?;
        let transcript: Transcript =
            serde_json::from_str(&raw).context("parse transcript for narration")?;
        let main_text = transcript
            .segments.iter().map(|s| s.text.as_str())
            .collect::<Vec<_>>().join(" ");

        // Build the narration SOURCE from every real story signal scout gives
        // us — not the spoken audio alone. Raw b-roll (e.g. a 29s arrest clip) has a
        // near-empty transcript, so the title + platform caption + top viral
        // comments carry the actual topic; feeding only the transcript made the LLM
        // hallucinate an unrelated hook. Order = orientation → facts → sentiment.
        let mut sources: Vec<String> = Vec::new();
        // Audience-discourse synthesis (enrich_context.js) — pushed AFTER the comments so the
        // sentiment reading sits next to the raw comments it explains. Captured here, emitted below.
        let mut discourse_block = String::new();
        if let Some(ctx) = crate::ingest::content_search::load_main_context(&job.base_dir) {
            if !ctx.title.trim().is_empty() {
                sources.push(format!("[Judul]\n{}", ctx.title.trim()));
            }
            if !ctx.description.trim().is_empty() {
                sources.push(format!("[Deskripsi]\n{}", ctx.description.trim()));
            }
            // The real subject(s) — person/org/community scout identified. Naming them
            // explicitly stops the narrator inventing or mislabelling who the story is about.
            if !ctx.figures.is_empty() {
                let lines: Vec<String> = ctx.figures.iter()
                    .filter(|f| !f.name.trim().is_empty())
                    .map(|f| {
                        let mut s = format!("- {}", f.name.trim());
                        if !f.role.trim().is_empty() { s.push_str(&format!(" ({})", f.role.trim())); }
                        if !f.description.trim().is_empty() { s.push_str(&format!(": {}", f.description.trim())); }
                        s
                    })
                    .collect();
                if !lines.is_empty() {
                    sources.push(format!("[Tokoh]\n{}", lines.join("\n")));
                }
            }
            // Resolved cultural references (entities/memes/slang/events) → the narrator sounds
            // informed about what the audience is referencing instead of naive.
            let refs: Vec<String> = ctx.references.iter()
                .filter(|r| !r.term.trim().is_empty() && !r.summary.trim().is_empty())
                .map(|r| {
                    let kind = r.kind.trim();
                    let asof = r.as_of_date.trim();
                    let tail = if asof.is_empty() { String::new() } else { format!(" (per {asof})") };
                    if kind.is_empty() { format!("- {}: {}{}", r.term.trim(), r.summary.trim(), tail) }
                    else { format!("- {} ({}): {}{}", r.term.trim(), kind, r.summary.trim(), tail) }
                })
                .collect();
            if !refs.is_empty() {
                sources.push(format!("[Konteks Budaya]\n{}", refs.join("\n")));
            }
            // Topic Dossier (scout topic_dossier.ts): entitas+relasi+sudut cerita → spine narasi.
            for b in dossier_blocks(&ctx.dossier) {
                sources.push(b);
            }
            // Collective audience reading — emitted after the comments block (see below).
            let d = &ctx.discourse;
            if !d.audience_stance.trim().is_empty() || !d.narration_guidance.trim().is_empty() || !d.trends.is_empty() {
                let mut s = String::from("[Maksud Komentar]");
                if !d.audience_stance.trim().is_empty() {
                    s.push_str(&format!("\nSikap audiens: {}", d.audience_stance.trim()));
                }
                let themes: Vec<&str> = d.themes.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
                if !themes.is_empty() {
                    s.push_str(&format!("\nTema: {}", themes.join("; ")));
                }
                if !d.narration_guidance.trim().is_empty() {
                    s.push_str(&format!("\nArahan narator: {}", d.narration_guidance.trim()));
                }
                let trends: Vec<&str> = d.trends.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
                if !trends.is_empty() {
                    // Style/jargon reference only — explicitly NOT a topic to force.
                    s.push_str(&format!("\nTren diskursus (gaya/jargon yang lagi hidup — pakai bila relevan, JANGAN paksakan ke topik): {}", trends.join(", ")));
                }
                discourse_block = s;
            }
        }
        let mut comments = crate::edit::comment_card::load_comment_pool(&job.base_dir);
        if !comments.is_empty() {
            comments.sort_by(|a, b| b.likes.cmp(&a.likes)); // most-liked first
            let lines: Vec<String> = comments.iter().take(12)
                .map(|c| {
                    let head = if c.likes > 0 {
                        format!("- {} ({} like): {}", c.author, c.likes, c.text)
                    } else {
                        format!("- {}: {}", c.author, c.text)
                    };
                    // Attach the decoded subtext so the narrator reads sarcasm/coded refs correctly.
                    if c.context.trim().is_empty() { head }
                    else { format!("{head}  [maksud: {}]", c.context.trim()) }
                })
                .collect();
            sources.push(format!("[Komentar Netizen Teratas]\n{}", lines.join("\n")));
        }
        if !discourse_block.is_empty() {
            sources.push(discourse_block);
        }

        // Vision model's account of what's literally ON SCREEN (analyze stage,
        // `describe_video`). For raw b-roll this is the only objective record of the
        // event itself — feed it so the narrator describes what actually happens.
        if let Ok(raw) = std::fs::read_to_string(job.video_descriptions_path()) {
            if let Ok(descs) = serde_json::from_str::<Vec<crate::analyze::VideoDescription>>(&raw) {
                let lines: Vec<String> = descs.iter()
                    .filter(|d| !d.text.trim().is_empty())
                    .take(20) // keep the prompt tight
                    .map(|d| format!("- [{:.0}s] {}", d.timestamp_sec, d.text.trim()))
                    .collect();
                if !lines.is_empty() {
                    sources.push(format!("[Deskripsi Visual]\n{}", lines.join("\n")));
                }
            }
        }

        // Analysis results (analyze stage): the ranked viral angles + each moment's
        // vision note. Gives the narrator the "why this matters" framing.
        if let Ok(raw) = std::fs::read_to_string(job.moments_path()) {
            if let Ok(list) = serde_json::from_str::<crate::analyze::ViralMomentList>(&raw) {
                let lines: Vec<String> = list.moments.iter().take(4).filter_map(|m| {
                    let note = m.visual_score.as_ref().map(|v| v.note.trim()).unwrap_or("");
                    let basis = if !note.is_empty() { note } else { m.reason.trim() };
                    (!basis.is_empty()).then(|| format!("- {basis}"))
                }).collect();
                if !lines.is_empty() {
                    sources.push(format!("[Analisa Momen]\n{}", lines.join("\n")));
                }
            }
        }

        let transcript_has_speech = main_text.split_whitespace().count() >= 8;
        if transcript_has_speech {
            sources.push(format!("[Transkrip Audio]\n{}", main_text.trim()));
        }

        // Enrich with subtitles from related videos in the footage pool (extra
        // angles on the topic) without changing the main video used for the edit.
        let enrich_text = self.fetch_enrichment_texts(&job.base_dir).await?;
        if !enrich_text.is_empty() {
            sources.push(format!("[Video Terkait]\n{}", enrich_text.join("\n\n")));
        }

        if sources.is_empty() {
            anyhow::bail!(
                "no narration source: empty transcript and no scout title/description/comments"
            );
        }
        let source_text = sources.join("\n\n");
        tracing::info!(
            "🎙️  Narration context: {} block(s){}",
            sources.len(),
            if transcript_has_speech { "" } else { " — transcript empty, grounded on title/desc/comments" }
        );

        // Narration may use a more creative model than analyze (e.g. deepseek-v4-flash for natural
        // Indonesian prose) without breaking analyze's structured JSON extraction. Override the
        // ACTIVE provider's model with `[narration] model` when set; provider stays the same.
        let nm = self.config.narration.model.trim().to_string();
        let llm = if nm.is_empty() {
            crate::analyze::provider::build_llm_provider(self.config, &provider.to_string())
        } else {
            let mut cfg = self.config.clone();
            match provider.to_string().as_str() {
                "claude" => cfg.llm.claude_model = nm.clone(),
                "gemini" => cfg.llm.gemini_model = nm.clone(),
                "openai" => cfg.llm.openai_model = nm.clone(),
                "vllm"   => cfg.llm.vllm_model = nm.clone(),
                _         => cfg.llm.novita_model = nm.clone(), // novita & other OpenAI-compat
            }
            tracing::info!("🎙️  Narration model override: {nm} (analyze tetap pakai [llm] model)");
            crate::analyze::provider::build_llm_provider(&cfg, &provider.to_string())
        }
        .map_err(|e| anyhow::anyhow!("narration provider: {e}"))?;

        // RAG: retrieve proven narration STRUCTURES (arc/hook/lessons) from the
        // `narration_structures` corpus and inject them as a reference block so the
        // script imitates what worked. Best-effort; empty when disabled/unavailable.
        let structure_refs = self.build_narration_structure_refs(&source_text).await;

        let narr = crate::narration::produce(
            self.execution,
            llm.as_ref(),
            &source_text,
            &self.config.reaction,
            &self.config.news,
            &job.narration_mp3(),
            &self.config.narration.language,
            self.config.narration.target_secs,
            &structure_refs,
        )
        .await?;

        // Persist word timings for the edit stage.
        let words_json = serde_json::to_string(&narr.words).unwrap_or_else(|_| "[]".into());
        let _ = std::fs::write(job.narration_words(), words_json);
        // Persist the hook line so the edit can use it for the 0–3s headline.
        let _ = std::fs::write(job.narration_dir().join("hook.txt"), &narr.hook);
        // Persist the full narration script so the structure verifier
        // (scripts/narration/verify_narration_structure.py) can check it against the corpus.
        let _ = std::fs::write(job.narration_dir().join("narration.txt"), &narr.text);
        Ok(())
    }

    /// Retrieve proven narration structures from the `narration_structures` Supabase
    /// table (built by `scripts/narration/analyze_narration_structure.py`) most similar to this
    /// video's context, and format them as a reference block for the narrator prompt.
    ///
    /// Gated on `[narration] structure_rag` + a configured `THOTH_SUPABASE_URL` +
    /// a valid embed provider. Independent of `[vector_db] enabled` (moments-RAG).
    /// Returns an empty string on any miss — narration always proceeds.
    async fn build_narration_structure_refs(&self, source_text: &str) -> String {
        let ncfg = &self.config.narration;
        let vdb = &self.config.vector_db;
        if !ncfg.structure_rag || vdb.supabase_url.is_empty() {
            return String::new();
        }
        let embed_cfg = crate::rag::embed::EmbedConfig::from_app_config(self.config);
        if !embed_cfg.is_valid() {
            tracing::debug!("narration RAG: embed provider invalid — skip");
            return String::new();
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();

        // Query embedding from the assembled narration context (topic + sentiment).
        let query_text: String = source_text.chars().take(2000).collect();
        let embedding = match crate::rag::embed::embed_text_with_config(
            &query_text, &embed_cfg, &client,
        ).await {
            Some(e) => e,
            None => { tracing::debug!("narration RAG: embedding failed — skip"); return String::new(); }
        };

        let store = match crate::rag::RagStore::new(&vdb.supabase_url).await {
            Ok(s) => s,
            Err(e) => { tracing::warn!("narration RAG: cannot connect to Supabase: {e}"); return String::new(); }
        };

        let refs = match store.retrieve_narration_structures(
            &embedding,
            ncfg.structure_rag_count as i64,
            ncfg.structure_rag_min_similarity,
        ).await {
            Ok(r) => r,
            Err(e) => { tracing::warn!("narration RAG: retrieval failed: {e}"); return String::new(); }
        };

        if refs.is_empty() {
            tracing::debug!("narration RAG: no reference structures found");
            return String::new();
        }
        tracing::info!(
            "🧠 Narration RAG: {} reference structure(s) injected (top similarity {:.2})",
            refs.len(), refs.first().map(|r| r.similarity).unwrap_or(0.0)
        );
        crate::rag::RagStore::format_narration_refs(&refs)
    }

    /// Fetch subtitle text from enrichment pool YouTube videos to enrich the
    /// narrator's context. Uses yt-dlp `--skip-download --write-auto-sub` which
    /// is very fast (<2s per video). Returns plain text, one entry per video.
    async fn fetch_enrichment_texts(&self, base_dir: &std::path::Path) -> Result<Vec<String>> {
        use crate::ingest::content_search::ContentResult;

        let enrich_path = base_dir.join(crate::edit::enrichment::ENRICHMENT_FILE);
        let raw = match std::fs::read_to_string(&enrich_path) {
            Ok(s) => s,
            Err(_) => return Ok(Vec::new()),
        };
        let pool: Vec<ContentResult> = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(Vec::new()),
        };

        // Take up to N YouTube videos from the pool (skip non-YouTube — subtitle
        // download only works reliably on YouTube).
        let max_extra = self.config.narration.max_enrichment_sources.min(4) as usize;
        let candidates: Vec<&ContentResult> = pool.iter()
            .filter(|r| r.platform == "youtube" && !r.url.is_empty() && r.relevance != "unverified")
            .take(max_extra)
            .collect();

        if candidates.is_empty() { return Ok(Vec::new()); }

        let ytdlp = self.config.ingest.ytdlp_path.clone();
        let execution = self.execution.clone();
        let tmp_root = base_dir.join(".narr_subs");
        let _ = std::fs::create_dir_all(&tmp_root);

        // Konkuren berbatas: 4 yt-dlp subs paralel (cap aman vs platform rate-limit).
        // Tiap kandidat mendapat sub-dir sendiri (tmp_root/<id>) → tidak ada tabrakan file.
        let results: Vec<Option<String>> = stream::iter(candidates.into_iter().cloned())
            .map(|cand| {
                let ytdlp = ytdlp.clone();
                let tmp_root = tmp_root.clone();
                let execution = execution.clone();
                async move {
                    // Sub-dir unik per video → tidak ada tabrakan file
                    let sub_dir = tmp_root.join(&cand.url
                        .chars()
                        .filter(|c| c.is_alphanumeric() || *c == '_')
                        .take(24)
                        .collect::<String>());
                    let _ = std::fs::create_dir_all(&sub_dir);
                    let out_tmpl = sub_dir.join("%(id)s.%(ext)s");

                    let mut cmd = tokio::process::Command::new(&ytdlp);
                    cmd.args([
                        "--skip-download", "--write-auto-sub",
                        "--sub-lang", "id-orig,id,en",
                        "--sub-format", "vtt",
                        "--ignore-errors", "--quiet",
                        "-o", &out_tmpl.to_string_lossy().to_string(),
                        &cand.url,
                    ]);
                    let command_result = execution
                        .output_with_timeout(&mut cmd, std::time::Duration::from_secs(15))
                        .await;
                    if let Err(error) = command_result
                        && crate::execution::is_cancelled(&error)
                    {
                        let _ = std::fs::remove_dir_all(&sub_dir);
                        return Err(error);
                    }

                    // Parse VTT → plain text
                    let result = Self::parse_vtt_dir(&sub_dir).map(|text| {
                        if !text.trim().is_empty() {
                            let label = if !cand.title.is_empty() {
                                format!("[{}]\n{}", cand.title.chars().take(60).collect::<String>(), text)
                            } else {
                                text
                            };
                            tracing::debug!("enrichment sub: {} chars from {}", label.len(), cand.url);
                            Some(label)
                        } else {
                            None
                        }
                    }).flatten();

                    // Bersihkan sub-dir video ini
                    let _ = std::fs::remove_dir_all(&sub_dir);
                    Ok(result)
                }
            })
            .buffer_unordered(4)
            .collect::<Vec<Result<Option<String>>>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>>>()?;

        let _ = std::fs::remove_dir_all(&tmp_root);
        let texts: Vec<String> = results.into_iter().flatten().collect();
        Ok(texts)
    }

    /// Parse all .vtt files in a directory → deduplicated plain text.
    fn parse_vtt_dir(dir: &std::path::Path) -> Option<String> {
        let mut out = String::new();
        let Ok(entries) = std::fs::read_dir(dir) else { return None; };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("vtt") { continue; }
            let Ok(content) = std::fs::read_to_string(&p) else { continue };
            let mut prev = String::new();
            for line in content.lines() {
                let l = line.trim();
                if l.is_empty() || l.starts_with("WEBVTT") || l.starts_with("Kind:")
                    || l.starts_with("Language:") || l.contains("-->") || l.parse::<u64>().is_ok()
                    || l.contains('<') { continue; }
                let clean: String = l.chars().filter(|c| !c.is_control()).collect();
                if clean != prev && !clean.is_empty() {
                    if !out.is_empty() { out.push(' '); }
                    out.push_str(&clean);
                    prev = clean;
                }
            }
        }
        if out.is_empty() { None } else { Some(out) }
    }
}

/// Rakit blok grounding narasi dari Topic Dossier. Hanya emit seksi yang terisi.
fn dossier_blocks(d: &crate::ingest::content_search::Dossier) -> Vec<String> {
    let mut out = Vec::new();
    let ents: Vec<String> = d.entities.iter()
        .filter(|e| !e.term.trim().is_empty() && !e.summary.trim().is_empty())
        .map(|e| {
            let kind = e.kind.trim();
            if kind.is_empty() { format!("- {}: {}", e.term.trim(), e.summary.trim()) }
            else { format!("- {} ({}): {}", e.term.trim(), kind, e.summary.trim()) }
        }).collect();
    let rels: Vec<String> = d.relations.iter().map(|r| r.trim()).filter(|r| !r.is_empty()).map(|r| format!("- {r}")).collect();
    if !ents.is_empty() || !rels.is_empty() {
        let mut s = String::from("[Entitas & Fakta]");
        if !ents.is_empty() { s.push('\n'); s.push_str(&ents.join("\n")); }
        if !rels.is_empty() { s.push_str("\nRelasi:\n"); s.push_str(&rels.join("\n")); }
        out.push(s);
    }
    let angles: Vec<String> = d.angles.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).map(|a| format!("- {a}")).collect();
    if !angles.is_empty() {
        out.push(format!("[Sudut Cerita]\n{}", angles.join("\n")));
    }
    let tl: Vec<String> = d.timeline.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).map(|t| format!("- {t}")).collect();
    if !tl.is_empty() {
        out.push(format!("[Kronologi]\n{}", tl.join("\n")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::dossier_blocks;

    #[test]
    fn dossier_blocks_emits_present_sections_only() {
        use crate::ingest::content_search::{Dossier, Reference};
        let d = Dossier {
            topic: "Kasus X".into(),
            entities: vec![Reference { term: "Nvidia".into(), kind: "org".into(), summary: "chip".into(), as_of_date: String::new(), source_url: String::new() }],
            relations: vec!["A kaitan B".into()],
            angles: vec!["sudut 1".into(), "sudut 2".into()],
            timeline: vec![],
        };
        let blocks = dossier_blocks(&d);
        let joined = blocks.join("\n---\n");
        assert!(joined.contains("[Entitas & Fakta]"));
        assert!(joined.contains("Nvidia"));
        assert!(joined.contains("A kaitan B"));
        assert!(joined.contains("[Sudut Cerita]"));
        assert!(joined.contains("sudut 1"));
        assert!(!joined.contains("[Kronologi]")); // timeline kosong → tak diemit
    }

    #[test]
    fn dossier_blocks_empty_when_all_empty() {
        use crate::ingest::content_search::Dossier;
        assert!(dossier_blocks(&Dossier::default()).is_empty());
    }
}

#[cfg(test)]
mod job_id_wiring_tests {
    use super::*;
    use crate::execution::{Cancelled, JobExecutionContext};
    use std::sync::{Arc, Mutex};

    fn temp_base() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("thoth_run_wiring_{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn job_id_override_yields_flat_root_with_that_id() {
        let base = temp_base();
        let job = build_job_context(Some("srv-job-1"), "srv-job-1".to_owned(), &base).unwrap();

        assert_eq!(job.job_id, "srv-job-1");
        assert_eq!(job.root(), base); // flat: root == base_dir, no `.thoth/<id>` nesting

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn no_override_mints_nested_root() {
        let base = temp_base();
        let minted_id = uuid::Uuid::new_v4().to_string();
        let job = build_job_context(None, minted_id.clone(), &base).unwrap();

        assert_eq!(job.job_id, minted_id);
        assert_eq!(job.root(), base.join(".thoth").join(&minted_id)); // nested (CLI default)

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn cancelled_context_stops_before_next_stage() {
        let pre_cancelled = JobExecutionContext::new();
        pre_cancelled.cancel();
        let entered = Arc::new(Mutex::new(Vec::new()));
        let first_entered = Arc::clone(&entered);

        let error = run_cooperative_stage(&pre_cancelled, move || async move {
            first_entered.lock().unwrap().push("first");
            Ok(())
        })
        .await
        .unwrap_err();

        assert!(error.downcast_ref::<Cancelled>().is_some());
        assert!(entered.lock().unwrap().is_empty());

        let execution = JobExecutionContext::new();
        let entered = Arc::new(Mutex::new(Vec::new()));
        let first_entered = Arc::clone(&entered);
        let second_entered = Arc::clone(&entered);
        let first_execution = execution.clone();

        let error = async {
            run_cooperative_stage(&execution, move || async move {
                first_entered.lock().unwrap().push("first");
                first_execution.cancel();
                Ok(())
            })
            .await?;
            run_cooperative_stage(&execution, move || async move {
                second_entered.lock().unwrap().push("second");
                Ok(())
            })
            .await
        }
        .await
        .unwrap_err();

        assert!(error.downcast_ref::<Cancelled>().is_some());
        assert_eq!(*entered.lock().unwrap(), vec!["first"]);
    }
}

#[cfg(test)]
mod ocr_pipeline_tests {
    use super::*;
    use crate::edit::enrichment::ENRICHMENT_FILE;
    use crate::ingest::content_search::{
        MAIN_CONTEXT_FILE, MainContext, OCR_ANALYZER_VERSION, OCR_SCHEMA_VERSION, OcrMetadata,
        OcrStatus, configured_ocr_model,
    };
    use crate::pipeline::ocr::{OcrAnalysis, OcrVerdict};

    fn analyzed_context() -> MainContext {
        MainContext {
            ocr: OcrMetadata {
                ocr_schema_version: OCR_SCHEMA_VERSION,
                ocr_status: Some(OcrStatus::Analyzed),
                ocr_model: configured_ocr_model(),
                ocr_analyzer_version: OCR_ANALYZER_VERSION.into(),
                ocr_analyzed_at: "2026-07-23T00:00:00Z".into(),
                ocr_requested_frames: 4,
                ocr_valid_frames: 4,
                ocr_outcome: "clean".into(),
            },
            ..MainContext::default()
        }
    }

    fn analyzed_result() -> OcrAnalysis {
        OcrAnalysis {
            schema_version: OCR_SCHEMA_VERSION,
            ocr_status: OcrStatus::Analyzed,
            provider: "novita".into(),
            model: configured_ocr_model(),
            analyzer_version: OCR_ANALYZER_VERSION.into(),
            requested_frames: 4,
            valid_frames: 4,
            analyzed_at: "2026-07-23T00:00:00Z".into(),
            verdict: Some(OcrVerdict {
                outcome: "clean".into(),
                trim_start: 0.0,
                mute_audio: false,
                subtitle_blur: Vec::new(),
            }),
            error_code: None,
            error_message: None,
        }
    }

    #[test]
    fn direct_url_ocr_creates_default_context_without_inventing_grounding_fields() {
        let dir = temp_dir("direct-url");

        persist_ocr_analysis(&dir, &analyzed_result()).unwrap();

        let saved: MainContext =
            serde_json::from_slice(&std::fs::read(dir.join(MAIN_CONTEXT_FILE)).unwrap()).unwrap();
        assert_eq!(saved.ocr.ocr_status, Some(OcrStatus::Analyzed));
        assert_eq!(saved.ocr.ocr_model, configured_ocr_model());
        assert!(saved.title.is_empty());
        assert!(saved.description.is_empty());
        assert!(saved.figures.is_empty());
        assert!(saved.references.is_empty());
        assert!(saved.discourse.themes.is_empty());
        assert!(saved.dossier.topic.is_empty());

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn edit_preflight_rejects_unsafe_enrichment_video() {
        let dir = temp_dir("unsafe-enrichment");
        crate::pipeline::ocr::save_main_context_atomic(&dir, &analyzed_context()).unwrap();
        std::fs::write(
            dir.join(ENRICHMENT_FILE),
            br#"[{"platform":"youtube","url":"https://private.example/video?token=secret","is_video":true}]"#,
        )
        .unwrap();

        let error = preflight_edit_ocr(&dir).unwrap_err().to_string();
        assert!(error.contains("footage[0]"));
        assert!(!error.contains("token=secret"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn edit_preflight_requires_current_main_context() {
        let dir = temp_dir("missing-main");

        let error = preflight_edit_ocr(&dir).unwrap_err().to_string();
        assert!(error.contains("main OCR"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("thoth-pipeline-ocr-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
