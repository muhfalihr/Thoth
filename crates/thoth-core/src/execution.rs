use anyhow::Result;
use std::collections::HashMap;
use std::process::{ExitStatus, Output, Stdio};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
#[error("job cancelled")]
pub struct Cancelled;

#[derive(Clone)]
pub struct JobExecutionContext {
    cancellation: CancellationToken,
    registry: Arc<Mutex<Registry>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ChildKey {
    pid: u32,
    generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RegistryLifecycle {
    Accepting,
    Terminating,
}

struct Registry {
    lifecycle: RegistryLifecycle,
    next_generation: u64,
    children: HashMap<ChildKey, Arc<ChildControl>>,
}

struct ChildControl {
    cancel: CancellationToken,
    completed: CancellationToken,
}

impl JobExecutionContext {
    #[must_use]
    pub fn new() -> Self {
        Self {
            cancellation: CancellationToken::new(),
            registry: Arc::new(Mutex::new(Registry {
                lifecycle: RegistryLifecycle::Accepting,
                next_generation: 0,
                children: HashMap::new(),
            })),
        }
    }

    #[must_use]
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub fn check_cancelled(&self) -> Result<()> {
        if self.cancellation.is_cancelled() {
            Err(Cancelled.into())
        } else {
            Ok(())
        }
    }

    pub fn spawn(&self, command: &mut Command) -> Result<SupervisedChild> {
        self.check_cancelled()?;
        configure_process_group(command);
        command.kill_on_drop(true);

        // Spawning while holding this short synchronous lock makes closing the
        // registry linearizable: a spawn is either fully registered or rejected.
        let mut registry = lock_registry(&self.registry);
        if registry.lifecycle == RegistryLifecycle::Terminating {
            return Err(Cancelled.into());
        }
        let generation = allocate_generation(&mut registry.next_generation)?;

        #[cfg(windows)]
        let process_tree = WindowsJob::new()?;
        let mut child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| anyhow::anyhow!("spawned child has no process ID"))?;

        #[cfg(windows)]
        if let Err(error) = process_tree.assign(&child) {
            let _ = child.start_kill();
            return Err(error.context("could not assign spawned process to its owned Job Object"));
        }

        let key = ChildKey { pid, generation };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let control = Arc::new(ChildControl {
            cancel: CancellationToken::new(),
            completed: CancellationToken::new(),
        });
        registry.children.insert(key, Arc::clone(&control));
        drop(registry);

        let (result_tx, result_rx) = oneshot::channel();
        let registry = Arc::clone(&self.registry);
        let global_cancellation = self.cancellation.clone();
        let monitor_control = Arc::clone(&control);
        tokio::spawn(async move {
            let outcome = monitor_child(
                child,
                pid,
                global_cancellation,
                monitor_control.cancel.clone(),
                #[cfg(windows)]
                process_tree,
            )
            .await;
            remove_exact_child(&registry, key, &monitor_control);
            monitor_control.completed.cancel();
            let _ = result_tx.send(outcome);
        });

        Ok(SupervisedChild {
            pid,
            stdout,
            stderr,
            control,
            result: Some(result_rx),
        })
    }

    pub async fn output(&self, command: &mut Command) -> Result<Output> {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        self.spawn(command)?.output().await
    }

    pub async fn status(&self, command: &mut Command) -> Result<ExitStatus> {
        self.spawn(command)?.status().await
    }

    pub async fn terminate_all(&self) {
        let controls = {
            let mut registry = lock_registry(&self.registry);
            registry.lifecycle = RegistryLifecycle::Terminating;
            registry.children.values().cloned().collect::<Vec<_>>()
        };
        for control in &controls {
            control.cancel.cancel();
        }
        for control in controls {
            control.completed.cancelled().await;
        }
    }

    #[cfg(test)]
    fn active_child_count(&self) -> usize {
        lock_registry(&self.registry).children.len()
    }
}

impl Default for JobExecutionContext {
    fn default() -> Self {
        Self::new()
    }
}

pub struct SupervisedChild {
    pid: u32,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    control: Arc<ChildControl>,
    result: Option<oneshot::Receiver<Result<ExitStatus>>>,
}

impl SupervisedChild {
    #[must_use]
    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.stderr.take()
    }

