//! Text-to-Speech synthesis.
//!
//! Providers (set via `reaction.tts.provider` in config.toml):
//!   - `"edge"`       — Microsoft Edge TTS (free, no key)
//!   - `"minimax"`    — MiniMax Speech 2.8 HD Sync (recommended for quality)
//!   - `"fish_audio"` — Fish Audio S2 Pro (very natural voices)
//!   - `"openai"`     — OpenAI TTS
//!   - `"elevenlabs"` — ElevenLabs
//!
//! All providers output an MP3 file at the given path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tracing::{debug, warn};

use crate::config::{NewsConfig, ReactionConfig};

use super::error::ReactionError;
use crate::news::util::{python_command, run_command};

/// Result of a TTS synthesis call.
#[derive(Debug, Clone)]
pub struct TtsResult {
    /// Absolute path to the generated MP3 file.
    pub path: PathBuf,
    /// Actual spoken duration in seconds (from script, approximated if unknown).
    pub duration_secs: f64,
}

/// TTS result WITH per-word timings — drives narration-synced subtitles + pacing.
#[derive(Debug, Clone)]
pub struct TimedTtsResult {
    pub path: PathBuf,
    pub duration_secs: f64,
    pub words: Vec<crate::transcribe::model::WordTimestamp>,
}

/// Synthesize `text` to MP3 + per-word timings.
///
/// Primary: ElevenLabs `with-timestamps` (exact per-character alignment → words).
/// Fallback: Edge TTS via `scripts/tts/tts_narrate.py` (word timings distributed from
/// sentence boundaries) when the ElevenLabs key/voice is missing or the call fails.
pub async fn synthesize_timed(
    text: &str,
    output_path: &Path,
    reaction_cfg: &ReactionConfig,
    news_cfg: &NewsConfig,
) -> Result<TimedTtsResult, ReactionError> {
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let want_eleven = reaction_cfg.tts.provider == "elevenlabs"
        && !reaction_cfg.tts.elevenlabs_api_key.is_empty()
        && !reaction_cfg.tts.elevenlabs_voice_id.is_empty();

    if want_eleven {
        match synthesize_elevenlabs_timed(text, output_path, reaction_cfg).await {
            Ok(r) => return Ok(r),
            Err(e) => warn!("ElevenLabs timed TTS failed ({e}); falling back to Edge"),
        }
    }
    synthesize_edge_timed(text, output_path, reaction_cfg, news_cfg).await
}

/// ElevenLabs `with-timestamps` → MP3 + per-word timings (aggregated from the
/// per-character alignment the API returns).
async fn synthesize_elevenlabs_timed(
    text: &str,
    output_path: &Path,
    cfg: &ReactionConfig,
) -> Result<TimedTtsResult, ReactionError> {
    use crate::transcribe::model::WordTimestamp;

    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{}/with-timestamps",
        cfg.tts.elevenlabs_voice_id
    );
    let body = serde_json::json!({
        "text": text,
        "model_id": cfg.tts.elevenlabs_model,
        // Lower stability + higher style → more expressive, energetic delivery
        // (a flat read is what makes a reaction voiceover feel stiff).
        "voice_settings": { "stability": 0.28, "similarity_boost": 0.80, "style": 0.50, "use_speaker_boost": true },
    });

    let resp = reqwest::Client::new()
        .post(&url)
        .header("xi-api-key", &cfg.tts.elevenlabs_api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| ReactionError::Tts(format!("ElevenLabs timed request: {e}")))?
        .error_for_status()
        .map_err(|e| ReactionError::Tts(format!("ElevenLabs timed status: {e}")))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| ReactionError::Tts(format!("ElevenLabs timed JSON: {e}")))?;

    // Decode audio
    let b64 = resp["audio_base64"].as_str()
        .or_else(|| resp["audio"].as_str())
        .ok_or_else(|| ReactionError::Tts("ElevenLabs: no audio_base64".to_owned()))?;
    let audio = b64_decode(b64)
        .map_err(|e| ReactionError::Tts(format!("ElevenLabs b64 decode: {e}")))?;
    tokio::fs::write(output_path, &audio).await
        .map_err(|e| ReactionError::Tts(format!("write MP3: {e}")))?;

    // Aggregate per-character alignment → words
    let align = resp.get("alignment")
        .filter(|a| !a.is_null())
        .or_else(|| resp.get("normalized_alignment"))
        .ok_or_else(|| ReactionError::Tts("ElevenLabs: no alignment".to_owned()))?;
    let chars  = align["characters"].as_array().cloned().unwrap_or_default();
    let starts = align["character_start_times_seconds"].as_array().cloned().unwrap_or_default();
    let ends   = align["character_end_times_seconds"].as_array().cloned().unwrap_or_default();

    let mut words: Vec<WordTimestamp> = Vec::new();
    let (mut cur, mut w_start, mut last_end) = (String::new(), 0.0_f64, 0.0_f64);
    for i in 0..chars.len() {
        let ch = chars[i].as_str().unwrap_or("");
        let st = starts.get(i).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let en = ends.get(i).and_then(|v| v.as_f64()).unwrap_or(st);
        if ch.trim().is_empty() {
            if !cur.is_empty() {
                words.push(WordTimestamp {
                    word: std::mem::take(&mut cur),
                    start_ms: (w_start * 1000.0) as i64,
                    end_ms:   (last_end * 1000.0) as i64,
                    probability: 1.0,
                });
            }
        } else {
            if cur.is_empty() { w_start = st; }
            cur.push_str(ch);
            last_end = en;
        }
    }
    if !cur.is_empty() {
        words.push(WordTimestamp {
            word: cur, start_ms: (w_start * 1000.0) as i64,
            end_ms: (last_end * 1000.0) as i64, probability: 1.0,
        });
    }

    let duration_secs = ends.last().and_then(|v| v.as_f64()).unwrap_or_else(|| {
        words.last().map(|w| w.end_ms as f64 / 1000.0).unwrap_or(0.0)
    });
    debug!("ElevenLabs timed: {} words, {:.1}s", words.len(), duration_secs);
    Ok(TimedTtsResult { path: output_path.to_path_buf(), duration_secs, words })
}

