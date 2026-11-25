//! Client for the instance-local Process Host. A disconnect never implies
//! that a non-idempotent request can safely be sent again.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

use crate::capability::rpc::{codec, request::RpcRequest};
use crate::instance::InstanceName;
use crate::instance::storage::{InstanceLock, InstancePaths, ensure_dir};
use crate::transport::endpoint::channel::{EndpointPaths, LocalIpcStream};

use super::protocol::{Handshake, PROTOCOL_VERSION, launch_lock, ownership_lock};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const RETIRE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub(crate) struct ProcessHostClient {
    endpoint: PathBuf,
    handshake: Handshake,
}

impl ProcessHostClient {
    /// Connect to an existing owner. Only an absent ownership lock means
    /// there is no Host; a live but unreachable owner is not replaced.
    pub fn connect(
        instance: &InstanceName,
        paths: &InstancePaths,
        endpoints: &EndpointPaths,
    ) -> Result<Option<Self>, String> {
        if !paths.state_dir.exists() {
            return Ok(None);
        }
        let endpoint = super::host::endpoint(endpoints);
        if InstanceLock::acquire_path(&ownership_lock(paths), true)?.is_some() {
            return Ok(None);
        }
        let handshake: Handshake = serde_json::from_value(request(
            &endpoint,
            "process.handshake",
            json!({}),
            CONNECT_TIMEOUT,
        )?)
        .map_err(|error| format!("invalid Process Host handshake: {error}"))?;
        if handshake.version != PROTOCOL_VERSION {
            return Err(format!(
                "Process Host protocol {} is incompatible with {}; live processes were preserved",
                handshake.version, PROTOCOL_VERSION,
            ));
        }
        if handshake.instance != instance.as_str() {
            return Err("Process Host belongs to another instance".into());
        }
        Ok(Some(Self {
            endpoint,
            handshake,
        }))
    }

    pub fn discover() -> Result<Vec<Self>, String> {
        let root = crate::host::home::devshell_home()?;
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let mut clients = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(instance) = InstanceName::parse(&name) else {
                continue;
            };
            let paths = InstancePaths::resolve(&instance)?;
            if !ownership_lock(&paths).exists() {
                continue;
            }
            let endpoints = EndpointPaths::resolve(&instance)?;
            if let Some(client) = Self::connect(&instance, &paths, &endpoints)? {
                clients.push(client);
            }
        }
        clients.sort_by(|a, b| a.handshake.instance.cmp(&b.handshake.instance));
        Ok(clients)
    }

    pub fn instance(&self) -> &str {
        &self.handshake.instance
    }

    pub fn ensure(instance: &InstanceName) -> Result<Self, String> {
        let paths = InstancePaths::resolve(instance)?;
        let endpoints = EndpointPaths::resolve(instance)?;
        ensure_dir(&paths.state_dir, 0o700)?;
        let _launch = InstanceLock::acquire_path(&launch_lock(&paths), false)?
            .ok_or_else(|| "failed to acquire Process Host launch lock".to_string())?;
        let mode = crate::daemon::process::current_security_mode();
        let identity = super::protocol::execution_identity(&mode)?;
        if let Some(client) = Self::connect(instance, &paths, &endpoints)? {
            return client.check_execution(&identity);
        }
        // Host inherits the Worker's environment and containment. A daemon
        // sandbox that dies with the Worker cannot promise persistence.
        if crate::capability::execution::ExecutionConfig::from_env()?
            .as_ref()
            .and_then(|config| config.sandbox.as_ref())
            .is_some_and(|sandbox| sandbox.phase == "daemon")
        {
            return Err(
                "independent Process Host is not available inside a daemon-phase sandbox".into(),
            );
        }
        super::host::launcher::spawn(instance, &paths, &mode)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match Self::connect(instance, &paths, &endpoints) {
                Ok(Some(client)) => return client.check_execution(&identity),
                Ok(None) => {}
                Err(error) if Instant::now() >= deadline => return Err(error),
                Err(_) => {}
            }
            if Instant::now() >= deadline {
                return Err("Process Host did not become ready".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn check_execution(self, identity: &str) -> Result<Self, String> {
        if self.handshake.execution_identity != identity {
            return Err(
                "Process Host execution configuration differs; existing resources preserved".into(),
            );
        }
        Ok(self)
    }

    pub fn subscribe(&self, id: &str, takeover: bool) -> Result<LocalIpcStream, String> {
        let mut channel = LocalIpcStream::connect_with_timeout(&self.endpoint, CONNECT_TIMEOUT)
            .map_err(|error| error.to_string())?;
        codec::write_request_frame(
            &mut channel,
            &RpcRequest::request(
                "subscribe",
                "process.v1.subscribe",
                json!({"id": id, "generation": self.handshake.generation, "takeover": takeover}),
            ),
        )?;
        Ok(channel)
    }

    pub fn list(&self) -> Result<Value, String> {
        self.call("process.v1.list", json!({}), CONNECT_TIMEOUT)
    }

    pub(crate) fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        // The generation is checked atomically by the owner, so a replacement
        // Host cannot accept a request intended for the previous generation.
        let mut params = params
            .as_object()
            .cloned()
            .ok_or_else(|| "Process Host parameters must be an object".to_string())?;
        params.insert("generation".to_string(), json!(self.handshake.generation));
        request(&self.endpoint, method, Value::Object(params), timeout)
    }
}

fn request(
    endpoint: &Path,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let mut channel = LocalIpcStream::connect_with_timeout(endpoint, CONNECT_TIMEOUT)
        .map_err(|error| format!("cannot connect to Process Host: {error}"))?;
    channel
        .set_request_timeout(timeout)
        .map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    codec::write_request_frame(&mut channel, &RpcRequest::request(&id, method, params))?;
    channel
        .wait_for_response(timeout)
        .map_err(|error| error.to_string())?;
    let response = codec::read_response(&mut channel)?
        .ok_or_else(|| "Process Host closed without a response".to_string())?;
    if response.id != id {
        return Err("Process Host returned a different request identity".into());
    }
    if response.ok {
        return response
            .result
            .ok_or_else(|| "Process Host returned no result".to_string());
    }
    Err(match response.error {
        Some(error) => format!("{}: {}", error.code, error.message),
        None => "Process Host rejected the request".into(),
    })
}

/// Retirement is an explicit instance lifecycle operation, separate from
/// Worker stop/restart. Do not delete data until the owner has released its lock.
pub(crate) fn retire(
    instance: &InstanceName,
    paths: &InstancePaths,
    endpoints: &EndpointPaths,
) -> Result<(), String> {
    if !paths.state_dir.exists() {
        return Ok(());
    }
    let _launch = InstanceLock::acquire_path(&launch_lock(paths), false)?
        .ok_or_else(|| "failed to acquire Process Host launch lock".to_string())?;
    if let Some(client) = ProcessHostClient::connect(instance, paths, endpoints)? {
        client.call("process.v1.retire", json!({}), RETIRE_TIMEOUT)?;
        let deadline = Instant::now() + RETIRE_TIMEOUT;
        loop {
            if InstanceLock::acquire_path(&ownership_lock(paths), true)?.is_some() {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Process Host did not release ownership after retirement".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Ok(())
}
