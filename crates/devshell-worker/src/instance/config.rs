use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::instance::InstanceName;
use crate::storage::InstancePaths;
use crate::storage::permissions::ensure_file_mode;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerConfig {
    pub version: u32,
    pub instance: String,
    pub created_at: u64,
    #[serde(default)]
    pub tools: WorkerToolsConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverse: Option<WorkerReverseConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerReverseConfig {
    pub controller_url: String,
    pub device_token: String,
    #[serde(default)]
    pub generation: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerToolsConfig {}

pub fn build_config(instance: &InstanceName) -> Result<WorkerConfig, String> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    Ok(WorkerConfig {
        version: 1,
        instance: instance.as_str().to_string(),
        created_at,
        tools: WorkerToolsConfig::default(),
        reverse: None,
    })
}

pub fn write_config(paths: &InstancePaths, config: &WorkerConfig) -> Result<(), String> {
    let body = toml::to_string(config).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&paths.config_file)
        .map_err(|error| format!("failed to open {}: {error}", paths.config_file.display()))?;
    ensure_file_mode(&paths.config_file, 0o600)?;
    file.write_all(body.as_bytes())
        .map_err(|error| format!("failed to write {}: {error}", paths.config_file.display()))?;
    Ok(())
}

pub fn read_config(paths: &InstancePaths, instance: &InstanceName) -> Result<WorkerConfig, String> {
    let body = fs::read_to_string(&paths.config_file)
        .map_err(|error| format!("failed to read {}: {error}", paths.config_file.display()))?;
    let config: WorkerConfig = toml::from_str(&body)
        .map_err(|error| format!("failed to parse {}: {error}", paths.config_file.display()))?;

    if config.instance != instance.as_str() {
        return Err(format!(
            "config instance mismatch in {}: expected {}, found {}",
            paths.config_file.display(),
            instance,
            config.instance
        ));
    }

    Ok(config)
}
