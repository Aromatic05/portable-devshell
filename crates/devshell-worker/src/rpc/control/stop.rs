use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;

use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::ControlHandler;

pub struct StopHandler {
    shutdown_requested: Arc<AtomicBool>,
}

impl StopHandler {
    pub fn new(shutdown_requested: Arc<AtomicBool>) -> Self {
        Self { shutdown_requested }
    }
}

impl ControlHandler for StopHandler {
    fn handle(&self, _request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        self.shutdown_requested.store(true, Ordering::SeqCst);
        Ok(json!({ "stopping": true }))
    }
}
