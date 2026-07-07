use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::daemon::process::WorkerRuntimeContext;
use crate::instance::WorkerConfig;
use crate::rpc::control::register_control_handlers;
use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::response::RpcResponse;
use crate::security::{SecurityPolicy, build_security_policy};
use crate::tools::{ToolCall, ToolName, ToolRegistry};

pub struct RpcRouter {
    control_handlers: HashMap<String, Arc<dyn ControlHandler>>,
    runtime: WorkerRuntimeContext,
    tools: Arc<ToolRegistry>,
    policy: Arc<dyn SecurityPolicy>,
    shutdown_requested: Arc<AtomicBool>,
}

impl RpcRouter {
    pub fn new(config: WorkerConfig, runtime: WorkerRuntimeContext, tools: Arc<ToolRegistry>) -> Self {
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let mut control_handlers = HashMap::new();
        register_control_handlers(
            &mut control_handlers,
            config,
            runtime.clone(),
            Arc::clone(&shutdown_requested),
            Arc::clone(&tools),
        );

        let policy = build_security_policy(runtime.security_mode.clone());

        Self {
            control_handlers,
            runtime,
            tools,
            policy,
            shutdown_requested,
        }
    }

    pub fn dispatch(&self, request: RpcRequest) -> RpcResponse {
        match self.dispatch_inner(&request) {
            Ok(result) => RpcResponse::success(request.id, result),
            Err(error) => RpcResponse::failure(request.id, error),
        }
    }

    pub fn shutdown_requested(&self) -> bool {
        self.shutdown_requested
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn dispatch_inner(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        if let Some(handler) = self.control_handlers.get(&request.method) {
            return handler.handle(request);
        }

        let tool_name = ToolName::parse(&request.method)
            .map_err(|message| RpcError::new("rpc.methodNotFound", message))?;
        let tool = self
            .tools
            .find(&tool_name)
            .map_err(|error| RpcError::new("rpc.methodNotFound", error.message))?;
        self.policy
            .check_tool_call(&tool_name, &request.params)
            .map_err(|error| {
                let mut rpc_error = RpcError::new(error.code, error.message);
                rpc_error.details = error.details;
                rpc_error
            })?;

        tool.call(ToolCall {
            workspace: PathBuf::from(&self.runtime.workspace),
            params: request.params.clone(),
            policy: Arc::clone(&self.policy),
        })
        .map_err(|error| {
            let mut rpc_error = RpcError::new(error.code, error.message);
            rpc_error.details = error.details;
            rpc_error
        })
    }
}

pub trait ControlHandler: Send + Sync {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError>;
}
