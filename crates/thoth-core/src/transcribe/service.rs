use std::path::{Path, PathBuf};
use std::time::Instant;
use std::io::Write;

use anyhow::Result;
use chrono::{DateTime, Utc};
use ffmpeg_sidecar::command::FfmpegCommand;
use serde::{Deserialize, Serialize};
use tracing::{debug, info};
use futures_util::stream::{self, StreamExt};

use crate::config::AppConfig;
use crate::execution::{run_cooperative_item, JobExecutionContext};
use crate::pipeline::job::JobContext;
use crate::util::progress::{spinner, stage_done};

// ── Groq upload limits ────────────────────────────────────────────────────────
/// Groq's hard limit is 25 MB; we use 24 MB as a safety margin.
const GROQ_MAX_BYTES: u64 = 24 * 1024 * 1024;
/// MP3 bitrate used for compression. At 48 kbps, 52 min ≈ 18 MB (safely under limit).
const MP3_BITRATE: &str = "48k";
/// Duration per chunk when audio exceeds the limit even after compression (e.g. >66 min videos).
const CHUNK_DURATION_SECS: f64 = 20.0 * 60.0; // 20 minutes → ~3.4 MB per chunk at 48 kbps

use super::error::TranscribeError;
use super::model::{merge_subword_tokens, Transcript, WhisperSegment, WordTimestamp};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeResult {
    pub transcript_path: PathBuf,
    pub word_count: usize,
    pub duration_secs: f64,
    pub model_used: String,
    pub completed_at: DateTime<Utc>,
}

pub struct TranscribeService<'a> {
    config: &'a AppConfig,
    job: &'a JobContext,
    execution: &'a JobExecutionContext,
}

impl<'a> TranscribeService<'a> {
    pub fn new(
        config: &'a AppConfig,
        job: &'a JobContext,
        execution: &'a JobExecutionContext,
    ) -> Self {
        Self { config, job, execution }
    }

    pub async fn run(
        &self,
        video_path: &Path,
        model_size: &str,
    ) -> Result<TranscribeResult> {
        self.execution.check_cancelled()?;
        let t0 = Instant::now();

        // ── Step 1: Try YouTube transcript first (instant, no API cost) ──────
        //
        // yt-dlp downloads subtitle files during ingest if available.
        // json3 has word-level timestamps; vtt has at least segment-level.
        // We prefer this over Whisper when available.
        let t_infer = Instant::now();
        let (transcript, model_used) = if let Some(yt) = self.try_youtube_transcript().await {
            self.execution.check_cancelled()?;
            let infer_secs = t_infer.elapsed().as_secs_f64();
            info!(
                "YouTube transcript loaded in {:.1}s — {} segments",
                infer_secs,
                yt.segments.len()
            );
            (yt, "youtube".to_owned())
        } else {
            // ── Step 2: Extract audio + run Whisper ─────────────────────────
            let wav_path = self.job.source_dir().join("audio.wav");
            self.extract_audio(video_path, &wav_path).await?;
            self.execution.check_cancelled()?;

            let wav_mb = std::fs::metadata(&wav_path)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            info!("audio extracted: {wav_mb:.1} MB ({wav_path:?})");

            let transcript = self.transcribe(&wav_path, model_size).await?;
            self.execution.check_cancelled()?;
            (transcript, model_size.to_owned())
        };
        let infer_secs = t_infer.elapsed().as_secs_f64();

        // Step 3: Save transcript JSON
        let transcript_path = self.job.transcript_path();
        self.execution.check_cancelled()?;
        let json = serde_json::to_string_pretty(&transcript).map_err(|e| {
            TranscribeError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        })?;
        tokio::fs::write(&transcript_path, json)
            .await
            .map_err(TranscribeError::Io)?;

        let word_count: usize = transcript.segments.iter().map(|s| s.words.len()).sum();
        let video_mins = transcript.duration_ms as f64 / 60_000.0;

        info!(
            "transcription complete — {} segments, {} words, {:.1} min of audio, inference {:.1}s",
            transcript.segments.len(),
            word_count,
            video_mins,
            infer_secs
        );
        stage_done("Transcribe", t0.elapsed());

        Ok(TranscribeResult {
            transcript_path,
            word_count,
            duration_secs: transcript.duration_ms as f64 / 1000.0,
            model_used,
            completed_at: Utc::now(),
        })
    }

