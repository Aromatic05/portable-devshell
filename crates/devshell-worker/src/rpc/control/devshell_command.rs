use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::rpc::error::RpcError;
use crate::rpc::notification::WorkerNotificationQueue;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::{ControlHandler, control_handler, parse_params, serialize};

const MAX_SESSIONS: usize = 32;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const MAX_BUFFER_BYTES: usize = 4 * 1024 * 1024;
const READ_WAIT: Duration = Duration::from_secs(30);
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const SESSION_REAPER_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct DevshellCommandBroker {
    inner: Arc<BrokerInner>,
}

struct BrokerInner {
    notifications: Arc<WorkerNotificationQueue>,
    sessions: Mutex<HashMap<String, Arc<BrokerSession>>>,
}

struct BrokerSession {
    changed: Condvar,
    state: Mutex<BrokerSessionState>,
}

struct BrokerSessionState {
    buffered_bytes: usize,
    events: VecDeque<DevshellCommandOutputEvent>,
    last_access: Instant,
    terminal: Option<DevshellCommandTerminal>,
}

impl Default for BrokerSessionState {
    fn default() -> Self {
        Self {
            buffered_bytes: 0,
            events: VecDeque::new(),
            last_access: Instant::now(),
            terminal: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevshellCommandOutputEvent {
    stream: DevshellCommandStream,
    data: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DevshellCommandStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevshellCommandTerminal {
    exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    ctx_id: String,
    parent_call_id: String,
    #[serde(default)]
    task_id: Option<String>,
    workspace: String,
    cwd: String,
    argv: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct OutputParams {
    session_id: String,
    stream: DevshellCommandStream,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct CompleteParams {
    session_id: String,
    exit_code: i32,
    #[serde(default)]
    error: Option<String>,
}

impl DevshellCommandBroker {
    pub fn new(notifications: Arc<WorkerNotificationQueue>) -> Self {
        let broker = Self {
            inner: Arc::new(BrokerInner {
                notifications,
                sessions: Mutex::new(HashMap::new()),
            }),
        };
        broker.start_reaper();
        broker
    }

    fn start_reaper(&self) {
        let inner = Arc::downgrade(&self.inner);
        thread::spawn(move || {
            loop {
                thread::sleep(SESSION_REAPER_INTERVAL);
                let Some(inner) = inner.upgrade() else {
                    break;
                };
                let broker = DevshellCommandBroker { inner };
                let _ = broker.prune_stale_sessions();
            }
        });
    }

    pub fn open_handler(&self) -> Arc<dyn ControlHandler> {
        let broker = self.clone();
        control_handler(move |request| broker.open(request))
    }

    pub fn read_handler(&self) -> Arc<dyn ControlHandler> {
        let broker = self.clone();
        control_handler(move |request| broker.read(request))
    }

    pub fn output_handler(&self) -> Arc<dyn ControlHandler> {
        let broker = self.clone();
        control_handler(move |request| broker.output(request))
    }

    pub fn complete_handler(&self) -> Arc<dyn ControlHandler> {
        let broker = self.clone();
        control_handler(move |request| broker.complete(request))
    }

    pub fn close_handler(&self) -> Arc<dyn ControlHandler> {
        let broker = self.clone();
        control_handler(move |request| broker.close(request))
    }

    fn open(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let params: OpenParams = parse_params(request)?;
        if params.ctx_id.is_empty()
            || params.parent_call_id.is_empty()
            || params.workspace.is_empty()
            || params.cwd.is_empty()
            || params.argv.is_empty()
            || params.argv.iter().any(|value| value.contains('\0'))
        {
            return Err(RpcError::new(
                "devshell.command.invalidRequest",
                "ctxId, parentCallId, workspace, cwd, and argv are required.",
            ));
        }

        self.prune_stale_sessions()?;

        let session_id = format!("devshell-{}", Uuid::new_v4().simple());
        let session = Arc::new(BrokerSession {
            changed: Condvar::new(),
            state: Mutex::new(BrokerSessionState::default()),
        });
        {
            let mut sessions = self
                .inner
                .sessions
                .lock()
                .map_err(|_| internal_error("broker session registry lock poisoned"))?;
            if sessions.len() >= MAX_SESSIONS {
                return Err(RpcError::new(
                    "devshell.command.capacityReached",
                    "Too many model devshell command sessions are active.",
                ));
            }
            sessions.insert(session_id.clone(), session);
        }

        let notification = serde_json::json!({
            "type": "notification",
            "method": "devshell.command.open",
            "params": {
                "sessionId": session_id,
                "ctxId": params.ctx_id,
                "parentCallId": params.parent_call_id,
                "taskId": params.task_id,
                "workspace": params.workspace,
                "cwd": params.cwd,
                "argv": params.argv,
            }
        });
        if let Err(error) = self.inner.notifications.push_json(&notification) {
            let _ = self.remove_session(&session_id);
            return Err(RpcError::new(
                "devshell.command.transportUnavailable",
                format!("Failed to queue model devshell command: {error}"),
            ));
        }

        Ok(serde_json::json!({ "sessionId": session_id }))
    }

    fn read(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let params: SessionParams = parse_params(request)?;
        let session = self.session(&params.session_id)?;
        let mut state = session
            .state
            .lock()
            .map_err(|_| internal_error("broker session lock poisoned"))?;
        if state.events.is_empty() && state.terminal.is_none() {
            let (next, _) = session
                .changed
                .wait_timeout(state, READ_WAIT)
                .map_err(|_| internal_error("broker session lock poisoned"))?;
            state = next;
        }

        state.last_access = Instant::now();

        let events = state.events.drain(..).collect::<Vec<_>>();
        state.buffered_bytes = 0;
        let terminal = state.terminal.clone();
        drop(state);
        if terminal.is_some() {
            let _ = self.remove_session(&params.session_id)?;
        }
        serialize(serde_json::json!({
            "events": events,
            "terminal": terminal,
        }))
    }

    fn output(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let params: OutputParams = parse_params(request)?;
        if params.data.len() > MAX_CHUNK_BYTES {
            return Err(RpcError::new(
                "devshell.command.outputTooLarge",
                "Model devshell output chunk exceeds the Worker limit.",
            ));
        }
        let session = self.session(&params.session_id)?;
        let mut state = session
            .state
            .lock()
            .map_err(|_| internal_error("broker session lock poisoned"))?;
        if state.terminal.is_some() {
            return Err(RpcError::new(
                "devshell.command.sessionCompleted",
                "Model devshell command session is already complete.",
            ));
        }
        if state.buffered_bytes.saturating_add(params.data.len()) > MAX_BUFFER_BYTES {
            return Err(RpcError::new(
                "devshell.command.outputBufferFull",
                "Model devshell output buffer is full.",
            ));
        }
        state.last_access = Instant::now();
        state.buffered_bytes += params.data.len();
        state.events.push_back(DevshellCommandOutputEvent {
            stream: params.stream,
            data: params.data,
        });
        drop(state);
        session.changed.notify_all();
        Ok(serde_json::json!({ "accepted": true }))
    }

    fn complete(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let params: CompleteParams = parse_params(request)?;
        let session = self.session(&params.session_id)?;
        let mut state = session
            .state
            .lock()
            .map_err(|_| internal_error("broker session lock poisoned"))?;
        if state.terminal.is_none() {
            state.terminal = Some(DevshellCommandTerminal {
                exit_code: params.exit_code,
                error: params.error,
            });
        }
        state.last_access = Instant::now();
        drop(state);
        session.changed.notify_all();
        Ok(serde_json::json!({ "completed": true }))
    }

    fn close(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let params: SessionParams = parse_params(request)?;
        if params.session_id.is_empty() {
            return Err(RpcError::new(
                "devshell.command.invalidRequest",
                "sessionId is required.",
            ));
        }
        let removed = self.remove_session(&params.session_id)?;
        if removed {
            self.notify_close(&params.session_id)?;
        }
        Ok(serde_json::json!({ "closed": removed }))
    }

    fn session(&self, session_id: &str) -> Result<Arc<BrokerSession>, RpcError> {
        if session_id.is_empty() {
            return Err(RpcError::new(
                "devshell.command.invalidRequest",
                "sessionId is required.",
            ));
        }
        self.inner
            .sessions
            .lock()
            .map_err(|_| internal_error("broker session registry lock poisoned"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                RpcError::new(
                    "devshell.command.sessionMissing",
                    "Model devshell command session is unavailable.",
                )
            })
    }

    fn remove_session(&self, session_id: &str) -> Result<bool, RpcError> {
        Ok(self
            .inner
            .sessions
            .lock()
            .map_err(|_| internal_error("broker session registry lock poisoned"))?
            .remove(session_id)
            .is_some())
    }

    fn prune_stale_sessions(&self) -> Result<(), RpcError> {
        let now = Instant::now();
        let stale = {
            let sessions = self
                .inner
                .sessions
                .lock()
                .map_err(|_| internal_error("broker session registry lock poisoned"))?;
            let mut stale = Vec::new();
            for (session_id, session) in sessions.iter() {
                let state = session
                    .state
                    .lock()
                    .map_err(|_| internal_error("broker session lock poisoned"))?;
                if state.terminal.is_none()
                    && now.saturating_duration_since(state.last_access) >= SESSION_IDLE_TIMEOUT
                {
                    stale.push(session_id.clone());
                }
            }
            stale
        };
        for session_id in stale {
            if self.remove_session(&session_id)? {
                self.notify_close(&session_id)?;
            }
        }
        Ok(())
    }

    fn notify_close(&self, session_id: &str) -> Result<(), RpcError> {
        self.inner
            .notifications
            .push_json(&serde_json::json!({
                "type": "notification",
                "method": "devshell.command.close",
                "params": { "sessionId": session_id }
            }))
            .map_err(|error| {
                RpcError::new(
                    "devshell.command.transportUnavailable",
                    format!("Failed to queue model devshell close notification: {error}"),
                )
            })
    }
}

fn internal_error(message: &str) -> RpcError {
    RpcError::new("devshell.command.internalError", message)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{DevshellCommandBroker, SESSION_IDLE_TIMEOUT};
    use crate::rpc::codec::decode_json;
    use crate::rpc::notification::WorkerNotificationQueue;
    use crate::rpc::request::RpcRequest;

    #[test]
    fn broker_streams_output_and_terminal_state_after_open() {
        let notifications = Arc::new(WorkerNotificationQueue::new(1024 * 1024));
        let broker = DevshellCommandBroker::new(Arc::clone(&notifications));
        let open = broker
            .open(&RpcRequest::request(
                "open",
                "devshell.command.open",
                serde_json::json!({
                    "ctxId": "ctx-a",
                    "parentCallId": "call-a",
                    "workspace": "/workspace",
                    "cwd": "/workspace",
                    "argv": ["instance", "list"],
                }),
            ))
            .unwrap();
        let session_id = open["sessionId"].as_str().unwrap();
        assert!(notifications.try_pop().unwrap().is_some());

        broker
            .output(&RpcRequest::request(
                "output",
                "devshell.command.output",
                serde_json::json!({
                    "sessionId": session_id,
                    "stream": "stdout",
                    "data": "ok\n",
                }),
            ))
            .unwrap();
        broker
            .complete(&RpcRequest::request(
                "complete",
                "devshell.command.complete",
                serde_json::json!({ "sessionId": session_id, "exitCode": 0 }),
            ))
            .unwrap();
        let read = broker
            .read(&RpcRequest::request(
                "read",
                "devshell.command.read",
                serde_json::json!({ "sessionId": session_id }),
            ))
            .unwrap();
        assert_eq!(read["events"][0]["data"], "ok\n");
        assert_eq!(read["terminal"]["exitCode"], 0);
    }

    #[test]
    fn broker_close_notifies_control_and_is_idempotent() {
        let notifications = Arc::new(WorkerNotificationQueue::new(1024 * 1024));
        let broker = DevshellCommandBroker::new(Arc::clone(&notifications));
        let open = broker
            .open(&RpcRequest::request(
                "open",
                "devshell.command.open",
                serde_json::json!({
                    "ctxId": "ctx-a",
                    "parentCallId": "call-a",
                    "workspace": "/workspace",
                    "cwd": "/workspace",
                    "argv": ["instance", "logs", "-f"],
                }),
            ))
            .unwrap();
        let session_id = open["sessionId"].as_str().unwrap();
        let _ = notifications.try_pop().unwrap().unwrap();

        let closed = broker
            .close(&RpcRequest::request(
                "close",
                "devshell.command.close",
                serde_json::json!({ "sessionId": session_id }),
            ))
            .unwrap();
        assert_eq!(closed["closed"], true);
        let notification: serde_json::Value =
            decode_json(&notifications.try_pop().unwrap().unwrap()).unwrap();
        assert_eq!(notification["method"], "devshell.command.close");
        assert_eq!(notification["params"]["sessionId"], session_id);

        let closed_again = broker
            .close(&RpcRequest::request(
                "close-again",
                "devshell.command.close",
                serde_json::json!({ "sessionId": session_id }),
            ))
            .unwrap();
        assert_eq!(closed_again["closed"], false);
        assert!(notifications.try_pop().unwrap().is_none());
    }

    #[test]
    fn opening_a_new_session_prunes_stale_sessions_before_capacity_check() {
        let notifications = Arc::new(WorkerNotificationQueue::new(1024 * 1024));
        let broker = DevshellCommandBroker::new(Arc::clone(&notifications));
        let first = broker
            .open(&RpcRequest::request(
                "open-a",
                "devshell.command.open",
                serde_json::json!({
                    "ctxId": "ctx-a",
                    "parentCallId": "call-a",
                    "workspace": "/workspace",
                    "cwd": "/workspace",
                    "argv": ["instance", "logs", "-f"],
                }),
            ))
            .unwrap();
        let first_id = first["sessionId"].as_str().unwrap().to_string();
        let _ = notifications.try_pop().unwrap().unwrap();
        let session = broker.session(&first_id).unwrap();
        session.state.lock().unwrap().last_access =
            Instant::now() - SESSION_IDLE_TIMEOUT - Duration::from_millis(1);

        let _second = broker
            .open(&RpcRequest::request(
                "open-b",
                "devshell.command.open",
                serde_json::json!({
                    "ctxId": "ctx-a",
                    "parentCallId": "call-b",
                    "workspace": "/workspace",
                    "cwd": "/workspace",
                    "argv": ["instance", "list"],
                }),
            ))
            .unwrap();

        assert!(broker.session(&first_id).is_err());
        let close: serde_json::Value =
            decode_json(&notifications.try_pop().unwrap().unwrap()).unwrap();
        assert_eq!(close["method"], "devshell.command.close");
        assert_eq!(close["params"]["sessionId"], first_id);
        let open: serde_json::Value =
            decode_json(&notifications.try_pop().unwrap().unwrap()).unwrap();
        assert_eq!(open["method"], "devshell.command.open");
    }
}
