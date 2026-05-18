use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{debug, info, warn};

use crate::config::AppConfig;
use crate::pipeline::job::JobContext;
use crate::util::progress::{percent_bar, spinner, stage_done};

use super::error::IngestError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestResult {
    pub video_path: PathBuf,
    pub audio_path: PathBuf,
    pub title: String,
    pub duration_secs: f64,
    pub video_id: String,
    pub completed_at: DateTime<Utc>,
}

pub struct IngestService<'a> {
    config: &'a AppConfig,
    job: &'a JobContext,
}

impl<'a> IngestService<'a> {
    pub fn new(config: &'a AppConfig, job: &'a JobContext) -> Self {
        Self { config, job }
    }

    pub async fn run(&self, url: &str, force: bool) -> Result<IngestResult, IngestError> {
        let t0 = Instant::now();
        let out_template = self
            .job
            .source_dir()
            .join("%(id)s.%(ext)s")
            .to_string_lossy()
            .to_string();

        // Reuse existing download unless force flag is set
        if !force {
            if let Some(existing) = self.find_existing_video().await? {
                info!("  ↩ reusing cached download: {}", existing.display());
                let result = self.build_result(existing).await?;
                eprintln!(
                    "  ✓ Ingest skipped — video already downloaded ({:.0}s, {})",
                    t0.elapsed().as_secs_f64(),
                    result.title
                );
                return Ok(result);
            }
        }

        eprintln!("  ↓ Fetching metadata for: {url}");
        let pb = spinner("Waiting for yt-dlp…");

        let ytdlp = &self.config.ingest.ytdlp_path;
        let mut cmd = tokio::process::Command::new(ytdlp);
        // Tell yt-dlp exactly where our FFmpeg binary is so it can merge
        // video + audio streams (required for bestvideo+bestaudio format)
        let ffmpeg_bin = ffmpeg_sidecar::paths::ffmpeg_path();
        let ffmpeg_dir = ffmpeg_bin
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        cmd.args([
            "--no-playlist",
            "--write-info-json",
            "--retries",
            "5",
            "--fragment-retries",
            "5",
            "--format",
            &self.config.ingest.format,
            // Tell yt-dlp where FFmpeg lives so it can merge streams
            "--ffmpeg-location",
            &ffmpeg_dir,
            // Always produce a single MP4 output after merge
            "--merge-output-format",
            "mp4",
            "--output",
            &out_template,
            "--newline",
            url,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        debug!("spawning yt-dlp: {:?}", cmd);

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                IngestError::YtDlpNotFound {
                    path: ytdlp.clone(),
                    source: e,
                }
            } else {
                IngestError::Io(e)
            }
        })?;

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();

        // Collect stderr in the background so we can report it on failure
        let stderr_handle = tokio::spawn(async move {
            let mut buf = String::new();
            while let Ok(Some(line)) = stderr_lines.next_line().await {
                buf.push_str(&line);
                buf.push('\n');
            }
            buf
        });

        // Track whether we have switched to the percent bar yet
        let mut pct_bar: Option<indicatif::ProgressBar> = None;
        let mut current_file_desc = String::from("video");

        while let Ok(Some(line)) = stdout_lines.next_line().await {
            debug!("yt-dlp stdout: {line}");

            // yt-dlp prints the destination file before downloading
            if line.starts_with("[download] Destination:") {
                let fname = line
                    .trim_start_matches("[download] Destination:")
                    .trim()
                    .to_owned();
                current_file_desc = fname
                    .rsplit('/')
                    .next()
                    .or_else(|| fname.rsplit('\\').next())
                    .unwrap_or(&fname)
                    .to_owned();

                // Swap spinner → percent bar on first file destination
                if pct_bar.is_none() {
                    pb.finish_and_clear();
                    let bar = percent_bar(&format!("  Downloading {current_file_desc}"));
                    pct_bar = Some(bar);
                } else if let Some(ref bar) = pct_bar {
                    bar.set_message(format!("  Downloading {current_file_desc}"));
                    bar.set_position(0);
                }
                continue;
            }

            if let Some(pct) = parse_download_percent(&line) {
                // Extract speed and ETA from the line for richer display
                let extra = parse_speed_eta(&line).unwrap_or_default();
                if let Some(ref bar) = pct_bar {
                    bar.set_position(pct as u64);
                    bar.set_message(format!("  Downloading {current_file_desc}{extra}"));
                } else {
                    pb.set_message(format!("Downloading {pct:.0}%{extra}"));
                }
            } else if line.contains("[download] 100%") {
                if let Some(ref bar) = pct_bar {
                    bar.set_position(100);
                }
            } else if line.contains("[Merger]") {
                if let Some(ref bar) = pct_bar {
                    bar.finish_and_clear();
                }
                pb.reset();
                pb.set_message("Merging video + audio streams…");
                pb.enable_steady_tick(std::time::Duration::from_millis(80));
                pct_bar = None;
            } else if line.contains("[ExtractAudio]") {
                if let Some(ref bar) = pct_bar {
                    bar.finish_and_clear();
                }
                pb.reset();
                pb.set_message("Extracting audio…");
                pb.enable_steady_tick(std::time::Duration::from_millis(80));
                pct_bar = None;
            } else if line.contains("[info]") || line.contains("[youtube]") {
                // Strip brackets from yt-dlp status lines
                let msg = line
                    .trim_start_matches('[')
                    .splitn(2, ']')
                    .nth(1)
                    .unwrap_or(&line)
                    .trim()
                    .to_owned();
                pb.set_message(msg);
            }
        }