    async fn transcribe(
        &self,
        wav_path: &Path,
        #[cfg_attr(not(feature = "local-whisper"), allow(unused_variables))]
        model_size: &str,
    ) -> Result<Transcript> {
        #[cfg(feature = "local-whisper")]
        {
            let model_path = self.config.whisper_model_path(Some(model_size));
            if !model_path.exists() {
                self.download_whisper_model(model_size).await?;
            }

            info!("using local whisper [{model_size}] (CUDA-accelerated)");
            Ok(local::run_local_whisper(
                wav_path,
                &model_path,
                self.config.whisper.n_threads,
                &self.config.whisper.language,
            )
            .await?)
        }

        #[cfg(not(feature = "local-whisper"))]
        {
            // Default: Groq Whisper API
            info!("using Groq Whisper API for transcription");
            self.transcribe_via_groq(wav_path).await
        }
    }

    async fn download_whisper_model(&self, model_size: &str) -> Result<(), TranscribeError> {
        let model_dir = &self.config.whisper.model_dir;
        if !model_dir.exists() {
            std::fs::create_dir_all(model_dir).map_err(TranscribeError::Io)?;
        }

        let model_path = self.config.whisper_model_path(Some(model_size));
        let filename = model_path
            .file_name()
            .ok_or_else(|| {
                TranscribeError::InitFailed("Invalid model path: no filename".to_owned())
            })?
            .to_string_lossy();

        // HuggingFace URL
        let url = format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
            filename
        );

        info!("Downloading Whisper model [{model_size}] from HuggingFace...");

        let client = reqwest::Client::new();
        let res = client
            .get(&url)
            .send()
            .await
            .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?;

        if !res.status().is_success() {
            return Err(TranscribeError::InferenceFailed(format!(
                "Failed to download model: HTTP {}",
                res.status()
            )));
        }

        let total_size = res.content_length().ok_or_else(|| {
            TranscribeError::InferenceFailed("Failed to get content length".to_owned())
        })?;

        let pb = indicatif::ProgressBar::new(total_size);
        pb.set_style(
            indicatif::ProgressStyle::default_bar()
                .template(
                    "{msg}\n{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({eta})",
                )
                .map_err(|e| TranscribeError::InitFailed(e.to_string()))?
                .progress_chars("#>-"),
        );
        pb.set_message(format!("Downloading {}", filename));

