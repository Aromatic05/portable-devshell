use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::request::RpcRequest;
use crate::tool::ToolCancellation;

const MAX_CONCURRENT_TOOL_CALLS: usize = 8;
const MAX_STANDARD_TOOL_CALLS: usize = 6;
const MAX_TMUX_WAIT_OBSERVATIONS: usize = 16;

#[derive(Default)]
pub struct ActiveToolCallRegistry {
    idle: Condvar,
    state: Mutex<ActiveToolCallState>,
}

#[derive(Default)]
struct ActiveToolCallState {
    active: usize,
    calls: HashMap<ActiveToolCallKey, ToolCancellation>,
    control_active: usize,
    standard_active: usize,
    stopping: bool,
    tmux_wait_observations: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolCallClass {
    Standard,
    Urgent,
    TmuxWaitObservation,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ActiveToolCallKey {
    rpc_request_id: String,
    ctx_id: String,
}

impl ActiveToolCallKey {
    fn from_request(request: &RpcRequest) -> Self {
        Self {
            rpc_request_id: request.id.clone(),
            ctx_id: request
                .context
                .as_ref()
                .and_then(|context| context.ctx_id.clone())
                .unwrap_or_else(|| "ctx-worker-default".to_string()),
        }
    }
}

impl ActiveToolCallRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire(self: &Arc<Self>, request: &RpcRequest) -> Result<ToolCallPermit, RpcError> {
        let class = tool_call_class(request);
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

        let capacity_reached = match class {
            ToolCallClass::Standard => {
                state.active >= MAX_CONCURRENT_TOOL_CALLS
                    || state.standard_active >= MAX_STANDARD_TOOL_CALLS
            }
            ToolCallClass::Urgent => state.active >= MAX_CONCURRENT_TOOL_CALLS,
            ToolCallClass::TmuxWaitObservation => {
                state.tmux_wait_observations >= MAX_TMUX_WAIT_OBSERVATIONS
            }
        };
        if capacity_reached {
            let mut error = RpcError::new(
                "worker.toolConcurrencyLimit",
                "Worker tool concurrency limit reached.",
            );
            error.retryable = true;
            error.details = Some(serde_json::json!({
                "maxConcurrentToolCalls": MAX_CONCURRENT_TOOL_CALLS,
                "maxStandardToolCalls": MAX_STANDARD_TOOL_CALLS,
                "maxTmuxWaitObservations": MAX_TMUX_WAIT_OBSERVATIONS,
                "runningToolCalls": state.active,
                "runningStandardToolCalls": state.standard_active,
                "runningTmuxWaitObservations": state.tmux_wait_observations,
                "toolCallClass": match class {
                    ToolCallClass::Standard => "standard",
                    ToolCallClass::Urgent => "urgent",
                    ToolCallClass::TmuxWaitObservation => "tmuxWaitObservation",
                },
            }));
            return Err(error);
        }

        let key = ActiveToolCallKey::from_request(request);
        if state.calls.contains_key(&key) {
            return Err(RpcError::new(
                "worker.duplicateRpcRequest",
                "A tool call with the same context and RPC request id is already active.",
            ));
        }
        let cancellation = ToolCancellation::default();
        state.calls.insert(key.clone(), cancellation.clone());
        match class {
            ToolCallClass::Standard => {
                state.active += 1;
                state.standard_active += 1;
            }
            ToolCallClass::Urgent => state.active += 1,
            ToolCallClass::TmuxWaitObservation => state.tmux_wait_observations += 1,
        }
        Ok(ToolCallPermit {
            cancellation,
            class,
            key,
            registry: Arc::clone(self),
        })
    }

    pub fn acquire_control(
        self: &Arc<Self>,
        request: &RpcRequest,
    ) -> Result<ControlCallPermit, RpcError> {
        let mut state = self.state.lock().map_err(|_| {
            RpcError::new(
                "worker.toolSchedulerFailed",
                "Active call registry lock poisoned.",
            )
        })?;
        if state.stopping {
            return Err(RpcError::new(
                "worker.stopping",
                "Worker is stopping and cannot accept new artifact operations.",
            ));
        }

        let key = ActiveToolCallKey::from_request(request);
        if state.calls.contains_key(&key) {
            return Err(RpcError::new(
                "worker.duplicateRpcRequest",
                "A request with the same context and RPC request id is already active.",
            ));
        }
        let cancellation = ToolCancellation::default();
        state.calls.insert(key.clone(), cancellation.clone());
        state.control_active += 1;
        Ok(ControlCallPermit {
            cancellation,
            key,
            registry: Arc::clone(self),
        })
    }

    pub fn cancel(&self, ctx_id: &str, rpc_request_id: &str) -> Result<bool, RpcError> {
        let state = self.state.lock().map_err(|_| {
            RpcError::new(
                "worker.toolSchedulerFailed",
                "Active tool call registry lock poisoned.",
            )
        })?;
        let key = ActiveToolCallKey {
            rpc_request_id: rpc_request_id.to_string(),
            ctx_id: ctx_id.to_string(),
        };
        let Some(cancellation) = state.calls.get(&key) else {
            return Ok(false);
        };
        cancellation.cancel();
        Ok(true)
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

        while state.active > 0 || state.control_active > 0 || state.tmux_wait_observations > 0 {
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "timed out waiting for {} active tool call(s) to stop",
                    state.active + state.control_active + state.tmux_wait_observations
                ));
            }

