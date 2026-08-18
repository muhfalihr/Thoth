pub mod job;
pub mod ocr;
pub mod state;

use std::{future::Future, path::Path};

use anyhow::{Context, Result};
use futures_util::stream::{self, StreamExt};
use tracing::{debug, info, warn};
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
    MainContext, OCR_ANALYZER_VERSION, OCR_SCHEMA_VERSION, configured_ocr_model,
    validate_main_ocr,
};
use crate::ingest::IngestService;
use crate::news::EnrichService;
use crate::transcribe::TranscribeService;
use crate::util::fs::ensure_dir;

use job::JobContext;
use state::{
    OcrStageResult, PipelineState, invalidate_for_ocr_rerun, ocr_is_fresh,
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

async fn run_main_ocr_if_video<F, Fut>(main_is_video: bool, stage: F) -> Result<bool>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<()>>,
{
    if !main_is_video {
        return Ok(false);
    }
    stage().await?;
    Ok(true)
}

fn persist_ocr_analysis(
    base_dir: &Path,
    analysis: &ocr::OcrAnalysis,
    source_fingerprint: &str,
) -> Result<()> {
    let mut context = ocr::load_main_context_for_ocr(base_dir)?;
    if !context.ocr_source_fingerprint.is_empty()
        && context.ocr_source_fingerprint != source_fingerprint
    {
        context = MainContext::default();
    }
    ocr::apply_analysis_for_source(&mut context, analysis, source_fingerprint)?;
    ocr::save_main_context_atomic(base_dir, &context)
}

fn preflight_edit_ocr(base_dir: &Path, expected_source_fingerprint: &str) -> Result<()> {
    let context = ocr::load_main_context_for_ocr(base_dir)?;
    validate_main_ocr(&context)?;
    if context.ocr_source_fingerprint != expected_source_fingerprint {
        anyhow::bail!("main OCR source binding is stale");
    }
    crate::edit::enrichment::preflight_ocr(base_dir)
}

/// The forced main footage a Content Set declared. Its presence is what makes a
/// run "forced": the job imports its own copy of Scout's source package, cuts from
/// those local files instead of downloading `main.url`, and narration stops being
/// best-effort because the cut planner allocates against its beats.
#[derive(Debug, Clone)]
pub struct PlannedMainInput {
    /// The Content Set that declared the package; the manifest is resolved
    /// relative to its directory.
    pub content_set_path: std::path::PathBuf,
    pub descriptor: thoth_types::main_footage::MainFootageDescriptor,
    /// Scout's publish root. The manifest must resolve inside it.
    pub scout_output_root: std::path::PathBuf,
}

/// The imported source Stage 1 ingests for a forced run — a local file inside the
/// job, never a URL, so nothing is downloaded and nothing is re-encoded here.
/// Sources keep Scout's media order, so the lowest `media_index` is the main post.
fn forced_ingest_source(
    imported: &crate::main_footage::ImportedSourcePackage,
) -> Result<String> {
    let source = imported
        .package
        .sources
        .iter()
        .min_by_key(|source| source.media_index)
        .ok_or_else(|| {
            crate::main_footage::MainFootageError::new(
                thoth_types::main_footage::MainFootageErrorCode::SourcePackageInvalid,
                "package_declares_no_usable_source",
            )
        })?;
    let path = crate::main_footage::resolve_contained(&imported.root, Path::new(&source.path))
        .map_err(|_| {
            crate::main_footage::MainFootageError::new(
                thoth_types::main_footage::MainFootageErrorCode::SourcePackageInvalid,
                "imported_source_outside_job_root",
            )
        })?;
    Ok(path.to_string_lossy().to_string())
}

/// What Stage 1 actually ingests. A forced run resolves a job-owned local file
/// from the imported package — `main.url` never reaches the ingest service — while
/// a legacy run keeps the caller's URL untouched.
fn resolve_ingest_input(
    planned: Option<&crate::main_footage::ImportedSourcePackage>,
    url: &str,
) -> Result<String> {
    match planned {
        Some(imported) => forced_ingest_source(imported),
        None => Ok(url.to_string()),
    }
}

/// Whether the clip Stage 1 ingested is a real video, which is what the OCR
/// preflight branches on. A forced run cuts a package source — a video by
/// contract — so the Content Set's `main_is_video` (a fact about the *post*,
/// false for an image post that still carries videos) does not apply. Legacy
/// runs keep the caller's declaration.
fn stage_one_is_video(
    planned: Option<&crate::main_footage::ImportedSourcePackage>,
    declared: bool,
) -> bool {
    match planned {
        Some(imported) => !imported.package.sources.is_empty(),
        None => declared,
    }
}

pub struct PipelineRunner<'a> {
    config: &'a AppConfig,
    execution: &'a JobExecutionContext,
    main_is_video: bool,
    planned_main: Option<PlannedMainInput>,
}

