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

/// Copyright status detected from the video's metadata / info.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CopyrightStatus {
    /// Creative Commons license — can be reused with attribution.
    CreativeCommons { license_name: String },
    /// Standard YouTube license — all rights reserved by the creator / label.
    /// Clipping for personal review is fine, but redistribution may infringe.
    Standard { reason: String },
    /// Copyright indicators found in the description or title.
    SuspectedProtected { indicators: Vec<String> },
    /// No copyright information found — status unknown.
    Unknown,
}

impl CopyrightStatus {
    /// Returns `true` if redistribution is likely safe (CC) or unknown.
    pub fn is_likely_safe(&self) -> bool {
        matches!(self, CopyrightStatus::CreativeCommons { .. } | CopyrightStatus::Unknown)
    }

    /// One-line summary for display.
    pub fn summary(&self) -> String {
        match self {
            CopyrightStatus::CreativeCommons { license_name } =>
                format!("✓ Creative Commons ({license_name}) — reuse allowed with attribution"),
            CopyrightStatus::Standard { reason } =>
                format!("⚠ Standard YouTube license — {reason}"),
            CopyrightStatus::SuspectedProtected { indicators } =>
                format!("⚠ Copyright indicators found: {}", indicators.join(", ")),
            CopyrightStatus::Unknown =>
                "ℹ Copyright status unknown — check manually before redistribution".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestResult {
    pub video_path: PathBuf,
    pub audio_path: PathBuf,
    pub title: String,
    pub duration_secs: f64,
    pub video_id: String,
    /// Channel/uploader name — added v0.2; defaults to empty string on old state files.
    #[serde(default)]
    pub channel: String,
    /// Path to the downloaded YouTube subtitle file (.json3 or .vtt), if available.
    /// The transcription stage uses this for word-level timestamps before falling back to Whisper.
    #[serde(default)]
    pub subtitle_path: Option<PathBuf>,
    /// Copyright status — added v0.2; defaults to Unknown on old state files.
    #[serde(default = "default_copyright")]
    pub copyright_status: CopyrightStatus,
    pub completed_at: DateTime<Utc>,
}

fn default_copyright() -> CopyrightStatus {
    CopyrightStatus::Unknown
}

impl Default for CopyrightStatus {
    fn default() -> Self {
        CopyrightStatus::Unknown
    }
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

        // Download subtitles in the SAME yt-dlp call as the video.
        //
        // IMPORTANT: Do NOT use wildcard patterns like "id.*" or "en.*".
        // Per yt-dlp issue #13831, YouTube specifically rate-limits (HTTP 429)
        // requests for auto-TRANSLATED subtitle variants (the ones matched by ".*").
        // Only request the base language codes + "-orig" variant (original auto-captions).
        let sub_langs_owned = if self.config.whisper.language.is_empty()
            || self.config.whisper.language == "auto"
        {
            // id-orig = original spoken language auto-caption (no 429)
            // id      = base Indonesian auto-caption
            // en,en-US = English (manual or original auto-caption)
            "id-orig,id,en,en-US".to_owned()
        } else {
            let lang = &self.config.whisper.language;
            format!("{lang}-orig,{lang},en,en-US")
        };

        let mut yt_args = vec![
            "--no-playlist",
            "--write-info-json",
            "--retries",
            "5",
            "--fragment-retries",
            "5",
            "--format",
            &self.config.ingest.format,
            "--merge-output-format",
            "mp4",
            // Subtitles — downloaded alongside the video in one session (avoids 429).
            // --ignore-errors prevents subtitle 429 from aborting the whole download.
            "--write-auto-subs",
            "--write-subs",
            "--sub-format",
            "json3/vtt/best",
            "--sub-langs",
            &sub_langs_owned,
            "--ignore-errors",     // subtitle 429 / not available → warn, never abort video
            "--sleep-requests",    // pause between requests to reduce 429 risk
            "2",
            "--output",
            &out_template,
            "--newline",
            "--js-runtimes",
            "deno",
        ];

        // Only pass --ffmpeg-location if we actually found a binary
        if !ffmpeg_dir.is_empty() {
            yt_args.push("--ffmpeg-location");
            yt_args.push(&ffmpeg_dir);
        }
        yt_args.push(url);

        cmd.args(&yt_args)
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

            // Check whether the failure was ONLY a subtitle error (e.g., 429).
            // If the video file exists on disk, subtitle errors are non-fatal —
            // the transcription stage will fall back to Whisper automatically.
            let is_subtitle_only_error = stderr_buf.contains("subtitle")
                && (stderr_buf.contains("429") || stderr_buf.contains("Too Many Requests")
                    || stderr_buf.contains("not available"));

            if is_subtitle_only_error {
                // Log clearly so the user knows subtitles were skipped
                warn!(
                    "yt-dlp: subtitle download failed (HTTP 429 / not available) — \
                     Whisper will be used for transcription instead.\n{}",
                    stderr_buf.trim()
                );
                // Continue — video may still be on disk; find_or_merge_video() will confirm
            } else {
                // Real failure: video itself could not be downloaded
                warn!("yt-dlp stderr:\n{stderr_buf}");
                return Err(IngestError::YtDlpFailed { code, stderr: stderr_buf });
            }
        }

        // Find final merged video — or merge video+audio ourselves if yt-dlp
        // downloaded them separately (happens when yt-dlp can't find FFmpeg)
        let video_path = self
            .find_or_merge_video()
            .await?
            .ok_or_else(|| IngestError::OutputMissing(self.job.source_dir()))?;

        // Subtitles are now downloaded inline with the video (--write-auto-subs
        // in the main yt-dlp call above) to avoid HTTP 429 rate-limiting.
        // `find_subtitle_file()` below will pick them up if they were written.

        let result = self.build_result(video_path).await?;

        let size_mb = std::fs::metadata(&result.video_path)
            .map(|m| m.len() as f64 / 1_048_576.0)
            .unwrap_or(0.0);

        info!(
            "download complete — \"{}\" by {} ({:.0}s, {:.1} MB)",
            result.title, result.channel, result.duration_secs, size_mb
        );

        // ── Copyright status display ──────────────────────────────────────────
        let cr = result.copyright_status.summary();
        match &result.copyright_status {
            CopyrightStatus::CreativeCommons { .. } => info!("  Copyright  : {cr}"),
            CopyrightStatus::Unknown              => info!("  Copyright  : {cr}"),
            // Warnings are shown to stderr so they stand out visually
            _ => {
                // Short summary line (fits the box width)
                let short = match &result.copyright_status {
                    CopyrightStatus::Standard { .. } =>
                        "Standard YouTube License (all rights reserved)".to_owned(),
                    CopyrightStatus::SuspectedProtected { indicators } =>
                        format!("Copyright indicators: {}", indicators.join(", ")),
                    _ => cr.clone(),
                };
                eprintln!("\n  ╔══════════════════════════════════════════════════╗");
                eprintln!("  ║  ⚠  COPYRIGHT WARNING                            ║");
                eprintln!("  ╠══════════════════════════════════════════════════╣");
                eprintln!("  ║  {:<48}  ║", short.chars().take(48).collect::<String>());
                if short.len() > 48 {
                    // Second line for long messages
                    eprintln!("  ║  {:<48}  ║",
                        short.chars().skip(48).take(48).collect::<String>());
                }
                eprintln!("  ╠══════════════════════════════════════════════════╣");
                eprintln!("  ║  Personal review / commentary  →  generally OK  ║");
                eprintln!("  ║  Redistribution / reposting    →  check license  ║");
                eprintln!("  ║  Pipeline will continue — proceed at your risk.  ║");
                eprintln!("  ╚══════════════════════════════════════════════════╝\n");
            }
        }

        stage_done("Ingest", t0.elapsed());

        Ok(result)
    }

    /// Attempt to download YouTube auto-captions/subtitles as a best-effort operation.
    ///
    /// Runs yt-dlp with `--skip-download --write-auto-subs --write-subs`.
    /// Any failure (429, no subtitles available, network error) is silently ignored —
    /// the transcription stage will fall back to Whisper if no subtitle file is found.
    ///
    /// NOTE: A 2-second delay is added before the first attempt because YouTube often
    /// returns HTTP 429 (Too Many Requests) if the subtitle fetch follows the video
    /// download too quickly. The call is retried once after 5s on failure.
    async fn download_subtitles_optional(&self, url: &str, ffmpeg_dir: &str) {
        let out_template = self
            .job
            .source_dir()
            .join("%(id)s.%(ext)s")
            .to_string_lossy()
            .to_string();

        // Include language-specific variants (e.g. "id-orig") alongside base codes
        let sub_langs = if self.config.whisper.language.is_empty()
            || self.config.whisper.language == "auto"
        {
            "id-orig,id,en,en-US".to_owned()
        } else {
            let lang = &self.config.whisper.language;
            format!("{lang}-orig,{lang},en,en-US")
        };

        let ytdlp = &self.config.ingest.ytdlp_path;
        let pb = crate::util::progress::spinner("Checking YouTube subtitles…");

        let mut args = vec![
            "--no-playlist".to_owned(),
            "--skip-download".to_owned(),      // don't re-download the video
            "--write-auto-subs".to_owned(),
            "--write-subs".to_owned(),
            "--sub-format".to_owned(), "json3/vtt/best".to_owned(),
            "--sub-langs".to_owned(), sub_langs,
            "--ignore-errors".to_owned(),      // never abort on subtitle errors
            // Retry flags — YouTube returns 429 when requests come too fast
            "--retries".to_owned(), "3".to_owned(),
            "--sleep-requests".to_owned(), "1".to_owned(),
            "--no-warnings".to_owned(),
            // deno JS runtime for full YouTube support
            "--js-runtimes".to_owned(), "deno".to_owned(),
            "--output".to_owned(), out_template,
        ];
        if !ffmpeg_dir.is_empty() {
            args.push("--ffmpeg-location".to_owned());
            args.push(ffmpeg_dir.to_owned());
        }
        args.push(url.to_owned());

        // Short delay before first attempt — reduces 429 after video download
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        let result = tokio::process::Command::new(ytdlp)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .await;

        pb.finish_and_clear();

        match &result {
            Err(e) => { debug!("YouTube subtitle yt-dlp spawn error: {e}"); }
            Ok(out) if !out.status.success() => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                if stderr.contains("429") || stderr.contains("Too Many Requests") {
                    debug!("YouTube subtitle 429 rate-limit — will retry after 5s");
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    // Single retry
                    let _ = tokio::process::Command::new(ytdlp)
                        .args(&args)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .await;
                } else if !stderr.trim().is_empty() {
                    debug!("YouTube subtitle yt-dlp: {}", stderr.trim());
                }
            }
            _ => {}
        }

        // Check whether an actual subtitle file landed in the source directory
        match self.find_subtitle_file().await {
            Some(ref p) => {
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("?");
                info!(
                    "YouTube subtitle available: {} ({} format) — will use instead of Whisper",
                    p.file_name().unwrap_or_default().to_string_lossy(), ext
                );
            }
            None => {
                info!("YouTube subtitle: not available for this video — Whisper will be used");
            }
        }
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
        let meta = self.load_info_json(&video_path).await;
        let audio_path = video_path.with_extension("wav");
        let subtitle_path = self.find_subtitle_file().await;
        if let Some(ref p) = subtitle_path {
            info!("YouTube subtitle found: {}", p.display());
        }
        Ok(IngestResult {
            video_path,
            audio_path,
            title: meta.title,
            duration_secs: meta.duration_secs,
            video_id: meta.video_id,
            channel: meta.channel,
            subtitle_path,
            copyright_status: meta.copyright_status,
            completed_at: Utc::now(),
        })
    }

