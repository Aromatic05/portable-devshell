use serde::Serialize;

use crate::cli::InstanceArgs;
use crate::daemon::process::DaemonState;
use crate::daemon::{process, shutdown};
use crate::instance::{InstanceLock, InstanceName};
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::storage::permissions::ensure_dir;

#[derive(Serialize)]
struct StopResponse {
    ok: bool,
    instance: String,
    stopped: bool,
}

pub fn run(args: InstanceArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let instance_paths = InstancePaths::resolve(&instance)?;
    let socket_paths = SocketPaths::resolve(&instance)?;
    let _lock = if instance_paths.instance_root.exists() {
        ensure_dir(&instance_paths.state_dir, 0o700)?;
        Some(InstanceLock::acquire(&instance_paths)?)
    } else {
        None
    };

    let stopped = match process::daemon_state(&instance_paths, &socket_paths) {
        DaemonState::Running => stop_running_daemon(&instance_paths, &socket_paths)?,
        DaemonState::Stale => shutdown::stop_stale_daemon(
            &instance_paths,
            &socket_paths,
            std::time::Duration::from_secs(5),
        )?,
        DaemonState::Stopped => false,
    };

    process::clear_runtime_files(&instance_paths, &socket_paths.socket_file)?;

    serde_json::to_string_pretty(&StopResponse {
        ok: true,
        instance: instance.as_str().to_string(),
        stopped,
    })
    .map_err(|error| error.to_string())
}

fn stop_running_daemon(
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
) -> Result<bool, String> {
    let timeout = std::time::Duration::from_secs(5);
    let pid = process::read_pid(instance_paths);
    let graceful = shutdown::request_stop(socket_paths)
        .and_then(|()| shutdown::wait_until_stopped(pid, instance_paths, timeout));
    match graceful {
        Ok(()) => Ok(true),
        Err(graceful_error) => {
            let Some(pid) = pid else {
                return Err(graceful_error);
            };
            shutdown::terminate_daemon_process(pid, instance_paths, socket_paths, timeout)
                .map_err(|force_error| {
                    format!(
                        "graceful worker stop failed: {graceful_error}; forced stop failed: {force_error}"
                    )
                })?;
            Ok(true)
        }
    }
}