/// Edge TTS fallback via `scripts/tts/tts_narrate.py` → MP3 + word timings JSON.
async fn synthesize_edge_timed(
    text: &str,
    output_path: &Path,
    reaction_cfg: &ReactionConfig,
    news_cfg: &NewsConfig,
) -> Result<TimedTtsResult, ReactionError> {
    use crate::transcribe::model::WordTimestamp;

    // tts_narrate.py lives next to the configured tts_script.
    let script = reaction_cfg.tts_script
        .parent().unwrap_or_else(|| Path::new("scripts"))
        .join("tts_narrate.py");
    if !script.exists() {
        return Err(ReactionError::ScriptMissing(script.display().to_string()));
    }
    let mut cmd = python_command_for_tts(news_cfg, &script)?;
    cmd.arg("--text").arg(text)
        .arg("--voice").arg(&reaction_cfg.tts.edge_voice)
        .arg("--rate").arg("+6%")
        .arg("--output").arg(output_path);

    let stdout = run_command(cmd, "tts_narrate", 120).await
        .map_err(|e| ReactionError::Tts(e.to_string()))?;

    #[derive(Deserialize)]
    struct W { word: String, start_ms: i64, end_ms: i64 }
    #[derive(Deserialize)]
    struct Env { success: bool, #[serde(default)] path: Option<String>,
                 #[serde(default)] duration_secs: f64, #[serde(default)] error: Option<String>,
                 #[serde(default)] words: Vec<W> }
    let json = stdout.trim().lines().last().unwrap_or("{}");
    let env: Env = serde_json::from_str(json)
        .map_err(|e| ReactionError::Tts(format!("parse tts_narrate: {e}: {json}")))?;
    if !env.success {
        return Err(ReactionError::Tts(env.error.unwrap_or_else(|| "tts_narrate failed".into())));
    }
    let path = env.path.map(PathBuf::from).unwrap_or_else(|| output_path.to_path_buf());
    let words = env.words.into_iter().map(|w| WordTimestamp {
        word: w.word, start_ms: w.start_ms, end_ms: w.end_ms, probability: 1.0,
    }).collect();
    Ok(TimedTtsResult { path, duration_secs: env.duration_secs, words })
}

/// Minimal base64 decoder (avoid adding a crate dep just for TTS).
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut inv = [255u8; 256];
    for (i, &c) in T.iter().enumerate() { inv[c as usize] = i as u8; }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' { continue; }
        let v = inv[c as usize];
        if v == 255 { return Err(format!("invalid base64 char {c}")); }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// JSON envelope emitted by `scripts/tts/tts_generate.py`.
#[derive(Debug, Deserialize)]
struct TtsEnvelope {
    success: bool,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    duration_secs: f64,
    #[serde(default)]
    error: Option<String>,
}

/// Synthesize `text` to MP3 at `output_path`.
///
/// Tries Edge TTS first (via Python subprocess), falls back to OpenAI TTS
/// when `reaction.tts.provider = "openai"`.
pub async fn synthesize(
    text: &str,
    output_path: &Path,
    reaction_cfg: &ReactionConfig,
    news_cfg: &NewsConfig,         // for conda_env + python_path
    openai_api_key: Option<&str>,  // populated from llm config when needed
) -> Result<TtsResult, ReactionError> {
    // Ensure output directory exists.
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    match reaction_cfg.tts.provider.as_str() {
        "minimax"    => synthesize_minimax(text, output_path, reaction_cfg).await,
        "fish_audio" => synthesize_fish_audio(text, output_path, reaction_cfg).await,
        "openai"     => synthesize_openai(text, output_path, reaction_cfg, openai_api_key).await,
        "elevenlabs" => synthesize_elevenlabs(text, output_path, reaction_cfg).await,
        "none"       => Err(ReactionError::Tts("TTS provider is 'none'".to_owned())),
        _            => synthesize_edge(text, output_path, reaction_cfg, news_cfg).await,
    }
}

// ── Edge TTS (default, free) ──────────────────────────────────────────────────

async fn synthesize_edge(
    text: &str,
    output_path: &Path,
    reaction_cfg: &ReactionConfig,
    news_cfg: &NewsConfig,
) -> Result<TtsResult, ReactionError> {
    let script = &reaction_cfg.tts_script;
    if !script.exists() {
        return Err(ReactionError::ScriptMissing(script.display().to_string()));
    }

    // Build a fake NewsConfig-compatible struct so we can reuse python_command.
    // news_cfg carries conda_env + python_path which we need.
    let mut cmd = python_command_for_tts(news_cfg, script)?;
    cmd.arg("--text").arg(text)
        .arg("--voice").arg(&reaction_cfg.tts.edge_voice)
        .arg("--output").arg(output_path);

    debug!("TTS (edge): voice={}", reaction_cfg.tts.edge_voice);

    let stdout = run_command(cmd, "tts_edge", 60).await
        .map_err(|e| ReactionError::Tts(e.to_string()))?;

    parse_tts_envelope(&stdout, output_path)
}

// ── OpenAI TTS ────────────────────────────────────────────────────────────────

async fn synthesize_openai(
    text: &str,
    output_path: &Path,
    cfg: &ReactionConfig,
    api_key: Option<&str>,
) -> Result<TtsResult, ReactionError> {
    let key = match api_key.filter(|k| !k.is_empty()) {
        Some(k) => k.to_owned(),
        None => return Err(ReactionError::Tts("THOTH_OPENAI_API_KEY not set".to_owned())),
    };

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": cfg.tts.openai_model,
        "input": text,
        "voice": cfg.tts.openai_voice,
        "response_format": "mp3",
    });

    let bytes = client
        .post("https://api.openai.com/v1/audio/speech")
        .bearer_auth(&key)
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| ReactionError::Tts(format!("OpenAI TTS request: {e}")))?
        .error_for_status()
        .map_err(|e| ReactionError::Tts(format!("OpenAI TTS status: {e}")))?
        .bytes()
        .await
        .map_err(|e| ReactionError::Tts(format!("OpenAI TTS read: {e}")))?;

    tokio::fs::write(output_path, &bytes)
        .await
        .map_err(|e| ReactionError::Tts(format!("write MP3: {e}")))?;

    let words = text.split_whitespace().count();
    let dur = words as f64 / 3.0; // ~3 words/sec for Indonesian
    Ok(TtsResult { path: output_path.to_path_buf(), duration_secs: dur })
}

