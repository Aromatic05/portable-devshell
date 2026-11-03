use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_file_mode;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseConnectionState {
    pub state: String,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub pid: u32,
    pub transport: Option<String>,
    pub last_error: Option<String>,
    pub updated_at_ms: u64,
}

fn path(paths: &InstancePaths) -> std::path::PathBuf {
    paths.state_dir.join("reverse-connection.json")
}

pub fn read(paths: &InstancePaths) -> Option<ReverseConnectionState> {
    let value = fs::read_to_string(path(paths)).ok()?;
    serde_json::from_str(&value).ok()
}

pub fn write(
    paths: &InstancePaths,
    state: &str,
    transport: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    write_connection(paths, generation(paths), state, transport, error)
}

pub(super) fn write_connection(
    paths: &InstancePaths,
    generation: u64,
    state: &str,
    transport: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let updated_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let value = ReverseConnectionState {
        state: state.to_string(),
        generation,
        pid: std::process::id(),
        transport: transport.map(ToString::to_string),
        last_error: error.map(ToString::to_string),
        updated_at_ms,
    };
    let data = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    let file = path(paths);
    // Only one connector writes this state per daemon. A temporary file keeps
    // observers from reading partially-written status snapshots.
    let temporary = file.with_extension("tmp");
    fs::write(&temporary, data)
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    ensure_file_mode(&temporary, 0o600)?;
    #[cfg(windows)]
    let _ = fs::remove_file(&file);
    fs::rename(&temporary, &file)
        .map_err(|error| format!("failed to replace {}: {error}", file.display()))?;
    Ok(())
}

pub fn generation(paths: &InstancePaths) -> u64 {
    fs::read_to_string(paths.state_dir.join("reverse-generation"))
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}
