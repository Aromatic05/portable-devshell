//! Client for the instance-local Process Host. A disconnect never implies
//! that a non-idempotent request can safely be sent again.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

use crate::capability::rpc::{codec, error::RpcError, request::RpcRequest};
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
        Self::ensure_with(instance, &crate::daemon::process::current_security_mode(), |paths, mode| {
            if crate::capability::execution::ExecutionConfig::from_env()?
                .as_ref().and_then(|config| config.sandbox.as_ref())
                .is_some_and(|sandbox| sandbox.phase == "daemon")
            {
                return Err("daemon-phase Process Host must be started by the Worker launcher".into());
            }
            super::host::launcher::spawn(instance, paths, mode)
        })
    }

    #[cfg(unix)]
    pub(crate) fn ensure_for_daemon(
        instance: &InstanceName,
        mode: &crate::instance::sandbox::SecurityMode,
        command: std::process::Command,
    ) -> Result<Self, String> {
        Self::ensure_with(instance, mode, |paths, mode| {
            super::host::launcher::spawn_command(command, instance, paths, mode)
        })
    }

    fn ensure_with(
        instance: &InstanceName,
        mode: &crate::instance::sandbox::SecurityMode,
        launch: impl FnOnce(&InstancePaths, &crate::instance::sandbox::SecurityMode) -> Result<(), String>,
    ) -> Result<Self, String> {
        let paths = InstancePaths::resolve(instance)?;
        let endpoints = EndpointPaths::resolve(instance)?;
        ensure_dir(&paths.state_dir, 0o700)?;
        let _launch = InstanceLock::acquire_path(&launch_lock(&paths), false)?
            .ok_or_else(|| "failed to acquire Process Host launch lock".to_string())?;
        let identity = super::protocol::execution_identity(mode)?;
        if let Some(client) = Self::connect(instance, &paths, &endpoints)? {
            return client.check_execution(&identity);
        }
        launch(&paths, mode)?;
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
        self.subscribe_from(id, takeover, None)
    }

    pub fn subscribe_from(
        &self,
        id: &str,
        takeover: bool,
        from_seq: Option<u64>,
    ) -> Result<LocalIpcStream, String> {
        self.subscribe_stream(id, takeover, from_seq, false)
    }

    pub(crate) fn subscribe_remote_control(&self, id: &str) -> Result<LocalIpcStream, String> {
        self.subscribe_stream(id, true, None, true)
    }

    fn subscribe_stream(
        &self,
        id: &str,
        takeover: bool,
        from_seq: Option<u64>,
        remote: bool,
    ) -> Result<LocalIpcStream, String> {
        let mut channel = LocalIpcStream::connect_with_timeout(&self.endpoint, CONNECT_TIMEOUT)
            .map_err(|error| error.to_string())?;
        codec::write_request_frame(
            &mut channel,
            &RpcRequest::request(
                "subscribe",
                "process.v1.subscribe",
                json!({"id": id, "generation": self.handshake.generation, "takeover": takeover, "fromSeq": from_seq, "remote": remote}),
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
        self.call_rpc(method, params, timeout)
            .map_err(|error| format!("{}: {}", error.code, error.message))
    }

    pub(crate) fn call_rpc(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        // The generation is checked atomically by the owner, so a replacement
        // Host cannot accept a request intended for the previous generation.
        let mut params = params.as_object().cloned().ok_or_else(|| {
            RpcError::new(
                "rpc.invalidParams",
                "Process Host parameters must be an object",
            )
        })?;
        params.insert("generation".to_string(), json!(self.handshake.generation));
        request_rpc(&self.endpoint, method, Value::Object(params), timeout)
    }
}

fn request(
    endpoint: &Path,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    request_rpc(endpoint, method, params, timeout)
        .map_err(|error| format!("{}: {}", error.code, error.message))
}

fn request_rpc(
    endpoint: &Path,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, RpcError> {
    fn transport(error: impl std::fmt::Display) -> RpcError {
        RpcError::new("process.hostFailed", error.to_string())
    }
    let mut channel =
        LocalIpcStream::connect_with_timeout(endpoint, CONNECT_TIMEOUT).map_err(transport)?;
    channel.set_request_timeout(timeout).map_err(transport)?;
    let id = Uuid::new_v4().to_string();
    codec::write_request_frame(&mut channel, &RpcRequest::request(&id, method, params))
        .map_err(transport)?;
    channel.wait_for_response(timeout).map_err(transport)?;
    let response = codec::read_response(&mut channel)
        .map_err(transport)?
        .ok_or_else(|| transport("Process Host closed without a response"))?;
    if response.id != id {
        return Err(transport(
            "Process Host returned a different request identity",
        ));
    }
    if response.ok {
        return response
            .result
            .ok_or_else(|| transport("Process Host returned no result"));
    }
    Err(match response.error {
        Some(error) => RpcError {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: error.details,
        },
        None => transport("Process Host rejected the request"),
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