        let mut file = std::fs::File::create(&model_path).map_err(TranscribeError::Io)?;
        let mut downloaded: u64 = 0;
        let mut stream = res.bytes_stream();

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?;
            file.write_all(&chunk).map_err(TranscribeError::Io)?;
            let new = std::cmp::min(downloaded + (chunk.len() as u64), total_size);
            downloaded = new;
            pb.set_position(new);
        }

        pb.finish_with_message(format!("Downloaded {}", filename));
        Ok(())
    }

    async fn transcribe_via_groq(&self, wav_path: &Path) -> Result<Transcript> {
        if self.config.llm.groq_api_key.is_empty() {
            return Err(TranscribeError::InitFailed(
                "THOTH_GROQ_API_KEY is not set.\n\
                 Set it via: $env:THOTH_GROQ_API_KEY = \"gsk_...\"\n\
                 Or add to your .env file."
                    .to_owned(),
            ).into());
        }

        // ── Step 1: Compress WAV → MP3 ───────────────────────────────────────
        // WAV at 16kHz PCM is ~1.9 MB/min. MP3 at 48kbps is ~0.35 MB/min.
        // For a 52-min video: 96 MB WAV → ~18 MB MP3 (safely under Groq's 25 MB limit).
        let mp3_path = wav_path.with_extension("mp3");
        self.compress_wav_to_mp3(wav_path, &mp3_path).await?;

        let mp3_bytes = std::fs::metadata(&mp3_path).map(|m| m.len()).unwrap_or(0);
        let mp3_mb   = mp3_bytes as f64 / 1_048_576.0;

        if mp3_bytes <= GROQ_MAX_BYTES {
            // ── Single request ────────────────────────────────────────────────
            info!("uploading compressed audio: {mp3_mb:.1} MB (Groq limit: 24 MB)");
            let pb = spinner(&format!("Transcribing via Groq Whisper — {mp3_mb:.1} MB…"));
            let transcript = self.groq_upload(&mp3_path, 0.0).await?;
            pb.finish_and_clear();
            Ok(transcript)
        } else {
            // ── Chunked request ───────────────────────────────────────────────
            let duration_secs = wav_duration_secs(wav_path);
            let n_chunks = (duration_secs / CHUNK_DURATION_SECS).ceil() as usize;
            info!(
                "audio {mp3_mb:.1} MB > {:.0} MB limit — splitting into {n_chunks} chunks of {:.0} min each",
                GROQ_MAX_BYTES as f64 / 1_048_576.0,
                CHUNK_DURATION_SECS / 60.0,
            );
            self.groq_transcribe_chunked(&mp3_path, duration_secs).await
        }
    }

    /// Compress a 16 kHz mono WAV to MP3 at 48 kbps (idempotent — skips if MP3 already exists).
    async fn compress_wav_to_mp3(
        &self,
        wav_path: &Path,
        mp3_path: &Path,
    ) -> Result<(), TranscribeError> {
        if mp3_path.exists() {
            debug!("reusing cached MP3: {}", mp3_path.display());
            return Ok(());
        }

        let wav_mb = std::fs::metadata(wav_path)
            .map(|m| m.len() as f64 / 1_048_576.0)
            .unwrap_or(0.0);
        let pb = spinner(&format!(
            "Compressing audio: {wav_mb:.1} MB WAV → MP3 @ {}…",
            MP3_BITRATE
        ));

        let status = crate::util::ffmpeg::command()
            .args([
                "-y",
                "-i",
                &wav_path.to_string_lossy(),
                "-ac", "1",
                "-ar", "16000",
                "-b:a", MP3_BITRATE,
                &mp3_path.to_string_lossy(),
            ])
            .spawn()
            .map_err(|e| TranscribeError::AudioExtraction(e.to_string()))?
            .wait()
            .map_err(|e| TranscribeError::AudioExtraction(e.to_string()))?;

        pb.finish_and_clear();

        if !status.success() {
            return Err(TranscribeError::AudioExtraction(
                "FFmpeg failed to compress WAV to MP3".to_owned(),
            ));
        }

        let mp3_mb = std::fs::metadata(mp3_path)
            .map(|m| m.len() as f64 / 1_048_576.0)
            .unwrap_or(0.0);
        info!(
            "compressed: {wav_mb:.1} MB WAV → {mp3_mb:.1} MB MP3 ({:.0}% reduction)",
            (1.0 - mp3_mb / wav_mb) * 100.0
        );
        Ok(())
    }

    /// Split MP3 into fixed-length chunks, transcribe each, merge with timestamp offsets.
    ///
    /// Konkuren berbatas: fase 1 — extract semua chunk secara serial (FFmpeg stream-copy,
    /// sangat cepat ~1s/chunk); fase 2 — upload ke Groq secara konkuren `buffer_unordered(3)`
    /// (cap Groq rate-limit); fase 3 — sort by chunk_idx → dedup overlap → merge.
    async fn groq_transcribe_chunked(
        &self,
        mp3_path: &Path,
        total_duration_secs: f64,
    ) -> Result<Transcript> {
        let n_chunks = (total_duration_secs / CHUNK_DURATION_SECS).ceil() as usize;
        let chunk_dir = mp3_path.parent().unwrap_or(std::path::Path::new("."));

        // ── Fase 1: Extract semua chunk secara serial (stream-copy, cepat) ───────
        struct ChunkMeta { idx: usize, path: std::path::PathBuf, start: f64, end: f64, mb: f64 }
        let mut chunk_metas: Vec<ChunkMeta> = Vec::with_capacity(n_chunks);

        for chunk_idx in 0..n_chunks {
            let chunk_start = chunk_idx as f64 * CHUNK_DURATION_SECS;
            let chunk_end   = (chunk_start + CHUNK_DURATION_SECS).min(total_duration_secs);
            let chunk_dur   = chunk_end - chunk_start;

            info!(
                "chunk {}/{}: extract {:.0}s–{:.0}s ({:.1} min)",
                chunk_idx + 1, n_chunks, chunk_start, chunk_end, chunk_dur / 60.0
            );

            let chunk_path = chunk_dir.join(format!("chunk_{chunk_idx:03}.mp3"));
            let status = run_cooperative_item(self.execution, || async {
                let status = crate::util::ffmpeg::command()
                    .args([
                        "-y",
                        "-ss", &format!("{chunk_start:.3}"),
                        "-t",  &format!("{chunk_dur:.3}"),
                        "-i",  &mp3_path.to_string_lossy(),
                        "-c",  "copy",
                        &chunk_path.to_string_lossy(),
                    ])
                    .spawn()
                    .map_err(|e| TranscribeError::AudioExtraction(e.to_string()))?
                    .wait()
                    .map_err(|e| TranscribeError::AudioExtraction(e.to_string()))?;
                Ok(status)
            }).await?;

            if !status.success() || !chunk_path.exists() {
                break; // Past end of file — done
            }

            let mb = std::fs::metadata(&chunk_path)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            chunk_metas.push(ChunkMeta { idx: chunk_idx, path: chunk_path, start: chunk_start, end: chunk_end, mb });
        }

        // ── Fase 2: Upload ke Groq secara konkuren (cap 3 — hormati rate-limit) ──
        let total = chunk_metas.len();
        let this = self; // capture shared ref untuk async move closures
        let mut indexed_results: Vec<(usize, Transcript)> =
            stream::iter(chunk_metas)
                .map(|meta| async move {
                    run_cooperative_item(this.execution, || async {
                        let pb = spinner(&format!(
                            "[{}/{}] Uploading chunk {:.0}s–{:.0}s ({:.1} MB)…",
                            meta.idx + 1, total, meta.start, meta.end, meta.mb
                        ));
                        let transcript = this.groq_upload(&meta.path, meta.start).await?;
                        this.execution.check_cancelled()?;
                        pb.finish_and_clear();
                        // Bersihkan chunk setelah upload selesai
                        let _ = tokio::fs::remove_file(&meta.path).await;
                        Ok((meta.idx, transcript))
                    }).await
                })
                .buffer_unordered(3)
                .collect::<Vec<_>>()
                .await
                .into_iter()
                .collect::<Result<Vec<_>>>()?;

        // ── Fase 3: Sort by idx → dedup overlap → flatten ────────────────────────
        indexed_results.sort_by_key(|(idx, _)| *idx);
        let mut all_segments: Vec<WhisperSegment> = Vec::new();
        for (_, mut chunk_transcript) in indexed_results {
            self.execution.check_cancelled()?;
            // Deduplicate: drop segments that overlap with the previous chunk's last segment
            if let Some(prev_last) = all_segments.last() {
                let min_start = prev_last.end_ms;
                chunk_transcript.segments.retain(|s| s.start_ms >= min_start);
            }
            all_segments.extend(chunk_transcript.segments);
        }

        let duration_ms = (total_duration_secs * 1000.0) as i64;
        Ok(Transcript { segments: all_segments, duration_ms })
    }

    /// Upload one audio file to Groq Whisper API and return a Transcript.
    /// All timestamps are shifted by `offset_secs` (for chunked transcription).
    async fn groq_upload(
        &self,
        audio_path: &Path,
        offset_secs: f64,
    ) -> Result<Transcript, TranscribeError> {
        let file_bytes = tokio::fs::read(audio_path).await.map_err(TranscribeError::Io)?;
        let filename   = audio_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Detect MIME type from extension
        let mime = if filename.ends_with(".mp3") { "audio/mpeg" } else { "audio/wav" };

        let file_part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(filename)
            .mime_str(mime)
            .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?;

        let mut form = reqwest::multipart::Form::new()
            .part("file", file_part)
            .text("model", "whisper-large-v3")
            .text("response_format", "verbose_json")
            .text("timestamp_granularities[]", "word")
            .text("timestamp_granularities[]", "segment");

        if !self.config.whisper.language.is_empty()
            && self.config.whisper.language != "auto"
        {
            form = form.text("language", self.config.whisper.language.clone());
        }

        let client = reqwest::Client::new();
        let resp = client
            .post("https://api.groq.com/openai/v1/audio/transcriptions")
            .bearer_auth(&self.config.llm.groq_api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(TranscribeError::InferenceFailed(format!(
                "Groq API HTTP {status}: {text}"
            )));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?;

        let mut transcript = parse_groq_response(&json)?;

        // Apply chunk time offset to all timestamps
        if offset_secs > 0.0 {
            let offset_ms = (offset_secs * 1000.0) as i64;
            for seg in &mut transcript.segments {
                seg.start_ms += offset_ms;
                seg.end_ms   += offset_ms;
                for w in &mut seg.words {
                    w.start_ms += offset_ms;
                    w.end_ms   += offset_ms;
                }
            }
        }

        Ok(transcript)
    }

    // ── YouTube transcript ────────────────────────────────────────────────────

    /// Look for a yt-dlp downloaded subtitle file in the source directory and
    /// parse it into our `Transcript` format.
    ///
    /// Search order: `.json3` (word-level timestamps) → `.vtt` (segment-level).
    /// Returns `None` if no subtitle file exists or parsing fails.
    async fn try_youtube_transcript(&self) -> Option<Transcript> {
        let dir = self.job.source_dir();
        if !dir.exists() { return None; }

        let mut json3: Option<std::path::PathBuf> = None;
        let mut vtt:   Option<std::path::PathBuf> = None;

        let mut entries = tokio::fs::read_dir(&dir).await.ok()?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let p = entry.path();
            match p.extension().and_then(|e| e.to_str()) {
                Some("json3") => { json3 = Some(p); }
                Some("vtt")   => { if vtt.is_none() { vtt = Some(p); } }
                _ => {}
            }
        }

        let subtitle_path = match json3.or(vtt) {
            Some(p) => p,
            None => {
                // No subtitle file in source dir — Whisper will be used
                debug!("no YouTube subtitle file found in source dir");
                return None;
            }
        };
        let raw = tokio::fs::read_to_string(&subtitle_path).await.ok()?;

        let ext = subtitle_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let transcript = match ext {
            "json3" => parse_youtube_json3(&raw),
            "vtt"   => parse_youtube_vtt(&raw),
            _       => return None,
        };

        match transcript {
            Ok(t) if !t.segments.is_empty() => {
                info!(
                    "YouTube transcript: {} ({} segments, {:.1} min)",
                    subtitle_path.file_name().unwrap_or_default().to_string_lossy(),
                    t.segments.len(),
                    t.duration_ms as f64 / 60_000.0
                );
                Some(t)
            }
            Ok(_) => {
                info!("YouTube transcript file exists but has no segments — falling back to Whisper");
                None
            }
            Err(e) => {
                info!("YouTube transcript parse failed ({e}) — falling back to Whisper");
                None
            }
        }
    }

    async fn extract_audio(
        &self,
        video_path: &Path,
        wav_path: &Path,
    ) -> Result<(), TranscribeError> {
        if wav_path.exists() {
            debug!("reusing cached audio: {}", wav_path.display());
            return Ok(());
        }

        let t0 = Instant::now();
        let pb = spinner("Extracting audio — converting to 16 kHz mono WAV…");

        let status = crate::util::ffmpeg::command()
            .args([
                "-y",
                "-i",
                &video_path.to_string_lossy(),
                "-vn",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "wav",
                &wav_path.to_string_lossy(),
            ])
            .spawn()
            .map_err(|e| TranscribeError::AudioExtraction(e.to_string()))?
            .wait()
            .map_err(|e| TranscribeError::AudioExtraction(e.to_string()))?;

        pb.finish_and_clear();

        if !status.success() {
            return Err(TranscribeError::AudioExtraction(
                "FFmpeg exited with non-zero status".to_owned(),
            ));
        }

        info!("audio extraction done in {:.1}s", t0.elapsed().as_secs_f64());
        Ok(())
    }
}