// ── ElevenLabs ────────────────────────────────────────────────────────────────

async fn synthesize_elevenlabs(
    text: &str,
    output_path: &Path,
    cfg: &ReactionConfig,
) -> Result<TtsResult, ReactionError> {
    if cfg.tts.elevenlabs_api_key.is_empty() {
        return Err(ReactionError::Tts("THOTH_ELEVENLABS_API_KEY not set".to_owned()));
    }
    if cfg.tts.elevenlabs_voice_id.is_empty() {
        return Err(ReactionError::Tts("reaction.tts.elevenlabs_voice_id not set".to_owned()));
    }

    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{}",
        cfg.tts.elevenlabs_voice_id
    );
    let body = serde_json::json!({
        "text": text,
        "model_id": cfg.tts.elevenlabs_model,
        "voice_settings": { "stability": 0.5, "similarity_boost": 0.75 },
    });

    let bytes = reqwest::Client::new()
        .post(&url)
        .header("xi-api-key", &cfg.tts.elevenlabs_api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| ReactionError::Tts(format!("ElevenLabs request: {e}")))?
        .error_for_status()
        .map_err(|e| ReactionError::Tts(format!("ElevenLabs status: {e}")))?
        .bytes()
        .await
        .map_err(|e| ReactionError::Tts(format!("ElevenLabs read: {e}")))?;

    tokio::fs::write(output_path, &bytes)
        .await
        .map_err(|e| ReactionError::Tts(format!("write MP3: {e}")))?;

    let words = text.split_whitespace().count();
    let dur   = words as f64 / 3.0;
    Ok(TtsResult { path: output_path.to_path_buf(), duration_secs: dur })
}

