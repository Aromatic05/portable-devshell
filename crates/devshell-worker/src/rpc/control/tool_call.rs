use std::sync::Arc;

use serde::Deserialize;

use crate::rpc::error::RpcError;
use crate::rpc::router::{ActiveToolCallRegistry, ControlHandler, control_handler, parse_params};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct ToolCallCancelParams {
    rpc_request_id: String,
    ctx_id: String,
    #[serde(default)]
    reason: Option<String>,
}

pub fn handler(active_calls: Arc<ActiveToolCallRegistry>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let params: ToolCallCancelParams = parse_params(request)?;
        if params.rpc_request_id.is_empty() || params.ctx_id.is_empty() {
            return Err(RpcError::new(
                "rpc.invalidParams",
                "rpcRequestId and ctxId must be non-empty.",
            ));
        }
        let cancelled = active_calls.cancel(&params.ctx_id, &params.rpc_request_id)?;
        Ok(serde_json::json!({
            "cancelled": cancelled,
            "reason": params.reason,
            "rpcRequestId": params.rpc_request_id,
            "ctxId": params.ctx_id,
        }))
    })
}
