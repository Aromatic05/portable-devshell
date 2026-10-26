use std::collections::VecDeque;
use std::io::{Read, Write};
use std::ops::{Deref, DerefMut};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::capability::artifact::result_path::tool_result_path;
use crate::capability::artifact::store::{ArtifactDraft, ArtifactStore};
use crate::capability::artifact::types::{ArtifactReference, ArtifactStream};
use crate::instance::sandbox::path::{
    FilesystemCapability, PathNamespace, ResolvedPath, normalize_requested_path,
    parse_requested_path, resolve_existing_target,
};
use crate::tool::ToolCommandEnvironmentProvider;
use crate::tool::bash::bash_run_name;
use crate::tool::bash::model::ShellRuntime;
use crate::tool::bash::model::{BashRunOutput, BashRunParams, BashTermination};
use crate::tool::bash::process::spawn_shell;
use crate::tool::file::FileToolState;
#[cfg(unix)]
use crate::tool::file::observation::{CommandReadPlan, MAX_OUTPUT_BYTES};
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolProcessGuard,
    ToolProgressEmitter,
};

const DEFAULT_MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 100_000;
const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;
const MAX_INLINE_JSON_BYTES_PER_STREAM: usize = 6 * 1024 * 1024;
const FALLBACK_INLINE_BYTES_PER_STREAM: usize = 512 * 1024;
const INLINE_TRUNCATION_MARKER: &[u8] = b"\n... [output omitted] ...\n";
// Model-facing MCP projections are smaller than the Worker capture budget.
// Retain the original streams before any protocol-side presentation trimming.
const RECOVERY_OUTPUT_BYTES: usize = 4 * 1024;
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_TAIL_BYTES: usize = 64 * 1024;

pub struct BashRunTool {
    name: ToolName,
    artifacts: Arc<ArtifactStore>,
    model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
    #[cfg_attr(windows, allow(dead_code))]
    files: Arc<FileToolState>,
    shell: ShellRuntime,
}
impl BashRunTool {
    pub fn new(
        artifacts: Arc<ArtifactStore>,
        model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
        files: Arc<FileToolState>,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            name: bash_run_name(),
            artifacts,
            model_devshell,
            files,
            shell: ShellRuntime::detect()?,
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
            self.shell.catalog_description(),
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
                        "cwd": "Working directory; bare relative and ./ paths are workspace-relative, absolute paths are also accepted.",
                        "stdin": "Omit to send EOF.",
                        "timeoutMs": "Required timeout in milliseconds."
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
        let timeout_ms = params.timeout_ms;
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
                "timeoutMs cannot exceed 100000; use tmux_run for long-running commands",
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
        let read_plan = CommandReadPlan::analyze(&params.command, &cwd.canonical);
        let execution = crate::capability::execution::ExecutionConfig::from_env()
            .map_err(|error| ToolError::new("execution.invalidConfig", error))?;
        if let Some(config) = execution.as_ref() {
            let mut effective_env = config
                .environment(cwd.access_path())
                .map_err(|error| ToolError::new("execution.providerFailed", error))?;
            for (key, value) in std::mem::take(&mut params.env) {
                effective_env.insert(key, value);
            }
            params.env = effective_env;
        }
        let requested_path = match params.env.get("PATH") {
            Some(Some(value)) => Some(value.as_str()),
            Some(None) => Some(""),
            None => None,
        };
        if let Some(environment) = self.model_devshell.environment(&call, None, requested_path) {
            environment.inject(&mut params.env);
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

struct StreamOutput {
    kept: Vec<u8>,
    truncated: bool,
    artifact_draft: Option<ArtifactDraft>,
    artifact_warning: Option<String>,
}
fn resolve_cwd(call: &ToolCall, raw: Option<&str>) -> Result<ResolvedPath, ToolError> {
    let normalized = normalize_requested_path(raw.unwrap_or("./"))
        .map_err(|error| ToolError::new("bash.invalidCwd", error.message))?;
    let requested = parse_requested_path(&normalized)
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
fn spawn_reader(
    mut reader: impl Read + Send + 'static,
    bytes: Arc<AtomicUsize>,
    max: usize,
    mut artifact_draft: Option<ArtifactDraft>,
    mut artifact_warning: Option<String>,
    progress: Arc<BashProgress>,
    progress_stream: BashProgressStream,
) -> thread::JoinHandle<Result<StreamOutput, ToolError>> {
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        let head_limit = max / 2;
        let tail_limit = max - head_limit;
        let mut head = Vec::with_capacity(head_limit);
        let mut tail = VecDeque::with_capacity(tail_limit);
        let mut truncated = false;
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| ToolError::new("bash.ioFailed", error.to_string()))?;
            if count == 0 {
                break;
            }
            bytes.fetch_add(count, Ordering::SeqCst);
            progress.append(progress_stream, &buffer[..count]);
            if let Some(draft) = artifact_draft.as_mut()
                && let Err(error) = draft.write_chunk(&buffer[..count])
            {
                artifact_draft = None;
                artifact_warning = Some(error.message);
            }
            let mut offset = 0;
            if head.len() < head_limit {
                let kept = (head_limit - head.len()).min(count);
                head.extend_from_slice(&buffer[..kept]);
                offset = kept;
            }
            for byte in &buffer[offset..count] {
                if tail_limit == 0 {
                    truncated = true;
                    continue;
                }
                if tail.len() == tail_limit {
                    tail.pop_front();
                    truncated = true;
                }
                tail.push_back(*byte);
            }
        }
        let mut kept = head;
        kept.extend(tail);
        Ok(StreamOutput {
            kept,
            truncated,
            artifact_draft,
            artifact_warning,
        })
    })
}

