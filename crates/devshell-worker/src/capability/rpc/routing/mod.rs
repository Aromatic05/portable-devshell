mod active;
pub mod handler;

pub use active::{ActiveToolCallRegistry, ControlCallPermit, ToolCallPermit};
pub use handler::{
    ControlHandler, cancellable_control_handler, control_handler, parse_params, serialize,
};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::capability::artifact::payload::ArtifactPayloadStore;
use crate::capability::artifact::receive::ArtifactReceiveStore;
use crate::capability::rpc::control::register_control_handlers;
use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::notification::{
    DEFAULT_MAX_NOTIFICATION_BYTES, WorkerNotificationQueue,
};
use crate::capability::rpc::request::RpcRequest;
use crate::capability::rpc::response::RpcResponse;
use crate::capability::terminal::TerminalManager;
use crate::daemon::process::WorkerRuntimeContext;
use crate::daemon::process::registry::ActiveProcessRegistry;
use crate::instance::WorkerConfig;
use crate::instance::sandbox::{SecurityPolicy, build_security_policy};
use crate::instance::storage::ExtensionResourceStore;
use crate::instance::workspace::alert::AlertService;
use crate::tool::{ToolCall, ToolCancellation, ToolName, ToolProgressEmitter, ToolRegistry};

pub struct RpcRouter {
    active_processes: Arc<ActiveProcessRegistry>,
    active_tool_calls: Arc<ActiveToolCallRegistry>,
    control_handlers: HashMap<String, Arc<dyn ControlHandler>>,
    tools: Arc<ToolRegistry>,
    policy: Arc<dyn SecurityPolicy>,
    shutdown_requested: Arc<AtomicBool>,
    notifications: Arc<WorkerNotificationQueue>,
}

impl RpcRouter {
    pub fn new(
        config: WorkerConfig,
        runtime: WorkerRuntimeContext,
        tools: Arc<ToolRegistry>,
        payloads: Arc<ArtifactPayloadStore>,
        receives: Arc<ArtifactReceiveStore>,
        resources: Arc<ExtensionResourceStore>,
    ) -> Self {
        let active_processes = Arc::new(ActiveProcessRegistry::new());
        let active_tool_calls = Arc::new(ActiveToolCallRegistry::new());
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let policy = build_security_policy(runtime.security_mode.clone());
        let notifications = Arc::new(WorkerNotificationQueue::new(DEFAULT_MAX_NOTIFICATION_BYTES));
        let terminals = TerminalManager::with_policy_notifications(
            Arc::clone(&policy),
            Arc::clone(&notifications),
        );
        let alerts = Arc::new(AlertService::new());
        let mut control_handlers = HashMap::new();
        register_control_handlers(
            &mut control_handlers,
            config,
            runtime.clone(),
            Arc::clone(&shutdown_requested),
            Arc::clone(&active_processes),
            Arc::clone(&active_tool_calls),
            Arc::clone(&tools),
            Arc::clone(&policy),
            payloads,
            receives,
            resources,
            terminals.clone(),
            alerts,
            Arc::clone(&notifications),
        );

        Self {
            active_processes,
            active_tool_calls,
            control_handlers,
            tools,
            policy,
            shutdown_requested,
            notifications,
        }
    }

    pub fn is_control_method(&self, method: &str) -> bool {
        self.control_handlers.contains_key(method)
    }

    pub fn is_cancellable_control_method(&self, method: &str) -> bool {
        matches!(
            method,
            "artifact.payload.open"
                | "artifact.payload.read"
                | "artifact.receive.begin"
                | "artifact.receive.write"
                | "artifact.receive.direct.open"
        )
    }

    pub fn dispatch_control(&self, request: RpcRequest) -> RpcResponse {
        let result = self
            .control_handlers
            .get(&request.method)
            .ok_or_else(|| RpcError::new("rpc.methodNotFound", "Control method not found."))
            .and_then(|handler| handler.handle(&request));
        Self::response(request.id, result)
    }

    pub fn acquire_control_permit(
        &self,
        request: &RpcRequest,
    ) -> Result<ControlCallPermit, RpcError> {
        self.active_tool_calls.acquire_control(request)
    }

    pub fn dispatch_cancellable_control(
        &self,
        request: RpcRequest,
        permit: ControlCallPermit,
    ) -> RpcResponse {
        let result = self
            .control_handlers
            .get(&request.method)
            .ok_or_else(|| RpcError::new("rpc.methodNotFound", "Control method not found."))
            .and_then(|handler| handler.handle_with_cancellation(&request, &permit.cancellation()));
        Self::response(request.id, result)
    }

    pub fn acquire_tool_permit(&self, request: &RpcRequest) -> Result<ToolCallPermit, RpcError> {
        self.active_tool_calls.acquire(request)
    }

    pub fn dispatch_tool(&self, request: RpcRequest, permit: ToolCallPermit) -> RpcResponse {
        let result = self.dispatch_tool_inner(&request, permit.cancellation());
        Self::response(request.id, result)
    }

    pub fn shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }
    pub fn try_pop_notification(&self) -> Result<Option<Vec<u8>>, String> {
        self.notifications.try_pop()
    }

    pub fn clear_notifications(&self) -> Result<(), String> {
        self.notifications.clear()
    }

    fn dispatch_tool_inner(
        &self,
        request: &RpcRequest,
        cancellation: ToolCancellation,
    ) -> Result<serde_json::Value, RpcError> {
        let tool_name = ToolName::parse(&request.method)
            .map_err(|message| RpcError::new("rpc.methodNotFound", message))?;
        let tool = self.tools.find(&tool_name).map_err(RpcError::from)?;
        let context = request.context.as_ref();
        let workspace = context
            .and_then(|value| value.workspace.as_deref())
            .ok_or_else(|| {
                RpcError::new(
                    "rpc.invalidContext",
                    "tool calls require a workspace context",
                )
            })?;
        if !Path::new(workspace).is_absolute() {
            return Err(RpcError::new(
                "rpc.invalidContext",
                "tool workspace must be an absolute path",
            ));
        }
        let workspace = PathBuf::from(workspace).canonicalize().map_err(|error| {
            RpcError::new(
                "rpc.invalidContext",
                format!("failed to resolve workspace {workspace}: {error}"),
            )
        })?;
        if !workspace.is_dir() {
            return Err(RpcError::new(
                "rpc.invalidContext",
                format!("workspace is not a directory: {}", workspace.display()),
            ));
        }
        let operation_id = context
            .and_then(|value| value.operation_id.clone())
            .unwrap_or_else(|| request.id.clone());
        tool.call(ToolCall {
            workspace,
            params: request.params.clone(),
            ctx_id: context
                .and_then(|value| value.ctx_id.clone())
                .unwrap_or_else(|| "ctx-worker-default".to_string()),
            operation_id: operation_id.clone(),
            source: context.and_then(|value| value.source.clone()),
            policy: Arc::clone(&self.policy),
            process_registry: Arc::clone(&self.active_processes),
            cancellation,
            progress: ToolProgressEmitter::new(operation_id, Arc::clone(&self.notifications)),
        })
        .map_err(RpcError::from)
    }

    fn response(id: String, result: Result<serde_json::Value, RpcError>) -> RpcResponse {
        match result {
            Ok(result) => RpcResponse::success(id, result),
            Err(error) => RpcResponse::failure(id, error),
        }
    }
}
