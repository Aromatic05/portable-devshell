use std::sync::Arc;

use serde_json::json;

use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::ControlHandler;
use crate::tools::ToolRegistry;

pub struct ToolsListHandler {
    tools: Arc<ToolRegistry>,
}

impl ToolsListHandler {
    pub fn new(tools: Arc<ToolRegistry>) -> Self {
        Self { tools }
    }
}

impl ControlHandler for ToolsListHandler {
    fn handle(&self, _request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        serde_json::to_value(json!({ "tools": self.tools.catalog() }))
            .map_err(|error| RpcError::new("rpc.serializeFailed", error.to_string()))
    }
}
