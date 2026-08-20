pub mod job;
pub mod ocr;
pub mod state;

use std::{future::Future, path::Path};

use anyhow::{Context, Result};
use async_trait::async_trait;
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
    MainFootageInvalidation, MainFootageStageResult, OcrStageResult, PipelineState,
    invalidate_for_ocr_rerun, invalidate_main_footage, main_footage_is_fresh, ocr_is_fresh,
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

/// Task-12's narrow renderer seam. It exposes only verified job-owned media,
/// the immutable narration timeline, and render settings; there is deliberately
/// no URL, HTTP client, ingest service, planner, or downloader capability.
/// Task 13 supplies the FFmpeg-backed implementation of this port.
#[async_trait]
pub trait PlannedMainRenderer: Sync {
    async fn render(
        &self,
        job: &JobContext,
        plan: &crate::main_footage::VerifiedMainFootagePlan,
        narration: &crate::main_footage::NarrationTimelineV1,
        layout: &crate::edit::layout::OutputLayout,
        audio: &AudioOptions,
        social_name: &str,
        style_profile_name: &str,
        execution: &JobExecutionContext,
    ) -> Result<crate::edit::service::EditResult>;
}

/// Temporary production endpoint until Task 13 binds the real renderer behind
/// `PlannedMainRenderer`. Keeping the failure behind the port prevents this task
/// from re-entering legacy edit or adding a downloader fallback.
pub struct DeferredPlannedMainRenderer;

#[async_trait]
impl PlannedMainRenderer for DeferredPlannedMainRenderer {
    async fn render(
        &self,
        _job: &JobContext,
        _plan: &crate::main_footage::VerifiedMainFootagePlan,
        _narration: &crate::main_footage::NarrationTimelineV1,
        _layout: &crate::edit::layout::OutputLayout,
        _audio: &AudioOptions,
        _social_name: &str,
        _style_profile_name: &str,
        _execution: &JobExecutionContext,
    ) -> Result<crate::edit::service::EditResult> {
        anyhow::bail!("planned_renderer_unavailable")
    }
}

/// Injected boundary for the planned-main state machine. Production binds this
/// to package import, narration, the Task-11 coordinator, and the renderer port;
/// tests replace only those expensive/external stages while exercising the same
/// persistence, cancellation, invalidation, error, and ordering code.
#[async_trait]
pub(crate) trait PlannedMainStagePort: Sync {
    type Imported: Send + Sync;
    type Narration: Send + Sync;
    type Verified: Send + Sync;

    async fn import_sources(
        &self,
        job: &JobContext,
        planned: &PlannedMainInput,
        execution: &JobExecutionContext,
    ) -> Result<Self::Imported>;

    fn source_fingerprint<'b>(&self, imported: &'b Self::Imported) -> &'b str;

    fn validate_scene_index(&self, job: &JobContext, imported: &Self::Imported) -> Result<()>;

    fn load_narration(&self, job: &JobContext) -> Result<Option<Self::Narration>>;

    async fn generate_narration(
        &self,
        job: &JobContext,
        execution: &JobExecutionContext,
    ) -> Result<Self::Narration>;

    fn narration_fingerprint<'b>(&self, narration: &'b Self::Narration) -> &'b str;

    async fn resume_verified(
        &self,
        _job: &JobContext,
        _planned: &PlannedMainInput,
        _imported: &Self::Imported,
        _narration: &Self::Narration,
        _execution: &JobExecutionContext,
    ) -> Result<Option<Self::Verified>> {
        Ok(None)
    }

    async fn prepare_plan(
        &self,
        job: &JobContext,
        planned: &PlannedMainInput,
        imported: &Self::Imported,
        narration: &Self::Narration,
        execution: &JobExecutionContext,
    ) -> Result<Self::Verified>;

    fn verified_state(&self, verified: &Self::Verified) -> MainFootageStageResult;

    fn render_settings_fingerprint(&self) -> String;

    async fn render(
        &self,
        job: &JobContext,
        verified: &Self::Verified,
        narration: &Self::Narration,
        execution: &JobExecutionContext,
    ) -> Result<crate::edit::service::EditResult>;
}