    pub async fn output(mut self) -> Result<Output> {
        let mut stdout = self
            .take_stdout()
            .ok_or_else(|| anyhow::anyhow!("supervised child stdout is not piped"))?;
        let mut stderr = self
            .take_stderr()
            .ok_or_else(|| anyhow::anyhow!("supervised child stderr is not piped"))?;

        let read_stdout = async {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await?;
            std::io::Result::Ok(bytes)
        };
        let read_stderr = async {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await?;
            std::io::Result::Ok(bytes)
        };
        let (status, stdout, stderr) = tokio::join!(self.wait(), read_stdout, read_stderr);

        Ok(Output {
            status: status?,
            stdout: stdout?,
            stderr: stderr?,
        })
    }

    pub async fn status(self) -> Result<ExitStatus> {
        self.wait().await
    }

    pub async fn wait(mut self) -> Result<ExitStatus> {
        self.result
            .take()
            .expect("supervised child result receiver is present")
            .await
            .map_err(|_| anyhow::anyhow!("process monitor ended without an outcome"))?
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        self.control.cancel.cancel();
    }
}

async fn monitor_child(
    mut child: Child,
    pid: u32,
    global_cancellation: CancellationToken,
    local_cancellation: CancellationToken,
    #[cfg(windows)] process_tree: WindowsJob,
) -> Result<ExitStatus> {
    #[cfg(windows)]
    {
        monitor_windows_child(
            &mut child,
            pid,
            &process_tree,
            global_cancellation,
            local_cancellation,
        )
        .await
    }
    #[cfg(unix)]
    {
        monitor_unix_child(&mut child, pid, global_cancellation, local_cancellation).await
    }
}

#[cfg(windows)]
async fn monitor_windows_child(
    child: &mut Child,
    pid: u32,
    process_tree: &WindowsJob,
    global_cancellation: CancellationToken,
    local_cancellation: CancellationToken,
) -> Result<ExitStatus> {
    let root_status = tokio::select! {
        biased;
        () = global_cancellation.cancelled() => {
            return cancelled_after_cleanup(pid, cleanup_windows_tree(pid, process_tree, Some(child)).await);
        }
        () = local_cancellation.cancelled() => {
            return cancelled_after_cleanup(pid, cleanup_windows_tree(pid, process_tree, Some(child)).await);
        }
        status = child.wait() => status?,
    };

    // A root can exit while descendants remain. Keep the owned Job Object and
    // defer the normal outcome until the tree empties or cancellation wins.
    while process_tree.has_active_processes()? {
        tokio::select! {
            biased;
            () = global_cancellation.cancelled() => {
                return cancelled_after_cleanup(pid, cleanup_windows_tree(pid, process_tree, None).await);
            }
            () = local_cancellation.cancelled() => {
                return cancelled_after_cleanup(pid, cleanup_windows_tree(pid, process_tree, None).await);
            }
            () = tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
        }
    }
    Ok(root_status)
}

#[cfg(unix)]
async fn monitor_unix_child(
    child: &mut Child,
    pid: u32,
    global_cancellation: CancellationToken,
    local_cancellation: CancellationToken,
) -> Result<ExitStatus> {
    let root_status = tokio::select! {
        biased;
        () = global_cancellation.cancelled() => {
            return cancelled_after_cleanup(pid, cleanup_unix_tree(pid, Some(child)).await);
        }
        () = local_cancellation.cancelled() => {
            return cancelled_after_cleanup(pid, cleanup_unix_tree(pid, Some(child)).await);
        }
        status = child.wait() => status?,
    };

    while process_group_exists(pid) {
        tokio::select! {
            biased;
            () = global_cancellation.cancelled() => {
                return cancelled_after_cleanup(pid, cleanup_unix_tree(pid, None).await);
            }
            () = local_cancellation.cancelled() => {
                return cancelled_after_cleanup(pid, cleanup_unix_tree(pid, None).await);
            }
            () = tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
        }
    }
    Ok(root_status)
}

