/// Visual frame analysis for viral moment scoring.
///
/// Extracts JPEG frames from a video segment using FFmpeg, then calls a
/// vision-capable LLM (Claude, OpenAI, or Gemini) to score the visual quality
/// of that moment across four dimensions:
///
/// - **humor**         — funny faces, reactions, comedic timing
/// - **visual_impact** — graphics, text overlays, dramatic visuals
/// - **novelty**       — new on-screen info (charts, data, demonstrations)
/// - **engagement**    — eye contact, gestures, pacing, watchability
///
/// Each score is 0–10. The combined normalised score (sum/40) is blended with
/// the text-analysis rank to produce a final ordering of candidate moments.
///
/// All errors are handled gracefully: a failed frame extraction or API call
/// returns `None`, and the moment retains its text-only rank (vis_score = 0.0).

use std::path::{Path, PathBuf};

use anyhow::Result;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::config::{LlmConfig, VisionConfig};

use super::schema::VisualScore;

// ── Frame data ────────────────────────────────────────────────────────────────

/// A single extracted video frame, ready for base64 encoding into an API request.
pub struct FrameData {
    pub path:          PathBuf,
    pub base64:        String,
    pub timestamp_sec: f64,
}

// ── Scene boundary detection ──────────────────────────────────────────────────

/// Detect timestamps of scene boundaries (visual cuts) within a video segment.
///
/// Uses FFmpeg `select='gt(scene,threshold)'` which outputs a frame whenever
/// the visual difference between consecutive frames exceeds `threshold`.
/// Parses `pts_time:` values from FFmpeg's `showinfo` filter output.
///
/// Returns a sorted Vec of absolute timestamps (seconds from video start).
/// Returns empty Vec on failure — callers fall back to uniform sampling.
pub async fn detect_scene_boundaries(
    video_path: &Path,
    start_sec:  f64,
    end_sec:    f64,
    threshold:  f32,
) -> Vec<f64> {
    let ffmpeg = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_owned());
    let vf     = format!("select='gt(scene,{threshold:.2})',showinfo,scale=64:64");

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-ss", &format!("{start_sec:.3}"),
                "-to", &format!("{end_sec:.3}"),
                "-i", &video_path.to_string_lossy(),
                "-vf", &vf,
                "-frames:v", "500",   // safety cap
                "-f", "null", "-",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output(),
    ).await;

    let stderr = match output {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stderr).to_string(),
        _ => { debug!("vision: scene detection failed (timeout or spawn error)"); return Vec::new(); }
    };

    // Parse "pts_time:X.XXXXXX" from showinfo output
    let mut timestamps: Vec<f64> = stderr.lines()
        .filter(|l| l.contains("pts_time:"))
        .filter_map(|l| {
            let pos = l.find("pts_time:")?;
            let rest = &l[pos + 9..];
            let end  = rest.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(rest.len());
            rest[..end].parse::<f64>().ok()
        })
        // Convert from relative (seek-based) to absolute timestamps
        .map(|rel| start_sec + rel)
        .collect();

    timestamps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    timestamps.dedup_by(|a, b| (*b - *a).abs() < 0.1); // merge duplicates <100ms apart

    debug!("vision: scene_detection found {} boundaries in [{:.1}s–{:.1}s]",
           timestamps.len(), start_sec, end_sec);
    timestamps
}

// ── Frame extraction ──────────────────────────────────────────────────────────

