use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;

use crate::rpc::error::RpcError;
use crate::rpc::router::{ControlHandler, control_handler, parse_params, serialize};
use crate::security::SecurityPolicy;
use crate::tools::ToolError;
use crate::tools::artifact::payload::ArtifactPayloadStore;
use crate::tools::artifact::receive::{ArtifactReceiveBeginInput, ArtifactReceiveStore};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactPayloadOpenInput {
    handle: Option<String>,
    path: Option<String>,
    expires_at_ms: u128,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactPayloadReadInput {
    payload_id: String,
    offset_bytes: Option<u64>,
    max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactPayloadCloseInput {
    payload_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactReceiveWriteInput {
    receive_id: String,
    offset_bytes: u64,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactReceiveIdInput {
    receive_id: String,
}

pub fn payload_open(
    payloads: Arc<ArtifactPayloadStore>,
    policy: Arc<dyn SecurityPolicy>,
    workspace: PathBuf,
) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactPayloadOpenInput = parse_params(request)?;
        let result = match (input.handle.as_deref(), input.path.as_deref()) {
            (Some(handle), None) => payloads.open_handle(handle, input.expires_at_ms),
            (None, Some(path)) => {
                payloads.open_path(&workspace, path, policy.as_ref(), input.expires_at_ms)
            }
            _ => Err(ToolError::new(
                "rpc.invalidParams",
                "exactly one of handle or path is required",
            )),
        }
        .map_err(RpcError::from)?;
        serialize(result)
    })
}

pub fn payload_read(payloads: Arc<ArtifactPayloadStore>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactPayloadReadInput = parse_params(request)?;
        serialize(
            payloads
                .read(
                    &input.payload_id,
                    input.offset_bytes.unwrap_or(0),
                    input.max_bytes.unwrap_or(64 * 1024),
                )
                .map_err(RpcError::from)?,
        )
    })
}

pub fn payload_close(payloads: Arc<ArtifactPayloadStore>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactPayloadCloseInput = parse_params(request)?;
        payloads.close(&input.payload_id).map_err(RpcError::from)?;
        Ok(serde_json::json!({
            "closed": true,
            "payloadId": input.payload_id
        }))
    })
}

pub fn receive_begin(
    receives: Arc<ArtifactReceiveStore>,
    policy: Arc<dyn SecurityPolicy>,
    workspace: PathBuf,
) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactReceiveBeginInput = parse_params(request)?;
        serialize(
            receives
                .begin(&workspace, policy.as_ref(), input)
                .map_err(RpcError::from)?,
        )
    })
}

pub fn receive_write(receives: Arc<ArtifactReceiveStore>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactReceiveWriteInput = parse_params(request)?;
        serialize(
            receives
                .write(&input.receive_id, input.offset_bytes, input.content)
                .map_err(RpcError::from)?,
        )
    })
}

pub fn receive_finish(receives: Arc<ArtifactReceiveStore>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactReceiveIdInput = parse_params(request)?;
        serialize(receives.finish(&input.receive_id).map_err(RpcError::from)?)
    })
}

pub fn receive_abort(receives: Arc<ArtifactReceiveStore>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactReceiveIdInput = parse_params(request)?;
        receives.abort(&input.receive_id).map_err(RpcError::from)?;
        Ok(serde_json::json!({
            "aborted": true,
            "receiveId": input.receive_id
        }))
    })
}
