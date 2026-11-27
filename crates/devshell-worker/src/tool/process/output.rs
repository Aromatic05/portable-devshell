use super::capture::{
    BashProgress, BashProgressStream, StreamOutput, begin_artifact, enforce_inline_rpc_budget,
    persist_artifact, render_inline_stream, spawn_reader,
};
use super::model::{BashRunOutput, BashTermination, TaskCursor, TaskDescriptor};
use super::scope::rpc;
use crate::capability::artifact::{
    result_path::tool_result_path, store::ArtifactStore, types::ArtifactStream,
};
use crate::capability::process::client::ProcessHostClient;
use crate::capability::process::{CaptureBounds, CaptureSnapshot};
use crate::tool::ToolError;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, Read};
use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturePage {
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OutputBoundary {
    latest_seq: u64,
    shell_generation: u64,
    capture: CaptureSnapshot,
}

impl OutputBoundary {
    pub(super) fn from_descriptor(descriptor: &Value) -> Result<Self, ToolError> {
        Self::deserialize(descriptor)
            .map_err(|error| ToolError::new("process.internal", error.to_string()))
    }

    pub(super) fn cursor(&self) -> TaskCursor {
        TaskCursor {
            generation: Some(self.shell_generation),
            seq: self.latest_seq,
            stdout: self.capture.stdout.source_bytes,
            stderr: self.capture.stderr.source_bytes,
        }
    }
}

struct CaptureReader {
    client: ProcessHostClient,
    id: String,
    channel: &'static str,
    offset: usize,
    end: usize,
    pending: std::io::Cursor<Vec<u8>>,
    shell_generation: Option<u64>,
}

impl Read for CaptureReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let count = self.pending.read(buffer)?;
        if count != 0 {
            return Ok(count);
        }
        if self.offset >= self.end {
            return Ok(0);
        }
        let page = capture(
            &self.client,
            &self.id,
            self.channel,
            self.offset,
            (self.end - self.offset).min(256 * 1024),
            self.shell_generation,
        )
        .map_err(|error| io::Error::other(error.message))?;
        let bytes = STANDARD
            .decode(page.data_base64)
            .map_err(io::Error::other)?;
        if bytes.is_empty() {
            return Err(io::Error::other(
                "capture ended before its published boundary",
            ));
        }
        self.offset += bytes.len();
        self.pending = io::Cursor::new(bytes);
        self.pending.read(buffer)
    }
}

fn capture(
    client: &ProcessHostClient,
    id: &str,
    channel: &'static str,
    offset: usize,
    limit: usize,
    shell_generation: Option<u64>,
) -> Result<CapturePage, ToolError> {
    serde_json::from_value(rpc(
        client,
        "process.v1.capture",
        json!({
            "id": id, "channel": channel, "offset": offset, "limit": limit,
            "shellGeneration": shell_generation,
        }),
    )?)
    .map_err(|error_value| ToolError::new("process.captureFailed", error_value.to_string()))
}

