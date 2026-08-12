pub mod artifact_payload;
pub mod alerts;
pub mod handshake;
pub mod ping;
pub mod status;
pub mod stop;
pub mod terminal;
pub mod tool_call;
pub mod tool_session;
pub mod tools_list;
pub mod workspace;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::daemon::process::WorkerRuntimeContext;
use crate::daemon::process_registry::ActiveProcessRegistry;
use crate::instance::WorkerConfig;
use crate::rpc::router::{ActiveToolCallRegistry, ControlHandler};
use crate::security::SecurityPolicy;
use crate::terminal::TerminalManager;
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
    terminals: TerminalManager,
    alerts: Arc<alerts::AlertService>,
) {
    handlers.insert(
        "artifact.receive.begin".to_string(),
        artifact_payload::receive_begin(
            Arc::clone(&receives),
            Arc::clone(&policy),
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
        "terminal.open".to_string(),
        terminal::open(terminals.clone()),
    );
    handlers.insert(
        "terminal.attach".to_string(),
        terminal::attach(terminals.clone()),
    );
    handlers.insert(
        "terminal.write".to_string(),
        terminal::write(terminals.clone()),
    );
    handlers.insert(
        "terminal.resize".to_string(),
        terminal::resize(terminals.clone()),
    );
    handlers.insert(
        "terminal.kill".to_string(),
        terminal::kill(terminals.clone()),
    );
    handlers.insert("terminal.list".to_string(), terminal::list(terminals));
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
    handlers.insert("workspace.prepare".to_string(), workspace::prepare_handler());
    handlers.insert("workspace.touchTemporary".to_string(), workspace::touch_temporary_handler());
    handlers.insert("alerts.configure".to_string(), alerts::configure_handler(Arc::clone(&alerts)));
    handlers.insert("alerts.read".to_string(), alerts::read_handler(Arc::clone(&alerts)));
    handlers.insert("alerts.touch".to_string(), alerts::touch_handler(alerts));
    handlers.insert("tools.list".to_string(), tools_list::handler(tools));
}