/// Extract up to `count` JPEG frames from `[start_sec, end_sec]`.
///
/// When `scene_timestamps` is `Some(scenes)` and non-empty, frames are extracted
/// AT the detected scene boundaries (up to `count` frames, evenly subsampled).
/// When `scene_timestamps` is `None` or empty, uniform time-based sampling is used
/// (existing behaviour — fully backward compatible).
///
/// Frames are resized to `width` pixels wide (height proportional).
/// Returns an empty `Vec` on FFmpeg failure (caller treats it as no visual data).
pub async fn extract_frames(
    video_path:       &Path,
    start_sec:        f64,
    end_sec:          f64,
    count:            u32,
    width:            u32,
    output_dir:       &Path,
    scene_timestamps: Option<&[f64]>,   // None = uniform sampling (default)
) -> Vec<FrameData> {
    if let Err(e) = tokio::fs::create_dir_all(output_dir).await {
        warn!("vision: cannot create frames dir: {e}");
        return Vec::new();
    }

    // Choose timestamps to extract: scene-based or uniform
    let selected_ts: Vec<f64> = match scene_timestamps {
        Some(scenes) if !scenes.is_empty() => {
            subsample_timestamps(scenes, count as usize)
        }
        _ => {
            // Uniform: count evenly spaced points inside [start_sec, end_sec]
            let duration = (end_sec - start_sec).max(0.1);
            (1..=count)
                .map(|i| start_sec + (i as f64 - 0.5) * duration / count as f64)
                .collect()
        }
    };

    if selected_ts.is_empty() {
        return Vec::new();
    }

    let ffmpeg  = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_owned());
    let mut frames = Vec::new();

    for (idx, &ts) in selected_ts.iter().enumerate() {
        let out_path = output_dir.join(format!("frame_{idx:03}.jpg"));
        let status = tokio::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-ss", &format!("{ts:.3}"),
                "-i", &video_path.to_string_lossy(),
                "-vf", &format!("scale={width}:-2"),
                "-frames:v", "1",
                "-q:v", "4",
                &out_path.to_string_lossy(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;

        match status {
            Ok(s) if s.success() => {}
            Ok(s) => { warn!("vision: frame extraction exited with {s} at t={ts:.1}s"); continue; }
            Err(e) => { warn!("vision: failed to spawn ffmpeg: {e}"); continue; }
        }

        match std::fs::read(&out_path) {
            Ok(bytes) => {
                let base64 = B64.encode(&bytes);
                frames.push(FrameData { path: out_path, base64, timestamp_sec: ts });
            }
            Err(e) => warn!("vision: cannot read frame at t={ts:.1}s: {e}"),
        }
    }
    frames
}

/// Build uniformly spaced timestamps across a video duration.
fn build_uniform_timestamps(total_duration: f64, interval_sec: f64) -> Vec<f64> {
    let mut ts  = Vec::new();
    let mut t   = interval_sec / 2.0;
    while t < total_duration { ts.push(t); t += interval_sec; }
    ts
}

/// Select up to `max_count` timestamps from a list, evenly distributed by index.
fn subsample_timestamps(all: &[f64], max_count: usize) -> Vec<f64> {
    if all.len() <= max_count {
        return all.to_vec();
    }
    let step = all.len() as f32 / max_count as f32;
    (0..max_count)
        .map(|i| all[(i as f32 * step) as usize])
        .collect()
}

/// Delete the frames directory after scoring is complete.
pub fn cleanup_frames(frames_dir: &Path) {
    if frames_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(frames_dir) {
            warn!("vision: failed to clean up frames dir: {e}");
        }
    }
}

// ── Vision prompt ─────────────────────────────────────────────────────────────

fn build_system_prompt() -> &'static str {
    "You are a video content analyst. Score these video frames for short-form social media appeal. \
     Be objective and specific. Output ONLY valid JSON — no prose, no markdown."
}

fn build_user_prompt(start_sec: f64, end_sec: f64, segment_text: &str) -> String {
    format!(
        "Frames from [{start_sec:.1}s – {end_sec:.1}s]. What's being said: \"{segment_text}\"\n\n\
         Rate 0–10 each:\n\
         - humor: funny expressions, reactions, comedic timing, meme energy\n\
         - visual_impact: graphics, text on screen, dramatic visuals, eye-catching elements\n\
         - novelty: new info shown visually (charts, data, demonstrations, reveals)\n\
         - engagement: eye contact, gestures, pacing, overall watchability\n\n\
         Respond ONLY with JSON (no other text):\n\
         {{\"humor\":N,\"visual_impact\":N,\"novelty\":N,\"engagement\":N,\"note\":\"one sentence\"}}"
    )
}

// ── Visual analyzer ───────────────────────────────────────────────────────────