/// Calculate audio duration from a PCM s16le 16 kHz mono WAV file size.
/// Formula: (file_bytes - 44_byte_header) / (16000 samples/sec × 2 bytes/sample)
// ── YouTube subtitle parsers ──────────────────────────────────────────────────

/// Parse a YouTube JSON3 subtitle file into `Transcript`.
///
/// JSON3 format (from yt-dlp `--sub-format json3`) looks like:
/// ```json
/// { "events": [
///     { "tStartMs": 1000, "dDurationMs": 3000,
///       "segs": [ {"utf8": "Hello ", "tOffsetMs": 0},
///                 {"utf8": "world",  "tOffsetMs": 800} ] },
///     ...
/// ] }
/// ```
/// Each `seg` is a word with a time offset from the event start.
fn parse_youtube_json3(json: &str) -> Result<Transcript, Box<dyn std::error::Error + Send + Sync>> {
    use crate::transcribe::model::{WhisperSegment, WordTimestamp};

    let data: serde_json::Value = serde_json::from_str(json)?;
    let events = data["events"].as_array().ok_or("no events array")?;

    let mut segments: Vec<WhisperSegment> = Vec::new();

    for event in events {
        let t_start_ms = event["tStartMs"].as_i64().unwrap_or(0);
        let d_ms       = event["dDurationMs"].as_i64().unwrap_or(0);
        let t_end_ms   = t_start_ms + d_ms;

        let segs = match event["segs"].as_array() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };

        // Collect full segment text
        let text: String = segs.iter()
            .filter_map(|s| s["utf8"].as_str())
            .collect();
        let text = text.trim().to_owned();
        if text.is_empty() { continue; }

        // Build per-word timestamps
        let mut words: Vec<WordTimestamp> = Vec::new();
        for (i, seg) in segs.iter().enumerate() {
            let word = seg["utf8"].as_str().unwrap_or("").trim().to_owned();
            if word.is_empty() || word == "\n" { continue; }

            let offset_ms  = seg["tOffsetMs"].as_i64().unwrap_or(0);
            let word_start = t_start_ms + offset_ms;

            // End = next seg's start offset, or event end if last
            let word_end = if i + 1 < segs.len() {
                let next_off = segs[i + 1]["tOffsetMs"].as_i64().unwrap_or(d_ms);
                t_start_ms + next_off
            } else {
                t_end_ms
            };

            words.push(WordTimestamp {
                word,
                start_ms: word_start,
                end_ms: word_end,
                probability: 1.0,
            });
        }

        segments.push(WhisperSegment { text, start_ms: t_start_ms, end_ms: t_end_ms, words });
    }

    // Apply BPE merge (YouTube also sometimes splits words at token boundaries)
    let mut transcript = Transcript { segments, duration_ms: 0 };
    transcript.fix_subwords();
    transcript.duration_ms = transcript.segments.last().map(|s| s.end_ms).unwrap_or(0);
    Ok(transcript)
}

