use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;

use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::ControlHandler;
use crate::security::SecurityPolicy;
use crate::tools::ToolError;
use crate::tools::artifact::payload::ArtifactPayloadStore;

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

pub struct ArtifactPayloadOpenHandler {
    payloads: Arc<ArtifactPayloadStore>,
    policy: Arc<dyn SecurityPolicy>,
    workspace: PathBuf,
}

impl ArtifactPayloadOpenHandler {
    pub fn new(
        payloads: Arc<ArtifactPayloadStore>,
        policy: Arc<dyn SecurityPolicy>,
        workspace: PathBuf,
    ) -> Self {
        Self {
            payloads,
            policy,
            workspace,
        }
    }
}

impl ControlHandler for ArtifactPayloadOpenHandler {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let input: ArtifactPayloadOpenInput = serde_json::from_value(request.params.clone())
            .map_err(|error| RpcError::new("rpc.invalidParams", error.to_string()))?;
        let opened = match (input.handle.as_deref(), input.path.as_deref()) {
            (Some(handle), None) => self.payloads.open_handle(handle, input.expires_at_ms),
            (None, Some(path)) => self.payloads.open_path(
                &self.workspace,
                path,
                self.policy.as_ref(),
                input.expires_at_ms,
            ),
            _ => Err(ToolError::new(
                "rpc.invalidParams",
                "exactly one of handle or path is required",
            )),
        }
        .map_err(tool_error_to_rpc)?;
        serde_json::to_value(opened)
            .map_err(|error| RpcError::new("rpc.serializeFailed", error.to_string()))
    }
}

pub struct ArtifactPayloadReadHandler {
    payloads: Arc<ArtifactPayloadStore>,
}

impl ArtifactPayloadReadHandler {
    pub fn new(payloads: Arc<ArtifactPayloadStore>) -> Self {
        Self { payloads }
    }
}

impl ControlHandler for ArtifactPayloadReadHandler {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let input: ArtifactPayloadReadInput = serde_json::from_value(request.params.clone())
            .map_err(|error| RpcError::new("rpc.invalidParams", error.to_string()))?;
        let result = self
            .payloads
            .read(
                &input.payload_id,
                input.offset_bytes.unwrap_or(0),
                input.max_bytes.unwrap_or(64 * 1024),
            )
            .map_err(tool_error_to_rpc)?;
        serde_json::to_value(result)
            .map_err(|error| RpcError::new("rpc.serializeFailed", error.to_string()))
    }
}

pub struct ArtifactPayloadCloseHandler {
    payloads: Arc<ArtifactPayloadStore>,
}

impl ArtifactPayloadCloseHandler {
    pub fn new(payloads: Arc<ArtifactPayloadStore>) -> Self {
        Self { payloads }
    }
}

impl ControlHandler for ArtifactPayloadCloseHandler {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let input: ArtifactPayloadCloseInput = serde_json::from_value(request.params.clone())
            .map_err(|error| RpcError::new("rpc.invalidParams", error.to_string()))?;
        self.payloads
            .close(&input.payload_id)
            .map_err(tool_error_to_rpc)?;
        Ok(serde_json::json!({
            "closed": true,
            "payloadId": input.payload_id
        }))
    }
}

fn tool_error_to_rpc(error: ToolError) -> RpcError {
    let mut rpc_error = RpcError::new(error.code, error.message);
    rpc_error.retryable = error.retryable;
    rpc_error.details = error.details;
    rpc_error
}