/// Calls a vision-capable LLM provider to score a set of video frames.
///
/// Supports: `"gemini"`, `"openai"`, `"claude"`, `"vllm"`.
/// Returns `None` on any error so callers always degrade gracefully.
pub struct VisualAnalyzer<'a> {
    config:     &'a VisionConfig,
    llm_config: &'a LlmConfig,
    client:     reqwest::Client,
}

impl<'a> VisualAnalyzer<'a> {
    pub fn new(config: &'a VisionConfig, llm_config: &'a LlmConfig) -> Self {
        // Large multimodal models (especially self-hosted via vLLM) can take several
        // minutes to process 5 frames + generate descriptions.
        // qwen-32b-vl at 3 tok/s for a 256-token response = ~85 seconds per batch.
        // Use a generous 600s timeout to avoid false connection errors.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .user_agent("clipper/1.0")
            .build()
            .unwrap_or_default();
        Self { config, llm_config, client }
    }

    /// Score a moment's visual quality from the given frames.
    /// Returns `None` on any error (graceful degradation — caller uses vis_score = 0.0).
    pub async fn score_moment(
        &self,
        frames:       &[FrameData],
        segment_text: &str,
        start_sec:    f64,
        end_sec:      f64,
    ) -> Option<VisualScore> {
        if frames.is_empty() {
            return None;
        }
        let system = build_system_prompt();
        let user   = build_user_prompt(start_sec, end_sec, segment_text);

        let raw = match self.config.provider.as_str() {
            "gemini" => self.call_gemini(system, &user, frames).await,
            "openai" => self.call_openai(system, &user, frames).await,
            "claude" => self.call_claude(system, &user, frames).await,
            "vllm"   => self.call_vllm(system, &user, frames).await,
            other    => {
                warn!("vision: provider '{}' does not support vision — skipping", other);
                return None;
            }
        };

        match raw {
            Ok(text) => parse_visual_score(&text),
            Err(e)   => {
                warn!("vision: API error: {e}");
                None
            }
        }
    }

    // ── Batch description (full-video combined prompt) ────────────────────────

    /// Describe a batch of frames from the full video.
    ///
    /// Returns `None` on any API error. Each frame gets a one-sentence description.
    pub async fn describe_batch(
        &self,
        frames:     &[FrameData],
        timestamps: &[f64],
    ) -> Option<Vec<VideoDescription>> {
        if frames.is_empty() { return None; }

        let system = "You are a video frame describer. \
                      For each frame, write ONE concise sentence describing the visual content: \
                      speaker expressions/gestures, on-screen text/graphics, camera angle, background. \
                      Be specific. Output ONLY valid JSON — no prose, no markdown.";

        let ts_strs: Vec<String> = timestamps.iter()
            .enumerate()
            .map(|(i, t)| format!("frame_{i}: {t:.1}s"))
            .collect();

        let user = format!(
            "Describe each frame briefly. Timestamps: {}\n\n\
             Respond ONLY with JSON array (one entry per frame):\n\
             [{{\"t\":{t0:.1},\"desc\":\"one sentence\"}}, ...]",
            ts_strs.join(", "),
            t0 = timestamps.first().copied().unwrap_or(0.0)
        );

        let raw = match self.config.provider.as_str() {
            "gemini" => self.call_gemini(system, &user, frames).await,
            "openai" => self.call_openai(system, &user, frames).await,
            "claude" => self.call_claude(system, &user, frames).await,
            // For vLLM, use the describe-specific override (smaller/faster model)
            // if configured; otherwise fall back to the main vllm endpoint.
            "vllm"   => self.call_vllm_describe(system, &user, frames).await,
            other    => {
                warn!("vision: provider '{}' does not support vision description", other);
                return None;
            }
        };

        match raw {
            Ok(text) => parse_description_batch(&text, timestamps),
            Err(e)   => {
                warn!("vision: describe_batch error: {e}");
                None
            }
        }
    }

    // ── Raw vision call (custom prompts) ─────────────────────────────────────