        // Clean up whichever bar is still active
        if let Some(bar) = pct_bar {
            bar.finish_and_clear();
        } else {
            pb.finish_and_clear();
        }

        let status = child.wait().await.map_err(IngestError::Io)?;
        let stderr_buf = stderr_handle.await.unwrap_or_default();

        if !status.success() {
            let code = status.code().unwrap_or(-1);
            warn!("yt-dlp stderr:\n{stderr_buf}");
            return Err(IngestError::YtDlpFailed { code, stderr: stderr_buf });
        }

        // Find final merged video — or merge video+audio ourselves if yt-dlp
        // downloaded them separately (happens when yt-dlp can't find FFmpeg)
        let video_path = self
            .find_or_merge_video()
            .await?
            .ok_or_else(|| IngestError::OutputMissing(self.job.source_dir()))?;

        let result = self.build_result(video_path).await?;

        let size_mb = std::fs::metadata(&result.video_path)
            .map(|m| m.len() as f64 / 1_048_576.0)
            .unwrap_or(0.0);

        info!(
            "download complete — \"{}\" ({:.0}s, {:.1} MB)",
            result.title, result.duration_secs, size_mb
        );
        stage_done("Ingest", t0.elapsed());

        Ok(result)
    }

    async fn find_existing_video(&self) -> Result<Option<PathBuf>, IngestError> {
        let dir = self.job.source_dir();
        if !dir.exists() {
            return Ok(None);
        }

        // Collect video files from the source directory.
        // yt-dlp naming convention:
        //   "abc123.mp4"        → final merged output  ← PREFER THIS
        //   "abc123.f399.mp4"   → intermediate video-only stream (no audio)
        //   "abc123.f251.webm"  → intermediate audio-only stream (skip)
        let mut candidates: Vec<PathBuf> = Vec::new();
        let mut entries = tokio::fs::read_dir(&dir).await.map_err(IngestError::Io)?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let p = entry.path();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            // Only consider video container formats; skip .m4a/.webm audio-only files
            if matches!(ext, "mp4" | "mkv" | "mov") {
                candidates.push(p);
            }
        }

        if candidates.is_empty() {
            return Ok(None);
        }

        // Priority 1: merged output — stem has NO dot (no yt-dlp format ID)
        // e.g. "abc123.mp4" beats "abc123.f399.mp4"
        let merged = candidates.iter().find(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| !s.contains('.'))
                .unwrap_or(false)
        });
        if let Some(best) = merged {
            return Ok(Some(best.clone()));
        }

        // Priority 2: largest file (best proxy for the merged/highest-quality stream)
        candidates.sort_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
        Ok(candidates.into_iter().last())
    }

    /// Find the merged output video OR merge separate video+audio files ourselves.
    ///
    /// yt-dlp sometimes downloads video and audio as separate streams
    /// (e.g. `abc.f399.mp4` + `abc.f251.webm`) when it can't locate FFmpeg.
    /// This function detects that case and merges them using our FFmpeg.
    async fn find_or_merge_video(&self) -> Result<Option<PathBuf>, IngestError> {
        let dir = self.job.source_dir();
        if !dir.exists() {
            return Ok(None);
        }

        // Scan the source directory for all downloaded files
        let mut video_candidates: Vec<(PathBuf, u64)> = Vec::new(); // (path, size)
        let mut audio_candidates: Vec<PathBuf> = Vec::new();
        let mut merged_file: Option<PathBuf> = None;

        let mut entries = tokio::fs::read_dir(&dir).await.map_err(IngestError::Io)?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let p = entry.path();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);

            if matches!(ext, "json" | "wav" | "mp3") {
                continue; // skip info/audio extract files
            }

            if !stem.contains('.') {
                // Clean stem → already merged (e.g. "abc123.mp4")
                if matches!(ext, "mp4" | "mkv" | "mov") {
                    merged_file = Some(p);
                }
            } else {
                // Has format ID → intermediate stream
                match ext {
                    "mp4" | "mkv" | "mov" => video_candidates.push((p, size)),
                    "webm" | "m4a" | "aac" | "opus" | "ogg" => audio_candidates.push(p),
                    _ => {}
                }
            }
        }

        // Best case: already merged
        if let Some(merged) = merged_file {
            debug!("found merged video: {}", merged.display());
            return Ok(Some(merged));
        }

        // Need to merge: pick the largest video candidate + first audio candidate
        video_candidates.sort_by_key(|(_, s)| *s);
        let video_file = match video_candidates.into_iter().last() {
            Some((p, _)) => p,
            None => return Ok(None), // no video at all
        };
        let audio_file = match audio_candidates.into_iter().next() {
            Some(p) => p,
            None => {
                // Only video, no separate audio — return video as-is
                warn!("no audio stream found alongside video; using video-only file");
                return Ok(Some(video_file));
            }
        };

        // Derive output name from the video file's first component before the '.'
        let video_id = video_file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("video")
            .split('.')
            .next()
            .unwrap_or("video");
        let merged_path = dir.join(format!("{video_id}.mp4"));

        info!(
            "merging: {} + {} → {}",
            video_file.file_name().unwrap_or_default().to_string_lossy(),
            audio_file.file_name().unwrap_or_default().to_string_lossy(),
            merged_path.file_name().unwrap_or_default().to_string_lossy(),
        );

        let pb = spinner("Merging video + audio streams…");

        let status = crate::util::ffmpeg::command()
            .args([
                "-y",
                "-i", &video_file.to_string_lossy(),
                "-i", &audio_file.to_string_lossy(),
                "-c:v", "copy",
                "-c:a", "aac",
                "-b:a", "192k",
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-movflags", "+faststart",
                &merged_path.to_string_lossy(),
            ])
            .spawn()
            .map_err(|e| IngestError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?
            .wait()
            .map_err(IngestError::Io)?;

        pb.finish_and_clear();

        if status.success() && merged_path.exists() {
            info!("merge complete: {}", merged_path.display());
            // Remove intermediate files to save disk space
            let _ = tokio::fs::remove_file(&video_file).await;
            let _ = tokio::fs::remove_file(&audio_file).await;
            Ok(Some(merged_path))
        } else {
            warn!("FFmpeg merge failed, falling back to video-only file");
            Ok(Some(video_file))
        }
    }

    async fn build_result(&self, video_path: PathBuf) -> Result<IngestResult, IngestError> {
        let (title, duration_secs, video_id) = self.load_info_json(&video_path).await;
        let audio_path = video_path.with_extension("wav");
        Ok(IngestResult {
            video_path,
            audio_path,
            title,
            duration_secs,
            video_id,
            completed_at: Utc::now(),
        })
    }

    async fn load_info_json(&self, video_path: &Path) -> (String, f64, String) {
        let info_path = video_path.with_extension("info.json");
        if let Ok(raw) = tokio::fs::read_to_string(&info_path).await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                let title = v["title"].as_str().unwrap_or("Unknown").to_owned();
                let duration = v["duration"].as_f64().unwrap_or(0.0);
                let id = v["id"].as_str().unwrap_or("unknown").to_owned();
                return (title, duration, id);
            }
        }
        let stem = video_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_owned();
        (stem.clone(), 0.0, stem)
    }
}

/// Parse percentage from yt-dlp progress lines.
/// Example: "[download]  23.4% of  45.00MiB at  2.50MiB/s ETA 00:18"
fn parse_download_percent(line: &str) -> Option<f64> {
    if !line.contains("[download]") {
        return None;
    }
    let pct_str = line.split_whitespace().find(|s| s.ends_with('%'))?;
    pct_str.trim_end_matches('%').parse().ok()
}

/// Extract " @ 2.50MiB/s ETA 00:18" suffix for display.
fn parse_speed_eta(line: &str) -> Option<String> {
    let at_pos = line.find(" at ")?;
    let tail = &line[at_pos + 4..];
    // Grab speed and optional ETA
    let parts: Vec<&str> = tail.split_whitespace().collect();
    match parts.as_slice() {
        [speed, "ETA", eta, ..] => Some(format!(" — {speed}  ETA {eta}")),
        [speed, ..] => Some(format!(" — {speed}")),
        _ => None,
    }
}
