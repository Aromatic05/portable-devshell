use std::io::Write;
use std::ops::{Deref, DerefMut};
use std::process::{Child, ExitStatus};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::capability::artifact::result_path::tool_result_path;
use crate::capability::artifact::store::ArtifactStore;
use crate::capability::artifact::types::ArtifactStream;
use crate::capability::process::pipe::spawn_shell;
use crate::capability::process::shell::ShellRuntime;
use crate::instance::sandbox::path::{
    FilesystemCapability, PathNamespace, ResolvedPath, resolve_existing_target,
};
use crate::tool::ToolCommandEnvironmentProvider;
use crate::tool::bash::bash_run_name;
use crate::tool::bash::model::{BashRunOutput, BashRunParams, BashTermination};
#[cfg(unix)]
use crate::tool::file::observation::{CommandReadPlan, MAX_OUTPUT_BYTES};
use crate::tool::file::{FileToolState, requested_path};
use crate::tool::process::capture::{
    BashProgress, BashProgressStream, begin_artifact, enforce_inline_rpc_budget, persist_artifact,
    render_inline_stream, spawn_reader,
};
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolProcessGuard,
};

const DEFAULT_MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 100_000;
const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;
// Model-facing MCP projections are smaller than the Worker capture budget.
// Retain the original streams before any protocol-side presentation trimming.
const RECOVERY_OUTPUT_BYTES: usize = 4 * 1024;

