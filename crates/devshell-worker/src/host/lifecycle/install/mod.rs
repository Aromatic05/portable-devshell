use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

#[cfg(unix)]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;

use crate::daemon::process::{self, PlatformInfo, WorkerRuntimeContext};
use crate::host::home::devshell_home;
use crate::instance::storage::InstancePaths;
use crate::instance::{InstanceLock, InstanceName};
use crate::transport::endpoint::channel::EndpointPaths;

pub fn install_current_binary() -> Result<PathBuf, String> {
    let source = std::env::current_exe()
        .map_err(|error| format!("failed to resolve current worker executable: {error}"))?;
    install_from_path(&source)
}

pub fn install_from_path(source: &Path) -> Result<PathBuf, String> {
    let bytes = fs::read(&source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?;
    let sha = hex(&Sha256::digest(&bytes));
    let home = devshell_home()?;
    let target = target_key()?;
    platform::install(&bytes, &home, target, &sha)
}

pub fn start_installed_worker(binary: &Path, instance: &InstanceName) -> Result<(), String> {
    // Enrollment needs only local readiness; its bounded connection check
    // handles offline/retrying without waiting for Control's final Ready.
    let paths = InstancePaths::resolve(instance)?;
    let sockets = EndpointPaths::resolve(instance)?;
    let _lock = InstanceLock::acquire(&paths)?;
    if process::daemon_state(&paths, &sockets) != process::DaemonState::Stopped {
        return Err("Worker runtime changed during enrollment; daemon preserved".to_string());
    }
    let runtime = WorkerRuntimeContext {
        instance: instance.clone(),
        platform: PlatformInfo {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        },
        security_mode: process::current_security_mode(),
        worker_sha256: None,
    };
    crate::cli::instance::lifecycle::start::start_daemon_executable(
        instance, &paths, &sockets, &runtime, binary,
    )
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
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::target_key;

    #[test]
    fn current_target_is_supported_in_ci() {
        assert!(target_key().is_ok());
    }
}
