use std::io::{Read, Write};
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::process::{Child, ExitStatus};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use schemars::schema_for;

use crate::platform;
use crate::daemon::process_registry::ActiveProcessGuard;
use crate::security::path::{FilesystemCapability, parse_requested_path, resolve_existing_target};
use crate::tools::bash::backend::spawn_bash;
use crate::tools::bash::group::bash_run_name;
use crate::tools::bash::types::{BashRunOutput, BashRunParams, BashTermination};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;

pub struct BashRunTool {
    name: ToolName,
}
impl BashRunTool {
    pub fn new() -> Self {
        Self {
            name: bash_run_name(),
        }
    }
}
impl ToolHandler for BashRunTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            name: self.name.as_str(),
            description: "Run a shell command in the worker environment.".to_string(),
            input_schema: serde_json::to_value(schema_for!(BashRunParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(BashRunOutput)).unwrap(),
            access: ToolAccess::Execute,
        }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params: BashRunParams = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        if params.command.trim().is_empty() {
            return Err(ToolError::new(
                "bash.invalidCommand",
                "command cannot be empty",
            ));
        }
        let timeout_ms = params.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let max_output = params.max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES);
        if timeout_ms == 0 || max_output == 0 {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "timeoutMs and maxOutputBytes must be positive",
            ));
        }
        if timeout_ms > MAX_TIMEOUT_MS || max_output > MAX_OUTPUT_BYTES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "timeoutMs or maxOutputBytes exceeds the worker limit",
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
            .map_err(|error| ToolError::new(error.code, error.message))?;
        let cwd = resolve_cwd(&call, params.cwd.as_deref())?;
        let started = Instant::now();
        let mut child = spawn_bash(
            &PathBuf::from("/bin/bash"),
            &params.command,
            &cwd,
            &params.env,
        )?;
        let pid = child.id() as i32;
        let process_guard = match call.process_registry.register(pid) {
            Ok(process_guard) => process_guard,
            Err(error) => {
                let _ = child.wait();
                return Err(ToolError::new("bash.spawnFailed", error));
            }
        };
        let mut child = ManagedBashChild::new(child, pid, process_guard);
        if let Some(stdin) = params.stdin {
            let mut input = child
                .stdin
                .take()
                .ok_or_else(|| ToolError::new("bash.ioFailed", "missing stdin pipe"))?;
            input
                .write_all(stdin.as_bytes())
                .map_err(|error| ToolError::new("bash.ioFailed", error.to_string()))?;
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::new("bash.ioFailed", "missing stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::new("bash.ioFailed", "missing stderr pipe"))?;
        let limit = Arc::new(AtomicBool::new(false));
        let stdout_bytes = Arc::new(AtomicUsize::new(0));
        let stderr_bytes = Arc::new(AtomicUsize::new(0));
        let stdout_thread = spawn_reader(
            stdout,
            Arc::clone(&stdout_bytes),
            Arc::clone(&limit),
            max_output,
        );
        let stderr_thread = spawn_reader(
            stderr,
            Arc::clone(&stderr_bytes),
            Arc::clone(&limit),
            max_output,
        );
        let termination = wait(&mut child, pid, Duration::from_millis(timeout_ms), &limit)?;
        let status = child
            .wait_and_reap()
            .map_err(|error| ToolError::new("bash.ioFailed", error.to_string()))?;
        let stdout = stdout_thread
            .join()
            .map_err(|_| ToolError::new("bash.ioFailed", "stdout reader panicked"))??;
        let stderr = stderr_thread
            .join()
            .map_err(|_| ToolError::new("bash.ioFailed", "stderr reader panicked"))??;
        let term_signal = status.signal();
        let termination = if termination == BashTermination::Exited && term_signal.is_some() {
            BashTermination::Signaled
        } else {
            termination
        };
        serde_json::to_value(BashRunOutput {
            exit_code: if matches!(termination, BashTermination::Exited) {
                status.code()
            } else {
                None
            },
            term_signal: if matches!(termination, BashTermination::Signaled) {
                term_signal
            } else {
                None
            },
            stdout: String::from_utf8_lossy(&stdout.kept).to_string(),
            stderr: String::from_utf8_lossy(&stderr.kept).to_string(),
            stdout_bytes: stdout_bytes.load(Ordering::SeqCst),
            stderr_bytes: stderr_bytes.load(Ordering::SeqCst),
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
            duration_ms: started.elapsed().as_millis(),
            termination,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
struct ManagedBashChild {
    child: Child,
    process_group: i32,
    reaped: bool,
    _process_guard: ActiveProcessGuard,
}

impl ManagedBashChild {
    fn new(child: Child, process_group: i32, process_guard: ActiveProcessGuard) -> Self {
        Self {
            child,
            process_group,
            reaped: false,
            _process_guard: process_guard,
        }
    }

    fn wait_and_reap(&mut self) -> std::io::Result<ExitStatus> {
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
        let _ = platform::terminate_process_group(self.process_group, true);
        let _ = self.child.wait();
        self.reaped = true;
    }
}

struct StreamOutput {
    kept: Vec<u8>,
    truncated: bool,
}
fn resolve_cwd(call: &ToolCall, raw: Option<&str>) -> Result<PathBuf, ToolError> {
    let requested = parse_requested_path(raw.unwrap_or("./"))
        .map_err(|_| ToolError::new("bash.invalidCwd", "cwd must use `./` or `/` syntax"))?;
    let resolved = resolve_existing_target(&call.workspace, &requested)
        .map_err(|error| ToolError::new("bash.invalidCwd", error.message))?;
    if !resolved.canonical.is_dir() {
        return Err(ToolError::new("bash.invalidCwd", "cwd is not a directory"));
    }
    Ok(resolved.canonical)
}
fn spawn_reader(
    mut reader: impl Read + Send + 'static,
    bytes: Arc<AtomicUsize>,
    limit_hit: Arc<AtomicBool>,
    max: usize,
) -> thread::JoinHandle<Result<StreamOutput, ToolError>> {
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        let mut output = Vec::new();
        let mut truncated = false;
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| ToolError::new("bash.ioFailed", error.to_string()))?;
            if count == 0 {
                break;
            }
            bytes.fetch_add(count, Ordering::SeqCst);
            let remaining = max.saturating_sub(output.len());
            let kept = remaining.min(count);
            output.extend_from_slice(&buffer[..kept]);
            if kept < count {
                truncated = true;
                limit_hit.store(true, Ordering::SeqCst);
            }
        }
        Ok(StreamOutput {
            kept: output,
            truncated,
        })
    })
}
fn wait(
    child: &mut Child,
    pid: i32,
    timeout: Duration,
    limit: &AtomicBool,
) -> Result<BashTermination, ToolError> {
    let started = Instant::now();
    loop {
        if limit.load(Ordering::SeqCst) {
            terminate(pid)?;
            return Ok(BashTermination::OutputLimit);
        }
        if started.elapsed() >= timeout {
            terminate(pid)?;
            return Ok(BashTermination::Timeout);
        }
        match child.try_wait() {
            Ok(Some(_)) => return Ok(BashTermination::Exited),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => return Err(ToolError::new("bash.ioFailed", error.to_string())),
        }
    }
}
fn terminate(pid: i32) -> Result<(), ToolError> {
    platform::terminate_process_group(pid, true)
        .map_err(|error| ToolError::new("bash.ioFailed", error))
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
