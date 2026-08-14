//! Scout orchestration: a single-slot supervisor for the interactive
//! `bun scout/cli.ts <cmd>` discovery pipeline. One child at a time (mirrors the
//! single browser tab). In-memory only — the durable artifact is the content-set
//! JSON scout writes under `scout/output/`. See
//! docs/superpowers/specs/2026-07-14-scout-orchestration-design.md.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
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
    #[serde(default)] pub use_input_as_main: bool,
    #[serde(default)] pub main_coverage_target: Option<f64>,
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
    /// Signals the supervising task to kill the child (cancel).
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
                if r.use_input_as_main { a.push("--use-input-as-main".into()); }
                push_opt(&mut a, "--main-coverage-target", &r.main_coverage_target);
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

pub fn cdp_base() -> String {
    std::env::var("THOTH_CDP").unwrap_or_else(|_| "http://127.0.0.1:18800".to_string())
}

/// TCP-liveness probe of the CDP port.
/// ponytail: port-open check, not a full `GET /json/version` — upgrade to an HTTP
/// probe only if a listening-but-not-ready browser produces false positives.
pub async fn cdp_attached() -> bool {
    let base = cdp_base();
    let hostport = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
        .unwrap_or(&base)
        .trim_end_matches('/')
        .to_string();
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(hostport),
        ).await,
        Ok(Ok(_))
    )
}

/// Resolve the content-set path a `run` produces. Relative names land in
/// `scout/output/` (matching scout's outPath()); absolute paths are honored.
pub fn resolve_content_set(out: Option<&str>) -> PathBuf {
    match out {
        None => PathBuf::from(DEFAULT_CONTENT_SET),
        Some(o) => {
            let p = PathBuf::from(o);
            if p.is_absolute() { p } else { PathBuf::from(SCOUT_OUTPUT_DIR).join(o) }
        }
    }
}

async fn read_pipe<R>(sup: ScoutSupervisor, reader: R, stream: Stream)
where R: tokio::io::AsyncRead + Unpin {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        sup.lock().await.push_line(stream, line);
    }
}

/// Spawn `program args`, stream both pipes into the run, and wait for exit or
/// cancel. Assumes the caller already `try_begin`'d the slot. Records a Failed
/// run (with the error text) if the process can't be spawned.
pub async fn spawn_command(sup: &ScoutSupervisor, program: &str, args: Vec<String>) {
    let cancel = { sup.lock().await.cancel.clone() };
    let mut cmd = Command::new(program);
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // On Unix, make the child lead its own process group (pgid == pid) so cancel
    // can kill the whole group in one signal — the grandchild pipeline and its
    // descendants (ffmpeg/whisper) inherit the group. On Windows `taskkill /T`
    // walks the tree instead, so no group is needed there.
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let mut run = sup.lock().await;
            run.push_line(Stream::Err, format!("spawn failed: {program}: {e}"));
            run.finish(Some(-1));
            return;
        }
    };

    let child_pid = child.id(); // captured for tree-kill on cancel (grandchild)
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();
    if let Some(o) = stdout { readers.push(tokio::spawn(read_pipe(sup.clone(), o, Stream::Out))); }
    if let Some(e) = stderr { readers.push(tokio::spawn(read_pipe(sup.clone(), e, Stream::Err))); }

    let exit_code: Option<i32> = if let Some(notify) = cancel {
        tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = notify.notified() => {
                // Kill the tree FIRST (while parent links are intact), then reap
                // the dispatcher. child.kill() only hits `bun scout/cli.ts`; the
                // real pipeline runs in a grandchild it spawned via
                // spawnSync(stdio:'inherit') (scout/cli.ts:65), so we must kill
                // the tree or the grandchild keeps driving the browser tab and
                // holding the pipe write-end open.
                if let Some(pid) = child_pid { kill_tree(pid).await; }
                let _ = child.kill().await;
                let _ = child.wait().await;
                { sup.lock().await.push_line(Stream::Err, "cancelled".into()); }
                Some(-1)
            }
        }
    } else {
        child.wait().await.ok().and_then(|s| s.code())
    };

    // Bound the drain: a killed grandchild may briefly still hold the pipe
    // write-end, so an unbounded `r.await` could never see EOF and finish()
    // would never run — wedging the single slot Running forever. The timeout
    // guarantees the slot is always freed.
    for r in readers {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), r).await;
    }
    sup.lock().await.finish(exit_code);
}

/// Kill the whole process tree rooted at `pid`. Mirrors scout's own teardown
/// (`scout/lib/browser.ts:323` `taskkill /T /F`) — required because the scout
/// work runs in a grandchild that `child.kill()` cannot reach.
async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await;
    }
    #[cfg(not(windows))]
    {
        // The child leads its own process group (process_group(0) at spawn), so
        // the negative pgid signals the whole group — grandchild pipeline and
        // all its descendants die together, matching taskkill /T on Windows.
        let _ = Command::new("kill")
            .arg("-9")
            .arg(format!("-{pid}"))
            .output()
            .await;
    }
}