            let remaining = deadline.saturating_duration_since(now);
            let (next_state, wait_result) = self
                .idle
                .wait_timeout(state, remaining)
                .map_err(|_| "active tool call registry lock poisoned".to_string())?;
            state = next_state;

            if wait_result.timed_out()
                && (state.active > 0
                    || state.control_active > 0
                    || state.tmux_wait_observations > 0)
            {
                return Err(format!(
                    "timed out waiting for {} active tool call(s) to stop",
                    state.active + state.control_active + state.tmux_wait_observations
                ));
            }
        }

        Ok(())
    }

    fn release(&self, key: &ActiveToolCallKey, class: ToolCallClass) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.calls.remove(key);
        match class {
            ToolCallClass::Standard => {
                state.active = state.active.saturating_sub(1);
                state.standard_active = state.standard_active.saturating_sub(1);
            }
            ToolCallClass::Urgent => state.active = state.active.saturating_sub(1),
            ToolCallClass::TmuxWaitObservation => {
                state.tmux_wait_observations = state.tmux_wait_observations.saturating_sub(1);
            }
        }
        if state.active == 0 && state.control_active == 0 && state.tmux_wait_observations == 0 {
            self.idle.notify_all();
        }
    }

    fn release_control(&self, key: &ActiveToolCallKey) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.calls.remove(key);
        state.control_active = state.control_active.saturating_sub(1);
        if state.active == 0 && state.control_active == 0 && state.tmux_wait_observations == 0 {
            self.idle.notify_all();
        }
    }
}

pub struct ToolCallPermit {
    cancellation: ToolCancellation,
    class: ToolCallClass,
    key: ActiveToolCallKey,
    registry: Arc<ActiveToolCallRegistry>,
}

impl ToolCallPermit {
    pub(super) fn cancellation(&self) -> ToolCancellation {
        self.cancellation.clone()
    }
}

impl Drop for ToolCallPermit {
    fn drop(&mut self) {
        self.registry.release(&self.key, self.class);
    }
}

pub struct ControlCallPermit {
    cancellation: ToolCancellation,
    key: ActiveToolCallKey,
    registry: Arc<ActiveToolCallRegistry>,
}

impl ControlCallPermit {
    pub(super) fn cancellation(&self) -> ToolCancellation {
        self.cancellation.clone()
    }
}

impl Drop for ControlCallPermit {
    fn drop(&mut self) {
        self.registry.release_control(&self.key);
    }
}

fn is_urgent_tool(method: &str) -> bool {
    matches!(method, "tmux_input" | "tmux_inspect" | "tmux_manage")
}