fn planned_error(
    error: anyhow::Error,
    code: crate::main_footage::MainFootageErrorCode,
    detail: &'static str,
) -> anyhow::Error {
    if crate::execution::is_cancelled(&error)
        || error
            .downcast_ref::<crate::main_footage::MainFootageError>()
            .is_some()
    {
        error
    } else {
        crate::main_footage::MainFootageError::new(code, detail).into()
    }
}

fn emit_planned_checkpoint(stage: crate::util::progress::MainFootageProgressStage, pct: f32) {
    let message = match stage {
        crate::util::progress::MainFootageProgressStage::ImportingSources => {
            "importing main-footage sources"
        }
        crate::util::progress::MainFootageProgressStage::ValidatingSceneIndex => {
            "validating main-footage scene index"
        }
        crate::util::progress::MainFootageProgressStage::GeneratingNarration => {
            "generating narration timeline"
        }
        crate::util::progress::MainFootageProgressStage::PlanningCuts => {
            "planning main-footage cuts"
        }
        crate::util::progress::MainFootageProgressStage::MaterializingCuts => {
            "materializing main-footage cuts"
        }
        crate::util::progress::MainFootageProgressStage::VerifyingPlan => {
            "verifying main-footage plan"
        }
        crate::util::progress::MainFootageProgressStage::Rendering => {
            "rendering planned main footage"
        }
    };
    crate::util::progress::emit_stage(stage.as_str(), pct, message);
}

fn rendered_paths(state: &PipelineState) -> Option<Vec<std::path::PathBuf>> {
    let edit = state.stages.edit.as_ref()?;
    let paths = edit
        .output_clips
        .iter()
        .map(|clip| clip.path.clone())
        .collect::<Vec<_>>();
    (!paths.is_empty() && paths.iter().all(|path| path.is_file())).then_some(paths)
}

