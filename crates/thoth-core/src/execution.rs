use anyhow::Result;
use std::collections::HashSet;
use std::process::{ExitStatus, Output, Stdio};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
#[error("job cancelled")]
pub struct Cancelled;

#[derive(Clone)]
pub struct JobExecutionContext {
    cancellation: CancellationToken,
    active_root_pids: Arc<Mutex<HashSet<u32>>>,
}

impl JobExecutionContext {
    #[must_use]
    pub fn new() -> Self {
        Self {
            cancellation: CancellationToken::new(),
            active_root_pids: Arc::new(Mutex::new(HashSet::new())),
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
        configure_process_group(command);
        command.kill_on_drop(true);
        let child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| anyhow::anyhow!("spawned child has no process ID"))?;
        lock_pids(&self.active_root_pids).insert(pid);
        Ok(SupervisedChild {
            child,
            pid,
            cancellation: self.cancellation.clone(),
            active_root_pids: Arc::clone(&self.active_root_pids),
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
        let pids = lock_pids(&self.active_root_pids)
            .iter()
            .copied()
            .collect::<Vec<_>>();
        for pid in pids {
            terminate_process_tree(pid).await;
            unregister(&self.active_root_pids, pid);
        }
    }

    #[cfg(test)]
    fn active_child_count(&self) -> usize {
        lock_pids(&self.active_root_pids).len()
    }
}

impl Default for JobExecutionContext {
    fn default() -> Self {
        Self::new()
    }
}

pub struct SupervisedChild {
    child: Child,
    pid: u32,
    cancellation: CancellationToken,
    active_root_pids: Arc<Mutex<HashSet<u32>>>,
}

impl SupervisedChild {
    pub async fn output(mut self) -> Result<Output> {
        let mut stdout = self
            .child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("supervised child stdout is not piped"))?;
        let mut stderr = self
            .child
            .stderr
            .take()
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
        let cancellation = self.cancellation.clone();
        let result = tokio::select! {
            status = self.child.wait() => status.map_err(Into::into),
            () = cancellation.cancelled() => {
                terminate_child_tree(self.pid, &mut self.child).await;
                Err(Cancelled.into())
            }
        };
        unregister(&self.active_root_pids, self.pid);
        result
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        let was_active = lock_pids(&self.active_root_pids).remove(&self.pid);
        if was_active {
            terminate_process_tree_blocking(self.pid);
        }
    }
}

#[cfg(windows)]
fn terminate_process_tree_blocking(pid: u32) {
    match std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => {}
        Ok(status) => tracing::warn!(pid, %status, "dropped process-tree cleanup command failed"),
        Err(error) => {
            tracing::warn!(pid, %error, "could not run dropped process-tree cleanup command");
        }
    }
}

#[cfg(unix)]
fn terminate_process_tree_blocking(pid: u32) {
    signal_process_group(pid, libc::SIGTERM);
    std::thread::sleep(std::time::Duration::from_millis(750));
    signal_process_group(pid, libc::SIGKILL);
}

#[cfg(windows)]
async fn terminate_child_tree(pid: u32, child: &mut Child) {
    terminate_process_tree(pid).await;

    match tokio::time::timeout(std::time::Duration::from_millis(500), child.wait()).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => tracing::warn!(pid, %error, "could not wait for terminated root process"),
        Err(_) => {
            tracing::warn!(pid, "terminated root process did not exit promptly");
            if let Err(error) = child.kill().await {
                tracing::warn!(pid, %error, "could not kill root process");
            }
        }
    }
}

#[cfg(windows)]
async fn terminate_process_tree(pid: u32) {
    let mut taskkill = Command::new("taskkill");
    taskkill
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(std::time::Duration::from_secs(1), taskkill.status()).await {
        Ok(Ok(status)) if status.success() => {}
        Ok(Ok(status)) => tracing::warn!(pid, %status, "process-tree cleanup command failed"),
        Ok(Err(error)) => tracing::warn!(pid, %error, "could not run process-tree cleanup command"),
        Err(_) => tracing::warn!(pid, "process-tree cleanup command timed out"),
    }
}

#[cfg(unix)]
async fn terminate_child_tree(pid: u32, child: &mut Child) {
    signal_process_group(pid, libc::SIGTERM);
    let root_reaped =
        match tokio::time::timeout(std::time::Duration::from_millis(750), child.wait()).await {
            Ok(Ok(_)) => true,
            Ok(Err(error)) => {
                tracing::warn!(pid, %error, "could not wait for terminated root process");
                true
            }
            Err(_) => false,
        };

    // The root may honor SIGTERM while one of its descendants ignores it. Always
    // finish the group cleanup after the grace period, even when the root reaps early.
    signal_process_group(pid, libc::SIGKILL);
    if !root_reaped && let Err(error) = child.wait().await {
        tracing::warn!(pid, %error, "could not wait for killed root process");
    }
}

#[cfg(unix)]
async fn terminate_process_tree(pid: u32) {
    signal_process_group(pid, libc::SIGTERM);
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    signal_process_group(pid, libc::SIGKILL);
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        tracing::warn!(pid, "process ID does not fit platform pid_t");
        return;
    };
    // SAFETY: negative PIDs address the process group created at spawn, and `kill`
    // neither dereferences pointers nor transfers memory ownership.
    if unsafe { libc::kill(-pid, signal) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            tracing::warn!(pid, %error, "could not signal process group");
        }
    }
}

fn lock_pids(pids: &Mutex<HashSet<u32>>) -> std::sync::MutexGuard<'_, HashSet<u32>> {
    pids.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn unregister(pids: &Mutex<HashSet<u32>>, pid: u32) {
    lock_pids(pids).remove(&pid);
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

    #[cfg(unix)]
    fn parent_with_child_command(child_pid_path: &std::path::Path) -> Command {
        let script = format!("sleep 30 & echo $! > '{}'; wait", child_pid_path.display());
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
}
