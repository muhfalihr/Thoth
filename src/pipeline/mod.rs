pub mod job;
pub mod state;

use std::path::Path;

use anyhow::{Context, Result};
use tracing::info;
use crate::util::progress::stage_header;
use uuid::Uuid;

use crate::analyze::AnalyzeService;
use crate::cli::{LlmProviderName, OutputLayout as CliLayout, WhisperModelSize};
use crate::config::AppConfig;
use crate::edit::layout::OutputLayout;
use crate::edit::EditService;
use crate::ingest::IngestService;
use crate::transcribe::TranscribeService;
use crate::util::fs::ensure_dir;

use job::JobContext;
use state::PipelineState;

pub struct PipelineRunner<'a> {
    config: &'a AppConfig,
}

impl<'a> PipelineRunner<'a> {
    pub fn new(config: &'a AppConfig) -> Self {
        Self { config }
    }

    pub async fn run(
        &self,
        url: &str,
        output_dir: &Path,
        provider: &LlmProviderName,
        model: &WhisperModelSize,
        max_clips: usize,
        layout: &CliLayout,
        resume_id: Option<&str>,
    ) -> Result<Vec<std::path::PathBuf>> {
        ensure_dir(output_dir)?;

        // Create or load job state
        let job_id = resume_id
            .map(|s| s.to_owned())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let job = JobContext::new(job_id.clone(), output_dir.to_owned())
            .context("failed to create job directories")?;

        let mut state = if resume_id.is_some() && job.state_path().exists() {
            let s = PipelineState::load(&job.state_path()).context("failed to load pipeline state")?;
            info!("resuming job {job_id}");
            s
        } else {
            PipelineState::new(job_id.clone(), url.to_owned())
        };

        // ── Stage 1: Ingest ──────────────────────────────────────────────
        if state.stages.ingest.is_none() {
            stage_header(1, 4, "Ingest  (yt-dlp download)");
            let svc = IngestService::new(self.config, &job);
            let result = svc.run(url, false).await?;
            state.stages.ingest = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 1/4: Ingest — skipped (already complete)");
        }

        // Clone fields out of ingest result before further borrows
        let video_path = state.stages.ingest.as_ref().unwrap().video_path.clone();
        let video_title = state.stages.ingest.as_ref().unwrap().title.clone();
        let video_duration = state.stages.ingest.as_ref().unwrap().duration_secs;

        // ── Stage 2: Transcribe ──────────────────────────────────────────
        if state.stages.transcribe.is_none() {
            stage_header(2, 4, "Transcribe  (Groq Whisper API)");
            info!("  Video : \"{}\"  ({:.0}s)", video_title, video_duration);
            let svc = TranscribeService::new(self.config, &job);
            let result = svc.run(&video_path, &model.to_string()).await?;
            state.stages.transcribe = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 2/4: Transcribe — skipped (already complete)");
        }

        // ── Stage 3: Analyze ─────────────────────────────────────────────
        if state.stages.analyze.is_none() {
            stage_header(3, 4, &format!("Analyze  ({} LLM)", provider));
            let svc = AnalyzeService::new(self.config, &job);
            let result = svc
                .run(&job.transcript_path(), &provider.to_string(), max_clips)
                .await?;
            state.stages.analyze = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 3/4: Analyze — skipped (already complete)");
        }

        // ── Stage 4: Edit ────────────────────────────────────────────────
        if state.stages.edit.is_none() {
            stage_header(4, 4, &format!("Edit  (FFmpeg {layout} clips)"));
            let svc = EditService::new(self.config, &job);
            let out_layout = OutputLayout::from(layout);
            let result = svc
                .run(
                    &video_path,
                    &job.moments_path(),
                    &job.transcript_path(),
                    &out_layout,
                )
                .await?;
            state.stages.edit = Some(result);
            state.save(&job.state_path())?;
        } else {
            info!("Stage 4/4: Edit — skipped (already complete)");
        }

        let edit = state.stages.edit.as_ref().unwrap();
        let paths: Vec<_> = edit.output_clips.iter().map(|c| c.path.clone()).collect();

        eprintln!("\n  ╔══════════════════════════════════════════════════╗");
        eprintln!("  ║  Pipeline complete  —  {} clip(s) ready              ║", paths.len());
        eprintln!("  ╚══════════════════════════════════════════════════╝");
        for (i, clip) in edit.output_clips.iter().enumerate() {
            eprintln!(
                "  [{}] \"{}\"  ({:.0}s)  →  {}",
                i + 1,
                clip.title,
                clip.duration_secs,
                clip.path.display()
            );
        }
        eprintln!();

        Ok(paths)
    }
}
