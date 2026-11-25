//! Client for the instance-local Process Host. A disconnect never implies
//! that a non-idempotent request can safely be sent again.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

use crate::capability::rpc::{codec, request::RpcRequest};
use crate::instance::InstanceName;
use crate::instance::storage::{InstanceLock, InstancePaths};
use crate::transport::endpoint::channel::{EndpointPaths, LocalIpcStream};

use super::protocol::{Handshake, PROTOCOL_VERSION, launch_lock, ownership_lock};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const RETIRE_TIMEOUT: Duration = Duration::from_secs(15);

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

    pub fn list(&self) -> Result<Value, String> {
        self.call("process.v1.list", json!({}), CONNECT_TIMEOUT)
    }

    fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
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
