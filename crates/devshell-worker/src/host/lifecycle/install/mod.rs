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

/// Install the current executable, updating the CLI alias on Unix, and return
/// the verified content path for execution on every platform.
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

/// Resolve rollback ownership from the daemon's content identity. The shared
/// alias is only a discovery fallback; its actual bytes must match that identity.
pub(super) fn verified_installed_binary(sha: &str) -> Result<PathBuf, String> {
    previous_binary(&devshell_home()?, target_key()?, sha)
}

fn previous_binary(home: &Path, target: &str, sha: &str) -> Result<PathBuf, String> {
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("cannot identify previous Worker: invalid content SHA".to_string());
    }
    let name = if cfg!(windows) {
        "devshell-worker.exe"
    } else {
        "devshell-worker"
    };
    let binary = home.join("workers").join(target).join(sha).join(name);
    // Only a missing cache entry permits discovery through the Unix alias.
    // Corrupt or inaccessible cached content must fail closed.
    match fs::symlink_metadata(&binary) {
        #[cfg(unix)]
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let alias = home.join("bin").join(name);
            let destination = fs::read_link(&alias).map_err(|error| {
                format!(
                    "cannot identify previous Worker {}: {error}",
                    alias.display()
                )
            })?;
            let destination =
                fs::canonicalize(alias.parent().unwrap().join(destination)).map_err(|error| {
                    format!(
                        "cannot resolve previous Worker {}: {error}",
                        alias.display()
                    )
                })?;
            verify_path(&destination, sha)
        }
        _ => verify_path(&binary, sha),
    }
}

/// Save a canonical content path before alias activation. Rollback revalidates
/// this exact path and SHA, never rediscovers content through a mutable alias.
pub(super) fn verify_path(binary: &Path, sha: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(binary).map_err(|error| {
        format!(
            "cannot identify previous Worker {}: {error}",
            binary.display()
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "previous Worker is not a content file: {}",
            binary.display()
        ));
    }
    let binary = fs::canonicalize(binary).map_err(|error| {
        format!(
            "cannot resolve previous Worker {}: {error}",
            binary.display()
        )
    })?;
    let bytes = fs::read(&binary)
        .map_err(|error| format!("cannot read previous Worker {}: {error}", binary.display()))?;
    if hex(&Sha256::digest(&bytes)) != sha {
        return Err(format!(
            "previous Worker checksum mismatch: {}",
            binary.display()
        ));
    }
    Ok(binary)
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

#[cfg(all(test, unix))]
mod previous_content_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn cached_daemon_content_wins_over_another_instances_alias() {
        let home = crate::testing::temp_dir();
        let sha = hex(&Sha256::digest(b"previous"));
        let cached = platform::install(b"previous", home.path(), "linux-x64", &sha).unwrap();
        let other_sha = hex(&Sha256::digest(b"other"));
        let other = platform::install(b"other", home.path(), "linux-x64", &other_sha).unwrap();
        assert_eq!(
            previous_binary(home.path(), "linux-x64", &sha).unwrap(),
            cached
        );
        assert_eq!(
            home.path()
                .join("bin/devshell-worker")
                .canonicalize()
                .unwrap(),
            other
        );
    }

    #[test]
    fn external_previous_content_is_pinned_before_alias_changes() {
        let home = crate::testing::temp_dir();
        let external = crate::testing::temp_dir();
        let previous = external.path().join("previous-worker");
        fs::write(&previous, b"previous").unwrap();
        let sha = hex(&Sha256::digest(b"previous"));
        let alias = home.path().join("bin/devshell-worker");
        fs::create_dir_all(alias.parent().unwrap()).unwrap();
        symlink(&previous, &alias).unwrap();
        let saved = previous_binary(home.path(), "linux-x64", &sha).unwrap();
        assert_eq!(saved, previous.canonicalize().unwrap());
        let other_sha = hex(&Sha256::digest(b"other"));
        let other = platform::install(b"other", home.path(), "linux-x64", &other_sha).unwrap();
        assert_eq!(verify_path(&saved, &sha).unwrap(), saved);
        assert_eq!(alias.canonicalize().unwrap(), other);
        // With no cached P, discovering U must not claim it is the old daemon.
        assert!(
            previous_binary(home.path(), "linux-x64", &sha)
                .unwrap_err()
                .contains("checksum mismatch")
        );
        fs::write(&saved, b"changed after preparation").unwrap();
        assert!(
            verify_path(&saved, &sha)
                .unwrap_err()
                .contains("checksum mismatch")
        );
        fs::remove_file(&saved).unwrap();
        assert!(verify_path(&saved, &sha).is_err());
        // Even a same-content symlink replacement cannot redirect rollback.
        fs::write(&previous, b"previous").unwrap();
        let moved = external.path().join("moved-worker");
        fs::rename(&previous, &moved).unwrap();
        symlink(&moved, &saved).unwrap();
        assert!(
            verify_path(&saved, &sha)
                .unwrap_err()
                .contains("not a content file")
        );
        assert_eq!(alias.canonicalize().unwrap(), other);
    }

    #[test]
    fn corrupt_cache_is_rejected_even_when_alias_has_matching_external_content() {
        let home = crate::testing::temp_dir();
        let external = crate::testing::temp_dir();
        let sha = hex(&Sha256::digest(b"previous"));
        let cached = platform::install(b"previous", home.path(), "linux-x64", &sha).unwrap();
        fs::write(&cached, b"corrupt").unwrap();
        let previous = external.path().join("previous-worker");
        fs::write(&previous, b"previous").unwrap();
        let alias = home.path().join("bin/devshell-worker");
        fs::remove_file(&alias).unwrap();
        symlink(&previous, &alias).unwrap();
        assert!(
            previous_binary(home.path(), "linux-x64", &sha)
                .unwrap_err()
                .contains("checksum mismatch")
        );
        assert!(
            previous_binary(home.path(), "linux-x64", "../bad-sha")
                .unwrap_err()
                .contains("invalid content SHA")
        );
    }
}