    /// Call the vision API with fully custom system/user prompts and return the
    /// raw text response.  Used by trend-analyze for style analysis.
    pub async fn raw_vision_call(
        &self,
        system: &str,
        user:   &str,
        frames: &[FrameData],
    ) -> Option<String> {
        if frames.is_empty() { return None; }
        let raw = match self.config.provider.as_str() {
            "gemini" => self.call_gemini(system, user, frames).await,
            "openai" => self.call_openai(system, user, frames).await,
            "claude" => self.call_claude(system, user, frames).await,
            "vllm"   => self.call_vllm_describe(system, user, frames).await,
            other    => {
                warn!("vision: provider '{}' does not support raw_vision_call", other);
                return None;
            }
        };
        match raw {
            Ok(text) if !text.trim().is_empty() => Some(text),
            Ok(_)    => { warn!("vision: raw_vision_call returned empty response"); None }
            Err(e)   => { warn!("vision: raw_vision_call error: {e}"); None }
        }
    }

    // ── Gemini vision ─────────────────────────────────────────────────────────

    async fn call_gemini(
        &self,
        system: &str,
        user:   &str,
        frames: &[FrameData],
    ) -> Result<String> {
        let api_key = &self.llm_config.gemini_api_key;
        if api_key.is_empty() {
            anyhow::bail!("CLIPPER_GEMINI_API_KEY is not set");
        }
        let model = &self.llm_config.gemini_model;
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );

        // Build parts: inline image data for each frame, then text
        let mut parts: Vec<Value> = frames.iter().map(|f| {
            json!({ "inlineData": { "mimeType": "image/jpeg", "data": f.base64 } })
        }).collect();
        parts.push(json!({ "text": user }));

        let body = json!({
            "system_instruction": { "parts": [{ "text": system }] },
            "contents": [{ "role": "user", "parts": parts }],
            "generationConfig": { "temperature": 0.1, "maxOutputTokens": 256 }
        });

