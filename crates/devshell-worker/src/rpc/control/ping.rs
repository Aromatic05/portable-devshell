use serde_json::json;

use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::ControlHandler;

pub struct PingHandler;

impl ControlHandler for PingHandler {
    fn handle(&self, _request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        Ok(json!({ "pong": true }))
    }
}
