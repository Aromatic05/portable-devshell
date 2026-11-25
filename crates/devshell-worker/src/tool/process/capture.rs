use crate::capability::artifact::{
    store::{ArtifactDraft, ArtifactStore},
    types::{ArtifactReference, ArtifactStream},
};
use crate::tool::{ToolError, ToolProgressEmitter};
use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
const MAX_INLINE_JSON_BYTES_PER_STREAM: usize = 6 * 1024 * 1024;
const FALLBACK_INLINE_BYTES_PER_STREAM: usize = 512 * 1024;
const INLINE_TRUNCATION_MARKER: &[u8] = b"\n... [output omitted] ...\n";
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_TAIL_BYTES: usize = 64 * 1024;

pub(in crate::tool) struct StreamOutput {
    pub(in crate::tool) kept: Vec<u8>,
    pub(in crate::tool) truncated: bool,
    pub(in crate::tool) artifact_draft: Option<ArtifactDraft>,
    pub(in crate::tool) artifact_warning: Option<String>,
}

pub(in crate::tool) fn spawn_reader(
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
pub(in crate::tool) enum BashProgressStream {
    Stdout,
    Stderr,
}

pub(in crate::tool) struct BashProgress {
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
    pub(in crate::tool) fn new(started: Instant, emitter: ToolProgressEmitter) -> Self {
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

    pub(in crate::tool) fn emit_initial(&self) {
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

    pub(in crate::tool) fn finish(&self) {
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

pub(in crate::tool) fn enforce_inline_rpc_budget(output: &mut StreamOutput) {
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

pub(in crate::tool) fn render_inline_stream(output: &StreamOutput) -> String {
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

pub(in crate::tool) fn begin_artifact(
    store: &ArtifactStore,
    stream: ArtifactStream,
) -> (Option<ArtifactDraft>, Option<String>) {
    match store.begin(stream) {
        Ok(draft) => (Some(draft), None),
        Err(error) => (None, Some(error.message)),
    }
}

pub(in crate::tool) fn persist_artifact(
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