/// Parse a WebVTT subtitle file into `Transcript`.
///
/// VTT may or may not have word-level `<c>` timing tags.
/// If word tags are present we extract per-word timestamps; otherwise we
/// treat the whole cue as a single segment with no word-level data.
fn parse_youtube_vtt(vtt: &str) -> Result<Transcript, Box<dyn std::error::Error + Send + Sync>> {
    use crate::transcribe::model::{WhisperSegment, WordTimestamp};

    let mut segments: Vec<WhisperSegment> = Vec::new();

    // Split into cues (separated by blank lines after the header)
    let mut iter = vtt.lines().peekable();
    // Skip WEBVTT header
    while let Some(line) = iter.next() {
        if line.starts_with("WEBVTT") { break; }
    }

    let mut cue_buf: Vec<String> = Vec::new();

    let flush_cue = |buf: &mut Vec<String>, segs: &mut Vec<WhisperSegment>| {
        if buf.is_empty() { return; }
        // Find timestamp line: "HH:MM:SS.mmm --> HH:MM:SS.mmm"
        let ts_line = buf.iter().find(|l| l.contains("-->"));
        if let Some(ts) = ts_line {
            let parts: Vec<&str> = ts.splitn(2, "-->").collect();
            if parts.len() == 2 {
                let start_ms = parse_vtt_ts(parts[0].trim());
                let end_ms   = parse_vtt_ts(parts[1].trim().split_whitespace().next().unwrap_or(""));
                // Text lines (after the timestamp)
                let text_lines: Vec<&str> = buf.iter()
                    .skip_while(|l| !l.contains("-->"))
                    .skip(1)
                    .map(|l| l.as_str())
                    .collect();
                let raw_text = text_lines.join(" ");
                let text = strip_vtt_tags(&raw_text).trim().to_owned();
                if !text.is_empty() {
                    // Try to extract word-level <c> timing tags
                    let words = extract_vtt_words(&raw_text, start_ms, end_ms);
                    segs.push(WhisperSegment { text, start_ms, end_ms, words });
                }
            }
        }
        buf.clear();
    };

    for line in iter {
        if line.trim().is_empty() {
            flush_cue(&mut cue_buf, &mut segments);
        } else {
            cue_buf.push(line.to_owned());
        }
    }
    flush_cue(&mut cue_buf, &mut segments);

    let mut transcript = Transcript { segments, duration_ms: 0 };
    transcript.fix_subwords();
    transcript.duration_ms = transcript.segments.last().map(|s| s.end_ms).unwrap_or(0);
    Ok(transcript)
}

