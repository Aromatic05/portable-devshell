use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use schemars::schema_for;

use crate::platform;
use crate::tools::bash::backend::spawn_bash;
use crate::tools::bash::group::bash_run_name;
use crate::tools::bash::types::{BashRunOutput, BashRunParams};
use crate::tools::{ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

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
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params: BashRunParams = serde_json::from_value(call.params)
            .map_err(|error| ToolError::new("bash.invalidParams", error.to_string()))?;

        if params.command.trim().is_empty() {
            return Err(ToolError::new(
                "bash.invalidParams",
                "command cannot be empty",
            ));
        }

        let cwd = resolve_cwd(&call.workspace, params.cwd.clone(), call.policy.as_ref())?;
        let timeout = Duration::from_millis(params.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
        let max_output_bytes = params.max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES);
        let env = params.env;

        let mut child = spawn_bash(
            &PathBuf::from("/bin/bash"),
            &params.command,
            &cwd,
            &env,
        )?;
        let child_pid = child.id() as i32;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::new("internal", "missing stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ToolError::new("internal", "missing stderr pipe"))?;

        let total_bytes = Arc::new(AtomicUsize::new(0));
        let output_limit_hit = Arc::new(AtomicBool::new(false));
        let stdout_bytes = Arc::new(AtomicUsize::new(0));
        let stderr_bytes = Arc::new(AtomicUsize::new(0));
        let stdout_thread = spawn_reader(
            stdout,
            Arc::clone(&total_bytes),
            Arc::clone(&stdout_bytes),
            Arc::clone(&output_limit_hit),
            max_output_bytes,
        );
        let stderr_thread = spawn_reader(
            stderr,
            Arc::clone(&total_bytes),
            Arc::clone(&stderr_bytes),
            Arc::clone(&output_limit_hit),
            max_output_bytes,
        );

        let timed_out = wait_with_timeout(&mut child, child_pid, timeout, &output_limit_hit)?;
        let status = child
            .wait()
            .map_err(|error| ToolError::new("io_error", format!("failed to wait for child process: {error}")))?;

        let stdout = stdout_thread
            .join()
            .map_err(|_| ToolError::new("internal", "stdout reader thread panicked"))??;
        let stderr = stderr_thread
            .join()
            .map_err(|_| ToolError::new("internal", "stderr reader thread panicked"))??;

        if output_limit_hit.load(Ordering::SeqCst) {
            return Err(ToolError::new(
                "bash.outputLimitExceeded",
                "Command output exceeded maxOutputBytes.",
            )
            .with_details(serde_json::json!({
                "maxOutputBytes": max_output_bytes,
                "stdoutBytes": stdout_bytes.load(Ordering::SeqCst),
                "stderrBytes": stderr_bytes.load(Ordering::SeqCst)
            })));
        }

        let result = BashRunOutput {
            exit_code: if timed_out { None } else { status.code() },
            stdout,
            stderr,
            timed_out,
        };

        serde_json::to_value(result)
            .map_err(|error| ToolError::new("bash.serializeFailed", error.to_string()))
    }
}

fn resolve_cwd(
    workspace: &Path,
    cwd: Option<PathBuf>,
    policy: &dyn crate::security::SecurityPolicy,
) -> Result<PathBuf, ToolError> {
    let resolved = policy
        .resolve_workspace_path(workspace, cwd)
        .map_err(|error| {
            let mut tool_error = ToolError::new(error.code, error.message);
            tool_error.details = error.details;
            tool_error
        })?;
    resolved
        .canonicalize()
        .map_err(|error| ToolError::new("invalid_params", format!("failed to canonicalize cwd {}: {error}", resolved.display())))
}

fn spawn_reader(
    mut reader: impl Read + Send + 'static,
    total_bytes: Arc<AtomicUsize>,
    stream_bytes: Arc<AtomicUsize>,
    output_limit_hit: Arc<AtomicBool>,
    max_output_bytes: usize,
) -> thread::JoinHandle<Result<String, ToolError>> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        let mut output = Vec::new();
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| ToolError::new("io_error", format!("failed to read child output: {error}")))?;
            if read == 0 {
                break;
            }

            stream_bytes.fetch_add(read, Ordering::SeqCst);
            let previous = total_bytes.fetch_add(read, Ordering::SeqCst);
            let remaining = max_output_bytes.saturating_sub(previous);
            let allowed = remaining.min(read);
            output.extend_from_slice(&buffer[..allowed]);
            if allowed < read || previous + read > max_output_bytes {
                output_limit_hit.store(true, Ordering::SeqCst);
            }
        }

        Ok(String::from_utf8_lossy(&output).to_string())
    })
}

fn wait_with_timeout(
    child: &mut Child,
    child_pid: i32,
    timeout: Duration,
    output_limit_hit: &AtomicBool,
) -> Result<bool, ToolError> {
    let started_at = Instant::now();

    loop {
        if output_limit_hit.load(Ordering::SeqCst) {
            terminate_process_group(child_pid)?;
            return Ok(false);
        }

        if started_at.elapsed() >= timeout {
            terminate_process_group(child_pid)?;
            return Ok(true);
        }

        match child.try_wait() {
            Ok(Some(_)) => return Ok(false),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                return Err(ToolError::new(
                    "io_error",
                    format!("failed to poll child process: {error}"),
                ));
            }
        }
    }
}

fn terminate_process_group(pid: i32) -> Result<(), ToolError> {
    platform::terminate_process_group(pid, true)
        .map_err(|error| ToolError::new("io_error", error))
}
