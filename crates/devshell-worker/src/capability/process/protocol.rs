use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::instance::sandbox::SecurityMode;
use crate::instance::storage::InstancePaths;

pub(super) const PROTOCOL_VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Handshake {
    pub version: u32,
    pub pid: u32,
    pub instance: String,
    pub generation: String,
    pub execution_identity: String,
}

/// The Host inherits daemon-phase execution configuration at launch. A new
/// Worker must not silently execute under a different inherited policy.
pub(super) fn execution_identity(mode: &SecurityMode) -> Result<String, String> {
    let raw = std::env::var(crate::capability::execution::CONFIG_ENV);
    let config = match raw {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|error| format!("invalid execution configuration: {error}"))?,
        Err(std::env::VarError::NotPresent) => serde_json::Value::Null,
        Err(error) => return Err(error.to_string()),
    };
    let identity = serde_json::json!({
        "securityMode": match mode {
            SecurityMode::Disabled => "disabled",
            SecurityMode::Workspace => "workspace",
        },
        "execution": config,
    });
    Ok(
        blake3::hash(&serde_json::to_vec(&identity).map_err(|error| error.to_string())?)
            .to_hex()
            .to_string(),
    )
}

pub(super) fn ownership_lock(paths: &InstancePaths) -> PathBuf {
    paths.state_dir.join("process-host.lock")
}

pub(super) fn launch_lock(paths: &InstancePaths) -> PathBuf {
    paths.state_dir.join("process-host-launch.lock")
}

use super::output::OutputChannel;
use std::collections::BTreeMap;

pub(super) const MAX_WAIT_MS: u64 = 30_000;
pub(super) const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpawnInput {
    pub command: String,
    pub cwd: String,
    pub workspace: Option<PathBuf>,
    #[serde(default)]
    pub tty: bool,
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub persistent: bool,
    pub name: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    #[serde(default)]
    pub env: BTreeMap<String, Option<String>>,
    pub stdin: Option<String>,
    #[serde(default)]
    pub keep_stdin: bool,
    pub id: Option<String>,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub prepared_env: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Target {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WaitPinInput {
    pub owner: String,
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WaitReconcileInput {
    pub owners: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReadInput {
    pub id: String,
    #[serde(default)]
    pub from_seq: u64,
    #[serde(default)]
    pub shell_generation: Option<u64>,
    #[serde(default)]
    pub wait_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CaptureInput {
    pub id: String,
    #[serde(default)]
    pub shell_generation: Option<u64>,
    pub channel: OutputChannel,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WriteInput {
    pub id: String,
    #[serde(default)]
    pub shell_generation: Option<u64>,
    pub data_base64: String,
    pub controller: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ResizeInput {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    pub controller: Option<String>,
}

use crate::capability::rpc::{error::RpcError, request::RpcRequest};
use serde_json::Value;
pub(super) fn validate_dimensions(cols: u16, rows: u16) -> Result<(), RpcError> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err(invalid("invalid terminal dimensions"));
    }
    Ok(())
}

pub(super) fn parse<T: serde::de::DeserializeOwned>(request: &RpcRequest) -> Result<T, RpcError> {
    serde_json::from_value(request.params.clone()).map_err(|error| invalid(error.to_string()))
}

pub(super) fn serialize(value: impl serde::Serialize) -> Result<Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|error| RpcError::new("process.internal", error.to_string()))
}

pub(super) fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new("rpc.invalidParams", message)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SubscribeInput {
    pub id: String,
    #[serde(default)]
    pub takeover: bool,
    #[serde(default)]
    pub remote: bool,
    pub from_seq: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReleaseInput {
    pub id: String,
    pub controller: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TerminalRequest<T> {
    pub terminal: T,
}
