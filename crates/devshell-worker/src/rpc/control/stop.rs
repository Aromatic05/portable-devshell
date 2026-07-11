use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;

use crate::daemon::process_registry::ActiveProcessRegistry;
use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::{ActiveToolCallRegistry, ControlHandler};

const ACTIVE_PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const ACTIVE_TOOL_CALL_STOP_TIMEOUT: Duration = Duration::from_secs(5);

pub struct StopHandler {
    active_processes: Arc<ActiveProcessRegistry>,
    active_tool_calls: Arc<ActiveToolCallRegistry>,
    shutdown_requested: Arc<AtomicBool>,
}

impl StopHandler {
    pub fn new(
        shutdown_requested: Arc<AtomicBool>,
        active_processes: Arc<ActiveProcessRegistry>,
        active_tool_calls: Arc<ActiveToolCallRegistry>,
    ) -> Self {
        Self {
            active_processes,
            active_tool_calls,
            shutdown_requested,
        }
    }
}

impl ControlHandler for StopHandler {
    fn handle(&self, _request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        self.active_tool_calls.begin_stop().map_err(stop_error)?;
        self.active_processes
            .stop_all(ACTIVE_PROCESS_STOP_TIMEOUT)
            .map_err(stop_error)?;
        self.active_tool_calls
            .wait_idle(ACTIVE_TOOL_CALL_STOP_TIMEOUT)
            .map_err(stop_error)?;
        self.shutdown_requested.store(true, Ordering::SeqCst);
        Ok(json!({ "stopping": true }))
    }
}

fn stop_error(message: String) -> RpcError {
    let mut error = RpcError::new("worker.stopFailed", message);
    error.retryable = true;
    error
}