fn parse_vtt_ts(s: &str) -> i64 {
    // Accepts HH:MM:SS.mmm or MM:SS.mmm
    let parts: Vec<&str> = s.split(':').collect();
    let (h, m, rest) = match parts.as_slice() {
        [h, m, r] => (h.parse::<i64>().unwrap_or(0), m.parse::<i64>().unwrap_or(0), *r),
        [m, r]    => (0, m.parse::<i64>().unwrap_or(0), *r),
        _         => return 0,
    };
    let sec_parts: Vec<&str> = rest.split('.').collect();
    let secs = sec_parts[0].parse::<i64>().unwrap_or(0);
    let ms   = sec_parts.get(1)
        .and_then(|p| p.get(..3))
        .and_then(|p| p.parse::<i64>().ok())
        .unwrap_or(0);
    ((h * 3600 + m * 60 + secs) * 1000) + ms
}

fn strip_vtt_tags(s: &str) -> String {
    // Remove <...> tags: <c>, <00:00:00.000>, </c>, <lang>, etc.
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => { in_tag = true; }
            '>' => { in_tag = false; out.push(' '); }
            c if !in_tag => { out.push(c); }
            _ => {}
        }
    }
    // Collapse extra spaces
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract word-level timestamps from VTT `<c>` timing-tag format:
/// `<00:00:01.000><c> word</c><00:00:01.800><c> next</c>`
fn extract_vtt_words(raw: &str, seg_start: i64, seg_end: i64) -> Vec<crate::transcribe::model::WordTimestamp> {
    use crate::transcribe::model::WordTimestamp;

    let mut words = Vec::new();
    // Split on timing tags (look for <HH:MM:SS.mmm> pattern)
    let re_ts = regex_lite(raw);
    if re_ts.is_empty() {
        // No timing tags — treat the whole line as one segment
        let text = strip_vtt_tags(raw);
        for word in text.split_whitespace() {
            if !word.is_empty() {
                words.push(WordTimestamp {
                    word: word.to_owned(),
                    start_ms: seg_start,
                    end_ms: seg_end,
                    probability: 1.0,
                });
            }
        }
        return words;
    }

    // Walk through alternating (timestamp, text) pairs
    let mut current_ts = seg_start;
    for (ts_ms, text) in re_ts {
        for word in strip_vtt_tags(&text).split_whitespace() {
            if !word.is_empty() {
                words.push(WordTimestamp {
                    word: word.to_owned(),
                    start_ms: current_ts,
                    end_ms: ts_ms,
                    probability: 1.0,
                });
            }
        }
        current_ts = ts_ms;
    }
    words
}