    /// Scan the source directory for a yt-dlp downloaded subtitle file.
    /// Prefers `.json3` (word-level timestamps) over `.vtt` (segment-level).
    async fn find_subtitle_file(&self) -> Option<PathBuf> {
        let dir = self.job.source_dir();
        if !dir.exists() { return None; }

        let mut json3: Option<PathBuf> = None;
        let mut vtt:   Option<PathBuf> = None;

        let mut entries = tokio::fs::read_dir(&dir).await.ok()?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let p = entry.path();
            match p.extension().and_then(|e| e.to_str()) {
                Some("json3") => { json3 = Some(p); }
                Some("vtt")   => { vtt   = Some(p); }
                _ => {}
            }
        }
        // json3 has word-level timestamps → prefer it
        json3.or(vtt)
    }

    async fn load_info_json(&self, video_path: &Path) -> VideoMeta {
        // yt-dlp writes the info JSON next to the video file
        let info_path = video_path.with_extension("info.json");
        let raw = match tokio::fs::read_to_string(&info_path).await {
            Ok(s) => s,
            Err(_) => {
                let stem = video_path.file_stem()
                    .and_then(|s| s.to_str()).unwrap_or("unknown").to_owned();
                return VideoMeta { title: stem.clone(), duration_secs: 0.0,
                    video_id: stem, channel: String::new(),
                    copyright_status: CopyrightStatus::Unknown };
            }
        };

        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(j) => j,
            Err(_) => return VideoMeta::unknown(video_path),
        };

        let title    = v["title"].as_str().unwrap_or("Unknown").to_owned();
        let duration = v["duration"].as_f64().unwrap_or(0.0);
        let id       = v["id"].as_str().unwrap_or("unknown").to_owned();
        let channel  = v["uploader"].as_str()
            .or_else(|| v["channel"].as_str())
            .unwrap_or("Unknown")
            .to_owned();
        let description = v["description"].as_str().unwrap_or("");
        let license_raw = v["license"].as_str().unwrap_or("");

        let copyright_status = detect_copyright(license_raw, &title, description);

        VideoMeta { title, duration_secs: duration, video_id: id, channel, copyright_status }
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/// Structured metadata parsed from the yt-dlp `.info.json` file.
struct VideoMeta {
    title: String,
    duration_secs: f64,
    video_id: String,
    channel: String,
    copyright_status: CopyrightStatus,
}