pub struct BashRunTool {
    name: ToolName,
    artifacts: Arc<ArtifactStore>,
    model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
    #[cfg_attr(windows, allow(dead_code))]
    files: Arc<FileToolState>,
    shell: ShellRuntime,
    instance: crate::instance::InstanceName,
}
impl BashRunTool {
    pub fn new(
        artifacts: Arc<ArtifactStore>,
        model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
        files: Arc<FileToolState>,
        instance: crate::instance::InstanceName,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            name: bash_run_name(),
            artifacts,
            model_devshell,
            files,
            shell: ShellRuntime::detect()?,
            instance,
        })
    }
}
impl ToolHandler for BashRunTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tool::contract::catalog_entry_with_meta::<BashRunParams, BashRunOutput>(
            &self.name,
            "Execute a shell command. waitMs controls how long to wait; a running command returns a task ID. timeoutMs is an optional hard execution deadline. tty allocates a PTY at startup. Use task_read and task_input to continue. Retained output paths can be read with file_read.",
            [ToolCapability::Execute],
            serde_json::json!({
                "devshell": { "mcp": {
                    "annotations": {
                        "destructiveHint": true,
                        "idempotentHint": false,
                        "openWorldHint": true,
                        "readOnlyHint": false
                    },
                    "inputHints": {
                        "command": "Shell command. Run devshell help to discover authorized MCP model CLI commands.",
                        "cwd": "Working directory; bare relative and ./ paths are workspace-relative, absolute paths are also accepted.",
                        "stdin": "Omit to send EOF.",
                        "timeoutMs": "Optional hard execution deadline.", "waitMs": "Wait before returning a running task ID; does not stop the process.", "tty": "Allocate a PTY at startup."
                    },
                    "title": "Run shell command"
                }}
            }),
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let mut params: BashRunParams = call.parse_params()?;
        if params.command.trim().is_empty() {
            return Err(ToolError::new(
                "bash.invalidCommand",
                "command cannot be empty",
            ));
        }
        let requires_persistence = params.timeout_ms.is_none()
            || params.wait_ms.is_some()
            || params.tty
            || params.keep_stdin;
        let timeout_ms = params.timeout_ms.unwrap_or(MAX_TIMEOUT_MS);
        if params.wait_ms.is_some_and(|wait| wait > MAX_TIMEOUT_MS) {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "waitMs cannot exceed 100000",
            ));
        }
        let max_capture = params
            .max_capture_bytes
            .unwrap_or(DEFAULT_MAX_CAPTURE_BYTES);
        if timeout_ms == 0 || max_capture == 0 {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "timeoutMs and maxCaptureBytes must be positive",
            ));
        }
        if timeout_ms > MAX_TIMEOUT_MS {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "timeoutMs cannot exceed 100000",
            ));
        }
        if max_capture > MAX_CAPTURE_BYTES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "maxCaptureBytes exceeds the worker limit",
            ));
        }
        if params
            .stdin
            .as_ref()
            .is_some_and(|stdin| stdin.len() > MAX_STDIN_BYTES)
        {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "stdin exceeds the worker limit",
            ));
        }
        call.policy
            .check_capability(FilesystemCapability::ProcessExecute)
            .map_err(ToolError::from)?;
        let cwd = resolve_cwd(&call, params.cwd.as_deref())?;
        #[cfg(unix)]
        let read_plan = if call.stateless {
            None
        } else {
            CommandReadPlan::analyze(&params.command, &cwd.canonical)
        };
        let execution = crate::capability::execution::ExecutionConfig::from_env()
            .map_err(|error| ToolError::new("execution.invalidConfig", error))?;
        // The outer launcher still owns daemon-phase containment. Until it
        // can launch the Host independently, preserve the existing bounded
        // command path in that environment. Never escape its sandbox.
        let daemon_sandbox = execution
            .as_ref()
            .and_then(|config| config.sandbox.as_ref())
            .is_some_and(|sandbox| sandbox.phase == "daemon");
        let hosted = !daemon_sandbox || requires_persistence;
        if let Some(config) = execution.as_ref() {
            let mut effective_env = config
                .environment(cwd.access_path())
                .map_err(|error| ToolError::new("execution.providerFailed", error))?;
            for (key, value) in std::mem::take(&mut params.env) {
                effective_env.insert(key, value);
            }
            params.env = effective_env;
        }
        let task_id = hosted.then(|| format!("process-{}", uuid::Uuid::new_v4()));
        let requested_path = match params.env.get("PATH") {
            Some(Some(value)) => Some(value.as_str()),
            Some(None) => Some(""),
            None => None,
        };
        if !call.stateless
            && let Some(environment) =
                self.model_devshell
                    .environment(&call, task_id.as_deref(), requested_path)
        {
            environment.inject(&mut params.env);
        }
        if let Some(task_id) = task_id {
            let result = crate::tool::process::run::run(
                &self.instance,
                &self.artifacts,
                &call,
                params,
                &task_id,
                max_capture,
            )?;
            #[cfg(unix)]
            if result.termination == BashTermination::Exited
                && !result.stdout_truncated
                && !result.stderr_truncated
                && result.stdout_bytes.saturating_add(result.stderr_bytes) <= MAX_OUTPUT_BYTES
                && let Some(plan) = read_plan
            {
                plan.observe(&call, &self.files, &result.stdout);
            }
            return crate::tool::contract::serialize(result);
        }
        let started = Instant::now();
        let mut child = spawn_shell(
            &self.shell,
            &params.command,
            &cwd,
            &params.env,
            execution.as_ref(),
        )?;
        let pid = child.id() as i32;
        let process_guard = match Arc::clone(&call.process_registry).register(pid) {
            Ok(process_guard) => process_guard,
            Err(error) => {
                let _ = child.wait();
                return Err(ToolError::new("bash.spawnFailed", error));
            }
        };
        let mut child = ManagedBashChild::new(child, process_guard);
        let input = child
            .stdin
            .take()
            .ok_or_else(|| ToolError::new("bash.ioFailed", "missing stdin pipe"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::new("bash.ioFailed", "missing stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::new("bash.ioFailed", "missing stderr pipe"))?;
        let stdout_bytes = Arc::new(AtomicUsize::new(0));
        let stderr_bytes = Arc::new(AtomicUsize::new(0));
        let progress = Arc::new(BashProgress::new(started, call.progress()));
        progress.emit_initial();
        let (stdout_draft, stdout_warning) =
            begin_artifact(&self.artifacts, ArtifactStream::Stdout);
        let (stderr_draft, stderr_warning) =
            begin_artifact(&self.artifacts, ArtifactStream::Stderr);
        let stdout_thread = spawn_reader(
            stdout,
            Arc::clone(&stdout_bytes),
            max_capture,
            stdout_draft,
            stdout_warning,
            Arc::clone(&progress),
            BashProgressStream::Stdout,
        );
        let stderr_thread = spawn_reader(
            stderr,
            Arc::clone(&stderr_bytes),
            max_capture,
            stderr_draft,
            stderr_warning,
            Arc::clone(&progress),
            BashProgressStream::Stderr,
        );
        let stdin_thread = match params.stdin {
            Some(stdin) => Some(spawn_stdin_writer(input, stdin)),
            None => {
                drop(input);
                None
            }
        };
        let deadline = started + Duration::from_millis(timeout_ms);
        let wait_outcome = wait(&mut child, deadline, &call.cancellation)?;
        let status = child
            .wait_and_reap()
            .map_err(|error| ToolError::new("bash.ioFailed", error.to_string()))?;
        let stdin_result = if let Some(stdin_thread) = stdin_thread {
            stdin_thread
                .join()
                .map_err(|_| ToolError::new("bash.ioFailed", "stdin writer panicked"))?
        } else {
            Ok(())
        };
        let stdout_result = stdout_thread
            .join()
            .map_err(|_| ToolError::new("bash.ioFailed", "stdout reader panicked"))
            .and_then(|result| result);
        let stderr_result = stderr_thread
            .join()
            .map_err(|_| ToolError::new("bash.ioFailed", "stderr reader panicked"))
            .and_then(|result| result);
        progress.finish();
        let mut stdout = stdout_result?;
        let mut stderr = stderr_result?;
        stdin_result?;
        enforce_inline_rpc_budget(&mut stdout);
        enforce_inline_rpc_budget(&mut stderr);
        let term_signal = status.signal();
        let termination = match wait_outcome {
            BashWaitOutcome::Cancelled => BashTermination::Signaled,
            BashWaitOutcome::Termination(BashTermination::Exited) if term_signal.is_some() => {
                BashTermination::Signaled
            }
            BashWaitOutcome::Termination(termination) => termination,
        };
        let mut artifact_warnings = Vec::new();
        let retain_recovery = stdout.truncated
            || stderr.truncated
            || stdout.kept.len().saturating_add(stderr.kept.len()) > RECOVERY_OUTPUT_BYTES;
        let retain_stdout = retain_recovery && !stdout.kept.is_empty();
        let retain_stderr = retain_recovery && !stderr.kept.is_empty();
        let stdout_artifact = persist_artifact(
            &self.artifacts,
            &mut stdout,
            "stdout",
            retain_stdout,
            &mut artifact_warnings,
        );
        let stderr_artifact = persist_artifact(
            &self.artifacts,
            &mut stderr,
            "stderr",
            retain_stderr,
            &mut artifact_warnings,
        );
        let stdout_path = stdout_artifact.as_ref().map(tool_result_path);
        let stderr_path = stderr_artifact.as_ref().map(tool_result_path);
        if matches!(wait_outcome, BashWaitOutcome::Cancelled) {
            return Err(ToolError::new(
                "tool.cancelled",
                "bash_run was cancelled and its process group was terminated.",
            )
            .with_details(serde_json::json!({
                "durationMs": started.elapsed().as_millis(),
                "stderrBytes": stderr_bytes.load(Ordering::SeqCst),
                "stdoutBytes": stdout_bytes.load(Ordering::SeqCst),
                "termSignal": term_signal,
            })));
        }
        let result = crate::tool::contract::serialize(BashRunOutput {
            exit_code: if matches!(termination, BashTermination::Exited) {
                status.code()
            } else {
                None
            },
            term_signal: if matches!(
                termination,
                BashTermination::Signaled | BashTermination::Timeout
            ) {
                term_signal
            } else {
                None
            },
            timed_out: matches!(termination, BashTermination::Timeout).then_some(true),
            stdout: render_inline_stream(&stdout),
            stderr: render_inline_stream(&stderr),
            stdout_bytes: stdout_bytes.load(Ordering::SeqCst),
            stderr_bytes: stderr_bytes.load(Ordering::SeqCst),
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
            stdout_path,
            stderr_path,
            stdout_artifact,
            stderr_artifact,
            artifact_warnings: (!artifact_warnings.is_empty()).then_some(artifact_warnings),
            duration_ms: started.elapsed().as_millis(),
            termination,
            task: None,
            cursor: None,
        })?;
        #[cfg(unix)]
        if !stdout.truncated
            && !stderr.truncated
            && stdout.kept.len().saturating_add(stderr.kept.len()) <= MAX_OUTPUT_BYTES
            && let Some(plan) = read_plan
            && serde_json::to_vec(&result).is_ok_and(|bytes| bytes.len() <= 4_000 * 3)
            && let Some(visible) = result.get("stdout").and_then(serde_json::Value::as_str)
        {
            plan.observe(&call, &self.files, visible);
        }
        Ok(result)
    }
}
struct ManagedBashChild {
    child: Child,
    reaped: bool,
    process_guard: Option<Box<dyn ToolProcessGuard>>,
}

impl ManagedBashChild {
    fn new(child: Child, process_guard: Box<dyn ToolProcessGuard>) -> Self {
        Self {
            child,
            reaped: false,
            process_guard: Some(process_guard),
        }
    }

    fn terminate_group(&self) -> Result<(), ToolError> {
        self.process_guard
            .as_ref()
            .expect("unreaped bash child has a process guard")
            .terminate_process_group(true)
            .map_err(|error| ToolError::new("bash.ioFailed", error))
    }

    fn wait_and_reap(&mut self) -> std::io::Result<ExitStatus> {
        // Group cleanup is complete. Unregister while the unreaped leader still
        // pins its PID, so registry shutdown cannot signal a reused process group.
        self.process_guard.take();
        let status = self.child.wait()?;
        self.reaped = true;
        Ok(status)
    }
}

impl Deref for ManagedBashChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl DerefMut for ManagedBashChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for ManagedBashChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        if let Some(guard) = self.process_guard.take() {
            let _ = guard.terminate_process_group(true);
            drop(guard);
        }
        let _ = self.child.wait();
        self.reaped = true;
    }
}

