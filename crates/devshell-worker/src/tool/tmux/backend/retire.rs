#[cfg(unix)]
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::instance::storage::InstancePaths;
use crate::transport::socket::SocketPaths;

use super::TMUX_SESSION;
use crate::tool::tmux::transcript::ring as transcript_ring;

pub fn retire_instance_runtime(
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    instance: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    let _ = socket_paths;
    #[cfg(unix)]
    for socket in socket_candidates(socket_paths)? {
        if !owned_session(&socket, instance, None)? {
            continue;
        }
        let output = run_mux(&socket, &["kill-session", "-t", TMUX_SESSION], None)?;
        if !output.status.success() {
            return Err(format!(
                "failed to retire tmux session {}: {}",
                socket.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }

    #[cfg(windows)]
    retire_windows_workspaces(instance_paths, instance)?;

    let tmux_root = instance_paths.instance_root.join("tmux");
    remove_recorded_rings(&tmux_root)?;
    match fs::remove_dir_all(&tmux_root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", tmux_root.display())),
    }
}

#[cfg(windows)]
fn retire_windows_workspaces(instance_paths: &InstancePaths, instance: &str) -> Result<(), String> {
    let psmux_data_dir = instance_paths.instance_root.join("tmux").join("psmux");
    let workspaces = instance_paths.instance_root.join("tmux").join("workspaces");
    let entries = match fs::read_dir(&workspaces) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to read {}: {error}", workspaces.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let key = entry.file_name();
        let key = key.to_string_lossy();
        let namespace = PathBuf::from(format!("devshell-{key}"));
        if !owned_session(&namespace, instance, Some(&psmux_data_dir))? {
            continue;
        }
        let output = run_mux(
            &namespace,
            &["kill-session", "-t", TMUX_SESSION],
            Some(&psmux_data_dir),
        )?;
        if !output.status.success() {
            return Err(format!(
                "failed to retire psmux namespace {}: {}",
                namespace.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn socket_candidates(socket_paths: &SocketPaths) -> Result<Vec<PathBuf>, String> {
    let mut sockets = HashSet::new();
    sockets.insert(socket_paths.tmux_socket_file.clone());
    collect_matching_sockets(&socket_paths.instance_runtime_dir, "tmux-", &mut sockets)?;
    collect_matching_sockets(Path::new("/tmp"), "devshell-tmux-", &mut sockets)?;
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

fn owned_session(
    endpoint: &Path,
    instance: &str,
    psmux_data_dir: Option<&Path>,
) -> Result<bool, String> {
    let has_session = match run_mux(
        endpoint,
        &["has-session", "-t", TMUX_SESSION],
        psmux_data_dir,
    ) {
        Ok(output) => output,
        Err(_) => return Ok(false),
    };
    if !has_session.status.success() {
        return Ok(false);
    }
    let managed = show_option(endpoint, "@devshell_worker_managed", psmux_data_dir)?;
    let owner = show_option(endpoint, "@devshell_worker_instance", psmux_data_dir)?;
    Ok(managed == "1" && owner == instance)
}

fn show_option(
    endpoint: &Path,
    option: &str,
    psmux_data_dir: Option<&Path>,
) -> Result<String, String> {
    let output = run_mux(
        endpoint,
        &["show-options", "-qv", "-t", TMUX_SESSION, option],
        psmux_data_dir,
    )?;
    if !output.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_mux(
    endpoint: &Path,
    args: &[&str],
    _psmux_data_dir: Option<&Path>,
) -> Result<Output, String> {
    #[cfg(unix)]
    {
        Command::new("tmux")
            .arg("-S")
            .arg(endpoint)
            .args(args)
            .output()
            .map_err(|error| {
                format!(
                    "failed to inspect tmux session {}: {error}",
                    endpoint.display()
                )
            })
    }
    #[cfg(windows)]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .env(crate::INTERNAL_PSMUX_ENV, "1")
            .arg("-L")
            .arg(endpoint)
            .arg("-f")
            .arg("NUL");
        if let Some(data_dir) = _psmux_data_dir {
            command.env("PSMUX_DATA_DIR", data_dir);
        }
        command.args(args).output().map_err(|error| {
            format!(
                "failed to inspect psmux namespace {}: {error}",
                endpoint.display()
            )
        })
    }
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
