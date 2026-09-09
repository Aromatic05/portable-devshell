use std::collections::VecDeque;
use std::io::{Read, Write};
use std::ops::{Deref, DerefMut};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::daemon::process_registry::ActiveProcessGuard;
use crate::model_devshell::ModelDevshellShim;
use crate::platform;
use crate::security::path::{
    FilesystemCapability, PathNamespace, ResolvedPath, parse_requested_path,
    resolve_existing_target,
};
use crate::tools::artifact::store::{ArtifactDraft, ArtifactStore};
use crate::tools::artifact::types::{ArtifactReference, ArtifactStream};
use crate::tools::bash::backend::spawn_shell;
use crate::tools::bash::group::bash_run_name;
use crate::tools::bash::runtime::ShellRuntime;
use crate::tools::bash::types::{BashRunOutput, BashRunParams, BashTermination};
use crate::tools::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName,
    ToolProgressEmitter,
};

const DEFAULT_MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 100_000;
const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;
const MAX_INLINE_JSON_BYTES_PER_STREAM: usize = 6 * 1024 * 1024;
const FALLBACK_INLINE_BYTES_PER_STREAM: usize = 512 * 1024;
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_TAIL_BYTES: usize = 64 * 1024;

pub struct BashRunTool {
    name: ToolName,
    artifacts: Arc<ArtifactStore>,
    model_devshell: Arc<ModelDevshellShim>,
    shell: ShellRuntime,
}
impl BashRunTool {
    pub fn new(
        artifacts: Arc<ArtifactStore>,
        model_devshell: Arc<ModelDevshellShim>,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            name: bash_run_name(),
            artifacts,
            model_devshell,
            shell: ShellRuntime::detect()?,
        })
    }
}
impl ToolHandler for BashRunTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<BashRunParams, BashRunOutput>(
            &self.name,
            self.shell.catalog_description(),
            [ToolCapability::Execute],
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
        let requested_path = match params.env.get("PATH") {
            Some(Some(value)) => Some(value.as_str()),
            Some(None) => Some(""),
            None => None,
        };
        if let Some(environment) = self.model_devshell.environment(&call, None, requested_path) {
            environment.inject(&mut params.env);
        }
        let started = Instant::now();
        let mut child = spawn_shell(&self.shell, &params.command, &cwd, &params.env)?;
        let pid = child.id() as i32;
        let process_guard = match call.process_registry.register(pid) {
            Ok(process_guard) => process_guard,
            Err(error) => {
                let _ = child.wait();
                return Err(ToolError::new("bash.spawnFailed", error));
            }
        };
        let mut child = ManagedBashChild::new(child, pid, process_guard);
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
        let wait_outcome = wait(&mut child, pid, deadline, &call.cancellation)?;
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
        let stdout_artifact = persist_artifact(
            &self.artifacts,
            &mut stdout,
            "stdout",
            &mut artifact_warnings,
        );
        let stderr_artifact = persist_artifact(
            &self.artifacts,
            &mut stderr,
            "stderr",
            &mut artifact_warnings,
        );
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
        crate::tools::contract::serialize(BashRunOutput {
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
            stdout: String::from_utf8_lossy(&stdout.kept).to_string(),
            stderr: String::from_utf8_lossy(&stderr.kept).to_string(),
            stdout_bytes: stdout_bytes.load(Ordering::SeqCst),
            stderr_bytes: stderr_bytes.load(Ordering::SeqCst),
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
            stdout_artifact,
            stderr_artifact,
            artifact_warnings: (!artifact_warnings.is_empty()).then_some(artifact_warnings),
            duration_ms: started.elapsed().as_millis(),
            termination,
        })
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
    artifact_draft: Option<ArtifactDraft>,
    artifact_warning: Option<String>,
}
fn resolve_cwd(call: &ToolCall, raw: Option<&str>) -> Result<ResolvedPath, ToolError> {
    let requested = parse_requested_path(raw.unwrap_or("./"))
        .map_err(|_| ToolError::new("bash.invalidCwd", "cwd must use `./` or `/` syntax"))?;
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
            if offset < count && head.len() + tail.len() >= max {
                truncated = true;
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
    if output.kept.len() > FALLBACK_INLINE_BYTES_PER_STREAM {
        let head = FALLBACK_INLINE_BYTES_PER_STREAM / 2;
        let tail = FALLBACK_INLINE_BYTES_PER_STREAM - head;
        let mut kept = Vec::with_capacity(FALLBACK_INLINE_BYTES_PER_STREAM);
        kept.extend_from_slice(&output.kept[..head]);
        kept.extend_from_slice(&output.kept[output.kept.len() - tail..]);
        output.kept = kept;
    }
    output.truncated = true;
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
    warnings: &mut Vec<String>,
) -> Option<ArtifactReference> {
    if let Some(warning) = output.artifact_warning.take() {
        warnings.push(format!("{stream_name} artifact unavailable: {warning}"));
    }
    if !output.truncated {
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
    child: &mut Child,
    pid: i32,
    deadline: Instant,
    cancellation: &crate::tools::ToolCancellation,
) -> Result<BashWaitOutcome, ToolError> {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                terminate(pid)?;
                return Ok(BashWaitOutcome::Termination(BashTermination::Exited));
            }
            Ok(None) => {}
            Err(error) => return Err(ToolError::new("bash.ioFailed", error.to_string())),
        }
        if cancellation.is_cancelled() {
            terminate(pid)?;
            return Ok(BashWaitOutcome::Cancelled);
        }
        let now = Instant::now();
        if now >= deadline {
            terminate(pid)?;
            return Ok(BashWaitOutcome::Termination(BashTermination::Timeout));
        }
        thread::sleep(Duration::from_millis(10).min(deadline.saturating_duration_since(now)));
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
