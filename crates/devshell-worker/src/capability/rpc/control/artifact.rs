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
struct ArtifactRetainTextInput {
    text: String,
}

pub fn retain_text(payloads: Arc<ArtifactPayloadStore>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ArtifactRetainTextInput = parse_params(request)?;
        let reference = payloads.retain_text(&input.text).map_err(RpcError::from)?;
        serialize(serde_json::json!({
            "path": crate::capability::artifact::result_path::tool_result_path(&reference),
            "sourceBytes": reference.source_bytes,
            "expiresAtMs": reference.expires_at_ms
        }))
    })
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
                cancellation,
                PathBuf::from(&input.workspace).as_path(),
                policy.as_ref(),
                ArtifactReceiveBeginInput {
                    descriptor: input.descriptor,
                    overwrite: input.overwrite,
                    target_path: input.target_path,
                },
            )
            .map_err(RpcError::from)?;
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
        let result = direct
            .open_receiver(cancellation, input)
            .map_err(RpcError::from)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::artifact::payload::ArtifactPayloadType;
    use crate::capability::rpc::request::RpcRequest;
    use crate::instance::sandbox::path::FilesystemCapability;
    use crate::instance::sandbox::policy::{SecurityError, DisabledSecurityPolicy};
    use crate::tool::ToolCancellation;

    struct CancelDuringBegin(ToolCancellation);
    impl SecurityPolicy for CancelDuringBegin {
        fn check_capability(&self, _: FilesystemCapability) -> Result<(), SecurityError> {
            // The RPC entry check already passed. Cancellation arrives inside
            // the allocator, before it publishes its receiveId.
            self.0.cancel();
            Ok(())
        }
    }

    #[test]
    fn cancelled_begin_rolls_back_files_metadata_and_receive_quota() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let storage = root.path().join("receives");
        let receives = ArtifactReceiveStore::new(storage.clone()).unwrap();
        let cancellation = ToolCancellation::default();
        let handler = receive_begin(
            Arc::clone(&receives),
            Arc::new(CancelDuringBegin(cancellation.clone())),
        );
        let descriptor = ArtifactPayloadDescriptor {
            payload_type: ArtifactPayloadType::File,
            name: "empty.bin".to_string(),
            media_type: "application/octet-stream".to_string(),
            payload_bytes: 0,
            payload_blake3: blake3::hash(b"").to_hex().to_string(),
            logical_bytes: None,
            entry_count: None,
            manifest_blake3: None,
        };
        let request = RpcRequest::request(
            "begin",
            "artifact.receive.begin",
            serde_json::json!({
                "workspace": workspace, "targetPath": "./cancelled.bin", "descriptor": descriptor,
            }),
        );
        let error = handler
            .handle_with_cancellation(&request, &cancellation)
            .unwrap_err();
        assert_eq!(error.code, "tool.cancelled");
        assert_eq!(std::fs::read_dir(&storage).unwrap().count(), 0);
        // The cancelled allocation must leave every running receive slot free.
        let mut ids = Vec::new();
        for index in 0..256 {
            let result = receives
                .begin(
                    &ToolCancellation::default(),
                    &workspace,
                    &DisabledSecurityPolicy,
                    ArtifactReceiveBeginInput {
                        descriptor: descriptor.clone(),
                        overwrite: false,
                        target_path: format!("./receive-{index}.bin"),
                    },
                )
                .unwrap();
            ids.push(result.receive_id);
        }
        for id in ids {
            receives.abort(&id).unwrap();
        }
        assert_eq!(std::fs::read_dir(storage).unwrap().count(), 0);
    }
}