        let resp = self.client.post(&url).json(&body).send().await?;
        let status = resp.status();
        let text   = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("Gemini vision {status}: {text}");
        }
        let json: Value = serde_json::from_str(&text)?;
        let content = json["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        Ok(content)
    }

    // ── OpenAI vision ─────────────────────────────────────────────────────────

    async fn call_openai(
        &self,
        system: &str,
        user:   &str,
        frames: &[FrameData],
    ) -> Result<String> {
        let api_key = &self.llm_config.openai_api_key;
        if api_key.is_empty() {
            anyhow::bail!("CLIPPER_OPENAI_API_KEY is not set");
        }
        let model = &self.llm_config.openai_model;
        let url   = "https://api.openai.com/v1/chat/completions";

        // Build user content: images (detail=low → ~85 tokens each) + text
        let mut content: Vec<Value> = frames.iter().map(|f| {
            json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:image/jpeg;base64,{}", f.base64),
                    "detail": "low"
                }
            })
        }).collect();
        content.push(json!({ "type": "text", "text": user }));

        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": content }
            ],
            "max_tokens": 256
        });

        let resp = self.client
            .post(url)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text   = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("OpenAI vision {status}: {text}");
        }
        let json: Value = serde_json::from_str(&text)?;
        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        Ok(content)
    }

    // ── vLLM vision ───────────────────────────────────────────────────────────
    // Uses the OpenAI-compatible vision API served by vLLM.
    // Requires a multimodal model such as Qwen2.5-VL or LLaVA.
    //
    // Two variants:
    //   call_vllm         → uses vision.vllm_base_url + vision.vllm_model  (scoring)
    //   call_vllm_describe → uses vision.describe_vllm_base_url + describe_vllm_model
    //                         (full-video description, typically a smaller/faster model)
    //                         Falls back to call_vllm when override not configured.

    async fn call_vllm(
        &self,
        system: &str,
        user:   &str,
        frames: &[FrameData],
    ) -> Result<String> {
        let base_url = self.config.vllm_base_url.trim_end_matches('/');
        if base_url.is_empty() {
            anyhow::bail!(
                "vision.vllm_base_url is not set in config.toml.\n\
                 Example: vllm_base_url = \"http://192.168.1.10:8001\""
            );
        }
        let model = if self.config.vllm_model.is_empty() {
            "Qwen/Qwen2.5-VL-7B-Instruct"
        } else {
            &self.config.vllm_model
        };
        let url = format!("{base_url}/v1/chat/completions");

        // Build user content: base64 images + text (OpenAI image_url format)
        let mut content: Vec<Value> = frames.iter().map(|f| {
            json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:image/jpeg;base64,{}", f.base64)
                }
            })
        }).collect();
        content.push(json!({ "type": "text", "text": user }));

        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": content }
            ],
            "temperature": 0.1,
            "max_tokens":  512
        });

        let mut req = self.client.post(&url).json(&body);

        // Optional API key for secured vLLM deployments
        if !self.llm_config.vllm_api_key.is_empty() {
            req = req.bearer_auth(&self.llm_config.vllm_api_key);
        }

        let resp   = req.send().await?;
        let status = resp.status();
        let text   = resp.text().await?;

        if !status.is_success() {
            anyhow::bail!("vLLM vision {status}: {text}");
        }

        let json: Value = serde_json::from_str(&text)?;

        // Handle both standard content and reasoning model output fields
        let msg = &json["choices"][0]["message"];
        let content_str = msg["content"].as_str()
            .or_else(|| msg["reasoning_content"].as_str())
            .or_else(|| msg["reasoning"].as_str())
            .unwrap_or("")
            .to_owned();

        Ok(content_str)
    }

    /// vLLM vision call using the describe-specific override config.
    ///
    /// When `vision.describe_vllm_base_url` is set, uses that URL + model instead
    /// of the main `vision.vllm_base_url`. This lets you route describe_video calls
    /// to a smaller/faster model (e.g. 7B) while score_moment uses the larger model.
    async fn call_vllm_describe(
        &self,
        system: &str,
        user:   &str,
        frames: &[FrameData],
    ) -> Result<String> {
        // Use describe override if configured, otherwise fall back to main vllm config
        let base_url = {
            let override_url = self.config.describe_vllm_base_url.trim_end_matches('/');
            if !override_url.is_empty() {
                override_url.to_owned()
            } else {
                let main = self.config.vllm_base_url.trim_end_matches('/');
                if main.is_empty() {
                    anyhow::bail!(
                        "Neither vision.describe_vllm_base_url nor vision.vllm_base_url is set.\n\
                         Set at least one in config.toml."
                    );
                }
                main.to_owned()
            }
        };

        let model = {
            let override_model = self.config.describe_vllm_model.trim();
            if !override_model.is_empty() {
                override_model.to_owned()
            } else if !self.config.vllm_model.is_empty() {
                self.config.vllm_model.clone()
            } else {
                "Qwen/Qwen2.5-VL-7B-Instruct".to_owned()
            }
        };

        let url = format!("{base_url}/v1/chat/completions");

        let mut content: Vec<Value> = frames.iter().map(|f| {
            json!({
                "type": "image_url",
                "image_url": { "url": format!("data:image/jpeg;base64,{}", f.base64) }
            })
        }).collect();
        content.push(json!({ "type": "text", "text": user }));

        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user",   "content": content }
            ],
            "temperature": 0.1,
            "max_tokens":  512
        });

        let mut req = self.client.post(&url).json(&body);
        if !self.llm_config.vllm_api_key.is_empty() {
            req = req.bearer_auth(&self.llm_config.vllm_api_key);
        }

        let resp   = req.send().await?;
        let status = resp.status();
        let text   = resp.text().await?;

        if !status.is_success() {
            anyhow::bail!("vLLM describe vision {status}: {text}");
        }

        let json: Value = serde_json::from_str(&text)?;
        let msg = &json["choices"][0]["message"];
        let content_str = msg["content"].as_str()
            .or_else(|| msg["reasoning_content"].as_str())
            .or_else(|| msg["reasoning"].as_str())
            .unwrap_or("")
            .to_owned();

        Ok(content_str)
    }

    // ── Claude vision ─────────────────────────────────────────────────────────

    async fn call_claude(
        &self,
        system: &str,
        user:   &str,
        frames: &[FrameData],
    ) -> Result<String> {
        let api_key = &self.llm_config.claude_api_key;
        if api_key.is_empty() {
            anyhow::bail!("CLIPPER_CLAUDE_API_KEY is not set");
        }
        let model = &self.llm_config.claude_model;
        let url   = "https://api.anthropic.com/v1/messages";

        // Build content: base64 image blocks then text
        let mut content: Vec<Value> = frames.iter().map(|f| {
            json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": f.base64
                }
            })
        }).collect();
        content.push(json!({ "type": "text", "text": user }));

        let body = json!({
            "model":      model,
            "max_tokens": 256,
            "system":     system,
            "messages":   [{ "role": "user", "content": content }]
        });

        let resp = self.client
            .post(url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text   = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("Claude vision {status}: {text}");
        }
        let json: Value = serde_json::from_str(&text)?;
        let content = json["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        Ok(content)
    }
}

