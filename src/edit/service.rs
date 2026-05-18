use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use chrono::{DateTime, Utc};
use indicatif::MultiProgress;
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::analyze::schema::ViralMomentList;
use crate::config::AppConfig;
use crate::pipeline::job::JobContext;
use crate::transcribe::model::Transcript;
use crate::util::fs::slugify;
use crate::util::progress::{stage_done, step_bar, sub_spinner};

use super::error::EditError;
use super::ffmpeg::encode_clip_direct;
use super::layout::OutputLayout;
use super::subtitle::generate_ass;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipOutput {
    pub clip_index: usize,
    pub title: String,
    pub path: PathBuf,
    pub duration_secs: f64,
    pub layout: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditResult {
    pub output_clips: Vec<ClipOutput>,
    pub completed_at: DateTime<Utc>,
}

pub struct EditService<'a> {
    config: &'a AppConfig,
    job: &'a JobContext,
}

impl<'a> EditService<'a> {
    pub fn new(config: &'a AppConfig, job: &'a JobContext) -> Self {
        Self { config, job }
    }

    pub async fn run(
        &self,
        video_path: &Path,
        moments_path: &Path,
        transcript_path: &Path,
        layout: &OutputLayout,
    ) -> Result<EditResult, EditError> {
        let t0 = Instant::now();

        // Load inputs
        let moments_raw = tokio::fs::read_to_string(moments_path)
            .await
            .map_err(EditError::Io)?;
        let moments: ViralMomentList =
            serde_json::from_str(&moments_raw).map_err(|e| EditError::FfmpegFailed(e.to_string()))?;

        let transcript_raw = tokio::fs::read_to_string(transcript_path)
            .await
            .map_err(EditError::Io)?;
        let mut transcript: Transcript =
            serde_json::from_str(&transcript_raw).map_err(|e| EditError::FfmpegFailed(e.to_string()))?;
        // Fix BPE subword splits (e.g. "bers"+"ama" → "bersama") on load.
        // This is idempotent — safe to call even if already fixed.
        transcript.fix_subwords();

        let encoder = if self.config.ffmpeg.nvenc { "NVENC (GPU)" } else { "libx264 (CPU)" };
        info!(
            "rendering {} clip(s) — layout: {}, encoder: {}",
            moments.moments.len(),
            layout,
            encoder
        );

        // Top-level clip counter bar
        let mp = MultiProgress::new();
        let pb_clips = mp.add(step_bar(moments.moments.len() as u64, "Rendering clips"));

        let mut output_clips = Vec::new();

        for (i, moment) in moments.moments.iter().enumerate() {
            let slug     = slugify(&moment.title);
            let ass_path = self.job.ass_path(i, &slug);
            let out_path = self.job.clip_path(i, &slug);
            let clip_t0  = Instant::now();

            let video_duration = transcript.duration_ms as f64 / 1000.0;
            
            // ── Step 0: Align boundaries to word timestamps + padding ──
            // Find all words in the requested window to find the "real" start/end
            let clip_words = transcript.words_in_window(moment.start_sec, moment.end_sec);
            let (start, end) = if let (Some(first), Some(last)) = (clip_words.first(), clip_words.last()) {
                // Buffer by 0.2s before first word and after last word for natural breath
                let s = (first.start_ms as f64 / 1000.0 - 0.2).max(0.0);
                let e = (last.end_ms as f64 / 1000.0 + 0.2).min(video_duration);
                (s, e)
            } else {
                (moment.start_sec, moment.end_sec)
            };
            let duration = end - start;

            if start >= end || end > video_duration + 1.0 {
                return Err(EditError::InvalidBounds {
                    start,
                    end,
                    duration: video_duration,
                });
            }

            info!(
                "\n  ┄ Clip {}/{}: [{}] \"{}\"  [{:.1}s – {:.1}s | {:.0}s | {}]",
                i + 1, moments.moments.len(),
                moment.viral_type, moment.title,
                start, end, duration, moment.energy
            );
            if !moment.hook.is_empty() {
                info!("       🪝 Hook: \"{}\"", moment.hook);
            }

            // ── Step 1: Generate ASS subtitles ───────────────────────────
            let sp_sub = sub_spinner(&mp, "Generating subtitles (ASS)…");
            let word_count_in_clip = {
                let words = transcript.words_in_window(start, end);
                let n = words.len();
                generate_ass(&words, start, &ass_path)?;
                n
            };
            sp_sub.finish_with_message(format!("  ✓ subtitles: {word_count_in_clip} words"));

            // ── Step 2: Single-pass trim + reframe + subtitle + encode ──────
            //
            // Uses trim=start:end + setpts=PTS-STARTPTS inside the filtergraph so
            // subtitles (0-based in ASS) match the 0-based output timestamps exactly.
            // Also uses atrim+asetpts on the audio stream for A/V sync.
            let sp_enc = sub_spinner(
                &mp,
                &format!(
                    "Encoding {:.1}s–{:.1}s  (seek + reframe + subtitles + {encoder})…",
                    start, end
                ),
            );

            let video_path_clone = video_path.to_owned();
            let ass_path_clone   = ass_path.clone();
            let out_path_clone   = out_path.clone();
            let layout_clone     = layout.clone();
            let cfg_clone        = self.config.ffmpeg.clone();

            tokio::task::spawn_blocking(move || {
                encode_clip_direct(
                    &video_path_clone,
                    start, end,
                    &ass_path_clone,
                    &layout_clone,
                    &out_path_clone,
                    &cfg_clone,
                )
            })
            .await
            .map_err(|e| EditError::FfmpegFailed(e.to_string()))??;

            let out_mb = std::fs::metadata(&out_path)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            sp_enc.finish_with_message(format!(
                "  ✓ encoded  {:.1} MB  ({:.1}s)",
                out_mb, clip_t0.elapsed().as_secs_f64()
            ));

            output_clips.push(ClipOutput {
                clip_index: i,
                title: moment.title.clone(),
                path: out_path,
                duration_secs: duration,
                layout: layout.to_string(),
            });

            pb_clips.inc(1);
        }

        pb_clips.finish_with_message(format!(
            "All {} clips rendered in {:.1}s",
            output_clips.len(),
            t0.elapsed().as_secs_f64()
        ));

        info!("edit complete: {} clips", output_clips.len());
        stage_done("Edit", t0.elapsed());

        Ok(EditResult {
            output_clips,
            completed_at: Utc::now(),
        })
    }
}
