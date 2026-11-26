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
    capture: CaptureSnapshot,
}

impl OutputBoundary {
    pub(super) fn from_descriptor(descriptor: &Value) -> Result<Self, ToolError> {
        Self::deserialize(descriptor)
            .map_err(|error| ToolError::new("process.internal", error.to_string()))
    }

    pub(super) fn cursor(&self) -> TaskCursor {
        TaskCursor {
            seq: self.latest_seq,
            stdout: self.capture.stdout.stored_bytes,
            stderr: self.capture.stderr.stored_bytes,
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
) -> Result<CapturePage, ToolError> {
    serde_json::from_value(rpc(
        client,
        "process.v1.capture",
        json!({
            "id": id, "channel": channel, "offset": offset, "limit": limit,
        }),
    )?)
    .map_err(|error_value| ToolError::new("process.captureFailed", error_value.to_string()))
}

#[allow(clippy::too_many_arguments)]
fn collect_stream(
    client: &ProcessHostClient,
    artifacts: &ArtifactStore,
    id: &str,
    channel: &'static str,
    metadata: &CaptureBounds,
    offset: usize,
    max: usize,
    progress: Arc<BashProgress>,
    stream: ArtifactStream,
    progress_stream: BashProgressStream,
) -> Result<(StreamOutput, usize), ToolError> {
    if offset > metadata.stored_bytes {
        return Err(ToolError::new(
            "process.captureFailed",
            "output cursor exceeds retained capture",
        ));
    }
    let reader = CaptureReader {
        client: client.clone(),
        id: id.into(),
        channel,
        offset,
        end: metadata.stored_bytes,
        pending: std::io::Cursor::new(Vec::new()),
    };
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
    if metadata.truncated {
        output.truncated = true;
        output.artifact_draft = None;
        output.artifact_warning = Some("Process Host capture limit reached".into());
    }
    enforce_inline_rpc_budget(&mut output);
    Ok((
        output,
        metadata.source_bytes.saturating_sub(offset),
    ))
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
    let (mut stdout, stdout_bytes) = collect_stream(
        client,
        artifacts,
        id,
        "stdout",
        &boundary.capture.stdout,
        cursor.stdout,
        max,
        Arc::clone(&progress),
        ArtifactStream::Stdout,
        BashProgressStream::Stdout,
    )?;
    let (mut stderr, stderr_bytes) = collect_stream(
        client,
        artifacts,
        id,
        "stderr",
        &boundary.capture.stderr,
        cursor.stderr,
        max,
        Arc::clone(&progress),
        ArtifactStream::Stderr,
        BashProgressStream::Stderr,
    )?;
    progress.finish();
    let retain = stdout.truncated
        || stderr.truncated
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
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
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
        }),
        cursor: Some(boundary.cursor().encode(id)),
    })
}
