use crate::cli::UpgradeRestartArgs;
use crate::cli::instance::lifecycle::{start, stop};
use crate::daemon::log::append_log;
use crate::daemon::process::{self, DaemonState};
use crate::host::home::devshell_home;
use crate::host::lifecycle::install;
use crate::instance::InstanceLock;
use crate::instance::InstanceName;
use crate::instance::storage::InstancePaths;
use crate::transport::endpoint::channel::EndpointPaths;
use crate::transport::reverse::state;

/// Run by the *new* Worker binary, detached from the old Reverse connection.
/// The old executable remains available until the replacement is running.
pub fn restart(args: UpgradeRestartArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let paths = InstancePaths::resolve(&instance)?;
    let sockets = EndpointPaths::resolve(&instance)?;
    let _lock = InstanceLock::acquire(&paths)?;
    // A staged job owns only the daemon/connection that requested it. Holding
    // the existing instance lock through stop, spawn and rollback makes a user
    // stop linearize either before this check or after the replacement exists.
    if process::read_pid(&paths) != Some(args.expected_pid)
        || state::generation(&paths) != args.expected_generation
        || process::daemon_state(&paths, &sockets) != DaemonState::Running
    {
        return Err("staged Worker update expired; daemon preserved".to_string());
    }
    let previous = devshell_home()?
        .join("bin")
        .join("devshell-worker")
        .canonicalize()
        .map_err(|error| format!("cannot identify previous Worker: {error}"))?;

    // The existing installer verifies the content and switches only the
    // executable alias. The old daemon keeps running until the new binary
    // is ready to take ownership of its instance.
    install::install_current_binary()?;
    let _ = append_log(&paths, "reverse Worker update staged; restarting daemon");
    if let Err(error) = stop::stop_running_daemon(&paths, &sockets) {
        install::install_from_path(&previous)?;
        let _ = append_log(
            &paths,
            &format!("reverse Worker update could not stop daemon: {error}"),
        );
        return Err(error);
    }

    match start::start_daemon(&instance, &paths, &sockets) {
        Ok(()) => {
            let _ = append_log(&paths, "reverse Worker update daemon started");
            Ok(String::new())
        }
        Err(error) => {
            let restored = install::install_from_path(&previous)?;
            // Roll back under the same lock, using local IPC readiness only.
            // Waiting for network Ready here would block an explicit user stop.
            let runtime = process::WorkerRuntimeContext {
                instance: instance.clone(),
                platform: process::PlatformInfo {
                    os: std::env::consts::OS,
                    arch: std::env::consts::ARCH,
                },
                security_mode: process::current_security_mode(),
                worker_sha256: None,
            };
            start::start_daemon_executable(&instance, &paths, &sockets, &runtime, &restored)
                .map_err(|rollback| {
                    let message =
                        format!("Worker update failed: {error}; rollback failed: {rollback}");
                    let _ = append_log(&paths, &message);
                    message
                })?;
            let message = format!("Worker update failed, previous version restored: {error}");
            let _ = append_log(&paths, &message);
            Err(message)
        }
    }
}
