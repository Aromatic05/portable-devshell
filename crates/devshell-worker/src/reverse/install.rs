use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

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
    let install_dir = home.join("workers").join(target).join(&sha);
    let bin_dir = home.join("bin");
    let binary = install_dir.join("devshell-worker");
    let sha_file = install_dir.join("devshell-worker.sha256");
    let symlink_path = bin_dir.join("devshell-worker");

    fs::create_dir_all(&install_dir)
        .map_err(|error| format!("failed to create {}: {error}", install_dir.display()))?;
    fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("failed to create {}: {error}", bin_dir.display()))?;
    fs::set_permissions(&install_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to protect {}: {error}", install_dir.display()))?;
    fs::set_permissions(&bin_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to protect {}: {error}", bin_dir.display()))?;

    if !binary.exists() {
        atomic_write(&binary, &bytes, 0o755)?;
        atomic_write(&sha_file, format!("{sha}\n").as_bytes(), 0o600)?;
    }

    if symlink_path.exists() || symlink_path.symlink_metadata().is_ok() {
        fs::remove_file(&symlink_path)
            .map_err(|error| format!("failed to replace {}: {error}", symlink_path.display()))?;
    }
    symlink(
        PathBuf::from("../workers")
            .join(target)
            .join(&sha)
            .join("devshell-worker"),
        &symlink_path,
    )
    .map_err(|error| format!("failed to create {}: {error}", symlink_path.display()))?;
    Ok(symlink_path)
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

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(mode)
        .open(&tmp)
        .map_err(|error| format!("failed to open {}: {error}", tmp.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync {}: {error}", tmp.display()))?;
    fs::rename(&tmp, path)
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("failed to set mode on {}: {error}", path.display()))?;
    Ok(())
}

fn target_key() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("macos", "aarch64") => Ok("darwin-arm64"),
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
