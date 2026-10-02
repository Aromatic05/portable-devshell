use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;

use crate::capability::artifact::direct::{
    ArtifactDirectPushInput, ArtifactDirectReceiveOpenInput, ArtifactDirectTransfer,
};
use crate::capability::artifact::payload::{ArtifactPayloadDescriptor, ArtifactPayloadStore};
use crate::capability::artifact::receive::{ArtifactReceiveBeginInput, ArtifactReceiveStore};
use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::router::{
    ControlHandler, cancellable_control_handler, control_handler, parse_params, serialize,
};
use crate::instance::sandbox::SecurityPolicy;
use crate::tool::ToolError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactPayloadOpenInput {
    handle: Option<String>,
    path: Option<String>,
    expires_at_ms: u128,
    workspace: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactPayloadCloseInput {
    payload_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactReceiveBeginRpcInput {
    descriptor: ArtifactPayloadDescriptor,
    #[serde(default)]
    overwrite: bool,
    target_path: String,
    workspace: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactReceiveIdInput {
    receive_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactDirectReceiverIdInput {
    receiver_id: String,
}

pub fn payload_open(
    payloads: Arc<ArtifactPayloadStore>,
    policy: Arc<dyn SecurityPolicy>,
) -> Arc<dyn ControlHandler> {
    cancellable_control_handler(move |request, cancellation| {
        cancellation.check().map_err(RpcError::from)?;
        let input: ArtifactPayloadOpenInput = parse_params(request)?;
        let result = match (
            input.handle.as_deref(),
            input.path.as_deref(),
            input.workspace.as_deref(),
        ) {
            (Some(handle), None, None) => payloads.open_handle(handle, input.expires_at_ms),
            (None, Some(path), Some(workspace)) if PathBuf::from(workspace).is_absolute() => {
                payloads.open_path_cancellable(
                    PathBuf::from(workspace).as_path(),
                    path,
                    policy.as_ref(),
                    input.expires_at_ms,
                    cancellation,
                )
            }
            (None, Some(_), Some(_)) => Err(ToolError::new(
                "rpc.invalidContext",
                "artifact workspace must be an absolute path",
            )),
            _ => Err(ToolError::new(
                "rpc.invalidParams",
                "handle requires no workspace; path requires an absolute workspace",
            )),
        }
        .map_err(RpcError::from)?;
        serialize(result)
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
) -> Arc<dyn ControlHandler> {
    cancellable_control_handler(move |request, cancellation| {
        cancellation.check().map_err(RpcError::from)?;
        let input: ArtifactReceiveBeginRpcInput = parse_params(request)?;
        if !PathBuf::from(&input.workspace).is_absolute() {
            return Err(RpcError::new(
                "rpc.invalidContext",
                "artifact workspace must be an absolute path",
            ));
        }
        let result = receives
            .begin(
                PathBuf::from(&input.workspace).as_path(),
                policy.as_ref(),
                ArtifactReceiveBeginInput {
                    descriptor: input.descriptor,
                    overwrite: input.overwrite,
                    target_path: input.target_path,
                },
            )
            .map_err(RpcError::from)?;
        cancellation.check().map_err(RpcError::from)?;
        serialize(result)
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

pub fn direct_receive_open(direct: Arc<ArtifactDirectTransfer>) -> Arc<dyn ControlHandler> {
    cancellable_control_handler(move |request, cancellation| {
        cancellation.check().map_err(RpcError::from)?;
        let input: ArtifactDirectReceiveOpenInput = parse_params(request)?;
        let result = direct.open_receiver(input).map_err(RpcError::from)?;
        cancellation.check().map_err(RpcError::from)?;
        serialize(result)
    })
}

pub fn direct_receive_close(direct: Arc<ArtifactDirectTransfer>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactDirectReceiverIdInput = parse_params(request)?;
        direct
            .close_receiver(&input.receiver_id)
            .map_err(RpcError::from)?;
        Ok(serde_json::json!({
            "closed": true,
            "receiverId": input.receiver_id
        }))
    })
}

pub fn direct_payload_push(direct: Arc<ArtifactDirectTransfer>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactDirectPushInput = parse_params(request)?;
        serialize(direct.push_chunk(input).map_err(RpcError::from)?)
    })
}
