//! Scout orchestration: a single-slot supervisor for the interactive
//! `bun scout/cli.ts <cmd>` discovery pipeline. One child at a time (mirrors the
//! single browser tab). In-memory only — the durable artifact is the content-set
//! JSON scout writes under `scout/output/`. See
//! docs/superpowers/specs/2026-07-14-scout-orchestration-design.md.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};

pub const SCOUT_CLI: &str = "scout/cli.ts";
pub const SCOUT_OUTPUT_DIR: &str = "scout/output";
pub const DEFAULT_CONTENT_SET: &str = "scout/output/thoth_content_set.json";
pub const TOPICS_FILE: &str = "scout/output/reel_topics.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScoutKind { Browser, Discover, Run, Validate }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScoutStatus { Idle, Running, Done, Failed }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream { Out, Err }

#[derive(Clone, Debug, Serialize)]
pub struct LogLine { pub seq: u64, pub stream: Stream, pub text: String }

/// Signals the supervising task to kill the child (cancel).
#[derive(Default, Deserialize)]
pub struct DiscoverReq {
    #[serde(default)] pub max_per: Option<u32>,
    #[serde(default)] pub hours: Option<u32>,
    #[serde(default)] pub include: Option<String>,
    #[serde(default)] pub tiktok: bool,
}

#[derive(Default, Deserialize)]
pub struct RunReq {
    #[serde(default)] pub url: String,
    #[serde(default)] pub out: Option<String>,
    #[serde(default)] pub per: Option<u32>,
    #[serde(default)] pub max: Option<u32>,
    #[serde(default)] pub cap: Option<u32>,
    #[serde(default)] pub no_comments: bool,
}

#[derive(Default, Deserialize)]
pub struct ValidateReq {
    #[serde(default)] pub set: String,
}

pub struct ScoutRun {
    pub kind: Option<ScoutKind>,
    pub status: ScoutStatus,
    pub lines: Vec<LogLine>,
    pub next_seq: u64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub last_content_set: Option<PathBuf>,
    pub cancel: Option<Arc<Notify>>,
}

pub type ScoutSupervisor = Arc<Mutex<ScoutRun>>;

pub fn new_supervisor() -> ScoutSupervisor { Arc::new(Mutex::new(ScoutRun::new())) }

fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }

impl ScoutRun {
    pub fn new() -> Self {
        ScoutRun {
            kind: None, status: ScoutStatus::Idle, lines: Vec::new(), next_seq: 0,
            started_at: None, finished_at: None, exit_code: None,
            last_content_set: None, cancel: None,
        }
    }

    /// Single-slot transition. Err(()) == Busy (a run is already Running).
    /// Resets the ephemeral run state (NOT `last_content_set`, which must survive
    /// a subsequent discover/validate so /content-set still points at the last run).
    pub fn try_begin(&mut self, kind: ScoutKind) -> Result<Arc<Notify>, ()> {
        if self.status == ScoutStatus::Running { return Err(()); }
        self.kind = Some(kind);
        self.status = ScoutStatus::Running;
        self.lines.clear();
        self.next_seq = 0;
        self.started_at = Some(now_ms());
        self.finished_at = None;
        self.exit_code = None;
        let notify = Arc::new(Notify::new());
        self.cancel = Some(notify.clone());
        Ok(notify)
    }

    pub fn push_line(&mut self, stream: Stream, text: String) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.lines.push(LogLine { seq, stream, text });
    }

    pub fn finish(&mut self, exit_code: Option<i32>) {
        self.status = if exit_code == Some(0) { ScoutStatus::Done } else { ScoutStatus::Failed };
        self.exit_code = exit_code;
        self.finished_at = Some(now_ms());
        self.cancel = None;
    }

    /// `run` field of GET /api/scout/status; Null when never started.
    pub fn status_dto(&self) -> serde_json::Value {
        let Some(kind) = self.kind else { return serde_json::Value::Null; };
        serde_json::json!({
            "kind": kind,
            "status": self.status,
            "started_at": self.started_at,
            "exit_code": self.exit_code,
        })
    }
}