fn resolve_cwd(call: &ToolCall, raw: Option<&str>) -> Result<ResolvedPath, ToolError> {
    if call.stateless && raw.is_none() {
        return Err(ToolError::new(
            "bash.invalidCwd",
            "cwd is required in stateless mode",
        ));
    }
    let requested = requested_path(call, raw.unwrap_or("./"))
        .map_err(|error| ToolError::new("bash.invalidCwd", error.message))?;
    let (read, write) = match requested.namespace {
        PathNamespace::Workspace => (
            FilesystemCapability::WorkspaceRead,
            FilesystemCapability::WorkspaceWrite,
        ),
        PathNamespace::Absolute => (
            FilesystemCapability::AbsoluteRead,
            FilesystemCapability::AbsoluteWrite,
        ),
    };
    call.policy
        .check_capability(read)
        .and_then(|_| call.policy.check_capability(write))
        .map_err(ToolError::from)?;
    let resolved = resolve_existing_target(&call.workspace, &requested)
        .map_err(|error| ToolError::new("bash.invalidCwd", error.message))?;
    if !resolved
        .metadata()
        .map_err(|error| ToolError::new("bash.invalidCwd", error.to_string()))?
        .is_dir()
    {
        return Err(ToolError::new("bash.invalidCwd", "cwd is not a directory"));
    }
    Ok(resolved)
}
fn spawn_stdin_writer(
    mut writer: impl Write + Send + 'static,
    input: String,
) -> thread::JoinHandle<Result<(), ToolError>> {
    thread::spawn(move || match writer.write_all(input.as_bytes()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(ToolError::new("bash.ioFailed", error.to_string())),
    })
}

