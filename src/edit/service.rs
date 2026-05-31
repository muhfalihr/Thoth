use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use chrono::{DateTime, Utc};
use indicatif::MultiProgress;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::analyze::schema::ViralMomentList;
use crate::config::AppConfig;
use crate::util::beat_detect;
use crate::pipeline::job::JobContext;
use crate::transcribe::model::Transcript;
use crate::util::fs::slugify;
use crate::util::progress::{stage_done, step_bar, sub_spinner};

use super::color::ColorGrading;
use super::error::EditError;
use super::ffmpeg::{encode_clip_direct, generate_thumbnail, AudioOptions, ClipStyle, HeadlineOverlay};
use super::layout::OutputLayout;
use super::overlay::{detect_overlay_style, fetch_overlay_clip};
use super::subtitle::{generate_ass, SubtitleStyle};
use super::transition::Transition;
use crate::gpu::processor::{ClipJob, GpuProcessor};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipOutput {
    pub clip_index: usize,
    pub title: String,
    pub path: PathBuf,
    #[serde(default)]
    pub thumb_path: Option<PathBuf>,
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
        video_path:        &Path,
        moments_path:      &Path,
        transcript_path:   &Path,
        layout:            &OutputLayout,
        audio_opts:        &AudioOptions,
        source_channel:     &str,
        social_name:        &str,
        style_profile_name: &str,   // "auto" or "" = LLM per-clip, named = apply profile
    ) -> Result<EditResult, EditError> {
        let t0 = Instant::now();

        // ── Validate social icon (if provided) ───────────────────────────────
        if let Some(icon) = &audio_opts.social_icon {
            if !icon.path.exists() {
                return Err(EditError::FfmpegFailed(format!(
                    "social icon not found: {}", icon.path.display()
                )));
            }
            let ext = icon.path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("png") {
                return Err(EditError::FfmpegFailed(
                    "social icon must be a PNG file (extension .png)".to_owned()
                ));
            }
            if icon.size < audio_opts.social_icon_min_size {
                return Err(EditError::FfmpegFailed(format!(
                    "social icon size {} px is below the minimum {} px",
                    icon.size, audio_opts.social_icon_min_size
                )));
            }
            if icon.size > audio_opts.social_icon_max_size {
                return Err(EditError::FfmpegFailed(format!(
                    "social icon size {} px exceeds the maximum {} px",
                    icon.size, audio_opts.social_icon_max_size
                )));
            }
        }

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

        // Build SFX/BGM catalogs by scanning the configured folders.
        // The catalog knows ALL audio files in each folder and picks the best
        // match per clip based on vibe + energy + viral_type.
        let sfx_catalog = super::sfx::SfxCatalog::new(
            &self.config.assets.sfx_dir,
            &self.config.assets.sfx,
        );
        let bgm_catalog = super::sfx::SfxCatalog::new(
            &self.config.assets.bgm_dir,
            &self.config.assets.bgm,
        );
        super::sfx::log_catalogs(&sfx_catalog, &bgm_catalog);

        // Resolve effective yt-dlp path for overlay downloads
        let overlay_ytdlp = if self.config.overlay.ytdlp_path.is_empty() {
            self.config.ingest.ytdlp_path.clone()
        } else {
            self.config.overlay.ytdlp_path.clone()
        };

        // FFmpeg directory for overlay trim step
        let ffmpeg_bin = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_owned());
        let ffmpeg_dir = std::path::Path::new(&ffmpeg_bin)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

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
            
            // ── Step 0: Align boundaries to sentence boundaries ──────────────
            //
            // Strategy:
            //   1. Use words_starting_in() (looser filter) to find first/last word
            //   2. Snap START backward to the nearest sentence boundary ≤2s back
            //   3. Snap END forward to the nearest sentence boundary ≤2s ahead
            //
            // This ensures clips always begin/end at a natural phrase break, not
            // mid-word or mid-sentence.  The sentence boundary helpers look for
            // Whisper segment breaks where the previous segment ends with .!? or
            // there is a >500ms gap (natural pause).
            let clip_words = transcript.words_starting_in(moment.start_sec, moment.end_sec);
            let (start, end) = if let (Some(first), Some(last)) = (clip_words.first(), clip_words.last()) {
                let word_s = first.start_ms as f64 / 1000.0;
                let word_e = last.end_ms   as f64 / 1000.0;
                // Snap to sentence boundaries (look up to 2.0s in each direction)
                let s = transcript.find_sentence_start_before(word_s, 2.0).max(0.0);
                let e = transcript.find_sentence_end_after(word_e, 2.0).min(video_duration);
                (s, e)
            } else {
                // No words found — use sentence-boundary snapping on the LLM timestamps
                // (better than falling back to potentially mid-sentence timestamps)
                let s = transcript.find_sentence_start_before(moment.start_sec, 3.0).max(0.0);
                let e = transcript.find_sentence_end_after(moment.end_sec,   3.0).min(video_duration);
                (s, e)
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
                "\n  ┄ Clip {}/{}: [{}·{}] \"{}\"  [{:.1}s – {:.1}s | {:.0}s | {} | {}]",
                i + 1, moments.moments.len(),
                moment.viral_type, moment.content_category, moment.title,
                start, end, duration, moment.energy, moment.emotional_trigger
            );
            // Show which headline text will appear on-screen
            let hl_display = if !moment.headline.is_empty() {
                format!("\"{}\" (AI-crafted)", moment.headline.to_uppercase())
            } else {
                format!("\"{}\" (from title)", moment.title.to_uppercase())
            };
            info!("       📺 Headline: {}", hl_display);
            if !moment.hook.is_empty() {
                info!("       🪝 Hook: \"{}\"", moment.hook);
            }
            if !moment.transcript_segment.is_empty() {
                let preview: String = moment.transcript_segment.chars().take(80).collect();
                info!("       📝 Segment: \"{}{}\"",
                    preview,
                    if moment.transcript_segment.len() > 80 { "…" } else { "" }
                );
            }
            if !moment.target_audience.is_empty() {
                info!("       👥 For: \"{}\"", moment.target_audience);
            }

            // Resolve subtitle style early (needed before Step 1)
            let effective_subtitle_style: String =
                if !style_profile_name.is_empty() && style_profile_name != "auto" {
                    self.config.styles.profiles.get(style_profile_name)
                        .and_then(|p| if p.subtitle_style.is_empty() { None } else { Some(p.subtitle_style.clone()) })
                        .unwrap_or_else(|| moment.subtitle_style.clone())
                } else {
                    moment.subtitle_style.clone()
                };

            // ── Step 1: Generate ASS subtitles ───────────────────────────
            let sp_sub = sub_spinner(&mp, "Generating subtitles (ASS)…");
            let word_count_in_clip = {
                let words = transcript.words_in_window(start, end);
                let n = words.len();
                let sub_style = SubtitleStyle::from_str(&effective_subtitle_style);
                generate_ass(&words, start, &ass_path, &audio_opts.font, &sub_style)?;
                n
            };
            sp_sub.finish_with_message(format!("  ✓ subtitles: {word_count_in_clip} words"));

            // ── Step 2: Single-pass trim + reframe + subtitle + encode ──────
            let sp_enc = sub_spinner(
                &mp,
                &format!(
                    "Encoding {:.1}s–{:.1}s  (reframe + subtitles + {encoder})…",
                    start, end
                ),
            );

            // ── Build headline overlay for this moment ───────────────────────
            // Priority:
            //   1. moment.headline  — LLM-crafted news-ticker text (≤44 chars, ALL CAPS friendly)
            //   2. moment.title     — social-media hook title (fallback for old moments.json)
            // The panel appears for the first headline_dur seconds of the clip.
            let headline_dur = if audio_opts.headline_dur > 0.0 {
                audio_opts.headline_dur
            } else {
                4.0 // default 4 seconds
            };
            let headline = if audio_opts.headline.is_none() {
                // Choose best available headline text
                let hl_text = if !moment.headline.is_empty() {
                    moment.headline.clone()   // LLM-crafted visual overlay ✓
                } else {
                    moment.title.clone()      // fallback: social-media title
                };

                if !hl_text.is_empty() {
                    Some(HeadlineOverlay {
                        headline:      hl_text,
                        source:        source_channel.to_owned(),
                        social:        social_name.to_owned(),
                        duration_secs: headline_dur,
                    })
                } else {
                    None
                }
            } else {
                audio_opts.headline.clone()
            };

            let mut audio_clone  = audio_opts.clone();
            let has_headline     = headline.is_some();
            audio_clone.headline = headline;

            // ── Apply style profile (if specified) ───────────────────────────
            // A style profile overrides the LLM's per-clip field picks with a
            // consistent preset (e.g. "tiktok_id_2025" forces capcut_bold subtitles,
            // flash transitions, etc.).  Fields left empty ("") in the profile defer
            // to the LLM's suggestion.
            // Style profile overrides — owned Strings to avoid borrow lifetime issues
            let (
                effective_moment_clip_style,
                effective_moment_sfx_vibe,
                effective_moment_bgm_vibe,
                effective_moment_overlay_style,
            ): (String, String, String, String) =
            if !style_profile_name.is_empty() && style_profile_name != "auto" {
                if let Some(p) = self.config.styles.profiles.get(style_profile_name) {
                    (
                        if p.clip_style.is_empty()    { moment.clip_style.clone() }    else { p.clip_style.clone() },
                        if p.sfx_vibe.is_empty()      { moment.sfx_vibe.clone() }      else { p.sfx_vibe.clone() },
                        if p.bgm_vibe.is_empty()      { moment.bgm_vibe.clone() }      else { p.bgm_vibe.clone() },
                        if p.overlay_style.is_empty() { moment.overlay_style.clone() } else { p.overlay_style.clone() },
                    )
                } else {
                    warn!("style profile '{}' not found in config.toml — using LLM picks", style_profile_name);
                    (moment.clip_style.clone(), moment.sfx_vibe.clone(),
                     moment.bgm_vibe.clone(), moment.overlay_style.clone())
                }
            } else {
                (moment.clip_style.clone(), moment.sfx_vibe.clone(),
                 moment.bgm_vibe.clone(), moment.overlay_style.clone())
            };

            // ── Resolve per-clip production style ─────────────────────────────
            // CLI flags (--clip-style / --sfx / --bgm) act as global overrides.
            // Then style profile overrides. Then LLM per-clip suggestion.

            // clip_style
            if !effective_moment_clip_style.is_empty() && effective_moment_clip_style != "fade" {
                if audio_opts.clip_style == ClipStyle::Fade {
                    audio_clone.clip_style = ClipStyle::from_vibe(&effective_moment_clip_style);
                }
            }

            // sfx via catalog (considers vibe + energy + viral_type + rotation)
            if audio_opts.sfx_intro.is_none() {
                audio_clone.sfx_intro = sfx_catalog.pick(
                    &effective_moment_sfx_vibe,
                    &moment.energy,
                    &moment.viral_type,
                    i,
                );
            }

            // bgm via catalog
            if audio_opts.bgm.is_none() {
                audio_clone.bgm = bgm_catalog.pick(
                    &effective_moment_bgm_vibe,
                    &moment.energy,
                    &moment.viral_type,
                    i,
                );
            }

            // Store effective overlay style back for overlay download step
            let _ = effective_moment_overlay_style; // used in overlay detection below

            let sfx_label = audio_clone.sfx_intro.as_ref()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| format!("{} (vibe={})", s, moment.sfx_vibe))
                .unwrap_or_else(|| "none".to_owned());
            let bgm_label = audio_clone.bgm.as_ref()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| format!("{} (vibe={})", s, moment.bgm_vibe))
                .unwrap_or_else(|| "none".to_owned());

            // ── Download overlay clip + detect style (opt-in) ────────────────
            if self.config.overlay.enabled && !moment.overlay_query.is_empty() {
                let clip_duration = end - start;
                let at  = if moment.overlay_at_sec  > 0.0 { moment.overlay_at_sec  } else { 5.0 };
                let dur = if moment.overlay_duration > 0.0 { moment.overlay_duration } else { 4.0 };
                let at_clamped  = at.min(clip_duration - 1.0).max(0.0);
                // Cap show duration to both clip bounds AND max_duration (downloaded file length)
                let dur_clamped = dur
                    .min(clip_duration - at_clamped)
                    .min(self.config.overlay.max_duration)  // never show more than downloaded
                    .max(1.0);

                let mut spec = fetch_overlay_clip(
                    &moment.overlay_query,
                    at_clamped,
                    dur_clamped,
                    &self.config.overlay,
                    &overlay_ytdlp,
                    &ffmpeg_dir,
                    i,  // variant_index → guarantees each clip gets a different video
                ).await;

                // Detect/set overlay style (greenscreen → sticker, LLM hint → respected)
                if let Some(ref mut ov) = spec {
                    ov.style = detect_overlay_style(
                        &ov.path,
                        &moment.overlay_style,    // LLM hint: "sticker"|"pip"|"fullscreen"|"auto"
                        &ffmpeg_dir,
                        &moment.overlay_position, // LLM position: "bottom_right"|"bottom_left"|...
                    ).await;

                    info!(
                        "       🎬 Overlay: {} | style={:?} | t={:.1}s for {:.1}s | query=\"{}\"",
                        ov.path.file_name().unwrap_or_default().to_string_lossy(),
                        ov.style,
                        ov.at_sec, ov.duration_sec,
                        moment.overlay_query
                    );
                } else {
                    info!("       🎬 Overlay: skipped (query=\"{}\")", moment.overlay_query);
                }

                audio_clone.overlay = spec;
            }

            // ── Beat-sync: align transitions + SFX to BGM downbeats ─────────
            if self.config.assets.beat_sync {
                if let Some(ref bgm_path) = audio_clone.bgm {
                    let bpm      = beat_detect::detect_bpm(bgm_path, &effective_moment_bgm_vibe).await;
                    let interval = beat_detect::beat_interval_ms(bpm);

                    // Snap SFX beat offset (additive to sfx_at_sec)
                    audio_clone.sfx_beat_offset_ms = beat_detect::nearest_beat_after_ms(bpm, 0);
                    audio_clone.clip_bpm           = bpm;
                    audio_clone.bgm_duck           = true;

                    info!(
                        "       🎵 Beat sync: {:.0} BPM  interval={}ms  \
                         sfx_offset={}ms  transition=beat-aligned  ducking=on",
                        bpm, interval, audio_clone.sfx_beat_offset_ms
                    );
                }
            }

            // ── Dynamic SFX timing from LLM ──────────────────────────────────
            // LLM sets sfx_at_sec to the peak moment (e.g. stat reveal at 8s).
            // 0.0 = play at clip start (default); >0 = delay to peak moment.
            if moment.sfx_at_sec > 0.0 {
                let at_clamped = moment.sfx_at_sec.min((end - start) - 0.5).max(0.0);
                audio_clone.sfx_at_sec = at_clamped;
                info!("       🔊 SFX peak moment: t={:.1}s from clip start", at_clamped);
            }
            if moment.sfx_duration_sec > 0.0 {
                audio_clone.sfx_duration_sec = moment.sfx_duration_sec.clamp(0.5, 5.0);
            }

            info!(
                "       🎬 Style: {} | 🔊 SFX: {} | 🎵 BGM: {}",
                format!("{:?}", audio_clone.clip_style).to_lowercase(),
                sfx_label,
                bgm_label,
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
                    None,       // no intro card
                    &audio_clone,
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

            // ── Step 3: Generate Thumbnail ───────────────────────────────────
            let thumb_path = out_path.with_extension("jpg");
            let optimal_time = if moment.overlay_at_sec > 0.0 {
                moment.overlay_at_sec + 0.5
            } else if moment.sfx_at_sec > 0.0 {
                moment.sfx_at_sec
            } else if has_headline {
                // If there's a headline, pick an early frame so the text is fully visible
                (duration / 2.0).min(1.0)
            } else {
                duration / 2.0
            };
            
            // Ensure optimal_time is within bounds
            let thumb_time = optimal_time.clamp(0.0, duration.max(0.1));
            
            let sp_thumb = sub_spinner(&mp, &format!("Generating thumbnail at {:.1}s…", thumb_time));
            let mut final_thumb_path = None;
            if let Err(e) = generate_thumbnail(&out_path, &thumb_path, thumb_time) {
                warn!("failed to generate thumbnail: {}", e);
                sp_thumb.finish_with_message("  ✗ thumbnail failed");
            } else {
                sp_thumb.finish_with_message("  ✓ thumbnail saved");
                final_thumb_path = Some(thumb_path);
            }

            output_clips.push(ClipOutput {
                clip_index: i,
                title: moment.title.clone(),
                path: out_path,
                thumb_path: final_thumb_path,
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

        // ── GPU post-processing (color grading + GPU transitions) ─────────────
        //
        // Runs AFTER all FFmpeg clips are encoded.
        // Two modes based on config:
        //   1. gpu.color_grading=true, gpu.concat_output=false
        //      → Apply color grading to each clip independently (in-place)
        //   2. gpu.concat_output=true
        //      → Concat all clips into one final video with GPU transitions
        let gpu_cfg = &self.config.gpu;
        if gpu_cfg.enabled && (!output_clips.is_empty()) {
            let gpu_sp = sub_spinner(&mp, "Initializing GPU pipeline…");
            match GpuProcessor::new().await {
                Err(e) => {
                    warn!("GPU init failed (falling back to FFmpeg-only): {e}");
                    gpu_sp.finish_with_message("  ✗ GPU unavailable — FFmpeg-only output");
                }
                Ok(gpu) => {
                    gpu_sp.finish_with_message("  ✓ GPU ready");

                    if gpu_cfg.concat_output && output_clips.len() > 1 {
                        // ── Mode 2: concat all clips into one video ───────────
                        let sp = sub_spinner(&mp, &format!(
                            "GPU concat {} clips with transitions…", output_clips.len()
                        ));

                        let jobs: Vec<ClipJob> = output_clips.iter().enumerate()
                            .map(|(i, clip)| {
                                // Resolve color mood for this clip
                                let mood = if !gpu_cfg.default_color_mood.is_empty() {
                                    gpu_cfg.default_color_mood.clone()
                                } else {
                                    moments.moments.get(i)
                                        .map(|m| m.color_mood.clone())
                                        .unwrap_or_default()
                                };
                                let color = ColorGrading::from_mood(&mood).to_gpu_params();

                                // Resolve GPU transition for this clip
                                let tr_name = moments.moments.get(i)
                                    .map(|m| {
                                        let profile_tr = if !style_profile_name.is_empty()
                                            && style_profile_name != "auto"
                                        {
                                            self.config.styles.profiles
                                                .get(style_profile_name)
                                                .map(|p| p.gpu_transition.as_str())
                                                .unwrap_or("")
                                        } else { "" };
                                        if !profile_tr.is_empty() { profile_tr.to_owned() }
                                        else if !m.gpu_transition.is_empty() { m.gpu_transition.clone() }
                                        else { m.clip_style.clone() }
                                    })
                                    .unwrap_or_default();
                                let transition = Transition::from_name(&tr_name);

                                ClipJob::new(&clip.path, 0.0, clip.duration_secs)
                                    .with_color(color)
                                    .with_transition(transition)
                            })
                            .collect();

                        let concat_path = output_clips[0].path
                            .parent().unwrap_or(std::path::Path::new("."))
                            .join("final_concat.mp4");

                        match gpu.concat_gpu(&jobs, &concat_path, self.config.ffmpeg.nvenc).await {
                            Ok(()) => {
                                sp.finish_with_message(format!(
                                    "  ✓ GPU concat → {}", concat_path.display()
                                ));
                                info!("GPU concat complete: {}", concat_path.display());
                            }
                            Err(e) => {
                                warn!("GPU concat failed: {e}");
                                sp.finish_with_message("  ✗ GPU concat failed");
                            }
                        }

                    } else if gpu_cfg.color_grading {
                        // ── Mode 1: apply color grading to each clip ──────────
                        let sp_gpu = sub_spinner(&mp, &format!(
                            "GPU color grading {} clips…", output_clips.len()
                        ));

                        let mut graded = 0usize;
                        for (i, clip) in output_clips.iter_mut().enumerate() {
                            let mood = if !gpu_cfg.default_color_mood.is_empty() {
                                gpu_cfg.default_color_mood.clone()
                            } else {
                                moments.moments.get(i)
                                    .map(|m| m.color_mood.clone())
                                    .unwrap_or_default()
                            };

                            if mood.is_empty() { continue; }

                            let grading = ColorGrading::from_mood(&mood);
                            if grading.is_identity() { continue; }

                            let gpu_out = clip.path.with_extension("gpu.mp4");
                            match gpu.apply_color(
                                &clip.path, &gpu_out,
                                0.0, clip.duration_secs,
                                &grading.to_gpu_params(),
                                self.config.ffmpeg.nvenc,
                            ).await {
                                Ok(()) => {
                                    // Replace original with GPU-graded version
                                    if let Err(e) = std::fs::rename(&gpu_out, &clip.path) {
                                        warn!("rename GPU output failed: {e}");
                                    } else {
                                        graded += 1;
                                    }
                                }
                                Err(e) => warn!("GPU color grading clip {i}: {e}"),
                            }
                        }

                        sp_gpu.finish_with_message(format!(
                            "  ✓ GPU color graded {graded}/{} clips", output_clips.len()
                        ));
                    }
                }
            }
        }

        info!("edit complete: {} clips", output_clips.len());
        stage_done("Edit", t0.elapsed());

        Ok(EditResult {
            output_clips,
            completed_at: Utc::now(),
        })
    }
}