impl Default for ScoutRun { fn default() -> Self { Self::new() } }

fn push_opt(args: &mut Vec<String>, flag: &str, val: &Option<impl ToString>) {
    if let Some(v) = val { args.push(flag.into()); args.push(v.to_string()); }
}

/// Build the argv AFTER `scout/cli.ts` for a command. Unset options are omitted
/// so scout's own defaults apply (mirrors thoth-core push_params).
pub fn build_scout_args(
    kind: ScoutKind,
    disc: Option<&DiscoverReq>,
    run: Option<&RunReq>,
    val: Option<&ValidateReq>,
) -> Vec<String> {
    match kind {
        ScoutKind::Browser => vec!["browser".into(), "start".into()],
        ScoutKind::Discover => {
            let mut a = vec!["discover".to_string()];
            if let Some(d) = disc {
                push_opt(&mut a, "--max-per", &d.max_per);
                push_opt(&mut a, "--hours", &d.hours);
                push_opt(&mut a, "--include", &d.include);
                if d.tiktok { a.push("--tiktok".into()); }
            }
            a
        }
        ScoutKind::Run => {
            let mut a = vec!["run".to_string()];
            if let Some(r) = run {
                a.push(r.url.clone());
                push_opt(&mut a, "--out", &r.out);
                push_opt(&mut a, "--per", &r.per);
                push_opt(&mut a, "--max", &r.max);
                push_opt(&mut a, "--cap", &r.cap);
                if r.no_comments { a.push("--no-comments".into()); }
            }
            a
        }
        ScoutKind::Validate => {
            let mut a = vec!["validate".to_string()];
            if let Some(v) = val { a.push(v.set.clone()); }
            a
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_browser_start() {
        assert_eq!(build_scout_args(ScoutKind::Browser, None, None, None),
                   vec!["browser", "start"]);
    }

    #[test]
    fn args_discover_all_flags() {
        let d = DiscoverReq { max_per: Some(48), hours: Some(24),
            include: Some("h1,h2".into()), tiktok: true };
        assert_eq!(build_scout_args(ScoutKind::Discover, Some(&d), None, None),
            vec!["discover", "--max-per", "48", "--hours", "24",
                 "--include", "h1,h2", "--tiktok"]);
    }

    #[test]
    fn args_discover_defaults_omitted() {
        let d = DiscoverReq::default();
        assert_eq!(build_scout_args(ScoutKind::Discover, Some(&d), None, None),
                   vec!["discover"]);
    }

    #[test]
    fn args_run_url_and_flags() {
        let r = RunReq { url: "https://x/1".into(), out: Some("s.json".into()),
            per: Some(2), max: Some(4), cap: Some(12), no_comments: true };
        assert_eq!(build_scout_args(ScoutKind::Run, None, Some(&r), None),
            vec!["run", "https://x/1", "--out", "s.json", "--per", "2",
                 "--max", "4", "--cap", "12", "--no-comments"]);
    }

    #[test]
    fn args_validate() {
        let v = ValidateReq { set: "scout/output/s.json".into() };
        assert_eq!(build_scout_args(ScoutKind::Validate, None, None, Some(&v)),
                   vec!["validate", "scout/output/s.json"]);
    }

    #[test]
    fn try_begin_rejects_when_running() {
        let mut run = ScoutRun::new();
        assert!(run.try_begin(ScoutKind::Discover).is_ok());
        assert_eq!(run.status, ScoutStatus::Running);
        // second begin while running -> Busy
        assert!(run.try_begin(ScoutKind::Run).is_err());
    }

    #[test]
    fn status_dto_null_when_idle() {
        assert_eq!(ScoutRun::new().status_dto(), serde_json::Value::Null);
    }

    #[test]
    fn status_dto_shape_when_running() {
        let mut run = ScoutRun::new();
        run.try_begin(ScoutKind::Discover).unwrap();
        let v = run.status_dto();
        assert_eq!(v["kind"], "discover");
        assert_eq!(v["status"], "running");
        assert!(v["started_at"].is_i64());
        assert!(v["exit_code"].is_null());
    }
}
