use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

#[cfg(unix)]
#[path = "install_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "install_windows.rs"]
mod platform;

use super::hex;

use crate::instance::InstanceName;
use crate::storage::devshell_home;

pub fn install_current_binary() -> Result<PathBuf, String> {
    let source = std::env::current_exe()
        .map_err(|error| format!("failed to resolve current worker executable: {error}"))?;
    let bytes = fs::read(&source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?;
    let sha = hex(&Sha256::digest(&bytes));
    let home = devshell_home()?;
    let target = target_key()?;
    platform::install(&bytes, &home, target, &sha)
}

pub fn start_installed_worker(
    binary: &Path,
    instance: &InstanceName,
    workspace: &Path,
) -> Result<(), String> {
    let output = Command::new(binary)
        .arg("start")
        .arg("--instance")
        .arg(instance.as_str())
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("failed to start installed worker: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "installed worker start failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn target_key() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("windows", "x86_64") => Ok("windows-x64"),
        ("windows", "aarch64") => Ok("windows-arm64"),
        (os, arch) => Err(format!("unsupported worker target: {os}-{arch}")),
    }
}
#[cfg(test)]
mod tests {
    use super::target_key;

    #[test]
    fn current_target_is_supported_in_ci() {
        assert!(target_key().is_ok());
    }
}
