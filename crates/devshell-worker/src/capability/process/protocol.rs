use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::instance::sandbox::SecurityMode;
use crate::instance::storage::InstancePaths;

pub(super) const PROTOCOL_VERSION: u32 = 1;

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
