use super::capture::{
    BashProgress, BashProgressStream, StreamOutput, begin_artifact, enforce_inline_rpc_budget,
    persist_artifact, render_inline_stream, spawn_reader,
};
use super::model::{BashRunOutput, BashTermination, TaskCursor, TaskDescriptor};
use super::scope::{error, rpc};
use crate::capability::artifact::{
    result_path::tool_result_path, store::ArtifactStore, types::ArtifactStream,
};
use crate::capability::process::client::ProcessHostClient;
use crate::tool::{ToolCall, ToolError};
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
    source_bytes: usize,
    stored_bytes: usize,
    truncated: bool,
    data_base64: String,
    #[serde(default)]
    latest_seq: u64,
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
    .map_err(|error_value| error(error_value.to_string()))
}

fn collect_stream(
    client: &ProcessHostClient,
    artifacts: &ArtifactStore,
    id: &str,
    channel: &'static str,
    offset: usize,
    max: usize,
    progress: Arc<BashProgress>,
    stream: ArtifactStream,
    progress_stream: BashProgressStream,
) -> Result<(StreamOutput, usize, usize, u64), ToolError> {
    let metadata = capture(client, id, channel, offset, 0)?;
    if offset > metadata.stored_bytes {
        return Err(error("output cursor exceeds retained capture"));
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
    .map_err(|_| error("capture reader panicked"))??;
    if metadata.truncated {
        output.truncated = true;
        output.artifact_draft = None;
        output.artifact_warning = Some("Process Host capture limit reached".into());
    }
    enforce_inline_rpc_budget(&mut output);
    Ok((
        output,
        metadata.source_bytes.saturating_sub(offset),
        metadata.stored_bytes,
        metadata.latest_seq,
    ))
}

pub(super) fn collect(
    client: &ProcessHostClient,
    artifacts: &ArtifactStore,
    id: &str,
    descriptor: Value,
    cursor: TaskCursor,
    max: usize,
    started: Instant,
    call: &ToolCall,
) -> Result<BashRunOutput, ToolError> {
    if descriptor["state"] == "failed" {
        return Err(error(
            descriptor["error"].as_str().unwrap_or("process failed"),
        ));
    }
    let progress = Arc::new(BashProgress::new(started, call.progress()));
    progress.emit_initial();
    let (mut stdout, stdout_bytes, stdout_end, stdout_seq) = collect_stream(
        client,
        artifacts,
        id,
        "stdout",
        cursor.stdout,
        max,
        Arc::clone(&progress),
        ArtifactStream::Stdout,
        BashProgressStream::Stdout,
    )?;
    let (mut stderr, stderr_bytes, stderr_end, stderr_seq) = collect_stream(
        client,
        artifacts,
        id,
        "stderr",
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
        }),
        cursor: Some(
            TaskCursor {
                // Advance seq to the latest sequence covered by both stream
                // captures so output already included here does not trigger a
                // spurious empty wakeup on the next poll, while never skipping
                // stdout emitted between the stdout and stderr capture calls.
                seq: stdout_seq
                    .min(stderr_seq)
                    .max(descriptor["latestSeq"].as_u64().unwrap_or(0)),
                stdout: stdout_end,
                stderr: stderr_end,
            }
            .encode(),
        ),
    })
}
