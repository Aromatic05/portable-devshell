//! Forward Process Host's ordered raw stream through the existing Worker
//! notification channel. This owns subscriptions, never PTYs or task state.
use serde_json::json;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::capability::process::client::ProcessHostClient;
use crate::capability::rpc::{codec, error::RpcError, notification::WorkerNotificationQueue};
use crate::transport::endpoint::channel::LocalIpcStream;

use super::model::TerminalDescriptor;

#[derive(Clone)]
pub(super) struct TerminalBridge {
    subscriptions: Arc<Mutex<HashSet<String>>>,
    notifications: Arc<WorkerNotificationQueue>,
}

impl TerminalBridge {
    pub fn new(notifications: Arc<WorkerNotificationQueue>) -> Self {
        Self {
            subscriptions: Arc::new(Mutex::new(HashSet::new())),
            notifications,
        }
    }

    pub fn is_subscribed(&self, terminal_id: &str) -> bool {
        self.subscriptions
            .lock()
            .is_ok_and(|subscriptions| subscriptions.contains(terminal_id))
    }

    pub(super) fn push_control_notification(
        &self,
        descriptor: &TerminalDescriptor,
    ) -> Result<(), String> {
        let mut params = json!({
            "terminalId": descriptor.terminal_id,
            "generation": descriptor.generation,
            "humanControl": descriptor.human_control,
            "version": descriptor.version,
            "cols": descriptor.cols,
            "rows": descriptor.rows,
        });
        if let Some(name) = descriptor.name.as_deref() {
            params["name"] = json!(name);
        }
        if let Some(cwd) = descriptor.cwd.as_deref() {
            params["cwd"] = json!(cwd);
        }
        if let Some(workspace) = descriptor.workspace.as_deref() {
            params["workspace"] = json!(workspace);
        }
        self.notifications.push_json(&json!({
            "type": "notification",
            "method": "terminal.control",
            "params": params,
        }))
    }

    pub fn subscribe(
        &self,
        client: &ProcessHostClient,
        descriptor: &TerminalDescriptor,
        from_seq: u64,
    ) -> Result<(), RpcError> {
        let mut subscriptions = self
            .subscriptions
            .lock()
            .map_err(|_| bridge_error("terminal subscriptions lock poisoned"))?;
        if subscriptions.contains(&descriptor.terminal_id) {
            return Ok(());
        }
        let channel = client
            .subscribe_from(&descriptor.terminal_id, false, Some(from_seq))
            .map_err(bridge_error)?;
        subscriptions.insert(descriptor.terminal_id.clone());
        let bridge = self.clone();
        let descriptor = descriptor.clone();
        std::thread::spawn(move || {
            let result = bridge.forward(channel, &descriptor, from_seq);
            if let Ok(mut subscriptions) = bridge.subscriptions.lock() {
                subscriptions.remove(&descriptor.terminal_id);
            }
            if let Err(error) = result {
                let _ = bridge.notifications.push_json(&json!({
                    "type": "notification", "method": "terminal.error",
                    "params": {"terminalId": descriptor.terminal_id, "generation": descriptor.generation, "message": error}
                }));
            }
        });
        Ok(())
    }

    pub fn take_control(
        &self,
        client: &ProcessHostClient,
        terminal_id: &str,
    ) -> Result<serde_json::Value, RpcError> {
        // The lifetime of this connection is the input lease. A Worker
        // crash or explicit release returns ownership to the model.
        let mut channel = client
            .subscribe_remote_control(terminal_id)
            .map_err(bridge_error)?;
        let first = codec::read_response(&mut channel)
            .map_err(bridge_error)?
            .ok_or_else(|| bridge_error("terminal control stream ended before handshake"))?;
        if !first.ok {
            return Err(first.error.map_or_else(
                || bridge_error("terminal control rejected"),
                |error| RpcError {
                    code: error.code,
                    message: error.message,
                    retryable: error.retryable,
                    details: error.details,
                },
            ));
        }
        let first = first
            .result
            .ok_or_else(|| bridge_error("missing terminal control result"))?;
        let controller = first["controller"]
            .as_str()
            .ok_or_else(|| bridge_error("missing terminal controller"))?;
        let result = json!({
            "controller": controller,
            "session": first["process"]["terminal"],
            "snapshot": {"seq": first["screen"]["seq"], "data": first["screen"]["restore"]}
        });
        std::thread::spawn(move || {
            // Output is already delivered through the shared observation
            // stream. Drain this lease connection until it is released.
            while let Ok(Some(response)) = codec::read_response(&mut channel) {
                if !response.ok {
                    break;
                }
            }
        });
        Ok(result)
    }