// ── MiniMax Speech 2.8 HD Sync ────────────────────────────────────────────────

/// MiniMax T2A v2 synchronous API.
///
/// POST `https://api.minimax.chat/v1/t2a_v2?GroupId=<group_id>`
/// Response JSON: `{ "data": { "audio": "<hex_encoded_mp3>" }, "extra_info": { "audio_length": <ms> } }`
async fn synthesize_minimax(
    text: &str,
    output_path: &Path,
    cfg: &ReactionConfig,
) -> Result<TtsResult, ReactionError> {
    let api_key  = &cfg.tts.minimax_api_key;
    let group_id = &cfg.tts.minimax_group_id;

    if api_key.is_empty() {
        return Err(ReactionError::Tts("THOTH_MINIMAX_API_KEY is not set".to_owned()));
    }
    if group_id.is_empty() {
        return Err(ReactionError::Tts(
            "THOTH_MINIMAX_GROUP_ID is not set (find it in your MiniMax API dashboard)".to_owned()
        ));
    }

    let url = format!("https://api.minimax.chat/v1/t2a_v2?GroupId={group_id}");

    let body = serde_json::json!({
        "model":   cfg.tts.minimax_model,
        "text":    text,
        "stream":  false,
        "voice_setting": {
            "voice_id": cfg.tts.minimax_voice_id,
            "speed":    cfg.tts.minimax_speed,
            "vol":      1.0,
            "pitch":    0,
            "emotion":  cfg.tts.minimax_emotion,
        },
        "audio_setting": {
            "format":      "mp3",
            "sample_rate": 32000,
            "bitrate":     128000,
            "channel":     1,
        }
    });

    debug!("MiniMax TTS: model={} voice={} speed={} emotion={}",
           cfg.tts.minimax_model, cfg.tts.minimax_voice_id,
           cfg.tts.minimax_speed, cfg.tts.minimax_emotion);

    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| ReactionError::Tts(format!("MiniMax request: {e}")))?
        .error_for_status()
        .map_err(|e| ReactionError::Tts(format!("MiniMax HTTP error: {e}")))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| ReactionError::Tts(format!("MiniMax JSON parse: {e}")))?;

    // Check API-level errors
    if let Some(code) = resp["base_resp"]["status_code"].as_i64() {
        if code != 0 {
            let msg = resp["base_resp"]["status_msg"].as_str().unwrap_or("unknown");
            return Err(ReactionError::Tts(format!("MiniMax API error {code}: {msg}")));
        }
    }

    // Extract hex-encoded audio
    let hex_audio = resp["data"]["audio"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ReactionError::Tts("MiniMax: empty audio in response".to_owned()))?;

    let audio_bytes = decode_hex(hex_audio)
        .map_err(|e| ReactionError::Tts(format!("MiniMax hex decode: {e}")))?;

    tokio::fs::write(output_path, &audio_bytes)
        .await
        .map_err(|e| ReactionError::Tts(format!("MiniMax write MP3: {e}")))?;

    // Duration from extra_info.audio_length (milliseconds)
    let duration_secs = resp["extra_info"]["audio_length"]
        .as_f64()
        .map(|ms| ms / 1000.0)
        .unwrap_or_else(|| audio_bytes.len() as f64 / 16_000.0);

    debug!("MiniMax TTS: {:.0} KB, {:.1}s", audio_bytes.len() as f64 / 1024.0, duration_secs);
    Ok(TtsResult { path: output_path.to_path_buf(), duration_secs })
}

// ── Fish Audio S2 Pro ─────────────────────────────────────────────────────────

