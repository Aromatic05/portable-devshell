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
const INLINE_TAIL_TRUNCATION_MARKER: &[u8] =
    b"\n... [capture limit reached; further output omitted] ...\n";
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_TAIL_BYTES: usize = 64 * 1024;

pub(in crate::tool) struct StreamOutput {
    pub(in crate::tool) kept: Vec<u8>,
    pub(in crate::tool) middle_truncated: bool,
    pub(in crate::tool) head_len: usize,
    pub(in crate::tool) tail_truncated: bool,
    pub(in crate::tool) artifact_draft: Option<ArtifactDraft>,
    pub(in crate::tool) artifact_warning: Option<String>,
}

impl StreamOutput {
    pub(in crate::tool) fn is_truncated(&self) -> bool {
        self.middle_truncated || self.tail_truncated
    }
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
        let mut middle_truncated = false;
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| ToolError::new("process.ioFailed", error.to_string()))?;
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
                    middle_truncated = true;
                    continue;
                }
                if tail.len() == tail_limit {
                    tail.pop_front();
                    middle_truncated = true;
                }
                tail.push_back(*byte);
            }
        }
        let head_len = if middle_truncated { head.len() } else { 0 };
        let mut kept = head;
        kept.extend(tail);
        Ok(StreamOutput {
            kept,
            middle_truncated,
            head_len,
            tail_truncated: false,
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

    pub(in crate::tool) fn append(self: &Arc<Self>, stream: BashProgressStream, bytes: &[u8]) {
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

    pub(in crate::tool) fn has_output(&self) -> bool {
        self.inner
            .lock()
            .is_ok_and(|state| state.stdout_bytes > 0 || state.stderr_bytes > 0)
    }

    pub(in crate::tool) fn emit_heartbeat(&self) {
        let snapshot = {
            let Ok(mut state) = self.inner.lock() else {
                return;
            };
            if state.finished {
                return;
            }
            state.last_emit = Some(Instant::now());
            state.scheduled_flush = None;
            self.snapshot(&state)
        };
        self.emitter.emit(snapshot);
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
        let head = utf8_floor_boundary(&output.kept, kept_budget / 2);
        let tail_start = utf8_ceil_boundary(
            &output.kept,
            output.kept.len().saturating_sub(kept_budget - head),
        );
        let mut kept = Vec::with_capacity(head + output.kept.len().saturating_sub(tail_start));
        kept.extend_from_slice(&output.kept[..head]);
        kept.extend_from_slice(&output.kept[tail_start..]);
        output.kept = kept;
        output.middle_truncated = true;
        output.head_len = head;
    }
}

pub(in crate::tool) fn render_inline_stream(output: &StreamOutput) -> String {
    if output.middle_truncated {
        let split = output.head_len.min(output.kept.len());
        let head_end = utf8_floor_boundary(&output.kept[..split], split);
        let tail_start = utf8_ceil_boundary(&output.kept, split);
        let extra = INLINE_TRUNCATION_MARKER.len()
            + if output.tail_truncated {
                INLINE_TAIL_TRUNCATION_MARKER.len()
            } else {
                0
            };
        let mut rendered = Vec::with_capacity(output.kept.len() + extra);
        rendered.extend_from_slice(&output.kept[..head_end]);
        rendered.extend_from_slice(INLINE_TRUNCATION_MARKER);
        rendered.extend_from_slice(&output.kept[tail_start..]);
        if output.tail_truncated {
            rendered.extend_from_slice(INLINE_TAIL_TRUNCATION_MARKER);
        }
        return String::from_utf8_lossy(&rendered).to_string();
    }
    if output.tail_truncated {
        if output.kept.is_empty() {
            return String::new();
        }
        let mut rendered = String::from_utf8_lossy(&output.kept).into_owned();
        rendered.push_str(std::str::from_utf8(INLINE_TAIL_TRUNCATION_MARKER).unwrap_or_default());
        return rendered;
    }
    String::from_utf8_lossy(&output.kept).to_string()
}

fn utf8_floor_boundary(bytes: &[u8], mut index: usize) -> usize {
    index = index.min(bytes.len());
    if index < bytes.len() {
        while index > 0 && (bytes[index] & 0xC0) == 0x80 {
            index -= 1;
        }
    }
    if index > 0 {
        // Ensure the prefix up to `index` does not end with an incomplete multi-byte sequence.
        let mut check_start = index;
        while check_start > 0
            && index - check_start < 3
            && (bytes[check_start - 1] & 0xC0) == 0x80
        {
            check_start -= 1;
        }
        if check_start > 0 && (bytes[check_start - 1] & 0x80) != 0 {
            check_start -= 1;
        }
        if let Err(err) = std::str::from_utf8(&bytes[check_start..index])
            && err.error_len().is_none()
        {
            return check_start + err.valid_up_to();
        }
    }
    index
}

fn utf8_ceil_boundary(bytes: &[u8], mut index: usize) -> usize {
    index = index.min(bytes.len());
    while index < bytes.len() && (bytes[index] & 0xC0) == 0x80 {
        index += 1;
    }
    index
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
    if !output.is_truncated() && !retain {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_truncation_preserves_multibyte_utf8_boundaries() {
        let mut kept = Vec::new();
        for _ in 0..400_000 {
            kept.extend_from_slice("你好世界🚀\n".as_bytes());
        }
        let mut output = StreamOutput {
            kept,
            middle_truncated: false,
            head_len: 0,
            tail_truncated: false,
            artifact_draft: None,
            artifact_warning: None,
        };
        enforce_inline_rpc_budget(&mut output);
        assert!(output.is_truncated());
        assert!(output.middle_truncated);
        let rendered = render_inline_stream(&output);
        assert!(rendered.contains("... [output omitted] ..."));
        assert!(
            !rendered.contains('\u{FFFD}'),
            "truncation must not split UTF-8 codepoints"
        );
    }

    #[test]
    fn tail_truncation_with_non_empty_bytes_does_not_split_middle() {
        let output = StreamOutput {
            kept: b"line1\nline2\nline3".to_vec(),
            middle_truncated: false,
            head_len: 0,
            tail_truncated: true,
            artifact_draft: None,
            artifact_warning: None,
        };
        let rendered = render_inline_stream(&output);
        assert_eq!(
            rendered,
            "line1\nline2\nline3\n... [capture limit reached; further output omitted] ...\n"
        );
        assert!(!rendered.contains("... [output omitted] ..."));
    }

    #[test]
    fn tail_truncation_with_empty_bytes_returns_empty_string() {
        let output = StreamOutput {
            kept: Vec::new(),
            middle_truncated: false,
            head_len: 0,
            tail_truncated: true,
            artifact_draft: None,
            artifact_warning: None,
        };
        assert_eq!(render_inline_stream(&output), "");
    }

    #[test]
    fn middle_truncation_with_multibyte_utf8_preserves_head_len_boundary() {
        let head = "你🚀".as_bytes(); // 3 + 4 = 7 bytes
        let tail = "世A界".as_bytes(); // 3 + 1 + 3 = 7 bytes
        // Slice head in the middle of 🚀 (keep 3 + 2 = 5 bytes) and tail in the middle of 世 (skip 1 byte)
        let mut kept = Vec::new();
        kept.extend_from_slice(&head[..5]);
        let head_len = kept.len();
        kept.extend_from_slice(&tail[1..]);

        let output = StreamOutput {
            kept,
            middle_truncated: true,
            head_len,
            tail_truncated: false,
            artifact_draft: None,
            artifact_warning: None,
        };
        let rendered = render_inline_stream(&output);
        assert_eq!(rendered, "你\n... [output omitted] ...\nA界");
        assert!(
            !rendered.contains('\u{FFFD}'),
            "middle truncation must not emit replacement char: {rendered:?}"
        );

        let both = StreamOutput {
            tail_truncated: true,
            ..output
        };
        let rendered_both = render_inline_stream(&both);
        assert_eq!(
            rendered_both,
            "你\n... [output omitted] ...\nA界\n... [capture limit reached; further output omitted] ...\n"
        );
    }
}