async fn run_planned_main_with<P: PlannedMainStagePort>(
    job: &JobContext,
    state: &mut PipelineState,
    planned: &PlannedMainInput,
    execution: &JobExecutionContext,
    port: &P,
) -> Result<Vec<std::path::PathBuf>> {
    use crate::main_footage::MainFootageErrorCode;
    use crate::util::progress::MainFootageProgressStage;

    execution.check_cancelled()?;
    let imported = port
        .import_sources(job, planned, execution)
        .await
        .map_err(|error| {
            planned_error(
                error,
                MainFootageErrorCode::SourcePackageInvalid,
                "source_import_failed",
            )
        })?;
    execution.check_cancelled()?;
    emit_planned_checkpoint(MainFootageProgressStage::ImportingSources, 0.0);
    let source_fingerprint = port.source_fingerprint(&imported).to_owned();
    if state
        .stages
        .main_footage
        .as_ref()
        .is_some_and(|stage| stage.source_package_fingerprint != source_fingerprint)
    {
        invalidate_main_footage(state, MainFootageInvalidation::SourceChanged);
    }
    state.save(&job.state_path())?;
    execution.check_cancelled()?;

    port.validate_scene_index(job, &imported).map_err(|error| {
        planned_error(
            error,
            MainFootageErrorCode::SourcePackageInvalid,
            "scene_index_validation_failed",
        )
    })?;
    execution.check_cancelled()?;
    emit_planned_checkpoint(MainFootageProgressStage::ValidatingSceneIndex, 0.05);
    execution.check_cancelled()?;

    let narration = match port.load_narration(job)? {
        Some(narration) => narration,
        None => port
            .generate_narration(job, execution)
            .await
            .map_err(|error| {
                planned_error(
                    error,
                    MainFootageErrorCode::NarrationGenerationFailed,
                    "narration_stage_failed",
                )
            })?,
    };
    execution.check_cancelled()?;
    emit_planned_checkpoint(MainFootageProgressStage::GeneratingNarration, 0.1);
    let narration_fingerprint = port.narration_fingerprint(&narration).to_owned();
    if state
        .stages
        .main_footage
        .as_ref()
        .is_some_and(|stage| stage.narration_fingerprint != narration_fingerprint)
    {
        invalidate_main_footage(state, MainFootageInvalidation::NarrationChanged);
    }
    state.save(&job.state_path())?;
    execution.check_cancelled()?;

    let render_fingerprint = port.render_settings_fingerprint();
    if state.stages.main_footage.as_ref().is_some_and(|stage| {
        stage.render_settings_fingerprint.as_deref() != Some(render_fingerprint.as_str())
    }) {
        invalidate_main_footage(state, MainFootageInvalidation::RenderSettingsChanged);
        state.save(&job.state_path())?;
        execution.check_cancelled()?;
    }

    let mut resumed = false;
    let mut verified = None;
    if state.stages.main_footage.is_some() {
        if let Some(candidate) = port
            .resume_verified(job, planned, &imported, &narration, execution)
            .await?
        {
            let candidate_state = port.verified_state(&candidate);
            if main_footage_is_fresh(
                state.stages.main_footage.as_ref(),
                &candidate_state.source_package_fingerprint,
                &candidate_state.narration_fingerprint,
                &candidate_state.plan_fingerprint,
                &candidate_state.active_version,
            ) {
                resumed = true;
                verified = Some(candidate);
            }
        }
    }
    let verified = match verified {
        Some(verified) => {
            emit_planned_checkpoint(MainFootageProgressStage::PlanningCuts, 0.25);
            emit_planned_checkpoint(MainFootageProgressStage::MaterializingCuts, 0.55);
            emit_planned_checkpoint(MainFootageProgressStage::VerifyingPlan, 0.8);
            verified
        }
        None => port
            .prepare_plan(job, planned, &imported, &narration, execution)
            .await
            .map_err(|error| {
                planned_error(
                    error,
                    MainFootageErrorCode::CutPlanningFailed,
                    "planner_stage_failed",
                )
            })?,
    };
    execution.check_cancelled()?;
    let mut verified_state = port.verified_state(&verified);
    if !main_footage_is_fresh(
        state.stages.main_footage.as_ref(),
        &verified_state.source_package_fingerprint,
        &verified_state.narration_fingerprint,
        &verified_state.plan_fingerprint,
        &verified_state.active_version,
    ) {
        state.stages.edit = None;
    }
    verified_state.render_settings_fingerprint = Some(render_fingerprint);
    state.stages.main_footage = Some(verified_state);
    state.save(&job.state_path())?;
    execution.check_cancelled()?;

    if resumed {
        if let Some(paths) = rendered_paths(state) {
            emit_planned_checkpoint(MainFootageProgressStage::Rendering, 1.0);
            execution.check_cancelled()?;
            return Ok(paths);
        }
    }

    let edit = port.render(job, &verified, &narration, execution).await?;
    execution.check_cancelled()?;
    state.stages.edit = Some(edit);
    state.save(&job.state_path())?;
    execution.check_cancelled()?;
    emit_planned_checkpoint(MainFootageProgressStage::Rendering, 1.0);
    execution.check_cancelled()?;
    rendered_paths(state).ok_or_else(|| {
        crate::main_footage::MainFootageError::new(
            MainFootageErrorCode::PlanVerificationFailed,
            "planned_render_output_missing",
        )
        .into()
    })
}

struct ProductionPlannedMainStages<'a, 'b, R> {
    runner: &'a PipelineRunner<'b>,
    provider: &'a LlmProviderName,
    layout: crate::edit::layout::OutputLayout,
    audio: &'a AudioOptions,
    social_name: &'a str,
    style_profile_name: &'a str,
    renderer: &'a R,
}

fn timeline_error(detail: &'static str) -> anyhow::Error {
    crate::main_footage::MainFootageError::new(
        crate::main_footage::MainFootageErrorCode::NarrationGenerationFailed,
        detail,
    )
    .into()
}

#[async_trait]
impl<R: PlannedMainRenderer> PlannedMainStagePort for ProductionPlannedMainStages<'_, '_, R> {
    type Imported = crate::main_footage::ImportedSourcePackage;
    type Narration = crate::main_footage::NarrationTimelineV1;
    type Verified = crate::main_footage::VerifiedMainFootagePlan;

    async fn import_sources(
        &self,
        job: &JobContext,
        planned: &PlannedMainInput,
        execution: &JobExecutionContext,
    ) -> Result<Self::Imported> {
        crate::main_footage::import_package(
            &planned.content_set_path,
            &planned.descriptor,
            job,
            &planned.scout_output_root,
            execution,
        )
    }