#[derive(Clone, Copy)]
enum BashProgressStream {
    Stdout,
    Stderr,
}

struct BashProgress {
    emitter: ToolProgressEmitter,
    inner: Mutex<BashProgressState>,
    started: Instant,
}

struct BashProgressState {
    finished: bool,
    flush_sequence: u64,
    last_emit: Option<Instant>,
    scheduled_flush: Option<u64>,
    stderr: VecDeque<u8>,
    stderr_bytes: usize,
    stdout: VecDeque<u8>,
    stdout_bytes: usize,
}

impl BashProgress {
    fn new(started: Instant, emitter: ToolProgressEmitter) -> Self {
        Self {
            emitter,
            inner: Mutex::new(BashProgressState {
                finished: false,
                flush_sequence: 0,
                last_emit: None,
                scheduled_flush: None,
                stderr: VecDeque::with_capacity(PROGRESS_TAIL_BYTES),
                stderr_bytes: 0,
                stdout: VecDeque::with_capacity(PROGRESS_TAIL_BYTES),
                stdout_bytes: 0,
            }),
            started,
        }
    }

    fn emit_initial(&self) {
        self.emitter.emit(serde_json::json!({
            "durationMs": 0,
            "stderr": "",
            "stderrBytes": 0,
            "stdout": "",
            "stdoutBytes": 0,
            "termination": "running",
        }));
    }

    fn append(self: &Arc<Self>, stream: BashProgressStream, bytes: &[u8]) {
        let (snapshot, scheduled) = {
            let Ok(mut state) = self.inner.lock() else {
                return;
            };
            if state.finished {
                return;
            }
            match stream {
                BashProgressStream::Stdout => {
                    state.stdout_bytes = state.stdout_bytes.saturating_add(bytes.len());
                    append_progress_tail(&mut state.stdout, bytes);
                }
                BashProgressStream::Stderr => {
                    state.stderr_bytes = state.stderr_bytes.saturating_add(bytes.len());
                    append_progress_tail(&mut state.stderr, bytes);
                }
            }
            let now = Instant::now();
            if let Some(last_emit) = state.last_emit {
                let elapsed = now.duration_since(last_emit);
                if elapsed < PROGRESS_EMIT_INTERVAL {
                    let scheduled = if state.scheduled_flush.is_none() {
                        state.flush_sequence = state.flush_sequence.saturating_add(1);
                        let id = state.flush_sequence;
                        state.scheduled_flush = Some(id);
                        Some((id, PROGRESS_EMIT_INTERVAL - elapsed))
                    } else {
                        None
                    };
                    (None, scheduled)
                } else {
                    state.last_emit = Some(now);
                    state.scheduled_flush = None;
                    (Some(self.snapshot(&state)), None)
                }
            } else {
                state.last_emit = Some(now);
                (Some(self.snapshot(&state)), None)
            }
        };
        if let Some(snapshot) = snapshot {
            self.emitter.emit(snapshot);
        }
        if let Some((id, delay)) = scheduled {
            let progress = Arc::clone(self);
            thread::spawn(move || {
                thread::sleep(delay);
                progress.flush_scheduled(id);
            });
        }
    }

