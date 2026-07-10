pub mod handshake;
pub mod ping;
pub mod status;
pub mod stop;
pub mod tools_list;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::daemon::process::WorkerRuntimeContext;
use crate::daemon::process_registry::ActiveProcessRegistry;
use crate::instance::WorkerConfig;
use crate::rpc::router::{ActiveToolCallRegistry, ControlHandler};
use crate::tools::ToolRegistry;

pub fn register_control_handlers(
    handlers: &mut HashMap<String, Arc<dyn ControlHandler>>,
    config: WorkerConfig,
    runtime: WorkerRuntimeContext,
    shutdown_requested: Arc<AtomicBool>,
    active_processes: Arc<ActiveProcessRegistry>,
    active_tool_calls: Arc<ActiveToolCallRegistry>,
    tools: Arc<ToolRegistry>,
) {
    handlers.insert(
        "worker.handshake".to_string(),
        Arc::new(handshake::HandshakeHandler::new(
            config.clone(),
            runtime.clone(),
        )),
    );
    handlers.insert(
        "worker.status".to_string(),
        Arc::new(status::StatusHandler::new(runtime.clone())),
    );
    handlers.insert(
        "worker.stop".to_string(),
        Arc::new(stop::StopHandler::new(
            shutdown_requested,
            active_processes,
            active_tool_calls,
        )),
    );
    handlers.insert("worker.ping".to_string(), Arc::new(ping::PingHandler));
    handlers.insert(
        "tools.list".to_string(),
        Arc::new(tools_list::ToolsListHandler::new(tools)),
    );
}