#[derive(Clone, Copy, Debug)]
enum BashWaitOutcome {
    Cancelled,
    Termination(BashTermination),
}

fn wait(
    child: &mut ManagedBashChild,
    deadline: Instant,
    cancellation: &crate::tool::ToolCancellation,
) -> Result<BashWaitOutcome, ToolError> {
    loop {
        match crate::capability::process::child::exited_without_reaping(&mut child.child) {
            Ok(true) => {
                child.terminate_group()?;
                return Ok(BashWaitOutcome::Termination(BashTermination::Exited));
            }
            Ok(false) => {}
            Err(error) => return Err(ToolError::new("bash.ioFailed", error.to_string())),
        }
        if cancellation.is_cancelled() {
            child.terminate_group()?;
            return Ok(BashWaitOutcome::Cancelled);
        }
        let now = Instant::now();
        if now >= deadline {
            child.terminate_group()?;
            return Ok(BashWaitOutcome::Termination(BashTermination::Timeout));
        }
        thread::sleep(Duration::from_millis(10).min(deadline.saturating_duration_since(now)));
    }
}

#[cfg(unix)]
trait ExitSignal {
    fn signal(&self) -> Option<i32>;
}
#[cfg(unix)]
impl ExitSignal for std::process::ExitStatus {
    fn signal(&self) -> Option<i32> {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::signal(self)
    }
}