/// Parse a batch description response into `Vec<VideoDescription>`.
/// Handles both JSON array `[{"t":N,"desc":"..."}]` and fallback plain text.
fn parse_description_batch(raw: &str, timestamps: &[f64]) -> Option<Vec<VideoDescription>> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // Try JSON array first
    let start = cleaned.find('[').unwrap_or(0);
    let end   = cleaned.rfind(']').unwrap_or(cleaned.len().saturating_sub(1));

    if start < end {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&cleaned[start..=end]) {
            let descs: Vec<VideoDescription> = arr.iter()
                .filter_map(|v| {
                    let t    = v["t"].as_f64()?;
                    let desc = v["desc"].as_str().unwrap_or("").to_owned();
                    Some(VideoDescription { timestamp_sec: t, text: desc })
                })
                .collect();
            if !descs.is_empty() {
                return Some(descs);
            }
        }
    }

    // Fallback: if the model returned a single description, assign to first timestamp
    if let Some(&first_ts) = timestamps.first() {
        let text = cleaned.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_owned();
        if !text.is_empty() {
            return Some(vec![VideoDescription { timestamp_sec: first_ts, text }]);
        }
    }

    None
}

// ── Full-video description (Priority 1: combined audio-visual prompt) ────────

/// A visual description of a single video frame at a known timestamp.
#[derive(Debug, Clone)]
pub struct VideoDescription {
    /// Timestamp of the frame in the video (seconds from start).
    pub timestamp_sec: f64,
    /// One-sentence visual description of what is happening in the frame.
    pub text: String,
}

/// Sample the entire video and generate a brief text description for each frame.
///
/// **Sampling strategy** (controlled by `config.scene_detection`):
/// - `false` (default): uniform interval sampling every `interval_sec` seconds
/// - `true`: detect actual scene boundaries first, then describe one frame per
///   distinct scene — more accurate, avoids redundant descriptions of the same shot
///
/// Frames are batched into groups of `batch_size` per API call.
/// Returns an empty `Vec` on any failure — callers fall back to plain transcript.
pub async fn describe_video_frames(
    video_path:    &Path,
    total_duration: f64,
    interval_sec:   f64,
    batch_size:     u32,
    frame_width:    u32,
    output_dir:     &Path,
    config:         &VisionConfig,
    llm_config:     &LlmConfig,
) -> Vec<VideoDescription> {
    if total_duration <= 0.0 || interval_sec <= 0.0 {
        return Vec::new();
    }

    // ── Determine sampling timestamps ─────────────────────────────────────────
    let max_frames = (total_duration / interval_sec) as usize + 1;

    let timestamps: Vec<f64> = if config.scene_detection {
        // Scene-based: detect cuts across the whole video, subsample to max_frames
        let scenes = detect_scene_boundaries(
            video_path, 0.0, total_duration, config.scene_threshold,
        ).await;

        if scenes.is_empty() {
            debug!("vision: no scenes detected — falling back to uniform sampling");
            build_uniform_timestamps(total_duration, interval_sec)
        } else {
            debug!("vision: scene_detection found {} scenes across {:.0}s video", scenes.len(), total_duration);
            subsample_timestamps(&scenes, max_frames)
        }
    } else {
        build_uniform_timestamps(total_duration, interval_sec)
    };

    if timestamps.is_empty() {
        return Vec::new();
    }

    let analyzer = VisualAnalyzer::new(config, llm_config);
    let mut all_descriptions: Vec<VideoDescription> = Vec::new();

    // Process in batches
    for (batch_idx, chunk) in timestamps.chunks(batch_size as usize).enumerate() {
        let batch_dir = output_dir.join(format!("desc_batch_{batch_idx:04}"));

        // Extract one frame per timestamp in this batch (uniform 1-frame extract)
        let mut ts_list:    Vec<f64>      = Vec::new();
        let mut frames_data: Vec<FrameData> = Vec::new();
        for &ts in chunk {
            let frame_dir = batch_dir.join(format!("t{ts:.0}"));
            let frames = extract_frames(video_path, ts, ts + 0.5, 1, frame_width, &frame_dir, None).await;
            if let Some(f) = frames.into_iter().next() {
                ts_list.push(ts);
                frames_data.push(f);
            }
        }

        if frames_data.is_empty() {
            continue;
        }

        // Call vision LLM to describe this batch
        if let Some(descs) = analyzer.describe_batch(&frames_data, &ts_list).await {
            all_descriptions.extend(descs);
        }

        // Clean up batch frames
        cleanup_frames(&batch_dir);
    }

    // Sort by timestamp
    all_descriptions.sort_by(|a, b| a.timestamp_sec.partial_cmp(&b.timestamp_sec).unwrap());
    all_descriptions
}