impl VideoMeta {
    fn unknown(video_path: &Path) -> Self {
        let stem = video_path.file_stem()
            .and_then(|s| s.to_str()).unwrap_or("unknown").to_owned();
        Self { title: stem.clone(), duration_secs: 0.0, video_id: stem,
               channel: String::new(), copyright_status: CopyrightStatus::Unknown }
    }
}

/// Detect copyright status from yt-dlp info.json fields.
///
/// Detection strategy (in priority order):
/// 1. `license` field
///    - "creativeCommon" / "cc" → Creative Commons (safe to reuse with attribution)
///    - "youtube" or EMPTY     → Standard YouTube License (all rights reserved)
///      NOTE: yt-dlp leaves this field EMPTY for the Standard YouTube License,
///      which is the default for virtually all YouTube videos.
/// 2. Description / title scan for explicit copyright strings (©, ℗, "All Rights Reserved"…)
///    These indicate music labels, studios, or strict creators → stronger warning.
fn detect_copyright(license_raw: &str, title: &str, description: &str) -> CopyrightStatus {
    // ── 1. Check the `license` field ─────────────────────────────────────────
    let license_lower = license_raw.to_lowercase();

    if license_lower.contains("creative") || license_lower.contains("cc-by")
        || license_lower.starts_with("cc ")
    {
        let name = if license_raw.is_empty() { "Creative Commons".to_owned() }
                   else { license_raw.to_owned() };
        return CopyrightStatus::CreativeCommons { license_name: name };
    }

    // ── 2. Scan description/title for explicit copyright strings ─────────────
    let mut indicators = scan_copyright_text(description);
    indicators.extend(scan_copyright_text(title));
    indicators.dedup();

    if !indicators.is_empty() {
        return CopyrightStatus::SuspectedProtected { indicators };
    }

    // ── 3. Standard YouTube License (explicit field OR empty = default) ───────
    // When yt-dlp finds "youtube" or leaves the field empty, the video uses the
    // Standard YouTube License — all rights reserved by the creator.
    // This is the most common case on YouTube.
    if license_lower == "youtube" || license_lower.contains("standard") || license_raw.is_empty() {
        return CopyrightStatus::Standard {
            reason: "Standard YouTube license (all rights reserved). \
                     Personal review / commentary is generally OK; redistribution may infringe."
                .to_owned(),
        };
    }

    // Unknown license value — be cautious
    CopyrightStatus::Unknown
}

