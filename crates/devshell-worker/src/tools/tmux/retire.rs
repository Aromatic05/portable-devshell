use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::socket::SocketPaths;
use crate::storage::InstancePaths;

use super::backend::TMUX_SESSION;
use super::transcript_ring;

pub fn retire_instance_runtime(
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    instance: &str,
) -> Result<(), String> {
    for socket in socket_candidates(socket_paths)? {
        if !owned_session(&socket, instance)? {
            continue;
        }
        let output = Command::new("tmux")
            .arg("-S")
            .arg(&socket)
            .args(["kill-session", "-t", TMUX_SESSION])
            .output()
            .map_err(|error| {
                format!(
                    "failed to retire tmux session {}: {error}",
                    socket.display()
                )
            })?;
        if !output.status.success() {
            return Err(format!(
                "failed to retire tmux session {}: {}",
                socket.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }

    let tmux_root = instance_paths.instance_root.join("tmux");
    remove_recorded_rings(&tmux_root)?;
    match fs::remove_dir_all(&tmux_root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", tmux_root.display())),
    }
}

fn socket_candidates(socket_paths: &SocketPaths) -> Result<Vec<PathBuf>, String> {
    let mut sockets = HashSet::new();
    #[cfg(unix)]
    {
        sockets.insert(socket_paths.tmux_socket_file.clone());
        collect_matching_sockets(&socket_paths.instance_runtime_dir, "tmux-", &mut sockets)?;
        collect_matching_sockets(Path::new("/tmp"), "devshell-tmux-", &mut sockets)?;
    }
    Ok(sockets.into_iter().collect())
}

#[cfg(unix)]
fn collect_matching_sockets(
    directory: &Path,
    prefix: &str,
    sockets: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to read {}: {error}", directory.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(".sock") {
            sockets.insert(entry.path());
        }
    }
    Ok(())
}

fn owned_session(socket: &Path, instance: &str) -> Result<bool, String> {
    let has_session = Command::new("tmux")
        .arg("-S")
        .arg(socket)
        .args(["has-session", "-t", TMUX_SESSION])
        .output();
    let Ok(has_session) = has_session else {
        return Ok(false);
    };
    if !has_session.status.success() {
        return Ok(false);
    }
    let managed = show_option(socket, "@devshell_worker_managed")?;
    let owner = show_option(socket, "@devshell_worker_instance")?;
    Ok(managed == "1" && owner == instance)
}

fn show_option(socket: &Path, option: &str) -> Result<String, String> {
    let output = Command::new("tmux")
        .arg("-S")
        .arg(socket)
        .args(["show-options", "-qv", "-t", TMUX_SESSION, option])
        .output()
        .map_err(|error| {
            format!(
                "failed to inspect tmux session {}: {error}",
                socket.display()
            )
        })?;
    if !output.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn remove_recorded_rings(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("failed to read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                directories.push(path);
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("ring") {
                continue;
            }
            let name = fs::read_to_string(&path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
            transcript_ring::remove(name.trim()).map_err(|error| {
                format!(
                    "failed to remove tmux shared memory {}: {error}",
                    name.trim()
                )
            })?;
        }
    }
    Ok(())
}