/// Inject visual descriptions into a compact transcript string.
///
/// For each line `[sec] text`, find the nearest frame description within
/// `half_interval` seconds and append it as an indented `↳ Visual:` line.
///
/// Lines without a nearby frame description are passed through unchanged.
pub fn build_enriched_transcript(
    compact_transcript: &str,
    descriptions:       &[VideoDescription],
    interval_sec:       f64,
) -> String {
    if descriptions.is_empty() {
        return compact_transcript.to_owned();
    }

    let half = interval_sec / 2.0;
    let mut out = String::with_capacity(compact_transcript.len() * 2);

    for line in compact_transcript.lines() {
        out.push_str(line);
        out.push('\n');

        // Parse timestamp from "[sec] text" format
        if let Some(ts) = parse_compact_timestamp(line) {
            // Find nearest description within half_interval
            let nearest = descriptions.iter().min_by(|a, b| {
                let da = (a.timestamp_sec - ts).abs();
                let db = (b.timestamp_sec - ts).abs();
                da.partial_cmp(&db).unwrap()
            });

            if let Some(desc) = nearest {
                if (desc.timestamp_sec - ts).abs() <= half && !desc.text.is_empty() {
                    out.push_str("  ↳ Visual: ");
                    out.push_str(&desc.text);
                    out.push('\n');
                }
            }
        }
    }

    out
}

/// Parse the timestamp from a compact transcript line like `[120] text` or `[🎯 kw][120] text`.
pub fn parse_compact_timestamp(line: &str) -> Option<f64> {
    // Find the last `[N]` pattern before any text
    let mut s = line;
    // Skip keyword markers like [🎯 keyword]
    while let Some(start) = s.find('[') {
        let rest = &s[start + 1..];
        if let Some(end) = rest.find(']') {
            let inner = &rest[..end];
            // Try to parse as a number (seconds)
            if let Ok(sec) = inner.trim().parse::<f64>() {
                return Some(sec);
            }
            // Otherwise skip this bracket group and continue
            s = &rest[end + 1..];
        } else {
            break;
        }
    }
    None
}

// ── Response parsing ──────────────────────────────────────────────────────────

/// Parse the vision LLM's JSON response into a `VisualScore`.
/// Strips markdown fences, extracts the first `{...}` block, and deserialises.
/// Returns `None` on any parse failure.
fn parse_visual_score(raw: &str) -> Option<VisualScore> {
    // Strip ```json fences if present
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // Find the first { ... } JSON object
    let start = cleaned.find('{')?;
    let end   = cleaned.rfind('}')?;
    if end < start {
        return None;
    }
    let json_str = &cleaned[start..=end];

    let v: Value = serde_json::from_str(json_str).ok()?;

    let clamp = |key: &str| -> u8 {
        v[key].as_u64().unwrap_or(0).min(10) as u8
    };

    Some(VisualScore {
        humor:         clamp("humor"),
        visual_impact: clamp("visual_impact"),
        novelty:       clamp("novelty"),
        engagement:    clamp("engagement"),
        note:          v["note"].as_str().unwrap_or("").to_owned(),
    })
}
