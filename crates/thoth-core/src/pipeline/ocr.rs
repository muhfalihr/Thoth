use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::execution::JobExecutionContext;
use crate::ingest::content_search::{
    MAIN_CONTEXT_FILE, MainContext, OCR_ANALYZER_VERSION, OCR_SCHEMA_VERSION, OcrMetadata,
    OcrStatus, SubtitleBlur, configured_ocr_model, validate_main_ocr_for_model,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OcrAnalysis {
    pub schema_version: u32,
    pub ocr_status: OcrStatus,
    pub provider: String,
    pub model: String,
    pub analyzer_version: String,
    pub requested_frames: usize,
    pub valid_frames: usize,
    pub analyzed_at: String,
    #[serde(default)]
    pub verdict: Option<OcrVerdict>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OcrVerdict {
    pub outcome: String,
    pub trim_start: f64,
    pub mute_audio: bool,
    pub subtitle_blur: Vec<SubtitleBlur>,
}

#[derive(Debug, Clone)]
pub(crate) struct ScoutRuntime {
    pub(crate) bun: PathBuf,
    pub(crate) scout_dir: PathBuf,
    pub(crate) cli_ts: PathBuf,
}

pub(crate) fn resolve_scout_runtime() -> Result<ScoutRuntime> {
    let current_exe = std::env::current_exe().ok();
    let cwd = std::env::current_dir().context("could not determine current directory")?;
    let scout_dir = resolve_scout_dir_from(current_exe.as_deref(), &cwd)?;
    let bun = which::which("bun")
        .map_err(|_| anyhow::anyhow!("bun not found in PATH — Scout requires Bun >=1.2"))?;
    Ok(ScoutRuntime {
        bun,
        cli_ts: scout_dir.join("cli.ts"),
        scout_dir,
    })
}

fn resolve_scout_dir_from(current_exe: Option<&Path>, cwd: &Path) -> Result<PathBuf> {
    if let Some(executable) = current_exe {
        for ancestor in executable.ancestors().skip(1).take(6) {
            let candidate = ancestor.join("scout");
            if candidate.join("cli.ts").is_file() {
                return Ok(candidate);
            }
        }
    }

    let candidate = cwd.join("scout");
    if candidate.join("cli.ts").is_file() {
        return Ok(candidate);
    }

    anyhow::bail!(
        "scout/cli.ts not found — run from the repository root or install thoth under <repo>/target/release"
    )
}

pub async fn run_local_ocr(
    execution: &JobExecutionContext,
    video_path: &Path,
) -> Result<OcrAnalysis> {
    execution.check_cancelled()?;
    let video_path = video_path
        .canonicalize()
        .with_context(|| format!("local OCR video does not exist: {}", video_path.display()))?;
    if !video_path.is_file() {
        anyhow::bail!(
            "local OCR source is not a regular file: {}",
            video_path.display()
        );
    }

    let runtime = resolve_scout_runtime().context("failed to resolve Scout OCR runtime")?;
    let mut command = Command::new(&runtime.bun);
    command
        .arg(&runtime.cli_ts)
        .arg("ocr-local")
        .arg(&video_path)
        .current_dir(&runtime.scout_dir);

    let output = execution
        .output(&mut command)
        .await
        .context("failed to execute supervised Scout OCR")?;
    parse_ocr_output(
        output.status.success(),
        output.status.code(),
        &output.stdout,
        &output.stderr,
        &configured_ocr_model(),
    )
}

fn parse_ocr_output(
    success: bool,
    exit_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
    expected_model: &str,
) -> Result<OcrAnalysis> {
    if !success {
        let diagnostic = sanitize_diagnostic(&String::from_utf8_lossy(stderr));
        let status = exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by signal".to_string());
        anyhow::bail!("Scout OCR exited with status {status}: {diagnostic}");
    }

    let mut deserializer = serde_json::Deserializer::from_slice(stdout);
    let analysis = OcrAnalysis::deserialize(&mut deserializer)
        .map_err(|_| anyhow::anyhow!("Scout OCR stdout was not one valid JSON envelope"))?;
    deserializer
        .end()
        .map_err(|_| anyhow::anyhow!("Scout OCR stdout contained extra non-whitespace output"))?;
    validate_analysis(&analysis, expected_model)?;
    Ok(analysis)
}

fn validate_analysis(analysis: &OcrAnalysis, expected_model: &str) -> Result<()> {
    if analysis.ocr_status != OcrStatus::Analyzed {
        let code = analysis
            .error_code
            .as_deref()
            .map(sanitize_diagnostic)
            .unwrap_or_else(|| "unknown_failure".to_string());
        let message = analysis
            .error_message
            .as_deref()
            .map(sanitize_diagnostic)
            .unwrap_or_else(|| "OCR analysis did not complete".to_string());
        anyhow::bail!("Scout OCR returned failed status ({code}): {message}");
    }
    if analysis.schema_version != OCR_SCHEMA_VERSION {
        anyhow::bail!("Scout OCR returned an unsupported schema version");
    }
    if analysis.provider != "novita" {
        anyhow::bail!("Scout OCR returned an unsupported provider");
    }
    if analysis.model != expected_model {
        anyhow::bail!("Scout OCR returned an unsupported model");
    }
    if analysis.analyzer_version != OCR_ANALYZER_VERSION {
        anyhow::bail!("Scout OCR returned an unsupported analyzer version");
    }
    if analysis.requested_frames == 0 || analysis.valid_frames != analysis.requested_frames {
        anyhow::bail!("Scout OCR returned incomplete frame coverage");
    }
    if chrono::DateTime::parse_from_rfc3339(&analysis.analyzed_at).is_err() {
        anyhow::bail!("Scout OCR returned a malformed analyzed_at timestamp");
    }
    let projected = context_from_analysis(analysis)?;
    validate_main_ocr_for_model(&projected, expected_model)
        .context("Scout OCR returned malformed directives")
}

fn context_from_analysis(analysis: &OcrAnalysis) -> Result<MainContext> {
    let verdict = analysis
        .verdict
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("analyzed Scout OCR envelope omitted its verdict"))?;
    Ok(MainContext {
        ocr: OcrMetadata {
            ocr_schema_version: analysis.schema_version,
            ocr_status: Some(analysis.ocr_status),
            ocr_model: analysis.model.clone(),
            ocr_analyzer_version: analysis.analyzer_version.clone(),
            ocr_analyzed_at: analysis.analyzed_at.clone(),
            ocr_requested_frames: analysis.requested_frames,
            ocr_valid_frames: analysis.valid_frames,
            ocr_outcome: verdict.outcome.clone(),
        },
        trim_start: verdict.trim_start,
        mute_audio: verdict.mute_audio,
        subtitle_blur: verdict.subtitle_blur.clone(),
        ..MainContext::default()
    })
}

pub fn source_fingerprint(video_path: &Path) -> Result<String> {
    let metadata = fs::metadata(video_path)
        .with_context(|| format!("could not inspect OCR source {}", video_path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("OCR source is not a regular file");
    }
    let modified = metadata
        .modified()
        .context("OCR source has no modification timestamp")?
        .duration_since(UNIX_EPOCH)
        .context("OCR source modification timestamp predates the Unix epoch")?;
    let identity = format!(
        "ocr-source-v1:{}:{}:{}",
        metadata.len(),
        modified.as_secs(),
        modified.subsec_nanos()
    );
    Ok(format!("md5:{:x}", md5::compute(identity.as_bytes())))
}

pub fn apply_analysis(context: &mut MainContext, analysis: &OcrAnalysis) -> Result<()> {
    validate_analysis(analysis, &configured_ocr_model())?;
    let projected = context_from_analysis(analysis)?;
    context.ocr = projected.ocr;
    context.trim_start = projected.trim_start;
    context.mute_audio = projected.mute_audio;
    context.subtitle_blur = projected.subtitle_blur;
    Ok(())
}

pub fn apply_analysis_for_source(
    context: &mut MainContext,
    analysis: &OcrAnalysis,
    source_fingerprint: &str,
) -> Result<()> {
    apply_analysis(context, analysis)?;
    context.ocr_source_fingerprint = source_fingerprint.to_string();
    Ok(())
}

pub fn load_main_context_for_ocr(base_dir: &Path) -> Result<MainContext> {
    let path = base_dir.join(MAIN_CONTEXT_FILE);
    match fs::read(&path) {
        Ok(raw) => serde_json::from_slice(&raw)
            .with_context(|| format!("failed to parse {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(MainContext::default()),
        Err(error) => Err(error).with_context(|| format!("failed to read {}", path.display())),
    }
}

pub fn save_main_context_atomic(base_dir: &Path, context: &MainContext) -> Result<()> {
    fs::create_dir_all(base_dir)
        .with_context(|| format!("failed to create context directory {}", base_dir.display()))?;
    let destination = base_dir.join(MAIN_CONTEXT_FILE);
    let temporary = base_dir.join(format!(".{MAIN_CONTEXT_FILE}.{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("failed to create {}", temporary.display()))?;
        serde_json::to_writer_pretty(&mut file, context)
            .context("failed to serialize main content context")?;
        file.write_all(b"\n")
            .context("failed to finish main content context")?;
        file.flush()
            .context("failed to flush main content context")?;
        file.sync_all()
            .context("failed to sync main content context")?;
        drop(file);

        atomic_replace(&temporary, &destination).with_context(|| {
            format!(
                "failed to atomically replace {} with {}",
                destination.display(),
                temporary.display()
            )
        })?;

        #[cfg(unix)]
        fs::File::open(base_dir)
            .and_then(|directory| directory.sync_all())
            .with_context(|| format!("failed to sync context directory {}", base_dir.display()))?;
        Ok(())
    })();

    if result.is_err() {
        match fs::remove_file(&temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {}
        }
    }
    result
}

#[cfg(unix)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination).map_err(Into::into)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}

fn sanitize_diagnostic(value: &str) -> String {
    const MAX_DIAGNOSTIC_CHARS: usize = 4_096;
    let bounded = value.chars().take(MAX_DIAGNOSTIC_CHARS).collect::<String>();
    let without_urls = redact_urls(&bounded);
    let mut sanitized = without_urls
        .lines()
        .map(redact_header_value)
        .collect::<Vec<_>>()
        .join("\n");
    for marker in [
        "Bearer",
        "THOTH_NOVITA_API_KEY",
        "THOTH_OPENROUTER_API_KEY",
        "NOVITA_API_KEY",
        "OPENROUTER_API_KEY",
    ] {
        sanitized = redact_after_marker(&sanitized, marker);
    }
    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        "no diagnostic output".to_string()
    } else {
        sanitized.to_string()
    }
}

fn redact_urls(value: &str) -> String {
    let mut result = value.to_string();
    let mut search_from = 0;
    loop {
        let lower = result.to_ascii_lowercase();
        let remaining = &lower[search_from..];
        let http = remaining.find("http://");
        let https = remaining.find("https://");
        let Some(relative_start) = [http, https].into_iter().flatten().min() else {
            break;
        };
        let url_start = search_from + relative_start;
        let mut url_end = url_start;
        while let Some(character) = result[url_end..].chars().next() {
            if character.is_whitespace()
                || matches!(
                    character,
                    '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}'
                )
            {
                break;
            }
            url_end += character.len_utf8();
        }
        result.replace_range(url_start..url_end, "[REDACTED_URL]");
        search_from = url_start + "[REDACTED_URL]".len();
    }
    result
}

fn redact_header_value(line: &str) -> String {
    let mut search_from = 0;
    while let Some(relative_colon) = line[search_from..].find(':') {
        let colon = search_from + relative_colon;
        let bytes = line.as_bytes();
        let mut token_end = colon;
        while token_end > 0 && bytes[token_end - 1].is_ascii_whitespace() {
            token_end -= 1;
        }
        let mut token_start = token_end;
        while token_start > 0 && is_header_name_byte(bytes[token_start - 1]) {
            token_start -= 1;
        }
        if token_start == token_end {
            search_from = colon + 1;
            continue;
        }

        let boundary_is_safe = token_start == 0 || bytes[token_start - 1].is_ascii_whitespace();
        let prefix_is_only_whitespace = line[..token_start].trim().is_empty();
        let token = line[token_start..token_end].to_ascii_lowercase();
        let token_is_sensitive = token.contains('-')
            || [
                "authorization",
                "cookie",
                "token",
                "key",
                "secret",
                "credential",
                "session",
            ]
            .iter()
            .any(|marker| token.contains(marker));
        if boundary_is_safe && (prefix_is_only_whitespace || token_is_sensitive) {
            let mut redacted = line[..colon + 1].to_string();
            redacted.push_str(" [REDACTED_HEADER_VALUE]");
            return redacted;
        }
        search_from = colon + 1;
    }
    line.to_string()
}

fn is_header_name_byte(value: u8) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_')
}

fn redact_after_marker(value: &str, marker: &str) -> String {
    let marker_lower = marker.to_ascii_lowercase();
    let mut result = value.to_string();
    let mut search_from = 0;
    loop {
        let lower = result.to_ascii_lowercase();
        let Some(relative_start) = lower[search_from..].find(&marker_lower) else {
            break;
        };
        let marker_start = search_from + relative_start;
        let mut secret_start = marker_start + marker.len();
        while let Some(character) = result[secret_start..].chars().next() {
            if character.is_whitespace() || character == '=' || character == ':' {
                secret_start += character.len_utf8();
            } else {
                break;
            }
        }
        let mut secret_end = secret_start;
        while let Some(character) = result[secret_end..].chars().next() {
            if character.is_whitespace()
                || matches!(character, '"' | '\'' | ',' | ';' | ')' | ']' | '}')
            {
                break;
            }
            secret_end += character.len_utf8();
        }
        if secret_end > secret_start {
            result.replace_range(secret_start..secret_end, "[REDACTED]");
            search_from = secret_start + "[REDACTED]".len();
        } else {
            search_from = marker_start + marker.len();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use crate::ingest::content_search::{
        DEFAULT_OCR_MODEL, Discourse, Dossier, Figure, MainContext, OCR_ANALYZER_VERSION,
        OCR_SCHEMA_VERSION, OcrStatus, Reference, SubtitleBlur,
    };

    use super::*;

    fn analyzed_json(
        schema_version: u32,
        model: &str,
        analyzer_version: &str,
        outcome: &str,
    ) -> String {
        let (trim_start, mute_audio, subtitle_blur) = match outcome {
            "clean" => (0.0, false, "[]"),
            "cover" => (3.5, false, "[]"),
            "subtitle" => (
                1.25,
                true,
                r#"[{"x":0.1,"y":0.7,"w":0.8,"h":0.1,"start":0.0,"end":2.0}]"#,
            ),
            _ => panic!("unsupported test outcome"),
        };
        format!(
            r#"{{"schema_version":{schema_version},"ocr_status":"analyzed","provider":"novita","model":"{model}","analyzer_version":"{analyzer_version}","requested_frames":4,"valid_frames":4,"analyzed_at":"2026-07-23T00:00:00Z","verdict":{{"outcome":"{outcome}","trim_start":{trim_start},"mute_audio":{mute_audio},"subtitle_blur":{subtitle_blur}}}}}"#
        )
    }

    fn parse_success(stdout: &str) -> anyhow::Result<OcrAnalysis> {
        parse_ocr_output(true, Some(0), stdout.as_bytes(), b"", DEFAULT_OCR_MODEL)
    }

    #[test]
    fn valid_analyzed_stdout_parses() {
        let analysis = parse_success(&analyzed_json(
            OCR_SCHEMA_VERSION,
            DEFAULT_OCR_MODEL,
            OCR_ANALYZER_VERSION,
            "clean",
        ))
        .unwrap();

        assert_eq!(analysis.schema_version, OCR_SCHEMA_VERSION);
        assert_eq!(analysis.ocr_status, OcrStatus::Analyzed);
        assert_eq!(analysis.model, DEFAULT_OCR_MODEL);
        assert_eq!(analysis.analyzer_version, OCR_ANALYZER_VERSION);
        assert_eq!(analysis.requested_frames, 4);
        assert_eq!(analysis.valid_frames, 4);
        assert_eq!(analysis.verdict.as_ref().unwrap().outcome, "clean");
    }

    #[test]
    fn failed_status_is_rejected_even_with_zero_exit() {
        let stdout = format!(
            r#"{{"schema_version":1,"ocr_status":"failed","provider":"novita","model":"{DEFAULT_OCR_MODEL}","analyzer_version":"{OCR_ANALYZER_VERSION}","requested_frames":4,"valid_frames":3,"analyzed_at":"2026-07-23T00:00:00Z","error_code":"coverage","error_message":"incomplete"}}"#
        );

        let error = parse_success(&stdout).unwrap_err().to_string();
        assert!(error.contains("failed"));
    }

    #[test]
    fn zero_exit_with_invalid_or_extra_json_is_rejected() {
        assert!(parse_success("not-json").is_err());
        let valid = analyzed_json(
            OCR_SCHEMA_VERSION,
            DEFAULT_OCR_MODEL,
            OCR_ANALYZER_VERSION,
            "clean",
        );
        assert!(parse_success(&format!("{valid}\n{{}}")).is_err());
        assert!(parse_success(&format!("diagnostic\n{valid}")).is_err());
    }

    #[test]
    fn malformed_stdout_never_echoes_secret_values_through_error_sources() {
        let stdout = analyzed_json(
            OCR_SCHEMA_VERSION,
            DEFAULT_OCR_MODEL,
            OCR_ANALYZER_VERSION,
            "clean",
        )
        .replace(
            r#""ocr_status":"analyzed""#,
            r#""ocr_status":"Bearer private-stdout-token""#,
        );

        let error = parse_success(&stdout).unwrap_err();
        let error_chain = format!("{error:#}");
        assert!(!error_chain.contains("private-stdout-token"));
        assert!(!error_chain.contains("Bearer"));
    }

    #[test]
    fn unsupported_schema_model_analyzer_and_provider_are_rejected() {
        let cases = [
            analyzed_json(
                OCR_SCHEMA_VERSION + 1,
                DEFAULT_OCR_MODEL,
                OCR_ANALYZER_VERSION,
                "clean",
            ),
            analyzed_json(
                OCR_SCHEMA_VERSION,
                "different/model",
                OCR_ANALYZER_VERSION,
                "clean",
            ),
            analyzed_json(
                OCR_SCHEMA_VERSION,
                DEFAULT_OCR_MODEL,
                "older-analyzer",
                "clean",
            ),
            analyzed_json(
                OCR_SCHEMA_VERSION,
                DEFAULT_OCR_MODEL,
                OCR_ANALYZER_VERSION,
                "clean",
            )
            .replace(r#""provider":"novita""#, r#""provider":"other""#),
        ];

        for stdout in cases {
            assert!(parse_success(&stdout).is_err(), "accepted {stdout}");
        }
    }

    #[test]
    fn nonzero_exit_reports_sanitized_stderr_without_bearer_token() {
        let error = parse_ocr_output(
            false,
            Some(17),
            b"",
            b"request failed: Authorization: Bearer private-token-123\nTHOTH_NOVITA_API_KEY=also-secret\nretry exhausted",
            DEFAULT_OCR_MODEL,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("17"));
        assert!(error.contains("retry exhausted"));
        assert!(!error.contains("private-token-123"));
        assert!(!error.contains("also-secret"));
        assert!(!error.to_ascii_lowercase().contains("bearer private"));
    }

    #[test]
    fn nonzero_exit_redacts_headers_cookies_and_private_urls() {
        let error = parse_ocr_output(
            false,
            Some(17),
            b"",
            b"Authorization: Basic basic-secret\nSet-Cookie: session=cookie-secret; HttpOnly\nX-Private-Diagnostic: arbitrary-header-secret\nupstream HTTP 401 at https://private.example.test/path?token=query-secret\nretry exhausted",
            DEFAULT_OCR_MODEL,
        )
        .unwrap_err();
        let error_chain = format!("{error:#}");

        for secret in [
            "basic-secret",
            "cookie-secret",
            "arbitrary-header-secret",
            "query-secret",
            "private.example.test",
        ] {
            assert!(!error_chain.contains(secret), "leaked {secret}");
        }
        assert!(!error_chain.contains("https://"));
        assert!(error_chain.contains("17"));
        assert!(error_chain.contains("401"));
        assert!(error_chain.contains("retry exhausted"));
    }

    #[test]
    fn failed_envelope_redacts_headers_and_urls_but_keeps_safe_failure_code() {
        let stdout = format!(
            r#"{{"schema_version":1,"ocr_status":"failed","provider":"novita","model":"{DEFAULT_OCR_MODEL}","analyzer_version":"{OCR_ANALYZER_VERSION}","requested_frames":4,"valid_frames":3,"analyzed_at":"2026-07-23T00:00:00Z","error_code":"provider_http_401","error_message":"Authorization: Basic envelope-basic-secret\nSet-Cookie: session=envelope-cookie-secret\nX-Private-Diagnostic: envelope-header-secret\nhttps://private.example.test/path?api_key=envelope-query-secret"}}"#
        );

        let error = parse_success(&stdout).unwrap_err();
        let error_chain = format!("{error:#}");
        for secret in [
            "envelope-basic-secret",
            "envelope-cookie-secret",
            "envelope-header-secret",
            "envelope-query-secret",
            "private.example.test",
        ] {
            assert!(!error_chain.contains(secret), "leaked {secret}");
        }
        assert!(!error_chain.contains("https://"));
        assert!(error_chain.contains("provider_http_401"));
    }

    #[test]
    fn source_fingerprint_changes_when_file_identity_changes() {
        let dir = temp_dir("fingerprint");
        let video = dir.join("video.mp4");
        fs::write(&video, b"first").unwrap();
        let first = source_fingerprint(&video).unwrap();

        let mut file = fs::OpenOptions::new().append(true).open(&video).unwrap();
        file.write_all(b"-longer").unwrap();
        file.sync_all().unwrap();
        let second = source_fingerprint(&video).unwrap();

        assert_ne!(first, second);
        assert!(!first.contains(video.to_string_lossy().as_ref()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn applying_analysis_overwrites_stale_directives_and_metadata() {
        let analysis = parse_success(&analyzed_json(
            OCR_SCHEMA_VERSION,
            DEFAULT_OCR_MODEL,
            OCR_ANALYZER_VERSION,
            "subtitle",
        ))
        .unwrap();
        let mut context = MainContext {
            trim_start: 99.0,
            mute_audio: false,
            subtitle_blur: vec![SubtitleBlur {
                x: 0.0,
                y: 0.0,
                w: 0.1,
                h: 0.1,
                start: 9.0,
                end: 10.0,
            }],
            ..MainContext::default()
        };
        context.ocr.ocr_model = "stale/model".into();

        apply_analysis(&mut context, &analysis).unwrap();

        assert_eq!(context.ocr.ocr_status, Some(OcrStatus::Analyzed));
        assert_eq!(context.ocr.ocr_schema_version, OCR_SCHEMA_VERSION);
        assert_eq!(context.ocr.ocr_model, DEFAULT_OCR_MODEL);
        assert_eq!(context.ocr.ocr_analyzer_version, OCR_ANALYZER_VERSION);
        assert_eq!(context.ocr.ocr_requested_frames, 4);
        assert_eq!(context.ocr.ocr_valid_frames, 4);
        assert_eq!(context.ocr.ocr_outcome, "subtitle");
        assert_eq!(context.trim_start, 1.25);
        assert!(context.mute_audio);
        assert_eq!(context.subtitle_blur.len(), 1);
        assert_eq!(context.subtitle_blur[0].x, 0.1);
    }

    #[test]
    fn atomic_save_preserves_narration_grounding_fields() {
        let dir = temp_dir("sidecar");
        let context = MainContext {
            title: "Grounded title".into(),
            description: "Grounded description".into(),
            figures: vec![Figure {
                name: "Subject".into(),
                kind: "person".into(),
                role: "Role".into(),
                description: "Known subject".into(),
            }],
            references: vec![Reference {
                term: "Reference".into(),
                kind: "event".into(),
                summary: "Verified context".into(),
                as_of_date: "2026-07".into(),
                source_url: "https://example.test/source".into(),
            }],
            discourse: Discourse {
                audience_stance: "supportive".into(),
                themes: vec!["theme".into()],
                narration_guidance: "stay factual".into(),
                trends: vec!["trend".into()],
            },
            dossier: Dossier {
                topic: "Topic".into(),
                entities: vec![],
                relations: vec!["A -> B".into()],
                angles: vec!["angle".into()],
                timeline: vec!["event".into()],
            },
            ..MainContext::default()
        };

        save_main_context_atomic(&dir, &MainContext::default()).unwrap();
        save_main_context_atomic(&dir, &context).unwrap();
        let saved = load_main_context_for_ocr(&dir).unwrap();

        assert_eq!(saved.title, context.title);
        assert_eq!(saved.description, context.description);
        assert_eq!(saved.figures[0].name, "Subject");
        assert_eq!(saved.references[0].summary, "Verified context");
        assert_eq!(saved.discourse.narration_guidance, "stay factual");
        assert_eq!(saved.dossier.relations, vec!["A -> B"]);
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn context_loader_defaults_only_when_sidecar_is_absent() {
        let dir = temp_dir("load-context");
        assert_eq!(load_main_context_for_ocr(&dir).unwrap().title, "");

        fs::write(dir.join("content_context.json"), b"{broken").unwrap();
        assert!(load_main_context_for_ocr(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scout_directory_resolution_supports_binary_and_cwd_layouts() {
        let root = temp_dir("scout-runtime");
        let scout = root.join("scout");
        fs::create_dir_all(&scout).unwrap();
        fs::write(scout.join("cli.ts"), b"").unwrap();

        let release_exe = root.join("target").join("release").join("thoth.exe");
        assert_eq!(
            resolve_scout_dir_from(Some(&release_exe), &root).unwrap(),
            scout
        );

        let unrelated_exe = root.join("bin").join("thoth.exe");
        assert_eq!(
            resolve_scout_dir_from(Some(&unrelated_exe), &root).unwrap(),
            root.join("scout")
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("thoth-ocr-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
