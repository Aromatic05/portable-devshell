use crate::capability::rpc::bridge::send_request_with_timeout;
use crate::capability::rpc::request::RpcRequest;
use crate::cli::UpgradeRestartArgs;
use crate::cli::instance::lifecycle::{start, stop};
use crate::daemon::log::append_log;
use crate::daemon::process::{self, DaemonState};
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
    let result = restart_locked(&args, &instance, &paths, &sockets);
    if let Err(error) = &result {
        // The shell detached this helper with stderr discarded. Keep its real
        // failure observable locally without assigning it to a successor's state.
        let _ = append_log(
            &paths,
            &format!(
                "reverse Worker update helper failed pid={} generation={}: {error}",
                args.expected_pid, args.expected_generation,
            ),
        );
    }
    result
}

fn restart_locked(
    args: &UpgradeRestartArgs,
    instance: &InstanceName,
    paths: &InstancePaths,
    sockets: &EndpointPaths,
) -> Result<String, String> {
    // A staged job owns only the daemon/connection that requested it. Holding
    // the existing instance lock through stop, spawn and rollback makes a user
    // stop linearize either before this check or after the replacement exists.
    if process::read_pid(paths) != Some(args.expected_pid)
        || state::generation(paths) != args.expected_generation
        || process::daemon_state(paths, sockets) != DaemonState::Running
    {
        return Err("staged Worker update expired; daemon preserved".to_string());
    }
    let status = send_request_with_timeout(
        &sockets.socket_file,
        &RpcRequest::request("update-identity", "worker.status", serde_json::json!({})),
        std::time::Duration::from_secs(5),
    )?;
    let previous_sha = status
        .result
        .as_ref()
        .filter(|_| status.ok)
        .and_then(|value| value.get("workerSha256"))
        .and_then(serde_json::Value::as_str)
        .ok_or("cannot identify previous Worker content; daemon preserved")?;
    let previous = install::verified_installed_binary(previous_sha)?;

    // Installation verifies the content and returns its immutable path. Any
    // Unix CLI alias activation is independent of this instance's execution.
    // Keep the old daemon running until binary preparation succeeds.
    let installed = install::install_current_binary()?;
    let _ = append_log(paths, "reverse Worker update staged; restarting daemon");
    if let Err(error) = stop::stop_running_daemon(paths, sockets) {
        let _ = append_log(
            paths,
            &format!("reverse Worker update could not stop daemon: {error}"),
        );
        return Err(error);
    }

    let runtime = process::WorkerRuntimeContext {
        instance: instance.clone(),
        platform: process::PlatformInfo {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        },
        security_mode: process::current_security_mode(),
        worker_sha256: process::current_worker_sha256(),
    };
    // Installing can replace the inode this staged helper is executing. Its
    // current_exe() may now name a deleted file; launch the installed path.
    // The daemon derives its identity from its own executable's contents.
    match start::start_daemon_executable(instance, paths, sockets, &runtime, &installed) {
        Ok(()) => {
            let _ = append_log(paths, "reverse Worker update daemon started");
            Ok(String::new())
        }
        Err(error) => {
            // Roll back this instance's daemon directly. Reinstalling would
            // overwrite another instance's newer CLI alias. Both executables
            // remain available at their verified content paths.
            let restored = install::verify_path(&previous, previous_sha).map_err(|rollback| {
                format!(
                    "Worker update failed: {error}; rollback unavailable at {}: {rollback}",
                    previous.display()
                )
            })?;
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
            start::start_daemon_executable(instance, paths, sockets, &runtime, &restored).map_err(
                |rollback| {
                    let message =
                        format!("Worker update failed: {error}; rollback failed: {rollback}");
                    let _ = append_log(paths, &message);
                    message
                },
            )?;
            let message = format!("Worker update failed, previous version restored: {error}");
            let _ = append_log(paths, &message);
            Err(message)
        }
    }
}