    fn source_fingerprint<'b>(&self, imported: &'b Self::Imported) -> &'b str {
        &imported.fingerprint
    }

    fn validate_scene_index(&self, _job: &JobContext, imported: &Self::Imported) -> Result<()> {
        for index in &imported.package.scene_indexes {
            let path =
                crate::main_footage::resolve_contained(&imported.root, Path::new(&index.path))
                    .map_err(|_| {
                        crate::main_footage::MainFootageError::new(
                            crate::main_footage::MainFootageErrorCode::SourcePackageInvalid,
                            "scene_index_outside_job_root",
                        )
                    })?;
            let bytes = std::fs::read(path).map_err(|_| {
                crate::main_footage::MainFootageError::new(
                    crate::main_footage::MainFootageErrorCode::SourcePackageInvalid,
                    "scene_index_unreadable",
                )
            })?;
            serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| {
                crate::main_footage::MainFootageError::new(
                    crate::main_footage::MainFootageErrorCode::SourcePackageInvalid,
                    "scene_index_not_json",
                )
            })?;
        }
        Ok(())
    }

    fn load_narration(&self, job: &JobContext) -> Result<Option<Self::Narration>> {
        let path = job.narration_timeline();
        if !path.is_file() {
            return Ok(None);
        }
        let timeline: crate::main_footage::NarrationTimelineV1 = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| timeline_error("narration_timeline_unreadable"))?,
        )
        .map_err(|_| timeline_error("narration_timeline_unreadable"))?;
        let value = serde_json::to_value(&timeline)
            .map_err(|_| timeline_error("narration_timeline_unreadable"))?;
        let fingerprint = crate::main_footage::fingerprint_canonical(&value)
            .map_err(|_| timeline_error("narration_fingerprint_failed"))?;
        if timeline.fingerprint.as_deref() != Some(fingerprint.as_str()) {
            return Err(timeline_error("narration_fingerprint_mismatch"));
        }
        Ok(Some(timeline))
    }

    async fn generate_narration(
        &self,
        job: &JobContext,
        _execution: &JobExecutionContext,
    ) -> Result<Self::Narration> {
        let narration = self.runner.generate_narration(job, self.provider).await?;
        let timeline = crate::narration::timeline::build_narration_timeline(
            &narration,
            crate::narration::timeline::BeatPolicy::default(),
        )?;
        crate::narration::timeline::write_narration_timeline(job, &timeline)?;
        Ok(timeline)
    }

    fn narration_fingerprint<'b>(&self, narration: &'b Self::Narration) -> &'b str {
        narration
            .fingerprint
            .as_deref()
            .expect("validated narration timeline always has a fingerprint")
    }

    async fn resume_verified(
        &self,
        job: &JobContext,
        planned: &PlannedMainInput,
        imported: &Self::Imported,
        narration: &Self::Narration,
        execution: &JobExecutionContext,
    ) -> Result<Option<Self::Verified>> {
        crate::main_footage::MainFootageCoordinator::prepare(
            job,
            crate::main_footage::MainFootagePrepareInput {
                imported,
                coverage_target: planned.descriptor.coverage_target,
            },
            narration,
            execution,
        )
        .await
        .map(Some)
    }

    async fn prepare_plan(
        &self,
        job: &JobContext,
        planned: &PlannedMainInput,
        imported: &Self::Imported,
        narration: &Self::Narration,
        execution: &JobExecutionContext,
    ) -> Result<Self::Verified> {
        crate::main_footage::MainFootageCoordinator::prepare(
            job,
            crate::main_footage::MainFootagePrepareInput {
                imported,
                coverage_target: planned.descriptor.coverage_target,
            },
            narration,
            execution,
        )
        .await
    }

    fn verified_state(&self, verified: &Self::Verified) -> MainFootageStageResult {
        MainFootageStageResult::from_verified(verified)
    }

    fn render_settings_fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};

        let mut hash = Sha256::new();
        hash.update(format!(
            "{:?}|{:?}|{}|{}|{}|{}|{}",
            self.layout,
            self.audio,
            self.social_name,
            self.style_profile_name,
            self.runner.config.narration.duck_event_vol,
            self.runner.config.narration.leak_event_vol,
            self.runner.config.narration.lead_in_secs,
        ));
        format!("sha256:{:x}", hash.finalize())
    }

    async fn render(
        &self,
        job: &JobContext,
        verified: &Self::Verified,
        narration: &Self::Narration,
        execution: &JobExecutionContext,
    ) -> Result<crate::edit::service::EditResult> {
        self.renderer
            .render(
                job,
                verified,
                narration,
                &self.layout,
                self.audio,
                self.social_name,
                self.style_profile_name,
                execution,
            )
            .await
    }
}

