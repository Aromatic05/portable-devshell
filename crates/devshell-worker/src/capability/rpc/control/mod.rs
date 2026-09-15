pub mod artifact;
pub mod host;
pub mod instance;
pub mod terminal;
pub mod tool;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::capability::artifact::direct::ArtifactDirectTransfer;
use crate::capability::artifact::payload::ArtifactPayloadStore;
use crate::capability::artifact::receive::ArtifactReceiveStore;
use crate::capability::rpc::command::server as devshell_command;
use crate::capability::rpc::notification::WorkerNotificationQueue;
use crate::capability::rpc::router::{ActiveToolCallRegistry, ControlHandler};
use crate::capability::terminal::TerminalManager;
use crate::daemon::process::WorkerRuntimeContext;
use crate::daemon::process::registry::ActiveProcessRegistry;
use crate::instance::WorkerConfig;
use crate::instance::sandbox::SecurityPolicy;
use crate::instance::storage::ExtensionResourceStore;
use crate::tool::ToolRegistry;

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
    resources: Arc<ExtensionResourceStore>,
    terminals: TerminalManager,
    alerts: Arc<crate::instance::workspace::alert::AlertService>,
    notifications: Arc<WorkerNotificationQueue>,
) {
    let direct = ArtifactDirectTransfer::new(Arc::clone(&payloads), Arc::clone(&receives));
    let devshell_commands =
        devshell_command::DevshellCommandBroker::new(Arc::clone(&notifications));
    handlers.insert(
        "devshell.command.open".to_string(),
        devshell_commands.open_handler(),
    );
    handlers.insert(
        "devshell.command.read".to_string(),
        devshell_commands.read_handler(),
    );
    handlers.insert(
        "devshell.command.output".to_string(),
        devshell_commands.output_handler(),
    );
    handlers.insert(
        "devshell.command.complete".to_string(),
        devshell_commands.complete_handler(),
    );
    handlers.insert(
        "devshell.command.close".to_string(),
        devshell_commands.close_handler(),
    );
    handlers.insert(
        "artifact.receive.direct.open".to_string(),
        artifact::direct_receive_open(Arc::clone(&direct)),
    );
    handlers.insert(
        "artifact.receive.direct.close".to_string(),
        artifact::direct_receive_close(Arc::clone(&direct)),
    );
    handlers.insert(
        "artifact.payload.direct.push".to_string(),
        artifact::direct_payload_push(direct),
    );
    handlers.insert(
        "artifact.receive.begin".to_string(),
        artifact::receive_begin(Arc::clone(&receives), Arc::clone(&policy)),
    );
    handlers.insert(
        "artifact.receive.write".to_string(),
        artifact::receive_write(Arc::clone(&receives)),
    );
    handlers.insert(
        "artifact.receive.finish".to_string(),
        artifact::receive_finish(Arc::clone(&receives)),
    );
    handlers.insert(
        "artifact.receive.abort".to_string(),
        artifact::receive_abort(receives),
    );
    handlers.insert(
        "artifact.payload.open".to_string(),
        artifact::payload_open(Arc::clone(&payloads), Arc::clone(&policy)),
    );
    handlers.insert(
        "artifact.payload.read".to_string(),
        artifact::payload_read(Arc::clone(&payloads)),
    );
    handlers.insert(
        "artifact.payload.close".to_string(),
        artifact::payload_close(payloads),
    );
    handlers.insert(
        "extension.resource.prepare".to_string(),
        host::resource::prepare(resources),
    );
    handlers.insert(
        "tool.call.cancel".to_string(),
        tool::call::handler(Arc::clone(&active_tool_calls)),
    );
    handlers.insert("tool.session.close".to_string(), tool::session::handler());
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
        host::lifecycle::handshake::handler(config.clone(), runtime.clone()),
    );
    handlers.insert(
        "worker.status".to_string(),
        host::lifecycle::status::handler(runtime.clone()),
    );
    handlers.insert(
        "worker.stop".to_string(),
        host::lifecycle::stop::handler(shutdown_requested, active_processes, active_tool_calls),
    );
    handlers.insert("worker.ping".to_string(), host::lifecycle::ping::handler());
    handlers.insert(
        "workspace.prepare".to_string(),
        instance::workspace::prepare_handler(),
    );
    handlers.insert(
        "workspace.touchTemporary".to_string(),
        instance::workspace::touch_temporary_handler(),
    );
    handlers.insert(
        "alerts.configure".to_string(),
        instance::alerts::configure_handler(Arc::clone(&alerts)),
    );
    handlers.insert(
        "alerts.read".to_string(),
        instance::alerts::read_handler(Arc::clone(&alerts)),
    );
    handlers.insert(
        "alerts.touch".to_string(),
        instance::alerts::touch_handler(alerts),
    );
    handlers.insert("tools.list".to_string(), tool::list_handler(tools));
}
