use std::sync::Arc;

use serde::Deserialize;

use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::{ActiveToolCallRegistry, ControlHandler};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct ToolCallCancelParams {
    rpc_request_id: String,
    session_id: String,
    #[serde(default)]
    reason: Option<String>,
}

pub struct ToolCallCancelHandler {
    active_calls: Arc<ActiveToolCallRegistry>,
}

impl ToolCallCancelHandler {
    pub fn new(active_calls: Arc<ActiveToolCallRegistry>) -> Self {
        Self { active_calls }
    }
}

impl ControlHandler for ToolCallCancelHandler {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let params: ToolCallCancelParams = serde_json::from_value(request.params.clone())
            .map_err(|error| RpcError::new("rpc.invalidParams", error.to_string()))?;
        if params.rpc_request_id.is_empty() || params.session_id.is_empty() {
            return Err(RpcError::new(
                "rpc.invalidParams",
                "rpcRequestId and sessionId must be non-empty.",
            ));
        }
        let cancelled = self
            .active_calls
            .cancel(&params.session_id, &params.rpc_request_id)?;
        Ok(serde_json::json!({
            "cancelled": cancelled,
            "reason": params.reason,
            "rpcRequestId": params.rpc_request_id,
            "sessionId": params.session_id,
        }))
    }
}