/// Begin a run (Err == Busy) then supervise it in a detached task (202 semantics).
pub async fn start(sup: &ScoutSupervisor, kind: ScoutKind, args_after_cli: Vec<String>)
    -> Result<(), ()>
{
    { sup.lock().await.try_begin(kind)?; }
    let mut argv = vec![SCOUT_CLI.to_string()];
    argv.extend(args_after_cli);
    let sup2 = sup.clone();
    tokio::spawn(async move { spawn_command(&sup2, "bun", argv).await; });
    Ok(())
}

/// Notify the current run to cancel. False if nothing is running.
pub async fn cancel(sup: &ScoutSupervisor) -> bool {
    let notify = { sup.lock().await.cancel.clone() };
    match notify { Some(n) => { n.notify_one(); true } None => false }
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
            per: Some(2), max: Some(4), cap: Some(12), no_comments: true,
            use_input_as_main: false, main_coverage_target: None };
        assert_eq!(build_scout_args(ScoutKind::Run, None, Some(&r), None),
            vec!["run", "https://x/1", "--out", "s.json", "--per", "2",
                 "--max", "4", "--cap", "12", "--no-comments"]);
    }

    #[test]
    fn args_run_forced_main_flags_are_opt_in() {
        let default = RunReq { url: "https://x/1".into(), ..Default::default() };
        assert_eq!(build_scout_args(ScoutKind::Run, None, Some(&default), None),
                   vec!["run", "https://x/1"]);

        let forced = RunReq {
            url: "https://x/1".into(),
            use_input_as_main: true,
            main_coverage_target: Some(0.75),
            ..Default::default()
        };
        assert_eq!(build_scout_args(ScoutKind::Run, None, Some(&forced), None),
                   vec!["run", "https://x/1", "--use-input-as-main",
                        "--main-coverage-target", "0.75"]);
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

    // A cross-platform "print two lines then exit 0" command.
    fn echo_cmd() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            ("cmd", vec!["/C".into(), "echo out1&& echo out2".into()])
        } else {
            ("sh", vec!["-c".into(), "echo out1; echo out2".into()])
        }
    }

    // A command that blocks long enough to be cancelled.
    fn sleep_cmd() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            ("cmd", vec!["/C".into(), "ping -n 30 127.0.0.1 > NUL".into()])
        } else {
            ("sh", vec!["-c".into(), "sleep 30".into()])
        }
    }

    #[tokio::test]
    async fn lifecycle_captures_lines_and_finishes_done() {
        let sup = new_supervisor();
        { sup.lock().await.try_begin(ScoutKind::Discover).unwrap(); }
        let (p, a) = echo_cmd();
        spawn_command(&sup, p, a).await;
        let run = sup.lock().await;
        assert_eq!(run.status, ScoutStatus::Done);
        assert_eq!(run.exit_code, Some(0));
        // monotonic seq, at least our two echoed lines
        let texts: Vec<_> = run.lines.iter().map(|l| l.text.trim().to_string()).collect();
        assert!(texts.iter().any(|t| t == "out1"));
        assert!(texts.iter().any(|t| t == "out2"));
        for (i, l) in run.lines.iter().enumerate() { assert_eq!(l.seq as usize, i); }
    }

    #[tokio::test]
    async fn cancel_kills_and_marks_failed() {
        let sup = new_supervisor();
        let notify = { sup.lock().await.try_begin(ScoutKind::Run).unwrap() };
        let (p, a) = sleep_cmd();
        let sup2 = sup.clone();
        let handle = tokio::spawn(async move { spawn_command(&sup2, p, a).await });
        // give it a moment to spawn, then cancel
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        notify.notify_one();
        handle.await.unwrap();
        assert_eq!(sup.lock().await.status, ScoutStatus::Failed);
    }

    #[tokio::test]
    async fn spawn_error_marks_failed() {
        let sup = new_supervisor();
        { sup.lock().await.try_begin(ScoutKind::Browser).unwrap(); }
        spawn_command(&sup, "definitely-not-a-real-binary-xyz", vec![]).await;
        let run = sup.lock().await;
        assert_eq!(run.status, ScoutStatus::Failed);
        assert!(run.lines.iter().any(|l| l.stream == Stream::Err));
    }

    #[tokio::test]
    async fn cdp_attached_false_on_dead_port() {
        // Nothing listens here.
        // ponytail: process-global env mutation, sound only because this is the
        // ONLY test that touches THOTH_CDP. If another test ever reads
        // cdp_base()/cdp_attached() concurrently, serialize them (e.g. serial_test).
        unsafe { std::env::set_var("THOTH_CDP", "http://127.0.0.1:1"); }
        assert!(!cdp_attached().await);
        unsafe { std::env::remove_var("THOTH_CDP"); }
    }
}
