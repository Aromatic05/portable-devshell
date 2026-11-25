use crate::capability::process::client::ProcessHostClient;
use crate::instance::sandbox::path::FilesystemCapability;
use crate::instance::{InstanceName, storage::InstancePaths};
use crate::tool::{ToolCall, ToolError};
use crate::transport::endpoint::channel::EndpointPaths;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
const RPC_TIMEOUT: Duration = Duration::from_secs(5);

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

pub(super) fn wait_for(
    client: &ProcessHostClient,
    call: &ToolCall,
    id: &str,
    mut descriptor: Value,
    mut seq: u64,
    wait_ms: u64,
    until_output: bool,
    kill_on_cancel: bool,
) -> Result<Value, ToolError> {
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    let original_seq = seq;
    loop {
        if call.cancellation.is_cancelled() {
            if kill_on_cancel {
                rpc(client, "process.v1.kill", json!({"id": id}))?;
            }
            return call.check_cancelled().map(|_| descriptor);
        }
        if descriptor["state"] != "running" || Instant::now() >= deadline {
            return Ok(descriptor);
        }
        if until_output && descriptor["latestSeq"].as_u64().unwrap_or(0) > original_seq {
            return Ok(descriptor);
        }
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        let output = rpc(
            client,
            "process.v1.read",
            json!({
                "id": id, "fromSeq": seq, "waitMs": remaining.min(250)
            }),
        )?;
        descriptor = output["process"].clone();
        seq = descriptor["latestSeq"].as_u64().unwrap_or(seq);
    }
}