pub struct PipelineRunner<'a> {
    config: &'a AppConfig,
    execution: &'a JobExecutionContext,
    main_is_video: bool,
}

impl<'a> PipelineRunner<'a> {
    pub fn new(config: &'a AppConfig, execution: &'a JobExecutionContext) -> Self {
        Self {
            config,
            execution,
            main_is_video: true,
        }
    }

    pub fn with_main_is_video(mut self, main_is_video: bool) -> Self {
        self.main_is_video = main_is_video;
        self
    }

    /// Execute the forced URL-pool branch without entering the single-main
    /// ingest/transcribe/analyze/edit chain. Every media input after import is a
    /// job-owned local artifact; the injected renderer sees only a verified plan.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_planned_main<R: PlannedMainRenderer>(
        &self,
        planned: &PlannedMainInput,
        output_dir: &Path,
        provider: &LlmProviderName,
        layout: &CliLayout,
        audio_opts: &AudioOptions,
        social_name: &str,
        resume_id: Option<&str>,
        style_profile_name: &str,
        job_id_override: Option<&str>,
        renderer: &R,
    ) -> Result<Vec<std::path::PathBuf>> {
        crate::main_footage::require_narration_enabled(self.config.narration.enabled)?;
        self.execution.check_cancelled()?;
        ensure_dir(output_dir)?;
        let job_id = job_id_override
            .or(resume_id)
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let job = build_job_context(job_id_override, job_id.clone(), output_dir)
            .context("failed to create planned job directories")?;
        let mut state = if job.state_path().is_file() {
            PipelineState::load(&job.state_path()).context("failed to load pipeline state")?
        } else {
            PipelineState::new(job_id, String::new())
        };

        // Forced packages can be silent b-roll. Narration grounding comes from
        // the Content Set sidecars prepared by `run_once`; the transcript input
        // still exists as a typed empty artifact so generation never falls back
        // to downloading/transcribing one arbitrary source.
        if !job.transcript_path().is_file() {
            let transcript = crate::transcribe::model::Transcript {
                segments: Vec::new(),
                duration_ms: 0,
            };
            std::fs::write(
                job.transcript_path(),
                serde_json::to_vec_pretty(&transcript)?,
            )?;
        }
        ensure_dir(&job.narration_dir())?;

        let stages = ProductionPlannedMainStages {
            runner: self,
            provider,
            layout: crate::edit::layout::OutputLayout::from(layout),
            audio: audio_opts,
            social_name,
            style_profile_name,
            renderer,
        };
        run_planned_main_with(&job, &mut state, planned, self.execution, &stages).await
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

        let main_is_video = self.main_is_video;

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
        if self.config.narration.enabled && !job.narration_mp3().exists() {
            self.execution.check_cancelled()?;
            stage_header(5, 6, "Narration  (narrator voiceover)");
            match self.generate_narration(&job, provider).await {
                Ok(_) => {}
                Err(e) => {
                    // The raw error can carry a model response body, which the
                    // typed error deliberately withholds — keep it out of the
                    // operator-facing line and off the wire.
                    debug!(error = %e, "narration stage failed");
                    warn!("Narration failed — continuing without narrator");
                }
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
mod planned_main_orchestration_tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::{PlannedMainInput, PlannedMainStagePort, run_planned_main_with};
    use crate::edit::service::{ClipOutput, EditResult};
    use crate::execution::JobExecutionContext;
    use crate::main_footage::{MainFootageError, MainFootageErrorCode, PlanningMode};
    use crate::pipeline::job::JobContext;
    use crate::pipeline::state::{MainFootageStageResult, PipelineState};

    static PLANNED_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[derive(Clone)]
    struct Artifact {
        fingerprint: String,
    }

    struct FakeStages {
        calls: Mutex<Vec<&'static str>>,
        source_fingerprint: &'static str,
        narration_fingerprint: &'static str,
        plan_fingerprint: &'static str,
        fail: Option<&'static str>,
        cancel_after_import: bool,
        reuse_narration: bool,
    }

    impl FakeStages {
        fn success() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                source_fingerprint: "sha256:source",
                narration_fingerprint: "sha256:narration",
                plan_fingerprint: "sha256:plan",
                fail: None,
                cancel_after_import: false,
                reuse_narration: false,
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }

        fn push(&self, value: &'static str) {
            self.calls.lock().unwrap().push(value);
        }

        fn stage_result(&self) -> MainFootageStageResult {
            MainFootageStageResult {
                source_package_fingerprint: self.source_fingerprint.into(),
                narration_fingerprint: self.narration_fingerprint.into(),
                plan_fingerprint: self.plan_fingerprint.into(),
                active_version: "v001".into(),
                render_settings_fingerprint: None,
                planning_mode: PlanningMode::Vision,
                coverage_target: 0.6,
                main_coverage_sec: 6.0,
                main_coverage_ratio: 1.0,
                total_duration_sec: 6.0,
                selected_cut_count: 1,
                candidate_count: 1,
                transition_distribution: BTreeMap::new(),
                warnings: Vec::new(),
                retained_bytes: 7,
                completed_at: chrono::Utc::now(),
            }
        }
    }

    #[async_trait]
    impl PlannedMainStagePort for FakeStages {
        type Imported = Artifact;
        type Narration = Artifact;
        type Verified = MainFootageStageResult;

        async fn import_sources(
            &self,
            job: &JobContext,
            _planned: &PlannedMainInput,
            execution: &JobExecutionContext,
        ) -> anyhow::Result<Self::Imported> {
            self.push("import");
            std::fs::create_dir_all(job.main_footage_dir())?;
            std::fs::write(job.source_package_manifest(), b"immutable package")?;
            if self.cancel_after_import {
                execution.cancel();
            }
            Ok(Artifact {
                fingerprint: self.source_fingerprint.into(),
            })
        }

        fn source_fingerprint<'b>(&self, imported: &'b Self::Imported) -> &'b str {
            &imported.fingerprint
        }

        fn validate_scene_index(
            &self,
            _job: &JobContext,
            _imported: &Self::Imported,
        ) -> anyhow::Result<()> {
            self.push("validate");
            Ok(())
        }

        fn load_narration(&self, _job: &JobContext) -> anyhow::Result<Option<Self::Narration>> {
            Ok(self.reuse_narration.then(|| Artifact {
                fingerprint: self.narration_fingerprint.into(),
            }))
        }

        async fn generate_narration(
            &self,
            _job: &JobContext,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<Self::Narration> {
            self.push("narration");
            if self.fail == Some("narration") {
                anyhow::bail!("provider response with https://private.test/?token=secret");
            }
            Ok(Artifact {
                fingerprint: self.narration_fingerprint.into(),
            })
        }

        fn narration_fingerprint<'b>(&self, narration: &'b Self::Narration) -> &'b str {
            &narration.fingerprint
        }

        async fn resume_verified(
            &self,
            _job: &JobContext,
            _planned: &PlannedMainInput,
            _imported: &Self::Imported,
            _narration: &Self::Narration,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<Option<Self::Verified>> {
            Ok(self.reuse_narration.then(|| self.stage_result()))
        }

        async fn prepare_plan(
            &self,
            _job: &JobContext,
            _planned: &PlannedMainInput,
            _imported: &Self::Imported,
            _narration: &Self::Narration,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<Self::Verified> {
            self.push("planning");
            crate::util::progress::emit_stage("planning_cuts", 0.25, "planning main-footage cuts");
            if self.fail == Some("planner") {
                anyhow::bail!("planner leaked C:\\private\\signed-url");
            }
            self.push("materialization");
            crate::util::progress::emit_stage(
                "materializing_cuts",
                0.55,
                "materializing main-footage cuts",
            );
            self.push("verification");
            crate::util::progress::emit_stage("verifying_plan", 0.8, "verifying main-footage plan");
            if self.fail == Some("missing_cut") {
                return Err(MainFootageError::new(
                    MainFootageErrorCode::PlanVerificationFailed,
                    "cut_file_missing",
                )
                .into());
            }
            Ok(self.stage_result())
        }

        fn verified_state(&self, verified: &Self::Verified) -> MainFootageStageResult {
            verified.clone()
        }

        fn render_settings_fingerprint(&self) -> String {
            "sha256:render-settings".into()
        }

        async fn render(
            &self,
            job: &JobContext,
            _verified: &Self::Verified,
            _narration: &Self::Narration,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<EditResult> {
            self.push("render");
            let output = job.root().join("rendered.mp4");
            std::fs::write(&output, b"render")?;
            Ok(EditResult {
                output_clips: vec![ClipOutput {
                    clip_index: 0,
                    title: "planned".into(),
                    path: output,
                    thumb_path: None,
                    duration_secs: 6.0,
                    layout: "vertical".into(),
                }],
                completed_at: chrono::Utc::now(),
            })
        }
    }

    fn fixture() -> (PathBuf, JobContext, PipelineState, PlannedMainInput) {
        let root =
            std::env::temp_dir().join(format!("planned-orchestration-{}", uuid::Uuid::new_v4()));
        let job = JobContext::new_flat("job".into(), root.clone()).unwrap();
        let state = PipelineState::new("job".into(), "forced".into());
        let planned = PlannedMainInput {
            content_set_path: root.join("content-set.json"),
            descriptor: serde_json::from_value(serde_json::json!({
                "mode": "forced_url_pool",
                "package_manifest": "package.json",
                "coverage_target": 0.6
            }))
            .unwrap(),
            scout_output_root: root.join("scout"),
        };
        (root, job, state, planned)
    }

    fn code(error: &anyhow::Error) -> MainFootageErrorCode {
        error
            .downcast_ref::<MainFootageError>()
            .unwrap_or_else(|| panic!("expected stable main-footage error, got {error:#}"))
            .code
    }

    /// Production mutation caught: reusing the legacy run path would insert
    /// ingest/transcribe/analyze/edit calls into this exact ordered boundary.
    #[tokio::test]
    async fn planned_branch_orders_local_package_narration_plan_and_renderer_only() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let stages = FakeStages::success();

        let paths = run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap();

        assert_eq!(
            stages.calls(),
            [
                "import",
                "validate",
                "narration",
                "planning",
                "materialization",
                "verification",
                "render"
            ]
        );
        assert_eq!(paths.len(), 1);
        assert!(
            state.stages.ingest.is_none(),
            "forced mode called legacy ingest"
        );
        assert!(state.stages.transcribe.is_none());
        assert!(state.stages.analyze.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn narration_failure_is_terminal_and_redacted() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.fail = Some("narration");

        let error = run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap_err();

        assert_eq!(
            code(&error),
            MainFootageErrorCode::NarrationGenerationFailed
        );
        assert_eq!(stages.calls(), ["import", "validate", "narration"]);
        assert!(!error.to_string().contains("private.test"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn planner_failure_maps_to_cut_planning_failed_without_render() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.fail = Some("planner");

        let error = run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap_err();

        assert_eq!(code(&error), MainFootageErrorCode::CutPlanningFailed);
        assert_eq!(
            stages.calls(),
            ["import", "validate", "narration", "planning"]
        );
        assert!(!error.to_string().contains("private"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn missing_verified_cut_fails_before_renderer() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.fail = Some("missing_cut");

        let error = run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap_err();

        assert_eq!(code(&error), MainFootageErrorCode::PlanVerificationFailed);
        assert!(!stages.calls().contains(&"render"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancellation_after_import_retains_package_and_skips_later_stages() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.cancel_after_import = true;
        let execution = JobExecutionContext::new();

        let error = run_planned_main_with(&job, &mut state, &planned, &execution, &stages)
            .await
            .unwrap_err();

        assert!(crate::execution::is_cancelled(&error));
        assert_eq!(stages.calls(), ["import"]);
        assert_eq!(
            std::fs::read(job.source_package_manifest()).unwrap(),
            b"immutable package"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn matching_persisted_resume_skips_narration_planner_and_renderer() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.reuse_narration = true;
        let mut completed = stages.stage_result();
        completed.render_settings_fingerprint = Some("sha256:render-settings".into());
        state.stages.main_footage = Some(completed);
        let output = job.root().join("existing.mp4");
        std::fs::write(&output, b"existing").unwrap();
        state.stages.edit = Some(EditResult {
            output_clips: vec![ClipOutput {
                clip_index: 0,
                title: "existing".into(),
                path: output.clone(),
                thumb_path: None,
                duration_secs: 6.0,
                layout: "vertical".into(),
            }],
            completed_at: chrono::Utc::now(),
        });

        let paths = run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap();

        assert_eq!(paths, [output]);
        assert_eq!(stages.calls(), ["import", "validate"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn state_is_saved_after_verified_identity_and_render_mutations() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let stages = FakeStages::success();

        run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap();
        let reloaded = PipelineState::load(&job.state_path()).unwrap();
        let persisted = reloaded.stages.main_footage.unwrap();

        assert_eq!(persisted.source_package_fingerprint, "sha256:source");
        assert_eq!(persisted.narration_fingerprint, "sha256:narration");
        assert_eq!(persisted.plan_fingerprint, "sha256:plan");
        assert_eq!(persisted.active_version, "v001");
        assert!(reloaded.stages.edit.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn source_change_persists_plan_and_render_invalidation_without_deleting_history() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.fail = Some("narration");
        let mut old = stages.stage_result();
        old.source_package_fingerprint = "sha256:old-source".into();
        state.stages.main_footage = Some(old);
        state.stages.edit = Some(EditResult {
            output_clips: Vec::new(),
            completed_at: chrono::Utc::now(),
        });
        let retained = [
            job.root().join("plans/v001/main-footage-plan.json"),
            job.root().join("cuts/v001/cut-001.mp4"),
        ];
        for path in &retained {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"immutable").unwrap();
        }

        run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap_err();
        let persisted = PipelineState::load(&job.state_path()).unwrap();

        assert!(persisted.stages.main_footage.is_none());
        assert!(persisted.stages.edit.is_none());
        assert!(retained.iter().all(|path| path.is_file()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn narration_change_persists_downstream_invalidation_before_planner_failure() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.fail = Some("planner");
        let mut old = stages.stage_result();
        old.narration_fingerprint = "sha256:old-narration".into();
        state.stages.main_footage = Some(old);
        state.stages.edit = Some(EditResult {
            output_clips: Vec::new(),
            completed_at: chrono::Utc::now(),
        });

        run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap_err();
        let persisted = PipelineState::load(&job.state_path()).unwrap();

        assert!(persisted.stages.main_footage.is_none());
        assert!(persisted.stages.edit.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn render_settings_change_reuses_verified_plan_but_reruns_renderer() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let mut stages = FakeStages::success();
        stages.reuse_narration = true;
        let mut old = stages.stage_result();
        old.render_settings_fingerprint = Some("sha256:old-render-settings".into());
        state.stages.main_footage = Some(old);
        let stale = job.root().join("stale.mp4");
        std::fs::write(&stale, b"stale").unwrap();
        state.stages.edit = Some(EditResult {
            output_clips: vec![ClipOutput {
                clip_index: 0,
                title: "stale".into(),
                path: stale,
                thumb_path: None,
                duration_secs: 6.0,
                layout: "horizontal".into(),
            }],
            completed_at: chrono::Utc::now(),
        });

        let paths = run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap();

        assert_eq!(stages.calls(), ["import", "validate", "render"]);
        assert!(paths[0].ends_with("rendered.mp4"));
        let persisted = PipelineState::load(&job.state_path()).unwrap();
        assert_eq!(
            persisted
                .stages
                .main_footage
                .unwrap()
                .render_settings_fingerprint
                .as_deref(),
            Some("sha256:render-settings")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn successful_run_emits_the_complete_safe_progress_vocabulary_monotonically() {
        let _guard = PLANNED_TEST_LOCK.lock().unwrap();
        let (root, job, mut state, planned) = fixture();
        let stages = FakeStages::success();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        crate::util::progress::set_sink(Box::new(move |event| sink.lock().unwrap().push(event)));

        run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &stages,
        )
        .await
        .unwrap();
        crate::util::progress::set_sink(Box::new(|_| {}));
        let events = seen.lock().unwrap();
        let vocabulary = events
            .iter()
            .map(|event| event.stage.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            vocabulary,
            [
                "importing_sources",
                "validating_scene_index",
                "generating_narration",
                "planning_cuts",
                "materializing_cuts",
                "verifying_plan",
                "rendering",
            ]
        );
        assert!(events.windows(2).all(|pair| pair[0].pct <= pair[1].pct));
        assert!(
            events
                .iter()
                .all(|event| !event.message.contains("\\") && !event.message.contains("http"))
        );
        drop(events);
        let _ = std::fs::remove_dir_all(root);
    }
}
