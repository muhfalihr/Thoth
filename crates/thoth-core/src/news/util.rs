//! Shared utilities for the news module.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use crate::config::NewsConfig;

use super::error::NewsError;

/// Build a `tokio::process::Command` that runs `python <script> [args...]`,
/// routing through `conda run -n <env>` when `config.conda_env` is non-empty.
///
/// Example (conda):  `conda run -n thoth-news python scripts/foo.py --arg val`
/// Example (direct): `python scripts/foo.py --arg val`
pub fn python_command(config: &NewsConfig, script: &Path) -> Result<tokio::process::Command, NewsError> {
    if !script.exists() {
        return Err(NewsError::ScriptMissing(script.display().to_string()));
    }
    let mut cmd = if config.conda_env.is_empty() {
        let mut c = tokio::process::Command::new(&config.python_path);
        c.arg(script);
        c
    } else {
        let mut c = tokio::process::Command::new("conda");
        c.args(["run", "--no-capture-output", "-n", &config.conda_env, "python"]);
        c.arg(script);
        c
    };
    // Force UTF-8 I/O on Windows so cp1252 never chokes on Indonesian / emoji output.
    cmd.env("PYTHONIOENCODING", "utf-8")
       .env("PYTHONUTF8", "1");

    // Pass cookies file when configured (bypasses bot detection on sites like Kumparan).
    if !config.cookies_file.as_os_str().is_empty() && config.cookies_file.exists() {
        cmd.arg("--cookies").arg(&config.cookies_file);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    Ok(cmd)
}

/// Run a command and wait for it with a timeout, returning stdout as String.
/// Stderr is forwarded to tracing::warn on failure.
pub async fn run_command(
    mut cmd: tokio::process::Command,
    label: &str,
    timeout_secs: u64,
) -> Result<String, NewsError> {
    let child = cmd.spawn().map_err(|e| NewsError::Search(format!("{label}: spawn failed: {e}")))?;
    let grace = Duration::from_secs(timeout_secs + 10);
    let output = match tokio::time::timeout(grace, child.wait_with_output()).await {
        Ok(r) => r.map_err(NewsError::Io)?,
        Err(_) => return Err(NewsError::Search(format!("{label}: timed out after {}s", grace.as_secs()))),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(NewsError::Search(format!(
            "{label}: exited with {}: {}",
            output.status,
            stderr.trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
