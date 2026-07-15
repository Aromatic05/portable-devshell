pub mod artifact_payload;
pub mod handshake;
pub mod ping;
pub mod status;
pub mod stop;
pub mod tool_call;
pub mod tool_session;
pub mod tools_list;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::daemon::process::WorkerRuntimeContext;
use crate::daemon::process_registry::ActiveProcessRegistry;
use crate::instance::WorkerConfig;
use crate::rpc::router::{ActiveToolCallRegistry, ControlHandler};
use crate::security::SecurityPolicy;
use crate::tools::ToolRegistry;
use crate::tools::artifact::payload::ArtifactPayloadStore;
use crate::tools::artifact::receive::ArtifactReceiveStore;

#[allow(clippy::too_many_arguments)]
pub fn register_control_handlers(
    handlers: &mut HashMap<String, Arc<dyn ControlHandler>>,
    config: WorkerConfig,
    runtime: WorkerRuntimeContext,
    shutdown_requested: Arc<AtomicBool>,
    active_processes: Arc<ActiveProcessRegistry>,
    active_tool_calls: Arc<ActiveToolCallRegistry>,
    tools: Arc<ToolRegistry>,
    policy: Arc<dyn SecurityPolicy>,
    payloads: Arc<ArtifactPayloadStore>,
    receives: Arc<ArtifactReceiveStore>,
) {
    handlers.insert(
        "artifact.receive.begin".to_string(),
        artifact_payload::receive_begin(
            Arc::clone(&receives),
            Arc::clone(&policy),
            std::path::PathBuf::from(&runtime.workspace),
        ),
    );
    handlers.insert(
        "artifact.receive.write".to_string(),
        artifact_payload::receive_write(Arc::clone(&receives)),
    );
    handlers.insert(
        "artifact.receive.finish".to_string(),
        artifact_payload::receive_finish(Arc::clone(&receives)),
    );
    handlers.insert(
        "artifact.receive.abort".to_string(),
        artifact_payload::receive_abort(receives),
    );
    handlers.insert(
        "artifact.payload.open".to_string(),
        artifact_payload::payload_open(
            Arc::clone(&payloads),
            Arc::clone(&policy),
            std::path::PathBuf::from(&runtime.workspace),
        ),
    );
    handlers.insert(
        "artifact.payload.read".to_string(),
        artifact_payload::payload_read(Arc::clone(&payloads)),
    );
    handlers.insert(
        "artifact.payload.close".to_string(),
        artifact_payload::payload_close(payloads),
    );
    handlers.insert(
        "tool.call.cancel".to_string(),
        tool_call::handler(Arc::clone(&active_tool_calls)),
    );
    handlers.insert("tool.session.close".to_string(), tool_session::handler());
    handlers.insert(
        "worker.handshake".to_string(),
        handshake::handler(config.clone(), runtime.clone()),
    );
    handlers.insert(
        "worker.status".to_string(),
        status::handler(runtime.clone()),
    );
    handlers.insert(
        "worker.stop".to_string(),
        stop::handler(shutdown_requested, active_processes, active_tool_calls),
    );
    handlers.insert("worker.ping".to_string(), ping::handler());
    handlers.insert("tools.list".to_string(), tools_list::handler(tools));
}
