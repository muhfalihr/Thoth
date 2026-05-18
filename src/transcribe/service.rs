use std::path::{Path, PathBuf};
use std::time::Instant;
use std::io::Write;

use anyhow::Result;
use chrono::{DateTime, Utc};
use ffmpeg_sidecar::command::FfmpegCommand;
use serde::{Deserialize, Serialize};
use tracing::{debug, info};
use futures_util::StreamExt;

use crate::config::AppConfig;
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
}

impl<'a> TranscribeService<'a> {
    pub fn new(config: &'a AppConfig, job: &'a JobContext) -> Self {
        Self { config, job }
    }

    pub async fn run(
        &self,
        video_path: &Path,
        model_size: &str,
    ) -> Result<TranscribeResult, TranscribeError> {
        let t0 = Instant::now();

        // Step 1: Extract 16kHz mono WAV
        let wav_path = self.job.source_dir().join("audio.wav");
        self.extract_audio(video_path, &wav_path).await?;

        // Log audio file size so user knows what's being uploaded / processed
        let wav_mb = std::fs::metadata(&wav_path)
            .map(|m| m.len() as f64 / 1_048_576.0)
            .unwrap_or(0.0);
        info!("audio extracted: {wav_mb:.1} MB ({wav_path:?})");

        // Step 2: Transcribe (Groq API or local Whisper)
        let t_infer = Instant::now();
        let transcript = self.transcribe(&wav_path, model_size).await?;
        let infer_secs = t_infer.elapsed().as_secs_f64();

        // Step 3: Save transcript JSON
        let transcript_path = self.job.transcript_path();
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
            model_used: model_size.to_owned(),
            completed_at: Utc::now(),
        })
    }

    async fn transcribe(
        &self,
        wav_path: &Path,
        #[cfg_attr(not(feature = "local-whisper"), allow(unused_variables))]
        model_size: &str,
    ) -> Result<Transcript, TranscribeError> {
        #[cfg(feature = "local-whisper")]
        {
            let model_path = self.config.whisper_model_path(Some(model_size));
            if !model_path.exists() {
                self.download_whisper_model(model_size).await?;
            }

            info!("using local whisper [{model_size}] (CUDA-accelerated)");
            local::run_local_whisper(
                wav_path,
                &model_path,
                self.config.whisper.n_threads,
                &self.config.whisper.language,
            )
            .await
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

    async fn transcribe_via_groq(&self, wav_path: &Path) -> Result<Transcript, TranscribeError> {
        if self.config.llm.groq_api_key.is_empty() {
            return Err(TranscribeError::InitFailed(
                "CLIPPER_GROQ_API_KEY is not set.\n\
                 Set it via: $env:CLIPPER_GROQ_API_KEY = \"gsk_...\"\n\
                 Or add to your .env file."
                    .to_owned(),
            ));
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
    async fn groq_transcribe_chunked(
        &self,
        mp3_path: &Path,
        total_duration_secs: f64,
    ) -> Result<Transcript, TranscribeError> {
        let n_chunks = (total_duration_secs / CHUNK_DURATION_SECS).ceil() as usize;
        let chunk_dir = mp3_path.parent().unwrap_or(std::path::Path::new("."));
        let mut all_segments: Vec<WhisperSegment> = Vec::new();

        for chunk_idx in 0..n_chunks {
            let chunk_start = chunk_idx as f64 * CHUNK_DURATION_SECS;
            let chunk_end   = (chunk_start + CHUNK_DURATION_SECS).min(total_duration_secs);
            let chunk_dur   = chunk_end - chunk_start;

            info!(
                "chunk {}/{}: {:.0}s – {:.0}s ({:.1} min)",
                chunk_idx + 1, n_chunks,
                chunk_start, chunk_end,
                chunk_dur / 60.0
            );

            // Extract chunk with FFmpeg stream-copy (fast)
            let chunk_path = chunk_dir.join(format!("chunk_{chunk_idx:03}.mp3"));
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

            if !status.success() || !chunk_path.exists() {
                // Chunk is past end of file — we're done
                break;
            }

            let chunk_mb = std::fs::metadata(&chunk_path)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);

            let pb = spinner(&format!(
                "[{}/{}] Uploading chunk {:.0}s–{:.0}s ({chunk_mb:.1} MB)…",
                chunk_idx + 1, n_chunks, chunk_start, chunk_end
            ));

            let mut chunk_transcript = self.groq_upload(&chunk_path, chunk_start).await?;
            pb.finish_and_clear();

            // Deduplicate: drop segments that overlap with the previous chunk's last segment
            if let Some(prev_last) = all_segments.last() {
                let min_start = prev_last.end_ms;
                chunk_transcript.segments.retain(|s| s.start_ms >= min_start);
            }
            all_segments.extend(chunk_transcript.segments);

            // Clean up chunk file immediately to save disk space
            let _ = tokio::fs::remove_file(&chunk_path).await;
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
