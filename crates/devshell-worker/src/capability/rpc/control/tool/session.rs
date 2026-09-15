use std::sync::Arc;

use serde::Deserialize;

use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::router::{ControlHandler, control_handler, parse_params};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolSessionCloseInput {
    session_id: String,
}

pub fn handler() -> Arc<dyn ControlHandler> {
    control_handler(|request| {
        let input: ToolSessionCloseInput = parse_params(request)?;
        if input.session_id.is_empty() {
            return Err(RpcError::new(
                "rpc.invalidParams",
                "sessionId must not be empty",
            ));
        }
        Ok(serde_json::json!({ "closed": true }))
    })
}