#[cfg(windows)]
trait ExitSignal {
    fn signal(&self) -> Option<i32>;
}

#[cfg(windows)]
impl ExitSignal for std::process::ExitStatus {
    fn signal(&self) -> Option<i32> {
        None
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::{BufRead, BufReader, Read};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use crate::daemon::process::registry::ActiveProcessRegistry;
    use crate::tool::{ToolCancellation, ToolProcessGuard};

    use super::{BashWaitOutcome, ManagedBashChild, wait};
    use crate::capability::process::child::exited_without_reaping as child_exited_without_reaping;

    struct CheckUnreapedGuard {
        pid: i32,
        inner: Box<dyn ToolProcessGuard>,
    }

    impl ToolProcessGuard for CheckUnreapedGuard {
        fn terminate_process_group(&self, force: bool) -> Result<(), String> {
            self.inner.terminate_process_group(force)
        }
    }

    impl Drop for CheckUnreapedGuard {
        fn drop(&mut self) {
            use nix::libc;

            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            assert_eq!(
                unsafe {
                    libc::waitid(
                        libc::P_PID,
                        self.pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                },
                0,
                "registry guard must be released before reaping"
            );
            assert_eq!(unsafe { info.si_pid() }, self.pid);
        }
    }

    #[test]
    fn completed_shell_remains_waitable_after_exit_probe() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .process_group(0)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child_exited_without_reaping(&mut child).unwrap() {
            assert!(Instant::now() < deadline, "shell did not exit");
            std::thread::yield_now();
        }
        let registry = Arc::new(ActiveProcessRegistry::new());
        let pid = child.id() as i32;
        let guard = Box::new(CheckUnreapedGuard {
            pid,
            inner: Box::new(registry.register(pid).unwrap()),
        });
        let mut child = ManagedBashChild::new(child, guard);
        assert!(matches!(
            wait(&mut child, deadline, &ToolCancellation::default()).unwrap(),
            BashWaitOutcome::Termination(super::BashTermination::Exited)
        ));
        assert_eq!(child.wait_and_reap().unwrap().code(), Some(7));
        assert!(child.process_guard.is_none());
        registry.stop_all(Duration::from_secs(1)).unwrap();
    }

    fn wait_with_descendant(
        command: &str,
        timeout: Duration,
        cancellation: &ToolCancellation,
    ) -> BashWaitOutcome {
        let child = Command::new("/bin/sh")
            .args(["-c", command])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let registry = Arc::new(ActiveProcessRegistry::new());
        let guard = registry.register(child.id() as i32).unwrap();
        let mut child = ManagedBashChild::new(child, Box::new(guard));
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        output.read_line(&mut ready).unwrap();
        assert_eq!(ready, "ready\n");

        let started = Instant::now();
        let outcome = wait(&mut child, started + timeout, cancellation).unwrap();
        child.wait_and_reap().unwrap();
        let mut remaining = String::new();
        output.read_to_string(&mut remaining).unwrap();
        assert!(remaining.is_empty());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "descendant kept stdout open"
        );
        assert!(child.process_guard.is_none());
        registry.stop_all(Duration::from_secs(1)).unwrap();
        outcome
    }

    #[test]
    fn exited_shell_cleans_its_live_descendant() {
        assert!(matches!(
            wait_with_descendant(
                "sleep 5 & printf 'ready\\n'; exit 7",
                Duration::from_secs(2),
                &ToolCancellation::default(),
            ),
            BashWaitOutcome::Termination(super::BashTermination::Exited)
        ));
    }

    #[test]
    fn timed_out_shell_cleans_its_live_descendant() {
        assert!(matches!(
            wait_with_descendant(
                "sleep 5 & printf 'ready\\n'; wait",
                Duration::from_millis(50),
                &ToolCancellation::default(),
            ),
            BashWaitOutcome::Termination(super::BashTermination::Timeout)
        ));
    }

    #[test]
    fn cancelled_shell_cleans_its_live_descendant() {
        let cancellation = ToolCancellation::default();
        cancellation.cancel();
        assert!(matches!(
            wait_with_descendant(
                "sleep 5 & printf 'ready\\n'; wait",
                Duration::from_secs(2),
                &cancellation,
            ),
            BashWaitOutcome::Cancelled
        ));
    }
}