/// Minimal regex-free VTT timing tag extractor.
/// Returns Vec<(timestamp_ms, text_that_follows)>.
fn regex_lite(input: &str) -> Vec<(i64, String)> {
    let mut result: Vec<(i64, String)> = Vec::new();
    let mut remaining = input;

    loop {
        // Find next timing tag <HH:MM:SS.mmm> or <MM:SS.mmm>
        let start = match remaining.find('<') {
            Some(i) => i,
            None => break,
        };
        let end = match remaining[start..].find('>') {
            Some(i) => start + i + 1,
            None => break,
        };
        let tag_content = &remaining[start + 1..end - 1];

        // Check if it looks like a timestamp (contains : and .)
        if tag_content.contains(':') && tag_content.contains('.') {
            let ts_ms = parse_vtt_ts(tag_content);
            // Text between this timestamp and the next <
            let after = &remaining[end..];
            let text_end = after.find('<').unwrap_or(after.len());
            let text = after[..text_end].to_owned();
            result.push((ts_ms, text));
        }
        remaining = &remaining[end..];
    }
    result
}

fn wav_duration_secs(wav_path: &Path) -> f64 {
    let bytes = std::fs::metadata(wav_path)
        .map(|m| m.len())
        .unwrap_or(0) as f64;
    ((bytes - 44.0) / 32_000.0).max(0.0)
}

/// Parse Groq's verbose_json response into our Transcript type.
///
/// Groq Whisper returns BPE **subword tokens** in the `words` array
/// (e.g. "bersama" → ["bers", "ama"], "negara" → ["neg", "ara"]).
/// The segment `text` field, however, contains the correct full words.
/// We use `merge_subword_tokens` to reconstruct proper word-level timestamps.
fn parse_groq_response(json: &serde_json::Value) -> Result<Transcript, TranscribeError> {
    // ── 1. Parse segment boundaries and texts ────────────────────────────────
    let mut segments: Vec<WhisperSegment> = Vec::new();
    if let Some(segs) = json["segments"].as_array() {
        for seg in segs {
            let text    = seg["text"].as_str().unwrap_or("").trim().to_owned();
            let start_ms = (seg["start"].as_f64().unwrap_or(0.0) * 1000.0) as i64;
            let end_ms   = (seg["end"].as_f64().unwrap_or(0.0) * 1000.0) as i64;
            segments.push(WhisperSegment { text, start_ms, end_ms, words: Vec::new() });
        }
    }

    // ── 2. Collect ALL raw BPE tokens in order ────────────────────────────────
    let mut all_tokens: Vec<WordTimestamp> = Vec::new();
    if let Some(words) = json["words"].as_array() {
        for w in words {
            let word     = w["word"].as_str().unwrap_or("").trim().to_owned();
            let start_ms = (w["start"].as_f64().unwrap_or(0.0) * 1000.0) as i64;
            let end_ms   = (w["end"].as_f64().unwrap_or(0.0) * 1000.0) as i64;
            if !word.is_empty() {
                all_tokens.push(WordTimestamp { word, start_ms, end_ms, probability: 1.0 });
            }
        }
    }

    // ── 3. For each segment, assign its tokens then merge subwords ────────────
    let mut tok_cursor = 0usize;
    for seg in &mut segments {
        // Greedily consume tokens that start within this segment's time window.
        // Use a generous +100 ms tolerance for boundary tokens.
        let mut seg_tokens: Vec<WordTimestamp> = Vec::new();
        while tok_cursor < all_tokens.len() {
            let tok = &all_tokens[tok_cursor];
            if tok.start_ms <= seg.end_ms + 100 {
                seg_tokens.push(tok.clone());
                tok_cursor += 1;
            } else {
                break;
            }
        }

        // Merge BPE subword tokens back into whole words using segment text
        seg.words = merge_subword_tokens(&seg.text, &seg_tokens);
    }

    let duration_ms = segments.last().map(|s| s.end_ms).unwrap_or(0);
    Ok(Transcript { segments, duration_ms })
}

