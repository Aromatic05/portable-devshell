use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::json;

use crate::daemon::process_registry::ActiveProcessRegistry;
use crate::rpc::error::RpcError;
use crate::rpc::router::{ActiveToolCallRegistry, ControlHandler, control_handler};

const ACTIVE_PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const ACTIVE_TOOL_CALL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const FAIL_STOP_ENV: &str = "DEVSHELL_WORKER_TEST_FAIL_STOP";

pub fn handler(
    shutdown_requested: Arc<AtomicBool>,
    active_processes: Arc<ActiveProcessRegistry>,
    active_tool_calls: Arc<ActiveToolCallRegistry>,
) -> Arc<dyn ControlHandler> {
    control_handler(move |_| {
        if std::env::var(FAIL_STOP_ENV).as_deref() == Ok("1") {
            return Err(stop_error("injected worker stop failure".to_string()));
        }
        active_tool_calls.begin_stop().map_err(stop_error)?;
        active_processes
            .stop_all(ACTIVE_PROCESS_STOP_TIMEOUT)
            .map_err(stop_error)?;
        active_tool_calls
            .wait_idle(ACTIVE_TOOL_CALL_STOP_TIMEOUT)
            .map_err(stop_error)?;
        shutdown_requested.store(true, Ordering::SeqCst);
        Ok(json!({ "stopping": true }))
    })
}

fn stop_error(message: String) -> RpcError {
    let mut error = RpcError::new("worker.stopFailed", message);
    error.retryable = true;
    error
}