impl<'a> PipelineRunner<'a> {
    pub fn new(config: &'a AppConfig, execution: &'a JobExecutionContext) -> Self {
        Self {
            config,
            execution,
            main_is_video: true,
            planned_main: None,
        }
    }

    pub fn with_main_is_video(mut self, main_is_video: bool) -> Self {
        self.main_is_video = main_is_video;
        self
    }

    pub fn with_planned_main(mut self, planned_main: PlannedMainInput) -> Self {
        self.planned_main = Some(planned_main);
        self
    }

    /// Stage 5.5's forced precondition. A forced run is cut against narration
    /// beats, so a runtime config with the narrator switched off has nothing for
    /// the planner to allocate against. Legacy runs pass through untouched.
    fn forced_narration_gate(&self) -> Result<()> {
        if self.planned_main.is_some() {
            crate::main_footage::require_narration_enabled(self.config.narration.enabled)?;
        }
        Ok(())
    }

    /// Stage 6's forced precondition. A rerun that already has `narration.mp3`
    /// skips the narration stage entirely, so the beat timeline it should have
    /// published may be absent — refuse rather than plan blindly against beats
    /// that do not exist. The narrator is enabled here (the gate above proved
    /// it) and what is missing is its *output*, so this is a generation failure,
    /// not an unmet precondition.
    fn forced_timeline_gate(&self, job: &JobContext) -> Result<()> {
        if self.planned_main.is_some() && !job.narration_timeline().exists() {
            return Err(crate::main_footage::MainFootageError::new(
                crate::main_footage::MainFootageErrorCode::NarrationGenerationFailed,
                "narration_timeline_missing",
            )
            .into());
        }
        Ok(())
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

        // ── Forced main footage: take a job-owned copy of Scout's package ──────
        // Everything downstream reads the job's own immutable copies, so the run
        // no longer depends on Scout's directory — and Stage 1 ingests one of those
        // local files instead of downloading `main.url`.
        let planned_package = match &self.planned_main {
            Some(planned) => Some(crate::main_footage::import_package(
                &planned.content_set_path,
                &planned.descriptor,
                &job,
                &planned.scout_output_root,
                self.execution,
            )?),
            None => None,
        };
        let ingest_url = resolve_ingest_input(planned_package.as_ref(), url)?;
        // `set.main_is_video` describes the *post*, and is false for an image post
        // that nonetheless carries videos. On the forced path Stage 1 ingests a
        // package source — a video by contract — so the OCR branch must follow the
        // clip that was actually ingested, not the post it came from.
        let main_is_video = stage_one_is_video(planned_package.as_ref(), self.main_is_video);
        let url = ingest_url.as_str();

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
        let ran_ocr_gate = run_main_ocr_if_video(main_is_video, || async {
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
            invalidate_for_ocr_rerun(&mut state);
            self.execution.check_cancelled()?;
            state.save(&job.state_path())?;
            self.execution.check_cancelled()?;
            stage_header(2, 6, "OCR  (local Scout + DeepSeek)");
            let analysis = run_cooperative_stage(self.execution, || async {
                ocr::run_local_ocr(self.execution, &video_path).await
            })
            .await
            .context("local OCR stage failed")?;
            persist_ocr_analysis(&job.base_dir, &analysis, &source_fingerprint)
                .context("local OCR stage failed")?;
            state.stages.ocr = Some(OcrStageResult {
                status: analysis.ocr_status,
                schema_version: OCR_SCHEMA_VERSION,
                analyzer_version: OCR_ANALYZER_VERSION.into(),
                model: expected_model,
                source_fingerprint,
                completed_at: chrono::Utc::now(),
            });
            self.execution.check_cancelled()?;
            state.save(&job.state_path())?;
            self.execution.check_cancelled()?;
        }
        Ok(())
        })
        .await?;
        if !ran_ocr_gate {
            info!("Stage 2/6: OCR — skipped (still-image main is exempt)");
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
        if main_is_video {
            let current_source_fingerprint =
                ocr::source_fingerprint(&video_path).context("main OCR preflight failed")?;
            preflight_edit_ocr(&job.base_dir, &current_source_fingerprint)
                .context("OCR preflight before narration/edit failed")?;
        } else {
            crate::edit::enrichment::preflight_ocr(&job.base_dir)
                .context("footage OCR preflight before narration/edit failed")?;
        }

        // ── Stage 5.5: Narration  (narrator-driven spine) ────────────────
        // Generate ONE continuous narrator voiceover (+ word timings) that the
        // edit builds the video around. Best-effort: never fails the pipeline.
        // A forced main-footage run is cut against narration beats, so a runtime
        // config with the narrator disabled cannot produce anything to plan against.
        self.forced_narration_gate()?;
        if self.config.narration.enabled && !job.narration_mp3().exists() {
            self.execution.check_cancelled()?;
            stage_header(5, 6, "Narration  (narrator voiceover)");
            match self.generate_narration(&job, provider).await {
                Ok(narration) => {
                    // Forced main footage is cut against narration beats, so the
                    // timeline is published as part of the narration stage.
                    if self.planned_main.is_some() {
                        let timeline = crate::narration::timeline::build_narration_timeline(
                            &narration,
                            crate::narration::timeline::BeatPolicy::default(),
                        )?;
                        crate::narration::timeline::write_narration_timeline(&job, &timeline)?;
                    }
                }
                Err(e) => {
                    // The raw error can carry a model response body, which the
                    // typed error deliberately withholds — keep it out of the
                    // operator-facing line and off the wire.
                    debug!(error = %e, "narration stage failed");
                    if let Some(fatal) =
                        crate::main_footage::narration_failure(self.planned_main.is_some())
                    {
                        // A forced run has no legacy fallback: nothing continues.
                        return Err(fatal.into());
                    }
                    warn!("Narration failed — continuing without narrator");
                }
            }
            self.execution.check_cancelled()?;
        }
        self.forced_timeline_gate(&job)?;

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
    /// `narration.mp3` + `narration_words.json`.
    ///
    /// Returns the produced `Narration` so callers that need the voiceover's word
    /// timings (the forced main-footage path builds a beat timeline from them) do
    /// not have to re-read or re-synthesize anything. Legacy callers ignore it and
    /// keep treating a failure as best-effort.
    pub async fn generate_narration(
        &self,
        job: &JobContext,
        provider: &LlmProviderName,
    ) -> Result<crate::narration::Narration> {
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
        Ok(narr)
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
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use crate::edit::enrichment::ENRICHMENT_FILE;
    use crate::ingest::content_search::{
        MAIN_CONTEXT_FILE, MainContext, OCR_ANALYZER_VERSION, OCR_SCHEMA_VERSION, OcrMetadata,
        OcrStatus, configured_ocr_model,
    };
    use crate::pipeline::ocr::{OcrAnalysis, OcrVerdict};

    fn analyzed_context() -> MainContext {
        MainContext {
            ocr_source_fingerprint: "md5:current".into(),
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

    #[tokio::test]
    async fn still_image_main_does_not_invoke_local_ocr() {
        let invoked = Arc::new(AtomicBool::new(false));
        let invoked_by_stage = Arc::clone(&invoked);

        let ran = run_main_ocr_if_video(false, move || async move {
            invoked_by_stage.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();

        assert!(!ran);
        assert!(!invoked.load(Ordering::SeqCst));
    }

    #[test]
    fn direct_url_ocr_creates_default_context_without_inventing_grounding_fields() {
        let dir = temp_dir("direct-url");

        persist_ocr_analysis(&dir, &analyzed_result(), "md5:direct-url").unwrap();

        let saved: MainContext =
            serde_json::from_slice(&std::fs::read(dir.join(MAIN_CONTEXT_FILE)).unwrap()).unwrap();
        assert_eq!(saved.ocr.ocr_status, Some(OcrStatus::Analyzed));
        assert_eq!(saved.ocr.ocr_model, configured_ocr_model());
        assert_eq!(saved.ocr_source_fingerprint, "md5:direct-url");
        assert!(saved.title.is_empty());
        assert!(saved.description.is_empty());
        assert!(saved.figures.is_empty());
        assert!(saved.references.is_empty());
        assert!(saved.discourse.themes.is_empty());
        assert!(saved.dossier.topic.is_empty());

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sequential_job_ocr_does_not_reuse_previous_job_grounding() {
        let dir = temp_dir("sequential-job");
        let mut previous = analyzed_context();
        previous.ocr_source_fingerprint = "md5:previous-source".into();
        previous.title = "Previous job title".into();
        crate::pipeline::ocr::save_main_context_atomic(&dir, &previous).unwrap();

        persist_ocr_analysis(&dir, &analyzed_result(), "md5:current-source").unwrap();

        let saved: MainContext =
            serde_json::from_slice(&std::fs::read(dir.join(MAIN_CONTEXT_FILE)).unwrap()).unwrap();
        assert_eq!(saved.ocr_source_fingerprint, "md5:current-source");
        assert!(
            saved.title.is_empty(),
            "grounding from a different source must not cross job boundaries"
        );

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

        let error = preflight_edit_ocr(&dir, "md5:current").unwrap_err().to_string();
        assert!(error.contains("footage[0]"));
        assert!(!error.contains("token=secret"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn edit_preflight_requires_current_main_context() {
        let dir = temp_dir("missing-main");

        let error = preflight_edit_ocr(&dir, "md5:current").unwrap_err().to_string();
        assert!(error.contains("main OCR"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn edit_preflight_rejects_main_context_bound_to_previous_source() {
        let dir = temp_dir("stale-source-binding");
        let mut context = analyzed_context();
        context.ocr_source_fingerprint = "md5:previous-source".into();
        crate::pipeline::ocr::save_main_context_atomic(&dir, &context).unwrap();

        let error = preflight_edit_ocr(&dir, "md5:current-source")
            .unwrap_err()
            .to_string();
        assert!(error.contains("source binding"));

        std::fs::remove_dir_all(dir).unwrap();
    }

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("thoth-pipeline-ocr-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

/// Behavioural coverage for the forced main-footage branch of `PipelineRunner`
/// (brief steps 6 and 7). These drive the real decision points offline: the
/// Stage-1 input the runner resolves, and the narration gate it applies.
///
/// `PipelineRunner::run` itself cannot be driven end to end in a unit test —
/// Stage 1 shells out to `ffprobe`/`ffmpeg`, Stage 2 loads a CUDA Whisper model,
/// and Stage 3 calls a remote LLM. The seams below are the closest reachable
/// ones: `resolve_ingest_input` is the exact expression `run` assigns its
/// Stage-1 `url` from, and `forced_narration_gate` is the exact call `run` makes
/// before Stage 5.5.
#[cfg(test)]
mod forced_main_footage_tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::{resolve_ingest_input, stage_one_is_video, PipelineRunner, PlannedMainInput};
    use crate::execution::JobExecutionContext;
    use crate::main_footage::{
        ImportedSourcePackage, MainFootageDescriptor, MainFootageError, MainFootageErrorCode,
    };
    use crate::pipeline::job::JobContext;

    /// The URL a forced Content Set carries. It must never become the Stage-1
    /// ingest input — that is the whole point of forced main footage.
    const MAIN_URL: &str = "https://www.instagram.com/reel/post-123/";

    struct Fixture {
        scout_root: PathBuf,
        content_set: PathBuf,
        job_base: PathBuf,
    }

    fn digest(bytes: &[u8]) -> String {
        let mut hash = Sha256::new();
        hash.update(bytes);
        format!("sha256:{:x}", hash.finalize())
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// A Scout package with two sources published out of media order, so the
    /// lowest `media_index` is not simply the first array element.
    fn fixture() -> Fixture {
        let base = std::env::temp_dir().join(format!("mf-forced-{}", uuid::Uuid::new_v4()));
        let scout_root = base.join("scout/output");
        let package_dir = scout_root.join("main-footage/post-123");
        let job_base = base.join("job");
        fs::create_dir_all(&job_base).unwrap();

        let mut sources = Vec::new();
        let mut indexes = Vec::new();
        // Deliberately reversed: media_index 1 is declared before media_index 0.
        for media_index in [1u32, 0u32] {
            let bytes = format!("source {media_index} bytes").into_bytes();
            let relative = format!("sources/source-{media_index}.mp4");
            write(&package_dir.join(&relative), &bytes);

            let index_relative =
                format!("scene-index/source-{media_index}/cache-a/v002/index.json");
            let index_bytes =
                format!(r#"{{"scenes":[{{"id":"scene-{media_index}"}}]}}"#).into_bytes();
            write(&package_dir.join(&index_relative), &index_bytes);
            let frame_relative =
                format!("scene-index/source-{media_index}/cache-a/v002/frame-000.jpg");
            write(&package_dir.join(&frame_relative), b"frame bytes");

            sources.push(json!({
                "id": format!("source-{media_index}"),
                "media_index": media_index,
                "path": relative,
                "checksum": digest(&bytes),
                "technical": {
                    "container": "mp4",
                    "video_codec": "h264",
                    "duration_sec": 12.5,
                    "width": 1080,
                    "height": 1920,
                    "has_audio": true
                }
            }));
            indexes.push(json!({
                "source_id": format!("source-{media_index}"),
                "path": index_relative,
                "checksum": digest(&index_bytes),
                "planning_mode": "vision",
                "scenes": [{
                    "id": format!("scene-{media_index}"),
                    "start_sec": 0,
                    "end_sec": 4,
                    "representative_frame": frame_relative,
                    "transcript_evidence": "A person addresses the camera.",
                    "vision_description": "A person in a studio.",
                    "visual_metrics": {
                        "motion_score": 0.2,
                        "brightness": 0.6,
                        "scene_change_score": 0.1
                    }
                }]
            }));
        }

        let package = json!({
            "schema_version": 1,
            "post": {
                "id": "post-123",
                "canonical_url": MAIN_URL,
                "platform": "instagram"
            },
            "analysis_identity": "analysis-2026-08-14",
            "created_at": "2026-08-14T12:00:00Z",
            "sources": sources,
            "ignored": [],
            "unavailable": [],
            "scene_indexes": indexes
        });
        write(
            &package_dir.join("source-package.json"),
            serde_json::to_string_pretty(&package).unwrap().as_bytes(),
        );

        let content_set = scout_root.join("thoth_content_set.json");
        write(&content_set, b"{}");

        Fixture {
            scout_root,
            content_set,
            job_base,
        }
    }

    fn descriptor() -> MainFootageDescriptor {
        serde_json::from_value(json!({
            "mode": "forced_url_pool",
            "package_manifest": "main-footage/post-123/source-package.json",
            "coverage_target": 0.6
        }))
        .unwrap()
    }

    /// Runs the real import the forced branch performs before Stage 1.
    fn import(fixture: &Fixture) -> (JobContext, ImportedSourcePackage) {
        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        let imported = crate::main_footage::import_package(
            &fixture.content_set,
            &descriptor(),
            &job,
            &fixture.scout_root,
            &JobExecutionContext::new(),
        )
        .unwrap();
        (job, imported)
    }

    fn code(error: &anyhow::Error) -> MainFootageErrorCode {
        error
            .downcast_ref::<MainFootageError>()
            .unwrap_or_else(|| panic!("expected a MainFootageError, got: {error:#}"))
            .code
    }

    /// Scout publishes sources in discovery order, not media order. The Stage-1
    /// clip is the post's own first medium, so selection must be by
    /// `media_index` — not by array position.
    #[test]
    fn the_forced_stage_one_input_is_the_lowest_media_index_source() {
        let fixture = fixture();
        let (_job, imported) = import(&fixture);
        assert_eq!(imported.package.sources[0].media_index, 1, "fixture ordering");

        let resolved = resolve_ingest_input(Some(&imported), MAIN_URL).unwrap();

        assert!(
            resolved.ends_with("source-0.mp4"),
            "forced ingest took {resolved} instead of the lowest media_index source"
        );
    }

    /// The load-bearing guarantee of brief step 6: whatever the Content Set's
    /// `main.url` says, Stage 1 receives a job-owned local file. Asserted on the
    /// resolved input itself, including the exact predicate `IngestService::run`
    /// uses to choose its local-file branch over yt-dlp.
    #[test]
    fn the_forced_stage_one_input_is_a_job_owned_file_and_never_main_url() {
        let fixture = fixture();
        let (job, imported) = import(&fixture);

        let resolved = resolve_ingest_input(Some(&imported), MAIN_URL).unwrap();
        let resolved_path = Path::new(&resolved);

        assert_ne!(resolved, MAIN_URL);
        // `IngestService::run` takes its local-file branch on exactly this test.
        assert!(!resolved.starts_with("http://") && !resolved.starts_with("https://"));
        assert!(resolved_path.is_file(), "{resolved} is not an existing file");
        assert!(
            resolved_path.starts_with(fs::canonicalize(job.main_footage_dir()).unwrap()),
            "{resolved} escaped the job's main-footage root"
        );
        // And it really is the imported copy, not a link back into Scout.
        assert!(!resolved_path.starts_with(&fixture.scout_root));
    }

    /// Legacy sets keep resolving and ingesting their own `main_url`.
    #[test]
    fn the_legacy_stage_one_input_is_the_callers_url_unchanged() {
        assert_eq!(resolve_ingest_input(None, MAIN_URL).unwrap(), MAIN_URL);
    }

    /// A package whose declared source path leaves the job root is rejected
    /// rather than silently ingested from outside the job.
    ///
    /// `SourceVideoV1`'s deserializer already refuses such a path, so these
    /// values are written onto the decoded struct directly — the containment
    /// check in `forced_ingest_source` is the second of the two locks, and this
    /// pins that it is actually closed.
    #[test]
    fn a_forced_source_outside_the_job_root_is_rejected() {
        let fixture = fixture();
        let (_job, imported) = import(&fixture);

        for escape in ["../escape.mp4", "sources/../../escape.mp4"] {
            let mut escaping = imported.clone();
            escaping.package.sources[0].path = escape.to_string();
            escaping.package.sources[0].media_index = 0;

            let error = resolve_ingest_input(Some(&escaping), MAIN_URL)
                .expect_err("a source outside the job root must not be ingested");
            assert_eq!(code(&error), MainFootageErrorCode::SourcePackageInvalid);
        }
    }

    fn planned_main(fixture: &Fixture) -> PlannedMainInput {
        PlannedMainInput {
            content_set_path: fixture.content_set.clone(),
            descriptor: descriptor(),
            scout_output_root: fixture.scout_root.clone(),
        }
    }

    /// Brief step 7 through the runner that enforces it: a forced run with the
    /// narrator switched off in the effective runtime config stops with
    /// `forced_main_narration_required`, while the identical legacy runner
    /// continues (narration stays best-effort there).
    #[test]
    fn a_forced_runner_with_narration_disabled_fails_the_narration_gate() {
        let fixture = fixture();
        let execution = JobExecutionContext::new();
        let mut config = crate::config::AppConfig::load().expect("runtime config");
        config.narration.enabled = false;

        let legacy = PipelineRunner::new(&config, &execution);
        legacy
            .forced_narration_gate()
            .expect("legacy runs keep best-effort narration");

        let forced =
            PipelineRunner::new(&config, &execution).with_planned_main(planned_main(&fixture));
        let error = forced
            .forced_narration_gate()
            .expect_err("a forced run cannot plan without narration beats");
        assert_eq!(
            code(&error),
            MainFootageErrorCode::ForcedMainNarrationRequired
        );

        config.narration.enabled = true;
        let forced =
            PipelineRunner::new(&config, &execution).with_planned_main(planned_main(&fixture));
        forced
            .forced_narration_gate()
            .expect("an enabled narrator satisfies the forced gate");
    }

    /// A rerun with `narration.mp3` already on disk skips the narration stage,
    /// so the beat timeline can be missing while the narrator is perfectly well
    /// enabled. That is the narrator's *output* missing, not its precondition —
    /// `forced_main_narration_required` would send an operator to check a config
    /// switch that is already on.
    #[test]
    fn a_forced_rerun_without_a_beat_timeline_is_a_narration_generation_failure() {
        let fixture = fixture();
        let (job, _imported) = import(&fixture);
        let execution = JobExecutionContext::new();
        let config = crate::config::AppConfig::load().expect("runtime config");
        assert!(
            !job.narration_timeline().exists(),
            "fixture must start without a timeline"
        );

        let legacy = PipelineRunner::new(&config, &execution);
        legacy
            .forced_timeline_gate(&job)
            .expect("legacy runs never need a beat timeline");

        let forced =
            PipelineRunner::new(&config, &execution).with_planned_main(planned_main(&fixture));
        let error = forced
            .forced_timeline_gate(&job)
            .expect_err("a forced run cannot plan without beats");
        assert_eq!(
            code(&error),
            MainFootageErrorCode::NarrationGenerationFailed
        );

        std::fs::create_dir_all(job.narration_timeline().parent().unwrap()).unwrap();
        std::fs::write(job.narration_timeline(), b"{}").unwrap();
        forced
            .forced_timeline_gate(&job)
            .expect("a published timeline satisfies the forced gate");
    }

    /// `main_is_video` is a fact about the *post*: an image post that carries
    /// videos declares `false`. On the forced path Stage 1 ingests a package
    /// source — a video by contract — so the OCR preflight must branch on the
    /// clip that was actually ingested, or a forced run with a real video clip
    /// takes the footage-only preflight.
    #[test]
    fn the_forced_ocr_branch_follows_the_ingested_clip_not_the_post() {
        let fixture = fixture();
        let (_job, imported) = import(&fixture);
        assert!(!imported.package.sources.is_empty());

        assert!(
            stage_one_is_video(Some(&imported), false),
            "a forced run cutting a package source is a video run"
        );
        // Legacy runs are unchanged: the caller's declaration passes straight through.
        assert!(!stage_one_is_video(None, false));
        assert!(stage_one_is_video(None, true));
    }
}
