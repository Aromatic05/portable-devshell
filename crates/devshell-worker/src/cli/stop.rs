use serde::Serialize;

use crate::cli::InstanceArgs;
use crate::daemon::{process, shutdown};
use crate::daemon::process::DaemonState;
use crate::instance::InstanceName;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;

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

    let stopped = match process::daemon_state(&instance_paths, &socket_paths) {
        DaemonState::Running => {
            shutdown::request_stop(&socket_paths)?;
            shutdown::wait_until_stopped(
                &instance_paths,
                &socket_paths,
                std::time::Duration::from_secs(5),
            )?;
            true
        }
        DaemonState::Stale => {
            process::clear_runtime_files(&instance_paths, &socket_paths.socket_file)?;
            true
        }
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