fn is_tmux_wait_observation(request: &RpcRequest) -> bool {
    request.method == "tmux_read"
        && request
            .params
            .get("consumeOutput")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && request
            .params
            .get("timeMs")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|time_ms| time_ms > 0)
}

fn tool_call_class(request: &RpcRequest) -> ToolCallClass {
    if is_tmux_wait_observation(request) {
        ToolCallClass::TmuxWaitObservation
    } else if is_urgent_tool(&request.method) {
        ToolCallClass::Urgent
    } else {
        ToolCallClass::Standard
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::ActiveToolCallRegistry;
    use crate::capability::rpc::request::RpcRequest;

    #[test]
    fn urgent_tmux_tools_use_reserved_worker_capacity() {
        let registry = Arc::new(ActiveToolCallRegistry::new());
        let standard = (0..6)
            .map(|index| {
                registry
                    .acquire(&RpcRequest::request(
                        format!("standard-{index}"),
                        "tmux_run",
                        serde_json::json!({}),
                    ))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(
            registry
                .acquire(&RpcRequest::request("2", "bash_run", serde_json::json!({})))
                .is_err()
        );
        let urgent_one = registry
            .acquire(&RpcRequest::request(
                "3",
                "tmux_manage",
                serde_json::json!({}),
            ))
            .unwrap();
        let urgent_two = registry
            .acquire(&RpcRequest::request(
                "4",
                "tmux_input",
                serde_json::json!({}),
            ))
            .unwrap();
        assert!(
            registry
                .acquire(&RpcRequest::request(
                    "5",
                    "tmux_inspect",
                    serde_json::json!({})
                ))
                .is_err()
        );
        drop((standard, urgent_one, urgent_two));
        assert!(
            registry
                .acquire(&RpcRequest::request("2", "bash_run", serde_json::json!({})))
                .is_ok()
        );
    }

    #[test]
    fn tmux_wait_observations_have_separate_worker_capacity() {
        let registry = Arc::new(ActiveToolCallRegistry::new());
        let observations = (0..16)
            .map(|index| {
                registry
                    .acquire(&RpcRequest::request(
                        format!("observation-{index}"),
                        "tmux_read",
                        serde_json::json!({
                            "consumeOutput": false,
                            "line": -1,
                            "task": format!("task-{index}"),
                            "timeMs": 60_000,
                        }),
                    ))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(
            registry
                .acquire(&RpcRequest::request(
                    "observation-over-capacity",
                    "tmux_read",
                    serde_json::json!({
                        "consumeOutput": false,
                        "line": -1,
                        "task": "task-over-capacity",
                        "timeMs": 60_000,
                    }),
                ))
                .is_err()
        );

        let standard = (0..6)
            .map(|index| {
                registry
                    .acquire(&RpcRequest::request(
                        format!("standard-with-observation-{index}"),
                        "tmux_run",
                        serde_json::json!({}),
                    ))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let urgent_one = registry
            .acquire(&RpcRequest::request(
                "urgent-with-observation-1",
                "tmux_manage",
                serde_json::json!({}),
            ))
            .unwrap();
        let urgent_two = registry
            .acquire(&RpcRequest::request(
                "urgent-with-observation-2",
                "tmux_input",
                serde_json::json!({}),
            ))
            .unwrap();

        drop((observations, standard, urgent_one, urgent_two));
        assert!(registry.wait_idle(Duration::from_millis(10)).is_ok());
    }

    #[test]
    fn cancellable_control_calls_share_request_cancellation_registry() {
        let registry = Arc::new(ActiveToolCallRegistry::new());
        let request = RpcRequest::request(
            "artifact-open",
            "artifact.payload.open",
            serde_json::json!({}),
        );
        let permit = registry.acquire_control(&request).unwrap();

        assert!(
            registry
                .cancel("ctx-worker-default", "artifact-open")
                .unwrap()
        );
        let error = permit.cancellation().check().unwrap_err();
        assert_eq!(error.code, "tool.cancelled");

        drop(permit);
        registry.wait_idle(Duration::from_millis(10)).unwrap();
    }
}
