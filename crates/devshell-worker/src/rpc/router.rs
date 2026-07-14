use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::daemon::process::WorkerRuntimeContext;
use crate::daemon::process_registry::ActiveProcessRegistry;
use crate::instance::WorkerConfig;
use crate::rpc::control::register_control_handlers;
use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::response::RpcResponse;
use crate::security::{SecurityPolicy, build_security_policy};
use crate::tools::artifact::payload::ArtifactPayloadStore;
use crate::tools::artifact::receive::ArtifactReceiveStore;
use crate::tools::file::FileToolState;
use crate::tools::{ToolCall, ToolName, ToolRegistry};

const MAX_CONCURRENT_TOOL_CALLS: usize = 8;

pub struct RpcRouter {
    active_processes: Arc<ActiveProcessRegistry>,
    active_tool_calls: Arc<ActiveToolCallRegistry>,
    control_handlers: HashMap<String, Arc<dyn ControlHandler>>,
    runtime: WorkerRuntimeContext,
    tools: Arc<ToolRegistry>,
    policy: Arc<dyn SecurityPolicy>,
    shutdown_requested: Arc<AtomicBool>,
}

impl RpcRouter {
    pub fn new(
        config: WorkerConfig,
        runtime: WorkerRuntimeContext,
        tools: Arc<ToolRegistry>,
        files: Arc<FileToolState>,
        payloads: Arc<ArtifactPayloadStore>,
        receives: Arc<ArtifactReceiveStore>,
    ) -> Self {
        let active_processes = Arc::new(ActiveProcessRegistry::new());
        let active_tool_calls = Arc::new(ActiveToolCallRegistry::new());
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let policy = build_security_policy(runtime.security_mode.clone());
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
            files,
            payloads,
            receives,
        );

        Self {
            active_processes,
            active_tool_calls,
            control_handlers,
            runtime,
            tools,
            policy,
            shutdown_requested,
        }
    }

    pub fn is_control_method(&self, method: &str) -> bool {
        self.control_handlers.contains_key(method)
    }

    pub fn dispatch_control(&self, request: RpcRequest) -> RpcResponse {
        let result = self
            .control_handlers
            .get(&request.method)
            .ok_or_else(|| RpcError::new("rpc.methodNotFound", "Control method not found."))
            .and_then(|handler| handler.handle(&request));
        Self::response(request.id, result)
    }

    pub fn acquire_tool_permit(&self) -> Result<ToolCallPermit, RpcError> {
        self.active_tool_calls.acquire()
    }

    pub fn dispatch_tool(&self, request: RpcRequest, _permit: ToolCallPermit) -> RpcResponse {
        let result = self.dispatch_tool_inner(&request);
        Self::response(request.id, result)
    }

    pub fn shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }

    fn dispatch_tool_inner(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let tool_name = ToolName::parse(&request.method)
            .map_err(|message| RpcError::new("rpc.methodNotFound", message))?;
        let tool = self
            .tools
            .find(&tool_name)
            .map_err(|error| RpcError::new(error.code, error.message))?;
        let context = request.context.as_ref();
        tool.call(ToolCall {
            workspace: PathBuf::from(&self.runtime.workspace),
            params: request.params.clone(),
            session_id: context
                .and_then(|value| value.session_id.clone())
                .unwrap_or_else(|| "worker-default".to_string()),
            policy: Arc::clone(&self.policy),
            process_registry: Arc::clone(&self.active_processes),
        })
        .map_err(|error| {
            let mut rpc_error = RpcError::new(error.code, error.message);
            rpc_error.retryable = error.retryable;
            rpc_error.details = error.details;
            rpc_error
        })
    }

    fn response(id: String, result: Result<serde_json::Value, RpcError>) -> RpcResponse {
        match result {
            Ok(result) => RpcResponse::success(id, result),
            Err(error) => RpcResponse::failure(id, error),
        }
    }
}

#[derive(Default)]
pub struct ActiveToolCallRegistry {
    idle: Condvar,
    state: Mutex<ActiveToolCallState>,
}

#[derive(Default)]
struct ActiveToolCallState {
    active: usize,
    stopping: bool,
}

impl ActiveToolCallRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire(self: &Arc<Self>) -> Result<ToolCallPermit, RpcError> {
        let mut state = self.state.lock().map_err(|_| {
            RpcError::new(
                "worker.toolSchedulerFailed",
                "Active tool call registry lock poisoned.",
            )
        })?;

        if state.stopping {
            return Err(RpcError::new(
                "worker.stopping",
                "Worker is stopping and cannot accept new tool calls.",
            ));
        }

        if state.active >= MAX_CONCURRENT_TOOL_CALLS {
            let mut error = RpcError::new(
                "worker.toolConcurrencyLimit",
                "Worker tool concurrency limit reached.",
            );
            error.retryable = true;
            error.details = Some(serde_json::json!({
                "maxConcurrentToolCalls": MAX_CONCURRENT_TOOL_CALLS,
                "runningToolCalls": state.active,
            }));
            return Err(error);
        }

        state.active += 1;
        Ok(ToolCallPermit {
            registry: Arc::clone(self),
        })
    }

    pub fn begin_stop(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "active tool call registry lock poisoned".to_string())?;
        state.stopping = true;
        Ok(())
    }

    pub fn wait_idle(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "active tool call registry lock poisoned".to_string())?;

        while state.active > 0 {
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "timed out waiting for {} active tool call(s) to stop",
                    state.active
                ));
            }

            let remaining = deadline.saturating_duration_since(now);
            let (next_state, wait_result) = self
                .idle
                .wait_timeout(state, remaining)
                .map_err(|_| "active tool call registry lock poisoned".to_string())?;
            state = next_state;

            if wait_result.timed_out() && state.active > 0 {
                return Err(format!(
                    "timed out waiting for {} active tool call(s) to stop",
                    state.active
                ));
            }
        }

        Ok(())
    }

    fn release(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.active = state.active.saturating_sub(1);
        if state.active == 0 {
            self.idle.notify_all();
        }
    }
}

pub struct ToolCallPermit {
    registry: Arc<ActiveToolCallRegistry>,
}

impl Drop for ToolCallPermit {
    fn drop(&mut self) {
        self.registry.release();
    }
}

pub trait ControlHandler: Send + Sync {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError>;
}
