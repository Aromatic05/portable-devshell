#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::instance::InstanceName;
use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_file_mode;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerConfig {
    pub version: u32,
    pub instance: String,
    pub created_at: u64,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
}

pub fn build_config(instance: &InstanceName) -> Result<WorkerConfig, String> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();

    Ok(WorkerConfig {
        version: 1,
        instance: instance.as_str().to_string(),
        created_at,
        reverse: None,
    })
}

pub fn write_config(paths: &InstancePaths, config: &WorkerConfig) -> Result<(), String> {
    let body = toml::to_string(config).map_err(|error| error.to_string())?;
    let parent = paths
        .config_file
        .parent()
        .ok_or_else(|| "worker config path has no parent directory".to_string())?;
    let file_name = paths
        .config_file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config.toml");
    let temporary = parent.join(format!(".{file_name}.tmp-{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("failed to open {}: {error}", temporary.display()))?;
        ensure_file_mode(&temporary, 0o600)?;
        file.write_all(body.as_bytes())
            .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync {}: {error}", temporary.display()))?;
        replace_file(&temporary, &paths.config_file)?;
        ensure_file_mode(&paths.config_file, 0o600)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("failed to replace {}: {error}", destination.display()))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result != 0 {
        return Ok(());
    }
    Err(format!(
        "failed to replace worker config: {}",
        std::io::Error::last_os_error()
    ))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync directory {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{WorkerConfig, WorkerReverseConfig};

    #[test]
    fn reverse_proxy_url_round_trips_and_old_config_defaults_to_none() {
        let config = WorkerConfig {
            version: 1,
            instance: "proxy-test".to_string(),
            created_at: 1,
            reverse: Some(WorkerReverseConfig {
                controller_url: "https://controller.example".to_string(),
                device_token: "token".to_string(),
                generation: 7,
                proxy_url: Some("socks5h://127.0.0.1:1080".to_string()),
            }),
        };
        let encoded = toml::to_string(&config).unwrap();
        assert!(encoded.contains("proxyUrl = \"socks5h://127.0.0.1:1080\""));
        let decoded: WorkerConfig = toml::from_str(&encoded).unwrap();
        assert_eq!(
            decoded.reverse.unwrap().proxy_url.as_deref(),
            Some("socks5h://127.0.0.1:1080")
        );

        let old: WorkerConfig = toml::from_str(
            r#"
version = 1
instance = "old"
createdAt = 1

[reverse]
controllerUrl = "https://controller.example"
deviceToken = "token"
generation = 2
"#,
        )
        .unwrap();
        assert_eq!(old.reverse.unwrap().proxy_url, None);
    }
}