#[cfg(unix)]
async fn cleanup_unix_tree(pid: u32, child: Option<&mut Child>) -> Result<()> {
    let term = signal_process_group(pid, libc::SIGTERM);
    // The root handle is deliberately not waited or polled during this grace
    // period. That keeps the process-group identity reserved until final SIGKILL.
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    let kill = signal_process_group(pid, libc::SIGKILL);
    let wait = match child {
        Some(child) => child.wait().await.map(|_| ()).map_err(Into::into),
        None => Ok(()),
    };
    combine_cleanup_results([term, kill, wait])
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) -> Result<()> {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        anyhow::bail!("process ID does not fit platform pid_t");
    };
    // SAFETY: negative PIDs address the process group created at spawn, and `kill`
    // neither dereferences pointers nor transfers memory ownership.
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(());
    }
    {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error.into())
        }
    }
}

#[cfg(unix)]
fn process_group_exists(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal zero performs only an existence/permission check.
    if unsafe { libc::kill(-pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn lock_registry(registry: &Mutex<Registry>) -> std::sync::MutexGuard<'_, Registry> {
    registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn allocate_generation(next_generation: &mut u64) -> Result<u64> {
    let generation = *next_generation;
    *next_generation = next_generation
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("child generation counter exhausted"))?;
    Ok(generation)
}

fn remove_exact_child(registry: &Mutex<Registry>, key: ChildKey, expected: &Arc<ChildControl>) {
    let mut registry = lock_registry(registry);
    if registry
        .children
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, expected))
    {
        registry.children.remove(&key);
    }
}

fn combine_cleanup_results<const N: usize>(results: [Result<()>; N]) -> Result<()> {
    let failures = results
        .into_iter()
        .filter_map(Result::err)
        .map(|error| format!("{error:#}"))
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(failures.join("; "))
    }
}

