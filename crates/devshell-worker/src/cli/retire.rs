use serde::Serialize;

use crate::cli::InstanceArgs;
use crate::daemon::process::{self, DaemonState};
use crate::instance::{InstanceLock, InstanceName};
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::storage::permissions::ensure_dir;
#[cfg(unix)]
use crate::tools::tmux;

#[derive(Serialize)]
struct RetireResponse {
    ok: bool,
    instance: String,
    retired: bool,
}

pub fn run(args: InstanceArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let retired = retire_instance(&instance)?;
    serde_json::to_string_pretty(&RetireResponse {
        ok: true,
        instance: instance.as_str().to_string(),
        retired,
    })
    .map_err(|error| error.to_string())
}

pub fn retire_instance(instance: &InstanceName) -> Result<bool, String> {
    let instance_paths = InstancePaths::resolve(instance)?;
    let socket_paths = SocketPaths::resolve(instance)?;
    if !instance_paths.instance_root.exists() {
        return Ok(false);
    }

    ensure_dir(&instance_paths.state_dir, 0o700)?;
    let _lock = InstanceLock::acquire(&instance_paths)?;
    match process::daemon_state(&instance_paths, &socket_paths) {
        DaemonState::Running => {
            return Err(format!(
                "instance {} must be stopped before retirement",
                instance.as_str()
            ));
        }
        DaemonState::Stale => {
            return Err(format!(
                "instance {} has stale daemon state; stop it before retirement",
                instance.as_str()
            ));
        }
        DaemonState::Stopped => {}
    }

    #[cfg(unix)]
    tmux::retire_instance_runtime(&instance_paths, &socket_paths, instance.as_str())?;
    process::clear_runtime_files(&instance_paths, &socket_paths.socket_file)?;
    remove_file(&instance_paths.config_file)?;
    remove_tree(&instance_paths.artifacts_dir)?;
    remove_tree(&instance_paths.logs_dir)?;
    Ok(true)
}

fn remove_file(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", path.display())),
    }
}

fn remove_tree(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", path.display())),
    }
}