    fn finish(&self) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        state.finished = true;
        state.scheduled_flush = None;
    }

    fn flush_scheduled(&self, id: u64) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        if state.finished || state.scheduled_flush != Some(id) {
            return;
        }
        state.scheduled_flush = None;
        state.last_emit = Some(Instant::now());
        self.emitter.emit(self.snapshot(&state));
    }

    fn snapshot(&self, state: &BashProgressState) -> serde_json::Value {
        let stdout = state.stdout.iter().copied().collect::<Vec<_>>();
        let stderr = state.stderr.iter().copied().collect::<Vec<_>>();
        serde_json::json!({
            "durationMs": self.started.elapsed().as_millis(),
            "stderr": String::from_utf8_lossy(&stderr).to_string(),
            "stderrBytes": state.stderr_bytes,
            "stdout": String::from_utf8_lossy(&stdout).to_string(),
            "stdoutBytes": state.stdout_bytes,
            "termination": "running",
        })
    }
}

fn append_progress_tail(tail: &mut VecDeque<u8>, bytes: &[u8]) {
    for byte in bytes {
        if tail.len() == PROGRESS_TAIL_BYTES {
            tail.pop_front();
        }
        tail.push_back(*byte);
    }
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

fn enforce_inline_rpc_budget(output: &mut StreamOutput) {
    if json_string_upper_bound(&output.kept) <= MAX_INLINE_JSON_BYTES_PER_STREAM {
        return;
    }
    let kept_budget =
        FALLBACK_INLINE_BYTES_PER_STREAM.saturating_sub(INLINE_TRUNCATION_MARKER.len());
    if output.kept.len() > kept_budget {
        let head = kept_budget / 2;
        let tail = kept_budget - head;
        let mut kept = Vec::with_capacity(kept_budget);
        kept.extend_from_slice(&output.kept[..head]);
        kept.extend_from_slice(&output.kept[output.kept.len() - tail..]);
        output.kept = kept;
    }
    output.truncated = true;
}

fn render_inline_stream(output: &StreamOutput) -> String {
    if !output.truncated {
        return String::from_utf8_lossy(&output.kept).to_string();
    }
    let split = output.kept.len() / 2;
    let mut rendered = Vec::with_capacity(output.kept.len() + INLINE_TRUNCATION_MARKER.len());
    rendered.extend_from_slice(&output.kept[..split]);
    rendered.extend_from_slice(INLINE_TRUNCATION_MARKER);
    rendered.extend_from_slice(&output.kept[split..]);
    String::from_utf8_lossy(&rendered).to_string()
}

fn json_string_upper_bound(bytes: &[u8]) -> usize {
    let body = match std::str::from_utf8(bytes) {
        Ok(text) => text
            .chars()
            .map(|character| match character {
                '"' | '\\' => 2,
                '\u{00}'..='\u{1f}' => 6,
                _ => character.len_utf8(),
            })
            .sum::<usize>(),
        Err(_) => bytes
            .iter()
            .map(|byte| match byte {
                b'"' | b'\\' => 2,
                0x00..=0x1f => 6,
                0x20..=0x7e => 1,
                _ => 3,
            })
            .sum::<usize>(),
    };
    body.saturating_add(2)
}

fn begin_artifact(
    store: &ArtifactStore,
    stream: ArtifactStream,
) -> (Option<ArtifactDraft>, Option<String>) {
    match store.begin(stream) {
        Ok(draft) => (Some(draft), None),
        Err(error) => (None, Some(error.message)),
    }
}

fn persist_artifact(
    store: &ArtifactStore,
    output: &mut StreamOutput,
    stream_name: &str,
    retain: bool,
    warnings: &mut Vec<String>,
) -> Option<ArtifactReference> {
    if let Some(warning) = output.artifact_warning.take() {
        warnings.push(format!("{stream_name} artifact unavailable: {warning}"));
    }
    if !output.truncated && !retain {
        output.artifact_draft.take();
        return None;
    }
    let draft = output.artifact_draft.take()?;
    match store.persist(draft) {
        Ok(reference) => Some(reference),
        Err(error) => {
            warnings.push(format!(
                "{stream_name} artifact could not be persisted: {}",
                error.message
            ));
            None
        }
    }
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
        match child_exited_without_reaping(&mut child.child) {
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
fn child_exited_without_reaping(child: &mut Child) -> std::io::Result<bool> {
    use nix::libc;

    // Child::try_wait() reaps the group leader. Its PID could then be reused
    // before terminate_group() cleans up shell descendants, making killpg()
    // target an unrelated group. WNOWAIT holds the leader until wait_and_reap().
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(unsafe { info.si_pid() != 0 });
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(windows)]
fn child_exited_without_reaping(child: &mut Child) -> std::io::Result<bool> {
    Ok(child.try_wait()?.is_some())
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

    use super::{BashWaitOutcome, ManagedBashChild, child_exited_without_reaping, wait};

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