/// Fish Audio TTS API — returns raw binary audio (no JSON wrapper).
///
/// POST `https://api.fish.audio/v1/tts`
/// Response: binary MP3/Opus audio stream.
async fn synthesize_fish_audio(
    text: &str,
    output_path: &Path,
    cfg: &ReactionConfig,
) -> Result<TtsResult, ReactionError> {
    let api_key = &cfg.tts.fish_audio_api_key;
    if api_key.is_empty() {
        return Err(ReactionError::Tts("THOTH_FISH_AUDIO_API_KEY is not set".to_owned()));
    }

    let mut body = serde_json::json!({
        "text":         text,
        "format":       "mp3",
        "mp3_bitrate":  128,
        "normalize":    true,
        "latency":      "normal",
    });

    // Attach voice reference if configured
    if !cfg.tts.fish_audio_reference_id.is_empty() {
        body["reference_id"] = serde_json::Value::String(
            cfg.tts.fish_audio_reference_id.clone()
        );
    }

    // Model field (S2 Pro uses specific model ID on newer Fish Audio API)
    if cfg.tts.fish_audio_model == "s2-pro" {
        body["model"] = serde_json::Value::String("fishaudio/fish-speech-1.5".to_owned());
    }

    debug!("Fish Audio TTS: model={} ref_id='{}'",
           cfg.tts.fish_audio_model, cfg.tts.fish_audio_reference_id);

    let bytes = reqwest::Client::new()
        .post("https://api.fish.audio/v1/tts")
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| ReactionError::Tts(format!("Fish Audio request: {e}")))?
        .error_for_status()
        .map_err(|e| ReactionError::Tts(format!("Fish Audio HTTP error: {e}")))?
        .bytes()
        .await
        .map_err(|e| ReactionError::Tts(format!("Fish Audio read audio: {e}")))?;

    if bytes.is_empty() {
        return Err(ReactionError::Tts("Fish Audio returned empty audio".to_owned()));
    }

    tokio::fs::write(output_path, &bytes)
        .await
        .map_err(|e| ReactionError::Tts(format!("Fish Audio write MP3: {e}")))?;

    // Estimate duration from file size (~16 KB/s for 128kbps MP3)
    let duration_secs = bytes.len() as f64 / 16_000.0;

    debug!("Fish Audio TTS: {:.0} KB, ~{:.1}s", bytes.len() as f64 / 1024.0, duration_secs);
    Ok(TtsResult { path: output_path.to_path_buf(), duration_secs })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn parse_tts_envelope(stdout: &str, fallback_path: &Path) -> Result<TtsResult, ReactionError> {
    let trimmed = stdout.trim();
    let json = trimmed.find('{').map(|i| &trimmed[i..]).unwrap_or(trimmed);
    let env: TtsEnvelope = serde_json::from_str(json)
        .map_err(|e| ReactionError::Tts(format!("parse TTS output: {e}: {json}")))?;

    if !env.success {
        return Err(ReactionError::Tts(
            env.error.unwrap_or_else(|| "unknown TTS error".to_owned())
        ));
    }

    let path = env.path
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback_path.to_path_buf());

    if !path.exists() {
        return Err(ReactionError::Tts(format!("TTS output file not found: {}", path.display())));
    }

    let duration_secs = if env.duration_secs > 0.0 {
        env.duration_secs
    } else {
        // Estimate from file size: ~16 KB/s for MP3 128kbps
        std::fs::metadata(&path).map(|m| m.len() as f64 / 16_000.0).unwrap_or(10.0)
    };

    Ok(TtsResult { path, duration_secs })
}

/// Build a tokio Command for the TTS script using the news module's python helper.
/// This reuses the conda_env / python_path from NewsConfig — same environment.
fn python_command_for_tts(
    news_cfg: &NewsConfig,
    script: &Path,
) -> Result<tokio::process::Command, ReactionError> {
    python_command(news_cfg, script).map_err(|e| ReactionError::Tts(e.to_string()))
}

/// Decode a hex-encoded string (e.g. "4d50330a...") into raw bytes.
/// MiniMax returns audio as lowercase hex in the `data.audio` JSON field.
fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    let hex = hex.trim();
    if hex.len() % 2 != 0 {
        return Err(format!("odd-length hex string ({} chars)", hex.len()));
    }
    (0..hex.len() / 2)
        .map(|i| {
            u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|e| format!("invalid hex at byte {i}: {e}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_hex_valid() {
        let bytes = decode_hex("4d5033").unwrap();
        assert_eq!(bytes, vec![0x4d, 0x50, 0x33]);
    }

    #[test]
    fn decode_hex_odd_length_errors() {
        assert!(decode_hex("4d503").is_err());
    }

    #[test]
    fn decode_hex_invalid_char_errors() {
        assert!(decode_hex("4d5z33").is_err());
    }
}