/// Scan a text string for common copyright indicator patterns.
fn scan_copyright_text(text: &str) -> Vec<String> {
    let text_lower = text.to_lowercase();
    let mut found = Vec::new();

    // Explicit copyright symbols
    if text.contains('©') || text.contains('℗') {
        found.push("copyright symbol (©/℗)".to_owned());
    }
    // Common English phrases
    let phrases = [
        ("all rights reserved", "All Rights Reserved"),
        ("no reuse",             "No Reuse"),
        ("licensed to youtube",  "Licensed to YouTube"),
        ("provided to youtube",  "Provided to YouTube"),
        ("music distributed",    "Music Distributed by"),
        ("do not re-upload",     "Do Not Re-upload"),
        ("do not repost",        "Do Not Repost"),
        ("unauthorized use",     "Unauthorized Use Prohibited"),
        ("exclusive rights",     "Exclusive Rights"),
        ("℗ ",                   "Sound Recording Copyright (℗)"),
        ("#copyright",           "#copyright"),
    ];
    for (needle, label) in &phrases {
        if text_lower.contains(needle) {
            found.push((*label).to_owned());
        }
    }
    // Indonesian phrases
    let id_phrases = [
        ("hak cipta",            "Hak Cipta"),
        ("dilindungi hak",       "Dilindungi Hak Cipta"),
        ("dilarang menggunakan", "Dilarang Menggunakan Ulang"),
        ("dilarang re-upload",   "Dilarang Re-upload"),
    ];
    for (needle, label) in &id_phrases {
        if text_lower.contains(needle) {
            found.push((*label).to_owned());
        }
    }

    found.dedup();
    found
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