fn cancelled_after_cleanup(pid: u32, cleanup: Result<()>) -> Result<ExitStatus> {
    match cleanup {
        Ok(()) => Err(Cancelled.into()),
        Err(error) => {
            tracing::warn!(pid, error = %error, "process-tree cleanup failed");
            Err(anyhow::Error::new(Cancelled)
                .context(format!("process-tree cleanup failed: {error:#}")))
        }
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.as_std_mut().process_group(0);
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command
        .as_std_mut()
        .creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[must_use]
pub fn is_cancelled(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<Cancelled>().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    struct ProcessGuard(u32);

    impl Drop for ProcessGuard {
        fn drop(&mut self) {
            #[cfg(windows)]
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.0.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            #[cfg(windows)]
            let _ = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "Stop-Process -Id {} -Force -ErrorAction SilentlyContinue",
                        self.0
                    ),
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();

            #[cfg(unix)]
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", self.0)])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    struct FileGuard(PathBuf);

    impl Drop for FileGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn cancelled_error_is_typed() {
        let context = JobExecutionContext::new();
        let token = context.cancellation_token();

        context.cancel();
        let error = match context.check_cancelled() {
            Ok(()) => panic!("cancelled context unexpectedly passed its cancellation check"),
            Err(error) => error,
        };

        assert!(token.is_cancelled());
        assert!(is_cancelled(&error));
        assert!(
            error
                .chain()
                .any(|cause| cause.downcast_ref::<Cancelled>().is_some())
        );
    }

    #[cfg(windows)]
    fn output_command() -> Command {
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-Command",
            "Write-Output 'hello'; [Console]::Error.WriteLine('warning')",
        ]);
        command
    }

    #[cfg(unix)]
    fn output_command() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'hello\\n'; printf 'warning\\n' >&2"]);
        command
    }

    #[tokio::test]
    async fn output_preserves_streams_and_success_status() -> Result<()> {
        let context = JobExecutionContext::new();
        let output = context.output(&mut output_command()).await?;

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "warning");
        Ok(())
    }

    const LARGE_PIPE_PAYLOAD: usize = 256 * 1024;

    #[cfg(windows)]
    fn large_output_command() -> Command {
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-Command",
            &format!(
                "[Console]::Out.Write('o' * {LARGE_PIPE_PAYLOAD}); \
                 [Console]::Error.Write('e' * {LARGE_PIPE_PAYLOAD})"
            ),
        ]);
        command
    }

    #[cfg(unix)]
    fn large_output_command() -> Command {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!(
                "head -c {LARGE_PIPE_PAYLOAD} /dev/zero | tr '\\0' o; \
                 head -c {LARGE_PIPE_PAYLOAD} /dev/zero | tr '\\0' e >&2"
            ),
        ]);
        command
    }

    #[tokio::test]
    async fn output_drains_payloads_larger_than_pipe_capacity() -> Result<()> {
        let context = JobExecutionContext::new();
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            context.output(&mut large_output_command()),
        )
        .await
        .map_err(|_| anyhow::anyhow!("large piped output deadlocked"))??;

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), LARGE_PIPE_PAYLOAD);
        assert_eq!(output.stderr.len(), LARGE_PIPE_PAYLOAD);
        assert!(output.stdout.iter().all(|byte| *byte == b'o'));
        assert!(output.stderr.iter().all(|byte| *byte == b'e'));
        Ok(())
    }

    #[cfg(windows)]
    fn streamed_command() -> Command {
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-Command",
            "Write-Output 'ready-output'; [Console]::Error.WriteLine('ready-error'); Start-Sleep 30",
        ]);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        command
    }

    #[cfg(unix)]
    fn streamed_command() -> Command {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "printf 'ready-output\\n'; printf 'ready-error\\n' >&2; sleep 30",
        ]);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        command
    }

    #[tokio::test]
    async fn streamed_pipes_remain_usable_with_supervised_wait() -> Result<()> {
        let context = JobExecutionContext::new();
        let mut child = context.spawn(&mut streamed_command())?;
        let _guard = ProcessGuard(child.id());
        let stdout = child
            .take_stdout()
            .ok_or_else(|| anyhow::anyhow!("streamed stdout missing"))?;
        let stderr = child
            .take_stderr()
            .ok_or_else(|| anyhow::anyhow!("streamed stderr missing"))?;
        assert!(child.take_stdout().is_none());
        assert!(child.take_stderr().is_none());

        let mut stdout_reader = BufReader::new(stdout);
        let mut stderr_reader = BufReader::new(stderr);
        let mut stdout_line = String::new();
        let mut stderr_line = String::new();
        let (stdout_read, stderr_read) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                stdout_reader.read_line(&mut stdout_line),
                stderr_reader.read_line(&mut stderr_line),
            )
        })
        .await
        .map_err(|_| anyhow::anyhow!("streamed lines timed out"))?;
        stdout_read?;
        stderr_read?;
        assert_eq!(stdout_line.trim(), "ready-output");
        assert_eq!(stderr_line.trim(), "ready-error");

        context.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .map_err(|_| anyhow::anyhow!("streamed wait cancellation timed out"))?;
        let error = match result {
            Ok(status) => anyhow::bail!("cancelled streamed child exited with {status}"),
            Err(error) => error,
        };
        assert!(is_cancelled(&error));
        Ok(())
    }

    #[cfg(windows)]
    fn long_running_command() -> Command {
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-Command", "Start-Sleep 30"]);
        command
    }

    #[cfg(windows)]
    fn parent_with_child_command(child_pid_path: &std::path::Path) -> Command {
        let script = format!(
            "$child = Start-Process powershell -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 30') -PassThru; \
             Set-Content -NoNewline -Path '{}' -Value $child.Id; Start-Sleep 30",
            child_pid_path.display()
        );
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-Command", &script]);
        command
    }

    #[cfg(windows)]
    fn exiting_root_with_child_command(child_pid_path: &std::path::Path) -> Command {
        let script = format!(
            "$child = Start-Process powershell -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 30') -PassThru; \
             Set-Content -NoNewline -Path '{}' -Value $child.Id; exit 0",
            child_pid_path.display()
        );
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-Command", &script]);
        command
    }

    #[cfg(unix)]
    fn parent_with_child_command(child_pid_path: &std::path::Path) -> Command {
        let script = format!("sleep 30 & echo $! > '{}'; wait", child_pid_path.display());
        let mut command = Command::new("sh");
        command.args(["-c", &script]);
        command
    }

    #[cfg(unix)]
    fn exiting_root_with_child_command(child_pid_path: &std::path::Path) -> Command {
        let script = format!(
            "sleep 30 & echo $! > '{}'; exit 0",
            child_pid_path.display()
        );
        let mut command = Command::new("sh");
        command.args(["-c", &script]);
        command
    }

    async fn read_child_pid(path: &std::path::Path) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(contents) = tokio::fs::read_to_string(path).await
                && let Ok(pid) = contents.trim().parse()
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "child PID file was not created");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[cfg(windows)]
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
                ),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    async fn assert_process_exits(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_is_alive(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(!process_is_alive(pid), "process {pid} is still alive");
    }

    #[cfg(unix)]
    fn long_running_command() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        command
    }

    #[tokio::test]
    async fn cancellation_terminates_a_long_lived_child_with_typed_error() -> Result<()> {
        let context = JobExecutionContext::new();
        let child = context.spawn(&mut long_running_command())?;
        let _guard = ProcessGuard(child.pid);
        let started = Instant::now();

        context.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), child.status())
            .await
            .map_err(|_| anyhow::anyhow!("cancelled child did not terminate within two seconds"))?;
        let error = match result {
            Ok(status) => anyhow::bail!("cancelled child unexpectedly exited with {status}"),
            Err(error) => error,
        };

        assert!(is_cancelled(&error));
        assert!(started.elapsed() < Duration::from_secs(2));
        Ok(())
    }

    #[tokio::test]
    async fn terminate_all_is_idempotent_and_clears_attempted_roots() -> Result<()> {
        let context = JobExecutionContext::new();
        let child = context.spawn(&mut long_running_command())?;
        let _guard = ProcessGuard(child.pid);
        assert_eq!(context.active_child_count(), 1);

        context.cancel();
        context.terminate_all().await;
        assert_eq!(context.active_child_count(), 0);

        context.terminate_all().await;
        assert_eq!(context.active_child_count(), 0);
        Ok(())
    }

    #[tokio::test]
    async fn cancellation_terminates_a_real_parent_and_child_process_tree() -> Result<()> {
        let child_pid_path =
            std::env::temp_dir().join(format!("thoth-process-tree-{}.pid", uuid::Uuid::new_v4()));
        let _file_guard = FileGuard(child_pid_path.clone());
        let context = JobExecutionContext::new();
        let parent = context.spawn(&mut parent_with_child_command(&child_pid_path))?;
        let root_pid = parent.pid;
        let _root_guard = ProcessGuard(root_pid);
        let child_pid = read_child_pid(&child_pid_path).await;
        let _child_guard = ProcessGuard(child_pid);
        assert!(process_is_alive(root_pid));
        assert!(process_is_alive(child_pid));

        context.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), parent.status())
            .await
            .map_err(|_| anyhow::anyhow!("process-tree cleanup exceeded two seconds"))?;
        let error = match result {
            Ok(status) => anyhow::bail!("cancelled parent unexpectedly exited with {status}"),
            Err(error) => error,
        };

        assert!(is_cancelled(&error));
        assert_process_exits(root_pid).await;
        assert_process_exits(child_pid).await;
        Ok(())
    }

    #[tokio::test]
    async fn dropping_a_wait_future_does_not_orphan_the_process_tree() -> Result<()> {
        let child_pid_path = std::env::temp_dir().join(format!(
            "thoth-dropped-process-tree-{}.pid",
            uuid::Uuid::new_v4()
        ));
        let _file_guard = FileGuard(child_pid_path.clone());
        let context = JobExecutionContext::new();
        let parent = context.spawn(&mut parent_with_child_command(&child_pid_path))?;
        let root_pid = parent.pid;
        let _root_guard = ProcessGuard(root_pid);
        let child_pid = read_child_pid(&child_pid_path).await;
        let _child_guard = ProcessGuard(child_pid);
        assert!(process_is_alive(root_pid));
        assert!(process_is_alive(child_pid));

        drop(parent.status());

        assert_process_exits(root_pid).await;
        assert_process_exits(child_pid).await;
        Ok(())
    }

    #[tokio::test]
    async fn cancellation_cleans_descendant_after_root_already_exited() -> Result<()> {
        let child_pid_path = std::env::temp_dir().join(format!(
            "thoth-exited-root-tree-{}.pid",
            uuid::Uuid::new_v4()
        ));
        let _file_guard = FileGuard(child_pid_path.clone());
        let context = JobExecutionContext::new();
        let root = context.spawn(&mut exiting_root_with_child_command(&child_pid_path))?;
        let root_pid = root.id();
        let _root_guard = ProcessGuard(root_pid);
        let child_pid = read_child_pid(&child_pid_path).await;
        let _child_guard = ProcessGuard(child_pid);
        assert_process_exits(root_pid).await;
        assert!(process_is_alive(child_pid));

        context.cancel();
        let result = root.wait().await;
        let error = match result {
            Ok(status) => anyhow::bail!("cancelled exited root returned normal status {status}"),
            Err(error) => error,
        };
        assert!(is_cancelled(&error));
        assert_process_exits(child_pid).await;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_termination_owns_all_children_and_closes_spawn() -> Result<()> {
        let context = JobExecutionContext::new();
        let child_a = context.spawn(&mut long_running_command())?;
        let child_b = context.spawn(&mut long_running_command())?;
        let child_c = context.spawn(&mut long_running_command())?;
        let pids = [child_a.id(), child_b.id(), child_c.id()];
        let _guards = pids.map(ProcessGuard);

        let repeated = context.clone();
        let ((), (), result_a, result_b, result_c) = tokio::join!(
            context.terminate_all(),
            repeated.terminate_all(),
            child_a.wait(),
            child_b.wait(),
            child_c.wait(),
        );

        for result in [result_a, result_b, result_c] {
            let error = match result {
                Ok(status) => anyhow::bail!("terminated child returned normal status {status}"),
                Err(error) => error,
            };
            assert!(is_cancelled(&error));
        }
        let error = match context.spawn(&mut long_running_command()) {
            Ok(child) => {
                let _guard = ProcessGuard(child.id());
                drop(child);
                anyhow::bail!("closed registry accepted a new process");
            }
            Err(error) => error,
        };
        assert!(is_cancelled(&error));
        for pid in pids {
            assert_process_exits(pid).await;
        }
        Ok(())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dropping_live_child_is_nonblocking() -> Result<()> {
        let context = JobExecutionContext::new();
        let child = context.spawn(&mut long_running_command())?;
        let _guard = ProcessGuard(child.id());

        let started = Instant::now();
        drop(child);

        assert!(
            started.elapsed() < Duration::from_millis(50),
            "drop blocked the current-thread runtime for {:?}",
            started.elapsed()
        );
        Ok(())
    }

    #[test]
    fn generation_exhaustion_is_rejected() {
        let mut next_generation = u64::MAX;
        let error = allocate_generation(&mut next_generation)
            .expect_err("generation exhaustion must not wrap or reuse an identity");
        assert!(error.to_string().contains("generation"));
    }

    #[test]
    fn cleanup_failure_preserves_typed_cancellation() {
        let result = cancelled_after_cleanup(
            42,
            Err(anyhow::anyhow!("forced process-tree cleanup failure")),
        );
        let error = result.expect_err("cancellation must never become a normal exit status");
        assert!(is_cancelled(&error));
        assert!(
            error
                .to_string()
                .contains("forced process-tree cleanup failure")
        );
    }

    #[test]
    fn stale_monitor_cannot_remove_an_exact_generation() {
        let key = ChildKey {
            pid: 42,
            generation: 7,
        };
        let registered = Arc::new(ChildControl {
            cancel: CancellationToken::new(),
            completed: CancellationToken::new(),
        });
        let stale = Arc::new(ChildControl {
            cancel: CancellationToken::new(),
            completed: CancellationToken::new(),
        });
        let registry = Mutex::new(Registry {
            lifecycle: RegistryLifecycle::Accepting,
            next_generation: 8,
            children: HashMap::from([(key, Arc::clone(&registered))]),
        });

        remove_exact_child(&registry, key, &stale);
        assert!(lock_registry(&registry).children.contains_key(&key));
        remove_exact_child(&registry, key, &registered);
        assert!(!lock_registry(&registry).children.contains_key(&key));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn spawn_racing_registry_close_is_rejected_or_owned() -> Result<()> {
        let context = JobExecutionContext::new();
        let barrier = Arc::new(tokio::sync::Barrier::new(9));
        let mut spawners = Vec::new();
        for _ in 0..8 {
            let context = context.clone();
            let barrier = Arc::clone(&barrier);
            spawners.push(tokio::spawn(async move {
                barrier.wait().await;
                context.spawn(&mut long_running_command())
            }));
        }
        barrier.wait().await;
        context.terminate_all().await;

        for spawner in spawners {
            match spawner.await? {
                Ok(child) => {
                    let pid = child.id();
                    let _guard = ProcessGuard(pid);
                    let error = child
                        .wait()
                        .await
                        .expect_err("a spawn accepted before close must be owned by termination");
                    assert!(is_cancelled(&error));
                    assert_process_exits(pid).await;
                }
                Err(error) => assert!(is_cancelled(&error)),
            }
        }
        assert_eq!(context.active_child_count(), 0);
        Ok(())
    }
}

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
// SAFETY: kernel HANDLE values may be transferred between threads; ownership is
// unique to this wrapper and CloseHandle is called exactly once in Drop.
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
// SAFETY: the owned kernel object supports thread-safe query/termination calls;
// this wrapper exposes no mutation of the HANDLE value itself.
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let job = Self { handle };
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let success = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&information).cast(),
                std::mem::size_of_val(&information) as u32,
            )
        };
        if success == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(job)
    }

    fn assign(&self, child: &Child) -> Result<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        let process = child
            .raw_handle()
            .ok_or_else(|| anyhow::anyhow!("spawned child has no process handle"))?;
        let success = unsafe { AssignProcessToJobObject(self.handle, process.cast()) };
        if success == 0 {
            Err(std::io::Error::last_os_error().into())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) -> Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            Err(std::io::Error::last_os_error().into())
        } else {
            Ok(())
        }
    }

    fn has_active_processes(&self) -> Result<bool> {
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject,
        };
        let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let success = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut information).cast(),
                std::mem::size_of_val(&information) as u32,
                std::ptr::null_mut(),
            )
        };
        if success == 0 {
            Err(std::io::Error::last_os_error().into())
        } else {
            Ok(information.ActiveProcesses > 0)
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
async fn cleanup_windows_tree(
    pid: u32,
    process_tree: &WindowsJob,
    child: Option<&mut Child>,
) -> Result<()> {
    let mut taskkill = Command::new("taskkill");
    taskkill
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let taskkill_result = match tokio::time::timeout(
        std::time::Duration::from_millis(500),
        taskkill.status(),
    )
    .await
    {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(anyhow::anyhow!("taskkill exited with {status}")),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(anyhow::anyhow!("taskkill timed out")),
    };
    let job_result = process_tree.terminate();
    let tree_result = if taskkill_result.is_ok() || job_result.is_ok() {
        Ok(())
    } else {
        combine_cleanup_results([taskkill_result, job_result])
    };
    let wait_result = match child {
        Some(child) => tokio::time::timeout(std::time::Duration::from_secs(1), child.wait())
            .await
            .map_err(|_| anyhow::anyhow!("terminated root process did not exit promptly"))?
            .map(|_| ())
            .map_err(Into::into),
        None => Ok(()),
    };
    combine_cleanup_results([tree_result, wait_result])
}