#[allow(clippy::too_many_arguments)]
fn collect_stream<R: Read + Send + 'static>(
    artifacts: &ArtifactStore,
    metadata: &CaptureBounds,
    offset: usize,
    max: usize,
    progress: Arc<BashProgress>,
    stream: ArtifactStream,
    progress_stream: BashProgressStream,
    open_reader: impl FnOnce(Range<usize>) -> R,
) -> Result<(StreamOutput, usize), ToolError> {
    if offset > metadata.source_bytes {
        return Err(ToolError::new(
            "process.captureFailed",
            "output cursor exceeds source bytes",
        ));
    }
    // A cursor accounts for omitted source bytes, but only the retained prefix is readable.
    let source_delta = metadata.source_bytes - offset;
    let retained = offset.min(metadata.stored_bytes)..metadata.stored_bytes;
    let retained_len = retained.len();
    let tail_truncated = metadata.truncated && source_delta > retained_len;
    let reader = open_reader(retained);
    let bytes = Arc::new(AtomicUsize::new(0));
    let (draft, warning) = begin_artifact(artifacts, stream);
    let mut output = spawn_reader(
        reader,
        Arc::clone(&bytes),
        max,
        draft,
        warning,
        progress,
        progress_stream,
    )
    .join()
    .map_err(|_| ToolError::new("process.ioFailed", "capture reader panicked"))??;
    if tail_truncated {
        output.tail_truncated = true;
        if retained_len == 0 {
            output.artifact_draft = None;
            output.artifact_warning = Some("Process Host capture limit reached".into());
        } else if let Some(draft) = output.artifact_draft.as_mut() {
            draft.mark_omitted_tail(source_delta - retained_len);
        }
    }
    enforce_inline_rpc_budget(&mut output);
    Ok((output, source_delta))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn collect(
    client: &ProcessHostClient,
    artifacts: &ArtifactStore,
    id: &str,
    descriptor: Value,
    cursor: TaskCursor,
    max: usize,
    started: Instant,
    progress: Arc<BashProgress>,
) -> Result<BashRunOutput, ToolError> {
    let open_reader = |channel, range: Range<usize>| CaptureReader {
        client: client.clone(),
        id: id.into(),
        channel,
        offset: range.start,
        end: range.end,
        pending: io::Cursor::new(Vec::new()),
        shell_generation: cursor.generation,
    };
    collect_with_reader(artifacts, id, descriptor, cursor, max, started, progress, open_reader)
}

#[allow(clippy::too_many_arguments)]
fn collect_with_reader<R: Read + Send + 'static>(
    artifacts: &ArtifactStore,
    id: &str,
    descriptor: Value,
    cursor: TaskCursor,
    max: usize,
    started: Instant,
    progress: Arc<BashProgress>,
    open_reader: impl Fn(&'static str, Range<usize>) -> R,
) -> Result<BashRunOutput, ToolError> {
    if descriptor["state"] == "failed" {
        progress.finish();
        let (Some(code), Some(message)) = (
            descriptor["errorCode"].as_str(),
            descriptor["error"].as_str(),
        ) else {
            return Err(ToolError::new("process.internal", "invalid failed process descriptor"));
        };
        return Err(ToolError::new(code, message));
    }
    if progress.has_output() {
        progress.finish();
    }
    // Both stream bounds and latestSeq come from one host state lock. Only read
    // up to those bounds, even if more bytes arrive during capture paging.
    let boundary = OutputBoundary::from_descriptor(&descriptor)?;
    if cursor
        .generation
        .is_some_and(|generation| generation != boundary.shell_generation)
    {
        return Err(ToolError::new(
            "process.staleCursor",
            "task cursor belongs to a previous shell instance",
        ));
    }
    let (mut stdout, stdout_bytes) = collect_stream(
        artifacts,
        &boundary.capture.stdout,
        cursor.stdout,
        max,
        Arc::clone(&progress),
        ArtifactStream::Stdout,
        BashProgressStream::Stdout,
        |range| open_reader("stdout", range),
    )?;
    let (mut stderr, stderr_bytes) = collect_stream(
        artifacts,
        &boundary.capture.stderr,
        cursor.stderr,
        max,
        Arc::clone(&progress),
        ArtifactStream::Stderr,
        BashProgressStream::Stderr,
        |range| open_reader("stderr", range),
    )?;
    progress.finish();
    let retain = stdout.is_truncated()
        || stderr.is_truncated()
        || stdout.kept.len().saturating_add(stderr.kept.len()) > 4096;
    let retain_stdout = retain && !stdout.kept.is_empty();
    let retain_stderr = retain && !stderr.kept.is_empty();
    let mut warnings = Vec::new();
    let stdout_artifact = persist_artifact(
        artifacts,
        &mut stdout,
        "stdout",
        retain_stdout,
        &mut warnings,
    );
    let stderr_artifact = persist_artifact(
        artifacts,
        &mut stderr,
        "stderr",
        retain_stderr,
        &mut warnings,
    );
    let running = descriptor["state"] == "running";
    let signal = descriptor["exit"]["signal"]
        .as_i64()
        .filter(|signal| *signal != 0)
        .map(|signal| signal as i32);
    let exit_code = descriptor["exit"]["exitCode"]
        .as_i64()
        .filter(|code| *code >= 0)
        .map(|code| code as i32);
    let timed_out = descriptor["timedOut"] == true;
    let termination = if running {
        BashTermination::Running
    } else if timed_out {
        BashTermination::Timeout
    } else if signal.is_some() {
        BashTermination::Signaled
    } else {
        BashTermination::Exited
    };
    let status = if running {
        "running".into()
    } else {
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "failed".into())
    };
    Ok(BashRunOutput {
        exit_code: if termination == BashTermination::Exited {
            exit_code
        } else {
            None
        },
        term_signal: signal,
        timed_out: timed_out.then_some(true),
        stdout: render_inline_stream(&stdout),
        stderr: render_inline_stream(&stderr),
        stdout_bytes,
        stderr_bytes,
        stdout_truncated: stdout.is_truncated(),
        stderr_truncated: stderr.is_truncated(),
        stdout_path: stdout_artifact.as_ref().map(tool_result_path),
        stderr_path: stderr_artifact.as_ref().map(tool_result_path),
        stdout_artifact,
        stderr_artifact,
        artifact_warnings: (!warnings.is_empty()).then_some(warnings),
        duration_ms: started.elapsed().as_millis(),
        termination,
        wait_reason: None,
        wait_ms: None,
        until_exit: None,
        task: Some(TaskDescriptor {
            id: id.into(),
            status,
            pty: descriptor["pty"] == true || descriptor["tty"] == true,
            human_control: (descriptor["humanControl"] == true).then_some(true),
            alternate_screen: (descriptor["alternateScreen"] == true).then_some(true),
        }),
        cursor: Some(boundary.cursor().encode(id)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::ToolProgressEmitter;

    #[test]
    fn polling_truncated_capture_counts_only_new_source_bytes() {
        let root = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let task = "proc-1";
        let boundary = |seq, source_bytes| {
            json!({
                "state": "running", "latestSeq": seq, "shellGeneration": 1,
                "capture": {
                    "stdout": {"sourceBytes": source_bytes, "storedBytes": 2, "truncated": true},
                    "stderr": {"sourceBytes": 3, "storedBytes": 2, "truncated": true},
                },
            })
        };
        let open_reader = |channel, range: Range<usize>| {
            let retained = match channel {
                "stdout" => b"ab",
                "stderr" => b"xy",
                _ => panic!("unexpected channel: {channel}"),
            };
            &retained[range]
        };
        let poll = |descriptor, cursor| {
            let started = Instant::now();
            let progress = Arc::new(BashProgress::new(started, ToolProgressEmitter::new(|_| {})));
            collect_with_reader(&artifacts, task, descriptor, cursor, 64, started, progress, open_reader)
        };

        let first = poll(boundary(2, 3), TaskCursor::default()).unwrap();
        assert_eq!((first.stdout_bytes, first.stderr_bytes), (3, 3));
        assert!(first.stdout.starts_with("ab\n"));
        assert!(first.stderr.starts_with("xy\n"));
        assert!(first.stdout_truncated);
        assert!(first.stderr_truncated);
        for (artifact, prefix, path) in [
            (first.stdout_artifact.as_ref().unwrap(), b"ab", first.stdout_path.as_ref()),
            (first.stderr_artifact.as_ref().unwrap(), b"xy", first.stderr_path.as_ref()),
        ] {
            assert_eq!(artifact.source_bytes, 3);
            assert_eq!(artifact.stored_bytes, 2);
            assert!(artifact.artifact_truncated);
            assert_eq!(artifact.blake3, blake3::hash(prefix).to_hex().to_string());
            assert_eq!(path, Some(&tool_result_path(artifact)));
            let lease = artifacts.acquire_lease(&artifact.handle, artifact.expires_at_ms).unwrap();
            assert_eq!(std::fs::read(&lease.data_path).unwrap(), prefix);
            artifacts.release_lease(&lease.lease_id).unwrap();
        }
        assert_eq!(first.artifact_warnings.as_deref().unwrap(), [
            "stdout artifact contains only the retained prefix: Process Host capture limit reached",
            "stderr artifact contains only the retained prefix: Process Host capture limit reached",
        ]);
        let cursor = TaskCursor::decode_for(first.cursor.as_deref().unwrap(), task).unwrap();
        let repeated = poll(boundary(2, 3), cursor).unwrap();
        assert_eq!((repeated.stdout_bytes, repeated.stderr_bytes), (0, 0));
        assert_eq!((cursor.seq, cursor.stdout, cursor.stderr), (2, 3, 3));
        assert_eq!(repeated.cursor, first.cursor);
        assert!(repeated.stdout.is_empty());
        assert!(repeated.stderr.is_empty());
        assert!(!repeated.stdout_truncated);
        assert!(!repeated.stderr_truncated);
        assert!(repeated.artifact_warnings.is_none());

        let next = poll(boundary(3, 4), cursor).unwrap();
        assert_eq!((next.stdout_bytes, next.stderr_bytes), (1, 0));
        assert!(next.stdout.is_empty());
        assert!(next.stdout_truncated);
        assert!(next.stdout_artifact.is_none());
        assert!(next.stdout_path.is_none());
        assert!(!next.stderr_truncated);
        assert_eq!(next.artifact_warnings.unwrap(), [
            "stdout artifact unavailable: Process Host capture limit reached",
        ]);
        let cursor = TaskCursor::decode_for(next.cursor.as_deref().unwrap(), task).unwrap();
        assert_eq!((cursor.seq, cursor.stdout, cursor.stderr), (3, 4, 3));

        let error = poll(boundary(3, 4), TaskCursor { stdout: 5, ..cursor }).unwrap_err();
        assert_eq!(error.code, "process.captureFailed");
    }
}