/// Merge BPE subword tokens into complete words using the segment text as the
/// authoritative word-boundary guide.
///
// ── Local Whisper backend (feature-gated) ─────────────────────────────────────

#[cfg(feature = "local-whisper")]
mod local {
    use std::path::Path;

    use tracing::info;

    use crate::transcribe::{
        error::TranscribeError,
        model::{Transcript, WhisperSegment, WordTimestamp},
    };

    pub async fn run_local_whisper(
        wav_path: &Path,
        model_path: &Path,
        n_threads: i32,
        language: &str,
    ) -> Result<Transcript, TranscribeError> {
        use super::load_wav_f32;
        use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

        let samples = load_wav_f32(wav_path)?;

        let model_path = model_path.to_owned();
        let language = language.to_owned();

        tokio::task::spawn_blocking(move || {
            info!("initializing whisper context…");
            // whisper-rs 0.16: new_with_params takes AsRef<Path>
            let ctx = WhisperContext::new_with_params(
                model_path.as_path(),
                WhisperContextParameters::default(),
            )
            .map_err(|e| TranscribeError::InitFailed(e.to_string()))?;

            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_n_threads(n_threads);
            params.set_token_timestamps(true);
            params.set_max_len(0);
            if !language.is_empty() && language != "auto" {
                params.set_language(Some(&language));
            }
            params.set_print_realtime(false);
            params.set_print_progress(false);
            params.set_print_timestamps(false);
            params.set_print_special(false);

            let mut state = ctx
                .create_state()
                .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?;

            info!("running inference…");
            state
                .full(params, &samples)
                .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?;

            // whisper-rs 0.16: full_n_segments() returns i32 directly (no Result)
            let n_segs = state.full_n_segments();

            let mut segments = Vec::new();
            let mut total_end_ms: i64 = 0;

            for i in 0..n_segs {
                // whisper-rs 0.16: use get_segment() which returns Option<WhisperSegment>
                let seg = match state.get_segment(i) {
                    Some(s) => s,
                    None => continue,
                };

                let text = seg.to_str_lossy()
                    .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?
                    .trim()
                    .to_owned();
                // timestamps are in centiseconds → convert to ms (* 10)
                let start_ms = seg.start_timestamp() * 10;
                let end_ms   = seg.end_timestamp()   * 10;

                total_end_ms = total_end_ms.max(end_ms);

                let n_tokens = seg.n_tokens();

                let mut words = Vec::new();
                for j in 0..n_tokens {
                    let token = match seg.get_token(j) {
                        Some(t) => t,
                        None => continue,
                    };
                    let token_text = token.to_str_lossy()
                        .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?
                        .to_string();
                    if token_text.starts_with('[') || token_text.starts_with('<') {
                        continue;
                    }
                    let data = token.token_data();
                    words.push(WordTimestamp {
                        word: token_text.trim().to_owned(),
                        start_ms: data.t0 * 10,
                        end_ms: data.t1 * 10,
                        probability: data.p,
                    });
                }

                segments.push(WhisperSegment { text, start_ms, end_ms, words });
            }

            Ok(Transcript { segments, duration_ms: total_end_ms })
        })
        .await
        .map_err(|e| TranscribeError::InferenceFailed(e.to_string()))?
    }
}

#[cfg(feature = "local-whisper")]
fn load_wav_f32(wav_path: &Path) -> Result<Vec<f32>, TranscribeError> {
    let mut reader =
        hound::WavReader::open(wav_path).map_err(|e| TranscribeError::WavDecode(e.to_string()))?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<hound::Result<Vec<_>>>()
            .map_err(|e| TranscribeError::WavDecode(e.to_string()))?,
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .collect::<hound::Result<Vec<_>>>()
            .map_err(|e| TranscribeError::WavDecode(e.to_string()))?
            .into_iter()
            .map(|s| s as f32 / 32768.0)
            .collect(),
    };
    Ok(samples)
}