    fn forward(
        &self,
        mut channel: LocalIpcStream,
        descriptor: &TerminalDescriptor,
        mut forwarded_seq: u64,
    ) -> Result<(), String> {
        let first =
            codec::read_response(&mut channel)?.ok_or("terminal stream ended before handshake")?;
        if !first.ok {
            return Err(first
                .error
                .map_or_else(|| "terminal stream rejected".into(), |error| error.message));
        }
        let mut last_human_control = first
            .result
            .as_ref()
            .and_then(|result| result["process"]["humanControl"].as_bool());
        while let Some(response) = codec::read_response(&mut channel)? {
            if !response.ok {
                return Err(response
                    .error
                    .map_or_else(|| "terminal stream rejected".into(), |error| error.message));
            }
            let page = response.result.ok_or("terminal stream has no result")?;
            for frame in page["frames"]
                .as_array()
                .ok_or("invalid terminal stream frames")?
            {
                forwarded_seq = frame["seq"].as_u64().ok_or("invalid terminal output sequence")?;
                self.notifications.push_lossy_json(&json!({
                    "type": "notification", "method": "terminal.output",
                    "params": {
                        "terminalId": descriptor.terminal_id, "generation": descriptor.generation,
                        "seq": frame["seq"], "dataBase64": frame["dataBase64"],
                    }
                }))?;
            }
            let process = &page["process"];
            let human_control = process["humanControl"].as_bool().unwrap_or(false);
            if last_human_control != Some(human_control) {
                let changed_from = last_human_control;
                last_human_control = Some(human_control);
                if changed_from.is_some() {
                    let latest: TerminalDescriptor =
                        serde_json::from_value(process["terminal"].clone())
                            .map_err(|error| error.to_string())?;
                    self.push_control_notification(&latest)?;
                }
            }
            if process["state"] != "running" {
                let latest = page["latestSeq"]
                    .as_u64()
                    .ok_or("invalid terminal latest sequence")?;
                // A final page can still be followed by more output pages.
                if forwarded_seq < latest {
                    continue;
                }
                self.notifications.push_json(&json!({
                    "type": "notification", "method": "terminal.exit",
                    "params": {
                        "terminalId": descriptor.terminal_id, "generation": descriptor.generation,
                        "version": process["terminal"]["version"],
                        "latestSeq": latest,
                        "exitCode": process["exit"]["exitCode"].as_i64().unwrap_or(-1),
                        "signal": process["exit"]["signal"].as_i64().unwrap_or(0),
                    }
                }))?;
                return Ok(());
            }
        }
        Err("Process Host terminal stream disconnected".into())
    }
}

fn bridge_error(error: impl Into<String>) -> RpcError {
    RpcError::new("terminal.bridgeFailed", error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::rpc::response::RpcResponse;
    use crate::transport::endpoint::channel::LocalIpcListener;

    #[test]
    fn exit_notification_carries_final_seq_when_queued_output_is_evicted() {
        let dir = crate::testing::temp_dir();
        let path = dir.path().join("terminal.sock");
        let listener = LocalIpcListener::bind(&path).unwrap();
        let mut writer = LocalIpcStream::connect(&path).unwrap();
        let reader = listener.accept().unwrap();
        let queue = Arc::new(WorkerNotificationQueue::new(256));
        let bridge = TerminalBridge::new(Arc::clone(&queue));
        let descriptor = serde_json::from_value(json!({
            "terminalId": "test-terminal", "generation": 1, "version": 1,
            "cols": 80, "rows": 24, "latestSeq": 7, "state": "running", "createdAtMs": 0
        })).unwrap();
        let process = json!({
            "humanControl": false, "state": "exited", "terminal": {"version": 2},
            "exit": {"exitCode": 0, "signal": 0}
        });
        for result in [
            json!({"process": {"humanControl": false}}),
            json!({"process": process, "latestSeq": 9, "frames": [
                {"seq": 8, "dataBase64": "aGVsbG8="}
            ]}),
            json!({"process": process, "latestSeq": 9, "frames": [
                {"seq": 9, "dataBase64": "d29ybGQ="}
            ]}),
        ] {
            codec::write_response(&mut writer, &RpcResponse::success("stream", result))
                .unwrap();
        }
        drop(writer);
        bridge.forward(reader, &descriptor, 7).unwrap();
        assert_eq!(queue.try_pop().unwrap().unwrap(), json!({
            "type": "notification", "method": "terminal.exit", "params": {
                "terminalId": "test-terminal", "generation": 1, "version": 2,
                "latestSeq": 9, "exitCode": 0, "signal": 0
            }
        }));
        assert_eq!(queue.try_pop().unwrap(), None);
    }
}
