use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::capability::process::client::ProcessHostClient;
use crate::capability::rpc::{error::RpcError, notification::WorkerNotificationQueue};
use crate::instance::{InstanceName, sandbox::SecurityPolicy, storage::InstancePaths};
use crate::transport::endpoint::channel::EndpointPaths;

use super::bridge::TerminalBridge;
use super::model::*;
use super::path::resolve_cwd;

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct TerminalManager {
    instance: InstanceName,
    policy: Arc<dyn SecurityPolicy>,
    bridge: TerminalBridge,
}

impl TerminalManager {
    pub(crate) fn with_policy_notifications(
        instance: InstanceName,
        policy: Arc<dyn SecurityPolicy>,
        notifications: Arc<WorkerNotificationQueue>,
    ) -> Self {
        Self {
            instance,
            policy,
            bridge: TerminalBridge::new(notifications),
        }
    }

    pub(crate) fn spawn_control_watcher(&self, shutdown: Arc<AtomicBool>) {
        let manager = self.clone();
        std::thread::spawn(move || {
            let mut tracked: HashMap<String, bool> = HashMap::new();
            while !shutdown.load(Ordering::Acquire) {
                match manager.connect() {
                    Ok(Some(client)) => {
                        if let Ok(resources) = client.call_rpc(
                            "process.v1.list",
                            json!({}),
                            Duration::from_secs(2),
                        ) && let Some(resources) = resources.as_array()
                        {
                            let mut next = HashMap::new();
                            for resource in resources {
                                let Some(terminal) = resource
                                    .get("terminal")
                                    .filter(|terminal| !terminal.is_null())
                                else {
                                    continue;
                                };
                                let Ok(descriptor) =
                                    decode::<TerminalDescriptor>(terminal.clone())
                                else {
                                    continue;
                                };
                                if descriptor.state != "running" {
                                    continue;
                                }
                                let was_human = tracked.get(&descriptor.terminal_id).copied();
                                if was_human == Some(true)
                                    && !descriptor.human_control
                                    && !manager.bridge.is_subscribed(&descriptor.terminal_id)
                                {
                                    let _ =
                                        manager.bridge.push_control_notification(&descriptor);
                                }
                                next.insert(descriptor.terminal_id, descriptor.human_control);
                            }
                            tracked = next;
                        }
                    }
                    Ok(None) => tracked.clear(),
                    Err(_) => {}
                }
                for _ in 0..10 {
                    if shutdown.load(Ordering::Acquire) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        });
    }

    fn connect(&self) -> Result<Option<ProcessHostClient>, RpcError> {
        let paths = InstancePaths::resolve(&self.instance).map_err(host_error)?;
        let endpoints = EndpointPaths::resolve(&self.instance).map_err(host_error)?;
        ProcessHostClient::connect(&self.instance, &paths, &endpoints).map_err(host_error)
    }

    fn require(&self) -> Result<ProcessHostClient, RpcError> {
        self.connect()?
            .ok_or_else(|| RpcError::new("instance.missing", "Process Host does not exist"))
    }

    pub fn open(&self, input: TerminalOpenInput) -> Result<TerminalDescriptor, RpcError> {
        validate_dimensions(input.cols, input.rows)?;
        resolve_cwd(
            Path::new(&input.workspace),
            self.policy.as_ref(),
            input.cwd.as_deref(),
        )?;
        let client = ProcessHostClient::ensure(&self.instance).map_err(host_error)?;
        let mut spawn_params = json!({
            "command": "",
            "interactive": true,
            "persistent": input.persistent.unwrap_or(false),
            "cwd": input.cwd.unwrap_or_else(|| "./".into()),
            "workspace": input.workspace,
            "tty": true,
            "cols": input.cols,
            "rows": input.rows,
            "stdin": input.command.filter(|command| !command.is_empty()).map(|command| format!("{command}\r")),
        });
        if let Some(name) = input.name.filter(|name| !name.is_empty()) {
            spawn_params["name"] = json!(name);
        }
        let created = client.call_rpc("process.v1.spawn", spawn_params, TIMEOUT)?;
        let descriptor: TerminalDescriptor = decode(created["terminal"].clone())?;
        self.bridge.subscribe(&client, &descriptor, 0)?;
        Ok(descriptor)
    }

    pub fn inspect(&self, input: TerminalInspectInput) -> Result<TerminalInspectResult, RpcError> {
        let client = self.require()?;
        if input.generation != 1 {
            return Err(RpcError::new(
                "instance.conflict",
                "Terminal generation changed.",
            ));
        }
        let described = client.call_rpc(
            "process.v1.describe",
            json!({"id": input.terminal_id}),
            TIMEOUT,
        )?;
        let session: TerminalDescriptor = decode(described["terminal"].clone())?;
        let screen = client.call_rpc(
            "process.v1.inspect",
            json!({"id": input.terminal_id}),
            TIMEOUT,
        )?;
        let cols = screen["cols"]
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(session.cols);
        let rows = screen["rows"]
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(session.rows);
        let seq = screen["seq"].as_u64().unwrap_or(session.latest_seq);
        let lines = screen["text"]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(|text| text.split('\n').map(str::to_owned).collect())
            .unwrap_or_default();
        let cursor = json!({
            "row": screen["cursorRow"].as_u64().unwrap_or(0),
            "col": screen["cursorCol"].as_u64().unwrap_or(0),
        });
        Ok(TerminalInspectResult {
            session,
            cols,
            rows,
            cursor,
            lines,
            seq,
        })
    }

    pub fn attach(&self, input: TerminalAttachInput) -> Result<TerminalAttachResult, RpcError> {
        let client = self.require()?;
        let result: TerminalAttachResult = decode(client.call_rpc(
            "process.v1.terminalAttach",
            json!({"terminal": input}),
            TIMEOUT,
        )?)?;
        if result.exit.is_none() {
            self.bridge
                .subscribe(&client, &result.session, result.session.latest_seq)?;
        }
        Ok(result)
    }

    pub fn control(&self, input: TerminalControlInput) -> Result<Value, RpcError> {
        let client = self.require()?;
        if input.generation != 1 {
            return Err(RpcError::new(
                "instance.conflict",
                "Terminal generation changed.",
            ));
        }
        if let Some(controller) = input.controller {
            let method = if input.renew {
                "process.v1.renewControl"
            } else {
                "process.v1.releaseControl"
            };
            return client.call_rpc(
                method,
                json!({"id": input.terminal_id, "controller": controller}),
                TIMEOUT,
            );
        }
        self.bridge.take_control(&client, &input.terminal_id)
    }

    pub fn write(&self, input: TerminalWriteInput) -> Result<Value, RpcError> {
        self.require()?.call_rpc(
            "process.v1.terminalWrite",
            json!({"terminal": input}),
            TIMEOUT,
        )
    }

    pub fn resize(&self, input: TerminalResizeInput) -> Result<Value, RpcError> {
        validate_dimensions(input.cols, input.rows)?;
        self.require()?.call_rpc(
            "process.v1.terminalResize",
            json!({"terminal": input}),
            TIMEOUT,
        )
    }

    pub fn kill(&self, input: TerminalCommandInput) -> Result<TerminalDescriptor, RpcError> {
        decode(self.require()?.call_rpc(
            "process.v1.terminalKill",
            json!({"terminal": input}),
            TIMEOUT,
        )?)
    }

    pub fn list(&self) -> Result<Vec<TerminalDescriptor>, RpcError> {
        let Some(client) = self.connect()? else {
            return Ok(Vec::new());
        };
        let resources = client.call_rpc("process.v1.list", json!({}), TIMEOUT)?;
        let resources = resources
            .as_array()
            .ok_or_else(|| host_error("invalid Process Host resource list"))?;
        resources
            .iter()
            .filter_map(|resource| {
                resource
                    .get("terminal")
                    .filter(|terminal| !terminal.is_null())
                    .map(|terminal| decode(terminal.clone()))
            })
            .collect()
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(host_error)
}

fn host_error(error: impl std::fmt::Display) -> RpcError {
    RpcError::new("process.hostFailed", error.to_string())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), RpcError> {
    if cols < 2 || rows < 1 {
        return Err(RpcError::new(
            "target.invalid",
            "Terminal dimensions are invalid.",
        ));
    }
    Ok(())
}
