use serde::Serialize;

use crate::cli::InstanceArgs;
use crate::daemon::process::DaemonState;
use crate::daemon::{process, readiness, shutdown};
use crate::instance::{InstanceLock, InstanceName, build_config, write_config};
use crate::rpc::bridge::send_request;
use crate::rpc::request::RpcRequest;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::storage::permissions::ensure_dir;

#[derive(Serialize)]
struct StartResponse {
    ok: bool,
    instance: String,
    started: bool,
    pid: Option<u32>,
    workspace: String,
}

pub fn run(args: InstanceArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let instance_paths = InstancePaths::resolve(&instance)?;
    let socket_paths = SocketPaths::resolve(&instance)?;

    ensure_dir(&instance_paths.instance_root, 0o700)?;
    ensure_dir(&instance_paths.logs_dir, 0o700)?;
    ensure_dir(&instance_paths.artifacts_dir, 0o700)?;
    ensure_dir(&instance_paths.state_dir, 0o700)?;
    ensure_dir(&socket_paths.instance_runtime_dir, 0o700)?;

    let _lock = InstanceLock::acquire(&instance_paths)?;
    let started = match process::daemon_state(&instance_paths, &socket_paths) {
        DaemonState::Running => false,
        DaemonState::Stale => {
            shutdown::stop_stale_daemon(
                &instance_paths,
                &socket_paths,
                std::time::Duration::from_secs(5),
            )?;
            start_daemon(&instance, &instance_paths, &socket_paths)?;
            true
        }
        DaemonState::Stopped => {
            start_daemon(&instance, &instance_paths, &socket_paths)?;
            true
        }
    };

    let pid = process::read_pid(&instance_paths);
    let status = send_request(
        &socket_paths.socket_file,
        &RpcRequest::request("status-1", "worker.status", serde_json::json!({})),
    )?;
    if !status.ok {
        return Err(status
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "worker status request failed".to_string()));
    }

    serde_json::to_string_pretty(&StartResponse {
        ok: true,
        instance: instance.as_str().to_string(),
        started,
        pid,
        workspace: status
            .result
            .and_then(|result| result.get("workspace").cloned())
            .and_then(|value| value.as_str().map(ToString::to_string))
            .ok_or_else(|| "worker status did not include workspace".to_string())?,
    })
    .map_err(|error| error.to_string())
}

fn start_daemon(
    instance: &InstanceName,
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
) -> Result<(), String> {
    if !instance_paths.config_file.exists() {
        let config = build_config(instance)?;
        write_config(instance_paths, &config)?;
    }

    let runtime = process::WorkerRuntimeContext {
        instance: instance.clone(),
        workspace: process::capture_workspace()?,
        platform: process::PlatformInfo {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        },
        security_mode: process::current_security_mode(),
        worker_sha256: process::current_worker_sha256(),
    };
    let mut daemon = process::spawn(instance, instance_paths, &runtime)?;
    let readiness_timeout = std::env::var("DEVSHELL_WORKER_TEST_READY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or_else(|| std::time::Duration::from_secs(5));
    if let Err(error) = readiness::wait_until_ready(socket_paths, readiness_timeout) {
        let cleanup = shutdown::terminate_spawned_daemon(
            &mut daemon,
            instance_paths,
            socket_paths,
            std::time::Duration::from_secs(5),
        );
        if let Err(cleanup_error) = cleanup {
            return Err(format!("{error}; cleanup failed: {cleanup_error}"));
        }
        return Err(error);
    }
    Ok(())
}
