use super::capture::{BashProgress, BashProgressStream};
use crate::capability::process::client::ProcessHostClient;
use crate::instance::sandbox::path::FilesystemCapability;
use crate::instance::{InstanceName, storage::InstancePaths};
use crate::tool::{ToolCall, ToolError};
use crate::transport::endpoint::channel::EndpointPaths;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};
const RPC_TIMEOUT: Duration = Duration::from_secs(5);
const PROGRESS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

pub(super) fn error(message: impl Into<String>) -> ToolError {
    ToolError::new("process.hostFailed", message)
}

pub(super) fn rpc(
    client: &ProcessHostClient,
    method: &str,
    value: Value,
) -> Result<Value, ToolError> {
    client.call_rpc(method, value, RPC_TIMEOUT).map_err(|failure| ToolError { code: failure.code, message: failure.message, retryable: failure.retryable, details: failure.details })
}

pub(super) fn connect(instance: &InstanceName) -> Result<ProcessHostClient, ToolError> {
    let paths = InstancePaths::resolve(instance).map_err(error)?;
    let endpoints = EndpointPaths::resolve(instance).map_err(error)?;
    ProcessHostClient::connect(instance, &paths, &endpoints)
        .map_err(error)?
        .ok_or_else(|| error("no Process Host for this instance"))
}

pub(super) fn require_read(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(if call.stateless {
            FilesystemCapability::AbsoluteRead
        } else {
            FilesystemCapability::WorkspaceRead
        })
        .map_err(ToolError::from)
}

pub(super) fn scoped(call: &ToolCall, descriptor: &Value) -> Result<bool, ToolError> {
    if call.stateless {
        call.policy
            .check_capability(FilesystemCapability::AbsoluteRead)
            .map_err(ToolError::from)?;
        Ok(descriptor["workspace"].is_null())
    } else {
        call.policy
            .check_capability(FilesystemCapability::WorkspaceRead)
            .map_err(ToolError::from)?;
        let workspace = descriptor["workspace"]
            .as_str()
            .map(std::path::PathBuf::from);
        Ok(workspace.as_ref() == Some(&call.workspace))
    }
}

pub(super) fn require(
    client: &ProcessHostClient,
    call: &ToolCall,
    id: &str,
) -> Result<Value, ToolError> {
    let descriptor = rpc(client, "process.v1.describe", json!({"id": id}))?;
    if !scoped(call, &descriptor)? {
        return Err(ToolError::new(
            "process.notFound",
            "task does not belong to this execution scope",
        ));
    }
    Ok(descriptor)
}

pub(super) fn require_execute(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(FilesystemCapability::ProcessExecute)
        .map_err(ToolError::from)?;
    let capability = if call.stateless {
        FilesystemCapability::AbsoluteWrite
    } else {
        FilesystemCapability::WorkspaceWrite
    };
    call.policy
        .check_capability(capability)
        .map_err(ToolError::from)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn wait_for(
    client: &ProcessHostClient,
    call: &ToolCall,
    id: &str,
    mut descriptor: Value,
    mut seq: u64,
    wait_ms: u64,
    until_output: bool,
    kill_on_cancel: bool,
    settle_ms: u64,
    progress: Option<&Arc<BashProgress>>,
) -> Result<Value, ToolError> {
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    let original_seq = seq;
    let mut settle_deadline: Option<Instant> = None;
    let mut max_settle_deadline: Option<Instant> = None;
    let mut last_heartbeat = Instant::now();
    loop {
        if call.cancellation.is_cancelled() {
            if kill_on_cancel {
                rpc(client, "process.v1.kill", json!({"id": id}))?;
            }
            return call.check_cancelled().map(|_| descriptor);
        }
        let now = Instant::now();
        if descriptor["state"] != "running" || now >= deadline {
            return Ok(descriptor);
        }
        let current_seq = descriptor["latestSeq"].as_u64().unwrap_or(0);
        if until_output && current_seq > original_seq {
            if settle_ms == 0 {
                return Ok(descriptor);
            }
            let cap = *max_settle_deadline.get_or_insert_with(|| {
                (now + Duration::from_millis(settle_ms.saturating_mul(4))).min(deadline)
            });
            match settle_deadline {
                None => {
                    settle_deadline = Some((now + Duration::from_millis(settle_ms)).min(cap));
                }
                Some(settle_at) if now >= settle_at => {
                    return Ok(descriptor);
                }
                Some(_) => {}
            }
        }
        let target_deadline = settle_deadline.map_or(deadline, |settle_at| settle_at.min(deadline));
        let remaining = target_deadline.saturating_duration_since(now).as_millis() as u64;
        if remaining == 0 {
            return Ok(descriptor);
        }
        let slice = if settle_deadline.is_some() {
            remaining.min(50)
        } else {
            remaining.min(250)
        };
        let output = rpc(
            client,
            "process.v1.read",
            json!({
                "id": id, "fromSeq": seq, "waitMs": slice
            }),
        )?;
        descriptor = output["process"].clone();
        if let Some(progress) = progress
            && let Some(frames) = output["frames"].as_array()
        {
            for frame in frames {
                if let Some(data_base64) = frame["dataBase64"].as_str()
                    && let Ok(bytes) = STANDARD.decode(data_base64)
                    && !bytes.is_empty()
                {
                    let stream = if frame["channel"] == "stderr" {
                        BashProgressStream::Stderr
                    } else {
                        BashProgressStream::Stdout
                    };
                    progress.append(stream, &bytes);
                    last_heartbeat = Instant::now();
                }
            }
        }
        let last_frame_seq = output["frames"]
            .as_array()
            .and_then(|frames| frames.last())
            .and_then(|frame| frame["seq"].as_u64())
            .filter(|&frame_seq| frame_seq > seq);
        let next_seq = descriptor["latestSeq"].as_u64().unwrap_or(seq);
        let advanced_seq = last_frame_seq.unwrap_or(next_seq);
        if advanced_seq > seq {
            seq = advanced_seq;
            if until_output && settle_ms > 0 && seq > original_seq {
                let now = Instant::now();
                let cap = *max_settle_deadline.get_or_insert_with(|| {
                    (now + Duration::from_millis(settle_ms.saturating_mul(4))).min(deadline)
                });
                settle_deadline = Some((now + Duration::from_millis(settle_ms)).min(cap));
            }
        } else if let Some(progress) = progress
            && last_heartbeat.elapsed() >= PROGRESS_HEARTBEAT_INTERVAL
        {
            progress.emit_heartbeat();
            last_heartbeat = Instant::now();
        }
    }
}
